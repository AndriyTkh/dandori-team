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

## Owner decisions 2026-09-14 (TG-0 → TG-1 gate)
1. `supabase-auth` (UNTESTED) is accepted as incidental substrate for P1 harness work (T007–T019):
   `accepted-risk:` line added to its map entry. Option (a) over a validation dispatch first.
2. `tests/setup.ts` stays unedited (D-13). Every 002 test that seeds `members` clears `db.members`
   itself. No FR-030 exception.
3. `tests/stack/offline-round-trip.test.ts`'s private two-settle driver swap is approved as the
   second recorded FR-030 exception → subtask T004a under T004.

## Upstream merge 806f5a8 (8 commits), 2026-09-14
- Merge commit `7cb8df6` on `main`, then `main` → `002-team-workspaces` as `db23c6d` (clean).
  Conflict only in `CLAUDE.md`: fork's kept; upstream body copied verbatim into
  `docs/upstream-CLAUDE.md` (body `cmp`-verified byte-identical below the header).
- Upstream diff: `src/gcal/{api,client,sync}.ts` rewritten — Google account is now a refresh token,
  hour-long access tokens renewed via a **new Cloudflare Worker route** `worker/index.ts`
  (`/api/gcal/*`, `run_worker_first`, `GOOGLE_CLIENT_SECRET` as a Cloudflare secret, never in
  repo or bundle); event deletion read back unticks the task; label colour → event colour
  (`GCAL_COLOR_OF` added to `src/db/types.ts`, `SYNCED_TABLES`/`SYNCED_COLUMNS` unchanged);
  `dates.ts` un-exports three helpers; timeline phone CSS. `src/sync/` untouched;
  `supabase/` untouched; Dexie schema unchanged; no test-imported signature changed.
- Verify on `main` merge worktree (pre-T004 harness): tsc PASS, lint PASS, build PASS; suite
  6 files / 29 tests → 1 FAIL at `soft-delete.test.ts:91` acceptance 1 — the exact T003 flake,
  which `main` still carries (T004's fix lives on 002). Recorded as further confirmation, not as an
  upstream regression. On `002-team-workspaces` at `db23c6d`: `npm test -- --run` → 7 files /
  51 tests PASS.
- Architecture fact changed by upstream: "no server component anywhere" no longer holds →
  ADR-0007 + `ARCHITECTURE.md` §gcal/§5 update + regenerated index + `gcal-integration` paths
  (`worker/index.ts`), same change set. `gcal-integration` stays UNTESTED.
- Sign-off: Andrii Tkhorenko (single-operator).

## T007 receipt — harness `createTestUsers` / `asUser` (2026-09-14)

Merge commit `8579911` (lane `wt/harness-accounts`, worker commit `66ac420`).

**What landed.** `tests/harness/accounts.ts` gained two additive exports and nothing else:
`createTestUsers(n, label = 'user'): Promise<TestUser[]>` and `asUser(testUser): Promise<SupabaseClient>`,
the latter memoized on a `WeakMap<TestUser, Promise<SupabaseClient>>` so a file that switches
between accounts A/B/C signs in once per account rather than once per assertion. `git diff --stat`
on the lane: `1 file changed, 31 insertions(+)`, zero deletions. `createTestUser`, `clientFor`,
`deleteTestUser` and the `TestUser` type are byte-identical to `4991c33` — verified by the closer
against `git show 4991c33:tests/harness/accounts.ts`, not assumed.

**Verification (closer, Gate-2).**

- Throwaway probe `tests/stack/zz-t007-closer.test.ts`: 3 passed / 3 — `asUser(u0)` returns the
  same promise on repeat calls, and `auth.getUser()` on three memoized clients returned three
  distinct ids matching each `TestUser.user.id`. Probe deleted afterwards; `git status --short`
  then showed `accounts.ts` alone.
- Full stack suite, 5 files: `Test Files 5 passed (5) / Tests 24 passed (24)`, 13.0s.
- `npm run lint` (oxlint) exit 0, no diagnostics. `npx tsc -b --noEmit` exit 0, no output.

**FR-030.** This is an additive-only edit to a P0 harness helper file: new exports, no existing
signature changed, no existing assertion touched. The P0 checks themselves remain unedited, so
this is outside FR-030's "unedited checks" scope and is *not* a third exception — the two recorded
exceptions remain T004 and T004a.

**Substrate.** `supabase-auth` is `UNTESTED` under the owner's accepted-risk entry of 2026-09-14
(`docs/validation-map.md`). T007 leans on it and does not improve it; recorded here so the debt is
visible rather than laundered through a green harness card.

**Advisory findings, no fix at T007.** (1) `createTestUsers` uses `Promise.all`, so a partial
failure orphans the already-created users in the local stack; this matches the file's existing
"teardown is best-effort, never required for isolation" stance and emails are unique per call.
(2) `asUser` caches a rejected promise for the life of the file; `clientFor` throws loudly on a
sign-in error, so it surfaces as a clear failure rather than a silent one.

Verdict: PASS, mergeable. Sign-off: Andrii Tkhorenko (single-operator).

## Coordinator correction — T016 cited the withdrawn plan D-6 (2026-09-14)

**What was wrong.** Card T016 required `tests/stack/personal-unchanged.test.ts` to assert that
"updating `kind` on an existing row is silently pinned back (D-6)", and its done-when demanded
`kind` immutability "proven as *coerced*". Its Read list named `pin_workspace_kind` as a thing to
read in fork block A. None of that exists, and asserting it would have made the test demand
behaviour the feature must not have.

**The authoritative sources, which agree with each other.** `contracts/policies.sql` lines 117–122
state it directly: "There is no pin trigger: pin_workspace_kind and workspaces_zz_kind_fixed of the
superseded plan D-6 do NOT exist. Kind is an ordinary column under keep_newer and under the
unchanged workspaces write half, which is already owner-only." `plan.md` line 173 records D-6's
`kind` pin as superseded, line 459 marks the silent-pin decision withdrawn, and **D-6′** (line 482)
replaces it: `kind` is mutable by the owner, and one `after update` trigger,
`on_workspace_kind_change`, draws the consequences.

**Why it mattered rather than being a stale comment.** T016 and T017 would have contradicted each
other on the same column. T017 is built on D-6′ and asserts that an owner's flip *works* and that a
stale flip is cancelled by `keep_newer` before the AFTER trigger can fire. T016 as written asserted
that a flip is silently reverted. Both cannot be green. The contradiction would have surfaced at
T020–T023 as an unexplainable red in whichever file ran second.

**Resolution, decided by the coordinator on the contracts' authority, not invented.** T016 keeps
the two correct `kind` cases — a third value is refused by `workspaces_kind_check` (FR-001, US1
acceptance 4), and the `personal` default holds for a new row and for a row that predates the
column (FR-003). The withdrawn pin-back case is replaced by the ownership boundary that belongs in
a personal-unchanged smoke test: a **non-owner** flipping `kind` on a workspace they do not own is
refused `42501` by the unchanged `workspaces` write half, because `kind` carries no special
privilege path (FR-034). The owner's successful switch and both directions' consequences stay
wholly in T017. The T016 card text, its Read list and its done-when were rewritten in `tasks.md`
to say this, with the correction marked inline.

**Caught how.** The T016 worker was dispatched with the stale clause emphasised as the heart of the
card, and was corrected mid-flight before it wrote the assertion. The trigger for the check was the
T019 report, which set `kind` by a direct update and prompted a read of what actually happens to
such an update.

**Owner-visible.** This is a coordinator resolution of a contradiction inside already-approved
planning artifacts, not a new decision. It changes no requirement: FR-034 and D-6′ were already
owner-approved. It is recorded here so the divergence between the T016 card text and the contracts
is not mistaken later for a silent scope change. Sign-off: Andrii Tkhorenko (single-operator).

## T008 receipt — test-only `adminClient(testUser)` (2026-09-14)

Merge commit `1584e31` (lane `wt/harness-accounts`, worker commit `fa85fcd`).

**What landed.** Two lines of import (`pg`'s `Client`, and `DB_URL` added to the existing `./stack`
import) plus one appended exported function. `adminClient(testUser)` opens a direct `pg` connection
on `DB_URL`, runs a single parameterized `insert into public.instance_admins (user_id) values ($1)
on conflict (user_id) do nothing`, closes the connection in a `finally`, and returns `asUser(testUser)`
— the same memoized authenticated client T007 introduced, now admin-flagged. Never through
PostgREST, never through an RPC, because no client-callable grant-admin path exists anywhere in
this project and none may (FR-039).

**Why it exists.** The harness provisions users through `auth.admin.createUser`, so "the first
account created is the admin" lands nondeterministically inside a suite and is worse than useless
on a database that already has rows. The `users_seed_first_admin` trigger itself is still asserted
separately, against an empty `instance_admins`, by T018 — this helper is not a substitute for that
assertion and its doc comment says so.

**Verification.**

- Full stack suite in the lane: `Test Files 5 passed (5) / Tests 24 passed (24)`. That is the
  P0-no-regression half of the card's verify, and it passed.
- `npm run lint` (oxlint) exit 0. `npx tsc -b --noEmit` exit 0. Both re-run by the closer, not
  taken on the author's word.
- `grep -rn "adminClient" src/` returns nothing; repo-wide the name appears only at the two lines of
  `tests/harness/accounts.ts`.
- Additive-only (D-13) confirmed by diffing against `git show a694465:tests/harness/accounts.ts`:
  every pre-existing export is byte-identical.
- The closer confirmed the conflict target is valid — `contracts/policies.sql` line 290 declares
  `user_id uuid primary key` — and that the insert is not blocked by the table's RLS-with-no-policy
  rule, because the harness connects as `postgres` with `rolbypassrls = true`.
- `granted_by` is deliberately left null: the column is nullable, no constraint or routine reads it,
  and `list_logins()` never surfaces it. Fabricating a grantor would assert a provenance that did
  not happen.

**Outstanding re-verify obligation, against T026 — this is not a waiver.** The card's verify also
asks that `adminClient(a)` then `is_admin()` returns `true`, and `false` from a non-admin. That is
not executable today: `select to_regclass('public.instance_admins')` returns null on the live local
stack, because the table and `is_admin()` land at T025 and T026. The behavioural half is therefore
**carried by T018** (`tests/stack/logins-provisioning.test.ts`), which is `blocked-by: T008` and is
the only consumer of the helper: its admin-side clauses all require a caller for whom `is_admin()`
is true, so a broken helper fails T018 loudly and by name at T026, whose own verify line already
runs that file. `adminClient` is **not** described here as behaviourally verified, and
`account-provisioning` moves no closer to green on the strength of this card.

To make that discharge literal rather than inferred, the coordinator added clause **(j)** to T018's
card: `is_admin()` is called directly and asserted `true` from `adminClient(a)` and `false` from an
ordinary `asUser(b)` (T008 closer finding 1).

**Map discipline.** The closer found that `account-provisioning`, cited as substrate by T008 and
T018, had no entry in `docs/validation-map.md` at all, though ADR-0006's Consequences commit to a
new HIGH-criticality entry covering the routines, the first-account trigger and the admin guards.
The coordinator created it as `UNTESTED` in this change set, with its own `accepted-risk` line
recording that it was created ahead of its code so the cards cite a substrate that exists. It
reaches no other status without a receipt naming command, revision, date and the sign-off.

**Other checks.** Personal-must-not-regress: not applicable, test-harness file, nothing under
`src/`, `supabase/` or `worker/`. Spec control: one function, one import line, nothing beyond the
card. Origin-invariant: no origin column, table or cross-origin reference. FR-044: no password, key,
token or credential literal in the added code.

Verdict: PASS, mergeable, two advisory findings both actioned above. Sign-off: Andrii Tkhorenko
(single-operator).

## T009 receipt — structural schema guards (2026-09-14)

Merge commit `f810738` (lane `wt/guards`, worker commit `67e5569`).

**What landed.** `tests/stack/team-schema-guards.test.ts`, 12 cases pinning five structural risks
from `plan.md` against the deployed schema, independent of any application code: **R-17** pgcrypto
installed in the `extensions` schema, asserted first so a missing extension fails as one clear line;
**R-16** the `users_seed_first_admin` trigger on `auth.users`; **R-1** a plain authenticated select
on `public.members` that does not recurse; **R-2** `prosecdef` and a pinned `search_path` for all
fifteen functions this feature adds; **R-3** an anon client refused on each of the eight RPCs.

**Red verify, run three times, and what each run changed.**

Run 1 was red on R-16, R-1 and R-2 for their named reasons, and **green on all eight R-3 cases for
the wrong reason**: the routines do not exist yet, so PostgREST answers `PGRST202` "could not find
the function", the error is truthy, and a bare truthiness assertion is satisfied. The author had
documented the vacuity honestly in the file header rather than hiding it. Sent back.

Run 2, after the eight cases were tightened to require a Postgres `42501` privilege refusal with
`permission denied for function <name>`: `Tests 11 failed | 1 passed (12)`. Each R-3 case now reads
`create_login: expected privilege refusal 42501, got PGRST202: Could not find the function
public.create_login(email, password) in the schema cache`. Red for the right reason, and a real
regression guard once the routines land with their `revoke ... from public, anon`.

Run 3, after the closer's findings were actioned: `Tests 11 failed | 1 passed (12)`, with R-1 now
failing on a stronger precondition — `members_access policy not found on public.members (found:
(none))`.

**Closer verdict: PASS, mergeable, five advisory findings, none blocking.** The closer verified
red-first integrity case by case — all eleven reds trace to an absent schema object, none to a typo,
column name or harness error — and cross-checked the arithmetic (1+1+1+1+8 = 12) so that no case was
silently skipped. It confirmed all fifteen R-2 names exist in the contracts and that all eight R-3
argument name-sets match the contracted signatures character for character. It confirmed R-17's green
is genuine: the query joins `pg_extension` to `pg_namespace` and requires `nspname = 'extensions'`,
so pgcrypto in `public` would fail it. It confirmed `public.keep_creator()` is correctly **excluded**
from the fifteen, the contract defining it without `security definer` on purpose.

**Three findings actioned before merge.**

1. The file promised the wrong card. Its header said T024 turns it green. It does not. R-1 clears
   at T023, two R-3 cases at T024, R-16 and the third R-3 case at T025, and R-2 plus the last five
   R-3 cases at **T026** — the first point the whole file is green. R-2 clears cumulatively: 2/15 at
   T021, 6/15 at T022, 8/15 at T024, 10/15 at T025, 15/15 at T026. Header rewritten; T009's verify
   line corrected in `tasks.md`. **The author caught an arithmetic error in the coordinator's own
   correction** — the coordinator had written "ten of the fifteen by T024" and "the first three R-3
   cases at T024"; re-reading the task bodies gives eight and two, because `is_admin` is not defined
   until T025. The author flagged it rather than copying it, and the numbers above are the corrected
   ones.
2. R-1 went vacuously green in the T020 to T023 window — the same class of defect already sent back
   once on R-3. Between fork block A (table created, RLS enabled) and T023 (the `members_access`
   policy), the table has RLS on and no policy, so a select returns zero rows with no error and the
   test passes without exercising any policy. Closed by asserting through `pg_policies` that
   `members_access` exists on `public.members`, as a precondition before the untouched recursion
   canary. This is what run 3's new red line shows.
3. R-2 asserted that a `search_path` exists, not what it is — `startsWith('search_path=')` would
   accept an empty one. Replaced with a structural check requiring the pinned path's first segment to
   be `public` and its last to be `pg_temp`, which admits all three contract forms and rejects the
   degenerate ones, with each offending function's actual `proconfig` in the message.

**Two findings recorded, not fixed.** `tests/` sits outside every tsconfig include, so continuous
integration never typechecks this file or any other test — pre-existing and repo-wide, not introduced
here; the closer typechecked the file out of band, clean. And the R-3 cases now pin the eight
routines' parameter names, so a rename would leave the guard permanently red while looking like a
schema bug; recorded as a done-when note on T024 and T026 rather than loosened here.

**Other checks.** Lint and typecheck clean, re-run by the closer. Personal-must-not-regress: not
applicable, one file under `tests/stack/`, nothing under `src/`, `supabase/` or `worker/`. Spec
control: every assertion traces to the card and the contracts. Origin-invariant: no origin column,
table or cross-origin reference. Map discipline: no mapped paths touched; `supabase-auth` is used
as incidental substrate under the owner's accepted risk and the file makes no claim about auth.
FR-044: no credential literal; the two throwaway password strings are payload for calls asserted to
be refused.

Sign-off: Andrii Tkhorenko (single-operator).

## Coordinator correction — three cards named the wrong refusal mechanism (2026-09-14)

Three workers, on three unrelated cards, independently reported the same thing: a card (or a
coordinator instruction) asserted a Postgres `42501` where the deployed behaviour will be zero rows
and no error at all. In two of the three the wrong text was the coordinator's own. Recording the
mechanic once, and the three corrections it forced.

**The mechanic.** An `own_rows`-style policy has two halves. A write statement is refused with
`42501` only when the row **passes** the read half's `using` clause and its new values then fail
`with check`. When the row fails `using`, the statement matches nothing — it behaves like a `WHERE`
that selected no rows, reports `count: 0` and **raises no error and no SQLSTATE**. "Refused" has two
observable shapes, and a test that asserts the wrong one is a test that fails against correct code.

**T016 (`personal-unchanged.test.ts`), twice.** The card first required asserting that a non-owner's
`kind` update is pinned back to `personal` by a trigger. That trigger does not exist: plan decision
D-6 was withdrawn in favour of D-6′, `contracts/policies.sql:117-122` states authoritatively that no
pin trigger exists, `kind` is an ordinary owner-writable column, and `on_workspace_kind_change`
(AFTER UPDATE) only draws the consequences. Asserting a pin-back would also have contradicted T017,
which asserts the switch succeeds. Corrected. The coordinator then told the worker to assert `42501`
for the non-owner case, which was **also wrong** — account B is a stranger to A's workspace, fails
the read half, and gets zero rows with no error. The worker corrected the coordinator. Card text
fixed a second time.

**T017 (`kind-switch.test.ts`).** The worker hit the same mechanic independently on case (e) and
reported it rather than working around it. Its consequence is a scope correction on T022: that
card's verify line previously expected `kind-switch.test.ts` green after T022, but case (e) needs a
*member* to be visible under the read half, which only widens at T023. T022's verify line now
excludes case (e) and names T023 as where it turns green.

**T010 (`members-two-accounts.test.ts`).** The card said adding and removing a member are both
refused with `DA001`. They are different operations with different mechanisms. `add_member_by_email`
is `security definer` and raises `DA001`; removal **is not an RPC** (`contracts/rpc.md:293`) but an
ordinary soft-delete write, refused by RLS. Card corrected against the contract.

No requirement changed in any of the three. The contracts were already owner-approved and were
correct throughout; what was wrong was three task-card restatements of them, and the fix in every
case was to read the contract and make the card match it.

Sign-off: Andrii Tkhorenko (single-operator).

## T017 receipt — kind-switch gates on `on_workspace_kind_change` (2026-09-14)

Merged as `47d20aa` from lane `wt/kind-switch` (worker commit `f350a21`). Artefact:
`tests/stack/kind-switch.test.ts`, five cases (a)-(e), committed **red on purpose**.

Red run, by the coordinator on the `supabase` CLI local stack, from the lane worktree:

```
npx vitest run --project stack tests/stack/kind-switch.test.ts
Test Files  1 failed (1)
     Tests  5 failed (5)
```

All five fail for the one structural reason the card names: `workspaces.kind` does not exist, so
the flip arrives as `PGRST204 Could not find the 'kind' column of 'workspaces' in the schema
cache`, and case (b)'s owner-row read finds nothing because `public.members` does not exist
either. No case fails for an incidental reason and none is skipped.

**The closer returned SEND-BACK on the first pass with five blocking findings.** All five were
applied and re-verified; they are recorded here because four of them are hazards that bite any
stack test, not quirks of this file:

1. **`pg` returns `Date` for timestamptz, not `string`** (`pg-types.getTypeParser(1184)`).
   `expect(a).toBe(b)` on two `Date`s is always false, so the stamp assertions could never have
   passed; `Date.parse(<Date>)` coerces via `Date.prototype.toString()` and **truncates
   milliseconds to whole seconds**, so it cannot compare stamps at all. Every comparison now uses
   `.getTime()`. `tests/stack/offline-round-trip.test.ts:82` documents the hazard and `:145` shows
   the `toEqual` form.
2. **The file did not typecheck.** A row shape declared as an `interface` fails
   `TS2344: Index signature for type 'string' is missing` when passed as a generic constrained to
   `Record<string, unknown>`; a `type` alias does not. Three errors, none visible to `tsc -b`,
   because `tsconfig.app.json` includes only `src` and `tsconfig.node.json` only
   `vite.config.ts`/`worker/index.ts` — **`tests/` is in no project and `tsc -b` is vacuous on it.**
   The command that actually checks a test file, now used on every card:
   `npx tsc --ignoreConfig --noEmit --strict --target es2022 --module esnext --moduleResolution bundler --skipLibCheck --lib es2022,dom <file>`
3. Case (e)'s outsider half asserted `42501` for a stranger's flip. A stranger's `UPDATE` fails the
   read half's `using` clause, matches zero rows and raises **no error at all** — the assertion
   could never have passed, and the half duplicated T016's scope. Deleted; the file now creates two
   accounts, not three.
4. Case (a)'s `expect(tasksSeenByExMember).toEqual([])` had **no positive control**. A break that
   makes nobody see anything would have left it green. The same ex-member now reads **one** row
   while the membership is still live, in the same block, before the purge.
5. Case (c) could not distinguish `greatest(updated_at, now())` from a bare `now()`. It now forces
   the member row five minutes into the future before the purge and asserts the read-back stamp
   equals that future value — which only the `greatest` form produces. The fix worker verified the
   premise against `contracts/policies.sql:126-150` before changing anything.

**Green progression.** Cases (b), (c) and (d) turn green at **T022**, when fork block C lands
`workspaces_zz_kind_change` and `members_keep_newer`. Cases (a) and (e) turn green only at
**T023**: (e) needs the `workspaces` read half widened with `public.is_member(id)` before a
non-owner's write can be refused rather than silently matching nothing, and (a)'s positive control
needs the widened child read half so the live member can read the task it later must not see. The
T022 card has been corrected to say `(a) and (e)`, not `(e)` alone.

**Not proven by this card:** nothing about the trigger's behaviour is verified yet. The file is
evidence written before the code, and it stays red until T022.

Sign-off: Andrii Tkhorenko (single-operator).

## T019 receipt — `seedTeamWorkspace` harness helper (2026-09-14)

Merged as `3d6c86c` from lane `wt/harness-seed` (worker commit `b930f30`). Artefact:
`tests/harness/seed.ts`, `+135/-0` — **additive only**, no pre-existing line removed and no
existing export's signature changed (D-13). The seed never inserts a `public.members` row
directly; membership arrives through `add_member_by_email`, whose parameter names match
`contracts/rpc.md` character for character.

**The closer returned PASS with no blocking findings** — the first card in this taskgroup to do so.
It traced the function line by line and confirmed it will work once T024 lands the RPC.

**No runtime behaviour of `seedTeamWorkspace` is verified.** The card's own verify is
`npm test -- --run --project stack` green **after T024**, and T024 has not landed. What is
established today is the shape of the diff, its typecheck, its lint, and the closer's reading —
not that the helper works. It is recorded as UNTESTED substrate under the `membership` map entry
and reaches nothing better without a green run.

Five of six advisories were applied before the commit:

1. **The wrong trigger was named — the same defect class corrected in `7718363`.** Two comments
   said the owner's `members` row is `workspaces_seed_owner`'s effect, "in the same transaction as
   the workspace insert". It is not, on this helper's path: `seed_workspace_owner()` is guarded
   `if new.kind = 'team'` (`contracts/policies.sql:104`) and `createWorkspace` inserts
   `kind = 'personal'`, so that trigger fires and does nothing. The owner row arrives from
   `workspaces_zz_kind_change` / `on_workspace_kind_change()`'s personal-to-team branch
   (`contracts/policies.sql:126-155`), on the **update**. Same outcome, wrong mechanism named; the
   fix worker re-read the contract and confirmed before editing.
2. The recorded member id is now the id the RPC resolved (`data.member_id`), asserted equal to the
   caller's, not the id the caller passed in. On the edge-case-5 path — adding the owner's own
   email — the RPC returns the existing `owner` row, and the old code would have labelled the
   owner's id as a member's.
3. Every throw now carries the Postgres `code`, not just the message. The one that matters is the
   `kind`-write throw: an RLS refusal there arrives as `42501`.
4. The stamp is `Math.max(Date.parse(current.updated_at) + 1, Date.now())`, guarded against `NaN`
   with a named throw. `Date.parse` truncates Postgres's microsecond `updated_at` to milliseconds,
   so on a stack whose server clock leads the client the computed stamp could land **below** the
   stored value and `keep_newer()` would cancel the update.
5. `flushQueue()`'s return — the still-pending count after three bounded tries
   (`src/sync/sync.ts:313`) — is captured and throws when non-zero, instead of being discarded and
   surfacing later as a `PGRST116` that blames the read rather than the push.

The sixth advisory is a **deliberate deferral, not a defect**: the card asks the seed to use "the
real creation path", and today that is unavailable — `createWorkspace` gains its `kind` parameter
only at **T031**, far downstream of T019, which must land before T020. Create-then-flip is correct
for now. **Follow-up owed at T031/T040:** once `createWorkspace(name, 'team')` exists,
`seedTeamWorkspace` should call it and the read/stamp/update/read-back block disappears.

Both silent-failure guards the closer verified are intact and hardened, not weakened: the
`await flushQueue()` before the first server read, which closes the 400 ms debounce race in
`src/db/api.ts:53-66`, and the stamp-then-re-read-and-throw around the `kind` flip, which closes
`keep_newer()`'s silent-cancel hole (`supabase/schema.sql:142-153` — a BEFORE trigger returning
`null` cancels the update with no PostgREST error, and an AFTER-UPDATE trigger never fires on a
cancelled update). A cancelled `kind` update remains impossible to mistake for success.

