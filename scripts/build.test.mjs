// Build script tests. Node standard library only, run with `npm test`.
//
// These cover the two things that are expensive to get wrong and cheap to
// assert: the credential gate, and the minifier's one known blind spot.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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