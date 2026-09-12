---

description: "Task list for 001-validation-spine"
---

# Tasks: P0 Validation Spine

**Input**: Design documents from `/specs/001-validation-spine/`

**Prerequisites**: [plan.md](./plan.md) (required), [spec.md](./spec.md) (required for user stories).
`research.md`, `data-model.md`, `contracts/`, `quickstart.md` were deliberately not produced — see
plan.md, "Project Structure / Documentation".

**Tests**: This feature *is* tests. Every task below produces test, harness, CI or map content.
**Zero files under `src/` or `supabase/` may be modified by any task** (spec FR-002), and
`supabase/migrations/` must never be created (plan.md F-4). A task that cannot be completed without
breaking either rule stops and files a FINDING (spec FR-013).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US6)
- Every task carries `Write:` / `Read:` / `substrate:` / `verify:` field lines.
- Taskgroup headers `## TG-N` are hard sequencing gates: TG-N+1 does not start before TG-N is
  merged and checked.

**Standing context for every task** (not repeated in each `Read:` line): `CLAUDE.md`,
`specs/001-validation-spine/plan.md`, `specs/001-validation-spine/spec.md`,
`docs/validation-map.md`, `docs/decisions/ADR-0002-phase-gates.md`,
`docs/decisions/ADR-0003-test-framework.md`. `Read:` lines name what is needed **beyond** that.
`ARCHITECTURE.md §N` line ranges come from `docs/architecture-index.md`.

**Local stack facts** (verified, do not rediscover): API `http://127.0.0.1:54321`, DB
`postgresql://postgres:postgres@127.0.0.1:54322/postgres`, Studio `:54323`, well-known local dev
keys, `supabase` CLI is a devDependency (`npx supabase`), `supabase/config.toml` is committed.

---

## TG-1: Setup — runner, environment, dependencies

**Purpose**: a vitest process that can import the app's own modules and run Dexie, with nothing
backend-dependent yet.

- [x] T001 Add dev dependencies `vitest`, `jsdom`, `fake-indexeddb`, `pg`, `@types/pg` to `package.json` and add the `"test": "vitest"` script; run `npm install` so `package-lock.json` is updated
  - Write: `package.json`, `package-lock.json`
  - Read: plan.md D-1, D-4, D-7; existing `package.json` scripts block
  - substrate: `env-boot` (VALIDATED)
  - verify: `npx vitest --version` prints a version and `npm run test -- --run` exits 0 with "no test files found"
- [x] T002 Create `vitest.config.ts` at repo root: `environment: 'jsdom'`, `setupFiles: ['./tests/setup.ts']`, `globalSetup: ['./tests/harness/global-setup.ts']`, `test.env` carrying `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` (local dev keys, with the ADR-0002 comment saying why committing them is not a credential leak), `include` covering `tests/**/*.test.ts`, and file parallelism disabled for `tests/stack/`
  - Write: `vitest.config.ts`
  - Read: plan.md D-2, D-4, D-6; `vite.config.ts` (resolution reuse); `src/auth/supabase.ts:1-17` (the throw-on-missing-env this feeds)
  - substrate: `env-boot`
  - verify: `npx vitest run --reporter=basic` starts, loads config, reports no test files (no config or env error)
- [x] T003 [P] Create `tests/setup.ts`: import `fake-indexeddb/auto`, and reset the Dexie `dandori` database between test files so no cached rows leak across files
  - Write: `tests/setup.ts`
  - Read: plan.md D-4; `ARCHITECTURE.md §3` L263–L279 (local storage, Dexie stores, `meta` keys); `src/db/local.ts:20-66`
  - substrate: `local-cache` (UNTESTED — this feature clears it)
  - verify: a throwaway test importing `src/db/local.ts` and calling `db.open()` passes under `npx vitest run`
- [x] T004 [P] Create `tests/README.md` stating the two tiers (`tests/stack/` needs Docker, `tests/local/` does not), the one command, and the no-source-modification rule
  - Write: `tests/README.md`
  - Read: plan.md Summary, D-7; spec.md FR-002, FR-010
  - substrate: —
  - verify: manual check — the file names both tiers, the single command, and the FR-002 rule

**Checkpoint**: `npm test` runs an empty suite cleanly on a machine with no Docker.

---

