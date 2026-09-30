// Shipwright leaderboard.
//
// No framework, no bundler, no runtime dependency, no SDK. The page reads one
// HTTP endpoint, PostgREST, with the two public credentials that
// scripts/build.mjs wrote into config.js, and renders the result.
//
// The service-role key is never used here and never appears in this file. It
// bypasses row level security; the browser has no write path at all, so it has
// no reason to hold one. The only credential this page sends is the anon key,
// which is designed to be readable by a browser and is bounded by RLS.
//
// The number rule is the whole point of this file, so it is stated once and
// then obeyed everywhere: a row renders a numeric improvement only when every
// provenance value it would be leaning on is present. A row with a stored
// improvement and a missing provenance value renders as `measuring`, and no
// number appears anywhere in that row. See spec section 16.
//
// The functions that decide measuredness, ordering, counts and wording are
// exported and free of DOM access, so a verification harness can drive them
// with fixtures under Node without a browser. The three renderers are exported
// for the same reason: given a DOM, a harness can render all six states from a
// fixture and assert on the rendered text without a network or a real
// database. They consume exactly the results above.

// ---------------------------------------------------------------------------
// Columns. Named against public.optimizations as Rin's schema actually
// defines it; no column name here is guessed.
// ---------------------------------------------------------------------------

const SELECT_COLUMNS = [
  'id',
  'created_at',
  'title',
  'surface',
  'kind',
  'summary',
  'before_value',
  'after_value',
  'unit',
  'metric',
  'improvement_pct',
  'commit_sha',
  'harness',
  'measured_at',
  'measured_by',
].join(',');

// Spec section 3.1: the `surface` value maps to a displayed label. A row's own
// name is never remapped; this table is only used to decide whether the
// surface chip is worth rendering at all.
const SURFACE_LABELS = {
  tui_interaction: 'TUI interaction',
  repo_indexing: 'Repo indexing and file watching',
  native_text_search: 'Native text search',
};

// Spec section 6: the commit links to this repository. It is publicly
// readable, so the SHA renders as an anchor rather than as plain text.
const COMMIT_BASE = 'https://github.com/EasySchedule/oh-my-pi/commit/';

// The eight provenance values a measured row must carry, plus the improvement
// itself which is checked separately. This mirrors the database's
// optimizations_improvement_requires_evidence constraint. The constraint also
// requires commit_url; the spec does not list it, the page builds the link from
// the SHA, and a stored URL is not something the page needs in order to be
// honest about a number.
const REQUIRED_PROVENANCE = [
  'commit_sha',
  'harness',
  'measured_at',
  'measured_by',
  'metric',
  'unit',
];

// ---------------------------------------------------------------------------
// Copy. Spec section 5 is the whole vocabulary of this product. Nothing else
// renders user-visible text.
// ---------------------------------------------------------------------------

const COPY = {
  loadingStatus: 'Loading the board.',
  failedStatus: 'The board could not be loaded.',
  zeroStatus: 'No surfaces are being tracked yet.',
  noneMeasuredStatus: (total) => `No result published yet. ${total} tracked.`,
  publishedStatus: (measured, total) => `${measured} results published. ${total} tracked.`,
  rankedDivider: 'Ranked by measured improvement',
  rankedDividerCount: (measured) => `${measured} results`,
  measuringDivider: 'Still measuring',
  measuringDividerCount: (total) => `${total} tracked`,
  zeroHeading: 'Nothing is being tracked yet.',
  zeroBody: 'This board lists what we are measuring and what each measurement proved. Right now there is nothing on it.',
  failHeading: 'The board could not be loaded.',
  failBody: 'This page reads the board from our database every time you open it, and that read did not come back. Nothing is ranked, because we will not show a number we cannot prove.',
  retryLabel: 'Try again',
  retryHint: 'If this keeps happening, the board is offline, not empty.',
  measuringChip: 'measuring',
  kindChip: 'Surface',
  labels: {
    before: 'Before',
    after: 'After',
    metric: 'Metric',
    commit: 'commit',
    command: 'command',
    measured: 'measured',
    by: 'by',
  },
};

