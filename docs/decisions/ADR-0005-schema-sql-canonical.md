# ADR-0005 — `schema.sql` is the canonical home of every definition

- **Status:** Proposed (coordinator), awaiting owner gate
- **Date:** 2026-09-13
- **Decider:** Andrii Tkhorenko (AndriyTkh)
- **Depends-on:** ADR-0001 §2 (additive tables, replaced policies), ADR-0001 §4 (migration
  convention)
- **Amends:** ADR-0001 §4 — *where* a definition is written, not the migration rules themselves

## Context

Upstream commit `a3a7572` changed how upstream itself manages its database: `supabase/schema.sql`
became the single idempotent home of every definition — tables, columns added to an existing table
via guarded `add column if not exists`, functions, triggers, policies. `migration-*.sql` files were
narrowed to carry only what re-running `schema.sql` cannot do: a one-off edit to rows already
there. Old migration files stay, for numbering continuity, but stop being where new definitions
go. `supabase/README.md`'s "Changing the database" section states this plainly, and
`migration-003-synced-at.sql` / `migration-006-lww-and-ownership.sql` are now header comments
pointing at `schema.sql` plus, where one applied, a single row edit.

ADR-0001 §4 was written against the old convention: "hand-written, numbered, idempotent SQL files
… applied manually", with no distinction between a migration that defines something and one that
edits rows, because upstream did not yet draw that line. The fork's P1 work (the members table,
`workspaces.kind`, `tasks.assignee`, the replaced `own_rows` predicates) is about to add exactly
the kind of definitions this line separates, so the fork needs to pick a side before P1 writes SQL
under the old assumption.

## Decision

The fork adopts upstream's `schema.sql`-canonical convention wholesale, effective for all fork SQL
from P1 onward.

- **Every definition lives in `schema.sql`.** The members table, `workspaces.kind`, the
  `tasks.assignee` column, the replaced `own_rows` predicates, and any new trigger are written
  there, guarded the same way upstream guards its own additions (`create table if not exists`,
  `add column if not exists`, `create or replace function`, `drop policy if exists` /
  `create policy`).
- **`migration-007-*.sql` is created only if a row backfill is needed** — a one-off edit to rows
  already in the database (for example, stamping an existing `kind` value). If P1 needs no such
  edit, no migration file is created at all. Numbering still starts at **007**; the count is not
  forced to reach it.
- **ADR-0001 §2 is unchanged.** Tables and columns are still only ever added, never repurposed;
  RLS predicates are still the one replacement surface, both halves together, read/write asymmetry
  preserved. This ADR does not touch that rule — it only relocates where the additive/replaced SQL
  is physically written.
- **ADR-0001 §4's other terms are unchanged**: hand-written, idempotent, applied manually in the
  Supabase SQL editor, no migration tool, no down-migrations. Only *where a definition is written*
  changes, from a numbered migration file to `schema.sql`.
- **The P0 harness already exercises this.** `tests/harness/schema.ts` applies `schema.sql` and
  then the migrations in order, so every test run already re-applies `schema.sql` idempotently —
  no harness change is needed for this ADR to hold.

## Consequences

- **Merge tax moves, not away.** Upstream merges that touch `supabase/*.sql` used to conflict on
  migration file bodies; they now conflict on `schema.sql` policy bodies and guarded column adds
  instead. Still bounded to policy bodies and guarded additions, per ADR-0001 Consequences; still
  checked by hand.
- **Personal-must-not-regress still holds by construction.** A personal workspace on a database
  upgraded by re-running `schema.sql` behaves identically — this is upstream's own tested claim
  (`supabase/README.md`) and the fork inherits it rather than re-proving it. The upstream-client
  smoke test named in ADR-0001 Consequences is unaffected.
- **Old migration files are not rewritten.** `migration-003` and `migration-006` keep their header
  comments and any row edit exactly as upstream left them; the fork does not backport this
  convention onto its own pre-existing files, because none exist yet at this ADR's date.
- **A future reader looking for "where is X defined" looks in `schema.sql` first**, and in a
  migration file only for a row-level history of one-off edits.

## Reconsider when

- Upstream abandons the single-file convention (reverts `a3a7572` or forks it further away).
- A definition genuinely cannot be made idempotent in place inside `schema.sql` — at which point
  the exception is recorded here or in a new ADR, not worked around silently in a migration file.
