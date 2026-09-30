// Shipwright page bootstrap.
//
// Placeholder for the skeleton issue: this proves that config.js reached the
// browser and that the build wired the two Supabase values together. It
// deliberately makes no network call yet. The leaderboard query lands in the
// front-end issue.
//
// Every state below is a real, readable state. A leaderboard that throws or
// renders nothing when the database is unreachable is a broken public page,
// so the states are explicit rather than accidental.

const statusEl = document.getElementById('status');

const STATES = {
  ok: 'Build configuration present. Leaderboard not implemented yet.',
  missing: 'Build configuration is missing. The page was published without it.',
  noSupabase: 'Supabase client library not loaded yet. Leaderboard deferred.',
};

function setStatus(kind, message) {
  if (!statusEl) return;
  statusEl.dataset.state = kind;
  statusEl.textContent = message;
}

function readConfig() {
  const config = globalThis.SHIPWRIGHT_CONFIG;
  if (!config) return null;
  const { supabaseUrl, supabaseAnonKey } = config;
  if (!supabaseUrl || !supabaseAnonKey) return null;
  return { supabaseUrl, supabaseAnonKey };
}

export function describeState(config) {
  if (!config) return STATES.missing;
  if (!globalThis.supabase) return STATES.noSupabase;
  return STATES.ok;
}

function main() {
  const config = readConfig();
  setStatus(config ? 'ok' : 'missing', describeState(config));
  if (config) {
    // Expose for the leaderboard module. Not a secret: the anon key is public
    // by design and is bounded by RLS.
    globalThis.SHIPWRIGHT_SUPABASE_URL = config.supabaseUrl;
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main, { once: true });
} else {
  main();
}