// ---------------------------------------------------------------------------
// Pure core. No DOM access below this line until the renderers.
// ---------------------------------------------------------------------------

/** True for a value that is present: not null, not undefined, not blank text. */
export function isPresent(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

/** True only for a real finite number. A numeric string is not accepted. */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Whether a row may render numbers, derived from the data rather than declared
 * by any stored flag. A row cannot claim to be measured; it either carries the
 * evidence or it renders as `measuring`.
 */
export function isMeasured(row) {
  if (!row || typeof row !== 'object') return false;
  if (!isFiniteNumber(row.improvement_pct)) return false;
  if (!isFiniteNumber(row.before_value) || !isFiniteNumber(row.after_value)) return false;
  return REQUIRED_PROVENANCE.every((field) => isPresent(row[field]));
}

/** Sortable value for a timestamp. An unparseable date sorts last, never first. */
function timeValue(value) {
  const parsed = Date.parse(isPresent(value) ? String(value) : '');
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

function byId(a, b) {
  const x = String(a?.id ?? '');
  const y = String(b?.id ?? '');
  if (x === y) return 0;
  return x < y ? -1 : 1;
}

/**
 * Measured rows: stored improvement descending, then measured_at ascending, then
 * commit SHA ascending lexicographic, then row id ascending. Spec section 8
 * rule 4, in that order and no other keys.
 */
function compareMeasured(a, b) {
  if (b.improvement_pct !== a.improvement_pct) return b.improvement_pct - a.improvement_pct;
  const byTime = timeValue(a.measured_at) - timeValue(b.measured_at);
  if (byTime !== 0) return byTime;
  const xa = String(a.commit_sha ?? '');
  const xb = String(b.commit_sha ?? '');
  if (xa !== xb) return xa < xb ? -1 : 1;
  return byId(a, b);
}

/**
 * Unmeasured rows: created_at ascending, then row id ascending. The spec says
 * they keep the order they were returned in, which for the seed is insertion
 * order, and also that a shuffled read must produce the same board. Sorting on
 * the stored creation order satisfies both readings at once, and adds no sort
 * key of its own.
 */
function compareUnmeasured(a, b) {
  const byTime = timeValue(a?.created_at) - timeValue(b?.created_at);
  if (byTime !== 0) return byTime;
  return byId(a, b);
}

/**
 * Split a read into the ranked band and the unmeasured band, each in its own
 * total order. Ranks are assigned after sorting, contiguous from 1, and only to
 * measured rows.
 */
export function rankRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const measured = list
    .filter(isMeasured)
    .sort(compareMeasured)
    .map((row, index) => ({ row, rank: index + 1 }));
  const unmeasured = list.filter((row) => !isMeasured(row)).sort(compareUnmeasured);
  return { measured, unmeasured };
}

/**
 * The status line, from the counts of the read result. AC-28: these two counts
 * and the divider count are the only numbers the page may render outside a
 * measured row's own cells.
 */
export function statusLine(measuredCount, totalCount) {
  if (measuredCount > 0) return COPY.publishedStatus(measuredCount, totalCount);
  return COPY.noneMeasuredStatus(totalCount);
}

/**
 * The improvement as displayed.
 *
 * The value is read from storage, never derived from before and after. Rounding
 * is display formatting of a stored number. A half rounds up, so a negative
 * half rounds toward zero, which is what Math.round does.
 *
 * The sign is carried by the word, never by a minus sign: AC-11 gives the three
 * wordings as `<n>% faster`, `<n>% slower` and `no change`, so a stored
 * improvement of -4.5 renders `4% slower` and never `-4% slower`.
 *
 * `no change` is chosen on the stored value being exactly zero, because AC-11
 * keys the three wordings on the stored value's sign and zero. A stored
 * improvement of less than half a percent therefore rounds to a zero percentage
 * rather than to `no change`; that follows the criterion rather than the
 * tidier-sounding alternative.
 */
export function formatImprovement(value) {
  if (value === 0) return 'no change';
  const rounded = Math.abs(Math.round(value));
  return value > 0 ? `${rounded}% faster` : `${rounded}% slower`;
}

/** A number as stored, with the stored unit appended. No re-rounding, no conversion. */
export function formatValue(value, unit) {
  const text = String(value);
  return isPresent(unit) ? `${text} ${unit}` : text;
}

/** The seven-character short SHA the commit segment renders. */
export function shortSha(sha) {
  return String(sha ?? '').slice(0, 7);
}

/** The full commit URL for the anchor. */
export function commitUrl(sha) {
  return `${COMMIT_BASE}${encodeURIComponent(String(sha ?? ''))}`;
}

/**
 * The date as rendered: the leading date of the stored timestamp. Reading the
 * date off the stored string rather than formatting a Date keeps a measurement
 * on the day it was made, whatever timezone the reader's browser is in.
 */
export function measuredDate(value) {
  return String(value ?? '').slice(0, 10);
}

/**
 * The provenance segments a row may render, in the order spec AC-10 gives:
 * commit, command, measured, by. A segment whose value is absent is omitted
 * entirely, never replaced by a placeholder glyph.
 */
export function provenanceSegments(row) {
  const segments = [];
  if (isPresent(row?.commit_sha)) {
    segments.push({ label: COPY.labels.commit, kind: 'commit', value: shortSha(row.commit_sha), raw: String(row.commit_sha) });
  }
  if (isPresent(row?.harness)) {
    segments.push({ label: COPY.labels.command, kind: 'command', value: String(row.harness) });
  }
  if (isPresent(row?.measured_at)) {
    segments.push({ label: COPY.labels.measured, kind: 'measured', value: measuredDate(row.measured_at) });
  }
  if (isPresent(row?.measured_by)) {
    segments.push({ label: COPY.labels.by, kind: 'by', value: String(row.measured_by) });
  }
  return segments;
}

/** The surface chip renders only when the label is not identical to the name. */
export function surfaceChip(row) {
  const label = SURFACE_LABELS[row?.surface];
  if (!label) return null;
  if (isPresent(row?.title) && label === String(row.title)) return null;
  return label;
}

/** Whether the kind chip applies. Only `Surface` gets a chip. */
export function kindChip(row) {
  return row?.kind === 'Surface' ? COPY.kindChip : null;
}

/**
 * The read result as rows, or null when the payload is not the shape this page
 * can render. A payload it cannot parse is a read failure, not an empty board.
 */
export function parsePayload(payload) {
  if (!Array.isArray(payload)) return null;
  for (const row of payload) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// The one request. PostgREST, no SDK, no server, no serverless function.
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 20000;

function readConfig() {
  const config = globalThis.SHIPWRIGHT_CONFIG;
  if (!config) return null;
  const url = typeof config.supabaseUrl === 'string' ? config.supabaseUrl.trim() : '';
  const key = typeof config.supabaseAnonKey === 'string' ? config.supabaseAnonKey.trim() : '';
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ''), key };
}

