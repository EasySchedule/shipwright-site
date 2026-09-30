// Build script tests. Node standard library only, run with `npm test`.
//
// These cover the two things that are expensive to get wrong and cheap to
// assert: the credential gate, and the minifier's one known blind spot.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { findUnmangleableRuns, minifyJs } from './build.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = resolve(ROOT, 'scripts/build.mjs');

/** Count files under `dir` the way scripts/build.mjs does, recursively. */
function countSourceFiles(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countSourceFiles(resolve(dir, entry.name));
    else if (entry.isFile()) total += 1;
  }
  return total;
}

// Placeholders, not credentials. The anon key is public by design, and this is
// a string that means nothing.
const URL_VALUE = 'https://example.supabase.co';
const KEY_VALUE = 'placeholder-not-a-real-key';

/** Run the build with exactly the given SUPABASE_* variables set. */
function runBuild(env) {
  const childEnv = { PATH: process.env.PATH ?? '' };
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) childEnv[name] = value;
  }
  return spawnSync(process.execPath, [BUILD], {
    cwd: ROOT,
    encoding: 'utf8',
    env: childEnv,
  });
}

/**
 * Run the real build script against a synthetic source tree.
 *
 * `build.mjs` fixes SRC_DIR and OUT_DIR at load time from its own location, and
 * `runBuild` above spawns it with cwd: ROOT. So every test there is forced to
 * build the real src/, and the real src/ contains nothing the guard objects to.
 * That is the whole reason deleting the guard call leaves this suite green: no
 * test ever handed build() a source it would refuse, so nothing observed it.
 *
 * build.mjs imports only node:* builtins, so copying the one file into a temp
 * tree relocates ROOT to that tree and the copy is self-contained. Nothing in
 * production changes, and the repository's own src/ and dist/ are never
 * touched -- which the alternative, swapping a fixture into src/, would do,
 * clobbering the page's source and racing a concurrent build.
 *
 * `source` is written to src/probe.js. Pass undefined to run with an empty src/,
 * which the build refuses for its own reason. Returns spawnSync's result, so a
 * case can assert on the exit code and on the text the build printed.
 *
 * `onDist`, if given, is handed the contents of the dist/probe.js the run
 * produced, or undefined if there is none -- the build refuses before writing,
 * so a refusal leaves no dist/ to read. That is how a case checks what was
 * published and not only what was printed.
 */
