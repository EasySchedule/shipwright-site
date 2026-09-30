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

// Tokens that cannot follow a complete regex literal: the start of an
// identifier or a number, `$`, or a string.
//
// A run followed by one of these is provably arithmetic, because the pattern
// reading would be two adjacent expressions, which is a syntax error:
//
//   const n = f(x) / 2 / 3;
//                    ^^^^  the run closes here, and `3` follows it
//
// The test is deliberately one-sided. Everything else -- `(`, `[`, `{`, a
// template, any operator -- *can* follow a pattern, because `/re/(s)`, `/re/[0]`
// and a template tag are all ordinary JavaScript. Those leave both readings real
// and this guard has to stay on, since it is the only thing between the run and
// dist/. An unrecognised token is read as "can follow a pattern", which is the
// safe direction: the guard fires on correct code, which is a red build with a
// message, instead of staying quiet on a mangled pattern, which is a wrong
// number on the page.
const CANNOT_FOLLOW_PATTERN = /[A-Za-z0-9_$'\"]/;

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
  // True while nothing but whitespace has been emitted since the last line
  // terminator. Nothing has been emitted at all at the start of the file, which
  // is the same thing.
  let lineStart = true;

  const regexAllowed = () => {
    if (lastChar === '') return true;
    if (lastChar === ')' || lastChar === ']' || lastChar === '}') return false;
    if (isIdentifierChar(lastChar)) {
      // A number literal may be followed by division; an identifier may not.
      return !lastWord;
    }
    return true;
  };

  /**
   * Scan the `/`-run that starts at the `/` at index `from`, and return the
   * index just past it, flags included, or -1 if the run does not close on this
   * line.
   *
   * A regex literal cannot contain a raw newline, so that is the only thing that
   * can fail, and a failure means there is no pattern here -- the character is a
   * division operator and nothing is copied for it.
   *
   * This is also the one place the minifier does not have to guess. Everywhere
   * else it decides regex-or-division from `lastChar`, because the previous
   * character settles it. At the start of a line there is no previous character
   * to consult -- the one before the line break says nothing about this `/` --
   * and both readings are real:
   *
   *   if (1)
   *     / foo - bar /.test(s)      a pattern
   *   return (a)
   *     / 2 / 3;                   a division
   *
   * So at the start of a line the run is copied byte for byte and the guess is
   * skipped. That is safe in both directions, and it needs no third heuristic to
   * be safe in both directions, because whitespace is significant in only one of
   * them: inside a pattern, where copying it preserves the match, and not inside
   * a division, where the `/` characters are operators and the spaces between
   * them mean nothing. The JavaScript parser, which can see the whole program, is
   * the thing that decides which of the two it is looking at.
   *
   * This is the position that reached `dist/` in SHI-64. The guard below only
   * looks at runs whose closing `)`, `]` or `}` is on the same line, so a
   * statement beginning on its own line after a block was unguarded, and the
   * minifier was guessing about it too: it exited 0 and published `/foo-bar/`
   * for a source whose `/ foo - bar /` did not match.
   */
  const scanRegexRun = (from) => {
    let j = from + 1;
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
    if (!closed) return -1;
    while (j < n && /[a-z]/.test(source[j])) j += 1;
    return j;
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
    return false;
  };

  const push = (text) => {
    out += text;
    // Whitespace is not a statement. A push that is only spaces leaves the
    // line-start state alone; the two places that emit a newline set it
    // themselves, right after pushing.
    if (/\S/.test(text)) lineStart = false;
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
      lineStart = true;
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
        lineStart = true;
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

    // Regex literal. `lineStart` covers the positions where `lastChar` cannot:
    // see scanRegexRun, which is also where the reason for copying a
    // line-leading run verbatim is written down.
    if (ch === '/' && (lineStart || regexAllowed() || REGEX_PRECEDING_KEYWORDS.has(lastWord))) {
      const end = scanRegexRun(i);
      if (end !== -1) {
        push(source.slice(i, end));
        i = end;
        continue;
      }
      // Nothing closes on this line, so there is no pattern to copy. It is a
      // division operator, and the push below emits it as one.
    }

    push(ch);
    i += 1;
  }

  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim() + '\n';
}

// Characters that mean a `/`-run is a piece of code rather than one pattern.
// Used only to keep the guard below from mistaking ordinary division for a
// regex literal; it never causes a mangled pattern to be published.
const CODE_PUNCTUATION = /[;{},()=]/;

