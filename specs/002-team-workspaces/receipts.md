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