Sign-off: Andrii Tkhorenko (single-operator).

## Coordinator notes — carried forward, not yet discharged (2026-09-14)

- **FR-043's "outbound messages 0" is covered by construction, not by an assertion.** The
  `supabase` CLI local stack runs with no SMTP transport configured, so no provisioning routine
  can emit mail whatever it does. No card asserts it and none needs to; recorded here so the
  requirement is not later believed to rest on a test that does not exist.
- **Three `DA404` paths have no case in any card**: `contracts/rpc.md` lines 180, 198 and 245.
  T010 covers the fourth (`add_member_by_email` against an email with no account on this origin).
  Not a defect in any card as written — a gap in the card set, to be closed when the TG-2 schema
  cards land the routines that raise them.
- **The `membership` and `team-rls` map entries were created UNTESTED ahead of their code** in
  `460da90`, so the cards that name them as substrate cite something that exists. Neither may reach
  VALIDATED without a green run and a receipt naming command, revision, date and sign-off.

## T010 receipt — membership by email, two accounts (2026-09-14)

Merged as `1e39042` from lane `wt/us2-members` (worker commit `871f588`). Artefact:
`tests/stack/members-two-accounts.test.ts`, `+404/-0`, ten cases, committed **red on purpose**.

Red run, by the coordinator on the `supabase` CLI local stack, from the lane worktree:

```
npx vitest run --project stack tests/stack/members-two-accounts.test.ts
Test Files  1 failed (1)
     Tests  10 failed (10)
```

Ten failed, **none skipped** — the structural gap is reached independently by every case rather
than aborting a shared seed. All ten fail for the reasons the card names: `workspaces.kind` does
not exist, `public.members` does not exist, and `add_member_by_email` / `workspace_member_emails`
do not exist. Nothing fails for an incidental reason.

**The closer returned PASS — clean**, with four advisories, all applied before the commit:

1. A stale line-number pointer into `contracts/rpc.md` was dropped rather than corrected; a pointer
   that drifts is worse than no pointer.
2. The owner's member-list read now destructures `error` and asserts it null **before** the length
   check. A PostgREST error returns `data === null`, and `expect(null).toHaveLength(n)` fails for
   the wrong reason — the assertion would have been red without distinguishing "the list is wrong"
   from "the call failed".
3. **Coverage note, not a defect:** `add_member_by_email`'s `do update set deleted = false`
   reactivation branch (`contracts/rpc.md` lines 38 and 42) is exercised by **no file in this
   taskgroup.** This file's acceptance-6 case adds B twice while B's row was never deactivated, so
   `deleted` is already false and the conflict path takes the no-op arm. Re-adding a *removed*
   member — the branch that must flip `deleted` back — is covered nowhere. Carried forward.
4. The four `deleteTestUser` calls moved into a `finally` wrapping the `42P01`-only catch.

Finding 4 deserves its own record, because it leaked state into every other card's run before it
was caught. `cleanupMembers()` truncates `public.members`, which does not exist before T020, so it
raised `42P01`; the raise escaped `afterAll`, failed the suite at **file** level, and — the part
that mattered — **skipped the four `deleteTestUser` calls underneath it**, leaking four accounts
into the shared stack on every run. The coordinator added the narrow `42P01`-only catch
immediately and broadcast the shape to the T011 author; the closer then asked for the `finally`,
which makes teardown unconditional rather than merely tolerant. The settled pattern for every
stack test in this taskgroup: **tolerate exactly `42P01` in cleanup, and put account teardown in a
`finally` so it runs whatever the cleanup did.**

**Green progression.** Cases 1-6 need T020 (the `kind` column and the `members` table) plus
**T024** (`add_member_by_email`, `workspace_member_emails`). The removal cases additionally need
**T023**'s `members` write half, since B's refused removal must arrive as `42501` from row level
security rather than as zero rows matched.

**Not proven by this card:** no membership behaviour is verified. The file is evidence written
before the code and stays red until T024.

Sign-off: Andrii Tkhorenko (single-operator).

## T015 receipt — the three upstream triggers on both workspace kinds (2026-09-14)

Merged as `8583e4f` from lane `wt/triggers` (worker commit `3aae3a5`). Artefact:
`tests/stack/team-triggers.test.ts`, `+430/-0`, seven cases — three triggers ×
`describe.each(['personal','team'])` plus one R-6 case — committed **red on purpose**.

Red run, by the coordinator on the `supabase` CLI local stack, from the lane worktree:

```
npx vitest run --project stack tests/stack/team-triggers.test.ts
Test Files  1 failed (1)
     Tests  7 failed (7)
```

All seven fail identically on `workspace insert (kind: personal|team) failed: PGRST204 Could not
find the 'kind' column of 'workspaces' in the schema cache`. Single-cause, none skipped. "Fires
identically on both kinds" is established by **literally the same assertions** running twice out of
one `describe.each` body, not by two differently-shaped tests.

**The closer returned SEND-BACK on the first pass with two blocking findings.** Both are clock
hazards that bite any stack test, so they are recorded here rather than left in the lane:

1. **A `timestamptz` does not round-trip as an equal string.** PostgREST renders it through
   Postgres's own json conversion as `…+00:00` and **drops the fractional part entirely when the
   milliseconds are zero**; JS's `toISOString()` writes `…Z` and always keeps three digits. The
   strings are never equal, so the case would have gone red at T020 under the message "a
   newer-stamped update must land — the stale drop above is `keep_newer`, not a broken write path",
   reading as a `keep_newer` regression when nothing about `keep_newer` was wrong. Every stamp
   comparison now goes through `Date.parse` on **both** sides; the repo precedent is
   `tests/stack/lww-conflict.test.ts:226-227, 275, 389`. Note the sibling hazard stays forbidden:
   `Date.parse(<Date instance>)` truncates to whole seconds, and the `pg` driver returns `Date`.
2. **The R-6 late stamp was taken from the host clock against a row stamped by the container
   clock.** The task's `updated_at` had just been written by `follow_workspace_delete` as
   `greatest(updated_at, now())` — the **container's** `now()`. `tasks_keep_newer` fires before
   `tasks_stay_deleted` (alphabetical, `supabase/schema.sql:196-212`). If the container clock leads
   the host by more than the test's elapsed time — routine under Docker Desktop / WSL2, especially
   after a host sleep — `keep_newer` returns null, the statement matches nothing, and PostgREST
   answers 204 with `error === null`. That outcome is **byte-for-byte** the one the file's header
   pre-commits to reading as the FR-014/R-6 regression, so a clock skew would have been filed to
   the owner as a schema regression with the test's own comment forbidding investigation. The late
   stamp is now built from the cascaded row's own `updated_at` + 60 s — a value the container
   produced.

The closer returned **PASS** on the second pass; its four advisories were applied before the
commit (the header paragraph that stated the clock rule backwards, a citation of
`schema.sql:193-195` that pointed at the `do $$` preamble rather than the trigger loops at
`196-212`, a comment recording that the R-6 fix now depends on the member still being able to read
its own cascaded row, and optional chaining in two teardown catch handlers that could throw a
`TypeError` and skip a `deleteTestUser`).

**Green progression.** Six of the seven turn green at **T020** — they need only `workspaces.kind`,
since the creator writes under the unchanged `own_rows` predicate and `kind` is a label these cases
carry, not a gate. The R-6 case turns green at **T023**: it needs `public.members` (T020) and then
the widened child write half, because the member's fixture INSERT evaluates only `WITH CHECK`,
which before T023 requires the workspace to be the caller's own. T021 and T022 touch neither the
three triggers nor the policy predicates, so nothing moves between T020 and T023.

**Recorded coverage residue, in the file's header, asserted nowhere:** `keep_newer`'s contractual
**equal**-stamp acceptance (`supabase/schema.sql:138-141`, "Equal stamps are accepted on purpose"),
and FR-014's "*or reachable on rows it never saw*" half for two of the three triggers — `keep_newer`
and `follow_workspace_delete` are exercised only by the workspace's own creator, whose write path
T023 leaves character for character unchanged. The card's done-when is met literally.

