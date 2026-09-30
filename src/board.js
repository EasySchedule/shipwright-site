// Shipwright board render layer.
//
// This module is the page's row-render path. It has no reference to the DOM
// anywhere: no `document`, no `window`, no element creation, no network. Its
// entire job is to turn a read result into a tree of plain objects, and to
// serialize that tree to markup.
//
// That constraint is the point, not an accident of style. Two criteria in spec
// section 18 -- AC-22 and AC-25 -- are claims about *rendered output*, and the
// verifier has no browser and never will. A render step reachable only through
// element creation can be exercised only by a person looking at a screen, which
// would put both criteria permanently out of reach. Here they are:
//
//   import { renderBoard } from './src/board.js';
//   renderBoard(fixtureRows).markup;
//
// Plain Node. No DOM, no database, no network, no test framework.
//
// Why a tree rather than a markup string. The page must never turn a stored
// string into markup: row names and descriptions come from the database. So
// this module does not hand back HTML for the DOM layer to assign; it hands
// back structure, and app.js walks that structure building real elements with
// `textContent`. `serialize` exists for the same tree, so the string a fixture
// asserts on and the nodes a browser paints are two renderings of one value
// and cannot drift apart. AC-22 and AC-25 are therefore assertions about what
// the page renders, not about a parallel code path that only tests execute.

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

// Spec section 6: the commit links to this repository.
const COMMIT_BASE = 'https://github.com/EasySchedule/oh-my-pi/commit/';

// The provenance a measured row must carry. The improvement is checked
// separately. This mirrors the database's
// optimizations_improvement_requires_evidence constraint, which the page
// re-checks at render time because a rule enforced only in the database is one
// UPDATE away from being bypassed.
const REQUIRED_PROVENANCE = [
  'commit_sha',
  'harness',
  'measured_at',
  'measured_by',
  'metric',
  'unit',
];

// Spec section 5 is the whole vocabulary of this product. Nothing here renders
// user-visible text, and nothing else in either file may.
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
// Pure core. Nothing below reads or writes the DOM.
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
 * evidence or it renders as `measuring`. Spec section 9 rule 5, and the rule
 * AC-25 and AC-26 exist to check.
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
 * The provenance segments a row may render, in the order AC-10 gives: commit,
 * command, measured, by. A segment whose value is absent is omitted entirely,
 * never replaced by a placeholder glyph.
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

export function buildRequestUrl(baseUrl) {
  const query = [
    `select=${SELECT_COLUMNS}`,
    'published=eq.true',
    'order=created_at.asc,id.asc',
  ].join('&');
  return `${baseUrl}/rest/v1/optimizations?${query}`;
}

// ---------------------------------------------------------------------------
// The tree.
//
// A node is one of two things. An element carries `tag`; a text node does not,
// and carries `text` alone. That single rule is what keeps stored values from
// ever being read as markup: the only way text reaches a text node is through
// `text`, and the DOM layer writes `text` with `textContent`.
// ---------------------------------------------------------------------------

/** An element with a class and optional text. */
function el(tag, cls, text) {
  const node = { tag };
  if (cls) node.cls = cls;
  if (text !== undefined && text !== null) node.text = String(text);
  return node;
}

/** A text node. Used for the single space between a label and its value. */
function textNode(value) {
  return { text: String(value) };
}

function withChildren(node, kids) {
  node.children = kids;
  return node;
}

function chip(label, extraClass) {
  return el('span', `chip${extraClass ? ` ${extraClass}` : ''}`, label);
}

function labelled(label, value, cls) {
  return withChildren(el('span', cls || 'kv'), [
    el('span', 'kv__label', label),
    textNode(' '),
    el('span', 'kv__value', value),
  ]);
}

function divider(label, count, modifier) {
  return withChildren(el('div', `divider divider--${modifier}`), [
    el('span', 'divider__label', label),
    el('span', 'divider__count', count),
  ]);
}