function runBuildInTempTree(source, onDist) {
  const dir = mkdtempSync(join(tmpdir(), 'shipwright-build-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, 'src'));
    // Copied per call, so the run always tests the build.mjs in the tree right
    // now rather than a snapshot taken when this file was written.
    copyFileSync(BUILD, join(dir, 'scripts/build.mjs'));
    if (source !== undefined) writeFileSync(join(dir, 'src/probe.js'), source, 'utf8');
    const result = spawnSync(process.execPath, [join(dir, 'scripts/build.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        SUPABASE_URL: URL_VALUE,
        SUPABASE_ANON_KEY: KEY_VALUE,
      },
    });
    if (onDist !== undefined) {
      let published;
      try {
        published = readFileSync(join(dir, 'dist/probe.js'), 'utf8');
      } catch {
        published = undefined;
      }
      onDist(published);
    }
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Assert the build stopped in the guard, on this literal, and said why.
 *
 * The headline and the count are checked as well as the literal, because exit 1
 * on its own proves nothing: a missing credential exits 1 too, and a case that
 * only asserted the code could pass against a build that failed for a reason
 * that has nothing to do with the guard. The literal name is what makes the
 * message specific to this source file.
 */
function assertGuardRefused(result, literal) {
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(
    result.status,
    1,
    `expected the build to refuse this source, it exited ${result.status}:\n${output}`,
  );
  assert.ok(
    result.stderr.includes('the minifier would mangle'),
    `expected the guard's own message, got: ${output}`,
  );
  assert.ok(
    result.stderr.includes(literal),
    `expected the guard to name ${JSON.stringify(literal)}, got: ${output}`,
  );
  assert.ok(
    result.stderr.includes('1 regex literal(s)'),
    `expected exactly one offender reported, got: ${output}`,
  );
}

test('both variables set: builds, exits 0, writes both values', () => {
  const result = runBuild({ SUPABASE_URL: URL_VALUE, SUPABASE_ANON_KEY: KEY_VALUE });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /config\.js written/);
  // Counted from src/ rather than written down, so the assertion keeps its
  // meaning -- every source file is published, none skipped, none invented --
  // without becoming a tripwire every time a file is added to the page. The
  // count is recursive, because the build's own file walk is.
  const files = countSourceFiles(resolve(ROOT, 'src'));
  assert.match(result.stdout, new RegExp(`${files} file\\(s\\)`));
});

for (const [name, env, expected] of [
  ['anon key missing', { SUPABASE_URL: URL_VALUE }, 'SUPABASE_ANON_KEY'],
  ['url missing', { SUPABASE_ANON_KEY: KEY_VALUE }, 'SUPABASE_URL'],
  [
    'both missing',
    {},
    'SUPABASE_URL, SUPABASE_ANON_KEY',
  ],
  ['url empty', { SUPABASE_URL: '', SUPABASE_ANON_KEY: KEY_VALUE }, 'SUPABASE_URL'],
  ['key empty', { SUPABASE_URL: URL_VALUE, SUPABASE_ANON_KEY: '' }, 'SUPABASE_ANON_KEY'],
  [
    'whitespace only',
    { SUPABASE_URL: '   ', SUPABASE_ANON_KEY: '  ' },
    'SUPABASE_URL, SUPABASE_ANON_KEY',
  ],
]) {
  test(`${name}: exits 1 and names the variable`, () => {
    const result = runBuild(env);
    assert.notEqual(result.status, 0);
    assert.equal(result.status, 1);
    assert.ok(
      result.stderr.includes(expected),
      `expected stderr to name ${expected}, got: ${result.stderr}`,
    );
  });
}

test('minifier preserves behaviour on literals it handles', () => {
  const cases = [
    ['division by number', 'return 6/3;', 2],
    ['division by variable', 'const c=4; return 8/c;', 2],
    ['string keeps spaces', 'return "a  b";', 'a  b'],
    ['string keeps slash-star', 'return "a /* b";', 'a /* b'],
    ['template keeps spaces', 'return `a  ${1+1} b`;', 'a  2 b'],
    ['regex after =', 'return /a  b/.source;', 'a  b'],
    ['regex after return', 'return /a  b/.source;', 'a  b'],
    ['plus is not glued', 'let a=1; return a + +2;', 3],
    ['minus is not glued', 'let a=1; return a - -2;', 3],
    ['asi preserved', 'const a=1\nconst b=2\nreturn a+b', 3],
  ];
  for (const [name, source, want] of cases) {
    const got = new Function(minifyJs(source))();
    assert.deepEqual(got, want, `${name}: ${JSON.stringify(minifyJs(source))}`);
  }
});

/*
 * The blind spot.
 *
 * From a `/` alone you cannot tell a division from a regex literal. The minifier
 * decides from the previous character, and after `)`, `]` or `}` both readings
 * are real. It guesses "division" and re-whitespaces the run, and whitespace
 * inside a pattern is significant:
 *
 *   if (1) / foo - bar /.test("foo-bar")   ->  false
 *   if (1) /foo-bar/.test("foo-bar")       ->  true
 *
 * The mangled output still parses, so `node --check` cannot catch it. This test
 * pins the mangling, so that if the minifier is ever fixed the guard's test
 * below fails and gets updated on purpose rather than by accident.
 */
test('known blind spot: a pattern after ) is genuinely mangled', () => {
  const source = 'let hit=0; if (1) / foo - bar /.test("foo-bar") && (hit=1); return hit;';
  assert.equal(new Function(source)(), 0, 'source does not match');
  assert.equal(new Function(minifyJs(source))(), 1, 'minified output wrongly matches');
});

test('guard catches every shape that triggers the blind spot', () => {
  const caught = [
    'if (x) / foo - bar /.test(s);',
    'if (a[0]) / a . b /.test(s);',
    'if (o.k) / a * b /.test(s);',
    'let hit=0; if (1) / x y /.test("xy") && (hit=1);',
  ];
  for (const source of caught) {
    const found = findUnmangleableRuns(source);
    assert.equal(found.length, 1, `expected one offender in: ${source}`);
  }
});

test('guard does not fire on ordinary code', () => {
  const clean = [
    'const half = (a + b) / 2;',
    'const q = total / count;',
    'const r = / foo - bar /;',
    'return / foo - bar /;',
    '// / foo - bar / in a comment',
    'const s = "/ foo - bar /";',
    'if (x) /foo/.test(s);',
    'x(); / foo - bar /.test(s);',
    'const q = a / b / c;',
    'const t = el.textContent.trim();',
  ];
  for (const source of clean) {
    assert.deepEqual(
      findUnmangleableRuns(source),
      [],
      `unexpected offender in: ${source}`,
    );
  }
});

test('end to end: the real src/ builds clean, which is what makes the guard mean something', () => {
  const result = runBuild({ SUPABASE_URL: URL_VALUE, SUPABASE_ANON_KEY: KEY_VALUE });
  // The real src/ must be clean, which is what makes the negative case above
  // meaningful: the guard is not simply always-on.
  assert.equal(result.status, 0, `real src/ must build clean: ${result.stderr}`);
});

/*
 * A named regex literal is the safe shape, and it has to stay safe.
 *
 * The guard is a build-time fence, not a fix. What it protects is the ordinary
 * way a pattern is written -- bound to a name, or returned, or passed as an
 * argument -- where the minifier can tell a pattern from a division and copies
 * the run verbatim.
 *
 * So this asserts the exact bytes, not only the behaviour. Behaviour alone is
 * too weak: a pattern can still match what it matched while its source has been
 * rewritten, and a rewritten pattern is what the page then ships. The two
 * literals the leaderboard page actually uses are included, because those are
 * the ones that have to survive into dist/.
 *
 * `if (cond) <pattern>` is deliberately absent from the safe positions below.
 * That is the ambiguous reading this whole guard exists for, and
 * `guard catches every shape that triggers the blind spot` above already pins
 * it as refusing to build.
 */
test('a named regex literal survives minification byte for byte', () => {
  // Positions where the minifier can resolve the `/` without guessing.
  const binds = [
    (l) => `const PATTERN = ${l};`,
    (l) => `return ${l};`,
    (l) => `f(${l});`,
    (l) => `const o = { p: ${l} };`,
    (l) => `const o = { p: ${l} }; f(o.p);`,
  ];

  const literals = [
    "/[&<>\"']/g", // the page's escaping character class
    '/\\/+$/', // the page's trailing-slash pattern
    '/\\d{2}:\\d{2}/', // escaped metacharacters
    '/^(a|b)$/', // alternation in a group
    '/[^/]+/', // a negated character class
  ];

  for (const literal of literals) {
    for (const bind of binds) {
      const source = bind(literal);
      const minified = minifyJs(source);
      assert.ok(
        minified.includes(literal),
        `literal changed: ${JSON.stringify(literal)} in ${JSON.stringify(source)} ` +
          `-> ${JSON.stringify(minified)}`,
      );
    }
  }

  // Whitespace inside a pattern is the part that carries the meaning, so it gets
  // its own pass. In these positions the minifier can resolve the `/`, so both
  // the bytes and the pattern text have to come through unchanged.
  for (const literal of ['/ foo - bar /', '/ a b /i', '/ x y /g']) {
    const source = `const PATTERN = ${literal}; return PATTERN.source;`;
    const minified = minifyJs(source);
    assert.ok(
      minified.includes(literal),
      `literal changed: ${JSON.stringify(literal)} -> ${JSON.stringify(minified)}`,
    );
    // Evaluate both sides. A pattern can keep matching while its source is
    // rewritten, so the text is the stronger assertion of the two.
    assert.equal(
      new Function(minified)(),
      new Function(source)(),
      `pattern text changed: ${JSON.stringify(literal)} -> ` +
        `${JSON.stringify(minified)}`,
    );
  }
});

/*
 * The same literals have to be inert to the guard as well. A guard that fired on
 * a correctly written pattern would be its own outage: a red build for code that
 * minifies correctly.
 */
test('the guard is silent on named regex literals', () => {
  const clean = [
    'const PATTERN = / foo - bar /;',
    'const TRAILING = /\\/+$/;',
    "const UNSAFE_CHARS = /[&<>\"']/g;",
    'const TIME = /\\d{2}:\\d{2}/;',
    'const o = { p: / a b / };',
  ];
  for (const source of clean) {
    assert.deepEqual(
      findUnmangleableRuns(source),
      [],
      `unexpected offender in: ${source}`,
    );
  }
});

/*
 * The guard has to run inside build(), not only when it is called directly.
 *
 * Every test above reaches the guard by calling `findUnmangleableRuns`, and the
 * one end-to-end test builds the real src/, which is clean by construction. So
 * the suite still passes if build() stops calling the guard at all: replace
 * `findUnmangleableRuns(source)` with `[]` in build() and this file stays green
 * while the page ships with `/ foo - bar /` minified into `/foo-bar/`.
 *
 * What was missing is a build that is handed a source the guard would reject.
 * These cases run the real, unmodified build.mjs in a temp tree (see
 * runBuildInTempTree), so what is under test is the wiring inside build() and
 * not the exported function.
 */

// Same four shapes as `guard catches every shape that triggers the blind spot`
// above, byte for byte, so the unit test and this one cannot drift apart: one
// asserts the guard finds them, the other asserts build() refuses to ship them.
// All four put the `/` after `)`; what varies is the pattern body, which is where
// the interesting traps are. `.` and `*` are regex metacharacters, so a run
// containing them has to still read as one pattern rather than as an expression.
// The build never executes src/ -- it reads, minifies, and `node --check`s -- so
// these sources do not need their identifiers declared.
const HOSTILE_SHAPES = [
  ['a pattern whose body reads as arithmetic', 'if (x) / foo - bar /.test(s);', '/ foo - bar /'],
  ['a pattern containing a dot', 'if (a[0]) / a . b /.test(s);', '/ a . b /'],
  ['a pattern containing a star', 'if (o.k) / a * b /.test(s);', '/ a * b /'],
  [
    'a pattern whose mangling flips a result',
    'let hit=0; if (1) / x y /.test("xy") && (hit=1);',
    '/ x y /',
  ],
];

test('end to end: the build refuses a source the minifier would mangle', () => {
  // Whitespace inside the pattern is what carries the meaning, so a mangled
  // build still parses and still runs. This is the case that has to be refused.
  const result = runBuildInTempTree(
    'let hit = 0;\nif (1) / foo - bar /.test("foo-bar") && (hit = 1);\nif (!hit) throw new Error("unreachable");\n',
  );
  assertGuardRefused(result, '/ foo - bar /');
});

test('end to end: the same temp-tree harness builds a clean source', () => {
  // Without this, the refusal above could be passing because the harness is
  // broken -- a copy that will not run, a missing credential -- rather than
  // because the guard fired. Same helper, same spawn, clean source: exit 0.
  const result = runBuildInTempTree(
    'const SPACED = / foo - bar /;\nconst TRAILING = /\\/+$/;\nif (SPACED.source.length === 0) throw new Error("x");\nif (TRAILING.source.length === 0) throw new Error("y");\n',
  );
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, `expected a clean source to build:\n${output}`);
  assert.match(result.stdout, /config\.js written/);
});

for (const [name, source, literal] of HOSTILE_SHAPES) {
  test(`end to end: the build refuses ${name}`, () => {
    assertGuardRefused(runBuildInTempTree(`${source}\n`), literal);
  });
}

test('end to end: an empty src/ is refused, so a temp-tree refusal names the guard', () => {
  // The last thing a temp-tree case should be able to do is pass for the wrong
  // reason. An empty src/ is the build's own refusal, it never reaches the
  // guard, and it must not satisfy assertGuardRefused.
  const result = runBuildInTempTree(undefined);
  assert.equal(result.status, 1, `expected an empty src/ to be refused:\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, /src\/ is empty/);
  assert.ok(
    !result.stderr.includes('the minifier would mangle'),
    `guard message on a source the guard never read: ${result.stderr}`,
  );
});


/*
 * A `/` in first position on a line. (SHI-64)
 *
 * Every case above puts the ambiguous `/` on the same line as the `)`, `]` or `}`
 * before it, which is the position the guard was written for. The position that
 * actually reached dist/ was the other one. `findUnmangleableRuns` walked back
 * over spaces and tabs to find the closer and stopped at the newline, so it
 * skipped every run whose closer was on the previous line -- which is the
 * ordinary way to write the statement after a block:
 *
 *   function probe() {}
 *   / foo - bar /.test("foo-bar") && (hit = 1);
 *
 * Nothing stood between that and the page. The build exited 0 and published
 * `/foo-bar/`, a pattern that matches where the source's did not, and the
 * published artifact is the one a browser loads.
 *
 * The minifier now copies a line-leading run byte for byte instead of guessing
 * whether it is a pattern or a division, because there is nothing to decide:
 * whitespace inside a pattern is significant and copying it preserves the
 * match, and whitespace inside a division is not significant at all. These are
 * the runs that must come out unchanged.
 */
test('a pattern in first position on a line is copied byte for byte', () => {
  // Both of these are complete programs, so both are evaluated as well as
  // compared byte for byte. A pattern can keep matching what it matched while
  // its source has been rewritten, and a rewritten pattern is what ships.
  const programs = [
    ['after )', 'let hit = 0;\nif (1)\n/ foo - bar /.test("foo-bar") && (hit = 1);\nreturn hit;'],
    ['after }', 'let hit = 0;\nfunction probe() {}\n/ foo - bar /.test("foo-bar") && (hit = 1);\nreturn hit;'],
  ];
  for (const [name, source] of programs) {
    const minified = minifyJs(source);
    assert.ok(
      minified.includes('/ foo - bar /'),
      `${name}: the run was rewritten -> ${JSON.stringify(minified)}`,
    );
    assert.equal(new Function(source)(), 0, `${name}: the source does not match`);
    assert.equal(new Function(minified)(), 0, `${name}: the minified output wrongly matches`);
  }

  // After `]` the same source is not a legal program: `[1]` can be divided, so
  // the parser takes that `/` as an operator and then trips on the `.`. The
  // minifier does not know that -- it decides from the run alone -- so this one
  // is asserted on the output bytes only. Which is the level the bug arrived at
  // anyway: the build parses what it just wrote, and a mangled pattern parses
  // either way.
  const afterBracket = minifyJs('const a = [1]\n/ foo - bar /.test("foo-bar");');
  assert.ok(
    afterBracket.includes('/ foo - bar /'),
    `after ]: the run was rewritten -> ${JSON.stringify(afterBracket)}`,
  );
});

/*
 * The guard still has to fire -- and it still has to be quiet where there is
 * nothing wrong.
 *
 * Reading a line-leading `/` correctly is the minifier getting better at
 * guessing, not the guard becoming redundant. On the same line as its closer the
 * guess is still a guess, `lastChar` is `)` or `]` or `}`, and none of those can
 * tell a pattern from a division, so the guard is what stands between those
 * three and dist/. A change that quietly stopped it would leave the original
 * corruption in place while looking like a fix.
 *
 * The line-leading positions are the other direction. Nothing mangles them, so
 * the guard must stay off them: refusing them would be refusing correct code
 * that minifies correctly, and a build that stops for that is its own outage.
 */
test('the guard fires on the same-line positions and nowhere else', () => {
  const caught = [
    ['after )', 'if (x) / a . b /.test(s);'],
    ['after ]', 'const v = a[0] / a . b /.test(s);'],
    ['after }', 'function probe() {} / a . b /.test(s);'],
  ];
  for (const [name, source] of caught) {
    assert.deepEqual(
      findUnmangleableRuns(source),
      ['/ a . b /'],
      `${name}: the guard stopped firing`,
    );
    // The guard refuses a run because the minifier would change it, so that has
    // to still be true -- otherwise this would be refusing correct code.
    assert.ok(
      !minifyJs(source).includes('/ a . b /'),
      `${name}: the guard is refusing a run the minifier copies verbatim`,
    );
  }

  // And the line-leading positions, which the minifier copies verbatim, are
  // reported by neither. These are the ones that used to reach dist/ unchecked.
  const lineLeading = [
    'if (1)\n/ foo - bar /.test(s);',
    'const a = [1]\n/ foo - bar /.test(s);',
    'function probe() {}\n/ foo - bar /.test(s);',
  ];
  for (const source of lineLeading) {
    assert.deepEqual(
      findUnmangleableRuns(source),
      [],
      `the guard fired on a run the minifier copies verbatim: ${JSON.stringify(source)}`,
    );
  }
});

/*
 * Chained division is not a pattern. (SHI-64)
 *
 * The guard only ever meant to fire on something the minifier would mangle. It
 * also fired on arithmetic, because it looked at the run and nothing else:
 *
 *   const n = f(x) / 2 / 3;
 *                    ^^^^  the run closes here, and `3` follows it
 *
 * `/ 2 /` is a legal pattern and `f(x) / 2 / 3` is legal division, so every other
 * test the guard applies passes on it. That is a red build waiting for ordinary
 * code. The report called `const half = (a + b) / 2;` the false positive; it was
 * never one -- that line has no closing `/` at all. The chained form is the one
 * that was reported, and it was reported correctly as a false positive.
 *
 * What tells them apart is the token after the run, and the test has to be phrased
 * the other way round from the obvious one. It is tempting to say that a division
 * can be followed by the next operand of its chain and a pattern cannot, but a
 * pattern *can* be followed by a call, a subscript, an operator or a template tag:
 * `/re/(s)`, `/re/[0]` and `` /re/`t` `` are all ordinary JavaScript. The token that
 * settles it is one that cannot follow a pattern at all, because then the pattern
 * reading is two adjacent expressions. `3` is one. See CANNOT_FOLLOW_PATTERN.
 */
test('chained division is not reported, and neither is a single division', () => {
  const clean = [
    'const n = f(x) / 2 / 3;',
    'const n = f(x) / 2;',
    'const half = (a + b) / 2;',
    'const q = total / count;',
    'const v = a[0] / b / c / d;',
    // The same chain wrapped onto the next line, which reads exactly like the
    // line-leading patterns above.
    'const n = f(x)\n  / 2 / 3;',
    'const n = f(x)\n  / 2;',
  ];
  for (const source of clean) {
    assert.deepEqual(
      findUnmangleableRuns(source),
      [],
      `unexpected offender in: ${JSON.stringify(source)}`,
    );
  }
});

/*
 * A division that continues onto the next line has to stay a division.
 *
 * This is the regression risk of the fix above, so it is pinned deliberately. A
 * line-leading `/` is not the same thing as a completed statement: ASI inserts a
 * semicolon only when the next token cannot continue the statement, and a `/`
 * usually can. The restricted production after `return` bans a line terminator
 * before the expression starts, not one inside it, so this is a division:
 *
 *   return (a)
 *     / 2 / 3;              // a / 2 / 3
 *
 * A minifier that read every line-leading `/` as a pattern would take `/ 2 /` for
 * a literal here, and the page would divide by nothing.
 */
test('a division that continues onto the next line still divides', () => {
  const cases = [
    [
      'a wrapped sum divided by a literal',
      'function f(a, b) {\n  const v = (a + b)\n    / 2;\n  return v;\n}\nreturn f(3, 4);',
      3.5,
    ],
    [
      'a wrapped chain divided twice',
      'function f(a) {\n  return (a)\n    / 2 / 3;\n}\nreturn f(12);',
      2,
    ],
  ];
  for (const [name, source, want] of cases) {
    const minified = minifyJs(source);
    assert.equal(new Function(source)(), want, `${name}: the source does not divide`);
    assert.equal(
      new Function(minified)(),
      want,
      `${name}: the minified output no longer divides -> ${JSON.stringify(minified)}`,
    );
  }
});

/*
 * The same fix, through the real build, and against the exact bytes that shipped.
 *
 * The build now exits 0 on this source -- it is correct code, so it must -- and
 * what has to be checked is the artifact rather than the exit code, because the
 * SHI-64 report was exactly this: exit 0, a dist/ that built, and a pattern in
 * it that matched where the source's did not.
 */
test('end to end: a line-leading pattern is published with its whitespace intact', () => {
  let published;
  const result = runBuildInTempTree(
    'let hit = 0;\nfunction probe() { return 1; }\n' +
      '/ foo - bar /.test("foo-bar") && (hit = 1);\n' +
      'if (hit !== 0) throw new Error("the pattern was rewritten");\n',
    (text) => { published = text; },
  );
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, `correct source must build:\n${output}`);
  assert.match(result.stdout, /config\.js written/);
  assert.ok(published !== undefined, 'the build published no dist/probe.js');
  assert.ok(
    published.includes('/ foo - bar /'),
    `the published pattern was rewritten -> ${JSON.stringify(published)}`,
  );
  assert.ok(
    !published.includes('/foo-bar/'),
    `the published pattern lost its whitespace -> ${JSON.stringify(published)}`,
  );
});

test('end to end: the build still succeeds when a division wraps to the next line', () => {
  const result = runBuildInTempTree(
    'function half(a, b) {\n  const v = (a + b)\n    / 2;\n  return v;\n}\n' +
      'const third = (12)\n  / 2 / 3;\n' +
      'if (half(3, 4) !== 3.5) throw new Error("wrapped division broke");\n' +
      'if (third !== 2) throw new Error("wrapped chain broke");\n',
  );
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, `a wrapped division must not fail the build:\n${output}`);
  assert.match(result.stdout, /config\.js written/);
});

/*
 * The guard has to stay on when the next token can legally follow a pattern.
 *
 * The chained-division fix skipped a run whose next token looked like the start of
 * an operand, on the argument that a division can be followed by the next operand
 * of its chain and a pattern cannot. The first half is true. The second is not:
 * `/re/(s)`, `/re/[0]`, `/re/+1`, `/re/-1` and ``/re/`t` `` are ordinary JavaScript,
 * so `(`, `[`, `+`, `-` and a backtick all follow a complete regex literal.
 *
 * Reading those as operands therefore silenced the guard in the one position it
 * exists to protect, and did so silently -- the build exited 0 and published an
 * artifact that disagreed with the source. This is the same class of defect as the
 * one SHI-64 was filed for, pointing the other way, and it is the reason the test
 * is one-sided: only a token that cannot follow a pattern is skipped.
 */
test('the guard fires when the next token can follow a complete pattern', () => {
  const caught = [
    ['a call', 'if (x) / a - b /(s);'],
    ['a subscript', 'if (x) / a - b /[0];'],
    ['a unary sign on an identifier', 'if (x) / a - b / + g;'],
    ['a unary sign on a number', 'if (x) / a - b / - 1;'],
    ['a template tag', 'if (x) / a - b /`t`;'],
    // Not in the five above, but the same argument: `!` and `~` are operators, so
    // `!/ a b /.test(s)` is a pattern position too.
    ['logical not', 'if (x) / a - b /!g;'],
    ['bitwise not', 'if (x) / a - b /~g;'],
  ];
  for (const [name, source] of caught) {
    assert.deepEqual(
      findUnmangleableRuns(source),
      ['/ a - b /'],
      `${name}: the guard was silenced on a run that is still a pattern`,
    );
    assert.ok(
      !minifyJs(source).includes('/ a - b /'),
      `${name}: the guard is refusing a run the minifier copies verbatim`,
    );
  }
});

test('end to end: the build refuses a pattern followed by a unary sign', () => {
  // The source is the shape that reached dist/: `+` made the guard read `/ a - b /`
  // as arithmetic, the build exited 0, and the published artifact evaluated to the
  // opposite of the source. Only the build's own refusal stands between that and
  // the page, so it is asserted through the real build.mjs.
  const result = runBuildInTempTree(
    'let hit = false;\nfunction label(row) { return row.kind; }\n' +
      'if (label({ kind: 1 })) / a - b / + 1 !== "/ a - b /1" && (hit = true);\n' +
      'if (hit) throw new Error("the published artifact would disagree with the source");\n',
  );
  assertGuardRefused(result, '/ a - b /');
});
