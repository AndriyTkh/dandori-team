---

description: "Task list for 002-team-workspaces"
---

# Tasks: P1 Team Workspaces — the minimal team transform

**Input**: Design documents from `/specs/002-team-workspaces/`

**Prerequisites**: [plan.md](./plan.md) (required, whole — D-1..D-15, R-1..R-14, Owner questions,
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
`membership` / `team-rls` / `multi-account-cache` **do not exist yet** (new, HIGH).

---

## TG-0: Map debt — clear it before any P1 code

**Purpose**: ADR-0002's gate — *no phase starts while the substrate it stands on is `UNTESTED`* —
bites in exactly two places. `db-api` is the door every one of the five affordances goes through and
is `UNTESTED`. And `sync-engine` is `VALIDATED` on a **flaky** receipt, which is a map-discipline
problem, not a test problem. **Blocks TG-1 onward.**

- [ ] T001 [P] [data] Write `tests/local/db-api-p1-surface.test.ts` pinning the `db-api` functions P1 touches **as they behave today**, before a single line of `src/db/api.ts` changes: `createWorkspace(name)` (row shape, `_dirty`, queued), `renameWorkspace(id, name)` (bumps `updated_at`, re-dirties), `deleteWorkspace(id)` (soft-deletes the workspace **and** its children), `updateTask(id, patch)` (patch semantics, `updated_at` bump, untouched fields preserved), `listWorkspaces()` (excludes deleted). Docker-free tier
  - Write: `tests/local/db-api-p1-surface.test.ts`
  - Read: `src/db/api.ts` (whole); `src/db/local.ts:20-125`; `ARCHITECTURE.md §4` L407–L424 (db-api surface); `ARCHITECTURE.md §3` L207–L242 (entities, three timestamps); plan.md "Validation substrate"; `tests/local/claim-cache.test.ts` (tier conventions)
  - substrate: `db-api` (UNTESTED — this task is what clears it), `local-cache` (VALIDATED)
  - verify: `npm test -- --run --project local tests/local/db-api-p1-surface.test.ts` — green with the stack stopped
  - done-when: the five functions named above each have at least one passing assertion against **current** behaviour, nothing under `src/` changed (FR-030 spirit; plan.md "the debt row that becomes the first tasks")
- [ ] T002 [coordinator] Flip `db-api` to `VALIDATED` in `docs/validation-map.md` (`verify:` = T001's command, `tests:` = the new file, `last-verified: <sha> <date>`, `sign-off: Andrii Tkhorenko (single-operator)`) and create `specs/002-team-workspaces/receipts.md` with the run that backs it
  - Write: `docs/validation-map.md`, `specs/002-team-workspaces/receipts.md`
  - Read: `docs/project-structure.md` (map grammar, `verify:` field); `specs/001-validation-spine/receipts.md` (receipt shape); plan.md D-15
  - substrate: `db-api` (this task is where its status changes)
  - verify: named manual check — the `db-api` entry names a command that was actually run, and `receipts.md` carries that run's output, date and SHA
  - done-when: `db-api` is `VALIDATED` with a receipt; no other entry moved (FR-031)
  - blocked-by: T001
- [ ] T003 [data] Reproduce and root-cause the P0 flake found 2026-09-13: CI run `https://github.com/AndriyTkh/dandori-team/actions/runs/34744308875` at main `526758a` failed `tests/stack/soft-delete.test.ts:91` acceptance 1 ("a row deleted on one client arrives deleted at a second client") with `AssertionError: expected undefined to be defined`; it also failed once locally when two stack suites overlapped. Loop the file 10× and record pass/fail per run. **Suspected seam** (confirm or refute, do not assume): the settle-wait. `tests/harness/sync.ts:81-93` counts two *rests* after one `syncing`, while the file's own private `drivePushAndPullCycle` (`tests/stack/soft-delete.test.ts:44-72`) resets `leftInitial` after each settle and therefore requires two *separate* `syncing` entries — so a pull that settles without re-entering `syncing`, or a `push()`-only settle (receipts F-1 class), leaves the third cycle's pull unperformed and `db.tasks.get(taskId)` undefined
  - Write: `specs/002-team-workspaces/receipts.md`
  - Read: `tests/stack/soft-delete.test.ts:1-100`; `tests/harness/sync.ts` (whole); `src/sync/sync.ts:176-190`, `:462-507`, `:43-78` (read-only); `specs/001-validation-spine/receipts.md` F-1; plan.md R-14
  - substrate: `sync-engine` (VALIDATED, on the receipt this task repairs)
  - verify: `for ($i=1; $i -le 10; $i++) { npm test -- --run --project stack tests/stack/soft-delete.test.ts }` — the 10 outcomes recorded verbatim in `receipts.md`, and the failing run's mechanism named
  - done-when: the flake is reproduced or the 10× loop is green and that is recorded as such; the root cause is stated as a mechanism in `src/sync/sync.ts` or in the harness, not as "timing"
  - blocked-by: T002
- [ ] T004 [data] Fix the flake **inside `tests/harness/` or `tests/stack/` only** — normally the single settle-wait mechanism in `tests/harness/sync.ts`, with `tests/stack/soft-delete.test.ts`'s private `drivePushAndPullCycle` deleted in favour of it. **Boundary**: if the fix requires a change under `src/sync/`, stop — that is a **FINDING for the owner**, not an edit (CLAUDE.md, `data` role; plan.md R-14). **The one named exception to FR-030**: replacing `soft-delete.test.ts`'s private cycle-driver is a P0 *debt repair* performed before 002 touches anything, not an accommodation of this feature; **no assertion, acceptance or expectation in that file may change**, the edit is recorded in `receipts.md`, and "P0 passes unedited" for the rest of this feature is measured against the post-T004 baseline SHA
  - Write: `tests/harness/sync.ts`, `tests/stack/soft-delete.test.ts`
  - Read: T003's recorded root cause; `tests/harness/sync.ts`; `tests/stack/offline-round-trip.test.ts` (the other local driver, for consistency); `src/sync/sync.ts:176-190`, `:462-507` (read-only)
  - substrate: `sync-engine`
  - verify: `for ($i=1; $i -le 10; $i++) { npm test -- --run --project stack tests/stack/soft-delete.test.ts }` — 10/10 green
  - done-when: 10/10 green; `git diff tests/stack/soft-delete.test.ts` shows no change to any `expect(...)`, `it(...)` title or acceptance comment; `git diff src/` is empty
  - blocked-by: T003
- [ ] T005 [coordinator] Re-run the full suite twice consecutively and re-sign the `sync-engine` receipt in `specs/001-validation-spine/receipts.md` — the existing receipt is flaky and a `VALIDATED` entry standing on it is a map-discipline defect (map flip + receipt re-sign is a coordinator duty). `data` hands `coordinator` the two consecutive local run logs plus the failing and new green CI URLs; `coordinator` records both local runs, the failing CI URL, and the new green CI URL, and updates `docs/validation-map.md`'s `sync-engine` `last-verified` to the fixed SHA
  - Write: `specs/001-validation-spine/receipts.md`, `docs/validation-map.md`
  - Read: `specs/001-validation-spine/receipts.md` "Full-suite receipt" and "CI receipt" sections; `CLAUDE.md` "Definition of done"; T003/T004 records; the two run logs and CI URLs handed off by `data`
  - substrate: `sync-engine`, `supabase-schema`, `local-cache`, `env-boot`
  - verify: `npm test -- --run` fully green twice consecutively, plus a green CI run on `002-team-workspaces` whose URL is recorded
  - done-when: `sync-engine`'s receipt names a run that is reproducible 10/10 and a green CI URL; the old flaky CI URL is kept in the record, not erased (SC-003 discipline, CLAUDE.md reviewer duty 5)
  - blocked-by: T004
- [ ] T006 [P] [reviewer] R-10 check, **report only, edit nothing**: grep every P0 test and harness file for assertions on the `SYNCED_TABLES` / `SYNCED_COLUMNS` **set as a whole** (as opposed to a member of it) and report which would break when `members` becomes the fifth table and `assignee`/`kind` join the column maps. Known starting points at planning time: `tests/local/claim-cache.test.ts:3,18,76,96` iterate `SYNCED_TABLES`; `tests/stack/offline-round-trip.test.ts:75` derives `TASK_COLUMNS` from `Object.keys(SYNCED_COLUMNS.tasks)`. Per FR-030 a P0 check that must change is a FINDING for the owner — this task establishes whether one exists, **before** TG-2 widens the constants
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

**Purpose**: the transform itself. HIGH tier, so the P-gate applies **within** the taskgroup: each
test file is authored before the schema card it gates, fails for a named reason, and the schema card
is verified by turning it green. Everything lands in `supabase/schema.sql` (ADR-0005); **no
`migration-007`** (D-2). `supabase/schema.sql` is written by T017–T021, which are strictly serial.

- [ ] T007 [P] [data] Extend `tests/harness/accounts.ts` with `createTestUsers(n, label)` (a third account is needed for "knows the id, is not a member", US3 acceptance 4, and for edge case 9) and `asUser(testUser)` (memoized `clientFor`, so a file switching between A/B/C does not re-authenticate per assertion). **Additive exports only** — no existing export changes signature, because P0 files import them (D-13). FR-030 note: additive-only edit to a P0 harness helper file — new exports, no existing signature or assertion changes; outside FR-030's "unedited checks" scope, receipt in receipts.md
  - Write: `tests/harness/accounts.ts`
  - Read: `tests/harness/accounts.ts`; plan.md D-13 "Harness additions"; `src/auth/supabase.ts:1-17`
  - substrate: `supabase-auth` (UNTESTED, incidental — same standing as P0)
  - verify: `npm test -- --run --project stack` green (no P0 regression), and a scratch test provisioning three users and reading `auth.getUser()` on each passes
  - done-when: three independent authenticated clients exist in one process (FR-029); `git diff tests/harness/accounts.ts` shows no changed existing signature; no existing export signature changed
- [ ] T008 [P] [data] Write `tests/stack/team-schema-guards.test.ts` covering the three structural risks, red-first: **R-1 canary** — a plain authenticated `select` on `public.members` returns without `infinite recursion detected in policy for relation "members"`; **R-2** — a `pg_proc` query asserting `prosecdef` and `proconfig is not null` (i.e. a `set search_path`) for every function this feature adds (`is_member`, `is_owner`, `seed_workspace_owner`, `assignee_must_be_member`, `clear_assignee_on_removal`, `add_member_by_email`, `workspace_member_emails`); **R-3** — an unauthenticated (anon) client calling `add_member_by_email` and `workspace_member_emails` is refused
  - Write: `tests/stack/team-schema-guards.test.ts`
  - Read: contracts/policies.sql (whole); contracts/rpc.md; plan.md D-5, D-9, R-1, R-2, R-3; `tests/stack/schema-apply.test.ts` (structural-assertion style)
  - substrate: `supabase-schema` (VALIDATED — this feature changes it), `team-rls` (new, UNTESTED)
  - verify: `npm test -- --run --project stack tests/stack/team-schema-guards.test.ts` — red for the named reason (`relation "public.members" does not exist`), recorded; green after T021
  - done-when: R-1, R-2 and R-3 each have an assertion that fails if the guard is removed (plan.md R-2's "cannot be forgotten in review")
- [ ] T009 [data] Write `tests/stack/members-two-accounts.test.ts` (US2), red-first: A adds B by email and B appears in the member list shown by email; an email with no account on this origin adds nothing, returns `DA404`, and creates **0 rows** anywhere (SC-010); B (a member) attempting to add or remove anyone is refused with `DA001`; A removes B and B's reads/writes of that workspace stop while B's own personal workspaces are untouched; a non-member listing a workspace's members receives nothing; adding B twice leaves exactly **one** membership row; adding the owner's own email returns the existing `owner` row with **no demotion** to `member`
  - Write: `tests/stack/members-two-accounts.test.ts`
  - Read: spec.md US2 acceptances 1–6, edge cases 4 and 5, FR-004..FR-010, SC-010; contracts/rpc.md (whole); plan.md D-7, D-9, R-13; `tests/harness/accounts.ts` (post-T007)
  - substrate: `membership` (new, UNTESTED), `team-rls` (new, UNTESTED), `supabase-schema`
  - verify: `npm test -- --run --project stack tests/stack/members-two-accounts.test.ts` — red for the named reason before T021, green after
  - done-when: every US2 acceptance and edge cases 4–5 have an assertion; the `DA404` branch asserts on `error.code`, never on message text (FR-008)
  - blocked-by: T007
- [ ] T010 [data] Write `tests/stack/team-rls-both-halves.test.ts` (US3) covering the **eight** predicate halves — read and write on each of `workspaces`, `labels`, `tasks`, `notes` — in each direction: a member reads the team workspace's rows including rows A created; a member creates/edits/deletes a task, a label and a note; a member's workspace list contains the team workspace and **zero** of A's personal workspaces (SC-002); a third account that knows the workspace id may not create a child row in it; after removal every one of these returns nothing or is refused (R-5, asserted on **both** halves)
  - Write: `tests/stack/team-rls-both-halves.test.ts`
  - Read: spec.md US3 acceptances 1–6, FR-011, FR-012, SC-002; contracts/policies.sql "policy block"; `docs/validation-map.md` lines 124–144 (the read/write asymmetry correction); `ARCHITECTURE.md §3` L243–L262; plan.md D-4, D-5, R-5
  - substrate: `team-rls` (new, UNTESTED), `membership` (new, UNTESTED), `supabase-schema`
  - verify: `npm test -- --run --project stack tests/stack/team-rls-both-halves.test.ts` — red before T020, green after
  - done-when: all eight halves are exercised in both directions; the post-removal block asserts on read **and** write (FR-012, SC-002)
  - blocked-by: T007
- [ ] T011 [data] Add the **executed inversion demonstration** to `tests/stack/team-rls-both-halves.test.ts` (FR-013, SC-005): inside one `pg` connection and one transaction that always `rollback`s, `drop policy own_rows on public.<t>` / `create policy` with **one half inverted or equalized to the other**, `set local role authenticated`, `set local request.jwt.claims = '{"sub":"<uuid>"}'`, assert the outcome flips, `rollback`. Run once per direction per half, for a personal workspace **and** for a team workspace. **Fallback, named in advance and never silent**: if the environment refuses to execute the block, apply P0's fallback verbatim — the shadow-predicate mutation technique already used by `tests/stack/lww-conflict.test.ts`, plus reproduction steps in this file's header and a hand-trace in `specs/002-team-workspaces/receipts.md`, explicitly labelled a deviation (as P0's T018 was)
  - Write: `tests/stack/team-rls-both-halves.test.ts`, `specs/002-team-workspaces/receipts.md`
  - Read: spec.md FR-013, SC-005, US3 acceptance 5; plan.md D-13 "The executed inversion demo"; `specs/001-validation-spine/receipts.md` (T018's recorded deviation); `tests/stack/lww-conflict.test.ts` (the fallback technique); `tests/harness/stack.ts` (DB URL)
  - substrate: `team-rls` (new, UNTESTED), `supabase-schema`
  - verify: `npm test -- --run --project stack tests/stack/team-rls-both-halves.test.ts` green, and — checked immediately after — `psql`-level confirmation that `pg_policies` for the four tables is byte-identical to before the run (nothing committed)
  - done-when: SC-005 is satisfied by an executed demonstration, or by the named fallback recorded as a deviation; never by silence
  - blocked-by: T010
- [ ] T012 [data] Add the **R-7 assertion** to `tests/stack/team-rls-both-halves.test.ts`: B (a member, not the creator) edits a task A created in the team workspace; assert server-side that `tasks.user_id` is still **A's** id after the push — `user_id` keeps meaning "who created the row" and must not drift to "who touched it last" (FR-011). Repeat for `labels` and `notes`
  - Write: `tests/stack/team-rls-both-halves.test.ts`
  - Read: spec.md FR-011; plan.md D-4 "A fourth new trigger, `<t>_zz_keep_creator`", R-7; `src/sync/sync.ts:216` (the push path that stamps `user_id`); contracts/policies.sql (`keep_creator`)
  - substrate: `team-rls` (new, UNTESTED), `sync-engine` (VALIDATED)
  - verify: `npm test -- --run --project stack tests/stack/team-rls-both-halves.test.ts`
  - done-when: an assertion exists that fails if `<t>_zz_keep_creator` is dropped, on all three child tables (R-7's "no visible symptom" is what this closes)
  - blocked-by: T011
- [ ] T013 [data] Write `tests/stack/assignee-clear-on-removal.test.ts` (US5): A sets B as a task's assignee and both accounts read it back; clearing returns the task to unassigned (its default); removing B from the workspace clears the assignment **on the backend** with an `updated_at` that outranks an edit already queued on B's device; an assignment to a **non-member** is **coerced to `null`, not refused** (D-3) and the row is accepted; and — SC-007 — every access outcome asserted in this file is identical with and without an assignee present
  - Write: `tests/stack/assignee-clear-on-removal.test.ts`
  - Read: spec.md US5 acceptances 1–6, FR-016..FR-018, SC-006, SC-007; data-model.md §2 "Assignee", §5; contracts/policies.sql (`assignee_must_be_member`, `clear_assignee_on_removal`); plan.md D-3, R-8
  - substrate: `membership` (new, UNTESTED), `team-rls` (new, UNTESTED), `supabase-schema`
  - verify: `npm test -- --run --project stack tests/stack/assignee-clear-on-removal.test.ts` — red before T019, green after
  - done-when: SC-006 ("0 tasks whose assignee names a non-member") is measured directly and the coercion path is asserted as **accepted-and-nulled**, never as an error (FR-018, plan R-14)
  - blocked-by: T007
- [ ] T014 [data] Write `tests/stack/team-triggers.test.ts` (FR-014, R-6): demonstrate `keep_newer`, `stay_deleted_with_workspace` and `follow_workspace_delete` each still firing — **on a personal workspace and on a team workspace**, same rows, same effect. Include R-6's specific case: the owner soft-deletes a team workspace while a member has a queued live child; the late-arriving child must be **forced to `deleted`**, not refused. If the replaced `with check` refuses it instead, the trigger has become unreachable on rows it used to see — that is an FR-014 regression and a **FINDING for the owner**, not a fix
  - Write: `tests/stack/team-triggers.test.ts`
  - Read: spec.md FR-014, edge case "The owner deletes the team workspace…"; `ARCHITECTURE.md §4` L379–L393 (trigger table, name-order firing); `supabase/schema.sql:142-190`, `:193-195` (read-only); plan.md D-4, D-6, R-6; `tests/stack/soft-delete.test.ts` (the P0 personal-side equivalent)
  - substrate: `supabase-schema` (VALIDATED), `team-rls` (new, UNTESTED)
  - verify: `npm test -- --run --project stack tests/stack/team-triggers.test.ts` — red before T019/T020, green after
  - done-when: each of the three triggers has a passing demonstration on both workspace kinds (FR-014); any refusal-instead-of-coercion outcome is filed as a FINDING and not worked around
  - blocked-by: T007
- [ ] T015 [data] Write `tests/stack/personal-unchanged.test.ts` (US4 smoke): for a **personal** workspace after the swap — the owner reaches everything, a second account reaches nothing, by listing and by identifier, on read and on write; the delete cascade and stay-deleted behaviour are observably as before; a workspace created without expressing a choice is `personal`; every workspace that existed before the change reads `personal`; setting `kind` to a third value is refused **by the backend** (US1 acceptance 4), and updating `kind` on an existing row is silently pinned back (D-6)
  - Write: `tests/stack/personal-unchanged.test.ts`
  - Read: spec.md US1 acceptances 1–4, US4 acceptances 1–4, "Personal must not regress", FR-001, FR-003, SC-002; contracts/policies.sql (fork block A, `pin_workspace_kind`); plan.md D-1, D-6
  - substrate: `supabase-schema`, `team-rls` (new, UNTESTED)
  - verify: `npm test -- --run --project stack tests/stack/personal-unchanged.test.ts` — red before T017, green after
  - done-when: the personal read/write outcomes asserted here are identical to `tests/stack/rls-two-accounts.test.ts`'s, and `kind` immutability is proven as *coerced* while a third value is proven as *refused* (FR-001)
  - blocked-by: T007
- [ ] T016 [P] [data] Add `seedTeamWorkspace(owner, members[])` to `tests/harness/seed.ts`: create a team workspace through the same `src/db/api.ts` path `seedWorkspaceWithTask` uses, then add members via `add_member_by_email`, so the seed exercises the real creation path rather than inserting rows behind it. **Additive export only**. FR-030 note: additive-only edit to a P0 harness helper file — new exports, no existing signature or assertion changes; outside FR-030's "unedited checks" scope, receipt in receipts.md
  - Write: `tests/harness/seed.ts`
  - Read: `tests/harness/seed.ts`; contracts/rpc.md; plan.md D-13 "Harness additions", D-6 (the owner row arrives by pull, not by local write)
  - substrate: `db-api` (VALIDATED after T002), `membership` (new, UNTESTED)
  - verify: `npm test -- --run --project stack` green after T021; a scratch test seeding a team workspace with one added member and reading both membership rows back passes
  - done-when: no existing export in `tests/harness/seed.ts` changed signature (D-13); the seed never inserts a `members` row directly; no existing export signature changed
  - blocked-by: T007
- [ ] T017 [data] Add **fork block A** to `supabase/schema.sql`, in its own guarded block placed after upstream's table definitions and before the trigger loops, exactly as `contracts/policies.sql` lines 14–46 write it: `workspaces.kind text not null default 'personal'` with the separately-dropped-and-added `workspaces_kind_check check (kind in ('personal','team'))`; `public.members` with `id uuid primary key`, `user_id`/`member_id`/`workspace_id` FKs `on delete cascade`, `level text not null default 'member' check (level in ('owner','member'))`, the four housekeeping columns and `deleted boolean not null default false`; the **unconditional** `members_one_per_person unique (workspace_id, member_id)` (*not* partial on `not deleted`) and `members_by_person (member_id, synced_at)`; `enable row level security` on `members`; `tasks.assignee uuid references auth.users(id) on delete set null`. **No `migration-007`** (D-2) and **no origin column or table** (FR-027)
  - Write: `supabase/schema.sql`
  - Read: contracts/policies.sql lines 1–46; data-model.md §1; plan.md D-1, D-2, R-4; `supabase/schema.sql` (whole, read-only first); ADR-0005
  - substrate: `supabase-schema` (VALIDATED — re-verified in this PR)
  - verify: `npm test -- --run --project stack tests/stack/schema-apply.test.ts tests/stack/personal-unchanged.test.ts` — green, including the idempotent second apply
  - done-when: FR-001, FR-016, FR-028 hold; `git diff supabase/schema.sql` adds a separate guarded block and modifies **no** upstream table definition and **no** four-element `foreach` array (R-4); `supabase/migration-007*` does not exist
  - blocked-by: T008, T009, T010, T011, T012, T013, T014, T015, T016
- [ ] T018 [data] Add **fork block B** to `supabase/schema.sql` before the policy block: `public.is_member(ws uuid)` and `public.is_owner(ws uuid)`, both `language sql stable security definer set search_path = public, pg_temp`, both reading `and not m.deleted`; then `revoke execute … from public, anon` and `grant execute … to authenticated` for each. `security definer` is **not optional** — `members_access` is a policy on `members` whose predicate queries `members` (R-1)
  - Write: `supabase/schema.sql`
  - Read: contracts/policies.sql lines 48–75; plan.md D-5, R-1, R-2, R-3; data-model.md §1 `members`
  - substrate: `supabase-schema`, `team-rls` (new, UNTESTED)
  - verify: `npm test -- --run --project stack tests/stack/team-schema-guards.test.ts` — R-1 and R-2 assertions green
  - done-when: both helpers carry `security definer` **and** `set search_path`, and neither is executable by `anon` (R-2, R-3); `not m.deleted` is present in both (R-5)
  - blocked-by: T017
- [ ] T019 [data] Add **fork block C** to `supabase/schema.sql` — the fork's own triggers, in a guarded block that does **not** edit upstream's `array['workspaces','labels','tasks','notes']` loops (R-4): `members_synced_at` + `members_keep_newer` (the same housekeeping every synced table has); `workspaces_seed_owner` (`after insert`, `security definer`, `on conflict (workspace_id, member_id) do nothing`); `workspaces_zz_kind_fixed` (`new.kind := old.kind`, silent pin, never a raise); `tasks_zz_assignee_member` (coerce `assignee` to `null` when not a live member — coerce, never raise); `members_zz_clear_assignee` + `members_zz_clear_assignee_del` (clear with `updated_at = greatest(updated_at, now())`); `<labels|tasks|notes>_zz_keep_creator`. **Every new BEFORE trigger carries the `_zz_` infix** so it sorts after `keep_newer` → `stay_deleted` → `synced_at` — Postgres fires same-timing triggers in name order and a trigger sorting first would change observable behaviour (FR-014)
  - Write: `supabase/schema.sql`
  - Read: contracts/policies.sql lines 77–193; data-model.md §5 (trigger table and firing order); plan.md D-3, D-6, D-8, R-6, R-7, R-8, R-14; `supabase/schema.sql:142-195` (read-only)
  - substrate: `supabase-schema`, `membership` (new, UNTESTED)
  - verify: `npm test -- --run --project stack tests/stack/team-triggers.test.ts tests/stack/assignee-clear-on-removal.test.ts` — green
  - done-when: FR-002, FR-014, FR-018 hold; every new BEFORE trigger name sorts after `synced_at`; no upstream `foreach` array was edited (R-4)
  - blocked-by: T018
- [ ] T020 [data] Replace the **policy block** at the end of `supabase/schema.sql` wholesale, per `contracts/policies.sql` lines 195–245: on `workspaces`, `using (auth.uid() = user_id or public.is_member(id))` and `with check (auth.uid() = user_id)` — the read half widens, the write half deliberately does **not** (FR-005). On each of `labels`/`tasks`/`notes`, the read half `auth.uid() = user_id or public.is_member(workspace_id)` and the write half `(auth.uid() = user_id and exists(…workspace is mine…)) or public.is_member(workspace_id)` — the write half's first branch is **upstream's clause character for character**, and the membership branch is **not** conjoined with `auth.uid() = user_id`. On `members`, the fork-only `members_access`: `using (public.is_member(workspace_id))`, `with check (public.is_owner(workspace_id) and auth.uid() = user_id)`. **Both halves of each policy are written separately; one predicate used for both is a defect** (FR-012)
  - Write: `supabase/schema.sql`
  - Read: contracts/policies.sql lines 195–245; spec.md FR-005, FR-011, FR-012, FR-013, FR-015; `docs/validation-map.md` lines 124–144; plan.md D-4, R-4, R-11
  - substrate: `team-rls` (new, UNTESTED), `supabase-schema`
  - verify: `npm test -- --run --project stack tests/stack/team-rls-both-halves.test.ts tests/stack/rls-two-accounts.test.ts tests/stack/personal-unchanged.test.ts` — all green, the P0 file **unedited**
  - done-when: FR-012's "both halves replaced separately, asymmetry preserved" holds and T011's inversion demo flips an assertion in each direction (SC-005); P0's `rls-two-accounts.test.ts` passes with zero edits (FR-030)
  - blocked-by: T019
- [ ] T021 [data] Add the **two RPCs** to `supabase/schema.sql` per `contracts/rpc.md`: `public.add_member_by_email(ws uuid, email text) returns public.members` — raises `DA001` unless `public.is_owner(ws)`; looks the email up in `auth.users` with `lower(trim(...))` on **both** sides (R-13); raises `DA404` with message `no account with this email on this origin` when there is none, creating **no row of any kind** (SC-010); otherwise upserts `on conflict (workspace_id, member_id) do update set deleted = false, updated_at = now()` — a set-list that deliberately **does not touch `level`**, so adding the owner's own email never demotes them. And `public.workspace_member_emails(ws uuid) returns table (member_id uuid, email text, level text)` — **zero rows** unless `public.is_member(ws)`. Both `security definer`, both `set search_path = public, auth, pg_temp`, both `revoke execute … from public, anon` / `grant execute … to authenticated` (R-3)
  - Write: `supabase/schema.sql`
  - Read: contracts/rpc.md (whole); spec.md FR-007, FR-008, SC-010, edge cases 4 and 5; plan.md D-9, R-2, R-3, R-13
  - substrate: `membership` (new, UNTESTED), `team-rls` (new, UNTESTED)
  - verify: `npm test -- --run --project stack tests/stack/members-two-accounts.test.ts tests/stack/team-schema-guards.test.ts` — green
  - done-when: FR-007, FR-008 and SC-010 hold; no `profiles` table and no second copy of any email exists anywhere in the diff (FR-007, Q1); neither RPC is reachable by `anon` (R-3)
  - blocked-by: T020
- [ ] T022 [data] **P0-unedited gate.** Run the entire suite and prove no P0 check changed: `git diff --stat <post-T004 baseline SHA> -- tests/stack/lww-conflict.test.ts tests/stack/offline-round-trip.test.ts tests/stack/rls-two-accounts.test.ts tests/stack/schema-apply.test.ts tests/stack/soft-delete.test.ts tests/local/claim-cache.test.ts` must be empty. Harness files may have gained exports; none may have changed one. A P0 check that must change is a **FINDING for the owner, not an edit** (FR-030, spec "Personal must not regress", last bullet)
  - Write: `specs/002-team-workspaces/receipts.md`
  - Read: spec.md FR-030, SC-003; plan.md D-13 "Every P0 file is unedited"; T006's R-10 verdict list
  - substrate: all of `sync-engine`, `local-cache`, `supabase-schema`, `db-api`
  - verify: `npm test -- --run` fully green twice consecutively, **and** the `git diff --stat` above prints nothing
  - done-when: SC-003 ("0 edits to P0 checks") is demonstrated by an empty diff, not asserted; the run is recorded in `receipts.md`
  - blocked-by: T021

**Checkpoint**: the backend transform is complete and proven. The interface still shows nothing new.

---

## TG-2: Wire and cache — `members` as the fifth synced table, Dexie v3, `db-api`

**Purpose**: carry membership and assignee on the **existing generic sync loop** so FR-019 is
satisfied by the path itself, and grow the local cache **additively** so FR-021/FR-022 and SC-012
stay true. **The LWW rule does not change in this feature** — T030 asserts that mechanically.

- [ ] T023 [data] Update `src/db/types.ts`: `SYNCED_TABLES` becomes `['workspaces','members','labels','notes','tasks']` (`members` after `workspaces`, which it FKs); `SYNCED_COLUMNS.workspaces` gains `kind: true`; `SYNCED_COLUMNS.tasks` gains `assignee: true`; a new `SYNCED_COLUMNS.members` entry carries exactly `id, workspace_id, member_id, level, created_at, updated_at, deleted` — **`user_id` and `synced_at` are in no entry** (push stamps, pull strips). Add `export type WorkspaceKind = 'personal' | 'team'`, `export type MemberLevel = 'owner' | 'member'`, `Workspace.kind: WorkspaceKind`, `Task.assignee: ID | null`, and the `Member` interface from data-model.md §3. The existing `satisfies { [K in SyncedTable]: ColumnsOf<SyncedRow[K]> }` check must remain the guard
  - Write: `src/db/types.ts`
  - Read: data-model.md §3 (whole, including the TypeScript block); plan.md D-8, D-10; `src/db/types.ts` (whole); `src/sync/sync.ts:216`, `:418` (why `user_id`/`synced_at` are excluded); T006's R-10 verdict list
  - substrate: `local-cache` (VALIDATED — re-verified in this PR), `sync-engine` (VALIDATED)
  - verify: `npx tsc -b --noEmit` clean, then `npm test -- --run` fully green — including every P0 file unedited (this is where R-10 bites)
  - done-when: FR-019's wire half holds; the `satisfies` guard still turns a forgotten column into a compile error; any P0 file that now fails is filed as a **FINDING**, not edited (FR-030)
  - blocked-by: T022
- [ ] T024 [data] Update `src/db/local.ts`: add `this.version(3).stores({ members: 'id, workspace_id, _dirty' })` with an `upgrade` backfilling `w.kind ??= 'personal'` and `t.assignee ??= null` — the identical pattern to the v2 calendar backfill. **No existing store's key or index changes**, so Dexie rebuilds nothing. `wipeLocal()` grows `members` in its table list. **`claimCache` is unchanged** — same signature, same `meta` key `owner`, same value (the bare user id), same semantics: renaming the key would make every existing cache look ownerless after the upgrade and silently skip the **next** account-switch wipe (D-10)
  - Write: `src/db/local.ts`
  - Read: data-model.md §4; plan.md D-10, R-9; `src/db/local.ts:20-125` (especially `:47-62` v2 backfill and `:89-125` claim/wipe); spec.md FR-021, FR-022, SC-012
  - substrate: `local-cache` (VALIDATED — re-verified in this PR), `multi-account-cache` (new, UNTESTED)
  - verify: `npm test -- --run --project local` — `tests/local/claim-cache.test.ts` green **unedited** and `tests/local/no-wipe-on-reach-growth.test.ts` green
  - done-when: FR-021 and FR-022 hold; `git diff src/db/local.ts` shows additions to `version()` and one table name added to `wipeLocal`, and **no change inside `claimCache`**
  - blocked-by: T023
- [ ] T025 [P] [data] Write `tests/local/no-wipe-on-reach-growth.test.ts` (SC-012, R-9), Docker-free, covering both halves in one file: open a **v2-shaped** database with cached rows and `meta` pull cursors, upgrade to v3, assert every row count and every cursor value survives and `members` exists (R-9); then claim as A, seed rows in A's own workspace **and** in a team workspace A newly reaches, write a pull cursor, claim as **A again** — assert nothing wiped, cursors intact, `meta.owner` unchanged; then claim as **B** — assert the wipe fires and the cursors are gone
  - Write: `tests/local/no-wipe-on-reach-growth.test.ts`
  - Read: plan.md D-10 "What proves 'no wipe when reach grows'", R-9; data-model.md §4; `src/db/local.ts:20-125`; `tests/local/claim-cache.test.ts` (tier conventions); spec.md SC-012, FR-021
  - substrate: `multi-account-cache` (new, UNTESTED — this file is what validates it), `local-cache`
  - verify: `npm test -- --run --project local tests/local/no-wipe-on-reach-growth.test.ts` — green with the stack stopped
  - done-when: SC-012's "exactly once per switch, 0 times when the same account signs in again, including when reach has grown" is asserted in both directions, and the v2→v3 upgrade is asserted to lose **no** row and **no** cursor
  - blocked-by: T023
- [ ] T026 [data] Extend `src/db/api.ts`: `createWorkspace(name, kind: WorkspaceKind = 'personal')` — defaulted, so every existing call site is unchanged, and it writes **only** the workspace row (the owner's own `members` row is `workspaces_seed_owner`'s server-side effect and arrives on the next pull; writing one locally would collide on `members_one_per_person` and wedge the queue, D-6/R-14); `listMembers(ws)` — a Dexie read, no network; `removeMember(ws, memberId)` — an ordinary soft-delete write plus `queue()`, exactly like `deleteTask`, no network; `memberEmails(ws)` and `addMemberByEmail(ws, email)` — delegating to the `*Remote` wrappers from T027, with `addMemberByEmail` writing the returned row straight into Dexie; `TaskPatch` widens by `assignee`. **Q-A is open: implement Option A (no per-device email cache) and keep the `workspace_member_emails` call site in exactly one function**, so switching to Option B is a one-function change
  - Write: `src/db/api.ts`
  - Read: contracts/rpc.md "Client layering" and "Freshness / offline"; plan.md D-9, D-11, Complexity Tracking, Owner question Q-A; `src/db/api.ts` (whole); `ARCHITECTURE.md §4` L407–L424; spec.md FR-024, FR-026
  - substrate: `db-api` (VALIDATED after T002), `membership` (new, UNTESTED)
  - verify: `npx tsc -b --noEmit` clean; `npm test -- --run --project local tests/local/db-api-p1-surface.test.ts` green (T001's existing-function pins still hold)
  - done-when: FR-024's five operations exist behind `src/db/api.ts` and nothing else; `createWorkspace`'s existing call sites compile unchanged; `db-api` never imports the Supabase client directly (FR-026, ARCHITECTURE §2 layering)
  - blocked-by: T024, T027
- [ ] T027 [data] Add **exactly two** online-only wrappers to `src/sync/sync.ts` — `addMemberByEmailRemote(ws, email)` and `memberEmailsRemote(ws)` — thin `supabase.rpc(...)` calls that surface `error.code` unchanged so the caller can branch on `DA001`/`DA404`. **No comparator, cursor, merge, paging or loop change of any kind**: `members` rides the existing generic loop by virtue of `SYNCED_TABLES` alone (D-8)
  - Write: `src/sync/sync.ts`
  - Read: contracts/rpc.md; plan.md D-8, D-9; `src/sync/sync.ts:104-141`, `:203-277`, `:409-458`, `:462-507` (read before writing); `ARCHITECTURE.md §4` L331–L378
  - substrate: `sync-engine` (VALIDATED — must stay so), `membership` (new, UNTESTED)
  - verify: `npx tsc -b --noEmit` clean; `npm test -- --run --project stack tests/stack/lww-conflict.test.ts tests/stack/offline-round-trip.test.ts tests/stack/soft-delete.test.ts` green with those files **unedited**
  - done-when: the diff of `src/sync/sync.ts` contains only the two added exports — nothing inside `push`, `pull`, `cycle`, `mergeRows`, `isNewer` or `sameRow` changed (FR-020, CLAUDE.md "LWW lockstep")
  - blocked-by: T023
- [ ] T028 [P] [data] Add one `useLiveQuery` wrapper for `members` to `src/db/hooks.ts`, matching the shape of the existing per-table hooks, so the UI reads the member list reactively from Dexie through `db-api` rather than re-querying
  - Write: `src/db/hooks.ts`
  - Read: `src/db/hooks.ts` (whole); `src/db/api.ts` `listMembers` (post-T026); plan.md "Project Structure" (`src/db/hooks.ts` line)
  - substrate: `local-cache`, `db-api`
  - verify: `npx tsc -b --noEmit` clean and `npm run lint` clean
  - done-when: the hook mirrors an existing hook's signature exactly; no new data path is introduced (FR-026)
  - blocked-by: T026
- [ ] T029 [data] Write `tests/stack/member-offline-round-trip.test.ts` (US6, FR-019/FR-020): B, a member, edits a team task while offline — held locally and marked unsent — then reconnects and the edit is accepted and reaches A; two members edit the same team row and the older edit loses **at the backend and, independently, at the client merge step**, exactly as P0 pinned it for personal rows; a membership change made while a client was offline reaches that client's cache **on its next cycle** (`members` travelling the generic loop); and B, removed while offline with unsent edits to that workspace, has those edits refused on reconnect without retrying forever and **without stalling any other row or table** (edge case 1, plan R-14)
  - Write: `tests/stack/member-offline-round-trip.test.ts`
  - Read: spec.md US6 acceptances 1–6, FR-019, FR-020; plan.md D-7, D-8, R-14; `tests/stack/offline-round-trip.test.ts` and `tests/stack/lww-conflict.test.ts` (the P0 personal equivalents, read-only); `tests/harness/sync.ts` (post-T004)
  - substrate: `sync-engine` (VALIDATED), `membership` (new, UNTESTED), `multi-account-cache` (new, UNTESTED)
  - verify: `npm test -- --run --project stack tests/stack/member-offline-round-trip.test.ts`
  - done-when: FR-019's "learns on its next cycle" is asserted for a `members` row, and the refused-write path is asserted to leave other tables progressing (US6 acceptance 6)
  - blocked-by: T027, T016
- [ ] T030 [reviewer] **LWW lockstep statement.** Assert mechanically that this feature changes neither enforcement point: `git diff <merge-base with main> -- src/sync/sync.ts` touches no line in the merge range (`sameRow`/`isNewer`/`mergeRows`, `src/sync/sync.ts:104-141,409-458`), and `git diff <merge-base> -- supabase/schema.sql` touches no line of the `keep_newer()` function body (`supabase/schema.sql:142-153`). The rule is one rule with two enforcement points; P1 changes neither, and if one of them *did* change, both must change in the same change set or it is a **FINDING**. Reviewer cards write nothing: the diff excerpt is reported in this task's report, and `coordinator` transcribes it into `specs/002-team-workspaces/receipts.md` (see T042)
  - Write: —
  - Read: `CLAUDE.md` "LWW lockstep"; ADR-0001 §3; spec.md FR-020; plan.md D-8, Constitution Check row "LWW lockstep"
  - substrate: `sync-engine`, `supabase-schema`
  - verify: `git diff $(git merge-base HEAD main) -- src/sync/sync.ts supabase/schema.sql` reviewed line by line, with the two protected ranges shown untouched, and the excerpt reported for `coordinator` to paste into `receipts.md`
  - done-when: FR-020 is evidenced by an actual diff, not by assertion; the task report names both ranges and shows zero changed lines in each, ready for `coordinator` to transcribe
  - blocked-by: T029
- [ ] T031 [data] Extend `tests/local/db-api-p1-surface.test.ts` with the **new** `db-api` surface (the split promised in T001): `createWorkspace(name, 'team')` writes only the workspace row and **no** local `members` row (D-6); `listMembers` reads from Dexie; `removeMember` soft-deletes and queues without a network call; `updateTask(id, { assignee })` round-trips through `TaskPatch`. `memberEmails`/`addMemberByEmail` are online-only and are covered by TG-1's stack tests, not here — say so in the file header
  - Write: `tests/local/db-api-p1-surface.test.ts`
  - Read: `src/db/api.ts` (post-T026); plan.md D-6, D-9, D-11; spec.md FR-024, FR-026
  - substrate: `db-api` (VALIDATED — re-verified in this PR), `local-cache`
  - verify: `npm test -- --run --project local tests/local/db-api-p1-surface.test.ts` — green with the stack stopped
  - done-when: every `db-api` function this feature adds that *can* be exercised offline has a passing pin; the two that cannot are named in the header with the stack test that covers them instead
  - blocked-by: T026

**Checkpoint**: membership, `kind` and `assignee` reach the cache and the sync engine through the
same path as everything else. The interface still shows nothing new.

---

## TG-3: The five interface affordances — and nothing else

**Purpose**: FR-024's five affordances, each behind a `kind === 'team'` guard, plus R-11's guard on
two **existing** controls. `src/views/` gains **zero** changes (FR-025). `src/i18n/dict.ts` is owned
by exactly one card (T032); the other five read it. `src/components/Settings.tsx` is written by four
cards and is therefore strictly serial.

- [ ] T032 [ui] Add every new i18n key to `src/i18n/dict.ts` in **both** `ru` and `en`, in one card, so no other card in this taskgroup writes that file: `workspace.kindPersonal`, `workspace.kindTeam`, `members.section`, `members.owner`, `members.member`, `members.add`, `members.emailPlaceholder`, `members.noAccountHere`, `members.remove`, `members.confirmRemove`, `task.assignee`, `task.unassigned`. **No existing string is reworded, shortened or retranslated** (CLAUDE.md, `designer` role rule, applied here too). Hiding a control needs no key. Ownership: `src/i18n/` is owned by `ui` for adding keys (CLAUDE.md, ui role, amended 2026-09-13); the designer rule forbids rewording existing strings, which this card does not do.
  - Write: `src/i18n/dict.ts`
  - Read: plan.md D-11 (the table's i18n column and the note below it); `src/i18n/dict.ts:1-40` (the dictionary type that makes a missing language a compile error); `CLAUDE.md` → `designer` role, last bullet
  - substrate: `i18n-state` (UNTESTED, LOW — stays UNTESTED through P1 by design, ADR-0003 Consequences)
  - verify: `npx tsc -b --noEmit` clean (a missing language is a compile error) and `npm run lint` clean
  - done-when: all twelve keys exist in both languages; `git diff src/i18n/dict.ts` contains **only additions** (FR-024, FR-025)
  - blocked-by: T031
- [ ] T033 [ui] **Affordance 1** — choose **team** when creating a workspace: one kind toggle in `WorkspaceMenu`'s existing `AskName` flow in `src/components/Header.tsx`, calling `createWorkspace(name, kind)`. Personal remains the default when no choice is expressed (US1 acceptance 2). The toggle is the only new element; no reordering of what is already on screen
  - Write: `src/components/Header.tsx`
  - Read: plan.md D-11 row 1, D-6 (why no local `members` row is written); `src/components/Header.tsx` (`WorkspaceMenu`, `AskName`); `src/db/api.ts` `createWorkspace` (post-T026); spec.md FR-024, US1
  - substrate: `chrome-components` (UNTESTED, LOW — stays UNTESTED through P1 by design), `db-api` (VALIDATED)
  - verify: `npx tsc -b --noEmit && npm run lint && npm run build`, plus `git diff --stat -- src/views/` printing nothing
  - done-when: FR-024 affordance 1 exists; creating without expressing a choice yields `personal` (US1 acceptance 2); zero changes under `src/views/` (FR-025)
  - blocked-by: T032
- [ ] T034 [ui] **Affordance 2** — see the member list: a new `members` section in `src/components/Settings.tsx`'s `SECTIONS`, rendered **only** when `workspace.kind === 'team'`, listing members by email via `listMembers` + `memberEmails` and showing each one's level with `members.owner` / `members.member`. Note (D-6): the owner's own membership row arrives on the **next pull**, not immediately at creation — the list must render correctly while it is still empty, not error
  - Write: `src/components/Settings.tsx`, `src/components/Settings.css`
  - Read: plan.md D-11 row 2 and "Placement rationale", D-6 (last paragraph); `src/components/Settings.tsx` (`SECTIONS`, the workspace section); `src/db/hooks.ts` (post-T028); contracts/rpc.md `workspace_member_emails`; spec.md FR-007, FR-024
  - substrate: `chrome-components` (UNTESTED, LOW), `db-api`, `membership` (new)
  - verify: `npx tsc -b --noEmit && npm run lint && npm run build`, plus `git diff --stat -- src/views/` printing nothing
  - done-when: FR-024 affordance 2 exists behind a `kind === 'team'` guard; a person who owns only personal workspaces sees no new section (SC-008)
  - blocked-by: T033
- [ ] T035 [ui] **Affordance 3** — add a member by email, **owner only**: an email field plus submit in the same `members` section, calling `addMemberByEmail(ws, email)`, rendered only when the signed-in person is the workspace's owner. On `DA404`, render the translated `members.noAccountHere` — the client branches on `error.code`, **never** on the server's message text (FR-008, SC-010). Hiding the control is a convenience; the refusal is the backend's (FR-006)
  - Write: `src/components/Settings.tsx`, `src/components/Settings.css`
  - Read: contracts/rpc.md (error table); plan.md D-11 row 3, D-9 "Error shape"; spec.md FR-006, FR-008, SC-010, edge cases 4 and 5
  - substrate: `chrome-components` (UNTESTED, LOW), `db-api`, `membership` (new)
  - verify: `npx tsc -b --noEmit && npm run lint && npm run build`, plus `git diff --stat -- src/views/` printing nothing
  - done-when: FR-024 affordance 3 exists; the "no account on this origin" message is rendered from `src/i18n/dict.ts` on `error.code === 'DA404'` and from nothing else (SC-010)
  - blocked-by: T034
- [ ] T036 [ui] **Affordance 4** — remove a member, **owner only**: a remove control per member row in the same section, reusing the existing `Confirm` component with `members.confirmRemove`, calling `removeMember(ws, memberId)`. The owner's own row carries no remove control — in P1 the owner cannot be removed and cannot leave (FR-010, spec Q2)
  - Write: `src/components/Settings.tsx`, `src/components/Settings.css`
  - Read: plan.md D-11 row 4; `src/components/Confirm.tsx`; spec.md FR-009, FR-010, edge case "The last owner tries to leave or be removed"
  - substrate: `chrome-components` (UNTESTED, LOW), `db-api`, `membership` (new)
  - verify: `npx tsc -b --noEmit && npm run lint && npm run build`, plus `git diff --stat -- src/views/` printing nothing
  - done-when: FR-024 affordance 4 exists; no path in the UI offers to remove the owner (FR-010)
  - blocked-by: T035
- [ ] T037 [ui] **Affordance 5** — set/clear a task's assignee and see it on the task: one new `<Field>` in `src/components/TaskDialog.tsx` beside the existing ones, rendered **only** in a team workspace, offering that workspace's members plus `task.unassigned`, calling `updateTask(id, { assignee })`; and the assignee shown on the card, in the same conditional style the existing optional `GcalRow` uses
  - Write: `src/components/TaskDialog.tsx`, `src/components/TaskDialog.css`
  - Read: plan.md D-11 row 5 and "Placement rationale"; `src/components/TaskDialog.tsx` (`Field`, `GcalRow`); spec.md US5 acceptances 1–2, FR-024; contracts/rpc.md "Freshness / offline" (Option A: no name offline until Q-A is answered)
  - substrate: `task-dialog` (UNTESTED, NORMAL — stays UNTESTED through P1 by design, ADR-0003 Consequences), `db-api`
  - verify: `npx tsc -b --noEmit && npm run lint && npm run build`, plus `git diff --stat -- src/views/` printing nothing
  - done-when: FR-024 affordance 5 exists behind a `kind === 'team'` guard; a personal workspace's task dialog is byte-identical in behaviour (SC-008)
  - blocked-by: T036
- [ ] T038 [ui] **R-11 guard — not a sixth affordance.** In `src/components/Settings.tsx`'s workspace section, hide **both** the existing rename field and the existing delete-workspace button for a **non-owner of a team workspace**. Both are required by FR-005, and both are queue hazards, not cosmetics: a member's rename dirties the workspace row, is refused by the unchanged workspace `with check` (RLS `42501`), and the push loop's per-table catch then re-sends that same refused row every cycle — wedging the workspaces queue for good (R-11, R-14). A member's `deleteWorkspace()` would soft-delete every child and then be refused on the workspace row, leaving an empty-looking live workspace. **Nothing is added and nothing is reordered** — two existing controls become conditional
  - Write: `src/components/Settings.tsx`
  - Read: plan.md D-11 "Note", R-11, R-14; `src/components/Settings.tsx:153-155` (rename field, `useAutosave`); `src/sync/sync.ts:203-277` (the per-table catch, read-only); spec.md FR-005, FR-024
  - substrate: `chrome-components` (UNTESTED, LOW), `team-rls` (new)
  - verify: `npx tsc -b --noEmit && npm run lint && npm run build`, plus `git diff --stat -- src/views/` printing nothing
  - done-when: FR-005 holds in the interface as well as the backend; a personal workspace's Settings is unchanged (both controls still shown) (FR-025, SC-008)
  - blocked-by: T037
- [ ] T039 [ui] **FR-025 / SC-008 receipt.** Capture and record the interface-non-change evidence: `git diff --stat $(git merge-base HEAD main) -- src/views/` showing **zero** lines, and `git diff --stat $(git merge-base HEAD main) -- src/components/ src/styles/` showing changes confined to `Header.tsx`, `Settings.tsx`, `Settings.css`, `TaskDialog.tsx`, `TaskDialog.css` and nothing else. No vitest claim is made for FR-025 — the spec says so explicitly
  - Write: `specs/002-team-workspaces/receipts.md`
  - Read: spec.md FR-025, SC-008; plan.md "The UI entries stay UNTESTED, deliberately", D-14 step 5
  - substrate: `views-core`, `task-dialog`, `chrome-components` (all UNTESTED by design through P1)
  - verify: `git diff --stat $(git merge-base HEAD main) -- src/views/` prints nothing, and the `src/components/` stat lists exactly the five files above; both outputs pasted into `receipts.md`
  - done-when: SC-008's "5 new affordances and 0 other visible changes" has a diff receipt; any sixth changed file is a **FINDING** for the reviewer, not a rationalisation
  - blocked-by: T038

**Checkpoint**: the demo is walkable locally. Nothing in the map has moved yet.

---

## TG-4: Map, receipts, docs — the truth-telling taskgroup

**Purpose**: FR-031's "in the same change that adds the behaviour" is satisfied because this
taskgroup ships in the same PR as TG-1..TG-3. Three cards here are **BLOCKED on the owner** and must
not be settled by an agent (CLAUDE.md, agent roles).

- [ ] T040 [coordinator] Add the three new HIGH entries to `docs/validation-map.md` — `membership`, `team-rls`, `multi-account-cache` — with the `kind`, `criticality: HIGH`, `paths`, `depends-on` and `scenarios` that `ARCHITECTURE.md §2` already assigns them, each with a real `verify:` command and `tests:` list, and flip each to `VALIDATED` with `last-verified: <sha> <date>` and `sign-off: Andrii Tkhorenko (single-operator)` backed by TG-1/TG-2's receipts. `paths` for `membership` ⊇ `supabase/schema.sql`, `src/db/api.ts`; for `team-rls` ⊇ `supabase/schema.sql`; for `multi-account-cache` ⊇ `src/db/local.ts`, `src/db/types.ts`
  - Write: `docs/validation-map.md`
  - Read: `docs/project-structure.md` (map grammar, closed status vocabulary); `ARCHITECTURE.md §2` (fork target — new components); plan.md D-15, "Validation substrate"; `specs/002-team-workspaces/receipts.md`
  - substrate: `membership`, `team-rls`, `multi-account-cache` (this task is where they are created and flipped)
  - verify: named manual check — each of the three entries names a command that was actually run in this PR, and each command is re-run once from the map text itself and passes
  - done-when: SC-004's "unproven HIGH-tier entries introduced by this feature 3 → 0" holds; no entry is `VALIDATED` without a receipt (CLAUDE.md reviewer duty 5)
  - blocked-by: T039
- [ ] T041 [coordinator] Re-verify and re-sign the three existing entries this feature touches: `supabase-schema` (gains no new file but a materially changed one — re-run its `verify:` and add `tests/stack/team-*.test.ts` to `tests:`), `local-cache` (`paths` unchanged, Dexie v3 — re-run and add `tests/local/no-wipe-on-reach-growth.test.ts`), `db-api` (`paths` unchanged, surface widened — re-run and keep `tests/local/db-api-p1-surface.test.ts`). A component whose `paths` or behaviour change without its map entry changing is a **FINDING** (CLAUDE.md reviewer duty 5)
  - Write: `docs/validation-map.md`
  - Read: `docs/validation-map.md` (the three entries); plan.md D-15; `specs/002-team-workspaces/receipts.md`
  - substrate: `supabase-schema`, `local-cache`, `db-api`
  - verify: each of the three entries' `verify:` command is run verbatim from the map text and passes; outputs recorded
  - done-when: all three carry a `last-verified` SHA from this PR and a `(single-operator)` sign-off (FR-031)
  - blocked-by: T040
- [ ] T042 [coordinator] Complete `specs/002-team-workspaces/receipts.md` in the shape P0 established: the full-suite receipt (`npm test -- --run`, twice), the CI receipt (a green run URL on `002-team-workspaces`), T011's inversion demonstration (executed or the named fallback), T022's P0-unedited diff, T030's lockstep diff, T039's interface diff, FINDINGS with dispositions, and `Sign-off: Andrii Tkhorenko (single-operator)`
  - Write: `specs/002-team-workspaces/receipts.md`
  - Read: `specs/001-validation-spine/receipts.md` (shape); plan.md D-14, D-15; spec.md SC-003, SC-005, SC-008, SC-013, SC-014
  - substrate: all entries touched by this feature
  - verify: `npm test -- --run` green twice consecutively with both runs recorded, and the CI run on this branch green with its URL recorded
  - done-when: SC-014 holds (the whole body of evidence runs from the same single command as P0's, unattended, no browser) and SC-013 holds (**0** credentials in the diff, **0** runs touching a hosted project)
  - blocked-by: T041
- [ ] T043 [coordinator] **F-5 — sign-out ordering. BLOCKED on owner Q-B.** Record the disposition on `docs/validation-map.md`'s `supabase-auth` entry. D-12's recommendation is option **(b)**: `accepted-risk: "sign-out ordering uncovered; browser-bound. Owner: Andrii Tkhorenko, 2026-09-13, expires end of P2 (Playwright arrives, ADR-0003)"`. The supporting fact the owner is asked to weigh: P1 turns out **not** to change the sign-out order at all — `src/auth/useSession.ts:112-118` and `src/components/Settings.tsx`'s `AccountSection` sign-out path are not in this feature's diff, so FR-023 is satisfied by the files not being touched. If the owner requires option **(a)** instead, this card becomes "cover the non-interface steps and the wipe's effect directly, and say precisely what remains browser-bound". **Silently leaving F-5 as it is is prohibited** (FR-032, SC-011)
  - Write: `docs/validation-map.md`, `specs/002-team-workspaces/receipts.md`
  - Read: spec.md "Inherited accepted risk — F-5", FR-023, FR-032, SC-011; plan.md D-12, Owner question Q-B; `specs/001-validation-spine/receipts.md` F-5; `src/auth/useSession.ts:112-118`; `src/components/Settings.tsx:208-224`
  - substrate: `supabase-auth` (UNTESTED, carries F-5)
  - verify: `git diff $(git merge-base HEAD main) -- src/auth/ src/components/Settings.tsx` reviewed and shown to contain no change to the sign-out path, **plus** the owner's recorded decision text pasted into the map entry
  - done-when: SC-011 holds — F-5 ends this feature either covered by a passing check or re-recorded with an owner name, a date and an expiry; the number of ways it ends silently unaddressed is 0
  - blocked-by: **owner** (Q-B), T042
- [ ] T044 [coordinator] **ADR-0001 Consequences amendment, or ADR-0006 — BLOCKED on owner.** ADR-0001's Consequences call the multi-account cache rework "unavoidable in P1". D-10 concludes the opposite, and the spec written later agrees with D-10: FR-021, FR-022 and SC-012 require `claimCache`/`wipeLocal` to behave exactly as today, so P1's honest `multi-account-cache` deliverable is confirmed-unchanged semantics plus an additive Dexie version. That is a divergence from an accepted ADR's wording and, per CLAUDE.md, **a new owner decision lands in an ADR first**. The owner chooses: amend ADR-0001's Consequences in place, or write `ADR-0006` superseding that paragraph. Either way the map's affected entries take a `STALE` cascade and `docs/architecture-index.md` is regenerated **in the same PR** if `docs/ARCHITECTURE.md` changes
  - Write: `docs/decisions/ADR-0001-fork-contract.md` **or** `docs/decisions/ADR-0006-*.md` (owner's choice), `docs/validation-map.md`, `docs/ARCHITECTURE.md` and `docs/architecture-index.md` **only if** an architecture fact changes
  - Read: `docs/decisions/ADR-0001-fork-contract.md` (Consequences); plan.md D-10 "Why the cache rework shrinks to nothing"; spec.md FR-021, FR-022, SC-012; `CLAUDE.md` → Git ("an architecture change is a new ADR + a STALE cascade + a regenerated index, all in the same PR")
  - substrate: `multi-account-cache` (new), `local-cache`
  - verify: named manual check — the owner's decision exists as an ADR or an ADR amendment with a date and a sign-off, and if `docs/ARCHITECTURE.md` changed, `docs/architecture-index.md` was regenerated in the same commit
  - done-when: the divergence between D-10 and ADR-0001's Consequences is resolved **in writing by the owner**, not absorbed by an agent
  - blocked-by: **owner**, T042
- [ ] T045 [coordinator] **Q-A — member email caching. BLOCKED on owner.** T026 ships **Option A** (no per-device email cache; emails fetched live; offline the member list and a task's assignee show an identity-less placeholder) because it is the strict reading of FR-007/Q1 and is the safe default. The plan **recommends Option B**: `meta` holds `member-email:<uuid>`, refreshed on each successful `workspace_member_emails` call, cleared by `wipeLocal()`, never synced, never authoritative, drift bounded to one sync cycle — on the grounds that FR-019's "learns on its next cycle" is the intended standard for derived data and that an assignee with no name is a worse product than a one-cycle-stale name. **Switch note**: adopting B is a change inside the single `memberEmails()` function in `src/db/api.ts` plus one `meta` key in `wipeLocal`'s clear list — no schema change, no wire change, no second copy that can outlive a sign-out
  - Write: `specs/002-team-workspaces/receipts.md`, and — **only if the owner adopts Option B** — `src/db/api.ts`, `src/db/local.ts`
  - Read: spec.md FR-007, clarification Q1, FR-019; plan.md Owner question Q-A, R-12, D-9 "Why no `profiles` table"; contracts/rpc.md "Freshness / offline"; `src/gcal/sync.ts:26-27` (the existing per-device `meta` cache shape this would copy)
  - substrate: `db-api`, `local-cache`, `multi-account-cache` (new)
  - verify: if the owner keeps Option A — named manual check that no email is written to Dexie anywhere in the diff (`git grep -n "email" src/db/`); if the owner adopts Option B — `npm test -- --run --project local` green, including a new assertion that `wipeLocal()` clears every `member-email:` key
  - done-when: the owner's answer is recorded in `receipts.md` with a date, and the code matches it; FR-007's "no second copy of the email MUST be stored" is satisfied under whichever reading the owner chose
  - blocked-by: **owner** (Q-A), T042
- [ ] T046 [reviewer] Whole-branch review against the four reviewer duties, verdict short (a list of findings, or "clean"): **(1) personal-must-not-regress** — does anything in this diff change what a `kind: personal` workspace does, in data, sync, or views? **(2) spec control** — is every button, field and behaviour in the diff named in `spec.md` FR-024 or required by an FR? **(3) origin-invariant control** — is there any cross-origin reference, query, shared identity or token, or any "origin" column or table anticipating a model that needs no schema support (FR-027, SC-009)? **(4) map discipline** — did any component's `paths` or behaviour change without its map entry changing; is any `VALIDATED` claim unbacked by a receipt; is any sign-off presented as anything other than `(single-operator)`? Anything debatable goes to the owner **via the coordinator**, not decided here
  - Write: — (read-only; the findings list goes to the coordinator in the task report, no file written)
  - Read: `git diff $(git merge-base HEAD main)` (whole branch); `CLAUDE.md` → `reviewer` role, "What replaces upstream's 'What must not exist'"; spec.md "Personal must not regress", FR-024, FR-025, FR-027, FR-030..FR-033; `docs/validation-map.md`; `specs/002-team-workspaces/receipts.md`
  - substrate: every entry this feature touches
  - verify: `npm test -- --run` green, `npx tsc -b --noEmit` clean, `npm run lint` clean, `npm run build` clean, `git diff $(git merge-base HEAD main) -- src/views/` empty, and `git diff $(git merge-base HEAD main) | Select-String -Pattern "(?i)(service_role|secret|api[_-]?key|token|password)"` reviewed line by line with no credential present
  - done-when: SC-009 (**0** origin columns/tables/cross-origin references), SC-013 (**0** credentials) and SC-003 (**0** P0 edits) each have a named check behind them; the verdict is recorded and every finding has a disposition
  - blocked-by: T042

**Checkpoint**: the map tells the truth, the receipts back it, and the three owner questions are on
the owner's desk rather than answered by an agent.

---

## TG-5: The hosted demo walk — owner-run, manual, outside the suite

**Purpose**: SC-001's eleven-step walk on one deployment with two accounts, after the unattended
suite is green. **Nothing here runs in the suite and nothing in the suite touches a hosted project**
(SC-013). Steps marked **[owner]** are performed by the fork owner in person; no agent performs them
and no agent handles a hosted key.

- [ ] T047 [owner] Re-run the whole of `supabase/schema.sql` in the **hosted** project's SQL editor. It is idempotent, and re-running it is upstream's own convention (ADR-0005). Expect no error and no row change — in particular, every pre-existing workspace must read `kind = 'personal'` afterwards without a backfill (US1 acceptance 1, D-2)
  - Write: `specs/002-team-workspaces/receipts.md`
  - Read: plan.md D-14 step 1, D-2; `supabase/schema.sql` (post-TG-1); ADR-0005
  - substrate: `supabase-schema` (VALIDATED)
  - verify: named manual check (owner-run) — the SQL editor reports success, and `select kind, count(*) from public.workspaces group by 1` returns only `personal` rows for pre-existing data; both outputs recorded
  - done-when: US1 acceptance 1 holds on real data ("no row changed value, no row became team by omission")
  - blocked-by: T046
- [ ] T048 [owner] Create account **B** in the Supabase dashboard (Authentication → Users → Add user, email confirmed). This is the **only** manual database intervention SC-001 permits, and it exists because upstream has no sign-up UI and P1 adds none (spec Assumptions, Out of Scope)
  - Write: `specs/002-team-workspaces/receipts.md`
  - Read: plan.md D-14 step 2; spec.md SC-001, FR-008, Out of Scope ("Sign-up UI")
  - substrate: `supabase-auth` (UNTESTED, F-5 disposition per T043)
  - verify: named manual check (owner-run) — account B exists and can sign in to the deployed app; **B's email is not recorded in the repository** (FR-033)
  - done-when: exactly one manual intervention was needed (SC-001)
  - blocked-by: T047
- [ ] T049 [infra] Build and deploy: `npm run build`, then `npx wrangler deploy`, with the **same** `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` already in use and `CLOUDFLARE_API_TOKEN` supplied **from the operator's environment**. **Never `wrangler login`** (interactive) and **never a key, token or hosted URL in the repository or in any committed file** (FR-033, SC-013)
  - Write: — (no repository file; the deploy output is recorded by T051)
  - Read: plan.md D-14 step 3; `wrangler.jsonc`; `README.md` (deploy section); `CLAUDE.md` → `infra` role ("Secrets never enter the repository, under any circumstances")
  - substrate: `env-boot` (VALIDATED)
  - verify: `npm run build` exits 0 and `npx wrangler deploy` reports a successful deployment; then `git status` is clean and `git diff $(git merge-base HEAD main)` contains no token, key or hosted URL
  - done-when: the deployed build serves the five affordances; SC-013 holds (**0** credentials added to the repository)
  - blocked-by: T048
- [ ] T050 [owner] Walk the **eleven steps** of spec.md "First demo — the acceptance walk" on two browsers or two devices, A and B, recording pass/fail **per step**: (1) A creates a team workspace; (2) A adds tasks, one with a due date, one with a label; (3) A opens the member list and adds B by email; (4) A assigns one task to B, leaves another unassigned; (5) B signs in on a second device and sees the team workspace with A's rows and the assignee; (6) B's list contains **none** of A's personal workspaces — not greyed out, not empty, not present; (7) B goes offline, edits a task, creates another; (8) B comes back online and the queued edits are accepted; (9) A sees B's edit and B's new task without doing anything special; (10) A's personal workspaces behave exactly as before throughout; (11) A removes B — B's next cycle shows the workspace gone and the assigned task reads unassigned for A
  - Write: `specs/002-team-workspaces/receipts.md`
  - Read: spec.md "First demo — the acceptance walk" (all eleven steps), SC-001, SC-002, SC-006; plan.md D-14 step 4, D-6 (the owner's own member row arrives on the next pull, so step 3's list is correct after one cycle, not instantly)
  - substrate: `membership`, `team-rls`, `multi-account-cache` (all VALIDATED after T040)
  - verify: named manual check (owner-run) — eleven recorded outcomes, one line per step, with the date and the deployed build's SHA
  - done-when: SC-001 holds (the walk completes end to end with zero manual database intervention beyond T048); any failed step is a FINDING with a disposition, never a silently retried step
  - blocked-by: T049
- [ ] T051 [coordinator] Close the feature: fold T047–T050's outcomes into `specs/002-team-workspaces/receipts.md` alongside T039's `git diff --stat` receipt, confirm the Definition of Done from `CLAUDE.md` item by item (map entry updated in the same PR; every `verify:` command actually run; CI green — install, typecheck, lint, build, test; personal workspaces demonstrably unchanged; nothing in the diff outside the spec; no credential, key or token anywhere in the diff), and hand the three owner-blocked items (T043, T044, T045) to the owner as explicitly open if any is still unanswered. **The coordinator commits; no agent in this list commits on its own** (task-brief rule, CLAUDE.md Git)
  - Write: `specs/002-team-workspaces/receipts.md`
  - Read: `CLAUDE.md` → "Definition of done", Git; plan.md D-14, D-15; T039, T042, T046 outputs
  - substrate: every entry this feature touches
  - verify: `npm test -- --run` green, `npx tsc -b --noEmit` clean, `npm run lint` clean, `npm run build` clean, CI green on the branch, and `git log --stat` showing the map change in the same PR as the behaviour
  - done-when: every bullet of CLAUDE.md's Definition of done is checked off with a named receipt, and SC-001..SC-014 each have a receipt or a recorded owner-blocked disposition
  - blocked-by: T050

---

## Dependencies & Execution Order

- **TG-0 → TG-1** is a hard gate: ADR-0002 forbids building on `UNTESTED` substrate, and `db-api`
  is the door every affordance goes through. The `sync-engine` flake repair is in the same gate
  because a `VALIDATED` entry standing on a flaky receipt is a map-discipline defect, and the
  regression net for the whole of P1 is exactly those P0 tests.
- **Within TG-1** the P-gate applies again: T008–T016 (evidence and harness) are authored before
  T017–T021 (schema), and each schema card is verified by turning a named test green. T017 → T018 →
  T019 → T020 → T021 are strictly serial — one file, `supabase/schema.sql`.
- **TG-1 → TG-2**: the wire cannot carry `members` before `members` exists, and T006's R-10 verdict
  must be in hand before `SYNCED_TABLES` is widened.
- **TG-2 → TG-3**: `ui` waits until `data` has landed the membership model (CLAUDE.md, `ui` role:
  team affordances "land only against a spec, and only after `data` has the membership model in
  place").
- **TG-3 → TG-4**: the map is not flipped for a component whose behaviour is not merged.
- **TG-4 → TG-5**: the hosted walk happens only after the unattended suite is green (D-14).
- **Owner-blocked cards** — **T043** (Q-B, F-5), **T044** (ADR-0001 Consequences amendment or
  ADR-0006), **T045** (Q-A, member email caching) — do not block TG-5's technical steps, but the
  feature is not done while any of them is unanswered (SC-011, CLAUDE.md agent roles).

**MVP scope**: TG-0 + TG-1. That alone is the whole access transform, proven at the data layer by
two authenticated clients with no browser, and it is the half of this feature that can leak one
account's rows to another. It is worth merging and reviewing on its own before any interface exists.

---

## Workfile & conflict map

| Task | Lane | Role | Files | Conflict note |
|------|------|------|-------|---------------|
| T001 | wt/dbapi-debt | data | `tests/local/db-api-p1-surface.test.ts` | shared with T031 (TG-2) — serialize across taskgroups |
| T002 | serial | coordinator | `docs/validation-map.md`, `specs/002-team-workspaces/receipts.md` | creates `receipts.md`; every later receipt card appends |
| T003 | serial | data | `specs/002-team-workspaces/receipts.md` | appends after T002 |
| T004 | wt/sync-flake | data | `tests/harness/sync.ts`, `tests/stack/soft-delete.test.ts` | the **only** sanctioned P0-test edit; no assertion may change |
| T005 | serial | data | `specs/001-validation-spine/receipts.md`, `docs/validation-map.md` | map written serially with T002 |
| T006 | read-only | reviewer | — (no file written) | [P] — reads only; blocks T023 |
| T007 | wt/harness-accounts | data | `tests/harness/accounts.ts` | [P] — disjoint from T008/T016 |
| T008 | wt/guards | data | `tests/stack/team-schema-guards.test.ts` | [P] — own file |
| T009 | wt/us2-members | data | `tests/stack/members-two-accounts.test.ts` | own file |
| T010 | wt/us3-rls | data | `tests/stack/team-rls-both-halves.test.ts` | shared with T011, T012 — serial in that order |
| T011 | wt/us3-rls | data | `tests/stack/team-rls-both-halves.test.ts`, `specs/002-team-workspaces/receipts.md` | receipts append |
| T012 | wt/us3-rls | data | `tests/stack/team-rls-both-halves.test.ts` | after T011 |
| T013 | wt/us5-assignee | data | `tests/stack/assignee-clear-on-removal.test.ts` | own file |
| T014 | wt/triggers | data | `tests/stack/team-triggers.test.ts` | own file |
| T015 | wt/personal | data | `tests/stack/personal-unchanged.test.ts` | own file |
| T016 | wt/harness-seed | data | `tests/harness/seed.ts` | [P] — disjoint from T007 |
| T017 | serial | data | `supabase/schema.sql` | **`supabase/schema.sql` is written by T017–T021; strictly serial, never parallel lanes** |
| T018 | serial | data | `supabase/schema.sql` | after T017 |
| T019 | serial | data | `supabase/schema.sql` | after T018 |
| T020 | serial | data | `supabase/schema.sql` | after T019 |
| T021 | serial | data | `supabase/schema.sql` | after T020 |
| T022 | serial | data | `specs/002-team-workspaces/receipts.md` | appends |
| T023 | serial | data | `src/db/types.ts` | the constants every other TG-2 card depends on |
| T024 | serial | data | `src/db/local.ts` | shared with T045 (Option B only) — serialize |
| T025 | wt/cache-growth | data | `tests/local/no-wipe-on-reach-growth.test.ts` | [P] — own file, disjoint from T024 |
| T026 | serial | data | `src/db/api.ts` | shared with T031 (reads) and T045 (Option B writes) — serialize |
| T027 | serial | data | `src/sync/sync.ts` | only file in TG-2 touching the sync engine; T030 diffs it |
| T028 | wt/hooks | data | `src/db/hooks.ts` | [P] — own file |
| T029 | wt/us6-offline | data | `tests/stack/member-offline-round-trip.test.ts` | own file |
| T030 | read-only + receipts | reviewer | `specs/002-team-workspaces/receipts.md` | appends; diffs `src/sync/sync.ts` and `supabase/schema.sql` without writing them |
| T031 | wt/dbapi-debt | data | `tests/local/db-api-p1-surface.test.ts` | same file as T001 — serial across TG-0/TG-2 |
| T032 | serial | ui | `src/i18n/dict.ts` | **one card owns the dictionary; T033–T038 read it and never write it** |
| T033 | serial | ui | `src/components/Header.tsx` | own file, but sequenced after T032 for the keys |
| T034 | serial | ui | `src/components/Settings.tsx`, `src/components/Settings.css` | **`Settings.tsx` is written by T034, T035, T036, T038 → strictly serial** |
| T035 | serial | ui | `src/components/Settings.tsx`, `src/components/Settings.css` | after T034 |
| T036 | serial | ui | `src/components/Settings.tsx`, `src/components/Settings.css` | after T035 |
| T037 | serial | ui | `src/components/TaskDialog.tsx`, `src/components/TaskDialog.css` | own files |
| T038 | serial | ui | `src/components/Settings.tsx` | after T036; hides two existing controls, adds none |
| T039 | serial | ui | `specs/002-team-workspaces/receipts.md` | appends |
| T040 | serial | coordinator | `docs/validation-map.md` | map written serially with T041, T043 |
| T041 | serial | coordinator | `docs/validation-map.md` | after T040 |
| T042 | serial | coordinator | `specs/002-team-workspaces/receipts.md` | appends |
| T043 | serial | coordinator | `docs/validation-map.md`, `specs/002-team-workspaces/receipts.md` | **BLOCKED on owner (Q-B)**; map after T041 |
| T044 | serial | coordinator | `docs/decisions/ADR-0001-fork-contract.md` **or** `docs/decisions/ADR-0006-*.md`, `docs/validation-map.md`, (`docs/ARCHITECTURE.md` + `docs/architecture-index.md` only if an architecture fact changes) | **BLOCKED on owner**; if `ARCHITECTURE.md` changes, the index is regenerated in the same commit |
| T045 | serial | coordinator | `specs/002-team-workspaces/receipts.md`; **Option B only**: `src/db/api.ts`, `src/db/local.ts` | **BLOCKED on owner (Q-A)**; source files shared with T024/T026 — serialize |
| T046 | read-only | reviewer | — (no file written) | whole-branch diff review |
| T047 | serial | owner | `specs/002-team-workspaces/receipts.md` | owner-run; hosted SQL editor, no repo change |
| T048 | serial | owner | `specs/002-team-workspaces/receipts.md` | owner-run; dashboard only |
| T049 | serial | infra | — (no repository file) | `CLOUDFLARE_API_TOKEN` from the environment; never `wrangler login`, never a key in the repo |
| T050 | serial | owner | `specs/002-team-workspaces/receipts.md` | owner-run; eleven recorded outcomes |
| T051 | serial | coordinator | `specs/002-team-workspaces/receipts.md` | closes the feature; the coordinator commits |

**Conflicts of record.**
`supabase/schema.sql` — T017, T018, T019, T020, T021, in that order, one lane, never split.
`docs/validation-map.md` — T002, T005, T040, T041, T043, T044 (and T044 only if the owner's ADR
choice cascades `STALE`), all `serial`.
`specs/002-team-workspaces/receipts.md` — created by T002, appended by T003, T011, T022, T030, T039,
T042, T043, T045, T047, T048, T050, T051; append-only, serial.
`src/components/Settings.tsx` — T034, T035, T036, T038, in that order.
`src/i18n/dict.ts` — T032 only; T033–T038 read it.
`src/db/api.ts` — T026 (writes), T031 (tests it), T045 (writes, Option B only) — serial.
`src/db/local.ts` — T024 (writes), T025 (tests it), T045 (writes, Option B only) — serial.
`tests/local/db-api-p1-surface.test.ts` — T001 then T031, across two taskgroups.
`tests/harness/*.ts` — additive exports only; **no existing export changes signature** (D-13),
because P0 files import them. The one exception is T004's settle-wait repair, which is a P0 debt
fix recorded in receipts and re-baselined before TG-1 begins.
**Parallel markers** (`[P]`) appear only on T001, T006, T007, T008, T016, T025, T028 — the tasks
whose `Write:` sets are disjoint from every other task runnable at the same time.