## TG-2: Foundational harness — stack, schema, accounts, sync driving

**Purpose**: everything the stack tier needs. **Blocks TG-3 onward.**

- [x] T005 Create `tests/harness/stack.ts`: exported constants for the local API URL, DB URL, anon key and `service_role` key; a `assertStackReachable()` that probes the API and, if unreachable, runs `npx supabase start`; on failure it throws an error naming Docker and `npx supabase start` — never skips
  - Write: `tests/harness/stack.ts`
  - Read: plan.md D-7, D-1; `supabase/config.toml` (ports); spec.md FR-014, Edge Cases
  - substrate: `supabase-schema` (UNTESTED)
  - verify: with the stack up, a scratch test calling `assertStackReachable()` passes; with Docker stopped, it fails with a message naming Docker
- [x] T006 Create `tests/harness/schema.ts`: using `pg`, connect to the local DB and execute, in this exact order, `supabase/schema.sql`, `supabase/migration-002-note-link-and-mute.sql`, `-003-synced-at`, `-004-gcal`, `-005-gcal-placed`, `-006-lww-and-ownership`; fail naming the file and the SQL error if any step fails. **Read the SQL from its existing repo-root location; do not move, copy or symlink it, and do not create `supabase/migrations/`**
  - Write: `tests/harness/schema.ts`
  - Read: plan.md D-1, F-4; `supabase/README.md`; `ARCHITECTURE.md §4` L379–L393 (triggers); `docs/validation-map.md` migration-convention note (lines 144-148)
  - substrate: `supabase-schema`
  - verify: `npx vitest run tests/stack/schema-apply.test.ts` (T007) is green; `git status` shows no change under `supabase/`
- [x] T007 Create `tests/stack/schema-apply.test.ts`: assert the ordered apply succeeds on a clean stack and is idempotent on a second apply, and assert the four tables, the `own_rows` policies and the `keep_newer` / `stay_deleted` / `synced_at` triggers all exist afterwards
  - Write: `tests/stack/schema-apply.test.ts`
  - Read: plan.md D-1; `ARCHITECTURE.md §4` L379–L393; `ARCHITECTURE.md §3` L243–L262
  - substrate: `supabase-schema`
  - verify: `npx vitest run tests/stack/schema-apply.test.ts`
- [x] T007a [sub-of: T007] Make `applySchema` retry each file's apply on Postgres deadlock (SQLSTATE 40P01) — bounded (3 attempts, short backoff), rethrowing anything else unchanged. Discovered at the TG-4 full-suite merge gate: the mid-suite idempotency re-apply's `drop trigger if exists workspaces_synced_at` can deadlock against a Supabase service's row lock; the loser is killed and a plain retry succeeds
  - Write: `tests/harness/schema.ts`
  - Read: `tests/harness/schema.ts`; plan.md D-1
  - substrate: `supabase-schema`
  - verify: `npm test -- --run` fully green twice consecutively
- [x] T008 Create `tests/harness/global-setup.ts` wiring T005 then T006, so one `npm test` brings the stack up and applies the schema before any test file runs
  - Write: `tests/harness/global-setup.ts`
  - Read: plan.md D-1, D-7
  - substrate: `supabase-schema`
  - verify: `npm test -- --run` performs stack check + ordered apply once, visible in output
- [x] T008a [sub-of: T008] Scope `globalSetup` to the `stack` project only in `vitest.config.ts` (vitest 3 per-project globalSetup), so `npx vitest run tests/local/` starts no stack and passes on a Docker-free machine — discovered when the root-level globalSetup auto-started the stopped stack during the T019/T020 Docker-stopped verify
  - Write: `vitest.config.ts`
  - Read: `vitest.config.ts`; plan.md D-7; spec.md FR-008
  - substrate: `env-boot`
  - verify: with the stack stopped, `npx vitest run tests/local/` passes in seconds without starting containers, and `npm test -- --run` still performs stack check + ordered apply for the stack project
