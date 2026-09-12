# Implementation Plan: P0 Validation Spine

**Branch**: `001-validation-spine` | **Date**: 2026-09-12 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-validation-spine/spec.md`

## Summary

Stand up a test harness and a first body of executable evidence for **existing, unmodified**
upstream behaviour on the four HIGH-tier surfaces (sync engine, local cache, schema/RLS/triggers,
and the migration convention), so that the P1 team transform lands on validated substrate
(ADR-0002 gate rule).

Approach: **vitest** (ADR-0003) driving the **`supabase` CLI local stack** in Docker (ADR-0002) —
real Postgres, real `own_rows` policies, real `keep_newer` / `stay_deleted_with_workspace` /
`synced_at` triggers. The stack's schema is built by applying `supabase/schema.sql` and
`supabase/migration-002…006.sql` **in order, explicitly**, from vitest `globalSetup`; that ordered
apply is simultaneously the only automated check the hand-run migration convention will ever get
(ADR-0001 §4). Two-account scenarios are two independently-constructed `supabase-js` clients in one
vitest process — no browser, no Playwright. IndexedDB is provided by `fake-indexeddb` under a
`jsdom` environment so the real Dexie code runs unmodified. **No file under `src/` is touched**;
everything lands in `tests/`, `vitest.config.ts`, `package.json` scripts, `.github/workflows/ci.yml`
and `docs/`. An untestable seam is a FINDING for the owner, never a refactor (spec FR-002).

## Validation substrate

| Map entry | Status at planning | Debt task needed? |
|-----------|--------------------|-------------------|
| `sync-engine` | UNTESTED | **no external task — this feature IS the debt-clearing work** (US1, US2, US5) |
| `local-cache` | UNTESTED | **no external task — this feature IS the debt-clearing work** (US4, and the cache half of US1) |
| `supabase-schema` | UNTESTED | **no external task — this feature IS the debt-clearing work** (US2 server half, US3, US5; ordered migration apply covers the migration convention) |
| `supabase-auth` | UNTESTED | incidental — exercised by US3/US4 account handling; status flip is an outcome, not a goal |
| `db-api` | UNTESTED | incidental — exercised as the write path in US1/US5; status flip is an outcome, not a goal |
| `env-boot` | VALIDATED (`88e74aa`, 2026-09-12) | no |

**Why every row says "no" to an external debt task.** The normal reading of this table is
"UNTESTED substrate on the feature's path must be cleared by a prior task". That rule cannot apply
here: this feature *is* that prior task for the whole fork. P0 exists precisely because all four
HIGH entries are UNTESTED, and its deliverable is their receipts (spec SC-001). Pointing these rows
at an external blocker would be circular. They are therefore satisfied **inside this feature's own
task list**, and the phase gate they serve is P1's, not P0's.

The two incidental rows are recorded because the evidence unavoidably runs through them. Whether
they also reach `VALIDATED` depends on how completely the written tests cover them; that judgement
is made at receipt-writing time, not asserted here.

## Technical Context

**Language/Version**: TypeScript ~6.0 / ESM, Node 22 (CI pin), React 19 app

**Primary Dependencies**: existing — `@supabase/supabase-js` ^2.114, `dexie` ^4.4, `vite` ^8.2,
`supabase` CLI ^2.117 (already a devDependency; invoked as `npx supabase`).
To be added, dev-only: `vitest`, `jsdom`, `fake-indexeddb`, `pg` (ordered SQL apply).

**Storage**: Postgres via the local stack (`postgresql://postgres:postgres@127.0.0.1:54322/postgres`),
API at `http://127.0.0.1:54321`, Studio at `:54323`; `supabase/config.toml` is committed. Client-side
storage is Dexie/IndexedDB (`dandori` DB) plus `localStorage` for the auth session.

**Testing**: vitest (ADR-0003). Two tiers in one runner — a *stack* tier that needs Docker, and a
*local* tier (cache/claim behaviour) that does not.

**Target Platform**: developer workstation (Windows/macOS/Linux) + `ubuntu-latest` in CI; Docker
required only for the stack tier.

**Project Type**: single-project web app (Vite SPA, no server component).

**Performance Goals**: not a goal of this feature. The only timing constraint is that the suite is
short enough to run on every change; target under five minutes wall-clock in CI including stack
start.

**Constraints**:
- No modification of any file under `src/` or `supabase/` (spec FR-002). This includes **not**
  moving or copying upstream SQL into `supabase/migrations/` — that directory is the CLI's
  convention, not upstream's, and creating it is a merge surface against upstream.
