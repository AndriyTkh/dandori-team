---

description: "Task list for 002-team-workspaces"
---

# Tasks: P1 Team Workspaces — the minimal team transform

**Input**: Design documents from `/specs/002-team-workspaces/`

**Prerequisites**: [plan.md](./plan.md) (required, whole — D-1..D-18 including D-6′ and the
correction on D-7, R-1..R-19, Owner questions,
Project Structure), [spec.md](./spec.md) (required for user stories),
[data-model.md](./data-model.md), [contracts/policies.sql](./contracts/policies.sql),
[contracts/rpc.md](./contracts/rpc.md). `research.md` and `quickstart.md` were deliberately not
produced — see plan.md, "Project Structure / Documentation".

**Tests**: Mandatory, and they come first on every HIGH-tier surface (ADR-0002 P-gate). The schema
and policy cards in TG-1 are each verified by a test file authored **before** them in the same
taskgroup. Every check written by `001-validation-spine` must pass **unedited** (FR-030, SC-003);
a P0 check that must change is a **FINDING for the owner, not an edit** — with the single, named
exception recorded on T004.

## Format: `[ID] [P?] [Role] Description`

- **[P]**: Can run in parallel (disjoint `Write:` sets, no dependency on an unfinished task)
- **[Role]**: the owning agent role from `CLAUDE.md` — `data` / `ui` / `infra` / `reviewer` /
  `coordinator` (+ `owner` where a step is performed by the fork owner in person)
- Every task carries `Write:` / `Read:` / `substrate:` / `verify:` / `done-when:` field lines, and
  `blocked-by:` where applicable.
- Taskgroup headers `## TG-N` are hard sequencing gates: TG-N+1 does not start before TG-N is
  merged and checked.

**Standing context for every task** (not repeated in each `Read:` line): `CLAUDE.md`,
`specs/002-team-workspaces/plan.md`, `specs/002-team-workspaces/spec.md`,
`docs/validation-map.md`, `docs/decisions/ADR-0001-fork-contract.md`,
`docs/decisions/ADR-0002-phase-gates.md`, `docs/decisions/ADR-0003-test-framework.md`,
`docs/decisions/ADR-0004-multi-origin-federation.md`, `docs/decisions/ADR-0005-schema-sql-canonical.md`. `Read:` lines name
what is needed **beyond** that. `ARCHITECTURE.md §N` line ranges come from
`docs/architecture-index.md`.

**Local stack facts** (verified in P0, do not rediscover): API `http://127.0.0.1:54321`, DB
`postgresql://postgres:postgres@127.0.0.1:54322/postgres`, Studio `:54323`, well-known local dev
keys committed in `vitest.config.ts`, `supabase` CLI is a devDependency (`npx supabase`), two vitest
projects — `stack` (Docker, single forked worker, 30s timeout) and `local` (Docker-free).

**Command facts** (verified at planning time): there is **no `npm run typecheck` script**;
`package.json` has `dev`, `build`, `lint`, `preview`, `icons`, `test`. CI's typecheck step is
`npx tsc -b --noEmit`, and that is the command written in every `verify:` line below. A file-scoped
stack run is `npm test -- --run --project stack tests/stack/<file>`; a local-tier run is
`npm test -- --run --project local tests/local/<file>`.

**Substrate status at planning time** (plan.md "Validation substrate"): `env-boot` VALIDATED,
`local-cache` VALIDATED, `supabase-schema` VALIDATED, `sync-engine` VALIDATED *(flaky receipt —
TG-0 repairs it)*, `db-api` **UNTESTED**, `supabase-auth` **UNTESTED (accepted risk F-5)**,
`views-core` / `task-dialog` UNTESTED (NORMAL), `chrome-components` / `i18n-state` UNTESTED (LOW),
`membership` / `team-rls` / `multi-account-cache` / `account-provisioning` **do not exist yet**
(new, HIGH). `sync-engine` additionally ends this feature **re-verified and re-signed**, because
D-18 changes the push path.

---

## TG-0: Map debt — clear it before any P1 code

**Purpose**: ADR-0002's gate — *no phase starts while the substrate it stands on is `UNTESTED`* —
bites in exactly two places. `db-api` is the door every one of the seven affordances goes through and
is `UNTESTED`. And `sync-engine` is `VALIDATED` on a **flaky** receipt, which is a map-discipline
problem, not a test problem. **Blocks TG-1 onward.**

- [x] T001 [P] [data] Write `tests/local/db-api-p1-surface.test.ts` pinning the `db-api` functions P1 touches **as they behave today**, before a single line of `src/db/api.ts` changes: `createWorkspace(name)` (row shape, `_dirty`, queued), `renameWorkspace(id, name)` (bumps `updated_at`, re-dirties), `deleteWorkspace(id)` (soft-deletes the workspace **and** its children), `updateTask(id, patch)` (patch semantics, `updated_at` bump, untouched fields preserved), `listWorkspaces()` (excludes deleted). Docker-free tier
  - Write: `tests/local/db-api-p1-surface.test.ts`
  - Read: `src/db/api.ts` (whole); `src/db/local.ts:20-125`; `ARCHITECTURE.md §4` L407–L424 (db-api surface); `ARCHITECTURE.md §3` L207–L242 (entities, three timestamps); plan.md "Validation substrate"; `tests/local/claim-cache.test.ts` (tier conventions)
  - substrate: `db-api` (UNTESTED — this task is what clears it), `local-cache` (VALIDATED)
  - verify: `npm test -- --run --project local tests/local/db-api-p1-surface.test.ts` — green with the stack stopped
  - done-when: the five functions named above each have at least one passing assertion against **current** behaviour, nothing under `src/` changed (FR-030 spirit; plan.md "the debt row that becomes the first tasks")
- [x] T002 [coordinator] Flip `db-api` to `VALIDATED` in `docs/validation-map.md` (`verify:` = T001's command, `tests:` = the new file, `last-verified: <sha> <date>`, `sign-off: Andrii Tkhorenko (single-operator)`) and create `specs/002-team-workspaces/receipts.md` with the run that backs it
  - Write: `docs/validation-map.md`, `specs/002-team-workspaces/receipts.md`
  - Read: `docs/project-structure.md` (map grammar, `verify:` field); `specs/001-validation-spine/receipts.md` (receipt shape); plan.md D-15
  - substrate: `db-api` (this task is where its status changes)
  - verify: named manual check — the `db-api` entry names a command that was actually run, and `receipts.md` carries that run's output, date and SHA
  - done-when: `db-api` is `VALIDATED` with a receipt; no other entry moved (FR-031)
  - blocked-by: T001
- [x] T003 [data] Reproduce and root-cause the P0 flake found 2026-09-13: CI run `https://github.com/AndriyTkh/dandori-team/actions/runs/34744308875` at main `526758a` failed `tests/stack/soft-delete.test.ts:91` acceptance 1 ("a row deleted on one client arrives deleted at a second client") with `AssertionError: expected undefined to be defined`; it also failed once locally when two stack suites overlapped. Loop the file 10× and record pass/fail per run. **Suspected seam** (confirm or refute, do not assume): the settle-wait. `tests/harness/sync.ts:81-93` counts two *rests* after one `syncing`, while the file's own private `drivePushAndPullCycle` (`tests/stack/soft-delete.test.ts:44-72`) resets `leftInitial` after each settle and therefore requires two *separate* `syncing` entries — so a pull that settles without re-entering `syncing`, or a `push()`-only settle (receipts F-1 class), leaves the third cycle's pull unperformed and `db.tasks.get(taskId)` undefined
  - Write: `specs/002-team-workspaces/receipts.md`
  - Read: `tests/stack/soft-delete.test.ts:1-100`; `tests/harness/sync.ts` (whole); `src/sync/sync.ts:176-190`, `:462-507`, `:43-78` (read-only); `specs/001-validation-spine/receipts.md` F-1; plan.md R-14
  - substrate: `sync-engine` (VALIDATED, on the receipt this task repairs)
  - verify: `for ($i=1; $i -le 10; $i++) { npm test -- --run --project stack tests/stack/soft-delete.test.ts }` — the 10 outcomes recorded verbatim in `receipts.md`, and the failing run's mechanism named
  - done-when: the flake is reproduced or the 10× loop is green and that is recorded as such; the root cause is stated as a mechanism in `src/sync/sync.ts` or in the harness, not as "timing" (SC-003 discipline; FR-030 exception named on T004)
  - blocked-by: T002
- [x] T004 [data] Fix the flake **inside `tests/harness/` or `tests/stack/` only** — normally the single settle-wait mechanism in `tests/harness/sync.ts`, with `tests/stack/soft-delete.test.ts`'s private `drivePushAndPullCycle` deleted in favour of it. **Boundary**: if the fix requires a change under `src/sync/`, stop — that is a **FINDING for the owner**, not an edit (CLAUDE.md, `data` role; plan.md R-14). **The one named exception to FR-030**: replacing `soft-delete.test.ts`'s private cycle-driver is a P0 *debt repair* performed before 002 touches anything, not an accommodation of this feature; **no assertion, acceptance or expectation in that file may change**, the edit is recorded in `receipts.md`, and "P0 passes unedited" for the rest of this feature is measured against the post-T004 baseline SHA
  - Write: `tests/harness/sync.ts`, `tests/stack/soft-delete.test.ts`
  - Read: T003's recorded root cause; `tests/harness/sync.ts`; `tests/stack/offline-round-trip.test.ts` (the other local driver, for consistency); `src/sync/sync.ts:176-190`, `:462-507` (read-only)
  - substrate: `sync-engine`
  - verify: `for ($i=1; $i -le 10; $i++) { npm test -- --run --project stack tests/stack/soft-delete.test.ts }` — 10/10 green
  - done-when: 10/10 green; `git diff tests/stack/soft-delete.test.ts` shows no change to any `expect(...)`, `it(...)` title or acceptance comment; `git diff src/` is empty (SC-003 discipline; FR-030 exception named on T004)
  - blocked-by: T003
- [x] T004a [data] [sub-of: T004] Swap `tests/stack/offline-round-trip.test.ts`'s private `drivePushAndPullCycle` (same two-settle defect as T004's, 9 call sites) for the harness `driveSyncCycle`. Owner-approved 2026-09-14 as the second recorded FR-030 exception; no `expect(...)`, `it(...)` title or acceptance comment may change
  - Write: `tests/stack/offline-round-trip.test.ts`
  - Read: `tests/harness/sync.ts` (post-T004 `driveSyncCycle`, `flushFirst`); `tests/stack/soft-delete.test.ts` (the T004 swap, as the pattern); `specs/001-validation-spine/receipts.md` "sync-engine receipt repaired"
  - substrate: `sync-engine` (VALIDATED at ec12db6)
  - verify: `npx vitest run --project stack tests/stack/offline-round-trip.test.ts` 10/10 green, then `npx vitest run --project stack` green
  - done-when: 10/10 green; `git diff` shows no changed `expect`/`it`/acceptance text; `git diff src/` empty; recorded in 001 receipts
  - blocked-by: T004
- [x] T005 [coordinator] Re-run the full suite twice consecutively and re-sign the `sync-engine` receipt in `specs/001-validation-spine/receipts.md` — the existing receipt is flaky and a `VALIDATED` entry standing on it is a map-discipline defect (map flip + receipt re-sign is a coordinator duty). `data` hands `coordinator` the two consecutive local run logs plus the failing and new green CI URLs; `coordinator` records both local runs, the failing CI URL, and the new green CI URL, and updates `docs/validation-map.md`'s `sync-engine` `last-verified` to the fixed SHA
  - Write: `specs/001-validation-spine/receipts.md`, `docs/validation-map.md`
  - Read: `specs/001-validation-spine/receipts.md` "Full-suite receipt" and "CI receipt" sections; `CLAUDE.md` "Definition of done"; T003/T004 records; the two run logs and CI URLs handed off by `data`
  - substrate: `sync-engine`, `supabase-schema`, `local-cache`, `env-boot`
  - verify: `npm test -- --run` fully green twice consecutively, plus a green CI run on `002-team-workspaces` whose URL is recorded
  - done-when: `sync-engine`'s receipt names a run that is reproducible 10/10 and a green CI URL; the old flaky CI URL is kept in the record, not erased (SC-003 discipline, CLAUDE.md reviewer duty 5)
  - blocked-by: T004
- [x] T006 [P] [reviewer] R-10 check, **report only, edit nothing**: grep every P0 test and harness file for assertions on the `SYNCED_TABLES` / `SYNCED_COLUMNS` **set as a whole** (as opposed to a member of it) and report which would break when `members` becomes the fifth table and `assignee`/`kind` join the column maps. Known starting points at planning time: `tests/local/claim-cache.test.ts:3,18,76,96` iterate `SYNCED_TABLES`; `tests/stack/offline-round-trip.test.ts:75` derives `TASK_COLUMNS` from `Object.keys(SYNCED_COLUMNS.tasks)`. Per FR-030 a P0 check that must change is a FINDING for the owner — this task establishes whether one exists, **before** TG-2 widens the constants
  - Write: — (read-only; the finding list goes to the coordinator in the task report, no file written)
  - Read: `tests/local/claim-cache.test.ts`; `tests/stack/*.test.ts`; `tests/harness/*.ts`; `src/db/types.ts` (`SYNCED_TABLES`, `SYNCED_COLUMNS`, the `satisfies` guard); spec.md FR-030, SC-003; plan.md D-8 "Verification obligation", R-10
  - substrate: `sync-engine`, `local-cache`, `db-api`
  - verify: `npm test -- --run` green before the widening (baseline), plus the named manual check — every `SYNCED_TABLES`/`SYNCED_COLUMNS` reference in `tests/` is listed with a verdict of "member-wise, survives" or "set-wise, FINDING"
  - done-when: a complete list exists with one verdict per reference; **no file under `tests/` or `src/` was modified by this task**
  - blocked-by: T002

**Checkpoint**: the two substrate entries P1 stands on directly — `db-api` and `sync-engine` — are
`VALIDATED` on receipts that reproduce. TG-1 may start.

---

## TG-1: Schema, helpers, triggers, policies, RPCs — and the evidence that gates them

**Owner decisions 2026-09-14 (recorded in `specs/002-team-workspaces/receipts.md`):** `supabase-auth` carries an `accepted-risk:` for P1 harness work; every 002 test that seeds `members` clears `db.members` itself (`tests/setup.ts` stays unedited); offline-round-trip driver swap approved as T004a.

**Purpose**: the transform itself. HIGH tier, so the P-gate applies **within** the taskgroup: each
test file is authored before the schema card it gates, fails for a named reason, and the schema card
is verified by turning it green. Everything lands in `supabase/schema.sql` (ADR-0005); **no
`migration-007`** (D-2). `supabase/schema.sql` is written by the six serial schema cards at the end
of this taskgroup — fork blocks A, B, C, the policy block, the two membership RPCs, then fork block D
(the instance-admin layer) and fork block E (the provisioning routines). One file, one lane, never
parallel.