- [x] T008b [sub-of: T008a] Actually serialize the stack project in full multi-project runs: `fileParallelism: false` on a `projects` entry is not honored when both projects run (`npm test -- --run`) — JSON-reporter timestamps show all five `tests/stack/**` files overlapping, producing 40P01 deadlocks (schema re-apply vs concurrent REST writes), GoTrue `Database error creating new user` storms, and sync-settle timeouts. Pin the stack project to one worker via `poolOptions: { forks: { singleFork: true } }`
  - Write: `vitest.config.ts`
  - Read: `vitest.config.ts`; plan.md D-7
  - substrate: `env-boot`
  - verify: `npx vitest run --reporter=json` shows no two `tests/stack/**` files with overlapping start/end times, and `npm test -- --run` fully green twice consecutively
- [x] T009 [P] Create `tests/harness/accounts.ts`: provision throwaway users via the Auth admin API with the local `service_role` key, and a `clientFor(user)` factory building an independent `supabase-js` client with `persistSession: false`; include per-file unique naming so files cannot collide
  - Write: `tests/harness/accounts.ts`
  - Read: plan.md D-3, D-6; `src/auth/supabase.ts:1-17` (why the singleton is not used here)
  - substrate: `supabase-auth` (UNTESTED, incidental)
  - verify: a scratch test provisioning two users and reading `auth.getUser()` on each client passes
- [x] T010 [P] Create `tests/harness/sync.ts`: helpers to drive one cycle via `startSync()` and wait for settle through `onSyncState`, with a bounded timeout and a Dexie-poll backstop, plus a teardown helper that always calls `handle.stop()`; a thin wrapper around the exported `flushQueue()` for push-only cases
  - Write: `tests/harness/sync.ts`
  - Read: plan.md D-5, F-1; `ARCHITECTURE.md §4` L331–L356 (sync loop, cursors, triggers of a cycle); `src/sync/sync.ts:462-507` (`startSync`/`SyncHandle`), `:43-78` (state + listeners), `:304` (`flushQueue`)
  - substrate: `sync-engine` (UNTESTED)
  - verify: a scratch test starting and settling one cycle against the stack passes and leaves no running interval (vitest exits without `--forceExit`)