- Zero credentials committed; the local stack's well-known dev keys are not credentials (FR-009).
- No browser automation (ADR-0003).
- A failing check is a FINDING, not a softened assertion (FR-013).

**Scale/Scope**: 6 user stories, ~5 test files, one harness directory, one config file, one CI edit,
one validation-map update. ~500 lines of `src/sync/sync.ts` and ~125 lines of `src/db/local.ts` are
the behaviour under observation.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is **still the unfilled spec-kit template** — every principle is a
`[PRINCIPLE_N_NAME]` placeholder. There are therefore **no constitutional gates to evaluate**, and
none are invented here.

The governing constraints for this feature are the accepted ADRs, which are checked instead:

| Constraint | Source | Status |
|---|---|---|
| Test framework is vitest; Playwright deferred to P2 | ADR-0003 | PASS — vitest only |
| Backend is the `supabase` CLI local stack, not a fake | ADR-0002 | PASS |
| Two-account scenarios need no browser | ADR-0002 corollary | PASS — two `supabase-js` clients |
| Zero credentials in repo | ADR-0002 corollary | PASS — dev keys only |
| No fork feature work in P0 | ADR-0002 | PASS — tests/harness/CI/docs only |
| LWW lockstep: both enforcement points pinned together | ADR-0001 §3, ARCHITECTURE §4 | PASS — US2 covers both |
| RLS read/write asymmetry preserved and pinned | ARCHITECTURE §3, `schema.sql:249-253` | PASS — US3 covers both halves |
| Non-visible outcome accepted | ADR-0002 Consequences | PASS — recorded in spec SC-009 |

Post-design re-check: unchanged — no design element below requires an ADR exception, and
Complexity Tracking is empty.

## Key technical decisions

Phase-0 research is consolidated here rather than in a separate `research.md`; per the coordinator's
instruction this planning step produces `plan.md` only.

### D-1 — Ordered SQL apply via a Node `pg` client, not `supabase db reset`

**Decision**: `tests/harness/schema.ts`, called from vitest `globalSetup`, connects to
`127.0.0.1:54322` with `pg` and executes, in this exact order, `supabase/schema.sql`,
`migration-002-note-link-and-mute.sql`, `-003-synced-at`, `-004-gcal`, `-005-gcal-placed`,
`-006-lww-and-ownership`.

**Rationale**: the CLI's `db reset` reads `supabase/migrations/`, which upstream does not have — its
migrations sit at `supabase/migration-00N-*.sql` in the package root. Making `db reset` work would
mean moving or duplicating upstream's SQL, i.e. manufacturing a merge conflict surface for every
future upstream pull, and it would violate FR-002. A `pg` client needs no `psql` binary on PATH
(Windows-friendly), executes multi-statement SQL including `$$`-quoted function bodies, and makes the
ordering explicit and assertable. The files are written idempotent (`create or replace`,
`if not exists`, `drop … if exists`), so re-application on an already-seeded stack is safe.

**Alternatives rejected**: `supabase db reset` (needs the file move); `psql` shell-out (binary not
guaranteed on Windows or on the runner); a hand-written DDL fixture (re-states the assumptions under
test — explicitly rejected by ADR-0002).

### D-2 — Env injection through vitest config, not `.env.local`, not a source change

**Decision**: `vitest.config.ts` sets `test.env.VITE_SUPABASE_URL` and
`test.env.VITE_SUPABASE_ANON_KEY` to the local stack's fixed values, so `import.meta.env` resolves
when `src/auth/supabase.ts` is imported.

**Rationale**: `src/auth/supabase.ts` throws at module load when those two variables are missing —
so any test that imports `src/sync/sync.ts` (which imports the client) must have them present
*before* import. Injecting them from the test config keeps the operator free of setup steps (FR-015,
SC-004), keeps `.env.local` out of the loop, and touches no source. The values are the stack's
published dev keys, exempt from FR-009 by ADR-0002's corollary; the config carries a comment saying
so, so a future reader does not mistake them for a leak.

### D-3 — The singleton client is for the sync tests; two-account tests build their own clients

**Decision**: sync-engine tests (US1, US2 client half, US5) use the app's own singleton
(`src/auth/supabase.ts`) signed in as one account. RLS tests (US3) never touch the singleton — they
call `createClient` directly to build two clients, A and B, each with its own session and
`persistSession: false`.

