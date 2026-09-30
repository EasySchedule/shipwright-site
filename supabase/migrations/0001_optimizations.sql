-- 0001_optimizations.sql
--
-- Shipwright leaderboard table.
--
-- Authored by Rin from the live production schema, not from memory:
--   project_ref  nchzjfznvnfsqnrsrzgt
--   verified      2026-09-30
--   columns       17, read back from pg_attribute in attnum order
--   constraints   read back from pg_constraint
--   policy        read back from pg_policies
--   acl           read back from pg_class.relacl
--
-- The goal of this schema is that the site can never show a number it cannot
-- prove. A row may exist with no measurements at all; a row may not carry a
-- percentage unless it also carries the evidence for that percentage. The
-- database enforces that, not a code review.
--
-- Rollback note
-- -------------
-- This migration is additive and destroys no existing data, but a rollback
-- path is recorded here as required.
--
--   Full revert (drops the table and all three rows):
--     drop table if exists public.optimizations;
--
--   Revert only the kind column, returning the table to the 16-column shape:
--     alter table public.optimizations
--       drop constraint if exists optimizations_kind_allowed,
--       drop column if exists kind;
--
--   Revert only the policy, leaving reads unrestricted-by-policy:
--     drop policy if exists anon_select_published_optimizations
--       on public.optimizations;
--
--   Revert only the grant tightening, restoring the pre-tightening state where
--     anon and authenticated held full table privileges (arwdDxtm). RLS still
--     blocked their writes, but TRUNCATE was table-privilege governed and not
--     covered by RLS:
--     grant all on table public.optimizations to anon, authenticated;
--
-- On an existing database you almost certainly want the partial reverts above,
-- not the drop: the seeded rows are the launch state of the public page.

begin;

create table if not exists public.optimizations (
  -- Identity. Set by the database, never by the client.
  id               uuid        primary key default gen_random_uuid(),

  -- What this optimisation is. Required.
  title            text        not null,
  surface          text        not null,

  -- What kind of row this is. Nullable on purpose, see the long note below the
  -- table. The allowed set is exactly 'Surface' and 'Change'.
  kind             text,

  -- Prose. Nullable on purpose: a row may be tracked before it is measured.
  --
  -- This is the ONE prose column, and it carries the one-sentence product copy
  -- that renders under the title, e.g. "How fast the terminal interface
  -- responds to you."
  --
  -- There was a second `description` column here from 12:5xZ until 13:1xZ on
  -- 2026-09-30. It duplicated this column, and the front end would have had no
  -- way to know which one was authoritative, so it was folded into `summary`
  -- and dropped. See 0002. Do not re-add it.
  --
  -- Deliberately NOT part of the evidence constraint below: it describes a
  -- surface, it does not assert a metric or a value, so it needs no provenance
  -- to be honest.
  summary          text,

  -- Provenance. All nine columns are nullable, and all nine become
  -- mandatory the moment improvement_pct is set. This group is the evidence
  -- for the number.
  commit_sha       text,
  commit_url       text,
  metric           text,
  unit             text,
  before_value     numeric,
  after_value      numeric,
  improvement_pct  numeric,
  harness          text,
  measured_at      timestamptz,
  measured_by      text,

  -- Visibility. Defaults to false so a row cannot be published by accident.
  published        boolean     not null default false,

  -- Insertion time, not measurement time. Use measured_at for the latter.
  created_at       timestamptz not null default now(),

  -- One of exactly three tracked surfaces. The three are the three surfaces
  -- the founder asked us to make faster; this is the whole list.
  constraint optimizations_surface_allowed
    check (surface in ('tui_interaction', 'repo_indexing', 'native_text_search')),

  -- Exactly two kinds, fixed by the product spec.
  --
  -- 'Surface' is a thing we are tracking but have not yet proved a number for.
  -- 'Change' is a proved optimisation. The leaderboard renders a kind chip only
  -- for 'Surface', because a Change needs no chip telling the reader it is a
  -- change.
  --
  -- NULL is allowed and is a real state, not a gap in the constraint. The spec
  -- has an explicit edge case, "row has no kind -> no kind chip and no
  -- placeholder chip", and a NOT NULL column would make that state
  -- unreachable. SQL CHECK is satisfied by UNKNOWN, so a NULL kind passes this
  -- constraint while any value outside the two-value set is rejected.
  constraint optimizations_kind_allowed
    check (kind in ('Surface', 'Change')),

  -- The constraint that makes the leaderboard honest.
  --
  -- If improvement_pct is set, then every provenance column must be set too.
  -- Partial provenance is not provenance: an improvement_pct with a commit but
  -- no harness, or no date, is rejected. This is deliberately enforced by the
  -- database rather than by review, because the failure it prevents is a
  -- published number that nobody can reproduce.
  constraint optimizations_improvement_requires_evidence
    check (
      improvement_pct is null
      or (
        commit_sha is not null
        and commit_url  is not null
        and metric      is not null
        and unit        is not null
        and before_value  is not null
        and after_value   is not null
        and harness     is not null
        and measured_at is not null
        and measured_by is not null
      )
    )
);

