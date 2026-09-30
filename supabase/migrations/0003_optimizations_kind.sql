-- 0003_optimizations_kind.sql
--
-- Adds the `kind` column and its CHECK constraint, and classifies the three
-- seeded rows as 'Surface'.
-- Authored by Rin from the live production schema.
--   project_ref  nchzjfznvnfsqnrsrzgt
--   applied      2026-09-30 as migration add_optimizations_kind
--   verified     3 rows, all kind = 'Surface', improvement_pct NULL on all 3
--
-- 0001 now carries `kind` in its create table, so applying the full chain to a
-- fresh database is a no-op here: the column is added with `if not exists`, the
-- constraint is dropped and re-added rather than added twice, and the update is
-- guarded by `kind is null`. This file exists so that a database created from
-- the pre-kind 0001 can be brought forward without a manual step.
--
-- Why NULLABLE and not NOT NULL
-- ----------------------------
-- This is a product requirement, not a shortcut.
--
-- The leaderboard spec lists an explicit edge case: a row with no kind renders
-- no kind chip and no placeholder chip. A NOT NULL column would make that state
-- unreachable, and would impose a constraint onto three rows that already exist.
--
-- Nullable also states the design correctly. The three seeded rows are tracked
-- SURFACES. Every proved optimisation added later is a new 'Change' row, and a
-- Change row renders no kind chip at all, so 'Change' is in practice the
-- absence of a chip. NULL is a legitimate third state: not yet classified.
--
-- 'Surface' and 'Change' are the complete set and the comparison is
-- case-sensitive. 'surface' in lower case is rejected by the constraint.
--
-- Safety
--   - Additive and idempotent. `kind` is nullable with no default, so any
--     INSERT that omits it still succeeds.
--   - Adds no row and deletes no row. The table stays at exactly three.
--   - Touches only rows where kind is null AND surface is one of the three
--     tracked surfaces, so a future 'Change' row is never rewritten by this
--     statement.
--   - Writes no measurement value. `kind` classifies a row, it does not assert
--     a metric, so it is deliberately not covered by
--     optimizations_improvement_requires_evidence.
--   - Reads and writes nothing that reaches the browser; no key or credential
--     appears in this file.
--
-- Rollback note
-- -------------
--   Full revert:
--     alter table public.optimizations
--       drop constraint if exists optimizations_kind_allowed,
--       drop column if exists kind;
--
--   Revert only the classification, keeping the column and the constraint:
--     update public.optimizations set kind = null
--      where surface in ('tui_interaction','repo_indexing','native_text_search');

begin;

alter table public.optimizations
  add column if not exists kind text;

-- Dropped first so this file can be replayed. The constraint is then added
-- back with its intended definition.
alter table public.optimizations
  drop constraint if exists optimizations_kind_allowed;
alter table public.optimizations
  add constraint optimizations_kind_allowed
  check (kind in ('Surface', 'Change'));

-- The three seeded rows are the three tracked surfaces, so they are 'Surface'.
update public.optimizations
   set kind = 'Surface'
 where kind is null
   and surface in ('tui_interaction', 'repo_indexing', 'native_text_search');

commit;