export function buildRequestUrl(baseUrl) {
  const query = [
    `select=${SELECT_COLUMNS}`,
    'published=eq.true',
    'order=created_at.asc,id.asc',
  ].join('&');
  return `${baseUrl}/rest/v1/optimizations?${query}`;
}

async function readBoard(config, signal) {
  const response = await fetch(buildRequestUrl(config.url), {
    method: 'GET',
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      Accept: 'application/json',
    },
    cache: 'no-store',
    signal,
  });
  if (!response.ok) throw new Error('read failed');
  const rows = parsePayload(await response.json());
  // A payload this page cannot parse is a failed read, not an empty board.
  if (rows === null) throw new Error('unreadable payload');
  return rows;
}

// ---------------------------------------------------------------------------
// Rendering. Everything below writes text with textContent, never innerHTML,
// so a stored string can never become markup.
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function chip(text, extraClass) {
  const node = el('span', `chip${extraClass ? ` ${extraClass}` : ''}`, text);
  return node;
}

function labelled(label, value, className) {
  const node = el('span', className || 'kv');
  node.append(el('span', 'kv__label', label));
  node.append(document.createTextNode(' '));
  node.append(el('span', 'kv__value', value));
  return node;
}

function divider(label, count, modifier) {
  const node = el('div', `divider divider--${modifier}`);
  node.append(el('span', 'divider__label', label));
  node.append(el('span', 'divider__count', count));
  return node;
}