- [x] T011 Create `tests/harness/seed.ts`
- [x] T010a [sub-of: T010] Fix `tests/harness/sync.ts` pull-only-cycle no-op: `push()` settles even with zero dirty rows before `pull()` runs, so `driveSyncCycle` returning on the first settle skips the pull — wait for the full cycle (second settle on the same `onSyncState` seam, per TG-3's local `drivePushAndPullCycle` pattern in `tests/stack/offline-round-trip.test.ts`)
  - Write: `tests/harness/sync.ts`
  - Read: `tests/harness/sync.ts`; `tests/stack/offline-round-trip.test.ts` (the working pattern); `src/sync/sync.ts:462-507`, `:43-78` read-only
  - substrate: `sync-engine`
  - verify: `npx vitest run tests/stack/` green after the change (offline-round-trip keeps its own local helper; no regression): sign a given account's client in on the app singleton path used by sync tests, and create a workspace plus a task through `src/db/api.ts` so stories start from a known local state
  - Write: `tests/harness/seed.ts`
  - Read: plan.md D-2, D-3; `ARCHITECTURE.md §4` L407–L424 (db-api surface); `ARCHITECTURE.md §3` L207–L242 (entities, the three timestamps)
  - substrate: `db-api` (UNTESTED, incidental), `local-cache`
  - verify: a scratch test seeding a workspace + task and reading them back from Dexie passes

**Checkpoint**: the stack tier can start, be schema'd, provision accounts, and drive a sync cycle.
**FINDING gate**: if T010 or T011 cannot be written without exporting something new from `src/`,
stop and file the FINDING (plan.md F-1/F-2/F-3) rather than editing source.

---

## TG-3: US1 — offline edit sync round-trip (P1) 🎯 MVP

**Goal**: prove an offline edit reaches the server, comes back to a second client, and survives a
restart. **Independent test**: `npx vitest run tests/stack/offline-round-trip.test.ts` alone, green.

- [x] T012 [US1] Write `tests/stack/offline-round-trip.test.ts` covering spec.md US1 acceptance 1–2: edit a task while offline (dirty flag set, no network), then drive one cycle and assert the row landed server-side matching what was sent except the server-assigned `synced_at`, and that `_dirty` cleared
  - Write: `tests/stack/offline-round-trip.test.ts`
  - Read: `ARCHITECTURE.md §4` L323–L330 (SYNCED_COLUMNS wire contract), L331–L356 (push/pull, cursors, `_dirty` clearing rule at `sync.ts:240-249`); `ARCHITECTURE.md §3` L226–L242 (three timestamps); plan.md D-5
  - substrate: `sync-engine`, `local-cache`, `db-api`, `supabase-schema`
  - verify: `npx vitest run tests/stack/offline-round-trip.test.ts`
- [x] T013 [US1] Extend the same file with acceptance 3–4: a second client from an empty local cache pulls the row with identical content, does not re-receive it on a second cycle (cursor advanced), and still has it after the local cache is reopened without a network round trip
  - Write: `tests/stack/offline-round-trip.test.ts`
  - Read: `ARCHITECTURE.md §4` L331–L356 (per-table cursors, `CURSOR_SLACK_MS`, keyset paging); plan.md D-5, D-6
  - substrate: `sync-engine`, `local-cache`
  - verify: `npx vitest run tests/stack/offline-round-trip.test.ts`

**Checkpoint**: the first non-toolchain receipt in this repo's history exists.

---

## TG-4: US2 — LWW conflict pinning, both enforcement points (P1)

**Goal**: prove the stale edit loses at the server *and* at the client merge, and that the pair is
in lockstep. **Independent test**: `npx vitest run tests/stack/lww-conflict.test.ts` alone, green.

- [x] T014 [US2] Write `tests/stack/lww-conflict.test.ts` server half (acceptance 1–2): send an update whose `updated_at` is older than the stored row; assert content unchanged and `synced_at` not moved; assert the losing client stops re-sending it and that the refusal stalls neither other rows nor other tables
  - Write: `tests/stack/lww-conflict.test.ts`
  - Read: `ARCHITECTURE.md §4` L357–L378 (LWW contract, `keep_newer` returning null); L331–L356 (per-table error isolation, `sync.ts:274-280`, `:203-209`); `supabase/migration-006-lww-and-ownership.sql:37-48`
  - substrate: `supabase-schema`, `sync-engine`
  - verify: `npx vitest run tests/stack/lww-conflict.test.ts`
- [x] T015 [US2] Extend the file with the client half (acceptance 3–4), pinned behaviourally per plan.md F-2: an incoming row older than the local unsent copy leaves the local copy in place; an incoming row at the same instant produces the documented equal-stamp outcome (equal stamps accepted — the case that exists for bookkeeping-only writes, pinned at row level per resolved F-6, with no calendar code involved)
  - Write: `tests/stack/lww-conflict.test.ts`
  - Read: `ARCHITECTURE.md §4` L357–L378 (`mergeRows` three skip gates, `isNewer`/`isSameMoment` parse-not-string-compare, `canonical`, `sameRow`); plan.md F-2, F-6
  - substrate: `sync-engine`
  - verify: `npx vitest run tests/stack/lww-conflict.test.ts`
- [x] T015a [sub-of: T015] Reconcile `drivePullOnly` with the post-T010a harness: an offline-suppressed push produces no counted settle, so a pull-only cycle yields 1 settle while `driveSyncCycle` now waits for 2 — deterministic timeout once the T010a fix and the lane's workaround merged together. Add a `settles` option to `driveSyncCycle` (default 2) and have `drivePullOnly` pass 1
  - Write: `tests/harness/sync.ts`, `tests/stack/lww-conflict.test.ts`
  - Read: `tests/harness/sync.ts`; `tests/stack/lww-conflict.test.ts:155-190`; `src/sync/sync.ts:176-190`
  - substrate: `sync-engine`
  - verify: `npm test -- --run` fully green twice consecutively
- [x] T016 [US2] Add the lockstep assertion (acceptance 5) and record the demonstration required by spec.md SC-008: document in the test file's header comment which single-sided change makes which assertion fail, and perform that mutation once locally to confirm it (mutating only the test's own inputs — never `src/` or `supabase/`)
  - Write: `tests/stack/lww-conflict.test.ts`
  - Read: `CLAUDE.md` "LWW lockstep"; `docs/decisions/ADR-0001-fork-contract.md` §3; spec.md SC-008
  - substrate: `sync-engine`, `supabase-schema`
  - verify: `npx vitest run tests/stack/lww-conflict.test.ts`, plus the recorded one-off mutation demonstration noted in the file header

---

