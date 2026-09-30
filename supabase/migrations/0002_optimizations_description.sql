-- 0002_optimizations_description.sql
--
-- Folds the redundant `description` column into `summary`, then drops it, and
-- sets the launch titles. Authored by Rin from the live production schema.
--   project_ref  nchzjfznvnfsqnrsrzgt
--   applied      2026-09-30 as migration
--                  fold_optimizations_description_into_summary
--   verified     17 columns, 3 rows, every measurement column NULL
--
-- Why this migration exists at all
-- -------------------------------
-- An earlier version of this file ADDED a `description` column and put the
-- one-sentence product copy in it, alongside the pre-existing `summary`. That
-- left the table with two columns meaning the same thing, and the front end
-- would have had no way to know which was authoritative.
--
-- So this file was rewritten. Its new job is to remove the duplication: the
-- copy moves into `summary`, which already existed, and `description` goes
-- away. This file now brings a database forward that applied the old version,
-- and it is a no-op on a database built from the current 0001.
--
-- On an existing database you almost certainly want this over a table drop:
-- the seeded rows are the launch state of the public page.
--
-- Safety
--   - Idempotent. Safe to run more than once. The summary update writes the
--     same canonical values each time, and the drop is guarded.
--   - Adds no row and deletes no row. The table stays at exactly three.
--   - Writes no measurement value. These strings describe a surface, they do
--     not assert a metric, so none of this is covered by
--     optimizations_improvement_requires_evidence, and none of it needs to be.
--   - Touches only rows whose surface is one of the three tracked surfaces, so
--     a future 'Change' row is never rewritten by this statement.
--   - Reads and writes nothing that reaches the browser; no key or credential
--     appears in this file.
--
-- Rollback note
-- -------------
--   Full revert, restoring the duplicate column:
--     alter table public.optimizations add column if not exists description text;
--     update public.optimizations set
--       description = case surface
--         when 'tui_interaction'    then 'How fast the terminal interface responds to you.'
--         when 'repo_indexing'      then 'How fast the tool reads a repository and notices an edited file.'
--         when 'native_text_search' then 'How fast the tool returns search results across a repository.'
--       end
--     where surface in ('tui_interaction','repo_indexing','native_text_search');
--
--   Revert only the titles, without restoring the column:
--     update public.optimizations set title = 'TUI interaction latency'
--       where surface = 'tui_interaction';
--     update public.optimizations set title = 'Repository indexing time'
--       where surface = 'repo_indexing';
--     update public.optimizations set title = 'Native text search latency'
--       where surface = 'native_text_search';

begin;

-- One canonical description per tracked surface, held in `summary`.
--
-- Written unconditionally rather than only when the column exists, because
-- this is the authoritative copy and it makes the statement idempotent across
-- both database shapes: a fresh chain that never had `description`, and a
-- database that applied the old version of this file.
update public.optimizations set
  title = case surface
    when 'tui_interaction'    then 'TUI interaction'
    when 'repo_indexing'      then 'Repo indexing and file watching'
    when 'native_text_search' then 'Native text search'
  end,
  summary = case surface
    when 'tui_interaction'    then 'How fast the terminal interface responds to you.'
    when 'repo_indexing'      then 'How fast the tool reads a repository and notices an edited file.'
    when 'native_text_search' then 'How fast the tool returns search results across a repository.'
  end
where surface in ('tui_interaction', 'repo_indexing', 'native_text_search');

-- Drop the duplicate, but only if this database still has it. Guarded so that
-- running this file against a database built from the current 0001 is a clean
-- no-op instead of an error.
do $$
begin
  if exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'optimizations'
       and column_name  = 'description'
  ) then
    execute 'alter table public.optimizations drop column description';
  end if;
end
$$;

commit;