**Not proven by this card:** no trigger behaviour is verified. The file is evidence written before
the code and stays red until T020.

Sign-off: Andrii Tkhorenko (single-operator).

## T016 receipt — a personal workspace is unchanged after the swap (2026-09-14)

Merged as `15ad98b` from lane `wt/personal` (worker commit `ffccd7d`). Artefact:
`tests/stack/personal-unchanged.test.ts`, `+486/-0`, thirteen cases.

Run, by the coordinator on the `supabase` CLI local stack, from the lane worktree:

```
npx vitest run --project stack tests/stack/personal-unchanged.test.ts
Test Files  1 failed (1)
     Tests  5 failed | 8 passed (13)
```

The five reds are all structural on the missing `kind` column — two `42703 column
workspaces.kind does not exist`, two `expected 'PGRST204' to be '23514'`, one `PGRST204 Could not
find the 'kind' column of 'workspaces' in the schema cache` — and all five go green on **T020
alone**. The eight greens are personal-side behaviours that already hold on today's schema; the
closer audited each one for vacuity and found none. T021 and T022 turn nothing in this file green;
**T023's job is to leave all thirteen green**, which is the card's whole point.

**This card took three review passes, and all three blocking findings were the same defect wearing
different clothes: a claim about coverage that was not true.**

1. Pass 1: the file **overclaimed FR-003** — it asserted a pre-existing-row property it did not
   exercise.
2. Pass 2: the rewrite replaced the overclaim with a **referral to evidence nobody wrote** — a
   T009 catalog guard on `workspaces.kind`. T009's card enumerates R-1/R-2/R-3/R-16/R-17 only, and
   `kind` appears in `team-schema-guards.test.ts` solely inside the function name
   `on_workspace_kind_change`.
3. Pass 3: the replacement paragraph cited the **wrong requirement**. The pre-existing-row clause is
   **FR-001** ("defaulting to personal for every pre-existing row and every row created without an
   explicit choice"); FR-003 reads, in full, "A personal workspace's behaviour MUST be unchanged in
   every respect listed under *Personal must not regress*" and has no such clause.

The paragraph now standing makes the honest claim: `add column if not exists kind text not null
default 'personal'` (`contracts/policies.sql:24`) is a **fast default** on PG 11+, and
`supabase/config.toml:41` pins this stack at PG 17 — so a pre-existing row and a freshly-inserted
row read `'personal'` from the same column default, and there is no separate backfill step that
could get it wrong. `data-model.md:25` states the same doctrine independently. The case is named
for what it does (`a row inserted without naming kind reads personal (FR-001 default)`), because the
**name** is what lands in a receipt's test output, not the comment underneath it.

Advisories applied before the commit: the `notes.kind` (`'folder'|'file'`) disambiguation at both
sites where it could be mistaken for this feature's `workspaces.kind`; five redundant
`expect(...).not.toBeNull()` deletions, each verified to leave an exact-code assertion on the same
`error` object; an explicit statement of SC-002's scope (by-identifier read exercised on
`workspaces` only, child tables by listing and by-workspace-id write); `try`/`finally` around the
first `deleteTestUser` so the second cannot be skipped; and in-block positive controls on both
by-identifier cases — A reads `wsA` back before B's empty result, and A renames `wsA` successfully
before B's update matches nothing. Without that second control, a T023 swap that broke `workspaces`
UPDATE for **everyone** would have left the case green.

One advisory was **declined with reasons, and the reasons are right**: moving the three child-row
seeds into `beforeAll` would remove a case-ordering dependency but silently drop coverage, because
those inserts go through `clientA` and assert `labelErr`/`noteErr` are null — the only place in the
file that confirms A's own write succeeds on `labels` and `notes`. A raw-`pg` `beforeAll` seed
carries no such assertion. The dependency produces a cascading red, never a silent green, so it is
not the structural trap.

**A false positive was raised twice, by two different reviewers, and is recorded so it is not
raised a third time.** Both claimed T016's card still demands a `kind` pin-back. It does not. The
card carries an explicit coordinator correction withdrawing D-6's pin; its Read list cites
`contracts/policies.sql` lines 117-122 "on the withdrawn pin" and plan **D-6′**; its done-when ends
"no assertion claims a pin-back, which does not exist (D-6′)". The stale phrase appears only
*inside* the correction sentence. The second reviewer additionally quoted a done-when clause about
`kind` immutability being "proven as *coerced*" that is not in the card at all. **D-6 is withdrawn
and D-6′ governs:** `pin_workspace_kind` and `workspaces_zz_kind_fixed` do not exist, `kind` is an
ordinary owner-writable column, and `on_workspace_kind_change` (AFTER UPDATE) draws the
consequences.

Sign-off: Andrii Tkhorenko (single-operator).

## T011 receipt — both halves of the replaced team policies (2026-09-14)

Merged as `7c4c874` from lane `wt/us3-rls` (worker commit `44dba0c`'s content; lane retained for
T012 and T013, which write the same file and are serial behind this card). Artefact:
`tests/stack/team-rls-both-halves.test.ts`, `+561/-0`, nineteen cases, committed **red on purpose**.

Red run, by the coordinator on the `supabase` CLI local stack, from the lane worktree:

```
npx vitest run --project stack tests/stack/team-rls-both-halves.test.ts
Error: team-rls-both-halves seed failed — pre-T020 structural gap (see file header):
  code=42703 message=column "kind" of relation "workspaces" does not exist
Test Files  1 failed (1)
     Tests  19 skipped (19)
```

A single-cause abort carrying the SQLSTATE and the Postgres message verbatim, with nineteen skips —
and that shape is the **fix**, not the defect. It is worth recording why, because this file is where
the taskgroup's dominant defect class was traced to its structural parent.

**A module-level variable assigned inside an `it` that throws silently unseeds every downstream
case.** The first re-verify of this file read `12 failed | 7 skipped (19)` and every one of those
numbers was a lie. The seed `it` assigned the module-level ids and then threw on the missing `kind`
column, leaving `seededRowIds` as `""`. The `42501` that followed was upstream's **ownership**
clause refusing a write into a workspace that did not exist — the right SQLSTATE for the wrong
reason — and the `22P02 invalid input syntax for type uuid: ""` was a malformed literal, not a
policy refusal. Twelve cases failing for twelve incidental reasons looked like progress and was
worth nothing.

The settled pattern, now applied across this taskgroup: **seed in `beforeAll`; rethrow carrying the
Postgres `code` and `message` verbatim; replace the seed `it` with a seed-*landed* assertion; and
tolerate exactly `42P01` in cleanup so teardown still runs.** An honest single-cause red is
preferred to many cases failing for varied incidental reasons. The seed-landed `it` that remains is
not theatre — it can fail independently of `beforeAll` on a wrong `kind`, a wrong `level`, a wrong
`user_id`, an `on conflict … do nothing` that swallowed a `members` row, or a T022
`workspaces_seed_owner` row making it three.

**The second pass's blocking finding is the one that gives this file its value.** Three of the four
tables were not discriminated in the read direction. Pasting the **write** predicate into both
halves of `labels`/`tasks`/`notes` —
`using ((auth.uid() = user_id and exists (… w.user_id = auth.uid())) or public.is_member(workspace_id))`
— left all nineteen cases green. The only behaviour that separates the correct read half from the
write half is the property `docs/validation-map.md:137-139` calls load-bearing — *reads stay loose so
a not-yet-synced workspace cannot hide your own rows* — i.e. **your own row stays readable even when
its workspace is not yours**. The file asserted that in prose and never tested it. It now records a
live row B created, and after B's removal reads that row back by id, asserting one row with
`user_id = B`. The closer worked the mutant through by hand: branch 1 fails on the workspace's
owner, branch 2 fails on `not m.deleted`, USING is false, PostgREST returns `[]`, the assertion goes
red. Under the contracted predicate branch 1 alone admits it. It is the discriminating assertion,
and it doubles as a positive control proving B's read path works at all.

The other three directions were already sharp: `workspaces` write←read at the member's refused
rename, `workspaces` read←write at the team workspace's absence from B's list, and child write←read
at C's refused insert.

Advisories applied before the commit: the header now states that the post-removal write half asserts
INSERT only, and why that is sufficient (the policy is `for all`, so UPDATE and DELETE ride the
USING already asserted immediately above); an "A can still insert" control on the post-removal write
block; an in-block existence control for SC-002, whose `not.toContain` was otherwise satisfied
vacuously if A's personal workspace never existed; a sharper SC-002 filter
(`user_id === userA && id !== teamWorkspaceId`) that survives a future second A-owned workspace; a
header note that T023's "membership branch **not** conjoined with `auth.uid() = user_id`" is
undiscriminated here and is **T013's** to catch; an `afterAll` loop that skips undefined users so a
first-`beforeAll` throw is not masked by a `TypeError`; and a correction to the header's T022
claim — T022 is a **serial-lane** prerequisite on `supabase/schema.sql`, not a behavioural one for
any assertion in this file. The own-row control was also moved onto a second, never-deleted row
after the closer observed the first was a tombstone: correct today, since no predicate or trigger
filters on `deleted`, but incidentally sensitive to any future read path that does.

**Green progression.** The seed-landed case needs **T020** only. Every other case needs T020 plus
T021's `is_member` plus **T023**'s policy block; the third-account cases already pass today for the
right reason (upstream's `and exists(… w.user_id = auth.uid())`) and must keep passing across T023.
The card's verify — red before T023, green after — is honest given T020 and T021 land first.

**Not proven by this card:** no policy behaviour is verified. The file is evidence written before
the code and stays red until T023.

Sign-off: Andrii Tkhorenko (single-operator).

## Coordinator notes — added 2026-09-14, not yet discharged

- **Branch CI has been red since T009 landed, by design, and stays red until T023 and T026.**
  `.github/workflows/ci.yml` runs `npm run test -- --run`, and `package.json`'s `"test": "vitest"`
  runs **both** vitest projects including `stack` — so every deliberately-red TG-1 file fails CI.
  That is inherent to the red-first card design and is in direct tension with the definition of
  done's "CI is green". **The gate is suspended for the duration of TG-1 and is re-armed at T027**,
  which runs the entire suite. Recorded here rather than worked around: nobody may take a green CI
  as evidence during this window, and nobody may make CI green by weakening a red-first file.
- **`tests/` is typechecked by nothing in CI.** `tsconfig.app.json` includes only `src` and
  `tsconfig.node.json` only `vite.config.ts`/`worker/index.ts`, so `npx tsc -b --noEmit` — the CI
  typecheck step — never reads a file under `tests/`. Every "typecheck is green" claim about a test
  file in this feature's receipts rests on an out-of-band invocation run by hand:
  `npx tsc --ignoreConfig --noEmit --strict --target es2022 --module esnext --moduleResolution bundler --skipLibCheck --lib es2022,dom <file>`.
  Found independently by the T017 closer (three real errors invisible to `tsc -b`) and the T011
  closer. Now carded as **T026B** `[infra]`.
- **T022's new triggers are unobserved on personal rows.** Nothing watches
  `<labels|tasks|notes>_zz_keep_creator` or `tasks_zz_assignee_member` against a `kind: personal`
  workspace. The second is the more interesting: `seed_workspace_owner` is guarded
  `if new.kind = 'team'` (`contracts/policies.sql:101-114`), so a personal workspace has no
  `members` row at all and its owner is **not** a live member of their own workspace — which means
  `tasks_zz_assignee_member` coerces every personal assignment to `null`. That is contractually
  intended and observed nowhere. Now carded as **T026A**, deliberately kept out of T015: `spec.md`
  lines 443-450's "Triggers" invariant names exactly the three upstream triggers, and T015 gates
  T020, so a case that can only go green at T022 would have muddied that gate.
- **Two spec clauses were corrected, not superseded by a test.** `spec.md` US5 acceptance 6 and
  FR-016's final sentence both said an assignment to a non-member "MUST be refused". Both are wrong:
  plan decision D-3 and `contracts/policies.sql:164-178` make `assignee_must_be_member` do
  `new.assignee := null; return new;` and never raise, because a raise inside a sync batch would
  abort the whole upsert and wedge the tasks queue. Both clauses now read "accepted with the
  assignee coerced to empty", each carrying the correction and its citation. The T014 author
  followed the contract and changed no spec — the flag was right, it was merely half the size of
  the error.
- **`add_member_by_email`'s reactivation branch is covered by no file.** The
  `do update set deleted = false` arm (`contracts/rpc.md` lines 38 and 42) fires only when a
  *removed* member is re-added. T010's acceptance-6 case adds B twice while B's row was never
  deactivated, so the conflict path takes the no-op arm. Carried forward alongside the three
  uncovered `DA404` paths already recorded above.

## T014 receipt — the assignee is cleared when a member is removed (2026-09-14)

Merged as `fa133de` from lane `wt/us5-assignee` (lane commit `faf8dca`). Artefact:
`tests/stack/assignee-clear-on-removal.test.ts`, `+490/-0`, seven cases, committed **red on
purpose**.

Red run, by the coordinator on the `supabase` CLI local stack, from the lane worktree:

```
npx vitest run --project stack tests/stack/assignee-clear-on-removal.test.ts
Test Files  1 failed (1)
     Tests  7 failed (7)
```

Seven failed, **none skipped**, every one on the same structural gap —
`column "kind" of relation "workspaces" does not exist`, raised by `insertTeamWorkspace` at
`tests/stack/assignee-clear-on-removal.test.ts:120`. Nothing fails for an incidental reason.

**The interesting part of this card is a correction of a correction, and it is worth recording in
full because the same mistake is available on every stamp assertion in this taskgroup.**

The card requires that removing a member clears the assignment with an `updated_at` that
**outranks an edit already queued on the removed member's device** — i.e. that
`clear_assignee_on_removal` stamps `greatest(updated_at, now())` and not a bare `now()`. The file's
first shape used `OLD_STAMP = '2020-01-01…'`. That is in the past, so `greatest(past, now())` and a
bare `now()` produce the **same value**: the assertion could not tell the two implementations
apart, and would have certified a defect. The coordinator added a future-stamped arm
(`FUTURE = new Date(Date.now() + 600_000)`) to discriminate.

**The closer then corrected that correction.** Under a bare `now()`, the trigger's write carries
`new.updated_at = now()`, which is **less than** `FUTURE` — so `keep_newer` returns null and
**abandons the entire row write**. The row's `updated_at` therefore stays at `FUTURE`, and the
stamp assertion passes anyway, for exactly the wrong reason. What actually goes red is that the
clear never landed: `expect(futureAfter.assignee).toBeNull()` is the **sole discriminator** between
`greatest()` and a bare `now()`, and the stamp equality is a supporting invariant that is green
under both implementations. The file now says so at the assertion, tagged `// DISCRIMINATOR:`, so
that a future maintainer reading a green stamp assertion beside it does not delete the assignee
assertion as redundant. Note the general form: **a `keep_newer`-guarded table can swallow a write
whole, which turns "the value is unchanged" from evidence of correctness into evidence of nothing.**

Two more assertions were negative with no positive control, the taskgroup's third structural trap,
and both were fixed before the commit: SC-006's `expect(count).toBe(0)` now sits beside a
`liveMemberAssigneeCount` asserted to be `1` in the same block, and the stale-write
`toHaveLength(0)` now sits beside a newer-stamped `setAssigneeDirect` asserted `toHaveLength(1)`
with `assignee` null. Without those, the case would have stayed green if the measurement counted an
empty set, or if every `tasks` write in the file were being abandoned.

Advisories applied: `liveMemberAssigneeCount`'s docstring narrowed from three claimed failure modes
to the two it actually catches (the closer showed a mis-joined `not exists` still passes at T022
given the seeded data); `tasks_zz_assignee_member` added beside `clear_assignee_on_removal` in the
green-progression table's "needs" cell for acceptances 3 and 4, since both are required by that
block's final reassignment-coercion assertion; and every stale `~NNN` line pointer in the header
table refreshed.

**Green progression.** Six cases turn green at **T022**, when `clear_assignee_on_removal` and
`tasks_zz_assignee_member` land. The **seventh** — B, the assignee, reading the assignment back
through its own client — turns green at **T023**, because it needs the widened `tasks` read half.
That seventh case exists because the card's clause "A sets B as a task's assignee and **both
accounts read it back**" was discharged by no file: T011 covers a member reading A's rows but says
nothing about the `assignee` column's value. The carve-out is recorded on both T014's and T022's
verify lines, beside `kind-switch.test.ts` cases (a) and (e), which have the same shape.

**A spec correction came out of this card, and it is the larger half of the author's flag.** The
author found that `spec.md` US5 acceptance 6 and FR-016 both said an assignment to a non-member
"MUST be refused" while `contracts/policies.sql:164-178` makes `assignee_must_be_member` do
`new.assignee := null; return new;` and never raise. The author followed the contract and changed
no spec, which was right for a `data` worker; the coordinator corrected both spec clauses to
"accepted with the assignee coerced to empty", each carrying the citation and plan decision **D-3**
— a raise inside a sync batch would abort the whole upsert and wedge the tasks queue. Landed in
`843fc69`.

**Not proven by this card:** no trigger behaviour is verified. The file is evidence written before
the code and stays red until T022.

Sign-off: Andrii Tkhorenko (single-operator).

## T018 receipt — the admin-provisioned login surface (2026-09-14)

Merged as `6f22722` from lane `wt/logins` (lane commit `ece2089`). Artefact:
`tests/stack/logins-provisioning.test.ts`, `+735/-0`, twenty cases across the card's ten blocks
(a)–(j), committed **red on purpose**.

Red run, by the coordinator on the `supabase` CLI local stack, from the lane worktree:

```
npx vitest run --project stack tests/stack/logins-provisioning.test.ts
Test Files  1 failed (1)
     Tests  20 failed (20)
```

Twenty failed, **none skipped**, each on its own structural gap: `PGRST202` for the five routines
and `is_admin`, `PGRST204` for columns that do not exist, and
`relation "public.instance_admins" does not exist` raised from `adminClient()` at
`tests/harness/accounts.ts:138`. Every case reaches the gap its own block is about.

**The 20/20 count is itself the headline finding of this card, because the first honest count was
`11 failed | 9 skipped (20)`.** Nine cases never ran, and the two causes are both instances of the
taskgroup's second structural trap — a throwing hook aborting cases that would otherwise reach
their own honest red:

1. The `beforeEach` ran `delete from public.members`, which raises `42P01` before T020 exists. A
   throwing `beforeEach` skips **every remaining case in its scope**.
2. `setAdmins()` raised `42P01` on `public.instance_admins` from two describe-level hooks,
   aborting both of those describes wholesale.

The first repair was a `42P01`-only catch at both sites. The closer then improved on it, and the
improvement is the one to carry forward: **a tolerance keyed on the SQLSTATE tolerates the right
error for the wrong relation.** Once `public.members` exists, a `members_zz_clear_assignee` trigger
raising `42P01` against some *other* not-yet-landed relation would be swallowed by the same catch,
leaving stale `members` rows that a later case reads as fixture state. Both sites now probe
`select to_regclass('public.members')` / `to_regclass('public.instance_admins')` and skip the
cleanup when the relation is absent, rather than catching an error at all. A probe cannot
misidentify what failed; a catch can.

**The closer's remaining three blocking findings were all the third structural trap** — a negative
assertion with no in-block positive control — and all three landed on `instance_admins`:

- SC-016's "the removed login's `instance_admins` row is gone" read `toHaveLength(0)` while the
  grant that was supposed to create that row was asserted only as `expect(grantErr).toBeNull()`, an
  RPC success and never a read-back. If `set_login_admin` returned void without writing, the
  length-0 read was green for an incidental reason and the "loses the admin flag too" half of R-18
  was untested. The grant is now read back as exactly one row before the removal, so the later zero
  measures a real transition.
- Block (g)'s DA015 case, same shape twice over: `setAdmins(a, b)` was never read back, so the case
  passed if the insert loop had never run and `a` was never admin; and it asserted only `a`'s
  absence, so `set_login_admin` revoking **both** admins — a direct DA015 violation — went
  unnoticed. Both halves are now asserted.
- Sign-in refusal was `expect(err).not.toBeNull()` at two sites, including the SC-016/R-18 ban
  assertion. That accepts a rate-limit, a transport error or an unconfirmed-email state as evidence
  of a ban. **This file performs about twenty sign-ins against one local GoTrue**, so the
  rate-limit path is not hypothetical. Both now assert `error?.status === 400`, with a comment
  naming `invalid_credentials` as the tighter assertion to adopt once the code field is observed
  against a running stack. The ban is separately corroborated by reading `banned_until` — which the
  card permits *in addition* to the observable assertions, and forbids only as a substitute for
  them.

**FR-044 was raised blocking and the coordinator demoted it to advisory, applied anyway.** The
closer found fifteen literal password strings and read the fork's rule as "generated, not literal".
FR-044's actual text (`spec.md:755-757`) governs client-side storage and display surfaces — "A
password MUST NOT be stored or logged client-side beyond the form field being typed into… no
surface, anywhere, that displays an existing login's password" — and says nothing about test
fixtures; T018's own done-when asks only that no password be a real credential and none reach this
file. The throwaways passed both bars. The `randomUUID()`-based `throwawayPassword()` helper was
applied regardless, because it costs nothing and removes a question that would otherwise be
re-litigated by every future reviewer. The precedent is `tests/harness/accounts.ts:39`. No
`service_role` literal appears anywhere in the diff — the file reaches it only through
`adminClient()` / `createTestUsers` — so FR-033/SC-020 is clean.

**What makes this file hard to fool.** Every refusal is an exact `DA0xx` string match; **no
structural code is accepted as a refusal anywhere in the file**, so a missing routine can never
masquerade as a working guard. The `PGRST202`s it produces today are failures, not passes. The
closer verified all eight RPC call sites against `contracts/rpc.md` argument-name by
argument-name, which matters because a signature typo would produce a `PGRST202` that stays red
**forever** and reads exactly like an unlanded card. Case (c)'s R-15 canary builds a fresh
`createClient` with `persistSession: false, autoRefreshToken: false` per call, so no harness session
can satisfy it, and it gates on `signInError` being null before comparing ids, so the
`undefined === undefined` vacuity is unreachable. Case (i)'s concurrency assertion pins exactly one
success and exactly one failure with `error.code === 'DA012'`, so an unmapped `23505` surfaces as
`'23505'` and fails — the case genuinely discriminates the `23505 → DA012` mapping annotated onto
T026.

**Green progression.** Nineteen cases turn green at **T026**. Block **(j)** — `is_admin()` called
directly, added by the coordinator to discharge T008's deferred verify half rather than leave it
inferred from five `DA001` refusals — turns green at **T025**, and is the only case green before
T026. Block (f)'s ban case additionally needs T020 (`members`, `kind`, `assignee`), T021–T023 (the
member write policy and `members_zz_clear_assignee`) and **T024** (`add_member_by_email`), because
it removes a login that owns rows inside a team workspace. The card's verify line — "red before the
schema cards for a named reason, green after T026" — is honest, and does not mislead by omitting
(j)'s earlier green.

