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

## sync-engine flake receipt (T003)

- Substrate: `sync-engine` (VALIDATED at e7f258d; this receipt repairs the evidence behind it).
  Investigation only — no file other than this one was changed. Checkout `4185faa`, 2026-09-13,
  local supabase stack (Docker, 127.0.0.1:54321), single operator.
- Trigger: CI run `actions/runs/34744308875` at main `526758a`, `tests/stack/soft-delete.test.ts:91`
  acceptance 1, `AssertionError: expected undefined to be defined`; one local failure when two
  stack suites overlapped.

### 10x loop — verify command as written

`for ($i=1; $i -le 10; $i++) { npm test -- --run --project stack tests/stack/soft-delete.test.ts }`
(PowerShell, repo root, sequential, nothing else on the stack). **Scope note:** through
`npm test --`, the positional file filter was NOT honoured — every run executed the whole
`stack` project (5 files / 24 tests, soft-delete's 3 included). `npx vitest run --project stack
<file>` does honour it (1 file / 3 tests) and was used for the experiments below.

| run | outcome | files / tests | vitest duration | wall |
|---|---|---|---|---|
| 1 | PASS, exit 0 | 5 passed / 24 passed | 14.28s | 17s |
| 2 | PASS, exit 0 | 5 passed / 24 passed | 13.62s | 16s |
| 3 | PASS, exit 0 | 5 passed / 24 passed | 13.61s | 16s |
| 4 | PASS, exit 0 | 5 passed / 24 passed | 13.91s | 16s |
| 5 | PASS, exit 0 | 5 passed / 24 passed | 13.79s | 16s |
| 6 | PASS, exit 0 | 5 passed / 24 passed | 13.23s | 15s |
| 7 | PASS, exit 0 | 5 passed / 24 passed | 13.63s | 16s |
| 8 | PASS, exit 0 | 5 passed / 24 passed | 13.17s | 15s |
| 9 | PASS, exit 0 | 5 passed / 24 passed | 13.27s | 15s |
| 10 | PASS, exit 0 | 5 passed / 24 passed | 13.17s | 15s |

10/10 green: the flake does not reproduce on this machine unloaded. Log: session scratchpad
`loop10.log` (not committed).

### Mechanism (confirmed by trace + reproduction, not timing folklore)

Every write through `src/db/api.ts` calls `queue()` → `requestPush()` (`src/db/api.ts:37-39`),
which arms a **400 ms debounce timer** (`src/sync/sync.ts:168-174`, `PUSH_DEBOUNCE_MS`) that
fires a bare `void push()`. That push is outside `startSync()`'s `cycle`, is not cancelled by
`handle.stop()` (`sync.ts:499-506` clears only the 60s interval + DOM listeners), and always ends
in `settle()` (`sync.ts:280-281`) even with zero dirty rows.

Both cycle drivers — `tests/harness/sync.ts:81-93` (counts any two rests after one `syncing`) and
the private `drivePushAndPullCycle` in `tests/stack/soft-delete.test.ts:44-72` (resets
`leftInitial` per settle) — resolve on the **second `idle` transition after a `syncing`**, and
neither can tell whose `settle()` produced it. `deleteTask(taskId)` (`soft-delete.test.ts:80`)
arms the timer at t0; the test then drives cycle 2 and cycle 3 back to back:

1. cycle 3 `push()` — nothing dirty → `syncing` → `idle` = **settle #1** (`sync.ts:200`, `:281`).
2. cycle 3 `pull()` → `runPull()` sets `syncing` (`sync.ts:340`), then pulls `SYNCED_TABLES` in
   order `workspaces, labels, notes, tasks` (`src/db/types.ts:170`) — **tasks last**.
3. At t0+400 ms the debounce timer fires `push()`: `setState('syncing')` is a no-op (already
   `syncing`), no dirty rows, `settle()` → `idle` = **settle #2** while `runPull` is still
   fetching/merging the tasks page.
4. The driver resolves, `handle.stop()` sets `stopped=true` (does not abort the in-flight pull),
   the test reads `db.tasks.get(taskId)` before `mergeRows` has written the row → `undefined` →
   line 91. The real pull finishes afterwards; its own `settle()` (`sync.ts:357`) is silent because
   state is already `idle` (`setState` dedupes, `sync.ts:58-59`).

The condition is therefore: **(cycle 2 duration + cycle 3 duration up to the tasks merge) >= 400 ms
from `deleteTask()`**. Locally that window is ~120 ms (see probe N=0) so it never trips; on a cold
CI runner or under a concurrent suite it does. Seed's `createTask` arms the same timer, so cycle 1
carries the same hazard (the timer is re-armed, not stacked: `requestPush` clears the previous one).

Second-order variants of the same seam (all from the one extra `settle()`):
- timer lands during cycle 2's `push()` → `pushAgain` (`sync.ts:178-181`, `:290-293`) → a second
  push → settle #2 before `pull()` → cycle 2's pull is **skipped** (`cycle` returns on `stopped`,
  `sync.ts:479`). Harmless for acceptance 1 but it is the F-1 class again.
- timer lands during cycle 2's pull → driver 2 resolves early, that pull is still in flight while
  the test runs `db.tasks.clear()/db.meta.clear()`; cycle 3's `pull()` then **joins** it via
  `pullInFlight ??=` (`sync.ts:328`) instead of starting a fresh one; its settle is silent → the
  driver times out (10 s) rather than reading `undefined`.
- Refuted sub-hypothesis: a stale cursor written after `db.meta.clear()` cannot hide the row —
  `CURSOR_SLACK_MS = 5_000` (`sync.ts:30`, `:404`) puts the cursor 5 s behind, so the deleted row
  is always re-fetched.

**Verdict on the suspected seam:** confirmed in substance, corrected in detail. The settle-count
IS the seam, but the private driver's "two separate `syncing` entries" requirement would produce a
timeout, not an early return; the early return that yields `undefined` comes from the debounced
`requestPush` push adding a third rest that both drivers count as pull's. The harness and the
private driver share the defect equally — the private copy is not the safer one.

### Reproduction (temporary probe, `tests/stack/zz-t003-probe.test.ts`, deleted after — tree clean)

Replayed acceptance 1 verbatim with the file's own driver plus an `onSyncState` transition log,
`N` filler tasks seeded to lengthen the pulls (`npx vitest run --project stack <probe>`):

| N filler | deleteTask → timer fires | cycle 3 pull window | result |
|---|---|---|---|
| 0 | 660 ms → 1062 ms | 735–779 ms | PASS (`deleted=true`); stray push fires at 1062 ms, after the test |
| 400 | 3384 ms → 3794 ms | 3540–3720 ms | PASS — 64 ms margin |
| 800 | 10537 ms → 10942 ms | 10757 ms → still merging at 11011 ms | **FAIL — `AssertionError: expected undefined to be defined`**, `db.tasks.get` = undefined at 11011 ms; same row `present` 1.5 s later |

The N=800 log shows exactly the sequence above: settle #1 at 10757 (push), `syncing` at 10757
(pull), `idle` at 10942 (timer push's settle, counted as #2), `handle.stop()` at 10942, `get` →
undefined, row present after the quiet period. Same assertion, same line, same shape as CI.

### Extra experiment — overlapping suites (clearly separate from the 10x loop)

Two processes on one stack: A = `soft-delete.test.ts` 4x sequential, B =
`offline-round-trip.test.ts` 3x sequential, started together (`npx vitest run --project stack`).
Run twice.

- Attempt 1: A 3/4 PASS, A run 2 **FAIL — `Serialized Error: code XX000 … heapam.c
  simple_heap_update`** (Postgres "tuple concurrently updated") thrown from `globalSetup` →
  `applySchema()` racing B's own `applySchema()`; B log lost (shell redirect), rerun below.
- Attempt 2: A run 1 **FAIL — `Applying schema.sql failed: tuple concurrently updated` (XX000)**,
  A runs 2–4 PASS (3/3 tests each); B 3/3 PASS (4/4 tests each).

Conclusion: overlapping suites locally reproduce a **different** failure — concurrent
`supabase/schema.sql` re-apply from two `globalSetup`s (`tests/harness/global-setup.ts` →
`tests/harness/schema.ts`), the class already noted in 001 receipts (T007a bounded 40P01 retry does
not cover XX000). The `undefined` flake itself did not trip under overlap here because the
cycles stay ~120–200 ms; the overlap is a load amplifier for the same 400 ms window on CI, not
a separate mechanism for line 91.

### Recommended repair for T004 (tests/harness only; no `src/` change; no assertion change)

`src/sync/sync.ts` already exports the disarm: `flushQueue()` (`sync.ts:304-315`) clears
`pushTimer` and drains dirty rows. In `tests/harness/sync.ts` `driveSyncCycle`, **`await
flushQueue()` before `startSync()`**. The driven cycle then has exactly two observable settles —
the empty push's and the pull's — and no third party can add one, so `SETTLES_PER_FULL_CYCLE = 2`
becomes exact rather than hopeful. Keep the `settles` option (lww-conflict's offline pull-only
case) and the `predicate` backstop. Delete the private `drivePushAndPullCycle` in
`tests/stack/soft-delete.test.ts` (and, for consistency, the one in
`tests/stack/offline-round-trip.test.ts`) in favour of the harness; `expect`/`it`/acceptance
comments untouched; update the header comments that describe the old first-settle workaround.
Measured margin after the fix should be verified with the N=800 load probe (or equivalent)
before the 10x loop, since the unloaded loop cannot see this seam. Separately worth a T004 note,
not a fix: `handle.stop()` leaves the debounced push and an in-flight pull running into the next
test — `flushQueue()` at the start of each drive also absorbs that.

### Read-list check

Not stale. `src/sync/sync.ts:43-78` (state/settle), `:176-190` (push entry) accurate; `:462-507`
covers `startSync` (`:473`, `cycle` `:476-481`, `tick()` `:496`, `stop` `:499-506`). Harness
comment `tests/harness/sync.ts:14` cites `cycle()` at `sync.ts:462-479` — off by ~14 lines
(actual `:476-481`); cosmetic, fix alongside T004. 001 receipts F-1 (line 39) and plan R-14
(line 1292) as cited.

Sign-off: Andrii Tkhorenko (single-operator).

## R-10 verdict list (T006, reviewer, read-only)
- HEAD `4185faa`, 2026-09-13. Every `SYNCED_TABLES` / `SYNCED_COLUMNS` / table-count / column-list
  reference under `tests/` was listed with one verdict each. Baseline full-suite run: NOT RUN by
  T006 (stack in use by T003) — delegated to T005's two consecutive full-suite runs, which precede
  TG-2's widening.
- **FR-030 verdict: no 001-validation-spine check must change** for the `members` widening, the
  `assignee`/`kind` widening, or Dexie v3. SC-003 holds. Member-wise, survives:
  `claim-cache.test.ts:3,18-20,76-78,96-98`; `schema-apply.test.ts:31-78` (filters by the local
  4-list, `own_rows` name kept, new triggers not enumerated); `soft-delete.test.ts:86-87`;
  `lww-conflict.test.ts:59-107` fixtures (server default fills `assignee`);
  `rls-two-accounts.test.ts:95-158` (read half stays loose — what T011–T013 prove);
  `tests/harness/schema.ts:15-22` (`SQL_FILES` ends at migration-006; none planned).
- Set-wise but survives on a condition: `offline-round-trip.test.ts:75,120,218-226` —
  `TASK_COLUMNS = Object.keys(SYNCED_COLUMNS.tasks)`; the column-for-column `toEqual` stays green
  only if `createTask` writes `assignee: null` explicitly (`undefined` locally vs `null` on the
  server fails). `createTask` builds a full `Local<Task>` literal, so the widened type forces the
  field at compile time — provided `src/db/types.ts` and `src/db/api.ts` land together.
- Coordinator notes carried into TG-2 sequencing:
  1. T028 (`types.ts`) cannot pass its own verify alone — widening `SYNCED_TABLES` breaks
     `local.ts:85` until `DandoriDB` gains `members` (T029), and widening `Workspace`/`Task`
     breaks the literals at `api.ts:54,178` until T031. T028+T029+T031 source halves land as one
     green change set.
  2. `tests/setup.ts:14-18` enumerates per-table `clear()` and will not clear `members` after v3;
     D-13 forbids editing it. **Owner decision queued (BLOCKED):** each new 002 test clears
     `db.members` itself, or a one-line P0 harness edit is approved as a recorded FR-030 exception.
  3. `tests/local/db-api-p1-surface.test.ts:146-156` (002-owned) exact-`toEqual`s a
     `createWorkspace` row and **breaks at the `kind` widening**. Re-pin belongs to T040 (same
     file, TG-2), explicitly — not weakened to `toMatchObject`.
- T003 observation, not on this feature's path: two stack processes overlapping race
  `applySchema()` in `globalSetup` (`tuple concurrently updated`, XX000) — a different failure
  class from line 91, not covered by 001's 40P01 retry. CI runs one process; recorded for a later
  harness card.
