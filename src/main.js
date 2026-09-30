// Shipwright leaderboard client.
//
// No framework, no bundler, no runtime dependencies. One GET against the
// Supabase REST endpoint, then a render.
//
// Three rules shape everything below, and they are the reason this file is
// written the way it is.
//
// 1. Every value that came from the database is written with `textContent`.
//    There is no markup-string sink anywhere in this file. Hand-written DOM is
//    an injection surface unless it is closed deliberately, and row data is
//    attacker-reachable the moment a write path exists upstream.
//
// 2. A row renders a number only when it carries all nine evidence values.
//    `measured` is derived here, never declared. The database has a CHECK
//    constraint that rejects the bad write; this rejects the bad render. The
//    improvement percentage is read from storage and never computed from the
//    before and after values.
//
// 3. A failure shows the product, not the error. Nothing thrown by the read is
//    ever placed in the document: no upstream message, no status code, no
//    error code, no stack fragment. The page has one honest failure panel.

const TABLE = 'optimizations';

// The select list. Two deliberate omissions.
//
// `published` is absent because row level security already filters on it. A
// second filter in the client is one more place to be wrong tomorrow.
//
// `kind` is absent because the column does not exist yet on the live table. A
// PostgREST select naming a column the database does not have fails the whole
// read with PGRST204, which would put the launch state into the failure panel
// over a chip nobody asked for. The renderer already handles `kind`, so adding
// the column to this string is the entire change when the migration lands.
const SELECT_COLUMNS = [
  'id',
  'title',
  'surface',
  'description',
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

const SHORT_SHA_LENGTH = 7;
const COMMIT_ORIGIN = 'https://github.com/EasySchedule/oh-my-pi';
const SKELETON_ROWS = 3;

const COPY = {
  loading: 'Loading the board.',
  failed: 'The board could not be loaded.',
  failedBody:
    'This page reads the board from our database every time you open it, and that read did not come back. Nothing is ranked, because we will not show a number we cannot prove.',
  failedNote: 'If this keeps happening, the board is offline, not empty.',
  retry: 'Try again',
  zeroHeading: 'Nothing is being tracked yet.',
  zeroBody:
    'This board lists what we are measuring and what each measurement proved. Right now there is nothing on it.',
  statusZero: 'No surfaces are being tracked yet.',
  bandRanked: 'Ranked by measured improvement',
  bandMeasuring: 'Still measuring',
  chipMeasuring: 'measuring',
  chipSurface: 'Surface',
  labelBefore: 'Before',
  labelAfter: 'After',
  labelMetric: 'Metric',
  labelCommit: 'commit',
  labelCommand: 'command',
  labelMeasured: 'measured',
  labelBy: 'by',
  noChange: 'no change',
};

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

function hasText(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

/**
 * A stored value is usable when it is present and, for numbers, finite. NaN and
 * Infinity are treated as absent, because a row carrying one cannot prove
 * anything and must read as `measuring`.
 */
function usable(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return Number.isFinite(value);
  return hasText(value);
}

/**
 * Coerce a stored numeric to a finite JS number, or null when it is not one.
 * A value that cannot be read as a number is never rendered as one.
 */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Render a stored value exactly as stored. No re-rounding, no separators. */
function stored(value) {
  return typeof value === 'string' ? value : String(value);
}

/** A date reduced to its calendar day. The stored instant is left intact. */
function dayOf(instant) {
  const text = String(instant);
  return text.length >= 10 ? text.slice(0, 10) : text;
}

/**
 * The improvement percentage as the founder reads it: an integer percentage
 * rounded to nearest with `.5` rounding up, with the direction word. Zero is a
 * proven result and says so.
 */
export function formatImprovement(value) {
  if (value === 0) return COPY.noChange;
  const magnitude = Math.round(Math.abs(value));
  return magnitude + '% ' + (value < 0 ? 'slower' : 'faster');
}

function results(count) {
  return count === 1 ? '1 result' : count + ' results';
}

function tracked(count) {
  return count + ' tracked';
}

/**
 * The status line, selected by state. Both counts come from the read result;
 * neither is hardcoded.
 */
export function statusLine(measuredCount, total) {
  if (total === 0) return COPY.statusZero;
  if (measuredCount === 0) return 'No result published yet. ' + tracked(total) + '.';
  return results(measuredCount) + ' published. ' + tracked(total) + '.';
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

// The eight evidence values other than the improvement percentage itself.
// All nine together are what makes a row measured.
const EVIDENCE = [
  'before_value',
  'after_value',
  'unit',
  'metric',
  'commit_sha',
  'harness',
  'measured_at',
  'measured_by',
];

function firstText(a, b) {
  if (hasText(a)) return String(a).trim();
  if (hasText(b)) return String(b).trim();
  return '';
}

/**
 * Build a display row. `measured` is derived: it is true only when an
 * improvement percentage and all eight evidence values are usable. An
 * improvement that exists without its evidence is deliberately not surfaced,
 * because the point of the page is that a number is never shown unproven.
 */
export function buildRow(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const improvement = toNumber(source.improvement_pct);
  const complete = improvement !== null && EVIDENCE.every((key) => usable(source[key]));
  return {
    id: source.id === null || source.id === undefined ? '' : String(source.id),
    name: hasText(source.title) ? String(source.title) : '',
    surface: hasText(source.surface) ? String(source.surface) : '',
    kind: hasText(source.kind) ? String(source.kind) : '',
    description: firstText(source.description, source.summary),
    before: source.before_value,
    after: source.after_value,
    unit: hasText(source.unit) ? String(source.unit) : '',
    metric: hasText(source.metric) ? String(source.metric) : '',
    improvement: complete ? improvement : null,
    measured: complete,
    commit: hasText(source.commit_sha) ? String(source.commit_sha).trim() : '',
    command: hasText(source.harness) ? String(source.harness) : '',
    measuredAt: hasText(source.measured_at) ? String(source.measured_at) : '',
    measuredBy: hasText(source.measured_by) ? String(source.measured_by) : '',
  };
}

function compareText(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Ascending by instant, falling back to lexicographic on the stored text. */
function compareInstant(a, b) {
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) {
    return left < right ? -1 : 1;
  }
  return compareText(a, b);
}

/**
 * The board's order. Measured rows first, largest stored improvement first,
 * tie-broken by the instant proven, then the commit, then the row id. Then
 * unmeasured rows, by row id.
 *
 * The comparator is total: it ends in the row id, which is unique, so the
 * order never depends on the order the database happened to return rows in.
 * That is what lets a shuffled read render the same board.
 */
export function orderRows(rows) {
  return rows.slice().sort((a, b) => {
    if (a.measured !== b.measured) return a.measured ? -1 : 1;
    if (a.measured) {
      if (a.improvement !== b.improvement) return b.improvement - a.improvement;
      const byInstant = compareInstant(a.measuredAt, b.measuredAt);
      if (byInstant !== 0) return byInstant;
      const byCommit = compareText(a.commit, b.commit);
      if (byCommit !== 0) return byCommit;
    }
    return compareText(a.id, b.id);
  });
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

/**
 * The only way this file writes text. Every string that reaches the document
 * goes through here, so no upstream value can ever be parsed as markup.
 */
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== null && text !== undefined) element.textContent = text;
  return element;
}

function boardArea() {
  return document.getElementById('board');
}

function statusArea() {
  return document.getElementById('status');
}

/**
 * A provenance segment. Returns null when the value is absent, so an absent
 * value drops out of the strip entirely rather than being replaced by a
 * placeholder that would read as a rendering fault.
 */
function segment(label, value, build) {
  if (!hasText(value)) return null;
  const wrapper = node('span', 'seg');
  wrapper.appendChild(node('span', 'seg-label', label));
  wrapper.appendChild(build(value));
  return wrapper;
}

function commitValue(sha) {
  const anchor = document.createElement('a');
  anchor.className = 'sha';
  anchor.setAttribute('href', COMMIT_ORIGIN + '/commit/' + sha.trim());
  anchor.setAttribute('target', '_blank');
  anchor.setAttribute('rel', 'noopener noreferrer');
  anchor.textContent = sha.trim().slice(0, SHORT_SHA_LENGTH);
  return anchor;
}

function textValue(text, className) {
  const span = document.createElement('span');
  if (className) span.className = className;
  span.textContent = text;
  return span;
}

/**
 * The provenance strip. Only the segments whose values are present render, in
 * the order commit, command, measured, by.
 */
function provenance(row) {
  const parts = [
    segment(COPY.labelCommit, row.commit, commitValue),
    segment(COPY.labelCommand, row.command, (value) => textValue(value, 'command')),
    segment(COPY.labelMeasured, row.measuredAt, (value) => textValue(dayOf(value), '')),
    segment(COPY.labelBy, row.measuredBy, (value) => textValue(value, '')),
  ].filter(Boolean);
  if (parts.length === 0) return null;

  const strip = node('span', 'prov');
  parts.forEach((part, index) => {
    if (index > 0) {
      const separator = document.createElement('span');
      separator.className = 'seg-sep';
      separator.setAttribute('aria-hidden', 'true');
      separator.textContent = '·';
      strip.appendChild(separator);
    }
    strip.appendChild(part);
  });
  return strip;
}

function chips(row) {
  const group = node('span', 'chips');
  let any = false;
  // A change needs no chip saying "change", so only a surface is chipped.
  if (row.kind === COPY.chipSurface) {
    group.appendChild(node('span', 'chip chip-kind', COPY.chipSurface));
    any = true;
  }
  if (row.surface !== '' && row.surface !== row.name) {
    group.appendChild(node('span', 'chip chip-surface', row.surface));
    any = true;
  }
  return any ? group : null;
}

function identity(row, slot) {
  const group = node('div', 'identity');
  if (slot) group.appendChild(slot);
  const name = node('span', 'name', row.name);
  if (row.name !== '') name.title = row.name;
  group.appendChild(name);
  const chipsNode = chips(row);
  if (chipsNode) group.appendChild(chipsNode);
  if (row.description !== '') {
    const description = node('span', 'desc', row.description);
    description.title = row.description;
    group.appendChild(description);
  }
  return group;
}

function measuredRow(row, rank) {
  const card = node('article', 'row row-measured');

  const identityNode = identity(row, node('span', 'rank', '#' + rank));
  card.appendChild(identityNode);

  card.appendChild(node('span', 'improvement', formatImprovement(row.improvement)));

  card.appendChild(valueNode(COPY.labelBefore, row.before, row.unit, 'before'));
  card.appendChild(valueNode(COPY.labelAfter, row.after, row.unit, 'after'));

  const metric = node('span', 'metric');
  metric.appendChild(node('span', 'metric-label', COPY.labelMetric));
  metric.appendChild(textValue(row.metric, ''));
  card.appendChild(metric);

  const strip = provenance(row);
  if (strip) card.appendChild(strip);

  if (row.command !== '') {
    const command = node('code', 'command-block');
    command.textContent = row.command;
    card.appendChild(command);
  }

  return card;
}

function valueNode(label, value, unit, kind) {
  const wrapper = node('span', 'val val-' + kind);
  wrapper.appendChild(node('span', 'val-label', label));
  const amount = node('span', 'val-number', stored(value) + ' ' + unit);
  wrapper.appendChild(amount);
  return wrapper;
}

function unmeasuredRow(row) {
  const card = node('article', 'row row-unmeasured');
  const chip = node('span', 'chip chip-measuring', COPY.chipMeasuring);
  card.appendChild(identity(row, chip));
  const strip = provenance(row);
  if (strip) card.appendChild(strip);
  return card;
}

function divider(label, count) {
  const band = node('div', 'band');
  band.appendChild(node('span', 'band-label', label));
  band.appendChild(node('span', 'band-count', count));
  return band;
}

function skeleton() {
  const wrapper = node('div', 'skeleton');
  wrapper.setAttribute('aria-hidden', 'true');
  wrapper.appendChild(node('span', 'sk sk-name'));
  wrapper.appendChild(node('span', 'sk sk-line'));
  return wrapper;
}

function panel(heading, body, note, action) {
  const box = node('div', 'panel');
  box.appendChild(node('h2', 'panel-heading', heading));
  box.appendChild(node('p', 'panel-body', body));
  if (action) box.appendChild(action);
  if (note) box.appendChild(node('p', 'panel-note', note));
  return box;
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

function showLoading() {
  statusArea().textContent = COPY.loading;
  const board = boardArea();
  board.setAttribute('aria-busy', 'true');
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < SKELETON_ROWS; index += 1) {
    fragment.appendChild(skeleton());
  }
  board.replaceChildren(fragment);
}

function showRows(rows) {
  const measured = [];
  const unmeasured = [];
  for (const row of rows) {
    if (row.measured) measured.push(row);
    else unmeasured.push(row);
  }

  statusArea().textContent = statusLine(measured.length, rows.length);
  const board = boardArea();
  board.setAttribute('aria-busy', 'false');

  const fragment = document.createDocumentFragment();

  if (rows.length === 0) {
    fragment.appendChild(panel(COPY.zeroHeading, COPY.zeroBody, null, null));
    board.replaceChildren(fragment);
    return;
  }

  // Ranks are assigned after sorting, contiguous from one, measured rows only.
  if (measured.length > 0) {
    fragment.appendChild(divider(COPY.bandRanked, results(measured.length)));
    measured.forEach((row, index) => {
      fragment.appendChild(measuredRow(row, index + 1));
    });
  }
  if (unmeasured.length > 0) {
    fragment.appendChild(divider(COPY.bandMeasuring, tracked(unmeasured.length)));
    for (const row of unmeasured) {
      fragment.appendChild(unmeasuredRow(row));
    }
  }

  board.replaceChildren(fragment);
}

function showFailure(onRetry) {
  statusArea().textContent = COPY.failed;
  const board = boardArea();
  board.setAttribute('aria-busy', 'false');

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'retry';
  button.textContent = COPY.retry;
  button.addEventListener('click', onRetry);

  // Exactly one panel, because the board area is replaced wholesale.
  board.replaceChildren(panel(COPY.failed, COPY.failedBody, COPY.failedNote, button));
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

function trimTrailingSlash(value) {
  let end = value.length;
  while (end > 0 && value.charAt(end - 1) === '/') end -= 1;
  return value.slice(0, end);
}

function readConfig() {
  const config = globalThis.SHIPWRIGHT_CONFIG;
  if (!config) return null;
  const url = config.supabaseUrl;
  const key = config.supabaseAnonKey;
  if (!hasText(url) || !hasText(key)) return null;
  return { url: trimTrailingSlash(url).trim(), key: String(key).trim() };
}

export function boardUrl(config) {
  return config.url + '/rest/v1/' + TABLE + '?select=' + SELECT_COLUMNS;
}

/**
 * The single request this page makes. No ordering is asked of the database, so
 * the rank cannot be whatever the storage layer felt like returning, and the
 * read is not cached: a missing number means the measurement has not landed.
 */
export async function readBoard(config, fetchImpl) {
  const response = await fetchImpl(boardUrl(config), {
    method: 'GET',
    headers: {
      apikey: config.key,
      Authorization: 'Bearer ' + config.key,
      Accept: 'application/json',
    },
    cache: 'no-store',
  });
  if (!response || !response.ok) throw new Error('read rejected');
  const payload = await response.json();
  if (!Array.isArray(payload)) throw new Error('payload unreadable');
  return payload;
}

/**
 * Build the reader. The returned function renders the board, and re-renders it
 * from scratch on every attempt, which is what keeps a repeated failure from
 * leaving two panels on screen.
 */
export function makeStart(config, fetchImpl) {
  const start = async () => {
    showLoading();
    try {
      const payload = await readBoard(config, fetchImpl);
      showRows(orderRows(payload.map(buildRow)));
    } catch {
      // Deliberately discarded. The upstream reason never reaches the document.
      showFailure(start);
    }
  };
  return start;
}

function boot() {
  try {
    const config = readConfig();
    if (!config) throw new Error('config missing');
    if (typeof globalThis.fetch !== 'function') throw new Error('no fetch');
    const fetchImpl = globalThis.fetch.bind(globalThis);
    afterFirstPaint(() => {
      void makeStart(config, fetchImpl)();
    });
  } catch {
    showFailure(retry);
  }
}

/**
 * Run after the static shell has been painted.
 *
 * The first animation frame callback runs before the browser commits a frame, so
 * starting the read from inside it can still put the request ahead of the paint.
 * Waiting for the second frame means the first has been committed, and the
 * timeout lets the frame finish before the network queue is touched. The result
 * is that a person reads the words before any request goes out, which is the
 * whole point of shipping the shell as static HTML.
 */
function afterFirstPaint(callback) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      setTimeout(callback, 0);
    });
  });
}

function retry() {
  const config = readConfig();
  if (!config || typeof globalThis.fetch !== 'function') return;
  void makeStart(config, globalThis.fetch.bind(globalThis))();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
}