**Recorded coverage residue, asserted nowhere:** `DA404` (no such login) is in the error-code
register for `set_login_password`, `delete_login` and `set_login_admin` and is exercised by no case.
Card T018's (a)–(j) does not ask for it, so this is not a done-when failure; it is carried forward
beside `add_member_by_email`'s reactivation branch.

The `account-provisioning` map entry is updated in the same change set: `tests:` now names this
file, and its `verify` records that the evidence exists but is red by design until T025 and T026.
Status stays **UNTESTED** — a red file is not a validation.

**Not proven by this card:** no provisioning behaviour is verified. The file is evidence written
before the code and stays red until T026.

Sign-off: Andrii Tkhorenko (single-operator).

## T026B receipt — `tests/` is typechecked in CI (2026-09-14)

Merged as `c463d65` from lane `wt/tsconfig-tests` (lane commit `fbc0f26`). Artefacts:
`tsconfig.test.json` (new, 23 lines) and one line added to `tsconfig.json`'s `references`.

**The gap.** `tsconfig.app.json` includes only `src`, `tsconfig.node.json` only `vite.config.ts`
and `worker/index.ts`. CI's typecheck step (`.github/workflows/ci.yml:36`) runs
`npx tsc -b --noEmit` against the root solution file, which referenced only those two — so it had
never read a single file under `tests/`. Every "typecheck is green" statement about a test file in
this feature's receipts rested on an out-of-band invocation run by hand:
`npx tsc --ignoreConfig --noEmit --strict --target es2022 --module esnext --moduleResolution bundler --skipLibCheck --lib es2022,dom <file>`.
Found independently by the T017 closer and the T011 closer.

**Verify, run by the coordinator on the branch tip, both halves:**

```
npx tsc -b --noEmit --force        -> exit 0, no output
```

and, with `const coordinatorProbe: number = "not a number"` appended to a real stack test file
(`tests/stack/team-triggers.test.ts`, not a fixture):

```
tests/stack/team-triggers.test.ts(432,7): error TS6133: 'coordinatorProbe' is declared but its value is never read.
tests/stack/team-triggers.test.ts(432,34): error TS2304: Cannot find name '...'
tsc exit code with a broken test file: 2
tsc exit code on the clean tree: 0
```

The exit code is the half that matters and is checked separately: `tsc -b` printing errors while
exiting 0 would leave CI green and the card undone. It exits **2**, so CI fails. The probe was
reverted and `git status --porcelain` confirmed clean before the commit.

**The design decision worth recording.** The worker first tried `composite: true` +
`emitDeclarationOnly`, the ordinary shape for a `references` target. `tsc -b` then demanded that
`tsconfig.app.json` itself become composite (TS6306/TS6310) — which changes how `src/` is compiled
and is precisely what this card's done-when forbids. The config is therefore a **non-composite
leaf**, referenced only from the root solution file, matching what `tsconfig.app.json` and
`tsconfig.node.json` already are (neither is composite either). A non-composite project may pull
`src/**` in transitively as plain program inputs, which is what the tests need in order to
typecheck their imports at all.

Options are copied from the two existing configs rather than from a template, so `tests/` is held
to the same strictness as `src/` — including `noUnusedLocals`, `noUnusedParameters`,
`verbatimModuleSyntax` and `erasableSyntaxOnly`, all of which the hand invocation above did **not**
apply. `types` is `["node", "vite/client"]`; `"vitest/globals"` was deliberately not added, because
`vitest.config.ts` never sets `test.globals` and every test imports `describe`/`it`/`expect`
explicitly. `tsBuildInfoFile` points into `node_modules/.tmp/`, where the other two already write,
so nothing untracked appears in the tree.

**The card's premise turned out to be already discharged, and that is itself the finding.** The new
coverage surfaced **zero** errors on the tree as it stands, re-confirmed with `--force` after
deleting the build-info directory to rule out stale incremental state. The three real errors the
card attributes to the T017 closer were found by that closer's own out-of-band run and fixed before
`47d20aa` landed. So this card did not clean up a backlog; it removed the **need for the coordinator
to run a typecheck by hand on every future test file**, which is the thing that was actually
fragile. Nothing enforced that habit, and a single forgotten invocation would have put an untypechecked
test file into the tree with CI reporting green.

`.github/workflows/ci.yml` needed no change: its typecheck step already invokes
`npx tsc -b --noEmit` against the root `tsconfig.json`, which now carries the third reference.
Confirmed by the broken-file demonstration, which used that exact command.

**Note on the `env-boot` map entry.** It is not re-signed here. This card changes what CI checks,
not what the toolchain does: no `src/` compilation option changed, `tsconfig.app.json` is untouched,
and `npm run build` produces the same output. Its `paths` do not include `tsconfig.test.json`, so no
map discipline rule is triggered. T052 re-verifies and re-signs it at the end of the feature.

**CI standing, restated here because this card touches CI.** The typecheck step is now stricter and
green. The **test** step remains red by design and stays red until T023 and T026 — see the
coordinator note above on the suspended gate.

Sign-off: Andrii Tkhorenko (single-operator).

## T012 receipt — the executed inversion demonstration (2026-09-14)

Merged as `3ac4a69` from lane `wt/us3-rls` (lane commit `5af7116`). Artefact: eight new cases in
`tests/stack/team-rls-both-halves.test.ts`, `+564/-7`, taking the file from 19 cases to **27**.

**The executed path was taken. There is no deviation to record, and P0's fallback was not used.**
That is the headline: P0's equivalent card (T021, `specs/001-validation-spine/receipts.md`) had to
fall back to a hand-trace because the session's tool-safety layer refused a live DDL swap. Plan
decision D-13 anticipated exactly this and removed the objection by making the swap **never leave a
transaction**; this session ran it directly, confirming D-13's reasoning in practice rather than on
paper.

Verify, run by the coordinator on the `supabase` CLI local stack, from the lane worktree:

```
npx vitest run --project stack tests/stack/team-rls-both-halves.test.ts
Error: team-rls-both-halves seed failed — pre-T020 structural gap (see file header):
  code=42703 message=column "kind" of relation "workspaces" does not exist
Test Files  1 failed (1)
     Tests  27 skipped (27)
```

A single-cause abort carrying the SQLSTATE and the Postgres message verbatim — the shape T011's
receipt records as the fix, not the defect.

**The second half of the card's verify, which is the one that matters here**, was run immediately
after: a `pg_policies` dump over `workspaces`, `labels`, `tasks` and `notes` — `schemaname`,
`tablename`, `policyname`, `permissive`, `roles`, `cmd`, `qual`, `with_check`, ordered by table,
policy and command — taken **before** and **after** the run and diffed.

```
PG_POLICIES IDENTICAL
```

Nothing was committed. This check is not ceremony: the demonstration's mechanism is
`drop policy own_rows on public.<t>` followed by `create policy` with one half negated, and a leak
would leave row-level security **disarmed** for every later file in the run — the worst possible
failure in this repo. The rollback is in a `finally`, so a thrown assertion cannot skip it, and the
diff above is the evidence that it holds.

### The eight demonstrations

Four on `tasks` and four on `workspaces`: read half and write half, each on a personal and on a team
workspace. Each opens its own `pg` client and one transaction, reads the **live** predicate out of
`pg_policies`, records the baseline outcome, reinstalls `own_rows` with one half negated, asserts
the outcome flips, and rolls back. Every case asserts the **flip** — `expect(mutated).not.toBe(baseline)`
— rather than merely asserting the mutated outcome, which would prove nothing about the real
policy; and every zero or refusal has an in-block positive control from a sibling caller in the same
demonstration.

Three design choices, all recorded in the block's header comment so they read as decisions rather
than oversights:

1. **The predicate is introspected from `pg_policies`, never retyped from `contracts/policies.sql`.**
   So the demonstration inverts whatever is actually deployed when it runs — upstream's ownership
   clause today, T023's membership predicate later — instead of a hardcoded guess at what T023 will
   land verbatim. A retyped predicate would drift from the deployed one and quietly demonstrate the
   wrong thing.
2. **Negation, not equalization, and uniformly.** Equalizing the `tasks` read half to its write half
   is a **no-op on a personal workspace**: `is_member` is always false there, and the ownership
   `exists(...)` clause is tautologically true whenever the read half already admits the caller. An
   "equalize" demonstration on personal would have flipped nothing while appearing to test
   something — the precise failure this card exists to rule out. Negation flips deterministically in
   all eight.
3. **`tasks` and `workspaces`, not `labels` and `notes`.** FR-013 (`spec.md:608-613`) is the
   authoritative half of the pair and names no table at all; SC-005 (`spec.md:878-880`) says
   "either half of **either table's** access rule". `tasks` alone discharges FR-013 and the card's
   own text, but one table is not "either table", so the coordinator sent the card back to add
   `workspaces` — whose read half is the one that widens with `public.is_member(id)` at T023, and
   is therefore where a dead membership branch would hide. `labels` and `notes` carry the same
   predicate shape as `tasks`; two more copies would cover nothing and make the block harder to
   read.

**One asymmetry is deliberate and is labelled as such**, because it looks like a mistake. The two
`workspaces` write-half cases flip a different number of callers on the two kinds: the owner alone
on personal, the owner **and** the member on team. `workspaces` carries no related-row `exists()`
clause, so on a personal workspace a stranger is excluded by `USING` alone and can never reach
`WITH CHECK` no matter how it is mutated. Without the note, a later reviewer would read the personal
case as an incomplete copy of the team one and "fix" it.

That same asymmetry forced a new helper. `tryUpdateAsClaim` is distinct from the existing
INSERT-only `tryWriteAsClaim` because an UPDATE's "refused" is two different outcomes that must not
be conflated: **matched nothing** (`USING` failed — `rowCount: 0`, no exception) versus **matched
but rejected** (`WITH CHECK` failed — a real `42501`). The exception-or-nothing shape of the INSERT
helper cannot tell them apart, and this demonstration depends on the distinction.

**Green progression.** All eight join the file's existing red population: they need T020, T021 and
T023, like the rest of the file.

**A fixture-ordering finding, recorded and deliberately not acted on.** Even a personal-only
demonstration cannot run green before T020, and not for any reason intrinsic to the technique: the
file's single top-level `beforeAll` seeds the **team** workspace insert first, so the `42703` aborts
the hook before `aPersonalWorkspaceId` is ever created. The personal-workspace logic itself needs
only `pg_policies` introspection and an ordinary task row. The worker was instructed not to
restructure `beforeAll`, and did not. Recorded here because it means this file's evidence is
available only after T020 in its entirety — there is no earlier partial green to be had from it.

**Not proven by this card:** no policy behaviour is verified. The file is evidence written before
the code and stays red until T023.

Sign-off: Andrii Tkhorenko (single-operator).

## T013 receipt — `user_id` keeps meaning who created the row (2026-09-14)

Merged as `131fe13` from lane `wt/us3-rls` (lane commit `2f56f16`). Artefact: three new cases in
`tests/stack/team-rls-both-halves.test.ts`, `+87/-10`, taking the file from 27 cases to **30**.
This closes taskgroup TG-1.

Verify, run by the coordinator on the `supabase` CLI local stack, from the lane worktree:

```
npx vitest run --project stack tests/stack/team-rls-both-halves.test.ts
Test Files  1 failed (1)
     Tests  30 skipped (30)
```

The same single-cause `beforeAll` abort the file has carried since T011 —
`code=42703 message=column "kind" of relation "workspaces" does not exist`.

**This card's done-when is unusual and worth stating precisely: not "an assertion about `user_id`
exists" but "an assertion that goes red if `<t>_zz_keep_creator` is dropped".** R-7 is a risk whose
failure mode has **no visible symptom**. Drop the trigger and the edit still lands, sync still
succeeds, the board still renders; the only damage is that `user_id` silently stops meaning "who
created this row" and starts meaning "who touched it last". Nothing anywhere complains. A case that
merely reads `user_id` back and finds A's id can be green for three separate incidental reasons —
the write was refused, the write was cancelled by `keep_newer`, or the payload never carried a
different `user_id` in the first place.

**The hand-trace, which is this card's real product.** `src/sync/sync.ts:216` stamps `user_id` to
the **pushing client's own id** on every push, member or not — so the client genuinely sends B's id,
and that is precisely why the trigger has to exist. B's edit in these cases mirrors that payload
exactly: `{ [editField]: …, user_id: userB.user.id, updated_at: <newer stamp> }`.

- **With the trigger:** `keep_creator()` is a BEFORE UPDATE trigger, and Postgres evaluates
  `WITH CHECK` against the row **after** BEFORE ROW triggers have run. It resets
  `new.user_id := old.user_id` (A) before the check is ever applied.
- **Without it:** nothing resets the field, so `new.user_id` stays **B**, exactly as sent. The write
  still succeeds, because `public.is_member(workspace_id)` alone satisfies `WITH CHECK` for B
  regardless of what `user_id` holds. The PostgREST response is identical in both worlds.
- **What goes red:** only the direct-`pg` read-back, `expect(rows[0].user_id).toBe(userA.user.id)`,
  which now sees B's id. Identically on all three tables — `keep_creator` and the predicate shape
  are the same across `labels`, `tasks` and `notes` (`contracts/policies.sql:212-228`).

The response being identical in both worlds is exactly why the assertion is taken **server-side over
the harness's direct `pg` connection**, not through PostgREST.

**Both traps this taskgroup keeps hitting are closed in the same three cases.** Each asserts the
edited field holds B's new value **and** that `user_id` is still A's. Without the first half, a T023
regression that refused B's writes outright would leave an untouched row and a trivially green
assertion — the negative-assertion-without-a-positive-control trap, in the one place where it would
have been hardest to notice. And the edit's stamp is derived from the row's own `updated_at` plus
sixty seconds, read back first, never from the host clock: a host-stamped write under a container
clock that leads the host — routine on Docker Desktop / WSL2 — would be silently cancelled by
`keep_newer` with a 204 and `error === null`, leaving `user_id` unchanged and the case green for the
worst possible reason.

**An unplanned discrimination, worth recording because it closes something the file's own header
admitted was open.** Because B's payload self-assigns `user_id = B` and the trigger then resets it
to A, `auth.uid()` (B) and the post-trigger `user_id` (A) **genuinely diverge** — a row shape the
file's insert-only cases can never produce, since an insert always has `new.user_id` equal to the
inserter's own id. That divergence also discriminates a **wrongly conjoined** membership branch in
T023's write half (`and` where `contracts/policies.sql` has `or`), which T011's receipt recorded as
undetected by that card and assigned here. The file's header is updated to say so. T011's receipt
predicted this would be T013's to catch; it is, and now it is.

**Green progression.** All three need **T022 and T023 together**. T022 alone leaves B's write
refused outright, since the membership branch of the write half does not exist yet; T023 alone
leaves the trigger absent, so `user_id` drifts to B and the case fails on its own assertion. Neither
card can green them by itself, and that is the correct dependency — the trigger and the widened
predicate are two halves of one behaviour.

**Declined, with the reason recorded:** no `workspaces` counterpart. `keep_creator` is defined on
`labels`, `tasks` and `notes` only (`contracts/policies.sql:212-228`), and `workspaces.user_id` is
the workspace **owner**, not a per-row creator — a different concept that no trigger touches. A
fourth case would assert something outside both the card's and the trigger's scope.

**Not proven by this card:** no trigger behaviour is verified. The file is evidence written before
the code and stays red until T023.

Sign-off: Andrii Tkhorenko (single-operator).

## Coordinator note — TG-1 closed (2026-09-14)

Every card in taskgroup TG-1 has landed: T007, T008, T009, T010, T011, T012, T013, T014, T015,
T016, T017, T018, T019, plus T026B. The evidence spine for this feature now exists in full and is
**entirely red**, by design, with every file's green-at card named in its own header and in its
receipt above.

The files, and the card each becomes green at:

| file | cases | green at |
|---|---|---|
| `tests/stack/team-schema-guards.test.ts` | T009 | T020–T026 |
| `tests/stack/members-two-accounts.test.ts` | 10 | T024 (T023 for the removal cases) |
| `tests/stack/team-rls-both-halves.test.ts` | 30 | T023 (T013's three also need T022) |
| `tests/stack/team-triggers.test.ts` | 7 | T020, except R-6 at T023 |
| `tests/stack/personal-unchanged.test.ts` | 13 | T020 — and T023 must keep all thirteen green |
| `tests/stack/assignee-clear-on-removal.test.ts` | 7 | T022, except the seventh at T023 |
| `tests/stack/kind-switch.test.ts` | T017 | T022, except (a) and (e) at T023 |
| `tests/stack/logins-provisioning.test.ts` | 20 | T026, except (j) at T025 |

Two cards remain outside that table and are **not** yet written: **T026A**, the personal-side smoke
for T022's new triggers, and **T027**, the P0-unedited gate.

TG-2 opens next: T020 through T026 are strictly serial on `supabase/schema.sql` and must not be
lanewise-parallelised. The first of them, T020, is the card that turns the largest number of the
above from red to green in one step, and is therefore the first point in this feature where a real
verify means anything.

## T026A receipt — the personal-side smoke for T022's own new triggers (2026-09-14)

Merged as `e38d672` from lane `wt/personal-triggers` (lane commit `9f7cc82`). Artefact:
`tests/stack/personal-triggers-after-t022.test.ts`, `+377/-0`, five cases across the card's three
blocks (a)–(c), committed **red on purpose**.

**This card was authored ahead of its nominal `blocked-by: T022`**, under the coordinator reordering
recorded in `tasks.md` (`f938cbc`): for an evidence card, `blocked-by` names the card that turns the
file **green**, not the card that permits it to be **written**. Every one of TG-1's thirteen evidence
cards was authored the same way.

Red run, by the coordinator on the `supabase` CLI local stack, from the lane worktree:

```
npx vitest run --project stack tests/stack/personal-triggers-after-t022.test.ts
Test Files  1 failed (1)
     Tests  5 failed (5)
```

Five failed, **none skipped** — each case reaches the gap its own block is about.

**The finding worth recording is that this file is red in two different ways at once**, and the
distinction is load-bearing enough that the header now names it:

- **(b) and (c) are red structurally**, on `PGRST204 Could not find the 'kind' column of 'workspaces'
  in the schema cache` — the fixture cannot create a `kind`-bearing workspace before T020.
- **(a)'s three cases are red behaviourally**, on a genuine `42501 new row violates row-level
  security policy`. Case (a) names neither `kind` nor `assignee` nor `members`, so it cannot be
  reached by a structural miss at all. It runs against real RLS today and fails because
  `<t>_zz_keep_creator` does not exist yet.

**The mechanism behind (a)'s 42501, verified against source rather than inferred.** Upstream's child
write half is `supabase/schema.sql:249-253`; the read half is `using (auth.uid() = user_id)` at
`:248`. The UPDATE matches on the **old** row (`user_id = owner`), so `using` passes and the row is
scanned — a `using` miss would give zero rows and `error === null`, not `42501`. The payload then
sets `user_id = impostor` and `with check` fails on the new row. The message PostgREST returns,
**"new row violates row-level security policy"**, is the `WITH CHECK` message specifically; a `USING`
failure never produces it. At T022, `keep_creator` (BEFORE UPDATE) sets `new.user_id := old.user_id`
before the check is applied — Postgres evaluates `WITH CHECK` against the row **after** BEFORE ROW
triggers run — so the check passes against the owner's own id and the update lands.

**The worker built a stronger case than the card asked for, and the closer accepted it.** The card
asks that an ordinary owner update leave `user_id` unchanged, i.e. that `keep_creator` is a *no-op*
on personal. The file instead has the owner update their own row while naming an **impostor's real
user id** in the payload, so `keep_creator` is emphatically *not* a no-op — it rewrites the impostor's
id back to the creator's. That discharges the card a fortiori: `keep_creator` writes
`new.user_id := old.user_id` unconditionally (`contracts/policies.sql:212-217`), so the ordinary
payload is the same assignment with the same value producing the same post-trigger row, and the
"ordinary update still lands" half is separately held green by P0's `lww-conflict.test.ts` and
`offline-round-trip.test.ts`, which do ordinary owner updates on personal tasks and are gated
unedited by T027. The header now states that inference explicitly rather than leaving a reader to
conclude the ordinary case was forgotten.

**One blocking finding, and it was a miscitation — the failure mode this feature keeps paying for.**
The header claimed the personal-path `with check` is "upstream's own_rows text, byte identical before
and after T023 (`contracts/policies.sql:243-246`)". Two errors in one sentence. `:243-246` is the
**`workspaces`** policy, while case (a) — the only case whose T023-independence is genuinely in
question — writes `labels`, `tasks` and `notes`, whose replaced policy is `:250-263` with the write
half at `:256-263`. And for those tables the clause is **not** byte-identical: T023 writes
`((auth.uid() = user_id and exists (...)) or public.is_member(workspace_id))`, of which only the
first branch (`:257-261`) is upstream's text character for character.

The conclusion survived, and the corrected header states it the right way round: on a
`kind: 'personal'` workspace `public.is_member(workspace_id)` is false, because `is_member` requires a
live `members` row and a personal workspace seeds none — **which is case (c)'s own direct
assertion** — so the disjunction collapses to the first branch and case (a)'s personal path is
identical to pre-T023 **in effect**, not in text. That is a materially different claim from the one
the header made, and it is the claim the done-when actually needs.

**The done-when's T023-independence clause holds for all five cases**, checked one at a time against
the policy text: (a) writes child rows as the owner, taking the first branch only, and never reads
`members`; (b)'s `INSERT` evaluates `WITH CHECK` only, owner branch, personal — and
`tasks_zz_assignee_member` (`contracts/policies.sql:164-178`) reads `members` as `security definer`,
never through a policy; (c) reads `public.members` over raw `pg` on both halves, so `members_access`
(T023, `:271-275`) is never in the path, and `seed_workspace_owner` (`:101-114`) is likewise
`security definer`.

**Green-at attribution, checked rather than assumed:** **T022**, with T020 as a prerequisite for (b)
and (c)'s fixtures. `keep_creator` and its three `_zz_` triggers are created in fork block C
(`contracts/policies.sql:212-228`), and T022's card lists `<labels|tasks|notes>_zz_keep_creator` in
its own deliverable. T023 creates no trigger at all.

**`keep_newer` cannot silently swallow case (a)'s write**, which is the standing trap for every
update in this feature. The stamp is `seeded.updated_at + 60_000`, where `seeded.updated_at` comes
from the insert's own `.select('updated_at')` — Postgres-written, never the host clock, so a
container clock leading the host under Docker Desktop / WSL2 cannot cancel the write and leave
`user_id` trivially unchanged. `keep_newer` compares strict `<`, so +60s strictly outranks, and
`Date` parsing of PostgREST's `…+00:00` truncates by at most a microsecond, which 60s absorbs.
Trigger firing order is safe by name: `keep_newer` < `stay_deleted` < `synced_at` < `zz_keep_creator`
(`supabase/schema.sql:193-212`, `data-model.md:195-200`). And the in-block positive control would
catch a swallowed update regardless — every case (a) asserts the edited field equals the new value
**as well as** asserting `user_id`, so a refused or cancelled write cannot read as a green.

**No structural code is accepted as a refusal anywhere in the file.** Every error is asserted null,
with the SQLSTATE and message interpolated into the assertion label; there is no code allow-list, no
`try`/`catch` swallow, and no assertion that treats any error as evidence of a guard working. The
`PGRST204`s it produces today are failures, not passes. The file's one tolerance is the cleanup probe
`select to_regclass('public.members')`, guarding teardown only, inside a `try`/`finally` — the probe
form the T018 closer asked for, not a SQLSTATE-keyed catch that would tolerate the right error for
the wrong relation.

**Each negative assertion has an in-block positive control, as the done-when requires.** (b) asserts
the task row came back with its correct title over supabase-js **and** re-reads the same row over an
independent raw `pg` path, so a missing row cannot masquerade as a null assignee. (c) pairs the
personal workspace's zero `members` rows with a **team** workspace created in the same case, asserted
to have exactly one owner row (`member_id`, `level: 'owner'`, `deleted: false`) through the identical
query shape — so the zero and the one are measured the same way, and a broken query, an unwritten
fixture or a globally empty table cannot all read as a pass.

**Duplication check: clean, and the card's "nothing else observes" premise holds.** `team-triggers.test.ts`
(T015) covers only `keep_newer` / `stay_deleted_with_workspace` / `follow_workspace_delete` and never
mentions `keep_creator`, `assignee` or `members`. `personal-unchanged.test.ts` (T016) covers the
`own_rows` predicate, the `kind` default and constraint, and the delete cascade; its only child-table
writes are inserts and a stranger's refused update, and it never updates a child row as the owner nor
asserts `user_id`. T013's R-7 cases in `team-rls-both-halves.test.ts` assert `keep_creator` on the
**team** side.

Four advisories were applied alongside the blocking fix: the ordinary-update inference stated in the
header; the timestamp paragraph's vacuous half deleted (the file makes zero stamp comparisons, so a
claim about how they are compared was noise); case (b)'s "contractually intended, not a defect"
note raised from the describe block into the header, citing `plan.md:255-266` (D-3, "coercing, not
raising"); and truthiness guards at all three `afterAll` teardown sites, so a `createTestUser` throw
in `beforeAll` cannot add a `TypeError` beside the real error.

The impostor account is clean: `createTestUser` emails carry label + `Date.now()` + pid + sequence,
the password is `crypto.randomUUID()` (`tests/harness/accounts.ts:39`), it never signs in, and it is
torn down in the `finally` with the `auth.users` cascade as a backstop. No credential, key, token or
`service_role` literal appears in the diff — FR-044, FR-033 and SC-020 are clean.

**Not proven by this card:** no trigger behaviour is verified. The file is evidence written before the
code and stays red until T022. No map entry is flipped — a red file is not a validation.

Sign-off: Andrii Tkhorenko (single-operator).

## T030 receipt — growing reach is not an account switch (2026-09-14)

Merged as `5754c0c` from lane `wt/nowipe` (lane commit `3361aa2`). Artefact:
`tests/local/no-wipe-on-reach-growth.test.ts`, `+389/-0`, three cases in the Docker-free `local`
tier. **Authored ahead of its nominal `blocked-by: T028`**, under the coordinator reordering recorded
in `tasks.md` (`f938cbc`).

Verify, run by the coordinator over the whole `local` project — no stack, no Docker:

```
npx vitest run --project local
 ✓  local  tests/local/claim-cache.test.ts (5 tests)
 ❯  local  tests/local/no-wipe-on-reach-growth.test.ts (3 tests | 1 failed)
   × Dexie v2 -> v3 upgrade keeps every row and every cursor (R-9) > turns green at T029 …
     → expected false to be true
   ✓ … re-claiming as the same account, after its reach has grown, wipes nothing
   ✓ … claiming as a different account still wipes everything, reach or no reach
 ✓  local  tests/local/db-api-p1-surface.test.ts (22 tests)
 Test Files  1 failed | 2 passed (3)
      Tests  1 failed | 29 passed (30)
```

**This file is deliberately two-thirds green on the day it lands, which is unusual in this feature and
worth stating rather than leaving a reader to wonder.** `claimCache` and `wipeLocal` are code this
feature does **not** change (D-10), so the two cases that exercise them are regression guards from the
moment they exist — they pin today's correct behaviour against T029's rework of `src/db/local.ts`.
Only the upgrade case is red, on `expect(db.tables.some((t) => t.name === 'members')).toBe(true)`,
because `src/db/local.ts` declares no `version(3)` yet. The test title carries "turns green at T029"
so a reader hitting the failure knows immediately it is expected.

**The concern the coordinator put to the closer, and the receipt that settles it.** A v2→v3 upgrade
test that runs against a database nobody upgraded asserts nothing, and it would keep asserting nothing
forever without anyone noticing. The closer reproduced the post-T029 topology under `fake-indexeddb`
— a v2-shaped seed handle, then a `version(1)/version(2)/version(3)` Dexie opened over it:

```
seed idb version = 20   verno = 2
after open: verno = 3   idb = 30
v2 upgrade ran? false    v3 upgrade ran? true
members table present? true
workspaces count = 1   tasks = 1
backfilled ws.kind = personal   backfilled task.assignee = null
meta owner = user-aaaaaaaa
```

The seed pins IDB version 20 via `V2_STORES`, byte-identical to `src/db/local.ts:32-38`; T029's
`version(3)` becomes IDB 30; Dexie runs the v3 upgrader and correctly does **not** re-run v2's
calendar backfill. `seed.close()` releases the connection so nothing blocks the version change. Case
1 therefore becomes a genuine upgrade test at T029 **automatically**, with no intervention. No
silent-vacuity trap.

**One blocking finding, and it would have broken the build.** The header claimed "once T029 lands,
this same file is unchanged and the same seed exercises a real v2→v3 upgrade". False in a way that
stops the tree compiling: **T028** (`tasks.md:306`) makes `Workspace.kind` and `Task.assignee`
**required, non-optional**, and cases 2 and 3 build rows through the typed `EntityTable` path with
neither field. The closer confirmed with an isolated `tsc` probe against this worktree's Dexie:

```
error TS2345: Argument of type '{ id: string; name: string; _dirty: 0; }' is not assignable
  to parameter of type 'InsertType<Local<W>, "id">'.
  Property 'kind' is missing in type '…' but required in type 'Omit<Local<W>, "id">'.
```

The untyped raw-handle path case 1's seed uses (`seed.table('workspaces').add(…)`) does **not**
reject the omission — correct and necessary, since a v2-shaped row has no `kind` at all, but true by
construction rather than by stated design. The header now scopes the "unchanged" claim to case 1's
seed, says cases 2 and 3 **must** gain the two fields when T028 lands, and says case 1's seed must
**not**, plainly enough that nobody later "fixes" it by aligning the seed with production. It also
carries the forward note that `ws-team-newly-reached` takes `kind: 'team'` at that edit while
`ws-a-own` keeps `kind: 'personal'` — today the two differ only by a `name` string, so the second is a
team workspace in prose only.

**One advisory was taken beyond the card's done-when, deliberately.** `expect(db.verno)
.toBeGreaterThan(2)` and backfill assertions on the pre-existing rows (`ws-legacy`'s `kind` is
`'personal'`, `task-legacy-1`'s `assignee` is null) were added **after** the `members` assertion, so
today's recorded red is unchanged. Two reasons. First, R-9 (`plan.md:1260-1261`) requires v3 to
"backfill two fields" and **no file in this feature asserted that** — this closes a real gap for free.
Second, and the reason it is not merely nice to have: the T028 edit forced by the blocking finding is
exactly the moment someone will be editing this file, and "aligning" the seed with production would
silently revert case 1 to the no-upgrade state. `db.verno > 2` makes that revert loud.

**A vacuous assertion was found and repaired rather than deleted.** Case 3 asserted
`expect(await db.tasks.count()).toBe(0)` after the wipe, but the case seeded only workspaces — zero
against a table that was already zero, the one assertion in the file with no positive-control
sibling. A task row was added to the seed and a `toBe(1)` control placed beside the existing
workspace control, so the later zero measures a real transition. The alternative, dropping the
assertion, would have left `claim-cache.test.ts` as the only place a wiped task is observed.

**Reach growth is modelled correctly, which is this card's centre of gravity.** The second workspace
is added *after* the first claim, not seeded up front, and the pull cursor is advanced with it — so
"reach grew" is rows **plus** a cursor advance, which is what a real pull does, rather than merely
"there are more rows now". The abstraction is justified in the header against D-10's "team mode
changes what one account can reach, not how many accounts a device holds". A version of this case
with A's reach unchanged would have proved only the boring half.

**Positive controls, one per case.** Cases 2 and 3 take theirs through the same `db` handle with the
same `count()` / `getMeta()` query shapes as the assertions they control, immediately before the act.
Case 1's control necessarily reads through the `seed` handle rather than `db` — the different-handle
shape normally worth flagging — but here reading through `db` before `db.open()` *is* the act under
test, so the seed handle is the only control available; it proves the seed landed, which is the
failure mode that matters, since a silent no-op seed would otherwise leave `count()).toBe(1)` tested
against nothing.

**Duplication, recorded honestly:** case 3 is substantially `claim-cache.test.ts`'s acceptances 2 and
3 merged with a second workspace row added. The card explicitly demands the B-claim half so it is not
redundant, but its incremental value over P0 is small, and **case 2 is where this file's genuine new
evidence lives**.

**Carried forward, belonging to T029 and not fixable here:** once T028 puts `members` in
`SYNCED_TABLES`, `tests/setup.ts` still clears only five tables, so `members` rows will leak between
tests repo-wide; and `data-model.md §5`'s requirement that `wipeLocal()` grow its table list to
include `members` is asserted by nothing, which case 3 cannot yet do.

SC-012's text was read directly (`spec.md:895-897`) rather than taken from the card's paraphrase:
"wipes its cache exactly **once per switch** and **0** times when the same account signs in again,
including when that account's reach has grown by a new membership." Both directions are asserted.
R-9's obligation (`plan.md:1260-1264`) is row counts and cursor values, which case 1 covers, plus the
backfill, which it now also covers.

No source file moved — `git diff --stat` empty, `src/db/local.ts` untouched and T029's territory
intact. No credential, key, token or `service_role` literal; the two account labels are byte-identical
to `claim-cache.test.ts`'s own.

The `multi-account-cache` map entry is **not** created or flipped here — a file that is two-thirds
green against unchanged code and one-third red against unlanded code is not a validation. T039 and
T051 own that.

**Not proven by this card:** nothing about the v3 schema is verified, because there is no v3 yet.

Sign-off: Andrii Tkhorenko (single-operator).

## T035 receipt — one refused row must not wedge the rows queued behind it (2026-09-14)

Merged as `650b4fa` from lane `wt/push-refusal` (lane commit `2eb0174`). Artefact:
`tests/stack/push-refusal-fallback.test.ts`, `+434/-0`, two cases. **Authored ahead of its nominal
`blocked-by: T032`, which is this card's whole point**: `sync-engine` is `VALIDATED` HIGH-tier
substrate, so ADR-0002's test-first rule is at its strictest, and D-18 states the obligation in the
card's own text. The test precedes the change it justifies.

**The red run, which the card's done-when requires be recorded here so the defect is evidenced rather
than asserted.** Run by the coordinator on the `supabase` CLI local stack:

```
npx vitest run --project stack tests/stack/push-refusal-fallback.test.ts
 ✓ positive control: with no refused row anywhere in the batch, queued rows land and clear _dirty within one cycle  1144ms
 × red (D-18): an innocent row queued behind a refused row in the same table batch must not be wedged  1527ms
   → expected 1 to be +0 // Object.is equality