-- Row-level security.
--
-- Enabled, with exactly one policy: anon may read published rows and nothing
-- else. There is deliberately NO insert, update or delete policy for anon or
-- authenticated. With RLS on and no write policy, every write from those
-- roles is denied.
alter table public.optimizations enable row level security;

drop policy if exists anon_select_published_optimizations on public.optimizations;
create policy anon_select_published_optimizations
  on public.optimizations
  for select
  to anon
  using (published = true);

-- Grants.
--
-- Defence in depth, second layer. The policy above already denies anon and
-- authenticated every write, but a fresh table in this database inherits
-- table-level privileges for those roles, and those include TRUNCATE, which
-- PostgreSQL's RLS does not govern. Revoke first, then grant read back, so the
-- database does not depend on the HTTP layer never exposing a TRUNCATE verb.
--
-- service_role is the only role permitted to write to this table, because it
-- bypasses RLS. It must never reach a browser and must never appear in a
-- client bundle; the front end has no write path at all, which is why it does
-- not need the service-role key.
--
-- This grant is explicit rather than inherited. In this project service_role
-- already holds full table privileges on public tables via the database's
-- default privileges, and a table created in a non-public schema does NOT pick
-- that up. Stating it here means a fresh database reproduces the live ACL
-- exactly instead of depending on a default that only exists in public.
revoke all on table public.optimizations from anon, authenticated;
grant select on table public.optimizations to anon, authenticated;
grant all on table public.optimizations to service_role;

-- Seed: exactly three rows, one per tracked surface, all measurement columns
-- NULL, published.
--
-- An empty measurement set is the intended launch state. The page is designed
-- to show a tracked-but-unmeasured optimisation honestly. Do not add example or
-- placeholder numbers to make the page look fuller: fake rows would make this
-- site worthless, and the CHECK constraint above is the second line of defence
-- against exactly that.
--
-- The NOT EXISTS guard keeps this re-runnable. Without it, applying this
-- migration to a database that already holds the seed would produce six rows.
--
-- `summary` holds the one-sentence description of the surface. It is copied
-- verbatim from the product spec. It describes the surface and asserts no
-- metric, which is why the launch state can be honest while every measurement
-- column is NULL.
insert into public.optimizations (surface, title, kind, summary, published)
select v.surface, v.title, v.kind, v.summary, true
from (values
  ('tui_interaction',
   'TUI interaction',
   'Surface',
   'How fast the terminal interface responds to you.'),
  ('repo_indexing',
   'Repo indexing and file watching',
   'Surface',
   'How fast the tool reads a repository and notices an edited file.'),
  ('native_text_search',
   'Native text search',
   'Surface',
   'How fast the tool returns search results across a repository.')
) as v(surface, title, kind, summary)
where not exists (
  select 1 from public.optimizations e where e.surface = v.surface
);

commit;
