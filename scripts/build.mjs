#!/usr/bin/env node
// Shipwright site build.
//
// Node standard library only. No imports outside `node:*`, no dependencies,
// no bundler. It copies `src/` into `dist/`, minifies the first-party
// JavaScript, and writes `dist/config.js` from two environment variables.
//
// The credential check below is the reason this script exists in its own
// right. A missing Supabase credential must fail the build on the machine that
// is doing the building, loudly, before anything is published. It must never
// produce a dist/ that deploys cleanly and then fails to read the database in
// a browser, because that failure is invisible in CI and shows up only as an
// empty leaderboard on a public URL.
//
// Only the two public variables below are ever read. The Supabase service-role
// key is deliberately not supported here: it bypasses RLS and has no business
// in a static site build.

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// The two build variables. These names are the entire credential contract.
const REQUIRED_VARS = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'];

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(ROOT, 'src');
const OUT_DIR = join(ROOT, 'dist');

/**
 * Read the two required variables, or exit non-zero naming what is missing.
 * An empty string counts as missing; so does whitespace-only.
 */
function readConfig() {
  const values = {};
  const missing = [];

  for (const name of REQUIRED_VARS) {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') {
      missing.push(name);
      continue;
    }
    values[name] = raw.trim();
  }

  if (missing.length > 0) {
    process.stderr.write(
      `build: missing required environment variable${missing.length > 1 ? 's' : ''}: ` +
        `${missing.join(', ')}\n`,
    );
    process.stderr.write(
      'build: set ' +
        REQUIRED_VARS.join(' and ') +
        ' in the build environment. Names only; see .env.example. Never commit real values.\n',
    );
    process.exit(1);
  }

  return values;
}

/** Recursively list every file under `dir`, as paths relative to `dir`. */
async function listFiles(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listFiles(abs);
      for (const rel of nested) out.push(join(relative(dir, abs), rel));
    } else if (entry.isFile()) {
      out.push(relative(dir, abs));
    }
  }
  return out.sort();
}

const WORD = /[A-Za-z0-9_$]/;
// A `/` after one of these tokens starts a regex, not a division.
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await',
]);

function isIdentifierChar(ch) {
  return ch !== undefined && WORD.test(ch);
}

/**
 * Minify first-party JavaScript by removing comments and unnecessary
 * whitespace.
 *
 * This is deliberately a conservative minifier, not a real parser. It is
 * string-, template- and regex-literal aware, and it never joins two tokens
 * that could merge into one (`a / /re/` stays spaced, `a + +b` stays spaced,
 * an identifier followed by a template literal keeps its space so it is not
 * silently re-read as a tagged template). Newlines are preserved as line
 * terminators wherever the source had one, so automatic semicolon insertion
 * behaves exactly as it did in the source.
 *
 * Consequence to be honest about: this reduces bytes and strips comments. It
 * does not rename locals or fold expressions the way a full minifier would.
 * That is the correct trade for a few kilobytes of hand-written first-party
 * code with no dependencies to satisfy.
 */
