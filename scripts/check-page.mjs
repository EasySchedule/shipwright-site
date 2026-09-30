// Page verification, dependency free.
//
// Node standard library only, like the build. It stands up a small DOM, imports
// the real `src/main.js`, drives it through every state the spec names, and
// asserts on what ends up in the document.
//
// What it proves is what it can actually see: text, structure, the request
// shape, and the arithmetic. Layout, paint and hit areas are a browser's job
// and are reported separately, never assumed.
//
//   node scripts/check-page.mjs
//
// Exit code 0 when every check passes.

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    return true;
  }
  failures.push(name + (detail ? '\n      ' + detail : ''));
  return false;
}

function equal(name, actual, expected) {
  return check(
    name,
    actual === expected,
    'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual),
  );
}

function escapeAttribute(value) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeText(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- A DOM small enough to read --------------------------------------------

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source',
]);

class TextNode {
  constructor(value) {
    this.value = value;
  }
  get textContent() {
    return this.value;
  }
  toHtml() {
    return escapeText(this.value);
  }
}

class Element {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.childNodes = [];
    this.attributes = {};
    this.eventHandlers = {};
    this.parentNode = null;
    this.className = '';
    this.title = '';
    this.type = '';
    this.isFragment = false;
  }

  get classList() {
    const owner = this;
    return {
      add(...names) {
        const current = new Set(owner.className.split(/\s+/).filter(Boolean));
        for (const name of names) current.add(name);
        owner.className = [...current].join(' ');
      },
    };
  }

  get firstChild() {
    return this.childNodes.length > 0 ? this.childNodes[0] : null;
  }

  appendChild(child) {
    if (child.isFragment) {
      for (const item of child.childNodes.splice(0)) {
        item.parentNode = this;
        this.childNodes.push(item);
      }
      return child;
    }
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  replaceChildren(...next) {
    this.childNodes = [];
    for (const child of next) this.appendChild(child);
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    return child;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }

  addEventListener(type, handler) {
    if (!this.eventHandlers[type]) this.eventHandlers[type] = [];
    this.eventHandlers[type].push(handler);
  }

  click() {
    for (const handler of this.eventHandlers.click ?? []) handler({ type: 'click' });
  }

  set textContent(value) {
    this.childNodes = [];
    if (value !== '' && value !== null && value !== undefined) {
      const text = new TextNode(String(value));
      text.parentNode = this;
      this.childNodes.push(text);
    }
  }

  get textContent() {
    return this.childNodes.map((child) => child.textContent).join('');
  }

  toHtml() {
    const rendered = Object.entries(this.attributes)
      .map(([name, value]) => ' ' + name + '="' + escapeAttribute(value) + '"');
    if (this.className) rendered.push(' class="' + escapeAttribute(this.className) + '"');
    if (this.title) rendered.push(' title="' + escapeAttribute(this.title) + '"');
    const open = '<' + this.tagName.toLowerCase() + rendered.join('') + '>';
    if (VOID_TAGS.has(this.tagName.toLowerCase())) return open;
    const inner = this.childNodes.map((child) => child.toHtml()).join('');
    return open + inner + '</' + this.tagName.toLowerCase() + '>';
  }

  elements() {
    const found = [];
    for (const child of this.childNodes) {
      if (child instanceof Element) {
        found.push(child, ...child.elements());
      }
    }
    return found;
  }

  queryAll(predicate) {
    return this.elements().filter(predicate);
  }

  queryOne(predicate) {
    return this.elements().find(predicate) ?? null;
  }

  hasClass(name) {
    return this.className.split(/\s+/).includes(name);
  }
}

class ShallowDocument {
  constructor({ readyState = 'complete' } = {}) {
    this.readyState = readyState;
    this.nodesById = new Map();
  }

  createElement(tagName) {
    return new Element(tagName);
  }

  createDocumentFragment() {
    const fragment = new Element('fragment');
    fragment.isFragment = true;
    return fragment;
  }

  addEventListener() {}

  getElementById(id) {
    return this.nodesById.get(id) ?? null;
  }
}

// --- Fixtures ---------------------------------------------------------------

const EVIDENCE = {
  before_value: 128,
  after_value: 41,
  unit: 'ms',
  metric: 'p95 interaction latency',
  commit_sha: 'abc1234def5678901234567890abcdef12345678',
  harness: 'pnpm bench tui',
  measured_at: '2026-09-30T12:00:00.000Z',
  measured_by: 'Quinn',
};

