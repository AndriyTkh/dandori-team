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