**Rationale**: the app's client is a module-level singleton with `persistSession: true`
(`src/auth/supabase.ts:12-17`) — one account per module by construction, which is exactly the
single-account assumption P1 will widen. Trying to drive two accounts through it would be a source
change. Constructing clients directly is what ADR-0002's "two supabase-js clients in one vitest
process" already describes, and it observes RLS where RLS actually lives — at the API layer.

### D-4 — `fake-indexeddb` under `jsdom` (this closes ADR-0003's open question)

**Decision**: environment `jsdom`, with `fake-indexeddb/auto` imported from a setup file. Dexie runs
unmodified against it; `localStorage`, `window` and `document` come from jsdom.

**Rationale**: ADR-0003 left "how to run IndexedDB-dependent tests" to P0. Three candidates: a real
browser (excluded by ADR-0003 until P2), a Dexie backing-store substitute (would replace the code
path under test — the same objection that rules out a fake Postgres), or an in-process IndexedDB
implementation. `fake-indexeddb` keeps the real Dexie schema, the real transactions, and the real
`claimCache`/`wipeLocal` code on the real API; it is per-process and resettable between files, which
gives cheap isolation. jsdom is required anyway — not for rendering, which this feature never does,
but because `startSync()` registers `online`/`offline`/`visibilitychange` listeners on `window` and
`document` (`src/sync/sync.ts:491-494`) and the auth client wants `localStorage`. happy-dom was
considered and passed over only for jsdom's more complete storage/event surface; nothing in this
plan depends on the choice, and swapping it later costs one config line.

### D-5 — Driving a sync cycle deterministically

**Decision**: tests call `startSync()`, which fires one push+pull cycle immediately
(`src/sync/sync.ts:496`), then wait for the cycle to settle by subscribing to `onSyncState` (and, as
a backstop, polling Dexie for the expected row with a bounded timeout). Every test `stop()`s the
handle in teardown so the 60 s interval and the listeners do not leak into the next file.
`flushQueue()` is used where only the push half is wanted — it is exported and awaitable
(`src/sync/sync.ts:304`).

**Rationale**: this is the only seam that reaches the pull path without changing source (see F-1).
`requestPush()` is 400 ms-debounced and therefore not directly awaitable; `flushQueue()` is.

### D-6 — Test isolation by fresh accounts, not by truncation

**Decision**: each stack-tier test file provisions its own user(s) through the Auth admin API using
the stack's local `service_role` key, and works inside workspaces it creates itself. The stack tier
runs with file parallelism disabled; the local tier runs in parallel.

**Rationale**: truncating between tests would also destroy the trigger and policy state the evidence
depends on, and would make ordering-dependent failures (spec Edge Cases) likely. Per-account
isolation is what RLS is for, so using it is also incidental evidence that it works. Admin
provisioning avoids depending on whether email confirmation is enabled in `config.toml`.

### D-7 — One command, and the same command in CI

**Decision**: `npm test` → `vitest --run`. Its `globalSetup` checks the stack is reachable at
`127.0.0.1:54321`, runs `npx supabase start` if it is not, then applies the SQL (D-1). If Docker is
absent, the run **fails loudly naming Docker and `npx supabase start`** — it never skips the stack
tier silently (FR-014). Documented in `docs/project-structure.md` (run commands) and referenced from
the validation-map `verify:` fields.

**Rationale**: FR-010/SC-003 want one command from a fresh clone; auto-starting the stack is what
makes that literally true. In CI the staged block's explicit `start supabase` step is kept, so the
log shows stack start separately and `globalSetup`'s check becomes a no-op.

### D-8 — CI completion

**Decision**: uncomment and complete the staged block in `.github/workflows/ci.yml:46-58` —
`npx supabase start` then `npm test -- --run` — leaving the existing install/typecheck/lint/build
steps Docker-free, and keeping the explanatory comment about the dev keys.

**Rationale**: ADR-0002 Consequences require the four non-stack checks to stay runnable without
Docker; the file was staged for exactly this edit.

### D-9 — Receipts and map update are part of the feature

**Decision**: on a green run, `docs/validation-map.md` entries `sync-engine`, `local-cache`,
`supabase-schema` (and, if warranted, `supabase-auth` / `db-api`) get `status: VALIDATED`, a real
`verify:` command, `tests:` paths, `last-verified: <sha> <date>` and a sign-off; the four scenario
entries get the same treatment. A failing check instead produces a `BROKEN` entry plus a FINDING
(FR-013).

## Project Structure

### Documentation (this feature)

```text
specs/001-validation-spine/
├── plan.md              # This file
├── spec.md              # Approved
├── checklists/
│   └── requirements.md  # Spec quality checklist (passed)
└── tasks.md             # NOT created by /speckit-plan — next step
```