## TG-5: US3 — RLS pinning with two accounts (P1)

**Goal**: prove reads are `user_id`-scoped and writes additionally workspace-ownership-checked, and
that the asymmetry is pinned in both directions. **Independent test**:
`npx vitest run tests/stack/rls-two-accounts.test.ts` alone, green.

- [x] T017 [US3] Write `tests/stack/rls-two-accounts.test.ts` acceptance 1–3 using two independently constructed clients: B lists A's rows and gets an empty result (not an error); B's insert into A's workspace id is refused; B's insert into B's own workspace succeeds
  - Write: `tests/stack/rls-two-accounts.test.ts`
  - Read: `ARCHITECTURE.md §3` L243–L262 (ownership, the read/write asymmetry, `schema.sql:241,248,249-253`); `docs/validation-map.md` lines 124-138 (the correction); plan.md D-3, D-6
  - substrate: `supabase-schema`, `supabase-auth`
  - verify: `npx vitest run tests/stack/rls-two-accounts.test.ts`
- [x] T018 [US3] Add acceptance 4 — assertions structured so that tightening the read half to match the write half, or loosening the write half to match the read half, each break at least one assertion; record which assertion catches which direction in the file header (spec.md SC-008)
  - Write: `tests/stack/rls-two-accounts.test.ts`
  - Read: `CLAUDE.md` "Additive tables, replaced policies"; `ARCHITECTURE.md §3` L243–L262; spec.md US3 acceptance 4
  - substrate: `supabase-schema`
  - verify: `npx vitest run tests/stack/rls-two-accounts.test.ts`, plus the recorded two-direction mutation demonstration

---

## TG-6: US4 — local-cache account claim (P2)

**Goal**: pin `claimCache`/`wipeLocal` single-account behaviour. Needs no Docker.
**Independent test**: `npx vitest run tests/local/claim-cache.test.ts` alone, green, stack down.

- [x] T019 [US4] Write `tests/local/claim-cache.test.ts` covering all four US4 acceptances: same-account re-claim wipes nothing and keeps cursors; different-account claim wipes all cached rows before any read and records the new owner; a wipe also clears the `synced_at:<table>` cursors; a fresh unclaimed cache claims without a wipe
  - Write: `tests/local/claim-cache.test.ts`
  - Read: `ARCHITECTURE.md §3` L263–L279 (Dexie stores, `meta` keys, `_dirty`); `src/db/local.ts:89-125`; plan.md D-4
  - substrate: `local-cache`
  - verify: `npx vitest run tests/local/claim-cache.test.ts` — passes with the local stack stopped
- [x] T020 [P] [US4] Assert in the same file that this tier requires no network and no Docker (no stack access), so the Docker-free half of CI stays honest
  - Write: `tests/local/claim-cache.test.ts`
  - Read: ADR-0002 Consequences (four of five CI checks Docker-free); spec.md FR-008
  - substrate: `local-cache`
  - verify: `npx vitest run tests/local/` with Docker stopped

---

## TG-7: US5 — soft-delete propagation (P2)

**Goal**: prove a deleted row syncs as deleted and a late child into a deleted workspace is forced
dead. **Independent test**: `npx vitest run tests/stack/soft-delete.test.ts` alone, green.

- [x] T021 [US5] Write `tests/stack/soft-delete.test.ts` acceptance 1 and 4: a row marked deleted on one client arrives deleted at a second client, and no deleted row flips back to live across repeated cycles
  - Write: `tests/stack/soft-delete.test.ts`
  - Read: `ARCHITECTURE.md §3` L226–L242 (deletion is soft everywhere); `ARCHITECTURE.md §4` L331–L356; plan.md D-5
  - substrate: `sync-engine`, `supabase-schema`
  - verify: `npx vitest run tests/stack/soft-delete.test.ts`
- [x] T022 [US5] Add acceptance 2–3: a live child row sent into an already-deleted workspace is stored deleted (`stay_deleted_with_workspace`), and after a workspace delete none of its children is live (`follow_workspace_delete`, with `updated_at = greatest(updated_at, now())`)
  - Write: `tests/stack/soft-delete.test.ts`
  - Read: `ARCHITECTURE.md §4` L379–L393 (trigger table, alphabetical firing order `keep_newer` → `stay_deleted` → `synced_at`); `supabase/schema.sql:158-190, 207-218` (read-only)
  - substrate: `supabase-schema`
  - verify: `npx vitest run tests/stack/soft-delete.test.ts`