- [x] T007 [P] [data] Extend `tests/harness/accounts.ts` with `createTestUsers(n, label)` (a third account is needed for "knows the id, is not a member", US3 acceptance 4, and for edge case 9) and `asUser(testUser)` (memoized `clientFor`, so a file switching between A/B/C does not re-authenticate per assertion). **Additive exports only** — no existing export changes signature, because P0 files import them (D-13). FR-030 note: additive-only edit to a P0 harness helper file — new exports, no existing signature or assertion changes; outside FR-030's "unedited checks" scope, receipt in receipts.md [done: 8579911]
  - Write: `tests/harness/accounts.ts`
  - Read: `tests/harness/accounts.ts`; plan.md D-13 "Harness additions"; `src/auth/supabase.ts:1-17`
  - substrate: `supabase-auth` (UNTESTED, incidental — same standing as P0)
  - verify: `npm test -- --run --project stack` green (no P0 regression), and a scratch test provisioning three users and reading `auth.getUser()` on each passes
  - done-when: three independent authenticated clients exist in one process (FR-029); `git diff tests/harness/accounts.ts` shows no changed existing signature; no existing export signature changed
- [x] T008 [data] Add the **test-only** `adminClient(testUser)` helper to `tests/harness/accounts.ts`: it inserts `(user_id)` into `public.instance_admins` over the harness's **direct `pg` connection** (never through the API, never through an RPC) and returns that user's ordinary authenticated client, now admin-flagged. It exists because the harness provisions users through `auth.admin.createUser`, so "the first account created is the admin" lands nondeterministically inside a suite and is worse than useless on a database that already has rows. **It is never shipped and never imported by `src/`** — a lint-visible comment at its definition says so, and there is no client-callable grant-admin routine anywhere (D-13, plan Complexity Tracking row 4). The trigger itself is still asserted on its own, against an empty `instance_admins`, by T018
  - Write: `tests/harness/accounts.ts`
  - Read: `tests/harness/accounts.ts`; `tests/harness/schema.ts:11,34` (the direct `pg` client and `DB_URL`); contracts/policies.sql fork block D; plan.md D-13 "Harness additions", D-16, Complexity Tracking
  - substrate: `account-provisioning` (new, UNTESTED), `supabase-auth`
  - verify: `npm test -- --run --project stack` green (no P0 regression); a scratch test calling `adminClient(a)` and then `is_admin()` returns `true`, and the same call from a non-admin client returns `false`
  - done-when: the helper is additive (D-13), documented as test-only at its definition, and `grep -rn "adminClient" src/` returns nothing; no password and no key is written anywhere by it (FR-044)
  - blocked-by: T007