export function minifyJs(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  // Last emitted significant character, for the token-merge checks below.
  let lastChar = '';
  // Last emitted identifier/keyword, for regex-vs-division detection.
  let lastWord = '';
  let pendingSpace = false;

  const regexAllowed = () => {
    if (lastChar === '') return true;
    if (lastChar === ')' || lastChar === ']' || lastChar === '}') return false;
    if (isIdentifierChar(lastChar)) {
      // A number literal may be followed by division; an identifier may not.
      return !lastWord;
    }
    return true;
  };

  const needSpaceBetween = (nextCh) => {
    const a = lastChar;
    const b = nextCh;
    if (a === '') return false;
    if (isIdentifierChar(a) && isIdentifierChar(b)) return true;
    // Keep the token boundary that would otherwise be lost.
    if (a === '+' && b === '+') return true;
    if (a === '-' && b === '-') return true;
    if (a === '/' && (b === '/' || b === '*')) return true;
    if (a === '+' && b === '/') return true;
    if (a === '-' && b === '/') return true;
    if (b === '+' && (a === a)) return false;
    return false;
  };

  const push = (text) => {
    out += text;
    for (const ch of text) {
      if (/\s/.test(ch)) continue;
      lastChar = ch;
      if (isIdentifierChar(ch)) {
        lastWord = lastWord + ch;
        if (!/[A-Za-z0-9_$]/.test(lastWord[lastWord.length - 1])) lastWord = ch;
        continue;
      }
      lastWord = '';
    }
  };

  const pushSpaceIfNeeded = (nextCh) => {
    if (!pendingSpace) return;
    pendingSpace = false;
    if (nextCh === '\n' || nextCh === undefined) return;
    if (needSpaceBetween(nextCh)) push(' ');
  };

  /** Collapse a run of horizontal whitespace. Returns true if a line ended. */
  const handleWhitespace = (start) => {
    let j = start;
    let sawNewline = false;
    while (j < n && /\s/.test(source[j])) {
      if (source[j] === '\n') sawNewline = true;
      j += 1;
    }
    if (j >= n) {
      pendingSpace = false;
      return j;
    }
    if (sawNewline) {
      pushSpaceIfNeeded(source[j]);
      push('\n');
      pendingSpace = false;
    } else {
      pendingSpace = true;
    }
    return j;
  };

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (/\s/.test(ch)) {
      i = handleWhitespace(i);
      continue;
    }

    // Line comment. Stop before the newline so it stays a line terminator.
    if (ch === '/' && next === '/') {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      pendingSpace = true;
      continue;
    }

    // Block comment. A comment containing a newline keeps a newline, so ASI
    // decisions downstream are unchanged.
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      const body = source.slice(i, stop);
      if (body.includes('\n')) {
        pushSpaceIfNeeded('x');
        push('\n');
        pendingSpace = false;
      } else {
        pendingSpace = true;
      }
      i = stop;
      continue;
    }

    pushSpaceIfNeeded(ch);
    pendingSpace = false;

    // Quoted string.
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === ch) { j += 1; break; }
        j += 1;
      }
      push(source.slice(i, j));
      i = j;
      continue;
    }

    // Template literal, including nested ${ } expressions.
    if (ch === '`') {
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '`') { j += 1; break; }
        if (source[j] === '$' && source[j + 1] === '{') {
          // Copy the expression verbatim; the source is already readable and
          // rewriting it would need a real parser.
          let depth = 1;
          j += 2;
          while (j < n && depth > 0) {
            const c = source[j];
            if (c === '\\') { j += 2; continue; }
            if (c === '{') depth += 1;
            else if (c === '}') depth -= 1;
            else if (c === '"' || c === "'" || c === '`') {
              const q = c;
              j += 1;
              while (j < n) {
                if (source[j] === '\\') { j += 2; continue; }
                if (source[j] === q) { j += 1; break; }
                j += 1;
              }
              continue;
            }
            j += 1;
          }
          continue;
        }
        j += 1;
      }
      push(source.slice(i, j));
      i = j;
      continue;
    }

    // Regex literal.
    if (ch === '/' && (regexAllowed() || REGEX_PRECEDING_KEYWORDS.has(lastWord))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const c = source[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '\n') break;
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) { j += 1; closed = true; break; }
        j += 1;
      }
      if (closed) {
        while (j < n && /[a-z]/.test(source[j])) j += 1;
        push(source.slice(i, j));
        i = j;
        continue;
      }
    }

    push(ch);
    i += 1;
  }

  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim() + '\n';
}

/** Reject output that is not parseable, so a minifier bug is a red build. */
async function assertParses(file) {
  try {
    await execFileAsync(process.execPath, ['--check', file], { cwd: ROOT });
  } catch (err) {
    process.stderr.write(`build: minified output failed to parse: ${file}\n`);
    process.stderr.write(`${err.stderr || err.message}\n`);
    process.exit(1);
  }
}

export async function build() {
  const config = readConfig();

  // A clean output directory, so a removed source file cannot survive in a
  // rebuild and quietly stay published.
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const files = await listFiles(SRC_DIR);
  if (files.length === 0) {
    process.stderr.write('build: src/ is empty; nothing to publish\n');
    process.exit(1);
  }

  let jsBytes = 0;
  let rawJsBytes = 0;

  for (const rel of files) {
    const from = join(SRC_DIR, rel);
    const to = join(OUT_DIR, rel);
    await mkdir(dirname(to), { recursive: true });

    if (extname(rel) === '.js') {
      const source = await readFile(from, 'utf8');
      const minified = minifyJs(source);
      rawJsBytes += Buffer.byteLength(source);
      jsBytes += Buffer.byteLength(minified);
      await writeFile(to, minified, 'utf8');
      await assertParses(to);
    } else {
      await writeFile(to, await readFile(from));
    }
  }

  // Runtime configuration, written as a plain script so the page can read it
  // before any module executes. JSON.stringify is the escaping: the value
  // cannot break out of the string literal.
  const configJs =
    '// Generated by scripts/build.mjs. Do not edit, do not commit.\n' +
    '//\n' +
    '// Contains the Supabase anon (publishable) key, which is designed to be\n' +
    '// readable by a browser and is constrained by RLS. The service-role key\n' +
    '// is never read by this build.\n' +
    'globalThis.SHIPWRIGHT_CONFIG = Object.freeze({\n' +
    `  supabaseUrl: ${JSON.stringify(config.SUPABASE_URL)},\n` +
    `  supabaseAnonKey: ${JSON.stringify(config.SUPABASE_ANON_KEY)},\n` +
    '});\n';
  await writeFile(join(OUT_DIR, 'config.js'), configJs, 'utf8');

  const pct = rawJsBytes === 0 ? 0 : Math.round((1 - jsBytes / rawJsBytes) * 100);
  process.stdout.write(
    `build: ${files.length} file(s) -> dist/  ` +
      `js ${rawJsBytes} -> ${jsBytes} bytes (-${pct}%)  ` +
      `config.js written\n`,
  );
}

// Run as a script, not when scripts/dev.mjs imports build().
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await build();
}