---

## TG-8: US6 — one command, CI, receipts, map

**Goal**: the whole body of evidence runs unattended and the map tells the truth afterwards.
**Independent test**: fresh clone + Docker → `npm test` → green; CI run green on the PR.

- [ ] T023 [US6] Confirm and document the single command: `npm test` runs both tiers with stack start and ordered schema apply handled by `globalSetup`; record it in `docs/project-structure.md` under a run/test-commands section (that section does not exist yet — add it; the file currently documents only the map grammar)
  - Write: `docs/project-structure.md`
  - Read: plan.md D-7; spec.md FR-010, SC-003; `docs/project-structure.md` (map grammar, `verify:` field at line 45)
  - substrate: `env-boot`, `supabase-schema`
  - verify: `npm test` from a clean checkout with Docker running exits 0
- [ ] T024 [US6] Complete the staged block in `.github/workflows/ci.yml:46-58` — uncomment `start supabase` (`npx supabase start`) and `test` (`npm test -- --run`), keep the explanatory dev-keys comment, and leave install/typecheck/lint/build Docker-free
  - Write: `.github/workflows/ci.yml`
  - Read: plan.md D-8; ADR-0002 Consequences; ADR-0003 Consequences ("the CI test step stays commented until the first vitest suite exists" — it now exists); `CLAUDE.md` → `infra` role
  - substrate: `env-boot`
  - verify: CI run on the feature branch is green, with `test` present as a step and the four other steps unchanged
- [ ] T025 [US6] Verify the fresh-operator path (spec.md SC-004/FR-015): clone to a clean directory, install, run the one command with no `.env.local` and no secret supplied; record the outcome as the receipt text for the map
  - Write: `specs/001-validation-spine/receipts.md`
  - Read: spec.md FR-009, FR-015, SC-004, SC-006; plan.md D-2, D-7
  - substrate: `env-boot`, `supabase-schema`
  - verify: named manual check — fresh-clone run recorded with command, date, SHA and result
- [ ] T026 [US6] Flip `docs/validation-map.md` entries the suite now covers — `sync-engine`, `local-cache`, `supabase-schema`, and `supabase-auth` / `db-api` only if their coverage genuinely warrants it — filling `status`, `verify:` (the real command), `tests:` (real paths), `last-verified: <sha> <date>`, `sign-off: Andrii Tkhorenko (single-operator)`
  - Write: `docs/validation-map.md`
  - Read: `docs/project-structure.md` (map grammar); `CLAUDE.md` "Definition of done"; plan.md D-9, "Validation substrate"; T025's receipts
  - substrate: all of the above (this task is where their status changes)
  - verify: named manual check — every flipped entry names a command that was actually run, and no entry claims VALIDATED without a receipt
- [ ] T027 [US6] Update the four scenario entries — `s-offline-edit-sync`, `s-conflict-lww`, `s-account-switch-wipe`, `s-workspace-delete-cascade` — from "manual walk only" to the automated test path and outcome, and flip each scenario's `status:` field using the closed vocabulary (VALIDATED on a passing receipt, BROKEN otherwise — never left at UNTESTED once the suite covers it) (spec.md SC-002, FR-012)
  - Write: `docs/validation-map.md`
  - Read: `docs/validation-map.md` "Scenarios" block (lines 231-281); spec.md SC-002; `docs/project-structure.md` scenario-entry grammar (lines 54-64)
  - substrate: `sync-engine`, `local-cache`, `supabase-schema`
  - verify: named manual check — each of the four scenarios names its test file, its recorded outcome, and a `status:` value from the closed vocabulary that is no longer UNTESTED
- [ ] T028 [US6] Record FINDINGS produced along the way (plan.md F-1/F-2/F-3 if confirmed, F-5 sign-out ordering as the accepted P0 gap P1 inherits, F-6 as resolved) in `specs/001-validation-spine/receipts.md` and, where a component behaved contrary to documentation, as a `BROKEN` map entry with an owner decision pending
  - Write: `specs/001-validation-spine/receipts.md`, `docs/validation-map.md`
  - Read: spec.md FR-013, Edge Cases; plan.md "Risks, seams and candidate FINDINGS"
  - substrate: —
  - verify: named manual check — every FINDING names the observed vs documented behaviour; no assertion was weakened to make the suite green