- [x] T009 [P] [data] Write `tests/stack/team-schema-guards.test.ts` covering the three structural risks, red-first: **R-1 canary** — a plain authenticated `select` on `public.members` returns without `infinite recursion detected in policy for relation "members"`; **R-2** — a `pg_proc` query asserting `prosecdef` and `proconfig is not null` (i.e. a `set search_path`) for every function this feature adds (`is_member`, `is_owner`, `seed_workspace_owner`, `on_workspace_kind_change`, `assignee_must_be_member`, `clear_assignee_on_removal`, `add_member_by_email`, `workspace_member_emails`, `is_admin`, `seed_first_admin`, `create_login`, `set_login_password`, `delete_login`, `set_login_admin`, `list_logins`); **R-3** — an unauthenticated (anon) client calling **each of the eight** RPCs is refused, `create_login` most of all, because an anon-reachable one is an open account factory; **R-17** — `pgcrypto` is installed **in the `extensions` schema** (a `pg_extension`/`pg_namespace` join), asserted at the start of the file so a missing extension fails as one clear line rather than as "function extensions.crypt does not exist" deep in a provisioning test; **R-16** — the trigger `users_seed_first_admin` exists on `auth.users` after the schema is applied [done: f810738]
  - Write: `tests/stack/team-schema-guards.test.ts`
  - Read: contracts/policies.sql (whole); contracts/rpc.md; plan.md D-5, D-9, R-1, R-2, R-3; `tests/stack/schema-apply.test.ts` (structural-assertion style)
  - substrate: `supabase-schema` (VALIDATED — this feature changes it), `team-rls` (new, UNTESTED)
  - verify: `npm test -- --run --project stack tests/stack/team-schema-guards.test.ts` — red for the named reason (`relation "public.members" does not exist`), recorded. **Coordinator correction 2026-09-14:** it does **not** go green at T024. R-1 clears at T023 (T020 creates `members`; the added `members_access` precondition keeps it red until the policy itself lands), **two** R-3 cases at T024, R-16 and the third R-3 case at T025, and R-2 plus the remaining five R-3 cases at **T026**, the first point the whole file is green. R-2 clears cumulatively, not at once: 2/15 at T021, 6/15 at T022, 8/15 at T024, 10/15 at T025, 15/15 at T026
  - done-when: R-1, R-2 and R-3 each have an assertion that fails if the guard is removed (plan.md R-2's "cannot be forgotten in review")
- [x] T010 [data] Write `tests/stack/members-two-accounts.test.ts` (US2), red-first: A adds B by email and B appears in the member list shown by email; an email with no account on this origin adds nothing, returns `DA404`, and creates **0 rows** anywhere (SC-010); B (a member) attempting to **add** anyone is refused with `DA001`, and attempting to **remove** anyone is refused with `42501`. **Coordinator correction 2026-09-14 (T010 author's finding):** this card previously said both paths raise `DA001`. They do not, and `contracts/rpc.md` line 293 says why — "Removal is not an RPC": `add_member_by_email` is a `security definer` routine that raises `DA001` itself, while removal is an ordinary soft-delete write on `members` refused by row level security with `42501`. Two mechanisms, two codes; A removes B and B's reads/writes of that workspace stop while B's own personal workspaces are untouched; a non-member listing a workspace's members receives nothing; adding B twice leaves exactly **one** membership row; adding the owner's own email returns the existing `owner` row with **no demotion** to `member` [done: 1e39042]
  - Write: `tests/stack/members-two-accounts.test.ts`
  - Read: spec.md US2 acceptances 1–6, edge cases 4 and 5, FR-004..FR-010, SC-010; contracts/rpc.md (whole); plan.md D-7, D-9, R-13; `tests/harness/accounts.ts` (post-T007)
  - substrate: `membership` (new, UNTESTED), `team-rls` (new, UNTESTED), `supabase-schema`
  - verify: `npm test -- --run --project stack tests/stack/members-two-accounts.test.ts` — red for the named reason before T024, green after
  - done-when: every US2 acceptance and edge cases 4–5 have an assertion; the `DA404` branch asserts on `error.code`, never on message text (FR-008)
  - blocked-by: T007
- [x] T011 [data] Write `tests/stack/team-rls-both-halves.test.ts` (US3) covering the **eight** predicate halves — read and write on each of `workspaces`, `labels`, `tasks`, `notes` — in each direction: a member reads the team workspace's rows including rows A created; a member creates/edits/deletes a task, a label and a note; a member's workspace list contains the team workspace and **zero** of A's personal workspaces (SC-002); a third account that knows the workspace id may not create a child row in it; after removal every one of these returns nothing or is refused (R-5, asserted on **both** halves) [done: 7c4c874]
  - Write: `tests/stack/team-rls-both-halves.test.ts`
  - Read: spec.md US3 acceptances 1–6, FR-011, FR-012, SC-002; contracts/policies.sql "policy block"; `docs/validation-map.md` lines 124–144 (the read/write asymmetry correction); `ARCHITECTURE.md §3` L243–L262; plan.md D-4, D-5, R-5
  - substrate: `team-rls` (new, UNTESTED), `membership` (new, UNTESTED), `supabase-schema`
  - verify: `npm test -- --run --project stack tests/stack/team-rls-both-halves.test.ts` — red before T023, green after
  - done-when: all eight halves are exercised in both directions; the post-removal block asserts on read **and** write (FR-012, SC-002)
  - blocked-by: T007
- [ ] T012 [data] Add the **executed inversion demonstration** to `tests/stack/team-rls-both-halves.test.ts` (FR-013, SC-005): inside one `pg` connection and one transaction that always `rollback`s, `drop policy own_rows on public.<t>` / `create policy` with **one half inverted or equalized to the other**, `set local role authenticated`, `set local request.jwt.claims = '{"sub":"<uuid>"}'`, assert the outcome flips, `rollback`. Run once per direction per half, for a personal workspace **and** for a team workspace. **Fallback, named in advance and never silent**: if the environment refuses to execute the block, apply P0's fallback verbatim — the shadow-predicate mutation technique already used by `tests/stack/lww-conflict.test.ts`, plus reproduction steps in this file's header and a hand-trace in `specs/002-team-workspaces/receipts.md`, explicitly labelled a deviation (as P0's T021 was)
  - Write: `tests/stack/team-rls-both-halves.test.ts`, `specs/002-team-workspaces/receipts.md`
  - Read: spec.md FR-013, SC-005, US3 acceptance 5; plan.md D-13 "The executed inversion demo"; `specs/001-validation-spine/receipts.md` (T018's recorded deviation); `tests/stack/lww-conflict.test.ts` (the fallback technique); `tests/harness/stack.ts` (DB URL)
  - substrate: `team-rls` (new, UNTESTED), `supabase-schema`
  - verify: `npm test -- --run --project stack tests/stack/team-rls-both-halves.test.ts` green, and — checked immediately after — `psql`-level confirmation that `pg_policies` for the four tables is byte-identical to before the run (nothing committed)
  - done-when: SC-005 is satisfied by an executed demonstration, or by the named fallback recorded as a deviation; never by silence
  - blocked-by: T011
- [ ] T013 [data] Add the **R-7 assertion** to `tests/stack/team-rls-both-halves.test.ts`: B (a member, not the creator) edits a task A created in the team workspace; assert server-side that `tasks.user_id` is still **A's** id after the push — `user_id` keeps meaning "who created the row" and must not drift to "who touched it last" (FR-011). Repeat for `labels` and `notes`
  - Write: `tests/stack/team-rls-both-halves.test.ts`
  - Read: spec.md FR-011; plan.md D-4 "A fourth new trigger, `<t>_zz_keep_creator`", R-7; `src/sync/sync.ts:216` (the push path that stamps `user_id`); contracts/policies.sql (`keep_creator`)
  - substrate: `team-rls` (new, UNTESTED), `sync-engine` (VALIDATED)
  - verify: `npm test -- --run --project stack tests/stack/team-rls-both-halves.test.ts`
  - done-when: an assertion exists that fails if `<t>_zz_keep_creator` is dropped, on all three child tables (R-7's "no visible symptom" is what this closes)
  - blocked-by: T012
- [ ] T014 [data] Write `tests/stack/assignee-clear-on-removal.test.ts` (US5): A sets B as a task's assignee and both accounts read it back; clearing returns the task to unassigned (its default); removing B from the workspace clears the assignment **on the backend** with an `updated_at` that outranks an edit already queued on B's device; an assignment to a **non-member** is **coerced to `null`, not refused** (D-3) and the row is accepted; and — SC-007 — every access outcome asserted in this file is identical with and without an assignee present [in-progress: wt/us5-assignee]
  - Write: `tests/stack/assignee-clear-on-removal.test.ts`
  - Read: spec.md US5 acceptances 1–6, FR-016..FR-018, SC-006, SC-007; data-model.md §2 "Assignee", §5; contracts/policies.sql (`assignee_must_be_member`, `clear_assignee_on_removal`); plan.md D-3, R-8
  - substrate: `membership` (new, UNTESTED), `team-rls` (new, UNTESTED), `supabase-schema`
  - verify: `npm test -- --run --project stack tests/stack/assignee-clear-on-removal.test.ts` — red before T022, green after, **except the seventh case**. **Coordinator carve-out 2026-09-14 (T014 closer's finding 4):** the card's clause "A sets B as a task's assignee and **both accounts read it back**" was discharged by no file — T011 covers a member reading A's rows but says nothing about the `assignee` column's value — so a seventh case was added here in which B reads the assignment back through its own client. It needs the widened `tasks` read half and therefore turns green at **T023**, not T022; the same carve-out is recorded in T022's verify line, beside `kind-switch.test.ts` cases (a) and (e)
  - done-when: SC-006 ("0 tasks whose assignee names a non-member") is measured directly and the coercion path is asserted as **accepted-and-nulled**, never as an error (FR-018, plan R-14)
  - blocked-by: T007
- [x] T015 [data] Write `tests/stack/team-triggers.test.ts` (FR-014, R-6): demonstrate `keep_newer`, `stay_deleted_with_workspace` and `follow_workspace_delete` each still firing — **on a personal workspace and on a team workspace**, same rows, same effect. Include R-6's specific case: the owner soft-deletes a team workspace while a member has a queued live child; the late-arriving child must be **forced to `deleted`**, not refused. If the replaced `with check` refuses it instead, the trigger has become unreachable on rows it used to see — that is an FR-014 regression and a **FINDING for the owner**, not a fix [done: 8583e4f]
  - Write: `tests/stack/team-triggers.test.ts`
  - Read: spec.md FR-014, edge case "The owner deletes the team workspace…"; `ARCHITECTURE.md §4` L379–L393 (trigger table, name-order firing); `supabase/schema.sql:142-190`, `:193-195` (read-only); plan.md D-4, D-6, R-6; `tests/stack/soft-delete.test.ts` (the P0 personal-side equivalent)
  - substrate: `supabase-schema` (VALIDATED), `team-rls` (new, UNTESTED)
  - verify: `npm test -- --run --project stack tests/stack/team-triggers.test.ts` — red before T022/T023, green after
  - done-when: each of the three triggers has a passing demonstration on both workspace kinds (FR-014); any refusal-instead-of-coercion outcome is filed as a FINDING and not worked around
  - blocked-by: T007
- [x] T016 [data] Write `tests/stack/personal-unchanged.test.ts` (US4 smoke): for a **personal** workspace after the swap — the owner reaches everything, a second account reaches nothing, by listing and by identifier, on read and on write; the delete cascade and stay-deleted behaviour are observably as before; a workspace created without expressing a choice is `personal`; every workspace that existed before the change reads `personal`; setting `kind` to a third value is refused **by the backend** (US1 acceptance 4), and a **non-owner stranger** flipping `kind` on a workspace they do not own reaches nothing: the row fails the read half's `using` clause, so the update matches zero rows, raises no error and leaves `kind` unchanged. **Second coordinator correction 2026-09-14 (T016 author's finding):** an earlier version of this correction said `42501`. That is wrong for a stranger. Postgres raises `42501` only when a row **passes** `using` and its new values fail `with check` — that is a *member* of a team workspace who is not its owner, which is T017 case (e), not this card. **Coordinator correction 2026-09-14:** this card previously required asserting that a `kind` update is "silently pinned back (D-6)". That is withdrawn — `contracts/policies.sql` lines 117-122 state that `pin_workspace_kind` and `workspaces_zz_kind_fixed` of the **superseded** plan D-6 do not exist, and plan.md **D-6′** makes `kind` an ordinary owner-writable column. The owner's successful switch and both directions' consequences belong to T017, not here [done: 15ad98b]
  - Write: `tests/stack/personal-unchanged.test.ts`
  - Read: spec.md US1 acceptances 1–4, US4 acceptances 1–4, "Personal must not regress", FR-001, FR-003, SC-002; contracts/policies.sql (fork block A; lines 117-122 on the withdrawn pin); plan.md D-1, **D-6′** (D-6 is superseded)
  - substrate: `supabase-schema`, `team-rls` (new, UNTESTED)
  - verify: `npm test -- --run --project stack tests/stack/personal-unchanged.test.ts` — red before T020, green after
  - done-when: the personal read/write outcomes asserted here are identical to `tests/stack/rls-two-accounts.test.ts`'s; a third `kind` value is proven *refused* by `workspaces_kind_check` (FR-001) and a stranger's flip is proven to match *zero rows with no error*; no assertion claims a pin-back, which does not exist (D-6′)
  - blocked-by: T007
- [x] T017 [data] Write `tests/stack/kind-switch.test.ts` (US8, FR-034–FR-036), red-first — the evidence that gates D-6′'s trigger: **(a)** team → personal soft-deletes every live `members` row of that workspace, the owner's included, and the ex-member's next `select` on the workspace's tasks returns nothing; **(b)** personal → team re-creates exactly one `owner` row for `user_id`, un-deleting the previous one rather than inserting a duplicate (`members_one_per_person` is unconditional, R-8); **(c)** the purge writes `updated_at = greatest(updated_at, now())`, so a member's already-queued membership edit cannot out-rank it on the next push; **(d)** **R-19** — an `update` that flips `kind` but carries an *older* `updated_at` is cancelled by `keep_newer` **before** the AFTER-UPDATE trigger can fire, so no membership purge happens at all; **(e)** a kind flip on a workspace the caller does not own is refused by the unchanged workspace write half (`42501`), because kind is an ordinary column and carries no special privilege path [done: 47d20aa]
  - Write: `tests/stack/kind-switch.test.ts`
  - Read: contracts/policies.sql fork block C (`on_workspace_kind_change`); data-model.md §2 (both switch directions, the AFTER-timing note); plan.md **D-6′**, D-7 correction, R-19; spec.md US8, FR-034–FR-036, SC-021
  - substrate: `membership` (new, UNTESTED), `team-rls` (new, UNTESTED)
  - verify: `npm test -- --run --project stack tests/stack/kind-switch.test.ts` — **red before the schema card, for the named reason** (`on_workspace_kind_change` does not exist), green after it
  - done-when: both directions and the stale-flip case are asserted, not narrated; the test never asserts trigger *timing* by reading `pg_trigger` — it asserts the observable consequence (D-6′)
  - blocked-by: T007
- [ ] T018 [data] Write `tests/stack/logins-provisioning.test.ts` (US7, FR-037–FR-045, SC-015–SC-018, SC-021), red-first — the whole provisioning surface, and the **canary for R-15**: **(a)** on an empty `instance_admins`, inserting a user into `auth.users` fires `users_seed_first_admin` and makes exactly that user the admin, and a second insert does **not** add a second admin; **(b)** every one of the five admin routines (`create_login`, `set_login_password`, `delete_login`, `set_login_admin`, `list_logins`) called by a non-admin raises `DA001` and changes nothing (FR-038, SC-018); **(c)** `create_login` called by an admin mints a login **that can actually sign in** — `supabase.auth.signInWithPassword` with the minted credential succeeds, which is the assertion that fails loudly if a Supabase upgrade moves GoTrue's table shape (R-15); **(d)** a duplicate email raises `DA012` and leaves the existing row untouched; a malformed identifier raises `DA010`, a password shorter than 8 raises `DA011`, and a mixed-case, space-padded identifier is stored lower-cased and trimmed (FR-042); **(e)** `set_login_password` makes the old password fail and the new one succeed; **(f)** `delete_login` **bans**: sign-in is refused afterwards, the `auth.users` row still exists, the workspace rows that login created are still there with the creator id intact, its `instance_admins` row is gone, and its `members` rows are soft-deleted so `members_zz_clear_assignee` cleared its assignments (R-18, FR-045); `delete_login` refuses the caller's own login with `DA013` and a login that owns a live team workspace with `DA014`, changing nothing on either path (FR-045); **(g)** `set_login_admin` refuses to clear the **last** admin with `DA015`; **(h)** `list_logins` returns every login for an admin, banned rows included; **(i)** two admins creating the same email concurrently (two clients, `Promise.all`) end with exactly one `auth.users` row and one `DA012` (SC-021); **(j)** **added by the coordinator 2026-09-14** — `is_admin()` is called **directly** and returns `true` from a client produced by T008's `adminClient(a)` and `false` from an ordinary `asUser(b)`. This discharges T008's deferred verify half verbatim rather than leaving it inferred from the five routines' `DA001` refusals (T008 closer finding 1) [in-progress: wt/logins]
  - Write: `tests/stack/logins-provisioning.test.ts`
  - Read: contracts/rpc.md (whole — the eight operations, the verbatim GoTrue column set, the error-code register); contracts/policies.sql fork blocks D and E; data-model.md §6 "No hard delete of an account"; plan.md D-16, D-17, R-15, R-16, R-17, R-18; spec.md US7, FR-037–FR-045, SC-015–SC-018, SC-021
  - substrate: `account-provisioning` (new, UNTESTED)
  - verify: `npm test -- --run --project stack tests/stack/logins-provisioning.test.ts` — red before the schema cards for a named reason (the routines do not exist), green after T026
  - done-when: FR-037–FR-045, SC-015–SC-018 and SC-021 each have an assertion — **except FR-039 and FR-041/SC-017, which lie outside this file’s surface** (coordinator, 2026-09-14): FR-039 is a UI-side obligation and FR-041/SC-017 concern the hosted deployment’s configuration, neither observable from a stack test of the five routines. They are discharged elsewhere, not here, and this card is not held open for them; **no password used in the test is a real credential and none is written to `receipts.md`** (FR-044); the ban-not-delete behaviour is asserted from the *observable* side (sign-in refused, rows kept), never by reading `banned_until` alone
  - blocked-by: T008
- [x] T019 [P] [data] Add `seedTeamWorkspace(owner, members[])` to `tests/harness/seed.ts`: create a team workspace through the same `src/db/api.ts` path `seedWorkspaceWithTask` uses, then add members via `add_member_by_email`, so the seed exercises the real creation path rather than inserting rows behind it. **Additive export only**. FR-030 note: additive-only edit to a P0 harness helper file — new exports, no existing signature or assertion changes; outside FR-030's "unedited checks" scope, receipt in receipts.md [done: 3d6c86c]
  - Write: `tests/harness/seed.ts`
  - Read: `tests/harness/seed.ts`; contracts/rpc.md; plan.md D-13 "Harness additions", D-6 (the owner row arrives by pull, not by local write)
  - substrate: `db-api` (VALIDATED after T002), `membership` (new, UNTESTED)
  - verify: `npm test -- --run --project stack` green after T024; a scratch test seeding a team workspace with one added member and reading both membership rows back passes
  - done-when: no existing export in `tests/harness/seed.ts` changed signature (D-13); the seed never inserts a `members` row directly; no existing export signature changed
  - blocked-by: T007
- [ ] T020 [data] Add **fork block A** to `supabase/schema.sql`, in its own guarded block placed after upstream's table definitions and before the trigger loops, exactly as `contracts/policies.sql` lines 14–46 write it: `workspaces.kind text not null default 'personal'` with the separately-dropped-and-added `workspaces_kind_check check (kind in ('personal','team'))`; `public.members` with `id uuid primary key`, `user_id`/`member_id`/`workspace_id` FKs `on delete cascade`, `level text not null default 'member' check (level in ('owner','member'))`, the four housekeeping columns and `deleted boolean not null default false`; the **unconditional** `members_one_per_person unique (workspace_id, member_id)` (*not* partial on `not deleted`) and `members_by_person (member_id, synced_at)`; `enable row level security` on `members`; `tasks.assignee uuid references auth.users(id) on delete set null`. **No `migration-007`** (D-2) and **no origin column or table** (FR-027)
  - Write: `supabase/schema.sql`
  - Read: contracts/policies.sql lines 1–46; data-model.md §1; plan.md D-1, D-2, R-4; `supabase/schema.sql` (whole, read-only first); ADR-0005
  - substrate: `supabase-schema` (VALIDATED — re-verified in this PR)
  - verify: `npm test -- --run --project stack tests/stack/schema-apply.test.ts tests/stack/personal-unchanged.test.ts` — green, including the idempotent second apply
  - done-when: FR-001, FR-016, FR-028 hold; `git diff supabase/schema.sql` adds a separate guarded block and modifies **no** upstream table definition and **no** four-element `foreach` array (R-4); `supabase/migration-007*` does not exist
  - blocked-by: T009, T010, T011, T012, T013, T014, T015, T016, T019
- [ ] T021 [data] Add **fork block B** to `supabase/schema.sql` before the policy block: `public.is_member(ws uuid)` and `public.is_owner(ws uuid)`, both `language sql stable security definer set search_path = public, pg_temp`, both reading `and not m.deleted`; then `revoke execute … from public, anon` and `grant execute … to authenticated` for each. `security definer` is **not optional** — `members_access` is a policy on `members` whose predicate queries `members` (R-1)
  - Write: `supabase/schema.sql`
  - Read: contracts/policies.sql lines 48–75; plan.md D-5, R-1, R-2, R-3; data-model.md §1 `members`
  - substrate: `supabase-schema`, `team-rls` (new, UNTESTED)
  - verify: `npm test -- --run --project stack tests/stack/team-schema-guards.test.ts` — R-1 and R-2 assertions green
  - done-when: both helpers carry `security definer` **and** `set search_path`, and neither is executable by `anon` (R-2, R-3); `not m.deleted` is present in both (R-5)
  - blocked-by: T020
- [ ] T022 [data] Add **fork block C** to `supabase/schema.sql` — the fork's own triggers, in a guarded block that does **not** edit upstream's `array['workspaces','labels','tasks','notes']` loops (R-4): `members_synced_at` + `members_keep_newer` (the same housekeeping every synced table has); `workspaces_seed_owner` (`after insert`, `security definer`, `on conflict (workspace_id, member_id) do nothing`); `workspaces_zz_kind_change` (**`after update`**, `when (new.kind is distinct from old.kind)` — team→personal soft-deletes every live `members` row of that workspace with `updated_at = greatest(updated_at, now())`, personal→team upserts exactly one owner row `on conflict (workspace_id, member_id) do update set deleted = false, level = 'owner'`). **There is no `pin_workspace_kind` and no `workspaces_zz_kind_fixed`** — D-6′ supersedes that half of D-6; `kind` is an ordinary column under `keep_newer`, and AFTER timing is what makes a stale flip harmless (R-19); `tasks_zz_assignee_member` (coerce `assignee` to `null` when not a live member — coerce, never raise); `members_zz_clear_assignee` + `members_zz_clear_assignee_del` (clear with `updated_at = greatest(updated_at, now())`); `<labels|tasks|notes>_zz_keep_creator`. **Every new BEFORE trigger carries the `_zz_` infix** so it sorts after `keep_newer` → `stay_deleted` → `synced_at` — Postgres fires same-timing triggers in name order and a trigger sorting first would change observable behaviour (FR-014)
  - Write: `supabase/schema.sql`
  - Read: contracts/policies.sql fork blocks A–C; data-model.md §5 (trigger table and firing order); plan.md D-3, D-6, **D-6′**, D-8, R-6, R-7, R-8, R-19; `supabase/schema.sql:142-195` (read-only)
  - substrate: `supabase-schema`, `membership` (new, UNTESTED)
  - verify: `npm test -- --run --project stack tests/stack/team-triggers.test.ts tests/stack/assignee-clear-on-removal.test.ts tests/stack/kind-switch.test.ts` — green, **except `kind-switch.test.ts` cases (a) and (e)**. **Coordinator correction 2026-09-14 (T017 author's finding, extended by the T017 closer):** case (e) asserts a non-owner's kind flip is refused `42501`, and a Postgres write-check refusal can only be raised once the caller's row is visible under the read half's `using` clause. The `workspaces` read half only widens to include `public.is_member(id)` at **T023**; before that a non-owner's update matches zero rows and raises no error at all. Case (e) therefore turns green at T023, not here — do not "fix" the test to make it pass at T022. **Case (a) is the same shape**: after the team→personal purge it has the ex-member read the workspace’s tasks and expect nothing, and the paired positive control added at the closer’s insistence has that same ex-member read **one** row while the membership is still live. That positive control needs the widened child read half, which is also T023. Case (a) therefore turns green at T023 as well; at T022 only (b), (c) and (d) are green. **Coordinator carve-out 2026-09-14 (T014 closer's finding 4):** `assignee-clear-on-removal.test.ts` gained a seventh case — B, the assignee, reads the assignment back through its own client — because the T014 card's clause "A sets B as a task's assignee and **both accounts read it back**" was discharged by no file (T011 covers a member reading A's rows, but says nothing about the `assignee` column's value). That case is the same shape as (e): it needs the widened `tasks` read half, so it turns green at **T023**, not here. At T022 the other six cases of that file are green
  - done-when: FR-002, FR-014, FR-018, FR-034–FR-036 hold; every new BEFORE trigger name sorts after `synced_at`; the kind trigger is AFTER, not BEFORE; no upstream `foreach` array was edited (R-4)
  - blocked-by: T021
- [ ] T023 [data] Replace the **policy block** at the end of `supabase/schema.sql` wholesale, per `contracts/policies.sql` lines 195–245: on `workspaces`, `using (auth.uid() = user_id or public.is_member(id))` and `with check (auth.uid() = user_id)` — the read half widens, the write half deliberately does **not** (FR-005). On each of `labels`/`tasks`/`notes`, the read half `auth.uid() = user_id or public.is_member(workspace_id)` and the write half `(auth.uid() = user_id and exists(…workspace is mine…)) or public.is_member(workspace_id)` — the write half's first branch is **upstream's clause character for character**, and the membership branch is **not** conjoined with `auth.uid() = user_id`. On `members`, the fork-only `members_access`: `using (public.is_member(workspace_id))`, `with check (public.is_owner(workspace_id) and auth.uid() = user_id)`. **Both halves of each policy are written separately; one predicate used for both is a defect** (FR-012)
  - Write: `supabase/schema.sql`
  - Read: contracts/policies.sql lines 195–245; spec.md FR-005, FR-011, FR-012, FR-013, FR-015; `docs/validation-map.md` lines 124–144; plan.md D-4, R-4, R-11
  - substrate: `team-rls` (new, UNTESTED), `supabase-schema`
  - verify: `npm test -- --run --project stack tests/stack/team-rls-both-halves.test.ts tests/stack/rls-two-accounts.test.ts tests/stack/personal-unchanged.test.ts` — all green, the P0 file **unedited**
  - done-when: FR-012's "both halves replaced separately, asymmetry preserved" holds and T012's inversion demo flips an assertion in each direction (SC-005); P0's `rls-two-accounts.test.ts` passes with zero edits (FR-030)
  - blocked-by: T022
- [ ] T024 [data] Add the **two RPCs** to `supabase/schema.sql` per `contracts/rpc.md`: `public.add_member_by_email(ws uuid, email text) returns public.members` — raises `DA001` unless `public.is_owner(ws)`; looks the email up in `auth.users` with `lower(trim(...))` on **both** sides (R-13); raises `DA404` with message `no account with this email on this origin` when there is none, creating **no row of any kind** (SC-010); otherwise upserts `on conflict (workspace_id, member_id) do update set deleted = false, updated_at = now()` — a set-list that deliberately **does not touch `level`**, so adding the owner's own email never demotes them. And `public.workspace_member_emails(ws uuid) returns table (member_id uuid, email text, level text)` — **zero rows** unless `public.is_member(ws)`. Both `security definer`, both `set search_path = public, auth, pg_temp`, both `revoke execute … from public, anon` / `grant execute … to authenticated` (R-3)
  - Write: `supabase/schema.sql`
  - Read: contracts/rpc.md (whole); spec.md FR-007, FR-008, SC-010, edge cases 4 and 5; plan.md D-9, R-2, R-3, R-13
  - substrate: `membership` (new, UNTESTED), `team-rls` (new, UNTESTED)
  - verify: `npm test -- --run --project stack tests/stack/members-two-accounts.test.ts tests/stack/team-schema-guards.test.ts` — green
  - done-when: FR-007, FR-008 and SC-010 hold; no `profiles` table and no second copy of any email exists anywhere in the diff (FR-007, Q1); neither RPC is reachable by `anon` (R-3). **Parameter names are load-bearing:** `tests/stack/team-schema-guards.test.ts` R-3 pins `add_member_by_email(ws, email)` and `workspace_member_emails(ws)` by argument name, so a rename makes PostgREST answer `PGRST202` and leaves that guard permanently red while looking like a schema bug (T009 closer finding 5, coordinator 2026-09-14)
  - blocked-by: T023
- [ ] T025 [data] Add **fork block D** to `supabase/schema.sql` per `contracts/policies.sql`: `public.instance_admins (user_id uuid primary key references auth.users(id) on delete cascade, granted_by uuid references auth.users(id) on delete set null, created_at timestamptz not null default now())`, `enable row level security` **with no policy at all** — the table is reachable only through `security definer` routines, so "no policy" is the access rule, not an omission (data-model.md §1 invariant); `public.is_admin()` (`sql stable security definer set search_path = public, pg_temp`), revoked from `public, anon`, granted to `authenticated`; and `public.seed_first_admin()` + the `users_seed_first_admin` `after insert` trigger on `auth.users`, which promotes the **first** account on a fresh instance and does nothing on every later one. `instance_admins` is **not** a synced table and must not appear in `SYNCED_TABLES` — an instance admin is not a workspace permission and never reaches RLS
  - Write: `supabase/schema.sql`
  - Read: contracts/policies.sql fork block D; data-model.md §1 `instance_admins`, §5; plan.md D-16, D-17, R-16; ADR-0006 §A
  - substrate: `supabase-schema`, `account-provisioning` (new, UNTESTED)
  - verify: `npm test -- --run --project stack tests/stack/team-schema-guards.test.ts tests/stack/logins-provisioning.test.ts` — the R-2/R-3/R-16 guards and case (a) of the provisioning test green
  - done-when: FR-037 and FR-039 hold; `instance_admins` has RLS enabled and **zero** policies; no RLS predicate anywhere reads it (`grep -n "instance_admins" supabase/schema.sql` shows it only inside definer bodies); the trigger exists on `auth.users`
  - blocked-by: T024
- [ ] T026 [data] Add **fork block E** to `supabase/schema.sql` — the five provisioning routines, written from `contracts/rpc.md`, which is authoritative for their bodies: `create_login(email, password, admin default false)`, `set_login_password(user_id, password)`, `delete_login(user_id)`, `set_login_admin(user_id, admin)`, `list_logins()`. All five are `security definer set search_path = public, auth, extensions, pg_temp`, all five open with the shared `if not public.is_admin() then raise exception using errcode = 'DA001'` precondition (**including `list_logins`**, unlike `workspace_member_emails`, which returns zero rows instead), and all five are `revoke execute … from public, anon` / `grant execute … to authenticated`. `create_login` writes the **verbatim** GoTrue column set the contract records — `auth.users` including the empty-string token columns and `extensions.crypt(pw, extensions.gen_salt('bf'))`, plus the matching `auth.identities` row with `provider_id = user_id::text` — and nothing beyond it (R-15). **`delete_login` bans, it does not delete** (`banned_until = 'infinity'`, `encrypted_password` scrambled, `instance_admins` row removed, that login's `members` rows soft-deleted with `greatest(updated_at, now())`): the FK cascade on `user_id` means a real delete would destroy that person's workspaces, labels, tasks and notes, which FR-043 forbids (R-18). Error codes exactly as the register lists them: `DA001`, `DA010`–`DA015`. **`create extension` is not written here** — the extension is asserted by the guard test, not created (R-17)
  - Write: `supabase/schema.sql`
  - Read: contracts/rpc.md (whole); contracts/policies.sql fork block E pointer; `supabase/schema.sql:18,32,44,81` (the four `on delete cascade` FKs that force the ban decision); plan.md D-16, R-15, R-17, R-18; ADR-0006 §B
  - substrate: `account-provisioning` (new, UNTESTED)
  - verify: `npm test -- --run --project stack tests/stack/logins-provisioning.test.ts tests/stack/team-schema-guards.test.ts` — green, including the sign-in canary
  - done-when: FR-037–FR-045 and SC-015–SC-018 hold; **no `service_role` key exists in the diff, in any env file, or in the built client** (FR-033, SC-020); `delete_login` contains no `delete from auth.users`; every one of the five carries `security definer` **and** `set search_path`, and none is reachable by `anon` (R-2, R-3) **Parameter names are load-bearing:** `tests/stack/team-schema-guards.test.ts` R-3 pins each routine's argument name-set, so renaming a parameter makes PostgREST answer `PGRST202` and leaves that guard permanently red while looking like a schema bug (T009 closer finding 5, coordinator 2026-09-14).
  - **Coordinator note 2026-09-14 (from T018’s authoring):** `create_login` must map `unique_violation` (`23505`) to `DA012` in an exception handler, not rely on the contracted pre-check alone. The pre-check reads `auth.users` before inserting; two admins creating the same email concurrently both pass it, and the loser hits GoTrue’s `users_email_partial_key` unique index. `contracts/rpc.md` line 124 calls the pre-check a pre-check for exactly this reason, and SC-021 (T018 case (i), two clients under `Promise.all`) asserts the pair ends with one `auth.users` row and **one `DA012`** — which an unmapped `23505` fails
  - blocked-by: T025
- [ ] T026A [data] Write `tests/stack/personal-triggers-after-t022.test.ts` — the **personal-side smoke for T022's own new triggers**, which nothing else observes. T015 proves upstream's three triggers (`keep_newer`, `stay_deleted_with_workspace`, `follow_workspace_delete`) fire identically on both kinds; no card watches what T022's **new** triggers do to a `kind: personal` row. Three cases: **(a)** an owner's update to a label, task and note lands and leaves `user_id` unchanged, so `<labels|tasks|notes>_zz_keep_creator` (BEFORE UPDATE, `new.user_id := old.user_id`) is a no-op on a personal row rather than a silent rewrite; **(b)** a personal task created with `assignee` set to its own creator reads back `assignee = null` — `seed_workspace_owner` is guarded `if new.kind = 'team'` (`contracts/policies.sql:101-114`), so a personal workspace has **no** `members` row at all and its owner is not a live member of their own workspace, which means `tasks_zz_assignee_member` coerces every personal assignment; that is contractually intended and observed nowhere else; **(c)** creating a personal workspace seeds **no** `members` row. **Coordinator note 2026-09-14 (T015 closer's item 8, accepted):** this was deliberately kept out of T015 rather than bolted on. `spec.md` lines 443-450's "Triggers" invariant names exactly the three upstream triggers and asks that *they* behave identically — T022's are not those triggers, so adding them to T015 would be scope the card does not carry (reviewer duty 3). T015 also gates T020 (`blocked-by` at T020 lists it), and a case that can only go green at T022 sitting inside a T020 blocker muddies the gate reading
  - Write: `tests/stack/personal-triggers-after-t022.test.ts`
  - Read: contracts/policies.sql fork block C and lines 101-114, 164-178; spec.md "Personal must not regress", FR-017, FR-018; data-model.md §5 (trigger firing order); plan.md D-3, R-14
  - substrate: `supabase-schema`, `membership` (new, UNTESTED)
  - verify: `npx vitest run --project stack tests/stack/personal-triggers-after-t022.test.ts` — red before T022, green after
  - done-when: all three cases pass; no assertion depends on T023 (this file's subject is personal, whose read and write halves T023 leaves as upstream wrote them); each negative assertion carries an in-block positive control
  - blocked-by: T022
- [ ] T026B [infra] **`tests/` is typechecked by nothing in CI.** `tsconfig.app.json` includes only `src` and `tsconfig.node.json` only `vite.config.ts`/`worker/index.ts`, so `npx tsc -b --noEmit` — the CI typecheck step — never reads a single file under `tests/`. Every "typecheck is green" claim about a test file in this feature's receipts rests on an **out-of-band** invocation the coordinator ran by hand: `npx tsc --ignoreConfig --noEmit --strict --target es2022 --module esnext --moduleResolution bundler --skipLibCheck --lib es2022,dom <file>`. Close the gap the ordinary way: a `tsconfig.test.json` covering `tests/` referenced from the root solution file, so `tsc -b` picks it up, and no change to what `tsconfig.app.json` compiles into the bundle. Found independently by the T017 closer (three real errors invisible to `tsc -b`, recorded in T017's receipt) and the T011 closer
  - Write: `tsconfig.test.json`, `tsconfig.json`, `.github/workflows/ci.yml` (only if the step needs it)
  - Read: `tsconfig.app.json`, `tsconfig.node.json`, `.github/workflows/ci.yml`; T017's receipt in `specs/002-team-workspaces/receipts.md`
  - substrate: `env-boot`
  - verify: `npx tsc -b --noEmit` reports the errors a deliberately broken test file introduces, and reports none on the tree as it stands
  - done-when: no `src/` file's compilation options change, the built bundle is byte-identical, and a type error in any `tests/**/*.ts` fails CI
  - blocked-by: none
- [ ] T027 [data] **P0-unedited gate.** Run the entire suite and prove no P0 check changed: `git diff --stat <post-T004 baseline SHA> -- tests/stack/lww-conflict.test.ts tests/stack/offline-round-trip.test.ts tests/stack/rls-two-accounts.test.ts tests/stack/schema-apply.test.ts tests/stack/soft-delete.test.ts tests/local/claim-cache.test.ts` must be empty. Harness files may have gained exports; none may have changed one. A P0 check that must change is a **FINDING for the owner, not an edit** (FR-030, spec "Personal must not regress", last bullet)
  - Write: `specs/002-team-workspaces/receipts.md`
  - Read: spec.md FR-030, SC-003; plan.md D-13 "Every P0 file is unedited"; T006's R-10 verdict list
  - substrate: all of `sync-engine`, `local-cache`, `supabase-schema`, `db-api`
  - verify: `npm test -- --run` fully green twice consecutively, **and** the `git diff --stat` above prints nothing
  - done-when: SC-003 ("0 edits to P0 checks") is demonstrated by an empty diff, not asserted; the run is recorded in `receipts.md`
  - blocked-by: T026

**Checkpoint**: the backend transform is complete and proven. The interface still shows nothing new.

---

## TG-2: Wire and cache — `members` as the fifth synced table, Dexie v3, `db-api`

**Purpose**: carry membership and assignee on the **existing generic sync loop** so FR-019 is
satisfied by the path itself, and grow the local cache **additively** so FR-021/FR-022 and SC-012
stay true. **The LWW rule does not change in this feature** — T038 asserts that mechanically.

- [ ] T028 [data] Update `src/db/types.ts`: `SYNCED_TABLES` becomes `['workspaces','members','labels','notes','tasks']` (`members` after `workspaces`, which it FKs); `SYNCED_COLUMNS.workspaces` gains `kind: true`; `SYNCED_COLUMNS.tasks` gains `assignee: true`; a new `SYNCED_COLUMNS.members` entry carries exactly `id, workspace_id, member_id, level, created_at, updated_at, deleted` — **`user_id` and `synced_at` are in no entry** (push stamps, pull strips). Add `export type WorkspaceKind = 'personal' | 'team'`, `export type MemberLevel = 'owner' | 'member'`, `Workspace.kind: WorkspaceKind`, `Task.assignee: ID | null`, and the `Member` interface from data-model.md §3. The existing `satisfies { [K in SyncedTable]: ColumnsOf<SyncedRow[K]> }` check must remain the guard
  - Write: `src/db/types.ts`
  - Read: data-model.md §3 (whole, including the TypeScript block); plan.md D-8, D-10; `src/db/types.ts` (whole); `src/sync/sync.ts:216`, `:418` (why `user_id`/`synced_at` are excluded); T006's R-10 verdict list
  - substrate: `local-cache` (VALIDATED — re-verified in this PR), `sync-engine` (VALIDATED)
  - verify: `npx tsc -b --noEmit` clean, then `npm test -- --run` fully green — including every P0 file unedited (this is where R-10 bites)
  - done-when: FR-019's wire half holds; the `satisfies` guard still turns a forgotten column into a compile error; any P0 file that now fails is filed as a **FINDING**, not edited (FR-030)
  - blocked-by: T027
- [ ] T029 [data] Update `src/db/local.ts`: add `this.version(3).stores({ members: 'id, workspace_id, _dirty' })` with an `upgrade` backfilling `w.kind ??= 'personal'` and `t.assignee ??= null` — the identical pattern to the v2 calendar backfill. **No existing store's key or index changes**, so Dexie rebuilds nothing. `wipeLocal()` grows `members` in its table list. **`claimCache` is unchanged** — same signature, same `meta` key `owner`, same value (the bare user id), same semantics: renaming the key would make every existing cache look ownerless after the upgrade and silently skip the **next** account-switch wipe (D-10)
  - Write: `src/db/local.ts`
  - Read: data-model.md §4; plan.md D-10, R-9; `src/db/local.ts:20-125` (especially `:47-62` v2 backfill and `:89-125` claim/wipe); spec.md FR-021, FR-022, SC-012
  - substrate: `local-cache` (VALIDATED — re-verified in this PR), `multi-account-cache` (new, UNTESTED)
  - verify: `npm test -- --run --project local` — `tests/local/claim-cache.test.ts` green **unedited** and `tests/local/no-wipe-on-reach-growth.test.ts` green
  - done-when: FR-021 and FR-022 hold; `git diff src/db/local.ts` shows additions to `version()` and one table name added to `wipeLocal`, and **no change inside `claimCache`**
  - blocked-by: T028
- [ ] T030 [P] [data] Write `tests/local/no-wipe-on-reach-growth.test.ts` (SC-012, R-9), Docker-free, covering both halves in one file: open a **v2-shaped** database with cached rows and `meta` pull cursors, upgrade to v3, assert every row count and every cursor value survives and `members` exists (R-9); then claim as A, seed rows in A's own workspace **and** in a team workspace A newly reaches, write a pull cursor, claim as **A again** — assert nothing wiped, cursors intact, `meta.owner` unchanged; then claim as **B** — assert the wipe fires and the cursors are gone
  - Write: `tests/local/no-wipe-on-reach-growth.test.ts`
  - Read: plan.md D-10 "What proves 'no wipe when reach grows'", R-9; data-model.md §4; `src/db/local.ts:20-125`; `tests/local/claim-cache.test.ts` (tier conventions); spec.md SC-012, FR-021
  - substrate: `multi-account-cache` (new, UNTESTED — this file is what validates it), `local-cache`
  - verify: `npm test -- --run --project local tests/local/no-wipe-on-reach-growth.test.ts` — green with the stack stopped
  - done-when: SC-012's "exactly once per switch, 0 times when the same account signs in again, including when reach has grown" is asserted in both directions, and the v2→v3 upgrade is asserted to lose **no** row and **no** cursor
  - blocked-by: T028
- [ ] T031 [data] Extend `src/db/api.ts`: `createWorkspace(name, kind: WorkspaceKind = 'personal')` — defaulted, so every existing call site is unchanged, and it writes **only** the workspace row (the owner's own `members` row is `workspaces_seed_owner`'s server-side effect and arrives on the next pull; writing one locally would collide on `members_one_per_person` and wedge the queue, D-6/R-14); `listMembers(ws)` — a Dexie read, no network; `removeMember(ws, memberId)` — an ordinary soft-delete write plus `queue()`, exactly like `deleteTask`, no network; `memberEmails(ws)` and `addMemberByEmail(ws, email)` — delegating to the `*Remote` wrappers from T032, with `addMemberByEmail` writing the returned row straight into Dexie; `TaskPatch` widens by `assignee`. **Q-A is answered (Option B, owner 2026-09-13)**: keep the `workspace_member_emails` call site in **exactly one function**, because that one function is where the per-device `member-email:` cache lands — the cache itself is written by the dedicated card in TG-4, not here
  - Write: `src/db/api.ts`
  - Read: contracts/rpc.md "Client layering" and "Freshness / offline"; plan.md D-9, D-11, Complexity Tracking, Owner question Q-A; `src/db/api.ts` (whole); `ARCHITECTURE.md §4` L407–L424; spec.md FR-024, FR-026
  - substrate: `db-api` (VALIDATED after T002), `membership` (new, UNTESTED)
  - verify: `npx tsc -b --noEmit` clean; `npm test -- --run --project local tests/local/db-api-p1-surface.test.ts` green (T001's existing-function pins still hold)
  - done-when: FR-024's five operations exist behind `src/db/api.ts` and nothing else; `createWorkspace`'s existing call sites compile unchanged; `db-api` never imports the Supabase client directly (FR-026, ARCHITECTURE §2 layering)
  - blocked-by: T029, T032
- [ ] T032 [data] Add the online-only RPC wrappers to `src/sync/sync.ts` — `addMemberByEmailRemote(ws, email)` and `memberEmailsRemote(ws)` (D-9), plus the six instance-admin wrappers `isAdminRemote()`, `createLoginRemote(email, password, admin)`, `setLoginPasswordRemote(userId, password)`, `deleteLoginRemote(userId)`, `setLoginAdminRemote(userId, admin)`, `listLoginsRemote()` (D-16). All are thin `supabase.rpc(...)` calls that surface `error.code` unchanged so the caller can branch on `DA001`/`DA404`/`DA010`..`DA015`. **They are never queued**: a queued account creation would be a password sitting in Dexie (FR-044). **No comparator, cursor, merge, paging or loop change of any kind in this card**: `members` rides the existing generic loop by virtue of `SYNCED_TABLES` alone (D-8); the push loop's per-row fallback is a separate, test-first card (D-18)
  - Write: `src/sync/sync.ts`
  - Read: contracts/rpc.md (whole, incl. the error-code register and "Client layering"); plan.md D-8, D-9, D-16; `src/sync/sync.ts:104-141`, `:203-277`, `:409-458`, `:462-507` (read before writing); `ARCHITECTURE.md §4` L331–L378
  - substrate: `sync-engine` (VALIDATED — must stay so), `membership` (new, UNTESTED)
  - verify: `npx tsc -b --noEmit` clean; `npm test -- --run --project stack tests/stack/lww-conflict.test.ts tests/stack/offline-round-trip.test.ts tests/stack/soft-delete.test.ts` green with those files **unedited**
  - done-when: the diff of `src/sync/sync.ts` contains only the eight added exports — nothing inside `push`, `pull`, `cycle`, `mergeRows`, `isNewer` or `sameRow` changed by **this** card (FR-020, CLAUDE.md "LWW lockstep"); no password is logged, stored or passed anywhere but the RPC argument (FR-044)
  - blocked-by: T028
- [ ] T033 [data] Cache the admin flag per device (D-17): after a successful `isAdminRemote()` the boolean is written to Dexie `meta` under the key `is-admin`, in the **same shape as `member-email:<uuid>`** — display-only, never synced, never authoritative, cleared by `wipeLocal()` along with every other `meta` row, so signing out on a shared laptop does not leave the next person's client believing it is an admin. It exists only so the Logins section does not flash in and out on every reload; **every provisioning call is still authorized server-side by `is_admin()`**, and a device that lies to itself gets `DA001` and nothing else (FR-042). Read it on boot, refresh it on each successful sync cycle's admin check, and never branch a *security* decision on it
  - Write: `src/db/api.ts`
  - Read: plan.md D-17, D-10; contracts/rpc.md "Client layering"; `src/db/local.ts` (`meta`, `wipeLocal`, `claimCache`); `src/db/api.ts` (the `member-email:` cache written in the sibling card)
  - substrate: `multi-account-cache` (new, UNTESTED), `db-api`
  - verify: `npm test -- --run --project local tests/local/db-api-p1-surface.test.ts` — an added case asserts the key is written, read back, and **gone after `wipeLocal()`**
  - done-when: FR-037 and FR-039 hold (the flag is display-only, never a permission); `grep -n "is-admin" src/` shows the key written and read in exactly one module; no component reads Dexie directly (FR-026); the Dexie version is **not** bumped again — `meta` already exists (D-17)
  - blocked-by: T032
- [ ] T034 [P] [data] Add one `useLiveQuery` wrapper for `members` to `src/db/hooks.ts`, matching the shape of the existing per-table hooks, so the UI reads the member list reactively from Dexie through `db-api` rather than re-querying
  - Write: `src/db/hooks.ts`
  - Read: `src/db/hooks.ts` (whole); `src/db/api.ts` `listMembers` (post-T031); plan.md "Project Structure" (`src/db/hooks.ts` line)
  - substrate: `local-cache`, `db-api`
  - verify: `npx tsc -b --noEmit` clean and `npm run lint` clean
  - done-when: the hook mirrors an existing hook's signature exactly; no new data path is introduced (FR-026)
  - blocked-by: T031
- [ ] T035 [data] Write `tests/stack/push-refusal-fallback.test.ts` **before** the sync change (D-18's test-first obligation — `sync-engine` is VALIDATED HIGH-tier substrate, so the ADR-0002 rule is at its strictest here), red-first against today's loop: a member's queued write to a row RLS refuses (a workspace rename by a non-owner, or any row belonging to a workspace they were just removed from) makes the **whole** `upsert` batch raise `42501`, and today's per-table catch re-sends it on every cycle, so **innocent rows queued behind it never leave the device**. Assert exactly that in the red phase — the innocent row is still `_dirty` after three cycles — then, after the change, assert: the batch is retried row by row, the refused row alone is dropped from the queue, every innocent row in the same batch lands, the next pull reconciles the dropped row's true state, and **no other table's cursor moved backwards**
  - Write: `tests/stack/push-refusal-fallback.test.ts`
  - Read: `src/sync/sync.ts:203-277` (the push loop; `:249-252`, `:257-272`, `:274-277` are the exact lines D-18 names), `:409-458` (`mergeRows` — read to confirm it is **not** touched); plan.md D-18, D-7 correction, R-11, R-14; spec.md FR-041, SC-017
  - substrate: `sync-engine` (VALIDATED — this feature changes it, so the test comes first)
  - verify: `npm test -- --run --project stack tests/stack/push-refusal-fallback.test.ts` — **red for the named reason first**, green only after T036
  - done-when: SC-017's "one refused row does not block the others" has a failing-then-passing receipt; the red run's output is recorded in `receipts.md` so the defect is evidenced, not asserted
  - blocked-by: T032
- [ ] T036 [data] Implement the **per-row refusal fallback** in `src/sync/sync.ts`'s push loop exactly as D-18 specifies: when the batch `upsert` returns an error, retry that batch **one row at a time**; a row that succeeds is cleared from the queue as it is today; a row that fails with `42501` is dropped from the queue **and left dirty-free**, so the next pull reconciles it to the server's truth; any other error code keeps today's behaviour (the table's cycle fails and is retried whole). The scope is the push loop and nothing else: **`mergeRows` (`:409-458`), `isNewer`, `sameRow` and the `keep_newer()` trigger body are untouched**, which is what keeps the LWW lockstep intact (CLAUDE.md; FR-020). The cost is accepted and named in D-18: a genuinely refused batch costs one round trip per row, once
  - Write: `src/sync/sync.ts`
  - Read: plan.md D-18 (all five numbered changes and the "what is untouched" list); `src/sync/sync.ts:203-277`, `:409-458`; contracts/rpc.md error register (`42501` row); spec.md FR-041, FR-020, SC-017
  - substrate: `sync-engine` (VALIDATED → changed here → re-verified by T039)
  - verify: `npm test -- --run --project stack tests/stack/push-refusal-fallback.test.ts` green, **and** the full stack suite green twice consecutively — the LWW and soft-delete P0 files unedited
  - done-when: FR-041 and SC-017 hold; `git diff src/sync/sync.ts` shows changed lines **only** inside the push loop and the wrapper exports — zero changed lines in `104-141` and `409-458` (the lockstep check in the sibling reviewer card re-proves this mechanically); no retry loop is unbounded
  - blocked-by: T035
- [ ] T037 [data] Write `tests/stack/member-offline-round-trip.test.ts` (US6, FR-019/FR-020): B, a member, edits a team task while offline — held locally and marked unsent — then reconnects and the edit is accepted and reaches A; two members edit the same team row and the older edit loses **at the backend and, independently, at the client merge step**, exactly as P0 pinned it for personal rows; a membership change made while a client was offline reaches that client's cache **on its next cycle** (`members` travelling the generic loop); and B, removed while offline with unsent edits to that workspace, has those edits refused on reconnect without retrying forever and **without stalling any other row or table** (edge case 1, plan R-14)
  - Write: `tests/stack/member-offline-round-trip.test.ts`
  - Read: spec.md US6 acceptances 1–6, FR-019, FR-020; plan.md D-7, D-8, R-14; `tests/stack/offline-round-trip.test.ts` and `tests/stack/lww-conflict.test.ts` (the P0 personal equivalents, read-only); `tests/harness/sync.ts` (post-T004)
  - substrate: `sync-engine` (VALIDATED), `membership` (new, UNTESTED), `multi-account-cache` (new, UNTESTED)
  - verify: `npm test -- --run --project stack tests/stack/member-offline-round-trip.test.ts`
  - done-when: FR-019's "learns on its next cycle" is asserted for a `members` row, and the refused-write path is asserted to leave other tables progressing (US6 acceptance 6, now carried by D-18's fallback)
  - blocked-by: T036, T019
- [ ] T038 [reviewer] **LWW lockstep statement.** `src/sync/sync.ts` **does** change in this feature (D-18), which makes this check more important, not less: assert mechanically that neither *enforcement point* moved. `git diff <merge-base with main> -- src/sync/sync.ts` must touch no line of the merge range (`sameRow`/`isNewer`/`mergeRows`, `src/sync/sync.ts:104-141,409-458`) — every changed line must fall inside the push loop — and `git diff <merge-base> -- supabase/schema.sql` must touch no line of the `keep_newer()` function body (`supabase/schema.sql:142-153`). The rule is one rule with two enforcement points; P1 changes neither, and if one of them *did* change, both must change in the same change set or it is a **FINDING**. Reviewer cards write nothing: the diff excerpt is reported in this task's report, and `coordinator` transcribes it into `specs/002-team-workspaces/receipts.md` (see T053)
  - Write: —
  - Read: `CLAUDE.md` "LWW lockstep"; ADR-0001 §3; spec.md FR-020; plan.md D-8, Constitution Check row "LWW lockstep"
  - substrate: `sync-engine`, `supabase-schema`
  - verify: `git diff $(git merge-base HEAD main) -- src/sync/sync.ts supabase/schema.sql` reviewed line by line, with the two protected ranges shown untouched, and the excerpt reported for `coordinator` to paste into `receipts.md`
  - done-when: FR-020 is evidenced by an actual diff, not by assertion; the task report names both ranges, shows zero changed lines in each, and lists the push-loop line range D-18 did change, ready for `coordinator` to transcribe
  - blocked-by: T037
- [ ] T039 [coordinator] **Re-verify `sync-engine` in place.** Its code changed (D-18), so its `VALIDATED` standing from `e7f258d` no longer covers what the entry describes: add `tests/stack/push-refusal-fallback.test.ts` to the entry's `tests:` list, re-run the entry's `verify:` command **verbatim from the map text**, and record the run in `receipts.md`. The `last-verified` SHA and the `(single-operator)` sign-off are stamped with the rest of the map in TG-4 — this card is the *evidence*, that card is the *signature*, and separating them is deliberate: the proof belongs next to the change, the stamp belongs next to the merge SHA
  - Write: `docs/validation-map.md`, `specs/002-team-workspaces/receipts.md`
  - Read: `docs/validation-map.md` (`sync-engine` entry); plan.md D-15, D-18; CLAUDE.md "Definition of done"
  - substrate: `sync-engine`
  - verify: the entry's own `verify:` command, run from the map text and passing; output recorded
  - done-when: no `VALIDATED` claim on `sync-engine` rests on a receipt that predates the push-path change (CLAUDE.md reviewer duty 5); the entry's `tests:` list names the new file
  - blocked-by: T036
- [ ] T040 [data] Extend `tests/local/db-api-p1-surface.test.ts` with the **new** `db-api` surface (the split promised in T001): `createWorkspace(name, 'team')` writes only the workspace row and **no** local `members` row (D-6); `listMembers` reads from Dexie; `removeMember` soft-deletes and queues without a network call; `updateTask(id, { assignee })` round-trips through `TaskPatch`. `memberEmails`/`addMemberByEmail` are online-only and are covered by TG-1's stack tests, not here — say so in the file header
  - Write: `tests/local/db-api-p1-surface.test.ts`
  - Read: `src/db/api.ts` (post-T031); plan.md D-6, D-9, D-11; spec.md FR-024, FR-026
  - substrate: `db-api` (VALIDATED — re-verified in this PR), `local-cache`
  - verify: `npm test -- --run --project local tests/local/db-api-p1-surface.test.ts` — green with the stack stopped
  - done-when: every `db-api` function this feature adds that *can* be exercised offline has a passing pin; the two that cannot are named in the header with the stack test that covers them instead (FR-024, FR-026)
  - blocked-by: T031

**Checkpoint**: membership, `kind` and `assignee` reach the cache and the sync engine through the
same path as everything else. The interface still shows nothing new.

---

## TG-3: The seven interface affordances — and nothing else

**Purpose**: the **seven** affordances spec.md now names — FR-024's original five, plus the kind
switch (US8) and the Logins section (US7) — each behind its own guard: `kind === 'team'` for the
team ones, ownership for the owner-only ones, the cached admin flag for Logins. Plus R-11's guard on
two **existing** controls. `src/views/` gains **zero** changes (FR-025). `src/i18n/dict.ts` is owned
by exactly one card (T041); every other card reads it. `src/components/Settings.tsx` is written by
**six** cards (T043, T044, T045, T046, T048, T049) and is therefore strictly serial. Nothing here
enforces anything: every guard is convenience, and the server refuses a non-owner and a non-admin
regardless (D-11).

- [ ] T041 [ui] Add every new i18n key to `src/i18n/dict.ts` in **both** `ru` and `en`, in one card, so no other card in this taskgroup writes that file: `workspace.kindPersonal`, `workspace.kindTeam`, `members.section`, `members.owner`, `members.member`, `members.add`, `members.emailPlaceholder`, `members.noAccountHere`, `members.remove`, `members.confirmRemove`, `task.assignee`, `task.unassigned`. **No existing string is reworded, shortened or retranslated** (CLAUDE.md, `designer` role rule, applied here too). Hiding a control needs no key. Ownership: `src/i18n/` is owned by `ui` for adding keys (CLAUDE.md, ui role, amended 2026-09-13); the designer rule forbids rewording existing strings, which this card does not do.
  - Write: `src/i18n/dict.ts`
  - Read: plan.md D-11 (the table's i18n column and the note below it); `src/i18n/dict.ts:1-40` (the dictionary type that makes a missing language a compile error); `CLAUDE.md` → `designer` role, last bullet
  - substrate: `i18n-state` (UNTESTED, LOW — stays UNTESTED through P1 by design, ADR-0003 Consequences)
  - verify: `npx tsc -b --noEmit` clean (a missing language is a compile error) and `npm run lint` clean
  - done-when: all twelve keys exist in both languages; `git diff src/i18n/dict.ts` contains **only additions** (FR-024, FR-025)
  - blocked-by: T040
- [ ] T042 [ui] **Affordance 1** — choose **team** when creating a workspace: one kind toggle in `WorkspaceMenu`'s existing `AskName` flow in `src/components/Header.tsx`, calling `createWorkspace(name, kind)`. Personal remains the default when no choice is expressed (US1 acceptance 2). The toggle is the only new element; no reordering of what is already on screen
  - Write: `src/components/Header.tsx`
  - Read: plan.md D-11 row 1, D-6 (why no local `members` row is written); `src/components/Header.tsx` (`WorkspaceMenu`, `AskName`); `src/db/api.ts` `createWorkspace` (post-T031); spec.md FR-024, US1
  - substrate: `chrome-components` (UNTESTED, LOW — stays UNTESTED through P1 by design), `db-api` (VALIDATED)
  - verify: `npx tsc -b --noEmit && npm run lint && npm run build`, plus `git diff --stat -- src/views/` printing nothing
  - done-when: FR-024 affordance 1 exists; creating without expressing a choice yields `personal` (US1 acceptance 2); zero changes under `src/views/` (FR-025)
  - blocked-by: T041
- [ ] T043 [ui] **Affordance 6** — switch a workspace's kind, **owner only**: in `src/components/Settings.tsx`, a control that flips `kind` between `personal` and `team` through `db-api`'s ordinary workspace update — **no RPC, no special path** (contracts/rpc.md, "Kind switching is not an RPC"). Because team → personal removes every member, the control **confirms first**, in words that say what is lost: the members are removed and only the owner keeps access. Rendered only when `kind` is resolvable and the viewer is the owner; hidden entirely for a member (the same guard as the sibling R-11 card). Text from `src/i18n/dict.ts` in both languages, never inline
  - Write: `src/components/Settings.tsx`, `src/components/Settings.css`
  - Read: plan.md D-11 affordance 6, **D-6′**, R-11, R-19; spec.md US8, FR-034–FR-036, FR-024; `src/components/Settings.tsx`; `src/db/api.ts` (the update path); data-model.md §2
  - substrate: `db-api`, `membership`
  - verify: `npx tsc -b --noEmit` clean; manual check in the deployed walk (step list in the TG-5 walk card) — flip to personal, confirm the member list empties; flip back, confirm the owner row returns
  - done-when: FR-034–FR-036 hold from the interface; the switch writes **only** `kind` (the consequences are the trigger's job, not the component's); the confirmation states the consequence rather than asking a bare "are you sure?"; no member ever sees the control
  - blocked-by: T042
- [ ] T044 [ui] **Affordance 2** — see the member list: a new `members` section in `src/components/Settings.tsx`'s `SECTIONS`, rendered **only** when `workspace.kind === 'team'`, listing members by email via `listMembers` + `memberEmails` and showing each one's level with `members.owner` / `members.member`. Note (D-6): the owner's own membership row arrives on the **next pull**, not immediately at creation — the list must render correctly while it is still empty, not error
  - Write: `src/components/Settings.tsx`, `src/components/Settings.css`
  - Read: plan.md D-11 row 2 and "Placement rationale", D-6 (last paragraph); `src/components/Settings.tsx` (`SECTIONS`, the workspace section); `src/db/hooks.ts` (post-T034); contracts/rpc.md `workspace_member_emails`; spec.md FR-007, FR-024
  - substrate: `chrome-components` (UNTESTED, LOW), `db-api`, `membership` (new)
  - verify: `npx tsc -b --noEmit && npm run lint && npm run build`, plus `git diff --stat -- src/views/` printing nothing
  - done-when: FR-024 affordance 2 exists behind a `kind === 'team'` guard; a person who owns only personal workspaces sees no new section (SC-008)
  - blocked-by: T042
- [ ] T045 [ui] **Affordance 3** — add a member by email, **owner only**: an email field plus submit in the same `members` section, calling `addMemberByEmail(ws, email)`, rendered only when the signed-in person is the workspace's owner. On `DA404`, render the translated `members.noAccountHere` — the client branches on `error.code`, **never** on the server's message text (FR-008, SC-010). Hiding the control is a convenience; the refusal is the backend's (FR-006)
  - Write: `src/components/Settings.tsx`, `src/components/Settings.css`
  - Read: contracts/rpc.md (error table); plan.md D-11 row 3, D-9 "Error shape"; spec.md FR-006, FR-008, SC-010, edge cases 4 and 5
  - substrate: `chrome-components` (UNTESTED, LOW), `db-api`, `membership` (new)
  - verify: `npx tsc -b --noEmit && npm run lint && npm run build`, plus `git diff --stat -- src/views/` printing nothing
  - done-when: FR-024 affordance 3 exists; the "no account on this origin" message is rendered from `src/i18n/dict.ts` on `error.code === 'DA404'` and from nothing else (SC-010)
  - blocked-by: T044
- [ ] T046 [ui] **Affordance 4** — remove a member, **owner only**: a remove control per member row in the same section, reusing the existing `Confirm` component with `members.confirmRemove`, calling `removeMember(ws, memberId)`. The owner's own row carries no remove control — in P1 the owner cannot be removed and cannot leave (FR-010, spec Q2)
  - Write: `src/components/Settings.tsx`, `src/components/Settings.css`
  - Read: plan.md D-11 row 4; `src/components/Confirm.tsx`; spec.md FR-009, FR-010, edge case "The last owner tries to leave or be removed"
  - substrate: `chrome-components` (UNTESTED, LOW), `db-api`, `membership` (new)
  - verify: `npx tsc -b --noEmit && npm run lint && npm run build`, plus `git diff --stat -- src/views/` printing nothing
  - done-when: FR-024 affordance 4 exists; no path in the UI offers to remove the owner (FR-010)
  - blocked-by: T045
- [ ] T047 [ui] **Affordance 5** — set/clear a task's assignee and see it on the task: one new `<Field>` in `src/components/TaskDialog.tsx` beside the existing ones, rendered **only** in a team workspace, offering that workspace's members plus `task.unassigned`, calling `updateTask(id, { assignee })`; and the assignee shown on the card, in the same conditional style the existing optional `GcalRow` uses
  - Write: `src/components/TaskDialog.tsx`, `src/components/TaskDialog.css`
  - Read: plan.md D-11 row 5 and "Placement rationale"; `src/components/TaskDialog.tsx` (`Field`, `GcalRow`); spec.md US5 acceptances 1–2, FR-024; contracts/rpc.md "Freshness / offline" (Option A: no name offline until Q-A is answered)
  - substrate: `task-dialog` (UNTESTED, NORMAL — stays UNTESTED through P1 by design, ADR-0003 Consequences), `db-api`
  - verify: `npx tsc -b --noEmit && npm run lint && npm run build`, plus `git diff --stat -- src/views/` printing nothing
  - done-when: FR-024 affordance 5 exists behind a `kind === 'team'` guard; a personal workspace's task dialog is byte-identical in behaviour (SC-008)
  - blocked-by: T046
- [ ] T048 [ui] **Affordance 7** — the **Logins** section, admin only: a section in `src/components/Settings.tsx` listing the instance's logins (`listLogins`) and offering create, set-password, remove and grant/revoke-admin, each through `db-api` → `src/sync/sync.ts` → RPC (FR-026, never Supabase directly). **Passwords use `type="password"` inputs, are held in component state only for the duration of the call, and are never written to Dexie, never logged, never put in a URL and never echoed back after success (FR-044)** — the minted credential is shown once, at creation, for the admin to hand over out of band, and is not recoverable afterwards. Every error code from the register is rendered as its own message: `DA001` (not an admin), `DA010`/`DA011` (malformed email, weak password), `DA012` (email taken), `DA404` (no such login), `DA013` (that is your own login), `DA014` (this login still owns a team workspace), `DA015` (cannot remove the last admin). The section renders only when the cached admin flag says so — **that is convenience, not enforcement**: the server refuses a non-admin regardless, and the plan says so in D-11
  - Write: `src/components/Settings.tsx`, `src/components/Settings.css`
  - Read: plan.md D-11 affordance 7 and the FR-044 paragraph, D-16, D-17; contracts/rpc.md (the eight operations and the error-code register); spec.md US7, FR-037–FR-044, SC-015, SC-016; `src/components/Settings.tsx`; `src/i18n/dict.ts` (the `logins.*` keys, added in the i18n card)
  - substrate: `account-provisioning`, `db-api`, `multi-account-cache`
  - verify: `npx tsc -b --noEmit` clean; `grep -rn "password" src/components/Settings.tsx` shows no persistence, no `console.*` and no query-string use; manual check in the deployed walk — create a login, sign in as it in a second browser profile
  - done-when: FR-037–FR-044 hold from the interface; every register code has a distinct message (no generic "something went wrong"); the section is absent for a non-admin and harmless if it were not (SC-016); SC-020 holds — no new environment variable and no key was added to make this work
  - blocked-by: T047
- [ ] T049 [ui] **R-11 guard — not a sixth affordance.** In `src/components/Settings.tsx`'s workspace section, hide **both** the existing rename field and the existing delete-workspace button for a **non-owner of a team workspace**. Both are required by FR-005, and both are queue hazards, not cosmetics: a member's rename dirties the workspace row and is refused by the unchanged workspace `with check` (RLS `42501`). After D-18 that refusal no longer wedges the queue — the row is retried alone, dropped and reconciled on the next pull — so the reason this guard exists is the **half-state the control produces**, not the queue: the member sees a rename that silently never happens. A member's `deleteWorkspace()` would soft-delete every child and then be refused on the workspace row, leaving an empty-looking live workspace. **Nothing is added and nothing is reordered** — two existing controls become conditional
  - Write: `src/components/Settings.tsx`
  - Read: plan.md D-11 "Note", R-11, R-14 (fixed by D-18), D-18; `src/components/Settings.tsx:153-155` (rename field, `useAutosave`); `src/sync/sync.ts:203-277` (the push loop, read-only); spec.md FR-005, FR-024
  - substrate: `chrome-components` (UNTESTED, LOW), `team-rls` (new)
  - verify: `npx tsc -b --noEmit && npm run lint && npm run build`, plus `git diff --stat -- src/views/` printing nothing
  - done-when: FR-005 holds in the interface as well as the backend; a personal workspace's Settings is unchanged (both controls still shown) (FR-025, SC-008)
  - blocked-by: T047
- [ ] T050 [ui] **FR-025 / SC-008 receipt.** Capture and record the interface-non-change evidence: `git diff --stat $(git merge-base HEAD main) -- src/views/` showing **zero** lines, and `git diff --stat $(git merge-base HEAD main) -- src/components/ src/styles/` showing changes confined to `Header.tsx`, `Settings.tsx`, `Settings.css`, `TaskDialog.tsx`, `TaskDialog.css` and nothing else. No vitest claim is made for FR-025 — the spec says so explicitly
  - Write: `specs/002-team-workspaces/receipts.md`
  - Read: spec.md FR-025, SC-008; plan.md "The UI entries stay UNTESTED, deliberately", D-14 step 5
  - substrate: `views-core`, `task-dialog`, `chrome-components` (all UNTESTED by design through P1)
  - verify: `git diff --stat $(git merge-base HEAD main) -- src/views/` prints nothing, and the `src/components/` stat lists exactly the five files above; both outputs pasted into `receipts.md`
  - done-when: SC-008's "new affordances and 0 other visible changes" has a diff receipt covering all **seven** affordances; any sixth changed component file is a **FINDING** for the reviewer, not a rationalisation
  - blocked-by: T049

**Checkpoint**: the demo is walkable locally. Nothing in the map has moved yet.

---

## TG-4: Map, receipts, docs — the truth-telling taskgroup

**Purpose**: FR-031's "in the same change that adds the behaviour" is satisfied because this
taskgroup ships in the same PR as TG-1..TG-3. Three cards here (T054, T055, T056) carried
owner-blocked decisions; the owner gate on 2026-09-13 (evening) settled all three, and their cards
now implement the approved outcomes.

- [ ] T051 [coordinator] Add the **four** new HIGH entries to `docs/validation-map.md` — `membership`, `team-rls`, `multi-account-cache`, `account-provisioning` — with the `kind`, `criticality: HIGH`, `paths`, `depends-on` and `scenarios` that `ARCHITECTURE.md §2` already assigns them, each with a real `verify:` command and `tests:` list, and flip each to `VALIDATED` with `last-verified: <sha> <date>` and `sign-off: Andrii Tkhorenko (single-operator)` backed by TG-1/TG-2's receipts. `paths` for `membership` ⊇ `supabase/schema.sql`, `src/db/api.ts`; for `team-rls` ⊇ `supabase/schema.sql`; for `multi-account-cache` ⊇ `src/db/local.ts`, `src/db/types.ts`; for `account-provisioning` ⊇ `supabase/schema.sql`, `src/db/api.ts`, `src/sync/sync.ts`, `src/components/Settings.tsx`, with `verify: npm test -- --run --project stack tests/stack/logins-provisioning.test.ts` — the entry is written out in full in plan.md D-15, so nothing here is invented
  - Write: `docs/validation-map.md`
  - Read: `docs/project-structure.md` (map grammar, closed status vocabulary); `ARCHITECTURE.md §2` (fork target — new components); plan.md D-15, "Validation substrate"; `specs/002-team-workspaces/receipts.md`
  - substrate: `membership`, `team-rls`, `multi-account-cache`, `account-provisioning` (this task is where they are created and flipped)
  - verify: named manual check — each of the four entries names a command that was actually run in this PR, and each command is re-run once from the map text itself and passes
  - done-when: SC-004's "unproven HIGH-tier entries introduced by this feature 4 → 0" holds; no entry is `VALIDATED` without a receipt (CLAUDE.md reviewer duty 5)
  - blocked-by: T050
- [ ] T052 [coordinator] Re-verify and re-sign the **four** existing entries this feature touches — including `sync-engine`, whose code D-18 changed and whose final re-sign belongs here even though the change was proven in TG-2 (add `tests/stack/push-refusal-fallback.test.ts` to its `tests:` list, re-run its `verify:` verbatim, and set `last-verified` to this PR's SHA): `supabase-schema` (gains no new file but a materially changed one — re-run its `verify:` and add `tests/stack/team-*.test.ts` to `tests:`), `local-cache` (`paths` unchanged, Dexie v3 — re-run and add `tests/local/no-wipe-on-reach-growth.test.ts`), `db-api` (`paths` unchanged, surface widened — re-run and keep `tests/local/db-api-p1-surface.test.ts`). A component whose `paths` or behaviour change without its map entry changing is a **FINDING** (CLAUDE.md reviewer duty 5)
  - Write: `docs/validation-map.md`
  - Read: `docs/validation-map.md` (the three entries); plan.md D-15; `specs/002-team-workspaces/receipts.md`
  - substrate: `supabase-schema`, `local-cache`, `db-api`, `sync-engine`
  - verify: each of the four entries' `verify:` command is run verbatim from the map text and passes; outputs recorded
  - done-when: all four carry a `last-verified` SHA from this PR and a `(single-operator)` sign-off (FR-031); `sync-engine` no longer stands on a receipt that predates the push-path change (SC-004)
  - blocked-by: T051
- [ ] T053 [coordinator] Complete `specs/002-team-workspaces/receipts.md` in the shape P0 established: the full-suite receipt (`npm test -- --run`, twice), the CI receipt (a green run URL on `002-team-workspaces`), T012's inversion demonstration (executed or the named fallback), T027's P0-unedited diff, T038's lockstep diff (including the push-loop range D-18 changed), T039's `sync-engine` re-verification, T018's provisioning canary run (R-15), T050's interface diff, FINDINGS with dispositions, and `Sign-off: Andrii Tkhorenko (single-operator)`. **No password minted in any walk or test is written into the receipt** (FR-044)
  - Write: `specs/002-team-workspaces/receipts.md`
  - Read: `specs/001-validation-spine/receipts.md` (shape); plan.md D-14, D-15; spec.md SC-003, SC-005, SC-008, SC-013, SC-014
  - substrate: all entries touched by this feature
  - verify: `npm test -- --run` green twice consecutively with both runs recorded, and the CI run on this branch green with its URL recorded
  - done-when: SC-014 holds (the whole body of evidence runs from the same single command as P0's, unattended, no browser) and SC-013 holds (**0** credentials in the diff, **0** runs touching a hosted project)
  - blocked-by: T052
- [ ] T054 [coordinator] **F-5 — sign-out ordering. Owner-approved wording, 2026-09-13.** Record the disposition on `docs/validation-map.md`'s `supabase-auth` entry, verbatim: `accepted-risk: "sign-out ordering uncovered; browser-bound. Owner: Andrii Tkhorenko, 2026-09-13, expires end of P2 (Playwright arrives, ADR-0003)"`. The supporting fact the owner weighed at the gate: P1 turns out **not** to change the sign-out order at all — `src/auth/useSession.ts:112-118` and `src/components/Settings.tsx`'s `AccountSection` sign-out path are not in this feature's diff, so FR-023 is satisfied by the files not being touched. **Silently leaving F-5 as it is is prohibited** (FR-032, SC-011)
  - Write: `docs/validation-map.md`, `specs/002-team-workspaces/receipts.md`
  - Read: spec.md "Inherited accepted risk — F-5", FR-023, FR-032, SC-011; plan.md D-12, Owner question Q-B; `specs/001-validation-spine/receipts.md` F-5; `src/auth/useSession.ts:112-118`; `src/components/Settings.tsx:208-224`
  - substrate: `supabase-auth` (UNTESTED, carries F-5)
  - verify: `git diff $(git merge-base HEAD main) -- src/auth/ src/components/Settings.tsx` reviewed and shown to contain no change to the sign-out path, **plus** the owner's recorded decision text pasted into the map entry
  - done-when: SC-011 holds — F-5 ends this feature either covered by a passing check or re-recorded with an owner name, a date and an expiry; the number of ways it ends silently unaddressed is 0
  - blocked-by: T053
- [ ] T055 [coordinator] **ADR-0001 Consequences amendment — owner-approved, 2026-09-13.** Amend ADR-0001's Consequences with a dated note that the P1 cache change is additive (D-10 stands: cache unchanged in P1, Dexie v3 additive); regenerate nothing else. ADR-0001's Consequences called the multi-account cache rework "unavoidable in P1"; D-10 concludes the opposite, and the spec agrees with D-10: FR-021, FR-022 and SC-012 require `claimCache`/`wipeLocal` to behave exactly as today, so P1's honest `multi-account-cache` deliverable is confirmed-unchanged semantics plus an additive Dexie version. The owner approved landing this as an amendment note in ADR-0001, not a new ADR
  - Write: `docs/decisions/ADR-0001-fork-contract.md`, `docs/validation-map.md`
  - Read: `docs/decisions/ADR-0001-fork-contract.md` (Consequences); plan.md D-10 "Why the cache rework shrinks to nothing"; spec.md FR-021, FR-022, SC-012
  - substrate: `multi-account-cache` (new), `local-cache`
  - verify: named manual check — the amendment note exists in ADR-0001's Consequences with a date and a sign-off
  - done-when: the divergence between D-10 and ADR-0001's Consequences is resolved in writing, matching the owner's 2026-09-13 gate decision
  - blocked-by: T053
- [ ] T056 [coordinator] **Q-A — member email caching. Owner-approved, 2026-09-13: Option B.** Implement Option B: `memberEmails()` in `src/db/api.ts` writes `meta` keys `member-email:<uuid>` after each successful `workspace_member_emails` RPC call; reads fall back to the cache when offline; `wipeLocal()` clears every `member-email:` key. Never synced, never authoritative, drift bounded to one sync cycle — on the grounds that FR-019's "learns on its next cycle" is the intended standard for derived data and that an assignee with no name is a worse product than a one-cycle-stale name. This is a change inside the single `memberEmails()` function in `src/db/api.ts` plus one `meta` key in `wipeLocal`'s clear list in `src/db/local.ts` — no schema change, no wire change, no second copy that can outlive a sign-out
  - Write: `src/db/api.ts`, `src/db/local.ts`, `specs/002-team-workspaces/receipts.md`
  - Read: spec.md FR-007, clarification Q1, FR-019, owner gate 2026-09-13 (evening); plan.md Owner question Q-A, R-12, D-9 "Why no `profiles` table"; contracts/rpc.md "Freshness / offline"; `src/gcal/sync.ts:26-27` (the existing per-device `meta` cache shape this copies)
  - substrate: `db-api`, `local-cache`, `multi-account-cache` (new)
  - verify: `npm test -- --run --project local` green, including a new assertion that `wipeLocal()` clears every `member-email:` key and that no `member-email:` key is ever pushed to the wire
  - done-when: FR-007's "no second copy of the email MUST be stored" is satisfied under the derived-cache reading the owner approved at the gate; the local-tier test asserting the cache is wiped with the rest and never pushed is green
  - blocked-by: T053
- [ ] T057 [reviewer] Whole-branch review against the five reviewer duties, verdict short (a list of findings, or "clean"): **(1) code quality** — correctness, dead code, duplication, and any leftover of the withdrawn `pin_workspace_kind` trigger or of a `delete from auth.users`; **(2) personal-must-not-regress** — does anything in this diff change what a `kind: personal` workspace does, in data, sync, or views? **(3) spec control** — is every button, field and behaviour in the diff named in `spec.md` FR-024 or required by an FR? **(4) origin-invariant control** — is there any cross-origin reference, query, shared identity or token, or any "origin" column or table anticipating a model that needs no schema support (FR-027, SC-009)? **(5) map discipline** — did any component's `paths` or behaviour change without its map entry changing; is any `VALIDATED` claim unbacked by a receipt; is any sign-off presented as anything other than `(single-operator)`? Anything debatable goes to the owner **via the coordinator**, not decided here
  - Write: — (read-only; the findings list goes to the coordinator in the task report, no file written)
  - Read: `git diff $(git merge-base HEAD main)` (whole branch); `CLAUDE.md` → `reviewer` role, "What replaces upstream's 'What must not exist'"; spec.md "Personal must not regress", FR-024, FR-025, FR-027, FR-030..FR-033; `docs/validation-map.md`; `specs/002-team-workspaces/receipts.md`
  - substrate: every entry this feature touches
  - verify: `npm test -- --run` green, `npx tsc -b --noEmit` clean, `npm run lint` clean, `npm run build` clean, `git diff $(git merge-base HEAD main) -- src/views/` empty, and `git diff $(git merge-base HEAD main) | Select-String -Pattern "(?i)(service_role|secret|api[_-]?key|token|password)"` reviewed line by line with no credential present
  - done-when: SC-009 (**0** origin columns/tables/cross-origin references), SC-013 (**0** credentials) and SC-003 (**0** P0 edits) each have a named check behind them; the verdict is recorded and every finding has a disposition
  - blocked-by: T053

**Checkpoint**: the map tells the truth — four new HIGH entries created and validated, four existing
entries re-verified and re-signed, `sync-engine` among them — the receipts back it, and every owner
question this feature raised was answered by the owner at the 2026-09-13 gates, not by an agent.

---

## TG-5: The hosted demo walk — owner-run, manual, outside the suite

**Purpose**: SC-001's eighteen-step walk on one deployment with two accounts — the second of which is
**created inside the app** — after the unattended
suite is green. **Nothing here runs in the suite and nothing in the suite touches a hosted project**
(SC-013). Steps marked **[owner]** are performed by the fork owner in person; no agent performs them
and no agent handles a hosted key.

- [ ] T058 [owner] Re-run the whole of `supabase/schema.sql` in the **hosted** project's SQL editor. It is idempotent, and re-running it is upstream's own convention (ADR-0005). Expect no error and no row change — in particular, every pre-existing workspace must read `kind = 'personal'` afterwards without a backfill (US1 acceptance 1, D-2)
  - Write: `specs/002-team-workspaces/receipts.md`
  - Read: plan.md D-14 step 1, D-2; `supabase/schema.sql` (post-TG-1); ADR-0005
  - substrate: `supabase-schema` (VALIDATED)
  - verify: named manual check (owner-run) — the SQL editor reports success, and `select kind, count(*) from public.workspaces group by 1` returns only `personal` rows for pre-existing data; both outputs recorded
  - done-when: US1 acceptance 1 holds on real data ("no row changed value, no row became team by omission") (SC-001 too)
  - blocked-by: T057
- [ ] T059 [owner] **Make the hosted origin's admin explicit — the one manual database intervention.** The owner's account predates this change, so `users_seed_first_admin` never fired for it: run once in the hosted SQL editor `insert into public.instance_admins (user_id, granted_by) select id, null from auth.users where email = '<owner>' on conflict do nothing;` and confirm exactly one row. This is a **one-time backfill on an existing origin**, not something a fresh instance needs — on a fresh origin the trigger does it, which `tests/stack/logins-provisioning.test.ts` asserts. It replaces the old "create account B in the dashboard" step: **B is now minted inside the app** during the walk, which is the point of the demo (FR-037, FR-040, SC-001)
  - Write: `specs/002-team-workspaces/receipts.md`
  - Read: plan.md D-14 step 2, D-16; spec.md FR-037, FR-040, SC-001; contracts/policies.sql fork block D
  - substrate: `account-provisioning` (VALIDATED after T051), `supabase-auth`
  - verify: named manual check (owner-run) — `select count(*) from public.instance_admins` returns 1, and signing in to the deployed app shows the Logins section; **no email, password or hosted URL is recorded in the repository** (FR-033, FR-044)
  - done-when: exactly one manual intervention was needed and it created no account (SC-001); the admin flag is held by the owner's own login
  - blocked-by: T058
- [ ] T060 [owner] **Disable public sign-up on the hosted project — and only after the admin backfill.** In the Supabase dashboard, turn off e-mail sign-ups (Authentication → Providers → Email → "Enable sign-ups"), then verify by attempting a sign-up against the deployed app and confirming it is refused. **Order matters and is not cosmetic**: doing this before the backfill card would leave an instance with no admin and no way to create one from the app — recovery would then need the SQL editor anyway. From this point the only way a new account exists is an admin minting it in the Logins section, which is the point of US7 (FR-039, SC-019)
  - Write: `specs/002-team-workspaces/receipts.md`
  - Read: plan.md D-14 steps 3–4; spec.md FR-039, SC-019; ADR-0006 §D
  - substrate: `supabase-auth`, `account-provisioning`
  - verify: named manual check (owner-run) — a sign-up attempt on the deployed origin is refused, recorded with the date and the refusal the app showed; **no hosted URL, e-mail or credential is written into the repository** (FR-033)
  - done-when: SC-019 holds (the instance is closed); creating a login through the app still works afterwards, proving the two settings are independent
  - blocked-by: T059
- [ ] T061 [infra] Build and deploy: `npm run build`, then `npx wrangler deploy`, with the **same** `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` already in use and `CLOUDFLARE_API_TOKEN` supplied **from the operator's environment**. **Never `wrangler login`** (interactive) and **never a key, token or hosted URL in the repository or in any committed file** (FR-033, SC-013)
  - Write: — (no repository file; the deploy output is recorded by T063)
  - Read: plan.md D-14 step 3; `wrangler.jsonc`; `README.md` (deploy section); `CLAUDE.md` → `infra` role ("Secrets never enter the repository, under any circumstances")
  - substrate: `env-boot` (VALIDATED)
  - verify: `npm run build` exits 0 and `npx wrangler deploy` reports a successful deployment; then `git status` is clean and `git diff $(git merge-base HEAD main)` contains no token, key or hosted URL
  - done-when: the deployed build serves the seven affordances; SC-013 and SC-020 hold (**0** credentials added to the repository or to any environment — provisioning needs no new variable)
  - blocked-by: T060
- [ ] T062 [owner] Walk the **eighteen steps** of spec.md "First demo — the acceptance walk" on two browsers or two devices, A and B, recording pass/fail **per step**, beginning with A minting B's login in the Logins section and handing the credential over out of band (never into the repo, FR-044). The spec's step list is authoritative and is not restated here; the earlier eleven-step summary in this card is superseded by it. In outline: (1) A creates B's login; (2) A adds tasks, one with a due date, one with a label; (3) A opens the member list and adds B by email; (4) A assigns one task to B, leaves another unassigned; (5) B signs in on a second device and sees the team workspace with A's rows and the assignee; (6) B's list contains **none** of A's personal workspaces — not greyed out, not empty, not present; (7) B goes offline, edits a task, creates another; (8) B comes back online and the queued edits are accepted; (9) A sees B's edit and B's new task without doing anything special; (10) A's personal workspaces behave exactly as before throughout; (11) A removes B — B's next cycle shows the workspace gone and the assigned task reads unassigned for A
  - Write: `specs/002-team-workspaces/receipts.md`
  - Read: spec.md "First demo — the acceptance walk" (all eighteen steps, authoritative), SC-001, SC-002, SC-006, SC-015, SC-019; plan.md D-14 step 5, D-6 (the owner's own member row arrives on the next pull, so step 3's list is correct after one cycle, not instantly)
  - substrate: `membership`, `team-rls`, `multi-account-cache` (all VALIDATED after T051)
  - verify: named manual check (owner-run) — eighteen recorded outcomes, one line per step, with the date and the deployed build's SHA
  - done-when: SC-001 holds (the walk completes end to end with zero manual database intervention beyond T059's one-time admin backfill); SC-015 holds (a login minted in the app signs in); any failed step is a FINDING with a disposition, never a silently retried step
  - blocked-by: T061
- [ ] T063 [coordinator] Close the feature: fold T058–T062's outcomes into `specs/002-team-workspaces/receipts.md` alongside T050's `git diff --stat` receipt, confirm the Definition of Done from `CLAUDE.md` item by item (map entry updated in the same PR; every `verify:` command actually run; CI green — install, typecheck, lint, build, test; personal workspaces demonstrably unchanged; nothing in the diff outside the spec; no credential, key or token anywhere in the diff), and confirm the three formerly owner-blocked items (T054, T055, T056) are recorded as answered at the 2026-09-13 (evening) gate. **The coordinator commits; no agent in this list commits on its own** (task-brief rule, CLAUDE.md Git)
  - Write: `specs/002-team-workspaces/receipts.md`
  - Read: `CLAUDE.md` → "Definition of done", Git; plan.md D-14, D-15; T050, T053, T057 outputs
  - substrate: every entry this feature touches
  - verify: `npm test -- --run` green, `npx tsc -b --noEmit` clean, `npm run lint` clean, `npm run build` clean, CI green on the branch, and `git log --stat` showing the map change in the same PR as the behaviour
  - done-when: every bullet of CLAUDE.md's Definition of done is checked off with a named receipt, and SC-001..SC-014 each have a receipt or a recorded owner-blocked disposition
  - blocked-by: T062

---

## Dependencies & Execution Order

- **TG-0 → TG-1** is a hard gate: ADR-0002 forbids building on `UNTESTED` substrate, and `db-api`
  is the door every affordance goes through. The `sync-engine` flake repair is in the same gate
  because a `VALIDATED` entry standing on a flaky receipt is a map-discipline defect, and the
  regression net for the whole of P1 is exactly those P0 tests.
- **Within TG-1** the P-gate applies again: T007–T019 (evidence and harness) are authored before
  T020–T026 (schema), and each schema card is verified by turning a named test green. T020 → T021 →
  T022 → T023 → T024 → T025 → T026 are strictly serial — one file, `supabase/schema.sql`. The two
  provisioning cards sit **last** on purpose: fork block D (the admin table and the `auth.users`
  trigger) before fork block E (the five routines), because every routine's first line calls
  `is_admin()`.
- **Within TG-2 the P-gate applies to `sync-engine` specifically**: it is `VALIDATED` HIGH-tier
  substrate whose code this feature changes, so T035 (the failing test) is authored **before** T036
  (the push-loop fallback), and T039 re-verifies the entry immediately afterwards rather than at
  merge time. Writing T036 first would be a gate violation, not a shortcut (ADR-0002, CLAUDE.md
  `data` role).
- **TG-1 → TG-2**: the wire cannot carry `members` before `members` exists, and T006's R-10 verdict
  must be in hand before `SYNCED_TABLES` is widened.
- **TG-2 → TG-3**: `ui` waits until `data` has landed the membership model (CLAUDE.md, `ui` role:
  team affordances "land only against a spec, and only after `data` has the membership model in
  place").
- **TG-3 → TG-4**: the map is not flipped for a component whose behaviour is not merged.
- **TG-4 → TG-5**: the hosted walk happens only after the unattended suite is green (D-14).
- **Inside TG-5 the order is load-bearing**: T058 (re-run the schema) → **T059 (backfill the owner's
  `instance_admins` row) → T060 (disable public sign-up)** → T061 (deploy) → T062 (the eighteen-step
  walk). Disabling sign-up before the backfill leaves an origin with no admin and no in-app way to
  make one — recoverable only through the SQL editor, which is the manual step this feature exists
  to remove (D-14).
- **Owner gate cleared 2026-09-13: no card remains blocked on the owner.** Two follow-up decisions
  (in-app login provisioning; kind switchability) are recorded in spec.md and are **not** on this
  feature's path.

**MVP scope**: TG-0 + TG-1. That alone is the whole access transform, proven at the data layer by
two authenticated clients with no browser, and it is the half of this feature that can leak one
account's rows to another. It is worth merging and reviewing on its own before any interface exists.

---

## Workfile & conflict map

| Task | Lane | Role | Files | Conflict note |
|------|------|------|-------|---------------|
| T001 | wt/dbapi-debt | data | `tests/local/db-api-p1-surface.test.ts` | shared with T040 (TG-2) — serialize across taskgroups |
| T002 | serial | coordinator | `docs/validation-map.md`, `specs/002-team-workspaces/receipts.md` | creates `receipts.md`; every later receipt card appends |
| T003 | serial | data | `specs/002-team-workspaces/receipts.md` | appends after T002 |
| T004 | wt/sync-flake | data | `tests/harness/sync.ts`, `tests/stack/soft-delete.test.ts` | the **only** sanctioned P0-test edit; no assertion may change |
| T005 | serial | coordinator | `specs/001-validation-spine/receipts.md`, `docs/validation-map.md` | map written serially with T002 |
| T006 | read-only | reviewer | — (no file written) | [P] — reads only; blocks T028 |
| T007 | wt/harness-accounts | data | `tests/harness/accounts.ts` | shared with T008 — serial in that order; [P] against T009/T019 |
| T008 | wt/harness-accounts | data | `tests/harness/accounts.ts` | after T007, same file; **test-only** `adminClient()` |
| T009 | wt/guards | data | `tests/stack/team-schema-guards.test.ts` | [P] — own file |
| T010 | wt/us2-members | data | `tests/stack/members-two-accounts.test.ts` | own file |
| T011 | wt/us3-rls | data | `tests/stack/team-rls-both-halves.test.ts` | shared with T012, T013 — serial in that order |
| T012 | wt/us3-rls | data | `tests/stack/team-rls-both-halves.test.ts`, `specs/002-team-workspaces/receipts.md` | receipts append |
| T013 | wt/us3-rls | data | `tests/stack/team-rls-both-halves.test.ts` | after T012 |
| T014 | wt/us5-assignee | data | `tests/stack/assignee-clear-on-removal.test.ts` | own file |
| T015 | wt/triggers | data | `tests/stack/team-triggers.test.ts` | own file |
| T016 | wt/personal | data | `tests/stack/personal-unchanged.test.ts` | own file |
| T017 | wt/kind-switch | data | `tests/stack/kind-switch.test.ts` | [P] — own file |
| T018 | wt/logins | data | `tests/stack/logins-provisioning.test.ts` | own file; needs T008's helper |
| T019 | wt/harness-seed | data | `tests/harness/seed.ts` | [P] — disjoint from T007 |
| T026A | (new lane) | data | `tests/stack/personal-triggers-after-t022.test.ts` | own file; after T022 |
| T026B | (new lane) | infra | `tsconfig.test.json`, `tsconfig.json`, `.github/workflows/ci.yml` | [P] — no file shared with any data card |
| T020 | serial | data | `supabase/schema.sql` | **`supabase/schema.sql` is written by T020–T026; strictly serial, never parallel lanes** |
| T021 | serial | data | `supabase/schema.sql` | after T020 |
| T022 | serial | data | `supabase/schema.sql` | after T021 |
| T023 | serial | data | `supabase/schema.sql` | after T022 |
| T024 | serial | data | `supabase/schema.sql` | after T023 |
| T025 | serial | data | `supabase/schema.sql` | after T024 — fork block D |
| T026 | serial | data | `supabase/schema.sql` | after T025 — fork block E; last schema card |
| T027 | serial | data | `specs/002-team-workspaces/receipts.md` | appends |
| T028 | serial | data | `src/db/types.ts` | the constants every other TG-2 card depends on |
| T029 | serial | data | `src/db/local.ts` | shared with T056 (Option B only) — serialize |
| T030 | wt/cache-growth | data | `tests/local/no-wipe-on-reach-growth.test.ts` | [P] — own file, disjoint from T029 |
| T031 | serial | data | `src/db/api.ts` | shared with T033, T040 (reads) and T056 (Option B writes) — serialize |
| T032 | serial | data | `src/sync/sync.ts` | shared with T036 — serial in that order; T038 diffs both |
| T033 | serial | data | `src/db/api.ts` | after T031, same file — the `is-admin` cache |
| T034 | wt/hooks | data | `src/db/hooks.ts` | [P] — own file |
| T035 | wt/push-refusal | data | `tests/stack/push-refusal-fallback.test.ts` | own file; **written before T036** |
| T036 | serial | data | `src/sync/sync.ts` | after T032, same file — the push-loop fallback only |
| T037 | wt/us6-offline | data | `tests/stack/member-offline-round-trip.test.ts` | own file |
| T038 | read-only + receipts | reviewer | `specs/002-team-workspaces/receipts.md` | appends; diffs `src/sync/sync.ts` and `supabase/schema.sql` without writing them |
| T039 | serial | coordinator | `docs/validation-map.md`, `specs/002-team-workspaces/receipts.md` | `sync-engine` re-verification; map written serially with T051/T052 |
| T040 | wt/dbapi-debt | data | `tests/local/db-api-p1-surface.test.ts` | same file as T001 — serial across TG-0/TG-2 |
| T041 | serial | ui | `src/i18n/dict.ts` | **one card owns the dictionary; T042–T049 read it and never write it** |
| T042 | serial | ui | `src/components/Header.tsx` | own file, but sequenced after T041 for the keys |
| T043 | serial | ui | `src/components/Settings.tsx`, `src/components/Settings.css` | first `Settings.tsx` card — the kind switch |
| T044 | serial | ui | `src/components/Settings.tsx`, `src/components/Settings.css` | **`Settings.tsx` is written by T043, T044, T045, T046, T048, T049 → strictly serial** |
| T045 | serial | ui | `src/components/Settings.tsx`, `src/components/Settings.css` | after T044 |
| T046 | serial | ui | `src/components/Settings.tsx`, `src/components/Settings.css` | after T045 |
| T047 | serial | ui | `src/components/TaskDialog.tsx`, `src/components/TaskDialog.css` | own files |
| T048 | serial | ui | `src/components/Settings.tsx`, `src/components/Settings.css` | after T046 — the Logins section |
| T049 | serial | ui | `src/components/Settings.tsx` | after T048; hides two existing controls, adds none |
| T050 | serial | ui | `specs/002-team-workspaces/receipts.md` | appends |
| T051 | serial | coordinator | `docs/validation-map.md` | map written serially with T052, T054 |
| T052 | serial | coordinator | `docs/validation-map.md` | after T051 |
| T053 | serial | coordinator | `specs/002-team-workspaces/receipts.md` | appends |
| T054 | serial | coordinator | `docs/validation-map.md`, `specs/002-team-workspaces/receipts.md` | owner gate cleared 2026-09-13; map after T052 |
| T055 | serial | coordinator | `docs/decisions/ADR-0001-fork-contract.md`, `docs/validation-map.md` | owner gate cleared 2026-09-13 (amendment, not ADR-0006); no `ARCHITECTURE.md` fact changes, so no index regeneration |
| T056 | serial | coordinator | `src/db/api.ts`, `src/db/local.ts`, `specs/002-team-workspaces/receipts.md` | owner gate cleared 2026-09-13 (Option B); source files shared with T029/T031 — serialize |
| T057 | read-only | reviewer | — (no file written) | whole-branch diff review |
| T058 | serial | owner | `specs/002-team-workspaces/receipts.md` | owner-run; hosted SQL editor, no repo change |
| T059 | serial | owner | `specs/002-team-workspaces/receipts.md` | owner-run; hosted SQL editor — the one-time admin backfill |
| T060 | serial | owner | `specs/002-team-workspaces/receipts.md` | owner-run; dashboard only — **strictly after T059** |
| T061 | serial | infra | — (no repository file) | `CLOUDFLARE_API_TOKEN` from the environment; never `wrangler login`, never a key in the repo |
| T062 | serial | owner | `specs/002-team-workspaces/receipts.md` | owner-run; eighteen recorded outcomes |
| T063 | serial | coordinator | `specs/002-team-workspaces/receipts.md` | closes the feature; the coordinator commits |

**Conflicts of record.**
`supabase/schema.sql` — T020, T021, T022, T023, T024, T025, T026, in that order, one lane, never split.
`docs/validation-map.md` — T002, T005, T039, T051, T052, T054, T055, all `serial`.
`specs/002-team-workspaces/receipts.md` — created by T002, appended by T003, T012, T027, T035, T038,
T039, T050, T053, T054, T056, T058, T059, T060, T062, T063; append-only, serial.
`src/components/Settings.tsx` — T043, T044, T045, T046, T048, T049, in that order.
`src/i18n/dict.ts` — T041 only; T042–T049 read it.
`src/db/api.ts` — T031 (writes), T033 (writes the admin-flag cache), T040 (tests it), T056 (writes,
Option B) — serial.
`src/sync/sync.ts` — T032 (adds the eight wrappers), T036 (the push-loop fallback), T038 (diffs both
without writing) — serial, and the only two cards in this feature that may touch the sync engine.
`tests/harness/accounts.ts` — T007 then T008, additive exports only.
`src/db/local.ts` — T029 (writes), T030 (tests it), T056 (writes, Option B) — serial.
`tests/local/db-api-p1-surface.test.ts` — T001 then T040, across two taskgroups.
`tests/harness/*.ts` — additive exports only; **no existing export changes signature** (D-13),
because P0 files import them. The one exception is T004's settle-wait repair, which is a P0 debt
fix recorded in receipts and re-baselined before TG-1 begins.
**Parallel markers** (`[P]`) appear only on T001, T006, T007, T009, T017, T019, T030, T034 —
the tasks whose `Write:` sets are disjoint from every other task runnable at the same time. T008
carries no marker: it is serial behind T007, which writes the same harness file; T018 is **not**
parallel either, because it needs T008's helper.