function provenanceStrip(row) {
  const segments = provenanceSegments(row);
  if (segments.length === 0) return null;
  const kids = [];
  for (const segment of segments) {
    const kids2 = [el('span', 'prov__label', segment.label)];
    if (segment.kind === 'commit') {
      // Spec section 6: the commit links to this repository, which is publicly
      // readable, so the short SHA is an anchor. The SHA stays the visible text
      // and not the target, because a link that 404s for the founder is worse
      // than no link at all.
      kids2.push({
        tag: 'a',
        cls: 'prov__sha',
        attrs: {
          href: commitUrl(segment.raw),
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        text: segment.value,
      });
    } else if (segment.kind === 'command') {
      kids2.push(el('code', 'prov__command', segment.value));
    } else {
      kids2.push(el('span', `prov__${segment.kind}`, segment.value));
    }
    kids.push(withChildren(el('span', `prov__seg prov__seg--${segment.kind}`), kids2));
  }
  return withChildren(el('p', 'prov'), kids);
}

function rowHead(row) {
  const idBlock = el('div', 'row__idblock');
  const name = el('h3', 'row__name', isPresent(row.title) ? row.title : '');
  // The full text stays in the title attribute because the visible name wraps
  // to at most two lines and then ellipsises.
  if (isPresent(row.title)) name.attrs = { title: String(row.title) };
  idBlock.children = [name];
  if (isPresent(row.summary)) idBlock.children.push(el('p', 'row__desc', row.summary));

  const kids = [idBlock];
  const kind = kindChip(row);
  const surface = surfaceChip(row);
  if (kind || surface) {
    const chips = el('div', 'row__chips');
    chips.children = [];
    if (kind) chips.children.push(chip(kind, 'chip--kind'));
    if (surface) chips.children.push(chip(surface, 'chip--surface'));
    kids.push(chips);
  }
  return withChildren(el('div', 'row__head'), kids);
}

function measuredRow(entry) {
  const row = entry.row;
  const head = rowHead(row);
  // Rank leads the head, matching the card layout in spec section 6.
  head.children.unshift(el('p', 'row__rank', `#${entry.rank}`));

  const result = withChildren(el('p', 'row__result'), [
    labelled(COPY.labels.before, formatValue(row.before_value, row.unit), 'kv kv--before'),
    el('span', 'row__arrow', '→'),
    labelled(COPY.labels.after, formatValue(row.after_value, row.unit), 'kv kv--after'),
    labelled(COPY.labels.metric, String(row.metric), 'kv kv--metric'),
  ]);

  const kids = [head, el('p', 'row__improvement', formatImprovement(row.improvement_pct)), result];
  const strip = provenanceStrip(row);
  if (strip) kids.push(strip);
  return withChildren(el('article', 'row row--measured'), kids);
}

function unmeasuredRow(row) {
  // The rank slot holds the status chip and nothing else. There is no value
  // region in this row at all, not an empty one, so its absence cannot read as
  // a rendering fault. Spec section 7.1: no rank, no percentage, no before, no
  // after, no metric line, and no placeholder glyph standing in for any of them.
  const kids = [chip(COPY.measuringChip, 'chip--measuring'), rowHead(row)];
  const strip = provenanceStrip(row);
  if (strip) kids.push(strip);
  return withChildren(el('article', 'row row--unmeasured'), kids);
}

function panel(heading, body, modifier) {
  return withChildren(el('div', `panel panel--${modifier}`), [
    el('h2', 'panel__heading', heading),
    el('p', 'panel__body', body),
  ]);
}

function zeroPanel() {
  return panel(COPY.zeroHeading, COPY.zeroBody, 'zero');
}

function failurePanel() {
  // `on` is a marker, not a handler. The DOM layer binds it to the retry
  // callback; a node tree that has to stay serialisable cannot carry a
  // function.
  return withChildren(el('div', 'panel panel--error'), [
    el('h2', 'panel__heading', COPY.failHeading),
    el('p', 'panel__body', COPY.failBody),
    { tag: 'button', cls: 'panel__retry', attrs: { type: 'button' }, text: COPY.retryLabel, on: 'retry' },
    el('p', 'panel__hint', COPY.retryHint),
  ]);
}

function skeletonRows() {
  const rows = [];
  for (let i = 0; i < 3; i += 1) {
    rows.push({
      tag: 'div',
      cls: 'skeleton',
      attrs: { 'aria-hidden': 'true' },
      children: [
        el('span', 'skeleton__bar skeleton__bar--head'),
        el('span', 'skeleton__bar skeleton__bar--line'),
      ],
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Public: the six states as trees. Pure. No DOM.
// ---------------------------------------------------------------------------

/**
 * The read result as a board view. `busy` is the aria-busy value the DOM layer
 * writes onto the board element, `status` and `statusState` are the status
 * line, and `nodes` is the board's children in DOM order.
 *
 * `rows` is a read result: an array of anything. The measuredness predicate
 * decides what each row is, and a row that is not an object is unmeasured
 * rather than fatal. This never throws on the data.
 */
export function buildBoard(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const { measured, unmeasured } = rankRows(list);
  const total = list.length;

  if (total === 0) {
    // Zero rows is its own status line, not a count of nothing measured. The
    // board is not empty-and-unmeasured; nothing at all is being tracked.
    return {
      status: COPY.zeroStatus,
      statusState: 'ready',
      busy: 'false',
      nodes: [zeroPanel()],
    };
  }

  const nodes = [];
  if (measured.length > 0) {
    nodes.push(divider(COPY.rankedDivider, COPY.rankedDividerCount(measured.length), 'ranked'));
    for (const entry of measured) nodes.push(measuredRow(entry));
  }
  if (unmeasured.length > 0) {
    nodes.push(divider(COPY.measuringDivider, COPY.measuringDividerCount(total), 'measuring'));
    for (const row of unmeasured) nodes.push(unmeasuredRow(row));
  }
  return {
    status: statusLine(measured.length, total),
    statusState: 'ready',
    busy: 'false',
    nodes,
  };
}

export function buildLoading() {
  return {
    status: COPY.loadingStatus,
    statusState: 'loading',
    busy: 'true',
    nodes: skeletonRows(),
  };
}

export function buildFailure() {
  return {
    status: COPY.failedStatus,
    statusState: 'failed',
    busy: 'false',
    nodes: [failurePanel()],
  };
}

/**
 * The whole rendered board as markup, with no DOM in the call.
 *
 * This is the seam AC-22 and AC-25 are verified through. Given the same rows it
 * returns the same markup, whatever order those rows arrived in.
 */
export function renderBoard(rows) {
  const view = buildBoard(rows);
  return {
    status: view.status,
    statusState: view.statusState,
    busy: view.busy,
    markup: serialize(view.nodes),
  };
}

/**
 * Flatten a node tree to markup.
 *
 * Text and attribute values are escaped, so this is safe to print, to grep and
 * to compare. The DOM layer never calls it: it walks the tree instead, writing
 * every value with `textContent`. Both paths read the same tree, so a fixture
 * asserting on this string is asserting on what the page renders.
 */
export function serialize(nodes) {
  if (!Array.isArray(nodes)) return '';
  let out = '';
  for (const node of nodes) out += serializeNode(node);
  return out;
}

function serializeNode(node) {
  if (node === null || node === undefined) return '';
  // No `tag` means a text node, and its text is escaped.
  if (!node.tag) return escapeHtml(node.text ?? '');
  let out = `<${node.tag}`;
  if (node.cls) out += ` class="${escapeHtml(node.cls)}"`;
  if (node.attrs) {
    for (const [name, value] of Object.entries(node.attrs)) {
      if (value === null || value === undefined) continue;
      out += ` ${name}="${escapeHtml(value)}"`;
    }
  }
  out += '>';
  if (node.children) out += serialize(node.children);
  else if (node.text !== undefined) out += escapeHtml(node.text);
  return `${out}</${node.tag}>`;
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Held as a constant rather than written inline: the homegrown minifier cannot
// always tell a pattern from a division, and a module-level binding puts the
// `/` after `=` where the reading is unambiguous.
const ESCAPED_CHARS = /[&<>"']/g;

function escapeHtml(value) {
  return String(value).replace(ESCAPED_CHARS, (char) => ESCAPES[char]);
}