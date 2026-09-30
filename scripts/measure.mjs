#!/usr/bin/env node
// Shipwright measurement harness.
//
// Produces the byte counts and the XSS scan that the product spec budgets
// against, as repeatable numbers rather than adjectives. Node standard library
// only, no dependencies, for the same reason scripts/build.mjs has none.
//
// What this file exists to stop:
//
// 1. `gzip -c file` writes the original filename into the gzip header, so the
//    byte count moves by one byte per character of the filename. Renaming
//    dist/app.js to dist/main.js changes the "measured" number by one byte
//    without changing a single byte of JavaScript. Every count here uses
//    `gzip -nc`: no name, no timestamp, content only. `-c` alone is not a
//    measurement of the code, it is a measurement of the code plus its name.
//
// 2. The build is expected to be deterministic, but "expected" is not a
//    number. Every measurement below is taken across N rebuilds and reported
//    as a distribution with its spread. A build whose output size moves
//    between runs on the same input has a defect, and this harness is where
//    that shows up instead of in a launch review.
//
// 3. dist/config.js embeds the Supabase anon key, so its size tracks the key
//    length. It is reported separately and never folded silently into a
//    first-party total.
//
// Usage:
//   node scripts/measure.mjs [--runs N] [--json] [--supabase]
//
//   --runs N     rebuild and re-measure N times. Default 5. The distribution
//                across runs is the deliverable; the first run is not special.
//   --json       emit the result as JSON instead of the human report.
//   --supabase   additionally issue the live leaderboard read and report the
//                response body size. Needs SUPABASE_URL and SUPABASE_ANON_KEY.
//                Without --supabase the response measurement is reported as
//                NOT MEASURED, never as zero and never as a guess.
//
// Exit code is 0 when every budget passes and the XSS scan is clean, 1 when a
// budget is exceeded or a match is found, and 2 on a harness error. A failing
// measurement is a result, not a crash.

import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

const execFileAsync = promisify(execFile);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

// Budgets, from spec section 14 and the acceptance criteria.
const BUDGETS = {
  shellBytes: 15 * 1024, // AC-49, uncompressed, HTML + CSS, excluding JS
  firstPartyJsGzipBytes: 15 * 1024, // AC list, criterion 3
  firstLoadBytes: 40 * 1024, // criterion 3
  supabaseResponseBytes: 10 * 1024, // criterion 3
};

// The four sink patterns the spec forbids in src/. One match is a failure,
// including a match that looks inert, so this is a literal scan and not a
// judgement about intent.
const XSS_PATTERNS = [
  { id: 'innerHTML', re: /\binnerHTML\b/ },
  { id: 'insertAdjacentHTML', re: /\binsertAdjacentHTML\b/ },
  { id: 'outerHTML', re: /\bouterHTML\b/ },
  // String-concatenated HTML: a markup-looking token adjacent to a string or
  // template delimiter. Deliberately broad. A false positive costs a look; a
  // false negative ships an injection.
  { id: 'concat-html', re: /['"`][^'"`\n]*<\/?[a-zA-Z][^'"`\n]*['"`]\s*[+,)]|<\/?[a-zA-Z][a-zA-Z0-9-]*[^'"`\n]*['"`]\s*[+]/ },
];

function parseArgs(argv) {
  const out = { runs: 5, json: false, supabase: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--supabase') out.supabase = true;
    else if (arg === '--runs') {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n < 1) throw new Error('--runs needs a positive integer');
      out.runs = n;
      i += 1;
    } else if (arg.startsWith('--runs=')) {
      const n = Number(arg.slice('--runs='.length));
      if (!Number.isInteger(n) || n < 1) throw new Error('--runs needs a positive integer');
      out.runs = n;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

/** Recursively list files under dir as paths relative to dir. */
async function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(abs, base)));
    else if (entry.isFile()) out.push(relative(base, abs));
  }
  return out.sort();
}