function provenanceStrip(row) {
  const segments = provenanceSegments(row);
  if (segments.length === 0) return null;
  const strip = el('p', 'prov');
  for (const segment of segments) {
    const seg = el('span', `prov__seg prov__seg--${segment.kind}`);
    seg.append(el('span', 'prov__label', segment.label));
    if (segment.kind === 'commit') {
      const link = el('a', 'prov__sha', segment.value);
      link.href = commitUrl(segment.raw);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      seg.append(link);
    } else if (segment.kind === 'command') {
      seg.append(el('code', 'prov__command', segment.value));
    } else {
      seg.append(el('span', `prov__${segment.kind}`, segment.value));
    }
    strip.append(seg);
  }
  return strip;
}

function rowHead(row) {
  const head = el('div', 'row__head');
  const idBlock = el('div', 'row__idblock');
  const name = el('h3', 'row__name', isPresent(row.title) ? row.title : '');
  if (isPresent(row.title)) name.title = String(row.title);
  idBlock.append(name);
  if (isPresent(row.summary)) idBlock.append(el('p', 'row__desc', row.summary));
  head.append(idBlock);
  const kind = kindChip(row);
  const surface = surfaceChip(row);
  if (kind || surface) {
    const chips = el('div', 'row__chips');
    if (kind) chips.append(chip(kind, 'chip--kind'));
    if (surface) chips.append(chip(surface, 'chip--surface'));
    head.append(chips);
  }
  return head;
}

function measuredRow(entry) {
  const row = entry.row;
  const node = el('article', 'row row--measured');

  const rank = el('p', 'row__rank', `#${entry.rank}`);
  const head = rowHead(row);
  head.prepend(rank);

  const improvement = el('p', 'row__improvement', formatImprovement(row.improvement_pct));

  const result = el('p', 'row__result');
  result.append(labelled(COPY.labels.before, formatValue(row.before_value, row.unit), 'kv kv--before'));
  result.append(el('span', 'row__arrow', '→'));
  result.append(labelled(COPY.labels.after, formatValue(row.after_value, row.unit), 'kv kv--after'));
  result.append(labelled(COPY.labels.metric, String(row.metric), 'kv kv--metric'));

  node.append(head, improvement, result);
  const strip = provenanceStrip(row);
  if (strip) node.append(strip);
  return node;
}

function unmeasuredRow(row) {
  const node = el('article', 'row row--unmeasured');
  // The rank slot holds the status chip and nothing else. There is no value
  // region in this row at all, not an empty one, so its absence cannot read as
  // a rendering fault.
  node.append(chip(COPY.measuringChip, 'chip--measuring'));
  node.append(rowHead(row));
  const strip = provenanceStrip(row);
  if (strip) node.append(strip);
  return node;
}

function panel(heading, body, modifier) {
  const node = el('div', `panel panel--${modifier}`);
  node.append(el('h2', 'panel__heading', heading));
  node.append(el('p', 'panel__body', body));
  return node;
}

function zeroPanel() {
  return panel(COPY.zeroHeading, COPY.zeroBody, 'zero');
}