AssertionError: expected 1 to be +0 // Object.is equality
 ❯ tests/stack/push-refusal-fallback.test.ts:381:41
      expect(innocentTaskAfter?._dirty).toBe(0)

 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
```

`_dirty === 1` on a row that did nothing wrong, after three push cycles. That is D-18's defect, on a
real stack, with the control green in the same run.

**This file is the first in the feature whose red is behavioural rather than structural**, and the
distinction was the card's central design problem. No fork schema is used anywhere: no `members`, no
`workspaces.kind`. Both cases run entirely against upstream's existing `own_rows`
(`supabase/schema.sql:238-254`). Had the file needed any of T020's schema, it would have gone red for
a structural reason and the defect would have been invisible underneath it.

**The construction that makes the refusal reachable at all, and why it is delicate.** `42501` is
raised only when a row passes the read half's `using` clause and its new values then fail
`with check`. A row failing `using` matches **nothing** — zero rows, no error, PostgREST 204 with
`error === null` — which would never reach the branch D-18 describes. The refused row is therefore
deliberately a **fresh id**, never written to the server, so the `upsert` takes the INSERT path,
where only `WITH CHECK` is evaluated and `USING` is never consulted. That is stated both in the
header and inline at the fixture, because an edit that reuses an existing id would silently convert
the red into a 204 and the file would pass while proving nothing.

### The card's literal red-phase instruction was not followed, deliberately, and the closer upheld it

The card says "assert exactly that in the red phase — the innocent row is still `_dirty` after three
cycles". The file asserts the opposite: `expect(innocentTaskAfter?._dirty).toBe(0)`, which fails
today and passes after T036.

The card's own done-when is the binding half — "SC-017's 'one refused row does not block the others'
has a **failing-then-passing** receipt". An assertion that the row *is still dirty* passes today and
would have to be **inverted** at T036; an inverted assertion is a rewritten test, and a test rewritten
between red and green proves nothing about the change that happened in between. It would also break
ADR-0002's test-first rule at precisely the point where this card says the rule is strictest. The
shape used here is the only one yielding **one unmodified file** that is red before T036 and green
after.

### Two blocking findings, both invisible in the first run, and the second one was dead code

**B1 — the proof of the refusal mechanic could not survive the card it greens at.** The file
originally proved a genuine `42501` had occurred by spying on `console.error`. That works today:
`src/sync/sync.ts:227` `if (error) throw error` → per-table catch at `:274-277` →
`console.error('[sync] push failed: ' + table, err)` at `:276`, with the PostgrestError as the second
argument. It is the only `console.error` on the push path.

**But T036 deletes that path.** D-18 point 2 replaces `throw error` with a row-by-row retry inside
the same `try`; D-18 point 5 requires `pushFailed` be set only for transport failures, never for a
row the server deliberately refused — so after T036 the batch `42501` never reaches `:274-277` and
D-18 mandates no log at all. The assertion would then fail for a reason unrelated to what it
measures, and **the file could not go green at T036** — exactly what its own header promises.

Worse, nothing else in the file or the repo pinned the SQLSTATE.
`tests/stack/rls-two-accounts.test.ts:104-113`, cited in the header as the independent pin, asserts
only `expect(error).not.toBeNull()` and never inspects `.code`. With the spy gone, the card's
requirement that no structural code be accepted as a refusal would have gone with it.

The replacement is an out-of-band probe taken before `flushQueue()`, with the same fixture and the
same INSERT shape the queued row takes:

```ts
const { error: probe } = await rawActing.from('tasks').insert({
  id: randomUUID(), user_id: acting.user.id,
  workspace_id: unreachableWorkspaceId, title: 'refusal probe',
})
expect(probe?.code).toBe('42501')
```

It never touches the sync loop, so T036 cannot disturb it; it pins the SQLSTATE rather than "an error
happened"; and it excludes every structural code — `PGRST202`, `PGRST205`, `PGRST204`, `42P01`,
`42703`, `23503`, `23514`, `22P02` — by construction. `tasks` carries defaults for every other NOT
NULL column (`supabase/schema.sql:42-77`), so this insert can fail on RLS and on nothing else. The
coordinator's re-run reached line 381, which means the probe **executes and passes today**.

**B2 — the cursor assertion was dead code, and would have stayed dead after T036.** `readCursors()`
reads `synced_at:<table>` (`src/sync/sync.ts:21`). `wipeLocal()` clears `db.meta`
(`src/db/local.ts:115-123`) and runs in the `afterEach` and in the prior case's `finally`. Nothing
between the start of the case and the capture pulled — `flushQueue()` is push-only
(`src/sync/sync.ts:304-314`). So every `cursorsBefore[table]` was `null` and the
`if (before === null) continue` guard skipped **every table on every run**. Obligation (iv) of the
card — "no other table's cursor moved backwards" — was never executed, in red or in green. A cursor
that never moved satisfied it without running a single assertion.

The fix drives one full `driveSyncCycle()` after sign-in and **before** any row is seeded dirty, then
captures. Non-perturbation was traced rather than assumed: nothing is dirty at that point, so the
cycle's push half has nothing to send; `acting` already owns one server row, so
`pullTable('workspaces')` receives a non-empty first page and sets `synced_at:workspaces`
(`sync.ts:405`), while `labels` and `notes` legitimately stay `null` because their first page is
empty and `stamp` never advances past `since`. A canary —
`expect(Object.values(cursorsBefore).some((v) => v !== null)).toBe(true)` — now makes a relapse into
dead code loud instead of silent.

**Both findings sat in the region the first run never reached.** The run stopped at the central
assertion, so everything after it — the server read-back, `remaining === 0`, the refused-row drop,
`getSyncState()`, the cursor loop — was unexecuted, and stays unexecuted until T036. That is the
condition under which a vacuous assertion survives review, and it is why the coordinator asked the
closer to reason about the unexecuted region specifically rather than only about the failure.

### Positive controls, of which there are two kinds

The card's red phase is one large negative assertion, so the control question is the whole review.

- A **separate `it`** proves the push path, the fixture and the flush all work in this process: with
  no refused row in the batch, both queued rows land and `_dirty` clears in one cycle. It shares no
  fixture state with the defect case, and it is the only thing proving the two rows would have landed
  *together*.
- A genuine **in-block** control: the label canary, a different-table row queued by the same account
  in the same cycle, which drains today. So `_dirty === 1` on the task cannot be "sync never ran" or
  "this account cannot push". A same-table in-block control is impossible by construction — the whole
  batch is wedged — so this is as strong as the shape allows.

### What is asserted, and what is honestly not

Of the card's four post-T036 obligations: the innocent row landing and the refused row alone being
dropped are asserted directly; the cursor obligation is asserted and, after B2, actually executed.
The "next pull reconciles the dropped row's true state" assertion (`expect(refusedAfterPull)
.toBeUndefined()`) is real and non-trivial — D-18 point 4 requires deletion from Dexie for a row whose
workspace is unreachable — but D-18 leaves T036 free to delete during push or after pull, and the
assertion passes either way. It does not distinguish the two, which is correct, because D-18's
criterion is the deletion and not its timing. The header says so rather than overclaiming.

`getSyncState()` not being `'error'` is an **indirect** stand-in for D-18's "`pushFailed` is false":
`pushFailed` is module-private (`src/sync/sync.ts:56`) and reaches the outside only through `settle()`
(`:65-68`), and the assertion is taken after a full cycle, so a pull failure would produce the same
`'error'`. Recorded in the header rather than silently accepted, and no source change was made to
expose it — that would be scope this card does not carry.

**`keep_newer` is not a confounder here, and the header now explains why** — a question worth settling
in writing because every other card in this feature has had to guard against it. `keep_newer` is
attached `before update` **only** (`supabase/schema.sql:199-205`, the `before update` at `:202`), not
`before insert or update` — contrast `touch_synced_at` at `:124`. Every row this file pushes carries
a fresh `randomUUID()` id, so all writes are INSERTs and `keep_newer` never evaluates. That is what
makes the plain `new Date().toISOString()` stamps safe here, where `tests/stack/lww-conflict.test.ts`
needs fixed `T_NEWER`/`T_STALE` constants. A future edit reusing an existing id would need those same
constants, or a `42501`-shaped red would silently become a `keep_newer`-refused UPDATE with
`error === null` and zero rows changed.

**`mergeRows` confirmed untouched**, as the card asks. It is at `src/sync/sync.ts:409-458`, and
D-18's "What is explicitly not touched" names exactly `mergeRows (409-458)`, `keep_newer`, the pull
loop, the refused-id path at `240-272` and `SYNCED_TABLES` ordering. The file never imports, calls or
stubs it; the only path reaching it is the reconciliation cycle, exercised as every other stack test
exercises the pull side.

**A stale line cite in the plan was found and corrected in the same change set** (`9e0607b`). D-7's
own 2026-09-13 correction placed the upsert-and-throw at `sync.ts:249-252`; the real lines are
`:223-227` with the `throw` at `:227`, while `:249` is the closing brace of the `db.transaction`
bookkeeping block at `:241-249`. The test file cited `:223-227` and was right; `plan.md` and T035's
card were wrong and are now fixed. `:257-272` and `:274-277` were and remain accurate.

**Declined, with the reason recorded:** the file does not assert the wire shape of the per-row retry —
it does not count individual upsert requests. That would pin an implementation detail T036 is free to
choose (a sequential loop or `Promise.all`) rather than the outcome FR-041 and SC-017 require. Stated
in the header under what the file deliberately does not cover.

Traps (i) and (ii) do not arise: no module-level fixture variable exists — every account, workspace
and row is created inside its own `it`, so a throw in one case cannot unseed the other — and the hooks
do only `signOut()` and `wipeLocal()`, with no SQL cleanup, so the `to_regclass`-probe-versus-SQLSTATE
question does not apply. Teardown is in a `finally` in both cases. Emails are unique per call, ids are
`randomUUID()`, clients are built `persistSession: false`, and server rows cascade from
`auth.users` on delete, so nothing leaks between files. No credential, key, token or `service_role`
literal appears — FR-044, FR-033 and SC-020 clean.

**Not proven by this card:** the fallback does not exist. `sync-engine` keeps its `VALIDATED` status
on its P0 receipts and is **not** re-signed here; T039 re-verifies it immediately after T036, which is
the point of ordering those two cards adjacently.

Sign-off: Andrii Tkhorenko (single-operator).

## T020 receipt — fork block A, and the first production SQL this feature writes (2026-09-14)

Committed as `0ab42f2`, directly on `002-team-workspaces` with no lane: `supabase/schema.sql` is
written by T020–T026 **strictly serially**, so a worktree per card would be a merge hazard rather
than parallelism. `+34/-0`, occupying `supabase/schema.sql:104-137`.

**This card opens TG-2 and is the first in the feature to write code rather than evidence.** Every
one of TG-1's thirteen files was authored red against it. That inverts the usual review question:
the block is not judged only against the contract, but against what the tests already assert — a
block satisfying `contracts/policies.sql` while leaving a TG-1 assertion red is a defect in one of
the two, and the reviewer's job is to say which.

**The block is byte-identical to `contracts/policies.sql:19-51`** — `diff -u` over the two ranges
returns nothing, including the aligned trailing inline comments `-- creator` / `-- the subject`, the
`'personal', 'team'` spacing and the `-- unconditional, NOT partial…` comment. There is no deviation
to justify.

### Verify, run by the coordinator on the `supabase` CLI local stack

The card's own verify:

```
npx vitest run --project stack tests/stack/schema-apply.test.ts tests/stack/personal-unchanged.test.ts
 ✓  stack  tests/stack/personal-unchanged.test.ts (13 tests) 4804ms
 ✓  stack  tests/stack/schema-apply.test.ts (6 tests) 338ms
 Test Files  2 passed (2)
      Tests  19 passed (19)