/**
 * gzip byte count that depends only on content.
 *
 * Uses node's zlib so the number is independent of whatever gzip binary
 * happens to be on PATH, and sets no name or mtime in the header. This is the
 * number to compare against a budget. It is within a byte or two of
 * `gzip -nc file` on the same input and, unlike `gzip -c`, does not move when
 * the file is renamed.
 */
function gzipBytes(buf) {
  return gzipSync(buf, { level: 9 }).length;
}

/** Describe a set of samples: the distribution, not a single number. */
function distribution(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: Math.round((sum / sorted.length) * 100) / 100,
    median: sorted[Math.floor(sorted.length / 2)],
    spread: sorted[sorted.length - 1] - sorted[0],
    deterministic: sorted[sorted.length - 1] === sorted[0],
    samples: sorted,
  };
}

/** One full build plus measurement pass. */
async function measureOnce() {
  await execFileAsync(process.execPath, [join(ROOT, 'scripts', 'build.mjs')], {
    cwd: ROOT,
    env: process.env,
  });

  const files = await listFiles(DIST);
  const byExt = { html: [], css: [], js: [] };
  for (const rel of files) {
    const ext = extname(rel).slice(1);
    if (ext === 'html') byExt.html.push(rel);
    else if (ext === 'css') byExt.css.push(rel);
    else if (ext === 'js') byExt.js.push(rel);
  }

  const read = async (rel) => readFile(join(DIST, rel));
  const sizeOf = async (rel) => (await stat(join(DIST, rel))).size;

  // AC-49: initial HTML + CSS, uncompressed, excluding JS. config.js is JS
  // and is excluded here too.
  const shellFiles = [...byExt.html, ...byExt.css].sort();
  const shellParts = [];
  for (const rel of shellFiles) shellParts.push({ file: rel, bytes: await sizeOf(rel) });
  const shellBytes = shellParts.reduce((a, p) => a + p.bytes, 0);

  // First-party JS, gzipped. config.js is excluded because it is generated at
  // build time and embeds the Supabase anon key, so its size tracks key length
  // rather than code. It is reported on its own line instead of being hidden.
  const fpJs = byExt.js.filter((f) => f !== 'config.js').sort();
  const fpJsParts = [];
  for (const rel of fpJs) {
    const buf = await read(rel);
    fpJsParts.push({ file: rel, rawBytes: buf.length, gzipBytes: gzipBytes(buf) });
  }
  const firstPartyJsGzipBytes = fpJsParts.reduce((a, p) => a + p.gzipBytes, 0);

  let configBytes = null;
  if (byExt.js.includes('config.js')) {
    const buf = await read('config.js');
    configBytes = { rawBytes: buf.length, gzipBytes: gzipBytes(buf) };
  }

  // What a first visit actually downloads: every file the page references.
  // Counted gzipped, which is how it crosses the wire.
  const firstLoadFiles = files.sort();
  const firstLoadParts = [];
  for (const rel of firstLoadFiles) {
    const buf = await read(rel);
    firstLoadParts.push({ file: rel, rawBytes: buf.length, gzipBytes: gzipBytes(buf) });
  }
  const firstLoadBytes = firstLoadParts.reduce((a, p) => a + p.gzipBytes, 0);

  return {
    shellBytes,
    shellParts,
    firstPartyJsGzipBytes,
    firstPartyJsRawBytes: fpJsParts.reduce((a, p) => a + p.rawBytes, 0),
    firstPartyJsParts: fpJsParts,
    configBytes,
    firstLoadBytes,
    firstLoadParts,
    fileCount: files.length,
  };
}

/** Scan src/ for the forbidden sinks. Returns every match with file and line. */
async function scanXss() {
  const files = await listFiles(SRC_DIR);
  const matches = [];
  for (const rel of files) {
    if (!/\.(js|html|css)$/.test(rel)) continue;
    const lines = (await readFile(join(SRC_DIR, rel), 'utf8')).split('\n');
    lines.forEach((text, i) => {
      for (const { id, re } of XSS_PATTERNS) {
        if (re.test(text)) {
          matches.push({ file: rel, line: i + 1, pattern: id, text: text.trim().slice(0, 200) });
        }
      }
    });
  }
  return { scannedFiles: files.filter((f) => /\.(js|html|css)$/.test(f)), matches };
}