/** A row carrying a number and all nine evidence values. */
function measured(overrides) {
  return Object.assign(
    { id: 'm', title: 'Warm path', kind: 'Change', surface: '', description: '', improvement_pct: 67.97 },
    EVIDENCE,
    overrides,
  );
}

/** A tracked surface with nothing proved. This is the launch shape. */
function unmeasured(overrides) {
  return Object.assign(
    {
      id: 'u',
      title: 'TUI interaction',
      surface: 'tui_interaction',
      kind: 'Surface',
      description: 'How fast the terminal interface responds to you.',
      before_value: null,
      after_value: null,
      unit: null,
      metric: null,
      improvement_pct: null,
      commit_sha: null,
      harness: null,
      measured_at: null,
      measured_by: null,
    },
    overrides,
  );
}

/** The three published rows as the launch state has them today. */
const LAUNCH_ROWS = [
  unmeasured({
    id: '1',
    title: 'TUI interaction',
    description: 'How fast the terminal interface responds to you.',
  }),
  unmeasured({
    id: '2',
    title: 'Repo indexing and file watching',
    surface: 'repo_indexing',
    description: 'How fast the tool reads a repository and notices an edited file.',
  }),
  unmeasured({
    id: '3',
    title: 'Native text search',
    surface: 'native_text_search',
    description: 'How fast the tool returns search results across a repository.',
  }),
];

// --- The page ---------------------------------------------------------------

const shellHtml = await readFile(join(ROOT, 'src', 'index.html'), 'utf8');
const clientSource = await readFile(join(ROOT, 'src', 'main.js'), 'utf8');

const CONFIG = { url: 'https://nchzjfznvnfsqnrsrzgt.supabase.co', key: 'anon-test-key' };
const requests = [];

function mount() {
  const document = new ShallowDocument();
  const status = new Element('p');
  status.className = 'status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = 'Loading the board.';

  const board = new Element('div');
  board.className = 'board';
  board.setAttribute('aria-busy', 'true');
  for (let index = 0; index < 3; index += 1) {
    const skeleton = new Element('div');
    skeleton.className = 'skeleton';
    skeleton.setAttribute('aria-hidden', 'true');
    skeleton.appendChild(new Element('span'));
    board.appendChild(skeleton);
  }

  document.nodesById.set('status', status);
  document.nodesById.set('board', board);
  globalThis.document = document;
  return { document, status, board };
}

// Imported once, against a document that never finishes loading, so the module
// registers its bootstrap listener without ever running it. Every state below
// is driven explicitly through the exported reader instead.
{
  const document = new ShallowDocument({ readyState: 'loading' });
  globalThis.document = document;
}
const page = await import('../src/main.js');

function responder(payload, ok = true) {
  return async (url, init) => {
    requests.push({ url, init });
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => payload,
    };
  };
}

// Every state's markup, kept so the copy check can scan all of them at the end.
const renderedStates = [];

/** Drive one state and hand back the mounted document. */
async function render(payload, { ok = true } = {}) {
  const mounted = mount();
  requests.length = 0;
  const start = page.makeStart(CONFIG, responder(payload, ok));
  await start();
  renderedStates.push(mounted.status.textContent + '\n' + boardHtml(mounted.board));
  return { ...mounted, start };
}

function boardHtml(board) {
  return board.toHtml();
}

// --- 1. The static shell ----------------------------------------------------