```

`personal-unchanged.test.ts` went from **0/13 to 13/13** in one step. The idempotent second apply is
inside `schema-apply.test.ts` and passed.

The `supabase-schema` map entry's own verify, which names a different pair, re-run because this diff
touches a file in that entry's `paths`:

```
npx vitest run --project stack tests/stack/rls-two-accounts.test.ts
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

P0's file, **unedited** — `git status` never showed it modified. That is FR-030's obligation
discharged early, and it is why the entry keeps `VALIDATED` rather than going `STALE`.

Two further files were run to record exactly how far block A moves the evidence spine, since the
TG-1 closing note predicted it card by card and a prediction is worth checking:

```
npx vitest run --project stack tests/stack/team-triggers.test.ts tests/stack/team-schema-guards.test.ts
 ✓ the three existing triggers fire identically ('personal') > keep_newer / stay_deleted_with_workspace / follow_workspace_delete
 ✓ the three existing triggers fire identically ('team')     > keep_newer / stay_deleted_with_workspace / follow_workspace_delete
 × R-6: a team member's late-arriving live child on an owner-deleted workspace
     → task insert failed: 42501 new row violates row-level security policy for table "tasks"
 ✓ R-17: pgcrypto is installed in the extensions schema
 × R-16 / R-1 / R-2 / R-3 ×8
 Test Files  2 failed (2)
      Tests  12 failed | 7 passed (19)
```

**6 of `team-triggers`' 7 green, R-6 red on `42501` until T023 — exactly what that file's header and
the TG-1 table predicted.** R-6's red is a *member* insert, which needs the widened child write half;
nothing about block A can move it. `team-schema-guards` is red on everything block A does not add:
R-2 names all fifteen missing functions, R-3's eight cases return `PGRST202` rather than `42501`,
R-16 wants a trigger on `auth.users` (T025). R-17 was green before this card and is independent of it.

**R-1 is worth singling out.** It is still red, but its failure message changed shape: it now reads
`members_access policy not found on public.members (found: (none))` rather than a
`relation does not exist`. Block A created the table and enabled RLS; the policy is T023's. That is
the guard's own vacuity defence working — R-1 refuses to pass merely because `members` exists.

### The map, which is where the only blocking finding landed

The closer found nothing blocking in the SQL. Its one blocking item was mine: `git status` showed
only ` M supabase/schema.sql`, while `docs/validation-map.md:89-99` lists `supabase/schema.sql` in
`supabase-schema`'s `paths` and was stamped `last-verified: 5448a0d 2026-09-13`. `CLAUDE.md`
reviewer duty 5 makes a `paths` change without a map update a finding in its own right, and T020's
`substrate:` line says `VALIDATED — re-verified in this PR`. The entry is now re-stamped to
`0ab42f2 2026-09-14` with this receipt named in the sign-off. **The status is `VALIDATED` because
the two tests the entry names were actually run and passed above, not because they were expected to.**

Note for anyone diffing the map: `5448a0d 2026-09-13` appears **twice** in the file — the other
occurrence belongs to a different component and is deliberately left alone.

### Idempotency, examined adversarially rather than asserted

`schema.sql` is re-run to upgrade a live database (ADR-0005), so "it applies twice in the test" is
not the whole question.

- **The `drop constraint if exists` / `add constraint` pair (`:111-113`)** is safe on a second apply
  against a **populated** database: `kind` is `not null` and the first apply already constrained it
  to exactly `('personal','team')`, so the revalidation scan cannot find a violating row.
  `applySchema` (`tests/harness/schema.ts:45`) sends the whole file as one `client.query()` — simple
  query protocol, hence one implicit transaction — so no concurrent session ever observes the
  constraint absent. Same in the Supabase SQL editor. The pair *would* fail loudly and roll the apply
  back if a later card narrowed the value list while a row held the dropped value, which is correct
  fail-loud behaviour and the reason the contract chose drop/add over upstream's guarded
  `if not exists (select 1 from pg_constraint …)` form at `:95-102`: the guarded form silently keeps
  a **stale predicate** forever. The cost, recorded honestly: an `ACCESS EXCLUSIVE` lock and a full
  scan of `workspaces` on **every** re-run. Contract-level, not this card's to change.
- **`create table if not exists public.members` silently accepts a pre-existing table of a different
  shape**, and unlike upstream's four tables `members` has no compensating
  `add column if not exists` guard — upstream's `foreach` loop at `:153-155` exists precisely to
  repair that drift for `synced_at`. Harmless today, since `members` is new here and no deployed
  database holds an earlier shape. **It stops being harmless the first time a later card changes a
  `members` column**: that card must carry its own guarded `alter table … add column if not exists`
  rather than rely on the `create table`, or a live database will not upgrade and T022's
  `members_zz_*` triggers will attach to the wrong shape. Recorded here because ADR-0005 accepts "no
  down-migrations" as a risk and this is the same risk's other face.
- `add column if not exists assignee … references auth.users(id)` skips the **whole statement**,
  FK included, when the column exists — so an `assignee` created without its FK would never gain one.
  Same drift class; no database is in that state.
- Everything else — the two `create index if not exists`, `enable row level security`, both
  `add column if not exists` — is a plain no-op on re-apply.

### R-4, proven rather than assumed

`git diff -U0 | grep -c '^-[^-]'` → **0**: the change is a pure insertion, so no upstream table
definition could have changed. But "no removed lines" is not the whole of R-4, because **placement**
can change the meaning of what follows. Traced:

- The block sits after upstream's last table statement — the `tasks_note_id_fkey` do-block,
  `:95-102` — and before `touch_synced_at` at `:140`, exactly where the contract places it.
- All five `foreach t in array array[…]` arrays are byte-unchanged and still read
  `['workspaces','labels','tasks','notes']` / `['labels','tasks','notes']`.
- Consequence, and it is deliberate: `members` is therefore in **none** of the loops. It receives no
  `members_synced_at` trigger, no `members_synced_at_idx`, no `keep_newer`, no `stay_deleted`, and
  the policy block's `enable row level security` loop (`:268`) does not reach it either. Between T020
  and T022 `members.synced_at` is stamped at insert only, which is harmless because nothing writes
  `members` until `seed_workspace_owner` / `add_member_by_email` land at T022/T024.
- **That last exclusion is what makes block A's own
  `alter table public.members enable row level security` (`:133`) load-bearing rather than
  decorative.** Without it, `members` would be world-readable through PostgREST from the moment this
  card lands until T023. It is present, and it was checked for specifically.

### `members_one_per_person` unconditional — confirmed load-bearing, not stylistic

The card insists the unique index is unconditional, not partial on `not deleted`, and it is worth
recording *why*, because the partial form is the one a reader would reach for. All three downstream
upserts use the **bare** inference form with no `where`:

- `contracts/rpc.md:37` — `on conflict (workspace_id, member_id) do update set deleted = false, …`
  (T024 `add_member_by_email`)
- `contracts/policies.sql:145` — the personal→team branch of `on_workspace_kind_change` (T022)
- `contracts/policies.sql:107` — `seed_workspace_owner`'s `do nothing` (T022)

Postgres infers a **partial** index as an arbiter only when the statement carries a matching `where`
on the conflict target. A partial index here would therefore make all three raise
`42P10 there is no unique or exclusion constraint matching the ON CONFLICT specification`. The
semantics point the same way: with a partial index, re-adding a removed person would insert a
**second live row** beside the soft-deleted one, breaking FR-036/SC-019's "exactly one owner row,
un-deleted not duplicated" and T017 case (b).

One detail checked positively: block A creates a unique **index**, not a unique **constraint**.
`on conflict (cols)` infers from indexes, so this suffices — but `on conflict on constraint
members_one_per_person` would fail against an index alone. No contract uses that form; if one ever
does, this is the line it breaks on.

### Two column decisions that bite later, both checked against the cards that depend on them

**`tasks.assignee … on delete set null` is right, and `on delete cascade` would be a data-loss bug.**
Every other `auth.users` FK in the file cascades, so the odd one out deserves a reason: cascading
here would delete **another person's task** because that person happened to be the assignee. `set
null` returns the task to unassigned and keeps the row — which is exactly what FR-043 demands
("the workspace rows that login created are still there") and what makes R-18's ban-not-delete
decision coherent at T026. It also matches D-3's "coerce, never raise" posture at T014. In normal
operation the clause never fires at all, because `delete_login` bans rather than deletes.

**`members` carries exactly the four housekeeping columns the synced tables carry**, compared
directly against `workspaces` (`:25-27`) and `tasks` (`:74-76`) plus the loop-added `synced_at`
(`:155`): same four names, same types, same defaults, same nullability. This is what lets T022 attach
`members_synced_at` and `members_keep_newer` and get behaviour identical to the upstream four —
`touch_synced_at()` sets `new.synced_at = now()` unconditionally and `keep_newer()` reads only
`new.updated_at < old.updated_at`, so neither cares which table it is on. `members.id uuid primary
key` deliberately has **no** default, matching upstream's client-supplied-id convention; both
contract upserts supply `gen_random_uuid()` explicitly.

### Personal must not regress — traced to the client, not stopped at the schema

This is the fork's first binding rule and the diff adds a `not null` column to a populated table, so
it gets a full trace rather than an assurance.

- **Server side: no table rewrite, no row touched, no trigger fired.**
  `add column if not exists kind text not null default 'personal'` is a PG 11+ **fast default** — a
  non-volatile constant — so it is a catalogue-only change. `updated_at` is not bumped, `synced_at`
  is not bumped, and `ALTER TABLE` fires no row-level triggers at all. A personal user's devices do
  **not** re-download every workspace after the upgrade. `tasks.assignee` is a nullable add; its FK
  validates against all-NULL values, taking a brief lock and rewriting nothing.
- **Client side, checked in source rather than assumed.** Pulled rows now *carry* `kind` and
  `assignee`, because `mergeRows` strips only `user_id`/`synced_at` (`src/sync/sync.ts:409-458`).
  That is inert, and the reason is that both functions which could have turned it into behaviour
  iterate a fixed whitelist: `sameRow()` (`:131-141`) loops `Object.keys(SYNCED_COLUMNS[table])`, so
  the new columns are never compared and there is **no** one-time "every row differs" rewrite storm
  waking every live query; and `forServer()` (`:147-153`) loops the same whitelist, so push payloads
  are unchanged and a partial-column upsert cannot null out a server-side `assignee`.
  `SYNCED_COLUMNS` (`src/db/types.ts:215-242`) is untouched by this diff.
- **P0 evidence unaffected for a stated reason**, not merely observed to pass:
  `rls-two-accounts.test.ts` asserts only `toEqual([])` and `toHaveLength(1)` — no row-shape or
  column-count assertion anywhere — and `offline-round-trip.test.ts:76` projects its server read
  through `Object.keys(SYNCED_COLUMNS.tasks)`, so `assignee` never enters it.

### Done-when, clause by clause

FR-001 holds (default plus `workspaces_kind_check`, and `personal-unchanged`'s two `23514` cases
prove the constraint is reached rather than shadowed by a `42501`). FR-016 holds (`assignee`).
FR-028 and FR-027 hold: `grep -n "origin" supabase/schema.sql` returns **nothing**, so P1 anticipates
ADR-0004's federation with zero schema support, as required. R-4 holds per the trace above.
`ls supabase/` confirms there is no `migration-007*` — the highest is `migration-006`, and D-2 says
block A is schema-only.

No credential, key, token or `service_role` literal appears in the diff — FR-044, FR-033 and SC-020
clean.

**A stale citation in the card was corrected in the same change set.** T020 cited
`contracts/policies.sql` "lines 14–46"; block A is at **19–51**, and 14–18 are that file's placement
preamble. The card also said "its own guarded block", which reads as a `do $$ … end $$` wrapper — the
contract writes plain idempotent top-level DDL and is authoritative. Both fixed in the card text so
the next reader diffing against the contract lands on the right range.

**Not proven by this card:** no team behaviour whatsoever. Block A is columns, one table, two indexes
and an RLS enable. `membership` and `team-rls` stay `UNTESTED`; `account-provisioning` stays
`UNTESTED`. The only map entry that moves is `supabase-schema`, and it moves in place — re-stamped,
not re-classified.

Sign-off: Andrii Tkhorenko (single-operator).

## T021 receipt — fork block B, the two helpers the whole team model rests on (2026-09-14)

Committed as `67a56d8`, serial on `002-team-workspaces`, no lane. `supabase/schema.sql:254-281`,
`+29/-0`. Byte-identical to `contracts/policies.sql:53-80` — `diff -u` over the two ranges returns
nothing, including the alignment padding on `is_owner(uuid) ` in the revoke/grant lines and the `$fn$`
tags.

**These two functions are the most load-bearing pair in the fork.** Every team RLS predicate at T023
calls them, block C's triggers call them, T024's RPCs call them. A defect here is a silent
authorization hole, not a test failure — no test in the tree today would catch most of the ways they
could be subtly wrong, because nothing calls them until T023. That is why this card's review was
spent almost entirely on properties rather than on behaviour.

### Verify

```
npx vitest run --project stack tests/stack/schema-apply.test.ts tests/stack/team-schema-guards.test.ts
 ✓  stack  tests/stack/schema-apply.test.ts (6 tests) 363ms
 ✓ R-17: pgcrypto is installed in the extensions schema
 × R-2: every added function is security definer with a fixed search_path
   → missing functions: seed_workspace_owner, on_workspace_kind_change, assignee_must_be_member,
     clear_assignee_on_removal, add_member_by_email, workspace_member_emails, is_admin,
     seed_first_admin, create_login, set_login_password, delete_login, set_login_admin, list_logins
 × R-1, R-16, R-3 ×8
 Test Files  1 failed | 1 passed (2)
      Tests  11 failed | 7 passed (18)
```

**R-2's missing list went from fifteen names to thirteen: `is_member` and `is_owner` dropped out.**
That is the whole of this card's observable effect, and it is the right measurement — it proves not
only that the functions exist but that the guard's catalogue query **accepts their spelling**, which
is the failure mode a receipt saying "the SQL is correct" would miss.

The `supabase-schema` map entry's own verify, which names a different pair than the card does:

```
npx vitest run --project stack tests/stack/personal-unchanged.test.ts tests/stack/rls-two-accounts.test.ts
 Test Files  2 passed (2)
      Tests  18 passed (18)