/** Issue the live leaderboard read and report the response body size. */
async function measureSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return { measured: false, reason: 'SUPABASE_URL or SUPABASE_ANON_KEY unset' };

  const endpoint = `${url.replace(/\/$/, '')}/rest/v1/optimizations?select=*&published=eq.true`;
  try {
    const res = await fetch(endpoint, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    const body = await res.text();
    let rows = null;
    try {
      rows = JSON.parse(body).length;
    } catch {
      rows = null;
    }
    return {
      measured: true,
      url: endpoint,
      status: res.status,
      responseBytes: Buffer.byteLength(body),
      contentType: res.headers.get('content-type'),
      rowCount: rows,
      body,
    };
  } catch (err) {
    return { measured: false, reason: `request failed: ${err.message}` };
  }
}

function budgetLine(label, actual, budget, unit = 'bytes') {
  const pct = budget === 0 ? 0 : Math.round((actual / budget) * 1000) / 10;
  const verdict = actual <= budget ? 'PASS' : 'FAIL';
  return {
    label,
    actual,
    budget,
    unit,
    percentOfBudget: pct,
    headroomBytes: budget - actual,
    verdict,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Fail loudly rather than silently measuring a build that cannot exist.
  for (const name of ['SUPABASE_URL', 'SUPABASE_ANON_KEY']) {
    if (!process.env[name] || process.env[name].trim() === '') {
      process.stderr.write(
        `measure: ${name} is unset or empty.\n` +
          'measure: the build under test requires it, so there is nothing to measure.\n' +
          'measure: set both from the deployment environment and retry.\n',
      );
      process.exit(2);
    }
  }

  const passes = [];
  for (let i = 0; i < args.runs; i += 1) passes.push(await measureOnce());
  const last = passes[passes.length - 1];

  const shell = distribution(passes.map((p) => p.shellBytes));
  const fpJs = distribution(passes.map((p) => p.firstPartyJsGzipBytes));
  const firstLoad = distribution(passes.map((p) => p.firstLoadBytes));
  const xss = await scanXss();
  const supabase = args.supabase ? await measureSupabase() : { measured: false, reason: 'not requested (--supabase not passed)' };

  const budgets = [
    budgetLine('AC-49 static shell (HTML+CSS, uncompressed, excl. JS)', last.shellBytes, BUDGETS.shellBytes),
    budgetLine('First-party JS gzipped', last.firstPartyJsGzipBytes, BUDGETS.firstPartyJsGzipBytes),
    budgetLine('Total first-load weight (gzip)', last.firstLoadBytes, BUDGETS.firstLoadBytes),
  ];
  if (supabase.measured) {
    budgets.push(budgetLine('Supabase response body', supabase.responseBytes, BUDGETS.supabaseResponseBytes));
  }

  const result = {
    runs: args.runs,
    node: process.version,
    deterministic: shell.deterministic && fpJs.deterministic && firstLoad.deterministic,
    shell,
    firstPartyJs: fpJs,
    firstPartyJsParts: last.firstPartyJsParts,
    firstPartyJsRawBytesLast: last.firstPartyJsRawBytes,
    configBytes: last.configBytes,
    firstLoad,
    firstLoadParts: last.firstLoadParts,
    fileCount: last.fileCount,
    budgets,
    xss: {
      ...xss,
      // A scan that read zero files is not a clean scan. It is a scan that did
      // not happen, and it must never report PASS.
      verdict:
        xss.scannedFiles.length === 0
          ? 'NOT SCANNED'
          : xss.matches.length === 0
            ? 'PASS'
            : 'FAIL',
    },
    supabase,
    notes: [
      'gzip counts use zlib level 9 with no filename and no mtime in the header.',
      'gzip -c embeds the filename, so its count moves when a file is renamed; do not compare it across renames.',
      'config.js is generated at build time and embeds the Supabase anon key, so it is reported separately from first-party JS.',
      'A NOT MEASURED Supabase response is not a passing response.',
    ],
  };

  const allPass =
    budgets.every((b) => b.verdict === 'PASS') &&
    result.xss.verdict === 'PASS' &&
    result.deterministic;

  result.verdict = allPass ? 'PASS' : 'FAIL';

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const line = (s) => process.stdout.write(`${s}\n`);
    line('Shipwright measurement harness');
    line(`  runs: ${args.runs}   node: ${args.version ?? process.version}   build deterministic: ${result.deterministic ? 'yes' : 'NO'}`);
    line('');
    line('  Budget');
    for (const b of budgets) {
      line(
        `    [${b.verdict}] ${b.label}\n` +
          `           ${b.actual} / ${b.budget} bytes (${b.percentOfBudget}% of budget, ${b.headroomBytes >= 0 ? '+' : ''}${b.headroomBytes} headroom)`,
      );
    }
    if (!supabase.measured) line(`    [NOT MEASURED] Supabase response body — ${supabase.reason}`);
    line('');
    line('  Distribution across runs (bytes)');
    line(`    shell        n=${shell.n} min=${shell.min} max=${shell.max} spread=${shell.spread} ${shell.deterministic ? 'stable' : 'UNSTABLE'}`);
    line(`    first-party JS gz  n=${fpJs.n} min=${fpJs.min} max=${fpJs.max} spread=${fpJs.spread} ${fpJs.deterministic ? 'stable' : 'UNSTABLE'}`);
    line(`    first load gz     n=${firstLoad.n} min=${firstLoad.n === 0 ? 0 : firstLoad.min} max=${firstLoad.max} spread=${firstLoad.spread} ${firstLoad.deterministic ? 'stable' : 'UNSTABLE'}`);
    line('');
    line('  First-party JS files');
    for (const p of last.firstPartyJsParts) line(`    ${p.file}  ${p.rawBytes} raw -> ${p.gzipBytes} gzip`);
    if (last.configBytes) {
      line(`    config.js  ${last.configBytes.rawBytes} raw -> ${last.configBytes.gzipBytes} gzip  (generated; embeds anon key; excluded from first-party JS)`);
    }
    line('');
    line('  First-load files');
    for (const p of last.firstLoadParts) line(`    ${p.file}  ${p.rawBytes} raw -> ${p.gzipBytes} gzip`);
    line('');
    line(`  XSS scan of src/ (${xss.scannedFiles.length} file(s): ${xss.scannedFiles.join(', ') || 'none'})`);
    if (xss.scannedFiles.length === 0) {
      line('    [NOT SCANNED] zero files matched the scan patterns, so zero matches were found.');
      line('      This is NOT a clean result. A scan that read nothing cannot prove anything. Fix src/ and re-run.');
    } else {
      line(`    [${result.xss.verdict}] ${xss.matches.length} match(es) for innerHTML, insertAdjacentHTML, outerHTML, concatenated HTML`);
      for (const m of xss.matches) line(`      ${m.file}:${m.line}  ${m.pattern}  ${m.text}`);
      if (xss.matches.length === 0) {
        line(`      Zero matches across ${xss.scannedFiles.length} file(s) read: ${xss.scannedFiles.join(', ')}.`);
        line('      This is a completed scan of a non-empty file list, not a scan that failed to run.');
      }
    }
    line('');
    if (supabase.measured) {
      line('  Supabase');
      line(`    status ${supabase.status}  content-type ${supabase.contentType}`);
      line(`    ${supabase.url}`);
      line(`    response body ${supabase.responseBytes} bytes, ${supabase.rowCount} row(s)`);
    } else {
      line(`  Supabase: NOT MEASURED (${supabase.reason})`);
    }
    line('');
    line(`  VERDICT: ${result.verdict}`);
  }

  process.exit(allPass ? 0 : 1);
}

await main();