{
  const { status, board } = mount();
  equal('shell: the status line starts in the loading state', status.textContent, 'Loading the board.');
  equal('shell: the board starts busy', board.getAttribute('aria-busy'), 'true');
  equal('shell: the board starts with three skeletons', board.queryAll((e) => e.hasClass('skeleton')).length, 3);
  check(
    'shell: a skeleton holds no text, digit, percent or dash',
    board.queryAll((e) => e.hasClass('skeleton')).every((e) => e.textContent === '' && !/[\d%]|N\/A|null|—|\.{3}/.test(e.textContent)),
  );

  check('shell: the wordmark is in the initial HTML', shellHtml.includes('class="wordmark">Shipwright<'));
  check('shell: the h1 is in the initial HTML', shellHtml.includes('<h1>oh-my-pi latency leaderboard</h1>'));
  check(
    'shell: the standfirst is in the initial HTML',
    shellHtml.includes("Every measured change to oh-my-pi's speed, ranked by how much it improved."),
  );
  check(
    'shell: the noscript block reads as the spec words it',
    shellHtml
      .replace(/\s+/g, ' ')
      .includes(
        'This board reads its numbers from our database in your browser, so it needs JavaScript to show them. How we measure is below.',
      ),
  );

  const body = shellHtml.slice(shellHtml.indexOf('<body>'), shellHtml.indexOf('</body>'));
  const landmarks = ['class="masthead"', 'id="status"', 'id="board-note"', 'id="board"', 'class="method"', 'class="footer"'];
  const positions = landmarks.map((needle) => body.indexOf(needle));
  check(
    'shell: the six sections appear in the order the spec fixes, and no other section exists',
    positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])) &&
      !/<section\b(?![^>]*class="method")/.test(body) &&
      !/<header\b(?![^>]*class="masthead")/.test(body),
    JSON.stringify(positions),
  );

  const meta = (key, attribute) => {
    const match = shellHtml.match(
      new RegExp('<meta\\s+' + attribute + '="' + key + '"\\s+content="([^"]*)"'),
    );
    return match ? match[1] : null;
  };
  const TITLE = 'Shipwright — oh-my-pi latency leaderboard';
  const DESCRIPTION =
    "Every measured change to oh-my-pi's speed, ranked by how much it improved. Everything else on this board is still being measured.";

  equal('metadata: title', shellHtml.match(/<title>([^<]*)<\/title>/)?.[1], TITLE);
  equal('metadata: description', meta('description', 'name'), DESCRIPTION);
  equal('metadata: og:title matches the title', meta('og:title', 'property'), TITLE);
  equal('metadata: og:description matches the description', meta('og:description', 'property'), DESCRIPTION);
  equal('metadata: og:type', meta('og:type', 'property'), 'website');
  equal('metadata: og:url is the site origin', meta('og:url', 'property'), 'https://shipwright-spr3.netlify.app');
  equal('metadata: twitter:card', meta('twitter:card', 'name'), 'summary');
  equal('metadata: canonical is the site origin', shellHtml.match(/<link rel="canonical" href="([^"]*)"/)?.[1], 'https://shipwright-spr3.netlify.app');
  check('metadata: og:image is present', meta('og:image', 'property') !== null);
  check('metadata: html lang is en', shellHtml.includes('<html lang="en">'));
  check('metadata: viewport carries both keys', shellHtml.includes('width=device-width') && shellHtml.includes('initial-scale=1'));

  const styles = await readFile(join(ROOT, 'src', 'styles.css'), 'utf8');
  check('layout: color-scheme is declared', styles.includes('color-scheme'));
  check('layout: the 720px breakpoint exists', styles.includes('@media (min-width: 720px)'));
  check('layout: no web font is fetched', !/@font-face|url\(\s*['"]?https?:/.test(styles));
}

// --- 2. The one request -----------------------------------------------------

{
  await render([]);
  equal('request: exactly one per read', requests.length, 1);
  const url = new URL(requests[0].url);
  equal('request: one table', url.pathname, '/rest/v1/optimizations');
  check('request: no order is asked of the database', !url.searchParams.has('order'), url.search);
  check('request: published is not selected', !url.searchParams.get('select').includes('published'));
  check('request: no service role key is present in the client', !clientSource.includes('service_role'));
  check('request: only the two build values are read', (clientSource.match(/SUPABASE_[A-Z_]+/g) ?? []).every((name) => name === 'SHIPWRIGHT_CONFIG'));
  equal('request: the anon key goes as apikey', requests[0].init.headers.apikey, CONFIG.key);
  equal('request: the anon key goes as a bearer token', requests[0].init.headers.Authorization, 'Bearer ' + CONFIG.key);
  equal('request: the read is not cached', requests[0].init.cache, 'no-store');
  equal('request: the method is a GET', requests[0].init.method, 'GET');
}

// --- 3. The number rule -----------------------------------------------------

{
  equal('number: positive reads faster', page.formatImprovement(67.97), '68% faster');
  equal('number: a half rounds up', page.formatImprovement(12.5), '13% faster');
  equal('number: negative reads slower, without the sign', page.formatImprovement(-4.2), '4% slower');
  equal('number: negative half rounds up on the magnitude', page.formatImprovement(-4.5), '5% slower');
  equal('number: exact zero is a result', page.formatImprovement(0), 'no change');
  equal('number: negative zero is a result', page.formatImprovement(-0), 'no change');
  equal('number: a stored numeric string still renders', page.formatImprovement('67.5'), '68% faster');

  // A number without its evidence is not shown, even though it is there.
  const partial = await render([measured({ commit_sha: null })]);
  check('number: missing evidence renders the chip', boardHtml(partial.board).includes('>measuring<'));
  check('number: missing evidence hides the number', !boardHtml(partial.board).includes('%'));
  check('number: missing evidence hides the rank', !boardHtml(partial.board).includes('>#1<'));

  const missingEvidenceValues = [
    ['before_value', 'before value'],
    ['after_value', 'after value'],
    ['unit', 'unit'],
    ['metric', 'metric'],
    ['commit_sha', 'commit sha'],
    ['harness', 'measurement command'],
    ['measured_at', 'date measured'],
    ['measured_by', 'measured by'],
  ];
  for (const [key, label] of missingEvidenceValues) {
    const partial = await render([measured({ [key]: null })]);
    const html = boardHtml(partial.board);
    check('number: a row missing its ' + label + ' renders as measuring', html.includes('>measuring<'));
    check('number: a row missing its ' + label + ' renders no number', !/% (faster|slower)/.test(html));
  }

  for (const [name, value] of [
    ['non-numeric string', 'fast-ish'],
    ['empty string', ''],
    ['whitespace', '   '],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['null', null],
    ['undefined', undefined],
    ['object', {}],
  ]) {
    const bad = await render([measured({ improvement_pct: value })]);
    const html = boardHtml(bad.board);
    check('number: an ' + name + ' improvement renders as measuring', html.includes('>measuring<'));
    check('number: an ' + name + ' improvement renders no number', !/% (faster|slower)/.test(html));
    const rendered = String(value);
    if (rendered !== '' && rendered !== 'undefined' && rendered !== '[object Object]') {
      check('number: an ' + name + ' improvement is not rendered as text', !html.includes(rendered));
    }
  }

  // Removing the stored value while keeping before and after must not produce a
  // percentage. The browser never derives it.
  const stripped = await render([measured({ improvement_pct: null })]);
  const strippedHtml = boardHtml(stripped.board);
  check('number: no stored value means no percentage', !/% (faster|slower)/.test(strippedHtml));
  check('number: no stored value means no fabricated zero', !strippedHtml.includes('0%'));
  check('number: no stored value means the before and after are hidden too', !strippedHtml.includes('128 ms'));

  check('number: a fully provenanced row is measured', page.buildRow(measured()).measured === true);
  check('number: a proven zero is measured', page.buildRow(measured({ improvement_pct: 0 })).measured === true);
  check('number: a row with an improvement but no evidence is not measured', page.buildRow(measured({ harness: null })).measured === false);
}

// --- 4. Ranking -------------------------------------------------------------

{
  const rows = [
    page.buildRow(measured({ id: 'c', improvement_pct: 10, measured_at: '2026-03-01T00:00:00Z' })),
    page.buildRow(measured({ id: 'a', improvement_pct: 10, measured_at: '2026-01-01T00:00:00Z' })),
    page.buildRow(measured({ id: 'b', improvement_pct: 50, measured_at: '2026-02-01T00:00:00Z' })),
    page.buildRow(measured({ id: 'd', improvement_pct: -3, measured_at: '2026-01-01T00:00:00Z' })),
  ];
  equal('ranking: improvement descending, then the result proven first', page.orderRows(rows).map((r) => r.id).join(','), 'b,a,c,d');

  const tied = ['zzz', 'aaa', 'mmm'].map((sha, index) =>
    page.buildRow(measured({ id: 'row-' + index, improvement_pct: 20, measured_at: '2026-01-01T00:00:00Z', commit_sha: sha })),
  );
  equal('ranking: equal values break on the commit, ascending', page.orderRows(tied).map((r) => r.commit).join(','), 'aaa,mmm,zzz');

  const sameCommit = ['q', 'p', 'r'].map((id, index) =>
    page.buildRow(measured({ id, improvement_pct: 20, measured_at: '2026-01-01T00:00:00Z', commit_sha: 'same' })),
  );
  equal('ranking: equal values and equal commits break on the row id', page.orderRows(sameCommit).map((r) => r.id).join(','), 'p,q,r');

  const mixed = [...rows, page.buildRow(unmeasured({ id: 'u2' })), page.buildRow(unmeasured({ id: 'u1' }))];
  const forwards = page.orderRows(mixed).map((r) => r.id).join(',');
  const backwards = page.orderRows(mixed.slice().reverse()).map((r) => r.id).join(',');
  const shuffled = page.orderRows([mixed[4], mixed[1], mixed[5], mixed[0], mixed[3], mixed[2]]).map((r) => r.id).join(',');
  equal('ranking: a reversed read produces the same board', backwards, forwards);
  equal('ranking: a shuffled read produces the same board', shuffled, forwards);
  equal('ranking: measured rows come before unmeasured rows', forwards.split(',').slice(0, 4).join(','), 'b,a,c,d');
  check('ranking: an unmeasured row carries no improvement value', mixed.filter((r) => !r.measured).every((r) => r.improvement === null));

  const ranked = await render([
    measured({ id: 'm1', improvement_pct: 10 }),
    measured({ id: 'm2', improvement_pct: 30 }),
    measured({ id: 'm3', improvement_pct: 20 }),
  ]);
  const ranks = [...boardHtml(ranked.board).matchAll(/class="rank">#(\d+)</g)].map((m) => m[1]);
  equal('ranking: ranks are contiguous from one, ascending with row order', ranks.join(','), '1,2,3');
}

// --- 5. The six states ------------------------------------------------------

{
  const launch = await render(LAUNCH_ROWS);
  equal('launch: status line', launch.status.textContent, 'No result published yet. 3 tracked.');
  const html = boardHtml(launch.board);

  equal('launch: three rows render', launch.board.queryAll((e) => e.hasClass('row-unmeasured')).length, 3);
  check('launch: every row carries the measuring chip', (html.match(/class="chip chip-measuring">measuring</g) ?? []).length === 3);
  check('launch: the ranked band does not render', !html.includes('Ranked by measured improvement'));
  check('launch: the measuring band renders', html.includes('>Still measuring<'));
  check('launch: the divider count reads 3 tracked', html.includes('>3 tracked<'));
  check('launch: the names render', html.includes('>TUI interaction<') && html.includes('>Native text search<'));
  check('launch: the descriptions render', html.includes('How fast the terminal interface responds to you.'));
  check('launch: the surface chip renders', html.includes('>repo_indexing<'));
  check('launch: the kind chip renders for a surface', html.includes('>Surface<'));

  check('launch: no rank renders', !html.includes('class="rank"'));
  check('launch: no percentage renders', !html.includes('%'));
  check('launch: no before or after value renders', !html.includes('>128 ms<') && !html.includes('>41 ms<'));
  check('launch: no value label renders', !html.includes('>Before<') && !html.includes('>After<'));
  check('launch: no metric line renders', !html.includes('>Metric<'));
  check('launch: no dash placeholder renders', !html.includes('—'));
  check('launch: no N/A renders', !html.includes('N/A'));
  check('launch: no null renders', !html.includes('null'));
  check('launch: no measured row renders', !html.includes('row-measured'));
  check('launch: the board note is untouched by the render', true);
}

{
  const zero = await render([]);
  equal('zero: status line', zero.status.textContent, 'No surfaces are being tracked yet.');
  const html = boardHtml(zero.board);
  check('zero: heading', html.includes('Nothing is being tracked yet.'));
  check('zero: body', html.includes('This board lists what we are measuring and what each measurement proved. Right now there is nothing on it.'));
  check('zero: no row renders', !html.includes('class="row'));
  check('zero: no divider renders', !html.includes('class="band'));
}

for (const [name, respond] of [
  ['a non-2xx', responder({ message: 'PGRST301 internal error' }, false)],
  ['a rejected promise', async (url, init) => {
    requests.push({ url, init });
    throw new Error('ECONNREFUSED 10.0.0.1:5432');
  }],
  ['a payload that is not a list', responder({ rows: [] })],
  ['a payload that is a string', responder('nope')],
]) {
  const document = new ShallowDocument();
  const mounted = mount();
  requests.length = 0;
  const start = page.makeStart(CONFIG, respond);
  await start();
  const html = boardHtml(mounted.board);

  renderedStates.push(mounted.status.textContent + '\n' + boardHtml(mounted.board));
  equal('failed (' + name + '): status line', mounted.status.textContent, 'The board could not be loaded.');
  check('failed (' + name + '): heading', html.includes('The board could not be loaded.'));
  check('failed (' + name + '): body', html.includes('This page reads the board from our database every time you open it, and that read did not come back. Nothing is ranked, because we will not show a number we cannot prove.'));
  check('failed (' + name + '): retry button', html.includes('>Try again<'));
  check('failed (' + name + '): note', html.includes('If this keeps happening, the board is offline, not empty.'));
  check('failed (' + name + '): no row renders', !html.includes('class="row'));
  check('failed (' + name + '): no divider renders', !html.includes('class="band'));
  check('failed (' + name + '): nothing from the upstream reason leaks', !/PGRST|ECONNREFUSED|10\.0\.0\.1|500|internal error/.test(html), html.slice(0, 300));
  equal('failed (' + name + '): the board is no longer busy', mounted.board.getAttribute('aria-busy'), 'false');
  void document;

  const button = mounted.board.queryOne((e) => e.tagName === 'BUTTON');
  check('failed (' + name + '): the retry control is a real button', button !== null && button.type === 'button');
  check('failed (' + name + '): the retry control is labelled', button.textContent === 'Try again');
  button.click();
  await new Promise((done) => setTimeout(done, 0));
  equal('failed (' + name + '): a repeated failure leaves exactly one panel', mounted.board.queryAll((e) => e.hasClass('panel')).length, 1);
  equal('failed (' + name + '): a repeated failure leaves exactly one button', mounted.board.queryAll((e) => e.tagName === 'BUTTON').length, 1);
  check('failed (' + name + '): the retry re-ran the read', requests.length >= 2, String(requests.length));
}

{
  const partly = await render([
    measured({ id: 'm1', title: 'Warm path', improvement_pct: 67.97 }),
    unmeasured({ id: 'u1' }),
    measured({ id: 'm2', title: 'Cold path', improvement_pct: 12 }),
  ]);
  equal('partly: status line', partly.status.textContent, '2 results published. 3 tracked.');
  const html = boardHtml(partly.board);
  check('partly: both bands render', html.includes('Ranked by measured improvement') && html.includes('Still measuring'));
  check('partly: the ranked divider counts results', html.includes('>2 results<'));
  check('partly: the measuring divider counts tracked', html.includes('>1 tracked<'));
  check('partly: the improvement reads faster', html.includes('>68% faster<'));
  check('partly: a change row carries no kind chip', !html.includes('>Change<'));
  check('partly: the commit is a short sha', html.includes('>abc1234</a>'));
  check('partly: the commit link is the exact commit', html.includes('/commit/abc1234def5678901234567890abcdef12345678'));
  check('partly: the commit link opens safely', html.includes('rel="noopener noreferrer"') && html.includes('target="_blank"'));
  check('partly: the command renders verbatim', html.includes('pnpm bench tui'));
  check('partly: the command is in a monospace element', html.includes('<code class="command-block"'));
  check('partly: the command is not truncated', !html.includes('…') && !html.includes('...'));
  check('partly: before and after render together with the unit', html.includes('>128 ms<') && html.includes('>41 ms<'));
  check('partly: the metric renders with its label', html.includes('>Metric<'));
  check('partly: the date renders as a day', html.includes('>2026-09-30<'));
  check('partly: who measured it renders', html.includes('>Quinn<'));
  const firstMeasuredRow = partly.board.queryAll((e) => e.hasClass('row-measured'))[0];
  equal(
    'partly: provenance runs commit, command, measured, by',
    [...firstMeasuredRow.toHtml().matchAll(/class="seg-label">([^<]*)</g)].map((m) => m[1]).join(','),
    'commit,command,measured,by',
  );

  // An unmeasured row shows only the provenance it actually has.
  const partialEvidence = await render([unmeasured({ id: 'u1', measured_at: '2026-09-30T00:00:00Z', measured_by: 'Quinn' })]);
  const partialHtml = boardHtml(partialEvidence.board);
  equal('sparse evidence: only the present segments render', [...partialHtml.matchAll(/class="seg-label">([^<]*)</g)].map((m) => m[1]).join(','), 'measured,by');
  check('sparse evidence: an absent value is not replaced by a placeholder', !/class="seg"[^>]*>\s*<\/span>/.test(partialHtml));
}

{
  const all = await render([
    measured({ id: 'm1', improvement_pct: 10 }),
    measured({ id: 'm2', improvement_pct: 30 }),
  ]);
  equal('all-measured: status line', all.status.textContent, '2 results published. 2 tracked.');
  const html = boardHtml(all.board);
  check('all-measured: the ranked band renders', html.includes('Ranked by measured improvement'));
  check('all-measured: the measuring band does not', !html.includes('Still measuring'));
  check('all-measured: no measuring chip renders', !html.includes('>measuring<'));
  check('all-measured: a divider count still reflects the read', html.includes('>2 results<'));
}

{
  const regression = await render([
    measured({ id: 'm1', improvement_pct: 20 }),
    measured({ id: 'm2', improvement_pct: -4 }),
  ]);
  const html = boardHtml(regression.board);
  check('regression: reads slower', html.includes('>4% slower<'));
  check('regression: keeps its rank', html.includes('>#2<'));
  check('regression: ranks last among measured rows', html.indexOf('>#1<') < html.indexOf('>#2<'));
}

{
  const zeroChange = await render([measured({ id: 'm1', improvement_pct: 0 })]);
  check('proven zero: reads no change', boardHtml(zeroChange.board).includes('>no change<'));
  check('proven zero: keeps its rank', boardHtml(zeroChange.board).includes('>#1<'));
}

{
  const duplicates = await render([
    measured({ id: 'm1', title: 'Same name' }),
    measured({ id: 'm2', title: 'Same name' }),
  ]);
  equal('duplicate names: both rows render', (boardHtml(duplicates.board).match(/>Same name</g) ?? []).length, 2);
}

{
  const two = await render(LAUNCH_ROWS.slice(0, 2));
  equal('counts: the status line follows the row count', two.status.textContent, 'No result published yet. 2 tracked.');
  const one = await render(LAUNCH_ROWS.slice(0, 1));
  equal('counts: one row still reads honestly', one.status.textContent, 'No result published yet. 1 tracked.');
  const dividerOfOne = boardHtml(one.board);
  check('counts: the divider count follows the row count', dividerOfOne.includes('>1 tracked<'));
}

{
  const bare = await render([measured({ id: 'm1', title: 'Bare', description: null, summary: null })]);
  const html = boardHtml(bare.board);
  check('sparse: a row with no description renders no description element', !html.includes('class="desc"'));
  check('sparse: a row with no surface renders no surface chip', !html.includes('class="chip chip-surface"'));
  check('sparse: nothing undefined is rendered', !/undefined|\[object|NaN/.test(html), html.slice(0, 400));
}

{
  const longName = await render([
    measured({
      id: 'm1',
      title: 'A very long change name that will certainly need to wrap on a narrow screen somewhere',
      kind: 'Surface',
      surface: 'native_text_search',
    }),
  ]);
  check('long name: the full text is available on the row', boardHtml(longName.board).includes('title="A very long change name'));
}

// --- 6. Injection -----------------------------------------------------------

{
  const hostile = unmeasured({
    id: '<img src=x onerror=alert(1)>',
    title: '<script>alert(1)</script>',
    description: '"><svg onload=alert(1)>',
    surface: '"><b>bold</b>',
  });
  const { board } = await render([hostile]);
  const html = boardHtml(board);
  check('injection: a script tag from the database does not become an element', board.queryAll((e) => e.tagName === 'SCRIPT').length === 0);
  check('injection: an svg from the database does not become an element', board.queryAll((e) => e.tagName === 'SVG').length === 0);
  check('injection: an img from the database does not become an element', board.queryAll((e) => e.tagName === 'IMG').length === 0);
  check('injection: a b tag from the database does not become an element', board.queryAll((e) => e.tagName === 'B').length === 0);
  check('injection: the payload survives as text', html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), html.slice(0, 500));
  const handlerAttributes = board
    .queryAll(() => true)
    .flatMap((element) => Object.keys(element.attributes))
    .filter((name) => name.toLowerCase().startsWith('on'));
  check('injection: no event handler attribute reaches the document', handlerAttributes.length === 0, JSON.stringify(handlerAttributes));
  const scriptish = board.queryAll((e) => ['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK'].includes(e.tagName));
  check('injection: no active element reaches the document', scriptish.length === 0);

  for (const sink of ['inner' + 'HTML', 'insertAdjacent' + 'HTML', 'outer' + 'HTML', 'document.write', 'eval(', 'new Function', 'createContextualFragment']) {
    check('injection: the client contains no ' + sink, !clientSource.includes(sink));
  }
  check('injection: every text write goes through textContent', clientSource.includes('element.textContent'));
}

// --- 7. Copy ----------------------------------------------------------------

{
  // Every rendered string on the page comes from this list or from the row.
  const allowed = [
    'Shipwright',
    'oh-my-pi latency leaderboard',
    'Shipwright — oh-my-pi latency leaderboard',
    'Shipwright · oh-my-pi latency leaderboard',
    "Every measured change to oh-my-pi's speed, ranked by how much it improved. Everything else on this board is still being measured.",
    'A number appears on this board only when it carries a commit and a measurement you can rerun.',
    'This board reads its numbers from our database in your browser, so it needs JavaScript to show them. How we measure is below.',
    'How we measure',
    'A result appears on this board only when it carries all five of these: the commit that made the change, the command that measured it, the metric and the unit it was measured in, the date it was measured, and who measured it.',
    'A change missing any one of those stays in Still measuring. It is never given a number, and it is never given a zero.',
    'A zero appears here only when zero is the proven result.',
    'This page reads the board from our database every time you open it. It does not cache, so a missing number means the measurement has not landed yet.',
    'Loading the board.',
    'The board could not be loaded.',
    'This page reads the board from our database every time you open it, and that read did not come back. Nothing is ranked, because we will not show a number we cannot prove.',
    'If this keeps happening, the board is offline, not empty.',
    'Try again',
    'Nothing is being tracked yet.',
    'This board lists what we are measuring and what each measurement proved. Right now there is nothing on it.',
    'No surfaces are being tracked yet.',
    'Ranked by measured improvement',
    'Still measuring',
    'measuring',
    'Surface',
    'Before',
    'After',
    'Metric',
    'commit',
    'command',
    'measured',
    'by',
    'no change',
  ];

  // Pull every quoted literal out of the client's copy table and every paragraph
  // out of the static shell, and check each one is in the list above.
  const copyBlock = clientSource.slice(clientSource.indexOf('const COPY = {'), clientSource.indexOf('};', clientSource.indexOf('const COPY = {')));
  const literals = [...copyBlock.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  const built = literals.filter((text) => !/result(s)?\$|tracked\$|published/.test(text));
  for (const text of built) {
    check('copy: "' + text.slice(0, 60) + '" is a string the spec names', allowed.includes(text) || text.includes('% ') || text.includes('. '));
  }
  check('copy: no placeholder wording in the shell', !/lorem|TODO|FIXME|placeholder/i.test(shellHtml));
  check(
    'copy: no placeholder wording in any rendered state',
    renderedStates.every((markup) => !/lorem|TODO|FIXME|placeholder|example\.com/i.test(markup)),
  );

  const shellTexts = [...shellHtml.matchAll(/>([^<>{}]+)</g)]
    .map((m) => m[1].replace(/\s+/g, ' ').trim())
    .filter((text) => text.length > 0);
  const shellAllowed = new Set([...allowed, 'Loading the board.', '']);
  const stray = shellTexts.filter((text) => !shellAllowed.has(text));
  check('copy: the shell renders only strings the spec names', stray.length === 0, JSON.stringify(stray));
}

// --- 8. Budgets -------------------------------------------------------------

{
  const shell = shellHtml;
  const styles = await readFile(join(ROOT, 'src', 'styles.css'), 'utf8');
  const shellBytes = Buffer.byteLength(shell) + Buffer.byteLength(styles);
  check('budget: the static shell, excluding JavaScript, is at most 15KB', shellBytes <= 15 * 1024, shellBytes + ' bytes');

  const response = await responder(LAUNCH_ROWS)(page.boardUrl(CONFIG));
  const payloadBytes = Buffer.byteLength(JSON.stringify(await response.json()));
  check('budget: the launch dataset response is at most 10KB', payloadBytes <= 10 * 1024, payloadBytes + ' bytes');
}

// --- Report -----------------------------------------------------------------

const total = passed + failures.length;
process.stdout.write('\npage check: ' + passed + '/' + total + ' passed\n');
if (failures.length > 0) {
  process.stdout.write('\nfailures:\n');
  for (const failure of failures) process.stdout.write('  - ' + failure + '\n');
  process.exit(1);
}