```

P0's `rls-two-accounts.test.ts` green and unedited (FR-030), `personal-unchanged` still 13/13. The
entry is re-stamped to `67a56d8 2026-09-14`, still `VALIDATED`, because the tests it names were
actually run.

### The card's verify line was wrong, and is corrected rather than satisfied

T021 said "R-1 and R-2 assertions green". **Neither goes green here, and neither can.** R-2's first
expectation is that **all fifteen** `DEFINER_FUNCTIONS` exist, so it clears only at T026; R-1 requires
the `members_access` policy and clears at T023. The test file's own header
(`tests/stack/team-schema-guards.test.ts:18`) already said "T021 … R-2 at 2/15", and the T009
correction at `tasks.md:152` already said the same — the card was simply out of step with both. It now
carries the correction, including the instruction not to "fix" the test to make it pass. The card's
`Read:` cite is corrected too: block B is `contracts/policies.sql:53-80`, not 48–75; **lines 48–52 are
the tail of block A and already landed at T020** (`supabase/schema.sql:133,135-136`), so a worker
following the cite literally would have written a duplicate. Same slip class as T020's "14–46".

### The security properties, each checked rather than assumed

- **`stable` is right, not merely acceptable.** The body reads a table and a per-request GUC.
  `volatile` would forbid per-statement caching that matters when a predicate is evaluated once per
  row; **`immutable` would be a genuine defect**, because Postgres may constant-fold an immutable
  call and a folded `is_member` is a cached authorization decision.
- **Neither is `leakproof`, and that absence is load-bearing.** A leakproof definer function reading a
  table can be pushed below a security barrier and used to probe hidden rows. The contract is right
  not to add it; a later card must not "optimise" it in.
- **Neither is `strict`, and that is also deliberate.** `strict` would make `is_member(null)` return
  NULL instead of `false`. As written, `m.workspace_id = null` is NULL for every row, zero rows
  qualify, and `exists()` — which is never NULL by definition — returns `false`. Traced through the
  policy anyway, because a NULL inside an `or` is the subtle case: in
  `using (auth.uid() = user_id or public.is_member(id))`, NULL-or-false is NULL (no grant, safe) and
  NULL-or-true is true (already granted, so no widening). So even a NULL could not open a hole here —
  but `exists` closes it upstream and the property should stay closed there.
- **Schema qualification.** `public.members` and `auth.uid()` are both qualified, so resolution does
  not depend on the `search_path` pin at all — the pin is defence in depth, not the primary control.
  `pg_temp` is listed **last**, which is the correct ordering: first, a caller's temp table named
  `members` would shadow. Operators resolve from `pg_catalog`, implicitly searched first and not
  displaceable by a `search_path` that does not name it.
- **Can a caller get `true` for a workspace they are not in?** No. The only route to `true` is an
  existing `members` row with `member_id = auth.uid()` and `not deleted`. The single caller-controlled
  input, `ws uuid`, selects *which* row is looked for; it cannot substitute *whose*.

### `auth.uid()` under `security definer` — the one place this model could quietly invert

`security definer` switches the **role** (`current_user`, the privilege context). It does **not**
touch session or transaction GUCs. `auth.uid()` reads `request.jwt.claims`, which PostgREST sets with
`set_config(..., is_local => true)` per request *before* the function is entered, and the definer
switch on entry leaves that untouched. So the body sees the **calling** user's subject, which is the
entire premise of the fork's access model.

Recorded because the alternative is worth naming: if `auth.uid()` returned the definer, both helpers
would answer for `postgres`, which has no `members` row at all, every predicate would be `false`, and
the result would be a total lockout — loud rather than silent, but total. The mechanism that prevents
it is role-versus-GUC, a property of Postgres itself, not of any Supabase implementation choice.

### R-1's recursion argument holds, but the mechanism is narrower than the block's own comment says

The comment at `:256-258` credits `security definer` with preventing the recursion. Precisely, the
escape is **two-step**: `security definer` routes execution to the function's owner, and RLS is not
enforced against a table's owner **unless `force row level security` is set**. `security definer` is
the switch that reaches the exemption; it is not itself the exemption.

That distinction is not pedantry, because it names a live seam: **`force row level security` appears
nowhere in `supabase/` today, and if a later card ever adds it to `members`, these helpers start
recursing again.** The only thing that would catch it is R-1's canary at
`tests/stack/team-schema-guards.test.ts:121`. Nothing else in the tree guards that seam.

Checked whether anything else would have prevented the recursion anyway, which would have made D-5's
claim weaker than it reads — nothing does. A `bypassrls` role does not help, because the caller under
test is `authenticated`, which has neither `bypassrls` nor ownership; `service_role` bypassing RLS is
irrelevant since the predicate is never evaluated for it; and the policy shape offers no `user_id`
shortcut to short-circuit on, being a bare self-reference. `tests/harness/schema.ts` applies the file
as `postgres` (`tests/harness/stack.ts:9`), the same role that created `members` in block A, so
owner-equals-definer holds on the local stack; on hosted Supabase the SQL editor runs as `postgres`,
which owns `public`. Consistent in both environments.

The comment is contract-authored and byte-identical to `contracts/policies.sql`, so it is **not**
edited here — fidelity to the contract outranks a sharper comment. If it is ever tightened, it is
tightened in the contract.

### The grants: both required, effects disjoint, order **not** material

The card's phrasing implies the `revoke`-then-`grant` order carries meaning. It does not, and the
receipt says so rather than repeating the implication:

- `revoke execute … from public` removes the **implicit default** `EXECUTE` Postgres grants to
  `PUBLIC` on every new function. This is the one that matters — without it, `is_member` is a
  PostgREST `/rpc/is_member` endpoint reachable with the anon key.
- `revoke execute … from anon` removes any **explicit** grant to `anon`. There is none by default, so
  today it is a no-op — but it is not pointless, because `schema.sql` is re-run to upgrade a database
  (ADR-0005) and `revoke from public` would **not** strip an explicit `anon` grant left by an earlier
  revision. PUBLIC and `anon` are separate grantees.
- Reversing to grant-then-revoke would produce an identical `proacl`: `revoke from public` does not
  cascade into `authenticated`'s explicit grant.
- **`authenticated` alone is enough.** The owner keeps `EXECUTE` implicitly (a `revoke from public`
  never touches the owner), so `postgres` can still call them, which is what the harness and the
  contract's RPCs need; `authenticator` reaches them via `set role authenticated`. `service_role` is
  deliberately not granted and does not need to be — these are only ever called from RLS predicates,
  and predicates are not evaluated for a `bypassrls` role. Confirmed by grep: nothing in the tree
  calls either helper through `.rpc()`; every other reference is a comment or the `DEFINER_FUNCTIONS`
  catalogue list.

### R-5, and what its absence would cost

`not m.deleted` is present in both (`:267`, `:275`). Recorded because the failure mode is invisible:
drop it from `is_member` and **removal stops meaning anything** — a removed member keeps read and
write on `workspaces`/`labels`/`tasks`/`notes` and keeps seeing the roster. Drop it from `is_owner`
only and a removed *owner* retains invite, remove and delete. The files that would catch each are
`team-rls-both-halves.test.ts` (T011's post-removal block, both halves), `kind-switch.test.ts` case
(a) for the team→personal purge, `assignee-clear-on-removal.test.ts` from the other side, and T017
case (e) / T010's `42501` case for the owner variant. **Every one of those greens at T023 or later —
so nothing in the tree catches this defect at T021.** That is the honest state of the evidence.

### Placement and idempotency

Block B sits after `workspaces_cascade_delete` (`:250-252`, upstream's last trigger) and before the
policy block's `do $$` at `:292`, satisfying the contract's "before the policy block" and preceding
**every** consumer — T023's policies, block C's triggers (which land in the gap at `:282`), T024's
RPCs. Nothing between `:252` and `:254` reads them, so the position changes no semantics either side.

One ordering constraint is real rather than cosmetic: **block B cannot move above block A.** A
`language sql` body is parsed and validated at `create` time, unlike `plpgsql`, so `public.members`
must already exist.

`create or replace function` is idempotent **for the same signature and return type** — and not
otherwise. A changed return type errors; a changed *parameter name* errors
(`cannot change name of input parameter`); and a changed argument type or arity silently creates an
**overload** rather than replacing, leaving a stale function whose `EXECUTE` is still granted to
`PUBLIC`, because `:278-281` name `(uuid)` explicitly and would not reach the orphan. None can fire
today — first version, no prior `is_member` in history. **If any later card changes either signature,
it must carry a targeted `drop function if exists public.is_member(<old sig>);` in the same change
set**, or the re-run leaves an anon-executable orphan. That is a security consequence, not a tidiness
one, and it is written here because the card that would cause it does not exist yet.

### What this card turns green: nothing

No `it` in the suite flips at T021, and the ledger is stated plainly rather than dressed up: R-2 moves
0/15 → 2/15 and clears at T026; R-1 clears at T023; R-3's eight cases clear across T024 (2), T025 (1)
and T026 (5); R-16 at T025; R-17 was green before this card and is independent of it.
`assignee-clear-on-removal.test.ts:17` and `team-triggers.test.ts:29` each say in their own headers
that T021 moves nothing for them, and it did not.

**Personal must not regress:** the diff creates no table, alters no column, replaces no policy and
defines no trigger — nothing a `kind: personal` workspace can observe. `is_member` is not *called* by
anything yet; it becomes reachable at T023, and even then a personal workspace has no `members` rows,
so the branch is constant-`false`. No credential, key, token or `service_role` literal — FR-044,
FR-033, SC-020 clean.

**Not proven by this card:** no behaviour whatsoever. `membership` and `team-rls` stay `UNTESTED`;
only `supabase-schema` moves, and it moves in place.

Sign-off: Andrii Tkhorenko (single-operator).

## T022 receipt — fork block C, the fork's own triggers (2026-09-14)

**Card:** T022. **Commit:** `381122b` (`supabase/schema.sql`, +148/−0, inserted between fork block B's
grants and upstream's policy block). **Status: PASS.** Coder: dev-worker (sonnet, high). Closer:
dev-worker (sonnet, high), read-only against the commit. Sign-off: Andrii Tkhorenko (single-operator).

### Verify

| # | command | exit | result |
|---|---|---|---|
| 1 | `npx vitest run --project stack tests/stack/team-triggers.test.ts tests/stack/assignee-clear-on-removal.test.ts tests/stack/kind-switch.test.ts tests/stack/personal-triggers-after-t022.test.ts` (before edit) | 1 | 10 passed / 14 failed — all `42P01 relation "public.members" does not exist` or missing-trigger shaped |
| 2 | same (after edit; coder run, closer re-run agreed) | 1 | 19 passed / 5 failed — the five T023-gated cases exactly: `kind-switch` (a) (b) (e), `assignee-clear-on-removal` case 7, `team-triggers` R-6 |
| 3 | `npx vitest run --project stack tests/stack/schema-apply.test.ts tests/stack/rls-two-accounts.test.ts tests/stack/personal-unchanged.test.ts tests/stack/team-triggers.test.ts` | 1 | 30 passed / 1 failed — the same R-6 case; `schema-apply` 6/6, `rls-two-accounts` 5/5, `personal-unchanged` all green |
| 4 | `npx tsc -b --noEmit` | 0 | clean |
| 5 | closer: `diff` of `contracts/policies.sql:82-228` against `supabase/schema.sql:283-429` | 0 | zero drift |
| 6 | closer: `information_schema.triggers` on the live local stack | 0 | see ordering below |
| 7 | closer: `supabase/schema.sql` applied twice in sequence via pg client | 0 | `RUN1 OK`, `RUN2 OK` |

### Done-when, clause by clause

- **FR-002** — `workspaces_seed_owner`, `after insert`, `security definer`, `on conflict (workspace_id, member_id) do nothing`; `personal-triggers-after-t022` (c) positive control: team insert seeds exactly one owner row.
- **FR-014** — BEFORE order per table from the catalog: `labels`/`tasks`/`notes`: `keep_newer → stay_deleted → synced_at → _zz_*`; `members`: `keep_newer → synced_at`. `team-triggers` "three existing triggers fire identically" 6/6 on both kinds.
- **FR-018** — `assignee-clear-on-removal` acceptances 3–4 green; clear lands server-side with `greatest(updated_at, now())`.
- **FR-034–FR-036** — `workspaces_zz_kind_change` is `after update … when (new.kind is distinct from old.kind)`; `kind-switch` (c) (d) green (purge stamp, R-19 stale-flip cancellation). (a) (b) (e) are T023-gated (below).
- **No `pin_workspace_kind`, no `workspaces_zz_kind_fixed`** — grep finds neither definition; comments only.
- **R-4** — pure insertion; the three upstream `foreach … array['workspaces','labels','tasks','notes']` loops byte-identical.
- **Security** — four `security definer` functions all `set search_path = public, pg_temp`; `keep_creator` is plain plpgsql by contract (no cross-table read); no `raise` anywhere in block C — `assignee_must_be_member` coerces to `null`.

### Personal must not regress

`members_*` triggers and the kind-change trigger never fire on a personal workspace (no `members` row is ever seeded; `when` guard). `<t>_zz_keep_creator` is a no-op under the unchanged write half (a caller can only ever write their own `user_id`). `tasks_zz_assignee_member` coerces a personal self-assignment to `null` — contractually intended (`contracts/policies.sql:101-114`) and pinned by `personal-triggers-after-t022` (b). `personal-triggers-after-t022` 5/5; `personal-unchanged` green.

### Findings and deviations

1. **Card text (B1, non-blocking, corrected in `tasks.md` and logged as A-002):** the card's T023-gated exception list named three cases; five are T023-gated. `kind-switch` (b) shares `roundTripWs` with (a) (`kind-switch.test.ts:141-142`) and can only observe (a)'s purge once (a) survives its T023-dependent positive control; `team-triggers` R-6 needs the widened `tasks` write half and its header (`team-triggers.test.ts:20-33`) says so. No test file was edited.
2. **Closer F2 (cosmetic):** the dispatch cited the contract range as 82–279; block C is 82–228, and 229–279 is the contract's policy block (T023). Nothing from 229–279 landed here.
3. **Closer F1:** map re-stamp for `supabase-schema` owed at check-off — done in this commit.

### What this card turns green

`personal-triggers-after-t022.test.ts` (T026A) 5/5; `team-triggers` 6/7; `assignee-clear-on-removal` 6/7; `kind-switch` (c) (d). The remaining five cases turn green at T023.


## T027 receipt — P0-unedited gate for the schema lane (2026-09-14)

HEAD `4662e5d` (schema at `c5fda53`). Baseline `4991c33` (post-T004).

**1. P0 diff (must be empty):** `git diff --stat 4991c33 -- tests/stack/{lww-conflict,offline-round-trip,rls-two-accounts,schema-apply,soft-delete}.test.ts tests/local/claim-cache.test.ts` → **empty**. PASS, SC-003 demonstrated.
**Harness diff:** `tests/harness/{accounts,seed}.ts` changed (+210/-1). Inspected in full: only new imports (`Client` from `pg`, `DB_URL`, `flushQueue`) and new exports (`createTestUsers`, `asUser`, `adminClient` in accounts.ts; `SeededTeamWorkspace`, `seedTeamWorkspace` in seed.ts) appended. No existing export's signature or body changed.

**2/3. `npm test -- --run`, twice consecutively:**
| run | files | tests | failed | duration |
|---|---|---|---|---|
| 1 (15:19–15:21) | 16 passed / 2 failed (18) | 163 passed / 2 failed (165) | see below | 80.80s |
| 2 (15:23–15:25) | 16 passed / 2 failed (18) | 163 passed / 2 failed (165) | identical | 84.70s |

Same two failures both runs (not interleaving — reproduced verbatim twice):
- `tests/stack/push-refusal-fallback.test.ts` — "red (D-18): an innocent row queued behind a refused row…" — `innocentTaskAfter?._dirty` expected `0`, got `1`. Red-by-design until T036 (`wt/push-refusal` lane), not yet merged to this branch.
- `tests/local/no-wipe-on-reach-growth.test.ts` — "…turns green at T029…" — `db.tables.some(members)` expected `true`, got `false`. Red-by-design until T029's `local.ts` v3 store (`wt/sync-cache` lane), not yet merged to this branch.

Neither file is a P0 file; neither is touched by this lane's diff.

**4. Typecheck/lint/build:** `npx tsc -b --noEmit` → exit 0, no errors (test fixtures already typed for `kind`/`assignee`, T028a's fix is present on this branch — the anticipated gate-9 failure class did not occur). `npm run lint` (oxlint) → exit 0. `npm run build` (tsc -b && vite build) → exit 0, PWA precache generated.

**5. Map-owed:**
| entry | status | last-verified | owed |
|---|---|---|---|
| supabase-schema | VALIDATED | `381122b` 2026-09-14 | `paths` (`schema.sql`) changed materially at `c5fda53` (+412/-15, fork blocks D+E) after last-verified with no map update since — re-run `verify` + re-stamp SHA (T052) |
| membership | UNTESTED | — | T020-T024 landed; named verify (`members-two-accounts.test.ts` 10/10, `kind-switch.test.ts` 5/5) green this run — owes UNTESTED→VALIDATED flip (T052) |
| team-rls | UNTESTED | — | T023 landed; named verify (`team-rls-both-halves.test.ts` 30/30, `rls-two-accounts.test.ts`, `personal-unchanged.test.ts` 13/13) green this run — owes UNTESTED→VALIDATED flip (T052) |
| account-provisioning | UNTESTED | — | T025, T026 landed; named verify (`logins-provisioning.test.ts` 20/20, `team-schema-guards.test.ts` 12/12) green this run — owes UNTESTED→VALIDATED flip (T052) |

**Status: FAIL.** Step 1 (P0-unedited) and step 4 (typecheck/lint/build) pass clean. The card's own `verify` — "`npm test -- --run` fully green twice consecutively" — is not met: 2 files/2 tests red, identically, on both runs. Both are pre-existing, committed-red-by-design tests waiting on other in-flight lanes (T029/`wt/sync-cache`, T036/`wt/push-refusal`) that have not merged into `002-team-workspaces`; this lane's own diff does not touch either failing file. **B1 (planning gap):** the card does not say whether "fully green" means the literal whole repo or the subset already integrated into this branch — owner ruling needed before this gate can close.

sign-off: Andrii Tkhorenko (single-operator)

## Schema lane review — 67a56d8..c5fda53 (2026-09-14)

Reviewer verdict FAIL: transcription clean, three blocking RLS reachability findings + FR-010 gap; fixed by T023a. Full text follows.


