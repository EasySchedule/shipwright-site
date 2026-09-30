#!/usr/bin/env node
// Self-test for scripts/measure.mjs.
//
// A harness that can only report PASS is not a harness, it is a rubber stamp.
// This drives the real measure.mjs through the cases that must fail, in throwaway
// copies of the tree, and asserts on its exit code. It is the difference between
// "I checked these once" and "these are checkable by anyone".
//
//   node scripts/measure-selftest.mjs
//
// Exit 0 when every case behaves as required. The cases deliberately include
// the ones where measure.mjs is expected to refuse rather than answer, because
// a wrong-but-plausible number is worse than no number.
//
// Node standard library only, like the rest of scripts/.

import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HARNESS_ARGS = ['--runs', '1', '--placeholder-config'];

/**
 * `bytes` of source text that gzip cannot shrink.
 *
 * A fixed-seed LCG rather than Math.random, so the self-test is reproducible:
 * a case whose outcome depends on an unseeded RNG is a flaky case, and a flaky
 * failure test is worse than none. Alphanumeric output, no quotes or
 * backslashes, so the padding is valid inside a JS string literal.
 */
function incompressible(bytes) {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let state = 0x2f6e2b1;
  let out = '';
  for (let i = 0; i < bytes; i += 1) {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    out += ALPHABET[state % ALPHABET.length];
  }
  return out;
}

/**
 * Cases, in the order they are run.
 *
 * `expect` is the exit code measure.mjs must return: 0 pass, 1 a measured
 * failure, 2 a refusal to measure. `wantIn` is a string that must appear in the
 * combined output, so a case cannot pass by exiting 1 for an unrelated reason.
 */
const CASES = [
  {
    name: 'clean tree passes',
    expect: 0,
    wantIn: 'VERDICT: PASS',
    async apply() {},
  },
  {
    name: 'innerHTML sink in src/ fails',
    expect: 1,
    wantIn: 'innerHTML',
    async apply(dir) {
      await writeFile(join(dir, 'src', 'probe.js'), 'const el = document.body;\nel.innerHTML = "<b>x</b>";\n');
    },
  },
  {
    name: 'insertAdjacentHTML sink in src/ fails',
    expect: 1,
    wantIn: 'insertAdjacentHTML',
    async apply(dir) {
      await writeFile(join(dir, 'src', 'probe.js'), 'el.insertAdjacentHTML("beforeend", x);\n');
    },
  },
  {
    name: 'outerHTML sink in src/ fails',
    expect: 1,
    wantIn: 'outerHTML',
    async apply(dir) {
      await writeFile(join(dir, 'src', 'probe.js'), 'el.outerHTML = x;\n');
    },
  },
  {
    name: 'string-concatenated HTML fails',
    expect: 1,
    wantIn: 'concat-html',
    async apply(dir) {
      await writeFile(join(dir, 'src', 'probe.js'), 'function row(n) { return "<div>" + n + "</div>"; }\n');
    },
  },
  {
    name: 'a sink in a comment still fails, because intent is not the test',
    expect: 1,
    wantIn: 'innerHTML',
    async apply(dir) {
      await writeFile(join(dir, 'src', 'probe.js'), '// never do el.innerHTML = x here\n');
    },
  },
  {
    // With no entry document there is no first-load set to derive, so this
    // refuses at exit 2 before the XSS scan is even reached. That is strictly
    // stronger than the NOT SCANNED backstop inside the scan, and this case
    // asserts the stronger behaviour rather than claiming to exercise the
    // weaker one.
    name: 'src/ with no entry document is refused, not measured',
    expect: 2,
    wantIn: 'no top-level HTML file',
    async apply(dir) {
      await rm(join(dir, 'src', 'main.js'));
      await rm(join(dir, 'src', 'index.html'));
      await rm(join(dir, 'src', 'styles.css'));
      await writeFile(join(dir, 'src', 'notes.txt'), 'not scannable, and no entry document\n');
    },
  },
  {
    name: 'index.html referencing a file the build does not produce is refused',
    expect: 2,
    wantIn: 'references',
    async apply(dir) {
      await writeFile(
        join(dir, 'src', 'index.html'),
        '<!doctype html><html><head><link rel="stylesheet" href="./nope.css"></head><body></body></html>\n',
      );
    },
  },
  {
    name: 'two top-level HTML files is refused rather than guessed',
    expect: 2,
    wantIn: 'not guessed',
    async apply(dir) {
      await writeFile(join(dir, 'src', 'other.html'), '<!doctype html><html><body>other</body></html>\n');
    },
  },
  {
    // Padded CSS, not padded HTML: the shell budget counts HTML and CSS
    // uncompressed, and adding a second HTML file would trip the entry-document
    // refusal above instead of the budget.
    name: 'an AC-49 shell breach fails even with a clean scan',
    expect: 1,
    wantIn: 'AC-49 static shell',
    async apply(dir) {
      const original = await readFile(join(dir, 'src', 'styles.css'), 'utf8');
      await writeFile(join(dir, 'src', 'styles.css'), `${original}\n/* ${'x'.repeat(17000)} */\n`);
    },
  },
  {
    // High-entropy padding, because the first-load budget is a *gzip* budget
    // and repeated bytes compress away to nothing. A 6 MB file of one repeated
    // character would gzipped to a few KB and breach nothing, which is exactly
    // the mistake that makes a byte budget look enforced when it is not.
    name: 'a first-load gzip breach fails even when the raw size is small',
    expect: 1,
    wantIn: 'First-load weight',
    async apply(dir) {
      await writeFile(join(dir, 'src', 'pad.js'), `const pad = '${incompressible(60 * 1024)}';\n`);
      await writeFile(
        join(dir, 'src', 'index.html'),
        '<!doctype html><html><head><link rel="stylesheet" href="./styles.css"></head>' +
          '<body><script type="module" src="./pad.js"></script></body></html>\n',
      );
    },
  },
  {
    name: 'src/ absent fails the build, not silently an empty measurement',
    expect: 2,
    wantIn: 'no dist/ to measure',
    async apply(dir) {
      await rm(join(dir, 'src'), { recursive: true, force: true });
    },
  },
  {
    // The first-load set must come from the document, not from whatever is in
    // dist/. A page that references nothing but itself must not be reported as
    // downloading a stylesheet.
    name: 'a referenced file is counted and an unreferenced one is not',
    expect: 0,
    wantIn: 'not fetched on a visit',
    async apply(dir) {
      await writeFile(
        join(dir, 'src', 'index.html'),
        '<!doctype html><html><head></head><body>bare page</body></html>\n',
      );
    },
  },
  {
    name: 'the encoder cross-check runs and names both encoders',
    expect: 0,
    // Asserted on the cross-check's own conclusion line, not on the section
    // heading. The heading prints on the [SKIPPED] path too, so a heading
    // assertion would pass against a harness that never ran the check — which
    // a deliberate mutation confirmed.
    wantIn: 'No budget verdict changes between the two encoders.',
    async apply(dir) {
      // A big incompressible asset inflates the shipped total only. If the
      // first-load set were taken from dist/ instead of the document, this
      // would push the visitor budget over instead.
      await writeFile(join(dir, 'src', 'og.png'), incompressible(70 * 1024));
      await writeFile(
        join(dir, 'src', 'index.html'),
        '<!doctype html><html><head><link rel="stylesheet" href="./styles.css"></head><body></body></html>\n',
      );
    },
  },
  {
    name: '--supabase with a placeholder credential never reports a number',
    expect: 0,
    wantIn: 'placeholder credential is in use, so no live read was attempted',
    async apply() {},
    args: ['--supabase'],
  },
  {
    name: 'a real credential is used as-is and the report does not claim a placeholder',
    expect: 0,
    wantIn: 'credential: real anon key present',
    async apply() {},
    env: {
      SUPABASE_URL: 'https://example.invalid',
      SUPABASE_ANON_KEY: 'a-real-shaped-key-0123456789abcdef',
    },
  },
  {
    name: 'an unknown argument is refused rather than ignored',
    expect: 2,
    wantIn: 'unknown argument',
    async apply() {},
    args: ['--not-a-flag'],
  },
];

