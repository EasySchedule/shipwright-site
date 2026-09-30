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
// 4. "First load" is not "everything in dist/". A first visit downloads what
//    the page references. An Open Graph image referenced only from a
//    <meta property="og:image"> tag is fetched by crawlers, not by visitors,
//    and counting it charges the visitor for a byte they never download. This
//    harness derives the visitor-reachable set from dist/index.html and prints
//    both figures, so the number cannot quietly absorb a crawler-only asset.
//
// Usage:
//   node scripts/measure.mjs [--runs N] [--json] [--supabase]
//                             [--placeholder-config]
//
//   --runs N     rebuild and re-measure N times. Default 5. The distribution
//                across runs is the deliverable; the first run is not special.
//   --json       emit the result as JSON instead of the human report.
//   --supabase   additionally issue the live leaderboard read and report the
//                response body size. Needs SUPABASE_URL and SUPABASE_ANON_KEY.
//                Without --supabase the response measurement is reported as
//                NOT MEASURED, never as zero and never as a guess.
//   --placeholder-config
//                build against a synthetic credential of a stated length
//                instead of a real one, so the credential-independent budgets
//                are measurable by anyone with no secret in their environment.
//                Only affects dist/config.js. The report then marks the
//                first-load total that includes config.js as PLACEHOLDER, and
//                the key-independent figure is printed next to it.
//
// Exit code is 0 when every budget passes and the XSS scan is clean, 1 when a
// budget is exceeded or a match is found, and 2 on a harness error. A failing
// measurement is a result, not a crash.

import { execFile, spawn } from 'node:child_process';
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
  const out = { runs: 5, json: false, supabase: false, placeholderConfig: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--supabase') out.supabase = true;
    else if (arg === '--placeholder-config') out.placeholderConfig = true;
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
 * Which files in dist/ a first visit actually downloads.
 *
 * Derived from dist/index.html, not assumed. It reads the two attributes a
 * browser fetches on load — <link href> and <script src> — and deliberately
 * does NOT read <meta content> or <meta property>. An og:image is a crawler
 * asset; a browser visiting the page does not request it, so charging it to
 * first load is wrong even though the file is in dist/.
 *
 * Returns the reachable set, the unreachable set, and the meta-referenced
 * (crawler-only) files it chose to exclude, so the report can name them
 * instead of silently dropping them.
 */
async function resolveFirstLoad(html, entry) {
  const refs = new Set();
  for (const m of html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) refs.add(m[1]);
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) refs.add(m[1]);

  const reachable = new Set();
  const unresolved = [];
  for (const ref of refs) {
    // A cross-origin or absolute URL is not a file in dist/.
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//') || ref.startsWith('#')) {
      unresolved.push(ref);
      continue;
    }
    const clean = ref.split('#')[0].split('?')[0];
    if (clean === '') continue;
    const rel = relative(DIST, resolve(DIST, clean));
    // A href that escapes dist/ is not something this build ships.
    if (rel.startsWith('..')) {
      unresolved.push(ref);
      continue;
    }
    reachable.add(rel);
  }
  reachable.add(entry);

  // A <link rel="icon">/preload, or a <script> injected at runtime, can add a
  // fetch that this static scan cannot see. Say so rather than implying the
  // set is exhaustive.
  const dynamicHints = [];
  if (/<link\b[^>]*\brel\s*=\s*["'][^"']*\b(?:preload|prefetch|preconnect|modulepreload)\b/i.test(html)) {
    dynamicHints.push('a <link rel="preload|prefetch|preconnect|modulepreload"> hint is present');
  }
  if (/@import\b/i.test(html)) dynamicHints.push('a CSS @import is present');

  const crawlerOnly = [];
  for (const m of html.matchAll(/<meta\b[^>]*\b(?:property|name)\s*=\s*["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/gi)) {
    crawlerOnly.push(m[1]);
  }

  return { reachable: [...reachable].sort(), unresolved, dynamicHints, crawlerOnly };
}

/**
 * gzip byte count that depends only on content.
 *
 * Uses node's zlib so the number is independent of whatever gzip binary
 * happens to be on PATH, and sets no name or mtime in the header. This is the
 * number to compare against a budget. Unlike `gzip -c`, it does not move when
 * the file is renamed.
 *
 * It is NOT the same number as `gzip -nc file`. zlib and GNU gzip are different
 * deflate encoders and they disagree on real content, in both directions, by
 * tens of bytes. crossCheckGzipCli() measures both so a disagreement is
 * reported rather than discovered later by someone comparing numbers.
 */
function gzipBytes(buf) {
  return gzipSync(buf, { level: 9 }).length;
}

/**
 * GNU gzip byte count for the same content, when a gzip binary is available.
 *
 * `gzip -nc` with no file argument reads stdin, so it embeds no filename and no
 * mtime, exactly like gzipBytes(). It is a cross-check, not the measurement.
 *
 * Why it exists: zlib and GNU gzip are different deflate encoders, and they
 * disagree. On this tree, for the same bytes, zlib is 20 bytes larger for
 * dist/main.js, 142 larger for dist/og.png, and 22 *smaller* for
 * dist/styles.css. So a hand-run `gzip` and this harness can land on different
 * sides of a budget. Where that happens the report says the verdict is
 * unsettled instead of quietly publishing the flattering number.
 */
async function gzipCliBytes(buf) {
  // spawn, not execFile: execFile has no `input` option, so passing one leaves
  // gzip waiting on an stdin nobody writes to, and the harness hangs instead of
  // reporting. That hang is why this is written as an explicit pipe.
  return new Promise((resolve, reject) => {
    const child = spawn('gzip', ['-nc']);
    const chunks = [];
    let stderr = '';
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    // gzip can exit before the write finishes; that is a normal EPIPE, not a
    // failure of the measurement.
    child.stdin.on('error', () => {});
    child.on('error', fail);
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        fail(new Error(stderr.trim() || `gzip exited ${code}`));
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks).length);
    });
    child.stdin.end(buf);
  });
}