- [ ] T029 [US6] Commit the map and receipts together with the suite (`test:`/`ci:`/`docs:` messages, upstream style, owner identity, no assistant mentions) and confirm the feature's Definition of Done: map updated in the same PR, verify commands actually run, CI green, no credential in the diff, nothing outside the spec
  - Write: — (git only)
  - Read: `CLAUDE.md` → Git, Definition of done
  - substrate: —
  - verify: `git log --stat` shows the map change in the same PR as the tests; `git diff` contains no key or token; CI green

**Checkpoint**: P0's gate is clearable — P1 may be planned against validated substrate.

---

## Dependencies & Execution Order

- **TG-1 → TG-2** are hard gates: nothing story-shaped starts before the harness exists.
- **TG-3 … TG-7** each depend only on TG-2, not on each other. They are sequenced by story priority
  (US1 → US2 → US3 → US4 → US5) rather than by technical need; a second operator could take TG-6 in
  parallel from TG-1 alone, since the local tier needs neither the stack nor TG-2.
- **TG-8** depends on every story taskgroup that is intended to ship: the map must not be flipped for
  a component whose tests are not merged.
- Within a taskgroup, tasks that write the *same* test file (T012/T013, T014–T016, T017/T018,
  T021/T022) are strictly sequential.

**MVP scope**: TG-1 + TG-2 + TG-3 (US1). That alone is the first executable receipt in the repo and
is worth merging on its own.

---

## Workfile & conflict map

| Task | Lane | Files |
|------|------|-------|
| T001 | serial | `package.json`, `package-lock.json` |
| T002 | serial | `vitest.config.ts` |
| T003 | wt/setup-idb | `tests/setup.ts` |
| T004 | wt/tests-readme | `tests/README.md` |
| T005 | wt/harness-stack | `tests/harness/stack.ts` |
| T006 | wt/harness-schema | `tests/harness/schema.ts` |
| T007 | wt/harness-schema | `tests/stack/schema-apply.test.ts` |
| T008 | serial | `tests/harness/global-setup.ts` |
| T009 | wt/harness-accounts | `tests/harness/accounts.ts` |
| T010 | wt/harness-sync | `tests/harness/sync.ts` |
| T011 | wt/harness-seed | `tests/harness/seed.ts` |
| T012 | wt/us1-roundtrip | `tests/stack/offline-round-trip.test.ts` |
| T013 | wt/us1-roundtrip | `tests/stack/offline-round-trip.test.ts` |
| T014 | wt/us2-lww | `tests/stack/lww-conflict.test.ts` |
| T015 | wt/us2-lww | `tests/stack/lww-conflict.test.ts` |
| T016 | wt/us2-lww | `tests/stack/lww-conflict.test.ts` |
| T017 | wt/us3-rls | `tests/stack/rls-two-accounts.test.ts` |
| T018 | wt/us3-rls | `tests/stack/rls-two-accounts.test.ts` |
| T019 | wt/us4-cache | `tests/local/claim-cache.test.ts` |
| T020 | wt/us4-cache | `tests/local/claim-cache.test.ts` |
| T021 | wt/us5-delete | `tests/stack/soft-delete.test.ts` |
| T022 | wt/us5-delete | `tests/stack/soft-delete.test.ts` |
| T023 | serial | `docs/project-structure.md` |
| T024 | serial | `.github/workflows/ci.yml` |
| T025 | serial | `specs/001-validation-spine/receipts.md` |
| T026 | serial | `docs/validation-map.md` |
| T027 | serial | `docs/validation-map.md` |
| T028 | serial | `specs/001-validation-spine/receipts.md`, `docs/validation-map.md` |
| T029 | serial | — (git only) |

**Conflicts of record**: `docs/validation-map.md` is written by T026, T027 and T028 — all `serial`
and all in TG-8, in that order; they must never be split across parallel lanes. Same for
`specs/001-validation-spine/receipts.md` (T025 creates, T028 appends). Tasks sharing a `wt/` lane
share one file and run in listed order within that lane. No task writes anything under `src/` or
`supabase/`; a diff touching either is a finding, not a task outcome.