/**
 * Refuse to publish source that the minifier is known to mangle.
 *
 * Known, narrow limitation. From a `/` alone the minifier cannot tell a
 * division from a regex literal, and after `)`, `]` or `}` both readings are
 * real: `if (x) /re/.test(s)` is a pattern, `(a + b) / 2` is a division. With
 * the closer on the same line that is all the minifier has to go on, and it
 * guesses "division", then re-whitespaces the run as if it were ordinary code.
 *
 * Inside a pattern, whitespace is significant. So `/ foo - bar /` becomes
 * `/foo-bar/`, which turns a non-match into a match, with no error anywhere:
 *
 *   if (1) / foo - bar /.test("foo-bar")   // false
 *   if (1) /foo-bar/.test("foo-bar")       // true
 *
 * `assertParses` cannot catch this, because the mangled output still parses
 * perfectly. `node --check` proves syntax, not meaning.
 *
 * So the build stops instead of shipping it. The check is narrow on purpose: it
 * only considers a run that reads as one whole pattern, and only complains when
 * minifying that run in its own position would actually change it. A
 * hand-written page has no reason to contain one, and a red build beats a
 * leaderboard quietly showing the wrong number.
 *
 * This covers the same-line positions only, and on its own that left the
 * line-leading ones unguarded: the walk back to the closer stopped at a newline,
 * so a statement beginning on its own line after a block reached `dist/` with a
 * mangled pattern and an exit code of 0. Those are closed in minifyJs instead,
 * which copies a line-leading run byte for byte rather than guessing about it.
 * There is nothing left here for them, so nothing here refuses them.
 *
 * Fixing the remaining guessing properly means a real JavaScript lexer, which is
 * a lot of code to carry for a few kilobytes of first-party source. That trade
 * is a review decision, not a build-script decision.
 */
export function findUnmangleableRuns(source) {
  const offenders = [];
  const n = source.length;

  for (let i = 0; i < n; i += 1) {
    if (source[i] !== '/') continue;

    // The previous non-space character has to be one of the three that make
    // the reading ambiguous. Spaces and tabs only, and not newlines: a `/` that
    // starts a line is handled by minifyJs copying the run verbatim, so there is
    // nothing here for this guard to refuse, and refusing it would be refusing
    // correct code. See the note on the regex branch in minifyJs.
    let k = i - 1;
    while (k >= 0 && (source[k] === ' ' || source[k] === '\t')) k -= 1;
    if (k < 0) continue;
    const prev = source[k];
    if (prev !== ')' && prev !== ']' && prev !== '}') continue;

    // Skip `//` and `/*`, which are comments, not literals.
    if (source[i + 1] === '/' || source[i + 1] === '*') continue;

    // Find a closing `/` on the same line, respecting `[...]`.
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
    if (!closed) continue;

    while (j < n && /[a-z]/.test(source[j])) j += 1;
    const run = source.slice(i, j);

    // If the next token cannot follow a complete pattern, this is not one whole
    // pattern but the first half of `left / b / c`, and there is nothing in it
    // to mangle. `/ 2 /` is a legal pattern and `f(x) / 2 / 3` is legal division,
    // so every other test below passes on it, and the guard used to report
    // ordinary arithmetic as a mangled pattern. See CANNOT_FOLLOW_PATTERN for
    // why the test runs the other way round, and for why that direction matters.
    let after = j;
    while (after < n && (source[after] === ' ' || source[after] === '\t')) after += 1;
    if (after < n && CANNOT_FOLLOW_PATTERN.test(source[after])) continue;

    // A run containing code punctuation is an expression, not a pattern.
    if (CODE_PUNCTUATION.test(run)) continue;

    // Strip the delimiters to get the pattern itself.
    const closer = run.replace(/^\//, '').replace(/\/[a-z]*$/, '');
    if (closer === '') continue;
    try {
      new RegExp(closer);
    } catch {
      continue;
    }

    // Compare in context, not in isolation. Minified on its own the run always
    // begins at position 0, where the leading `/` is unambiguously a pattern and
    // it is copied verbatim. It only gets re-whitespaced in the position this
    // guard is about, so that is the position it has to be tested in. The
    // closer that made the position ambiguous is prepended rather than a fixed
    // `)`, so the context is the one the run actually sits in.
    if (minifyJs(`${prev}${run}`).trim() !== `${prev}${run}`) offenders.push(run);
  }

  return offenders;
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

      // Refuse before writing anything, not after: a mangled pattern parses
      // fine, so `assertParses` would wave it through.
      const offenders = findUnmangleableRuns(source);
      if (offenders.length > 0) {
        process.stderr.write(
          `build: ${rel}: ${offenders.length} regex literal(s) the minifier would ` +
            'mangle, because a `/` follows `)`, `]` or `}` and cannot be told ' +
            'apart from a division.\n',
        );
        for (const run of offenders) {
          process.stderr.write(`  would change: ${JSON.stringify(run)}\n`);
        }
        process.stderr.write(
          'build: rewrite it so the division or the regex is unambiguous, for ' +
            'example by assigning the left side to a variable first.\n',
        );
        process.exit(1);
      }

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
