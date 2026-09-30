// Shipwright page bootstrap: the thin DOM layer.
//
// This file owns exactly three things and delegates everything else:
//
//   1. the one read (PostgREST over the anon key),
//   2. turning a node tree into real elements,
//   3. deciding which of the six states to show.
//
// The state itself is built by `src/board.js`, which never touches the DOM.
// That split is deliberate and it is the reason AC-22 and AC-25 are checkable
// at all: a verifier with no browser can call `renderBoard(rows)` from
// `src/board.js` in plain Node and assert on rendered output. See that file's
// header, and spec section 18's amendment note of 30 September 2026.
//
// Consequence for this file: it must not build rows, sort rows, decide
// measuredness, or format a number. If any of that grows here, the seam is
// gone and those two criteria come back NOT MEASURED.
//
// Every value reaches the page through `textContent` or `setAttribute`, never
// through `innerHTML`. Row names and descriptions come from the database, so a
// stored string must never be able to become markup.
//
// The service-role key is never read here and never appears in this file. It
// bypasses RLS and the browser has no write path at all, so it has no reason to
// hold one. The only credential the page sends is the anon key, which is
// designed to be readable by a browser and is bounded by RLS.

import { buildBoard, buildFailure, buildLoading, isPresent, parsePayload, buildRequestUrl } from './board.js';

// The one request. PostgREST, no SDK, no server, no serverless function.
const REQUEST_TIMEOUT_MS = 20000;

function readConfig() {
  const config = globalThis.SHIPWRIGHT_CONFIG;
  if (!config) return null;
  const url = typeof config.supabaseUrl === 'string' ? config.supabaseUrl.trim() : '';
  const key = typeof config.supabaseAnonKey === 'string' ? config.supabaseAnonKey.trim() : '';
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ''), key };
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
// The DOM layer. This is the only part of the page that needs `document`.
// ---------------------------------------------------------------------------

const statusEl = () => document.getElementById('status');
const boardEl = () => document.getElementById('board');

/**
 * Walk one node from src/board.js and build the matching element.
 *
 * An element carries `tag`; a text node does not and carries `text` alone. So
 * a stored value can only ever arrive as a text node, and text nodes are built
 * with `createTextNode`. There is no branch here that parses a string as
 * markup, and no branch here that writes `innerHTML`.
 */
function buildNode(node) {
  if (node === null || node === undefined) return null;
  if (!node.tag) return document.createTextNode(String(node.text ?? ''));

  const el = document.createElement(node.tag);
  if (node.cls) el.className = node.cls;
  if (node.attrs) {
    for (const [name, value] of Object.entries(node.attrs)) {
      if (value === null || value === undefined) continue;
      el.setAttribute(name, String(value));
    }
  }
  if (node.children) {
    for (const child of node.children) {
      const built = buildNode(child);
      if (built) el.append(built);
    }
  } else if (node.text !== undefined) {
    el.textContent = String(node.text);
  }
  return el;
}

function setStatus(text, state) {
  const status = statusEl();
  if (!status) return;
  status.textContent = text;
  status.dataset.state = state;
}

/**
 * Show one state. `view` is a node tree from src/board.js; `onRetry` is bound
 * to the retry marker if the state carries one.
 */
function mount(view, onRetry) {
  const board = boardEl();
  setStatus(view.status, view.statusState);
  if (!board) return;

  board.setAttribute('aria-busy', view.busy);

  const nodes = [];
  for (const node of view.nodes) {
    const built = buildNode(node);
    if (!built) continue;
    // `on` is a marker in the tree. The only binding the page has is retry.
    if (node.on === 'retry' && onRetry) built.addEventListener('click', onRetry);
    nodes.push(built);
  }

  // replaceChildren, not append: a second render replaces the first, so a
  // failure panel can never stack on top of another failure panel.
  board.replaceChildren(...nodes);
}

export function renderLoading() {
  mount(buildLoading());
}

export function renderRows(rows) {
  mount(buildBoard(rows));
}

export function renderFailure(onRetry) {
  mount(buildFailure(), onRetry);
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

export { isPresent, buildRequestUrl };