function failurePanel(onRetry) {
  const node = panel(COPY.failHeading, COPY.failBody, 'error');
  const button = el('button', 'panel__retry', COPY.retryLabel);
  button.type = 'button';
  button.addEventListener('click', () => onRetry());
  node.append(button);
  node.append(el('p', 'panel__hint', COPY.retryHint));
  return node;
}

function skeletonRows() {
  const nodes = [];
  for (let i = 0; i < 3; i += 1) {
    const row = el('div', 'skeleton');
    row.setAttribute('aria-hidden', 'true');
    row.append(el('span', 'skeleton__bar skeleton__bar--head'));
    row.append(el('span', 'skeleton__bar skeleton__bar--line'));
    nodes.push(row);
  }
  return nodes;
}

const statusEl = () => document.getElementById('status');
const boardEl = () => document.getElementById('board');

export function renderLoading() {
  const board = boardEl();
  if (!board) return;
  board.replaceChildren(...skeletonRows());
  board.setAttribute('aria-busy', 'true');
  setStatus(COPY.loadingStatus, 'loading');
}

function setStatus(text, state) {
  const status = statusEl();
  if (!status) return;
  status.textContent = text;
  status.dataset.state = state;
}

export function renderRows(rows) {
  const board = boardEl();
  if (!board) return;

  const { measured, unmeasured } = rankRows(rows);
  const total = rows.length;

  board.setAttribute('aria-busy', 'false');

  // Zero rows is its own status line, not a count of nothing measured. The
  // board is not empty and unmeasured; nothing at all is being tracked.
  if (total === 0) {
    setStatus(COPY.zeroStatus, 'ready');
    board.replaceChildren(zeroPanel());
    return;
  }

  setStatus(statusLine(measured.length, total), 'ready');

  const nodes = [];
  if (measured.length > 0) {
    nodes.push(divider(COPY.rankedDivider, COPY.rankedDividerCount(measured.length), 'ranked'));
    for (const entry of measured) nodes.push(measuredRow(entry));
  }
  if (unmeasured.length > 0) {
    nodes.push(divider(COPY.measuringDivider, COPY.measuringDividerCount(total), 'measuring'));
    for (const row of unmeasured) nodes.push(unmeasuredRow(row));
  }
  // replaceChildren, not append: a second render replaces the first, so a
  // failure panel can never stack on top of another failure panel.
  board.replaceChildren(...nodes);
}

export function renderFailure(onRetry = load) {
  const board = boardEl();
  setStatus(COPY.failedStatus, 'failed');
  if (!board) return;
  board.setAttribute('aria-busy', 'false');
  board.replaceChildren(failurePanel(onRetry));
}

let inFlight = null;

async function load() {
  const config = readConfig();
  if (!config) {
    renderFailure(load);
    return;
  }
  renderLoading();
  const controller = new AbortController();
  inFlight = controller;
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const rows = await readBoard(config, controller.signal);
    renderRows(rows);
  } catch {
    // No error detail reaches the DOM. The thrown message, the HTTP status and
    // any Postgres code stay in this scope; the panel says the read did not
    // come back and nothing else.
    renderFailure(load);
  } finally {
    clearTimeout(timer);
    if (inFlight === controller) inFlight = null;
  }
}

/** Cancel a read in flight. Used by a harness, not by the page. */
export function cancelRead() {
  if (inFlight) inFlight.abort();
}

/**
 * The read starts after the static shell has been painted, so the words are on
 * screen before any request to Supabase is issued (spec section 14). Two
 * animation frames guarantee one paint has happened. A document that is not
 * being painted has nothing to wait for, so it starts immediately.
 */
function afterFirstPaint(fn) {
  if (typeof requestAnimationFrame !== 'function' || document.visibilityState === 'hidden') {
    fn();
    return;
  }
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => afterFirstPaint(load), { once: true });
  } else {
    afterFirstPaint(load);
  }
}