/** Copy the tree into a temp dir and run one case in it. */
async function runCase(testCase) {
  const dir = await mkdtemp(join(tmpdir(), 'shipwright-measure-'));
  try {
    for (const part of ['scripts', 'src', 'package.json']) {
      await cp(join(ROOT, part), join(dir, part), { recursive: true });
    }
    await testCase.apply(dir);
    // Default: no credential in the environment, so --placeholder-config is
    // what makes the run possible. A case can override that.
    const env = { ...process.env, SUPABASE_URL: '', SUPABASE_ANON_KEY: '', ...(testCase.env || {}) };
    const args = [...HARNESS_ARGS, ...(testCase.args || [])];
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [join(dir, 'scripts', 'measure.mjs'), ...args],
        { cwd: dir, env, timeout: 60_000 },
      );
      return { code: 0, output: `${stdout}${stderr}` };
    } catch (err) {
      return {
        code: err.code,
        output: `${err.stdout || ''}${err.stderr || ''}`,
        timedOut: err.killed === true || err.signal === 'SIGTERM',
      };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

let failed = 0;
process.stdout.write('measure.mjs self-test\n\n');

for (const testCase of CASES) {
  const { code, output, timedOut } = await runCase(testCase);
  const wantText = testCase.wantIn;
  const matched = wantText === '' || output.includes(wantText);
  const ok = !timedOut && code === testCase.expect && matched;
  if (!ok) failed += 1;
  process.stdout.write(
    `  [${ok ? 'ok  ' : 'FAIL'}] ${testCase.name}\n` +
      `           exit ${timedOut ? 'TIMED OUT' : code} (want ${testCase.expect}), ` +
      `${wantText === '' ? 'output not checked' : `output ${matched ? 'contains' : 'DOES NOT contain'} ${JSON.stringify(wantText)}`}\n`,
  );
  if (!ok) {
    const tail = output.trim().split('\n').slice(-8).map((l) => `             ${l}`).join('\n');
    process.stdout.write(`${tail}\n`);
  }
}

process.stdout.write(
  `\n  ${CASES.length - failed}/${CASES.length} cases behaved as required.\n` +
    `  A case that exits 1 for the wrong reason fails here; exit code alone is not enough.\n`,
);
process.exit(failed === 0 ? 0 : 1);