`research.md`, `data-model.md`, `contracts/` and `quickstart.md` are **deliberately not produced**:
the coordinator scoped this step to `plan.md` only. Their content has no separate home here anyway —
Phase-0 research is the Key technical decisions section above; there is no new data model (the
feature adds no entities, it observes existing ones); there is no new external contract (nothing is
exposed to a consumer); and the quickstart is one command (D-7), which belongs in
`docs/project-structure.md` rather than in a per-feature file.

### Source Code (repository root)

```text
tests/
├── setup.ts                 # fake-indexeddb/auto; per-file Dexie reset
├── harness/
│   ├── schema.ts            # ordered apply: schema.sql + migration-002..006  (D-1)
│   ├── stack.ts             # reachability check / `npx supabase start`; local URLs + dev keys
│   ├── accounts.ts          # admin-API user provisioning, client factory      (D-3, D-6)
│   └── sync.ts              # drive one cycle; wait-for-settle helpers         (D-5)
├── stack/
│   ├── offline-round-trip.test.ts     # US1
│   ├── lww-conflict.test.ts           # US2 (server refusal + client merge)
│   ├── rls-two-accounts.test.ts       # US3 (read rule and write rule, separately)
│   └── soft-delete.test.ts            # US5
└── local/
    └── claim-cache.test.ts            # US4 (no Docker)

vitest.config.ts             # jsdom, setup files, test.env dev keys, globalSetup  (D-2, D-4)
package.json                 # + "test" script; + vitest/jsdom/fake-indexeddb/pg devDeps
.github/workflows/ci.yml     # staged block completed                             (D-8)
docs/validation-map.md       # receipts, status flips                             (D-9)
docs/project-structure.md    # the one documented command
```

**Structure Decision**: single project, tests in a top-level `tests/` tree mirroring the two tiers
(`stack/` needs Docker, `local/` does not) with shared code under `tests/harness/`. Nothing is added
inside `src/` or `supabase/` — the untouched-source constraint (FR-002) is enforced structurally, so
a violation shows up as a diff in the wrong directory rather than as a judgement call in review.

## Risks, seams and candidate FINDINGS

Recorded at planning time; each is confirmed or dismissed during implementation, and a confirmed one
goes to the owner as a FINDING rather than becoming a refactor (FR-002).

- **F-1 (likely, accepted): the pull half has no exported entry point.** `src/sync/sync.ts` exports
  `flushQueue()` (push) but `pull()` is reachable only through `startSync()`, which also starts a
  60 s interval and three DOM listeners and does not return a promise for its first cycle. D-5's
  settle-wait is the workaround; it is a seam observation, not a blocker. If the wait proves flaky,
  that is the FINDING to file.
- **F-2 (likely): the client-side LWW comparators are module-internal.** `mergeRows`, `isNewer`,
  `isSameMoment`, `sameRow` and `canonical` are not exported, so US2's client-side acceptance
  scenarios are pinned *behaviourally* (observe Dexie after a pull) rather than as unit assertions.
  Adequate for the lockstep claim; if a specific case turns out unreachable behaviourally, it is a
  FINDING naming that case, not an export added to source.
- **F-3 (possible): singleton import side effects.** `src/auth/supabase.ts` throws on missing env at
  import and constructs a persisting client; if importing it across several vitest files leaks auth
  state between them, the mitigation is per-file isolation, and if that fails it is a FINDING.
- **F-4 (known trap, handled): migration location.** Upstream keeps migrations at
  `supabase/migration-00N-*.sql`; the CLI looks in `supabase/migrations/`. D-1 applies them
  explicitly. **Do not create `supabase/migrations/`.**
- **F-5 (open): sign-out ordering is not covered.** ARCHITECTURE §4 calls the four-step sign-out an
  ordering contract, and P1 changes its last step — but the ordering lives in `useSession.ts` /
  `Settings.tsx`, i.e. component code the no-browser tier cannot drive. It is out of this feature's
  six stories. Flagged for the owner as a coverage gap P1 inherits.
- **F-6 (open, minor): `gcal_placed`'s equal-stamp write path.** US2's equal-stamp acceptance is the
  case that exists *for* the calendar bookkeeping write, but the calendar surface is out of scope.
  The equal-stamp behaviour is pinned directly at the row level instead, without the calendar code.

## Complexity Tracking

No Constitution Check violations (the constitution is an unfilled template; the ADR checks above all
pass). Nothing to justify.