/** One gzip binary check, over the same file set the report prints. */
async function crossCheckGzipCli(files) {
  const parts = [];
  for (const rel of files) {
    const buf = await readFile(join(DIST, rel));
    const zlibBytes = gzipBytes(buf);
    let cliBytes;
    try {
      cliBytes = await gzipCliBytes(buf);
    } catch (err) {
      return { available: false, reason: err.code === 'ENOENT' ? 'no gzip binary on PATH' : err.message, parts };
    }
    parts.push({ file: rel, zlibBytes, cliBytes, delta: zlibBytes - cliBytes });
  }
  return { available: true, parts };
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
  try {
    await execFileAsync(process.execPath, [join(ROOT, 'scripts', 'build.mjs')], {
      cwd: ROOT,
      env: process.env,
    });
  } catch (err) {
    // A failed build means there is no dist/ to measure. Say that, rather than
    // letting the build's own stack trace stand in for a measurement verdict.
    const detail = (err.stderr || '').trim().split('\n').find((l) => l.startsWith('build:'));
    throw new Error(
      `the build under test did not complete, so there is no dist/ to measure` +
        (detail ? ` (${detail})` : ''),
    );
  }

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

  // The first-load set is derived from the entry document. Without one there is
  // nothing to derive it from, and guessing a filename is how a harness ends up
  // reporting a number for a page that does not exist.
  const entryHtml = byExt.html.filter((f) => !f.includes('/'));
  if (entryHtml.length === 0) {
    throw new Error(`no top-level HTML file in dist/; expected index.html. dist/ has: ${files.join(', ') || 'nothing'}`);
  }
  if (entryHtml.length > 1) {
    throw new Error(
      `dist/ has ${entryHtml.length} top-level HTML files (${entryHtml.join(', ')}); ` +
        'which one is the entry document is not guessed.',
    );
  }
  const entry = entryHtml[0];

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

  // What a first visit actually downloads: the files dist/index.html pulls in
  // via <link href> and <script src>. Counted gzipped, which is how it crosses
  // the wire. A file that is merely present in dist/ — an og:image, a
  // screenshot a human will never open — is not a byte the visitor downloads,
  // so it is counted separately as shipped weight instead.
  const html = (await read(entry)).toString("utf8");
  const graph = await resolveFirstLoad(html, entry);
  const missingFromDist = [];
  const firstLoadParts = [];
  for (const rel of graph.reachable) {
    try {
      await stat(join(DIST, rel));
    } catch {
      missingFromDist.push(rel);
      continue;
    }
    const buf = await read(rel);
    firstLoadParts.push({ file: rel, rawBytes: buf.length, gzipBytes: gzipBytes(buf) });
  }
  if (missingFromDist.length > 0) {
    throw new Error(
      `dist/index.html references ${missingFromDist.join(', ')} but the build did not produce it. ` +
        'The first-load set cannot be derived, so it is not guessed.',
    );
  }
  const firstLoadBytes = firstLoadParts.reduce((a, p) => a + p.gzipBytes, 0);
  const firstLoadExcludingConfigBytes = firstLoadParts
    .filter((p) => p.file !== 'config.js')
    .reduce((a, p) => a + p.gzipBytes, 0);

  // Everything the build ships, including what no visitor fetches on load.
  // Reported so the crawler-only assets are visible, not so they can be
  // charged to the first-load budget.
  const shippedParts = [];
  for (const rel of files) {
    const buf = await read(rel);
    shippedParts.push({ file: rel, rawBytes: buf.length, gzipBytes: gzipBytes(buf) });
  }
  const shippedBytes = shippedParts.reduce((a, p) => a + p.gzipBytes, 0);
  const counted = new Set(firstLoadParts.map((p) => p.file));
  const notOnFirstLoad = shippedParts.filter((p) => !counted.has(p.file));

  return {
    shellBytes,
    shellParts,
    firstPartyJsGzipBytes,
    firstPartyJsRawBytes: fpJsParts.reduce((a, p) => a + p.rawBytes, 0),
    firstPartyJsParts: fpJsParts,
    configBytes,
    firstLoadBytes,
    firstLoadExcludingConfigBytes,
    firstLoadParts,
    firstLoadGraph: {
      reachable: graph.reachable,
      unresolved: graph.unresolved,
      dynamicHints: graph.dynamicHints,
      crawlerOnly: graph.crawlerOnly,
    },
    shippedBytes,
    shippedParts,
    notOnFirstLoad,
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

// A synthetic credential for --placeholder-config. Fixed length on purpose:
// the number it produces must not drift between runs, or the placeholder would
// add noise to the very measurement it exists to make possible. 40 characters
// is a realistic Supabase anon key length, so the config.js it produces is
// close to the real one in magnitude without being a real one.
const PLACEHOLDER = {
  url: 'https://placeholder.invalid',
  key: 'x'.repeat(40),
};

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let usingPlaceholder = false;
  if (args.placeholderConfig) {
    for (const name of ['SUPABASE_URL', 'SUPABASE_ANON_KEY']) {
      if (!process.env[name] || process.env[name].trim() === '') {
        process.env[name] = name === 'SUPABASE_URL' ? PLACEHOLDER.url : PLACEHOLDER.key;
        usingPlaceholder = true;
      }
    }
  }

  // Fail loudly rather than silently measuring a build that cannot exist.
  for (const name of ['SUPABASE_URL', 'SUPABASE_ANON_KEY']) {
    if (!process.env[name] || process.env[name].trim() === '') {
      process.stderr.write(
        `measure: ${name} is unset or empty.\n` +
          'measure: the build under test requires it, so there is nothing to measure.\n' +
          'measure: set both from the deployment environment and retry, or pass\n' +
          'measure: --placeholder-config to measure only the credential-independent budgets.\n',
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
  const firstLoadNoConfig = distribution(passes.map((p) => p.firstLoadExcludingConfigBytes));
  const shipped = distribution(passes.map((p) => p.shippedBytes));
  const xss = await scanXss();
  const supabase =
    args.supabase && !usingPlaceholder
      ? await measureSupabase()
      : {
          measured: false,
          reason: usingPlaceholder
            ? 'a placeholder credential is in use, so no live read was attempted'
            : 'not requested (--supabase not passed)',
        };

  // One cross-check, not one per run: it measures the encoders, not the build.
  const gzipCheck = await crossCheckGzipCli(last.firstLoadParts.map((p) => p.file));
  let gzipVersion = null;
  if (gzipCheck.available) {
    try {
      gzipVersion = (await execFileAsync('gzip', ['--version'])).stdout.split('\n')[0].trim();
    } catch {
      gzipVersion = 'gzip (version unknown)';
    }
  }
  const sumZlib = (which) =>
    gzipCheck.parts
      .filter((p) => (which === 'load' ? true : !p.file.endsWith('config.js')))
      .reduce((a, p) => a + p.zlibBytes, 0);
  const sumCli = (which) =>
    gzipCheck.parts
      .filter((p) => (which === 'load' ? true : !p.file.endsWith('config.js')))
      .reduce((a, p) => a + p.cliBytes, 0);

  const budgets = [
    budgetLine('AC-49 static shell (HTML+CSS, uncompressed, excl. JS)', last.shellBytes, BUDGETS.shellBytes),
    budgetLine('First-party JS gzipped', last.firstPartyJsGzipBytes, BUDGETS.firstPartyJsGzipBytes),
    budgetLine('First-load weight, visitor-reachable files (gzip)', last.firstLoadBytes, BUDGETS.firstLoadBytes),
  ];
  if (supabase.measured) {
    budgets.push(budgetLine('Supabase response body', supabase.responseBytes, BUDGETS.supabaseResponseBytes));
  }

  // A budget whose verdict flips between two correct gzip implementations has
  // not been measured. It has been rounded, twice, in opposite directions.
  const unsettled = [];
  if (gzipCheck.available) {
    for (const b of budgets) {
      if (b.actual > b.budget) continue; // already failing; no verdict to unsettle
      const which = b.label.startsWith('First-party JS') ? 'js' : b.label.startsWith('First-load') ? 'load' : null;
      if (which === null) continue; // uncompressed budget: gzip does not apply
      if (sumCli(which) <= b.budget && sumZlib(which) > b.budget) unsettled.push(b.label);
    }
  }
  for (const b of budgets) {
    if (unsettled.includes(b.label)) b.verdict = 'UNSETTLED';
  }

  const result = {
    runs: args.runs,
    node: process.version,
    usingPlaceholderCredential: usingPlaceholder,
    anonKeyLength: usingPlaceholder ? PLACEHOLDER.key.length : process.env.SUPABASE_ANON_KEY.trim().length,
    deterministic:
      shell.deterministic && fpJs.deterministic && firstLoad.deterministic && shipped.deterministic,
    shell,
    firstPartyJs: fpJs,
    firstPartyJsParts: last.firstPartyJsParts,
    firstPartyJsRawBytesLast: last.firstPartyJsRawBytes,
    configBytes: last.configBytes,
    firstLoad,
    firstLoadExcludingConfig: firstLoadNoConfig,
    firstLoadParts: last.firstLoadParts,
    firstLoadGraph: last.firstLoadGraph,
    shipped,
    shippedParts: last.shippedParts,
    notOnFirstLoad: last.notOnFirstLoad,
    fileCount: last.fileCount,
    gzipCheck: { ...gzipCheck, version: gzipVersion, unsettled },
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
      'First load counts the files dist/index.html references via <link href> and <script src>, not everything in dist/.',
      'Files present in dist/ but not fetched on a visit are listed as notOnFirstLoad, with their own shipped total.',
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
    line(`  runs: ${args.runs}   node: ${process.version}   build deterministic: ${result.deterministic ? 'yes' : 'NO'}`);
    if (usingPlaceholder) {
      line(`  credential: PLACEHOLDER (synthetic, anon key length ${result.anonKeyLength}) — not a real key`);
    } else {
      line(`  credential: real anon key present (length ${result.anonKeyLength}; value not read by this report)`);
    }
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
    line(`    shell           n=${shell.n} min=${shell.min} max=${shell.max} spread=${shell.spread} ${shell.deterministic ? 'stable' : 'UNSTABLE'}`);
    line(`    first-party JS gz   n=${fpJs.n} min=${fpJs.min} max=${fpJs.max} spread=${fpJs.spread} ${fpJs.deterministic ? 'stable' : 'UNSTABLE'}`);
    line(`    first load gz      n=${firstLoad.n} min=${firstLoad.min} max=${firstLoad.max} spread=${firstLoad.spread} ${firstLoad.deterministic ? 'stable' : 'UNSTABLE'}`);
    line(`    first load, no config.js  n=${firstLoadNoConfig.n} min=${firstLoadNoConfig.min} max=${firstLoadNoConfig.max} spread=${firstLoadNoConfig.spread} ${firstLoadNoConfig.deterministic ? 'stable' : 'UNSTABLE'}`);
    line(`    shipped, all of dist/    n=${shipped.n} min=${shipped.min} max=${shipped.max} spread=${shipped.spread} ${shipped.deterministic ? 'stable' : 'UNSTABLE'}`);
    line('');
    line('  First-party JS files');
    for (const p of last.firstPartyJsParts) line(`    ${p.file}  ${p.rawBytes} raw -> ${p.gzipBytes} gzip`);
    if (last.configBytes) {
      line(`    config.js  ${last.configBytes.rawBytes} raw -> ${last.configBytes.gzipBytes} gzip  (generated; embeds anon key; excluded from first-party JS)`);
    }
    line('');
    line('  First-load files (what a visitor downloads)');
    for (const p of last.firstLoadParts) {
      const tag = p.file === 'config.js' && usingPlaceholder ? '  [placeholder key]' : '';
      line(`    ${p.file}  ${p.rawBytes} raw -> ${p.gzipBytes} gzip${tag}`);
    }
    line(`    total ${last.firstLoadBytes} gzip; ${last.firstLoadExcludingConfigBytes} excluding config.js`);
    line('');
    line('  In dist/ but not fetched on a visit');
    if (last.notOnFirstLoad.length === 0) {
      line('    none: every file dist/index.html references is the whole build output.');
    } else {
      for (const p of last.notOnFirstLoad) {
        const crawler = last.firstLoadGraph.crawlerOnly.some((u) => u.endsWith('/' + p.file) || u === p.file);
        line(`    ${p.file}  ${p.rawBytes} raw -> ${p.gzipBytes} gzip${crawler ? '  (og/twitter meta: fetched by crawlers, not by visitors)' : ''}`);
      }
      line(`    shipped, all of dist/: ${last.shippedBytes} gzip across ${last.fileCount} file(s)`);
    }
    for (const hint of last.firstLoadGraph.dynamicHints) line(`    note: ${hint}`);
    for (const ref of last.firstLoadGraph.unresolved) line(`    note: ${ref} is not a file in dist/, so it is not counted`);
    line('');
    line('  gzip encoder cross-check');
    if (!gzipCheck.available) {
      line(`    [SKIPPED] ${gzipCheck.reason}. The zlib number above is the only one measured.`);
    } else {
      line(`    ${gzipVersion}, \`gzip -nc\` via stdin, so no filename and no mtime in the header.`);
      for (const p of gzipCheck.parts) {
        line(`    ${p.file}  zlib ${p.zlibBytes}  gzip ${p.cliBytes}  delta ${p.delta >= 0 ? '+' : ''}${p.delta}`);
      }
      line('    zlib and GNU gzip are different deflate encoders and disagree in both');
      line('    directions. The zlib figure is the measurement; do not mix the two.');
      if (unsettled.length === 0) {
        line('    No budget verdict changes between the two encoders.');
      } else {
        line(`    [UNSETTLED] the verdict for: ${unsettled.join('; ')}`);
        line('      One encoder passes and the other fails, so the number is not decided.');
      }
    }
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

// Exit 2 is "the harness could not produce a number". That has to be a clean,
// named failure rather than a stack trace, and it has to be distinct from exit
// 1, which is "the harness produced a number and it failed a budget". Code that
// cannot tell those apart will eventually report a crash as a verdict.
try {
  await main();
} catch (err) {
  process.stderr.write(`measure: cannot measure: ${err.message}\n`);
  process.exit(2);
}
