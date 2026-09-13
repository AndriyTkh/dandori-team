# Receipts — 002-team-workspaces

Append-only. Every receipt names the command that was actually run, its output, the SHA and the
date. Sign-offs are `Andrii Tkhorenko (single-operator)` — a real receipt and an acknowledged
weakness at the same time, never independent review (CLAUDE.md).

## db-api receipt (T002)
- Component `db-api` flipped `UNTESTED` → `VALIDATED` in `docs/validation-map.md`.
- Test authored by T001 in lane `wt/dbapi-debt`, merged at `9bc5687` (2026-09-13). Diff of the lane:
  one new file, `tests/local/db-api-p1-surface.test.ts`; nothing under `src/` changed (FR-030
  spirit).
- Command `npm test -- --run --project local tests/local/db-api-p1-surface.test.ts`, run on the
  primary checkout at `9bc5687`, 2026-09-13, Docker-free (`local` vitest project; `requestPush`
  mocked, `fetch` stubbed to throw): **PASS — 1 file / 22 tests, 3.28s** (tests 188ms).
- Independent closer run (separate agent, same lane, before merge): PASS 22/22, `npm run lint`
  exit 0, `npx tsc -b --noEmit` exit 0.
- Scope honesty: `paths:` lists `src/db/dates.ts`; the receipt exercises `dates.ts` only
  indirectly (`taskDate()` via `updateTask` position moves). Functions pinned: `createWorkspace`,
  `renameWorkspace`, `deleteWorkspace` (soft cascade to labels/tasks/notes), `updateTask`,
  `listWorkspaces`, plus `createTask` via round-trip.
- Current-behaviour observations pinned as-is, not fixed (findings for P1 design, not defects
  today): (1) `deleteWorkspace` cascades to children even when the workspace row is absent
  locally; (2) no-op mutators (`renameWorkspace`/`updateTask` on unknown id) still call
  `requestPush`; (3) `renameWorkspace('')` keeps the old name but still bumps `updated_at` and
  re-dirties — a spurious LWW write; (4) `updateTask` does not normalise `title`; (5)
  `listWorkspaces()` returns `Local<T>` rows with `_dirty` intact.
- Sign-off: Andrii Tkhorenko (single-operator).
