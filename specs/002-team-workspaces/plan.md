# Implementation Plan: P1 Team Workspaces — the minimal team transform

**Branch**: `002-team-workspaces` | **Date**: 2026-09-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-team-workspaces/spec.md`

## Summary

Turn the single-owner planner into a planner that also has **team** workspaces, without changing
what a **personal** workspace does. Concretely: `workspaces.kind` (switchable in both directions by
its owner), a `public.members` table with two levels, a nullable `tasks.assignee`, the replacement of
both halves of every `own_rows` policy on the four existing tables, and exactly seven new interface
affordances.

The feature also carries the instance's **front door**, decided by the owner on 2026-09-13 and
recorded in ADR-0006: one deployment for everyone, so accounts are minted *inside the app* by an
instance admin rather than in the Supabase dashboard. That is `public.instance_admins`, a first-account
trigger, and five `security definer` provisioning routines that write `auth.users` / `auth.identities`
directly — **no `service_role` key anywhere** (D-16, D-17). The third piece that arrived with it is a
bounded change to the *push* path so that an RLS refusal no longer wedges a table's queue forever
(D-18); the conflict rule itself is untouched, so FR-020's lockstep holds unchanged.

Approach: all SQL lands in `supabase/schema.sql` (ADR-0005), guarded and idempotent, with **no
`migration-007`** — nothing in P1 needs a row backfill (D-2). Team access is expressed through two
`security definer` helpers, `is_member(ws)` / `is_owner(ws)`, because the members table's own policy
would otherwise recurse into itself (D-5). `members` becomes the **fifth synced table**, carried by
the existing generic sync loop with the same four housekeeping columns and the same
`keep_newer` / `touch_synced_at` triggers, which is what FR-019 asks for and what makes the P0
harness cover it for free (D-8). The local cache is **not** reworked: FR-021/FR-022 and SC-012
require `claimCache`/`wipeLocal` to behave exactly as they do today, so P1's `multi-account-cache`
work is a Dexie version bump that is additive only, plus the naming discipline that makes ADR-0004's
`(origin, account)` key a widening — verified by reviewer reading, as FR-022 itself specifies (D-10).

Evidence is the same tier P0 established: vitest, two supabase-js clients in one process, the local
`supabase` CLI stack in Docker, no browser (ADR-0002, ADR-0003). Every P0 check must pass **unedited**
(FR-030); the first tasks of this feature clear the one piece of map debt that sits directly on the
feature's path, `db-api` (see below).

## Validation substrate

| Map entry | Status at planning | Debt task needed? |
|-----------|--------------------|-------------------|
| `supabase-schema` | VALIDATED (`5448a0d`, 2026-09-13) | no — this feature changes it; re-verify + re-sign in the same PR |
| `sync-engine` | VALIDATED (`e7f258d`, 2026-09-12) → **changed by D-18 → re-verify** | **yes — the push path changes (ADR-0006 §E); re-verify + re-sign in the same PR, on top of the new `push-refusal-fallback` check** |
| `local-cache` | VALIDATED (`5448a0d`, 2026-09-13) | no — Dexie v3 is additive; re-verify + re-sign in the same PR |
| `db-api` | **UNTESTED** | **yes — FIRST tasks of this feature (P-gate, ADR-0002)** |
| `supabase-auth` | **UNTESTED**, carries accepted risk F-5 | **yes — F-5 must be covered or re-recorded (FR-032); owner's word required (D-12)** |
| `env-boot` | VALIDATED (`88e74aa`, 2026-09-12) | no |
| `views-core` | UNTESTED (NORMAL) | **no — stays UNTESTED through P1 by design (ADR-0003 Consequences)** |
| `task-dialog` | UNTESTED (NORMAL) | **no — stays UNTESTED through P1 by design (ADR-0003 Consequences)** |
| `chrome-components` | UNTESTED (LOW) | **no — stays UNTESTED through P1 by design (ADR-0003 Consequences)** |
| `i18n-state` | UNTESTED (LOW) | **no — stays UNTESTED through P1 by design (ADR-0003 Consequences)** |
| `gcal-integration` | UNTESTED (NORMAL) | no — not on this feature's path; untouched |
| `membership` *(new, HIGH)* | does not exist → added `UNTESTED`, flipped by this feature's receipts | **yes — created and validated inside this feature (SC-004)** |
| `team-rls` *(new, HIGH)* | does not exist → added `UNTESTED`, flipped by this feature's receipts | **yes — created and validated inside this feature (SC-004)** |
| `multi-account-cache` *(new, HIGH)* | does not exist → added `UNTESTED`, flipped by this feature's receipts | **yes — created and validated inside this feature (SC-004)** |
| `account-provisioning` *(new, HIGH)* | does not exist → added `UNTESTED`, flipped by this feature's receipts | **yes — created and validated inside this feature (ADR-0006 Consequences, SC-018..SC-020)** |

**The debt row that becomes the first tasks: `db-api`.** The five UI affordances (FR-024) all reach
data through `src/db/api.ts`, and `src/db/api.ts` is where `kind`, `assignee` and the member
operations become visible to the interface (ARCHITECTURE §4 L407-424). It is HIGH-tier and
`UNTESTED`. ADR-0002's gate rule — *no phase starts while the substrate it stands on is `UNTESTED`* —
therefore bites here and nowhere else in this feature: the **first tasks** of 002 write
`tests/local/db-api-*.test.ts` pinning the P1-touched `db-api` functions **as they behave today**
(`createWorkspace`, `createTask`, `updateTask`, `deleteWorkspace`'s child cascade, `listWorkspaces`),
before a single line of `src/db/api.ts` is changed. Those tests are the Docker-free tier, so they
cost nothing to run. Only then do the new functions land.

**The four new HIGH entries** (`membership`, `team-rls`, `multi-account-cache`,
`account-provisioning`) come from ARCHITECTURE §2 "Fork target — new components", plus ADR-0006's
Consequences for the fourth. Each is added to `docs/validation-map.md` as `UNTESTED` in the change
that creates the behaviour, and flipped to `VALIDATED` in the same change that lands its receipts —
never in a later one (FR-031). SC-004's "unproven HIGH-tier entries introduced by this feature
**4 → 0**" is the acceptance for that.

**`sync-engine` is the fifth entry this feature owes a receipt for**, and it is the only one that
starts `VALIDATED`. D-18 changes the push path, so its P0 receipt no longer describes the code: the
entry is re-verified and re-signed with a receipt dated to *this* change set, with the new
`push-refusal-fallback` check added to its `tests:` list (ADR-0006 §E, SC-004's second sentence).
Its three P0 checks stay the regression net for FR-020 and must pass **unedited**.

**The UI entries stay UNTESTED, deliberately.** `views-core`, `task-dialog`, `chrome-components` and
`i18n-state` are NORMAL/LOW and are excluded from P1's evidence by ADR-0003's Consequences ("Until P2
there is no test that exercises the real UI … their NORMAL/LOW tiers are what make that acceptable").
FR-025 says so too, in the spec's own words: interface non-change is proven by **reviewer diff
control plus a `git diff --stat` receipt plus the manual walk**, and *"no vitest claim is made for
it"*. This is recorded here explicitly so that shipping 002 with four UNTESTED UI entries reads as a
decision, not as an oversight.

## Technical Context

**Language/Version**: TypeScript ~6.0 / ESM, Node 22 (CI pin), React 19; PostgreSQL 17 (local
supabase stack) with PL/pgSQL.

**Primary Dependencies**: unchanged. `@supabase/supabase-js` ^2.114, `dexie` ^4.4, `vite` ^8.2,
`vitest` + `jsdom` + `fake-indexeddb` + `pg` (dev, added by P0), `supabase` CLI ^2.117.
**No new runtime or dev dependency is added by this feature.**

**Storage**: Postgres (one origin) + Dexie/IndexedDB (`dandori`, version 2 → **3**) +
`localStorage` for UI state and the Supabase session.

**Testing**: vitest, two tiers as P0 built them — `tests/stack/` (needs Docker) and `tests/local/`
(does not). Two independently constructed supabase-js clients per two-account scenario; a third for
the "knows an id, is not a member" cases (D-13).

**Target Platform**: developer workstation + `ubuntu-latest` in CI; plus one hosted Cloudflare
Workers deployment and one hosted Supabase project for the manual eleven-step demo walk (D-14),
which is owner-run and outside the suite.

**Project Type**: single-project web app (Vite SPA, no server component), one Supabase origin.

**Performance Goals**: not a criterion (spec Assumptions). The membership lookup per row check is
named in ADR-0001 Consequences so a later slowdown has a suspect; it is not measured here. The suite
must stay under five minutes wall-clock in CI including stack start, as P0 set.

**Constraints**:
- Personal behaviour is observably unchanged (ADR-0001 §6, spec "Personal must not regress").
- Every P0 check passes **unedited** (FR-030, SC-003). A P0 check that must change is a FINDING.
- No origin column, origin table or cross-origin reference (FR-027, ADR-0004, SC-009).
- Tables and columns only ever added; RLS predicates are the one replacement surface (ADR-0001 §2).
- All definitions in `supabase/schema.sql` (ADR-0005); a numbered migration only for a row backfill.
- The UI reaches data only through `src/db/api.ts` (FR-026); `db-api` never opens a socket
  (ARCHITECTURE §2 layering) — see D-9, which is the one place this bites.
- No browser automation (ADR-0003). No credential in the repo (FR-033, SC-013).

**Scale/Scope**: 8 user stories, 46 functional requirements, 21 success criteria. **Two** new tables
(`members`, `instance_admins`), two new columns, four replaced policies (eight halves), **eight**
backend operations (2 membership + 6 instance-admin), **seven** new triggers (four fork triggers on
the four existing tables, `workspaces_seed_owner`, `workspaces_zz_kind_change`, and the first-admin
trigger on `auth.users`), one Dexie version, **seven** UI affordances, ~10 new test files, plus one
bounded change to `src/sync/sync.ts`'s push loop (D-18).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is **still the unfilled spec-kit template** — every principle is a
`[PRINCIPLE_N_NAME]` placeholder (verified at planning time, 2026-09-13). There are therefore **no
constitutional gates to evaluate**, and none are invented here. The governing constraints are
`CLAUDE.md` and the five accepted ADRs, checked instead:

| Constraint | Source | Status |
|---|---|---|
| Workspace `kind` is `personal`/`team`, defaulting to personal | ADR-0001 §1, as amended by ADR-0006 §D | PASS — D-1; still exactly two values, now switchable by the owner (D-6′) |
| Membership is exactly two levels, not a role system | ADR-0001 §1 | PASS — D-1, `check (level in ('owner','member'))` |
| `assignee` carries no authorization meaning; RLS never reads it | ADR-0001 §1, FR-017 | PASS — D-3; no policy predicate mentions `assignee` |
| Removal auto-clears assignment, structurally, never by the client | ADR-0001 §1, FR-018 | PASS — D-3 trigger |
| Tables/columns only ever added; policies the one replacement surface | ADR-0001 §2 | PASS — D-1, D-4 |
| Both policy halves replaced separately; asymmetry preserved | ADR-0001 §2, FR-012 | PASS — D-4 |
| The three existing triggers behave identically | ADR-0001 §2, FR-014 | PASS — D-4, D-6, D-6′; new triggers are ordered so they cannot pre-empt them |
| LWW lockstep: one rule, two enforcement points | ADR-0001 §3, as amended by ADR-0006 §E | PASS — D-8: `members` gets the *same* `keep_newer`, and no comparator changes on either side. D-18 moves the push path *around* the rule and touches neither `mergeRows` nor `keep_newer` (FR-020) |
| Instance admin is not a workspace permission; no policy reads `instance_admins` | ADR-0006 §C, FR-039 | PASS — D-16; the table has RLS on and no policy, and reviewer duty makes a policy reading it a finding |
| No `service_role` key, platform secret or credential anywhere | ADR-0001 §Git, FR-033, SC-020 | PASS — D-16: provisioning runs as `security definer` under the caller's own anon-key session |
| Every definition in `schema.sql`; migration only for a backfill | ADR-0005 | PASS — D-2, no `migration-007` |
| Federation needs zero schema support; no origin concept in P1 | ADR-0004 (c), FR-027 | PASS — D-1; reviewer duty 4 |
| Backend is the local `supabase` CLI stack; two clients, no browser | ADR-0002, ADR-0003 | PASS — D-13 |
| P-gate: no code on `UNTESTED` substrate | ADR-0002 | PASS — `db-api` debt is this feature's first tasks |
| Personal must not regress | ADR-0001 §6 | PASS — D-4, D-6, D-11 and the unedited P0 suite |
| No feature outside a spec | ADR-0001 §6 | PASS — D-11 lists exactly seven affordances, each traced to a requirement |
| Sign-offs are `(single-operator)` | ADR-0001 §7 | PASS — receipts template in D-15 |

**Post-design re-check**: four items do not come out clean and are carried to Complexity Tracking —
D-9 and D-16 (`db-api` gains operations that cannot be satisfied offline), D-18 (the push loop gains
a second path), and D-13's test-only `adminClient()`. None is an ADR violation; each widens a
documented rule, so each is recorded rather than absorbed.

## Key technical decisions

Phase-0 research is consolidated here rather than in a separate `research.md`, matching the house
style set by `specs/001-validation-spine/plan.md`. `data-model.md` and `contracts/` **are** produced,
because this feature does add entities and does expose eight backend operations to a consumer.
Decisions are numbered in the order they were taken and the numbering is never reused: **D-6 is partly
superseded** (its `kind` pin) and replaced by **D-6′**, **D-7 carries a correction** about what an RLS
refusal actually does, and **D-16..D-18** arrived with ADR-0006 on 2026-09-13.

### D-1 — Schema shape: one added table, two added columns, nothing repurposed

**Decision.** In `supabase/schema.sql`, in a fork-only block placed after upstream's table
definitions and before the policy block:

```sql
alter table public.workspaces
  add column if not exists kind text not null default 'personal';
-- separate, guarded, so re-running is safe and the constraint is nameable
alter table public.workspaces
  drop constraint if exists workspaces_kind_check;
alter table public.workspaces
  add constraint workspaces_kind_check check (kind in ('personal', 'team'));

create table if not exists public.members (
  id            uuid primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,  -- who created the row
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  member_id     uuid not null references auth.users (id) on delete cascade,  -- whose membership it is
  level         text not null default 'member' check (level in ('owner', 'member')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  synced_at     timestamptz not null default now(),
  deleted       boolean not null default false
);
create unique index if not exists members_one_per_person
  on public.members (workspace_id, member_id);

alter table public.tasks
  add column if not exists assignee uuid references auth.users (id) on delete set null;
```

**`member_id` is separate from `user_id`, and that is not redundancy.** The push path stamps
`user_id: userId` onto **every** row it sends (`src/sync/sync.ts:216`). A members table that stored
the member's identity in `user_id` would have it silently rewritten to the pusher's id on the first
sync cycle. `user_id` therefore keeps its upstream meaning exactly — "who created this row", i.e. the
owner who added the member — and `member_id` is the person the row is about. This also keeps
ADR-0001 §2's "no column is repurposed" true for a fork-only table too.

**The unique index is unconditional, not partial on `not deleted`.** Removal is a soft delete (D-7),
and re-adding the same person flips `deleted` back to false on the *same* row — which is exactly what
US2 acceptance 6 asks for ("still exactly one membership row, not two") and what makes
`add_member_by_email` idempotent.

**No `origin` column, no `origin` table, no cross-origin reference** — every uuid above is an id in
*this* origin's `auth.users` (FR-027, ADR-0004 (c), SC-009). Reviewer duty 4 checks this.

**Alternatives rejected.** (a) An enum type for `kind`/`level` — a `check` constraint is what upstream
already uses for `notes.kind` (`schema.sql:85`), and an enum is a harder thing to widen later and a
worse merge object. (b) `members` keyed `primary key (workspace_id, user_id)` with no surrogate `id` —
rejected because the generic sync loop upserts `on_conflict: 'id'` and Dexie's stores are keyed `id`
(`src/db/local.ts:33-37`); a composite key would force a second, special-cased sync path, which is
precisely what D-8 is avoiding. The unique index gives the same guarantee. (c) `assignee` as a FK to
`members.id` — rejected: the spec's own assumption says "`assignee` names a person, not a membership",
and a FK to the membership row would make a re-added person silently reacquire old assignments.

**Serves**: FR-001, FR-002, FR-004, FR-011, FR-016, FR-027, FR-028.

### D-2 — Everything in `schema.sql`; **no `migration-007`**

**Decision.** No numbered migration file is created by this feature.

**Rationale.** ADR-0005: a migration exists only for a one-off edit to rows already in the database.
`kind` arrives with `not null default 'personal'`, which Postgres applies to every existing row at
`add column` time — every pre-existing workspace is personal without a rewrite (US1 acceptance 1,
FR-001). `assignee` arrives nullable and empty (FR-016). `members` starts empty. There is no row to
backfill, so per ADR-0005 "if P1 needs no such edit, no migration file is created at all".
Numbering still starts at 007 whenever the first real backfill appears.

**Consequence for the harness.** `tests/harness/schema.ts`'s `SQL_FILES` list is unchanged — nothing
to add. The ordered apply already re-applies `schema.sql` on every run, which is the automated check
this convention gets (ADR-0002).

**Alternatives rejected.** Putting the fork's DDL in `migration-007` — the pre-ADR-0005 habit; it
would split the definition of a live object across two files and make every upstream merge conflict
twice.

**Serves**: FR-028.

### D-3 — `assignee`: membership enforced by trigger, auto-clear by trigger, never by RLS

**Decision.** Two new triggers on top of D-1's column, and **no** policy predicate mentions
`assignee`:

1. `tasks_zz_assignee_member` — `before insert or update on public.tasks`, `security definer`,
   **coercing, not raising**: when `new.assignee is not null` and `new.assignee` is not a live member
   of `new.workspace_id`, `new.assignee := null` and the trigger returns `new`. Same reasoning D-6
   already gives for `kind` — a raise inside a sync batch wedges the tasks queue for every device
   that queued an assignment to a member who was removed in the meantime (the exact race US5
   describes), and coercion is also the same structural answer as the clear-on-removal trigger below,
   so the two rules agree with each other.
2. `members_zz_clear_assignee` — `after update on public.members`, `security definer`, firing when
   `new.deleted and not old.deleted`, running
   `update public.tasks set assignee = null, updated_at = greatest(updated_at, now())
    where workspace_id = new.workspace_id and assignee = new.member_id`.
   Mirrored on `after delete` for the dashboard path.

**Test obligation.** An assignment to a non-member pushed by a client lands with `assignee = null`,
the row is not refused, and the next pull converges the client.

**Why `greatest(updated_at, now())`.** Copied deliberately from `follow_workspace_delete`
(`schema.sql:158-175`): the clear has to outrank an edit already in flight on the removed member's
device, or that device pushes the assignment back as the newer row. This is what makes US5 acceptance
3 ("still true for a client that was offline while it happened") and SC-006 true.

**Why the `zz` name prefix.** Postgres fires same-timing triggers in **name order**, and
`schema.sql:193-195` says so in as many words: the existing order on a child row is
`keep_newer` → `stay_deleted` → `synced_at`. Any new BEFORE trigger named `tasks_a…` would run before
`keep_newer` and would raise on a stale update that today is *silently dropped* — a change in
observable behaviour and therefore a regression under FR-014. Naming it `tasks_zz_…` puts it last;
`keep_newer` returning null abandons the row before it is ever reached, exactly as today.

**Why a trigger and not RLS.** Putting the membership test in `with check` would make an access
decision read the assignee, which FR-017 forbids and SC-007 counts ("the number of access decisions
that read the assignee is **0**"). A trigger is a data-integrity rule, not an access rule, and the
policy text stays free of the word.

**Why not `on delete set null` alone.** The FK in D-1 (`assignee … on delete set null`) only fires
when the *account* is deleted, not when a membership ends. Soft-deleted membership (D-7) needs the
trigger. Both are kept: the FK for account deletion, the trigger for removal.

**Alternatives rejected.** (a) Clearing from the client on the next sync cycle — forbidden by
ADR-0001 §1 ("enforced structurally … never left to the client") and FR-018. (b) A check constraint —
cannot contain a subquery. (c) Hard-deleting the membership row so the FK fires — see D-7.

**Serves**: FR-016, FR-017, FR-018, SC-006, SC-007.

### D-4 — The replaced predicates, written out

**Decision.** The policy block at the end of `schema.sql` is **replaced wholesale** (it is already a
`drop policy if exists` + `create policy` block, so this is idempotent and is the one sanctioned
replacement surface). Both halves of each `own_rows` policy are written separately, and the
asymmetry is preserved:

```sql
-- workspaces: the READ half widens to membership; the WRITE half deliberately does NOT.
-- A member may not rename or delete the workspace (FR-005), so writes stay the owner's.
create policy own_rows on public.workspaces
  for all
  using       (auth.uid() = user_id or public.is_member(id))
  with check  (auth.uid() = user_id);

-- labels / tasks / notes, for each of the three:
create policy own_rows on public.<t>
  for all
  using (
    auth.uid() = user_id
    or public.is_member(workspace_id)
  )
  with check (
    (
      auth.uid() = user_id
      and exists (select 1 from public.workspaces w
                   where w.id = workspace_id and w.user_id = auth.uid())
    )
    or public.is_member(workspace_id)
  );
```

**The write half's first branch is upstream's clause, character for character.** That is what keeps
the personal path identical: for a personal workspace `is_member()` is false (there are no member
rows), so both halves evaluate exactly as they do today, and P0's `rls-two-accounts.test.ts` passes
unedited. The read half stays looser than the write half on the child tables, as today — B's own row
pointing at a workspace B does not own is still readable (`schema.sql:226-228`, and P0 pins it).

**Members' own policy** — a fork-only table, so a fork-only policy name (`members_access`), which
keeps `own_rows` meaning exactly what upstream means by it and keeps the merge surface honest:

```sql
create policy members_access on public.members
  for all
  using       (public.is_member(workspace_id))
  with check  (public.is_owner(workspace_id) and auth.uid() = user_id);
```

Read: any member of the workspace sees its membership rows (FR-007, FR-015; US2 acceptance 5 — a
non-member gets nothing). Write: only an owner, and only recording themselves as the row's creator
(FR-015, US2 acceptance 3). The creator's own first `owner` row is inserted by a `security definer`
trigger that bypasses RLS (D-6), which is what makes FR-002's "in the same operation" true without a
chicken-and-egg hole in this predicate.

**A fourth new trigger, `<t>_zz_keep_creator`.** `before update on labels/tasks/notes`, setting
`new.user_id := old.user_id`. Without it, a member editing a row another member created would have
their own id stamped over `user_id` by the push path (`sync.ts:216`), and `user_id` would drift from
"who created the row" to "who touched it last" — a direct FR-011 violation, invisible until someone
audits. For a personal row the assignment is a no-op (same value), so nothing personal changes. Named
`zz` for the same ordering reason as D-3.

**Alternatives rejected.** (a) One predicate written once and used for both halves — explicitly a
defect under FR-012 and the most likely quiet failure of this transform (validation map, the
foundations-pass correction). (b) An additive `PERMISSIVE` membership policy alongside `own_rows` —
rejected by ADR-0001 §2: permissive policies only ever OR, so team access would widen without the
workspace-ownership clause ever narrowing, and a `RESTRICTIVE` companion would have to re-encode the
personal case anyway. (c) Letting members write the workspace row (rename/delete) — contradicts
FR-005.

**Serves**: FR-005, FR-006, FR-011, FR-012, FR-013, FR-015, SC-002, SC-005.

### D-5 — `is_member` / `is_owner` as `security definer` helpers, not inline `EXISTS`

**Decision.**

```sql
create or replace function public.is_member(ws uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$ select exists (
  select 1 from public.members m
   where m.workspace_id = ws and m.member_id = auth.uid() and not m.deleted) $$;

create or replace function public.is_owner(ws uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$ select exists (
  select 1 from public.members m
   where m.workspace_id = ws and m.member_id = auth.uid()
     and m.level = 'owner' and not m.deleted) $$;

revoke execute on function public.is_member(uuid), public.is_owner(uuid) from public, anon;
grant  execute on function public.is_member(uuid), public.is_owner(uuid) to authenticated;
```

**Why `security definer` is not optional here.** `members_access` (D-4) is a policy **on `members`**
whose predicate must query `members`. An inline `EXISTS` would re-enter RLS on the same table and
recurse — Postgres reports `infinite recursion detected in policy for relation "members"`, and it is
the single most common way this exact design fails. A `security definer` function runs with the
definer's rights and does not re-enter the policy, which breaks the cycle. Having broken it there,
the same helpers are used on the four data tables for consistency and so there is **one** place where
"who may see this workspace" is written (ARCHITECTURE §2: `membership` is "the one source" of that
answer).

**`set search_path` is a security control, not a style choice.** Without it a `security definer`
function resolves `public.members` through the caller's `search_path`, and a caller who can create a
schema earlier on that path can substitute a table and make the function return `true`. `stable` lets
the planner cache the call per statement, which is also the answer to ADR-0001's "a membership lookup
per row check" cost note.

**`revoke … from anon`** keeps the helpers off the anonymous PostgREST surface. They are still
exposed as RPC to `authenticated`, which is harmless — they answer only about the caller — but the
grant is written explicitly so that the exposure is a decision on the record, not a default.

**Alternatives rejected.** (a) Inline `EXISTS` everywhere — recursion on `members`, and four copies
of the rule to keep in step. (b) Helpers in a private schema — `schema.sql` touches only `public`
today; a new schema is a larger divergence than the grants it saves, and PostgREST exposure is
already handled by the revoke. (c) `security invoker` + a `RESTRICTIVE` bypass policy on `members` —
more moving parts to express the same thing.

**Serves**: FR-011, FR-012, FR-015; and Risk R-1 below.

### D-6 — The creator becomes owner by trigger, not by RPC ~~; `kind` is pinned by trigger~~

> **Partly SUPERSEDED (2026-09-13, ADR-0006 §D).** The `seed_workspace_owner` half below stands
> unchanged and is still how a team workspace gets its first owner row. The `kind` pin —
> `workspaces_zz_kind_fixed` and the "silent pin over raise" reasoning — is **withdrawn**: kind is
> mutable by the owner. Read **D-6′** instead. No `pin_workspace_kind` function and no
> `workspaces_zz_kind_fixed` trigger is written.

**Decision.**

```sql
create or replace function public.seed_workspace_owner() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.kind = 'team' then
    insert into public.members (id, user_id, workspace_id, member_id, level)
    values (gen_random_uuid(), new.user_id, new.id, new.user_id, 'owner')
    on conflict (workspace_id, member_id) do nothing;
  end if;
  return null;
end $$;

drop trigger if exists workspaces_seed_owner on public.workspaces;
create trigger workspaces_seed_owner after insert on public.workspaces
  for each row execute function public.seed_workspace_owner();
```

**Trigger over RPC, for the owner row.** FR-002 says the creator is recorded "in the same
operation" and a team workspace "MUST NOT be able to exist with no owner". A trigger is the only form
of that statement which holds for *every* path into the table — the app's own push, a workspace
created offline and synced later, the CLI in P3, the SQL editor. An RPC holds only for the one caller
that remembers to use it, and would additionally force `createWorkspace` in `src/db/api.ts` to become
online-only, which would break offline workspace creation for personal workspaces too — a personal
regression. `security definer` is required because the inserting user is not yet an owner, so
`members_access`'s `with check` would refuse them; `on conflict do nothing` makes a re-push a no-op.

~~**Silent pin over raise, for `kind` immutability.**~~ Withdrawn — see D-6′. What survives from that
paragraph is its *reason*: a raise inside a sync batch aborts the whole batch, so nothing on the
synced-row path may raise. D-6′ obeys it by making the flip an ordinary column write with an
`after update` consequence trigger, which cannot abort anything. The *third value* case (US1
acceptance 4) is unchanged and still **does** raise: `workspaces_kind_check` refuses it at the
constraint, which is "the backend, not the interface".

**The owner's own membership row reaches the creating device by pull, not by local write.**
`createWorkspace` in `src/db/api.ts` does **not** write a local `members` row for the owner — it
cannot: `seed_workspace_owner` mints its own `id` server-side, and the local device does not know that
id in advance. Writing one locally anyway would not merely be redundant, it would be *wrong*: the
locally-written row would carry a different `id` but the same `(workspace_id, member_id)`, so the
generic push would hit `members_one_per_person`'s unique index on conflict — a conflict on the
**unique index**, not on `id` — and be refused, wedging the members queue exactly as R-14 describes.
So `createWorkspace` writes only the workspace row; the owner's own membership row is a server-side
side effect that reaches the creating device on its **next pull**, `members` being a synced table like
any other (D-8). The member list is therefore correct after the first sync cycle, not immediately —
recorded here so D-11's affordance 2 is not read as "the owner sees themself in the list before the
first pull".

**Serves**: FR-002, FR-010 (an owner row that can only be created, never written away, plus
`members_access`'s owner-only write half, makes "always at least one owner" structurally true).

### D-6′ — `kind` is mutable by the owner; one `after update` trigger draws the consequences

*Replaces the withdrawn half of D-6. Source: ADR-0006 §D, FR-001, FR-034..FR-036, US8, SC-019.*

**Decision.** Switching a workspace between `personal` and `team` is an **ordinary update of an
ordinary synced column** — no RPC, no special path, no new policy predicate. One trigger draws the
consequences:

```sql
create or replace function public.on_workspace_kind_change() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $fn$
begin
  if new.kind = 'personal' then
    update public.members
       set deleted = true, updated_at = greatest(updated_at, now())
     where workspace_id = new.id and not deleted;
  else
    insert into public.members (id, user_id, workspace_id, member_id, level)
    values (gen_random_uuid(), new.user_id, new.id, new.user_id, 'owner')
    on conflict (workspace_id, member_id) do update
       set deleted = false, level = 'owner',
           updated_at = greatest(public.members.updated_at, now());
  end if;
  return null;
end $fn$;

drop trigger if exists workspaces_zz_kind_change on public.workspaces;
create trigger workspaces_zz_kind_change after update on public.workspaces
  for each row when (new.kind is distinct from old.kind)
  execute function public.on_workspace_kind_change();
```

`seed_workspace_owner` (after **insert**) stays exactly as D-6 wrote it and keeps owning creation.
Two triggers, two events, no overlap.

**Why no new authorization.** The `workspaces_access` write half is *already* owner-only (D-4), and
`kind` is a column of `workspaces`. "Only the owner may switch the kind" is therefore true before
anything is written — a member's flip is refused by the existing policy with `42501`, which is
FR-034 and US8 acceptance 6 with no new code. A new predicate here would be a second place to get
the same rule wrong.

**Why AFTER, and why the `when` clause.** `keep_newer` is BEFORE UPDATE and returns null for a stale
row, which cancels the update entirely — so an AFTER trigger never fires for a write LWW abandoned.
A stale kind flip pushed by a device that was offline through the switch cannot therefore purge a
membership list that has since been rebuilt (R-19). The `when (new.kind is distinct from old.kind)`
guard means an ordinary rename never pays for this at all.

**Why `greatest(updated_at, now())`.** Same reason as `follow_workspace_delete` and
`members_zz_clear_assignee`: the consequence must outrank an edit already queued on some member's
device, or that device pushes its membership back. `keep_newer` accepts *equal* stamps
(`schema.sql:142-153` compares `<`), so `greatest` never abandons its own write.

**Why per-row, not one bulk statement with a shared timestamp.** The `update ... where workspace_id`
is a single statement but a **row-level** trigger fires for each row it touches, which is what runs
`members_zz_clear_assignee` once per departing member and clears each of their assignees (FR-035).
A `truncate`-style or `delete`-based purge would skip that path and leave dangling assignees.

**Why members are not restored on the way back.** personal → team upserts exactly one row, the
owner's. Restoring the old roster would silently re-grant access to people the owner may have
switched away *to remove* — a privilege decision taken by a trigger. The owner re-adds whoever should
be there (ADR-0006 §D). Round-tripping therefore ends with exactly one owner row, which is SC-019's
measurement.

**LWW is untouched.** `kind` is in `SYNCED_COLUMNS` for `workspaces` and rides `keep_newer` /
`mergeRows` like `name` does. Two devices flipping kind in opposite directions is resolved by the
newer stamp, with no special case anywhere (FR-020).

**Serves**: FR-001, FR-034, FR-035, FR-036, US8, SC-019.

### D-7 — Removal is a **soft** delete, and that is what reconciles it with LWW

**Decision.** Removing a member sets `members.deleted = true` with a fresh `updated_at`. It is never
a hard `delete`. The RLS helpers (D-5) read `and not m.deleted`, so access ends the moment the row is
written — FR-009's "immediately" is satisfied by the predicate, not by the row's absence.

**Rationale.** A hard delete never reaches an offline device: the row simply stops being returned by
the pull, and pull is a `synced_at > cursor` scan, not a diff — the removed member's Dexie cache would
keep the membership row forever. That is precisely the reason upstream soft-deletes everything
(`src/db/types.ts:26-32`, `schema.sql` header). Soft delete also means the removal is an ordinary
LWW-governed row like every other, decided by the same `keep_newer` at the server and the same
`mergeRows` at the client — one rule, two enforcement points, unchanged (FR-020).

**The reconciliation FR-009 demands.** "Access ends immediately" and "the row still exists" are not in
tension because the *predicate* is what grants access, and the predicate reads `deleted`. The removed
member's next pull brings the tombstone down and the workspace leaves their list; their queued writes
to that workspace are refused by RLS at the server (edge case 1, US6 acceptance 6).

**Correction (2026-09-13, ADR-0006 §E).** The sentence above originally read that those queued writes
take "the already-pinned refused-row path (`sync.ts:257-272`)" — the path where PostgREST accepts the
batch and silently returns fewer ids than were sent. **That is not what happens.** An RLS refusal on a
write is not a silent drop: PostgREST raises SQLSTATE **`42501` for the whole upsert batch**, the
`const { data, error } = ...; if (error) throw error` at `sync.ts:223-227` throws, and the per-table
catch at `sync.ts:274-277` marks the push failed **without clearing a single row's `_dirty` flag**.
(Line cite corrected 2026-09-14: the upsert-and-throw is `sync.ts:223-227`, with the `throw` itself at
`:227`; the correction above originally said `:249-252`, which is the closing brace of the
`db.transaction` bookkeeping block at `:241-249`. Found by the T035 closer. `:257-272` and `:274-277`
were and remain accurate.) One
refused row therefore keeps that entire table's queue re-sending the same batch every cycle, forever —
the exact wedge the silent-drop path exists to avoid, arrived at by a different route. The refused-id
bookkeeping at `sync.ts:257-272` is real and still needed, but it handles the *other* case (a row the
server accepted the batch for and did not return), not this one. The fix is **D-18**; this decision's
soft-delete reasoning is unaffected by it.

**Alternatives rejected.** (a) Hard delete + FK `on delete set null` for the assignee — simpler SQL,
but leaves the removed member's cache holding a stale membership row indefinitely and breaks US6
acceptance 3. (b) Soft delete without `not deleted` in the helpers — would leave a removed member with
full access, i.e. the worst failure this codebase can produce.

**Serves**: FR-009, FR-019, FR-020, US6 acceptance 6, edge case 1.

### D-8 — `members` is the fifth synced table, carried by the generic loop

**Decision.** `members` joins `SYNCED_TABLES` as `['workspaces', 'members', 'labels', 'notes',
'tasks']` — after `workspaces` (it FKs one) and before the rest. It gets a `SYNCED_COLUMNS` entry, a
`Member` row type, a Dexie store, and — in a **fork-only** guarded block, not by editing upstream's
four-element `foreach` arrays — the same `members_synced_at` and `members_keep_newer` triggers and a
`(member_id, synced_at)` index.

**Rationale, against FR-019/FR-020/FR-021.** FR-019 is explicit: membership and assignee information
"MUST reach the local cache and the sync engine **through the same path as other synced data**, so
that a client which was offline learns of a membership change on its next cycle". A live RPC read
cannot satisfy that sentence — it is not a path the cache sits on, and it does not work offline.
Carrying `members` on the generic loop also means the LWW rule applies to it with **no new code at
either enforcement point**, which is the cheapest possible way to keep the lockstep invariant true
(FR-020): the client comparators are table-agnostic (`sync.ts:131-141` reads `SYNCED_COLUMNS[table]`),
and the server trigger is the same `keep_newer()` function. And it means the P0 harness covers the new
table for free — `driveSyncCycle`, the cursor logic, the paging, the refused-row path all iterate
`SYNCED_TABLES`.

**What crosses the wire.** `id, workspace_id, member_id, level, created_at, updated_at, deleted`.
`user_id` and `synced_at` are stripped on pull and re-stamped on push exactly as for every other table
(`sync.ts:216`, `sync.ts:418`) — which is why `member_id` had to exist (D-1).

**The one asymmetry to accept.** A *member* pulls members rows but may not push them
(`members_access`'s owner-only `with check`). That is correct and needs no special-casing: a member
never writes one locally, so nothing of theirs is ever dirty in that table. If something ever is, the
existing refused-row path handles it like any other refusal.

**Verification obligation.** Adding a fifth table to `SYNCED_TABLES` touches a constant that several
P0 tests import. Confirming that **every P0 check still passes unedited** with the fifth table present
is an explicit task, not an assumption (FR-030, SC-003). If one must change, that is a FINDING for the
owner, not an edit (spec, *Personal must not regress*, last bullet).

**Alternatives rejected.** (a) Members read live over PostgREST/RPC and cached separately in Dexie —
fails FR-019's "same path", needs a second bespoke cursor/merge path, and would need its own answer to
"what does LWW mean here". (b) Members not cached at all — the member list and the workspace list both
break offline, and demo steps 5–7 stop working.

**Serves**: FR-019, FR-020, FR-030.

### D-9 — Add-by-email and email display: two `security definer` RPCs, reached *through* `db-api`

**Decision.** Two functions, both `security definer`, both `revoke execute from public, anon` /
`grant execute to authenticated`, both `set search_path = public, auth, pg_temp`:

- `public.add_member_by_email(ws uuid, email text) returns public.members` — refuses with
  `sqlstate 'DA001'` unless `public.is_owner(ws)`; looks the email up in `auth.users`
  (case-insensitively, trimmed); raises **`sqlstate 'DA404'`, message
  `no account with this email on this origin`** when there is none; otherwise upserts the membership
  row `on conflict (workspace_id, member_id) do update set deleted = false, updated_at = now()` and
  returns it. Adding the owner's own email returns the existing `owner` row untouched — never a
  second row, never a demotion (edge case 5).
- `public.workspace_member_emails(ws uuid) returns table (member_id uuid, email text, level text)` —
  returns **zero rows** unless `public.is_member(ws)`, then joins `members` to `auth.users`.

**Error shape.** A distinct `SQLSTATE`, not a message match. PostgREST surfaces it as `error.code`, so
the client distinguishes "no such account on this origin" from every other failure by a stable code and
renders its own translated string from `src/i18n/dict.ts` — which is what FR-008's "distinguishable
from every other failure" and SC-010's "a message naming that exact cause" need, without shipping an
English server string into a Russian interface. `DA001` = not the owner; `DA404` = no such account.
**No row of any kind is created on the failure path** (SC-010) — the lookup precedes the insert and the
function is a single statement-level transaction.

**Why no `profiles` table.** A `profiles` mirror would be additive and therefore legal under
ADR-0001 §2 — and the spec forbids it anyway (Q1, FR-007: "no second copy of the email MUST be
stored"), because a copy drifts the moment an account changes its email and nothing keeps it honest.
A `security definer` function reading `auth.users` at call time cannot drift, and it never makes the
account table readable — the function returns only the co-members' rows and nothing else about them.

**Layering (FR-026 vs ARCHITECTURE §2).** The UI must reach data only through `src/db/api.ts`
(FR-026), and `db-api` "never touches the network" (ARCHITECTURE §2 layering). An email→uuid lookup is
inherently online. Resolution: `src/db/api.ts` exports `addMemberByEmail`, `removeMember`,
`listMembers`, `memberEmails`; the two that need the network delegate to thin online-only functions
exported from `src/sync/sync.ts` (the only module that holds the Supabase client), then write the
returned row into Dexie. `removeMember` and `listMembers` need no network at all — removal is an
ordinary soft-delete write plus `queue()`, exactly like `deleteTask`, and the list is a Dexie read.
Both layering rules survive; the rule that bends is "every `db-api` mutator is offline-capable", which
was never written down but is true today. **Recorded in Complexity Tracking.**

**Serves**: FR-007, FR-008, FR-024, FR-026, SC-010; edge cases 4 and 5.

### D-10 — `kind`, `assignee` on the wire; Dexie 2 → 3, additive only; the cache is **not** reworked

**Decision.**

- `SYNCED_COLUMNS.workspaces` gains `kind: true`; `SYNCED_COLUMNS.tasks` gains `assignee: true`; a
  `members` entry is added. `Workspace` gains `kind: WorkspaceKind`; `Task` gains
  `assignee: ID | null`. The `satisfies ColumnsOf<…>` check at `src/db/types.ts:214` turns any
  omission into a compile error, which is the intended guard.
- `src/db/local.ts` adds `this.version(3).stores({ members: 'id, workspace_id, _dirty' })` with an
  `upgrade` that backfills `w.kind ??= 'personal'` and `t.assignee ??= null` — the identical pattern to
  the v2 calendar backfill (`local.ts:47-62`). **Stores and indexes are only added**; none is changed
  or dropped, so Dexie performs no table rebuild and no cached row is lost.
- **`claimCache` and `wipeLocal` are not rewritten.** Their signatures, their `meta` key (`owner`),
  its value format (the bare user id) and their semantics are unchanged.

**Why the cache rework shrinks to nothing.** ADR-0001's Consequences called the multi-account rework
"unavoidable in P1". The spec, written later and more precisely, asks for the opposite: FR-021 ("wiped
on account mismatch and on **nothing else** … reaching a newly-shared workspace MUST NOT trigger a
wipe"), SC-012 ("**0** times when the same account signs in again, including when that account's reach
has grown"), and *Personal must not regress* → Cache. Team mode changes what one account can reach, not
how many accounts a device holds (ARCHITECTURE §3, "Ownership (fork target)", final paragraph). The
honest P1 deliverable for `multi-account-cache` is therefore **confirmed-unchanged semantics**, an
additive Dexie version, and the naming discipline of FR-022 — which FR-022 itself says is "verified by
reviewer reading, not by a runtime check".

**Why the key is not renamed.** The tempting move — rename `meta.owner` to something composable like
`cache-identity` — is a *defect*. `claimCache` adopts a cache whose owner key is absent rather than
wiping it (`local.ts:96-100`, and the comment explaining why). Renaming the key would make every
existing cache look ownerless on first launch after the upgrade, so the **next** account switch would
silently skip its wipe. FR-022 is satisfied without renaming: the account id stays the whole value, so
ADR-0004's `(origin, account)` key is formed by adding the origin half beside it — a widening, not a
re-derivation. It would be falsified only if P1 encoded something *else* into that value, which it
does not. `claimCache(userId: string)` keeps its signature, which is also why P0's
`tests/local/claim-cache.test.ts` passes unedited.

**What proves "no wipe when reach grows".** A new Docker-free test,
`tests/local/no-wipe-on-reach-growth.test.ts`: claim as A, seed rows in A's own workspace **and** a
team workspace A newly reaches, write a pull cursor into `meta`, claim as A again, then assert every
row and every cursor is still there and `meta.owner` is unchanged; then claim as B and assert the wipe
does fire and the cursors are gone. One file covering both halves of SC-012.

**Serves**: FR-019, FR-021, FR-022, SC-012.

### D-11 — Exactly seven interface affordances, each mapped to a `db-api` function

**Decision.** Seven, and nothing else (FR-024, SC-008, SC-018):

| # | Affordance | Component | `src/db/api.ts` | i18n keys (ru + en) |
|---|---|---|---|---|
| 1 | Choose **team** when creating a workspace | `src/components/Header.tsx` → `WorkspaceMenu`'s existing `AskName` flow gains one kind toggle | `createWorkspace(name, kind = 'personal')` — defaulted, so every existing call site is unchanged; it writes **only** the workspace row — the owner's own `members` row is `seed_workspace_owner`'s server-side effect and reaches this device on its next pull (D-6), not written locally, which would conflict on `members_one_per_person` and wedge the queue (R-14) | `workspace.kindPersonal`, `workspace.kindTeam` |
| 2 | See the member list | `src/components/Settings.tsx`, a new `members` section, rendered **only** when `workspace.kind === 'team'` | `listMembers(ws)`, `memberEmails(ws)` | `members.section`, `members.owner`, `members.member` |
| 3 | Add a member by email (owner only) | same section | `addMemberByEmail(ws, email)` | `members.add`, `members.emailPlaceholder`, `members.noAccountHere` |
| 4 | Remove a member (owner only) | same section, reusing the existing `Confirm` component | `removeMember(ws, memberId)` | `members.remove`, `members.confirmRemove` |
| 5 | Set/clear a task's assignee, and see it on the task | `src/components/TaskDialog.tsx`, one new `<Field>` beside the existing ones, rendered **only** in a team workspace; the value shown on the card | `updateTask(id, { assignee })` — `TaskPatch` widens by one key | `task.assignee`, `task.unassigned` |
| 6 | **Switch the workspace's kind**, either direction, **owner only** | `src/components/Settings.tsx`, the existing `workspace` section, beside rename — a two-value control, not a destructive-looking button; guarded by the same `Confirm` the delete uses, because switching to personal ends everyone else's access (FR-034) | `updateWorkspace(id, { kind })` — an ordinary patch, offline-capable, no RPC (D-6′) | `workspace.kindSwitch`, `workspace.confirmToPersonal`, `workspace.confirmToTeam` |
| 7 | **Logins** — list, create, set password, remove, grant/revoke admin, **admin only** | `src/components/Settings.tsx`, a new `logins` section appended to `SECTIONS`, filtered out entirely unless the cached admin flag is true (D-17); reuses `Confirm` for remove and for revoking admin | `listLogins()`, `createLogin(email, password, admin)`, `setLoginPassword(id, password)`, `deleteLogin(id)`, `setLoginAdmin(id, admin)` | `logins.section`, `logins.create`, `logins.emailPlaceholder`, `logins.passwordPlaceholder`, `logins.setPassword`, `logins.remove`, `logins.confirmRemove`, `logins.admin`, `logins.grantAdmin`, `logins.revokeAdmin`, `logins.errBadEmail`, `logins.errShortPassword`, `logins.errDuplicate`, `logins.errOwnsTeamWorkspace`, `logins.errLastAdmin`, `logins.errSelf` |

**Passwords in affordance 7 (FR-044, non-negotiable).** Both password inputs are
`<input type="password">`. The value lives in component state until the call returns and is then
dropped: it is **never** written to Dexie, never put in a query string, never passed to `console.*`,
and never included in an error report. There is no "reveal" toggle and no list of passwords, because
only hashes exist server-side. An error from the RPC is rendered from `error.code` through the
`logins.err*` keys above — the server's English message is never shown raw, and the code is never
matched on message text (same discipline as `members.noAccountHere`).

**Admin-only rendering is a convenience, not the control (SC-018).** The `logins` section is hidden
from a non-admin, but every routine behind it refuses a non-admin caller in the database (D-16). The
hidden UI is what makes the app pleasant; the `DA001` is what makes it safe.

**Note.** In the same Settings workspace section, the existing rename field (`Settings.tsx:153-155`),
the existing delete-workspace button and affordance 6's kind switch are all **hidden** for a
non-owner of a team workspace (R-11). Hiding an existing control for a non-owner is a guard required
by FR-005, not a new affordance — it is not an eighth row above. No i18n keys are needed for hiding
a control.

**Placement rationale.** Settings already owns the per-workspace administrative section
(`SECTIONS = ['theme','language','workspace','gcal','account']`, `Settings.tsx:22`) and already has
rename/delete-workspace in it — the member list belongs beside them, and a sixth section keyed
`members` is the smallest possible addition. The task card already renders optional rows conditionally
(`GcalRow`), so the assignee field costs no restructuring. The `logins` section is a **seventh**
section key, appended to the same array and filtered in `sections` (`Settings.tsx:50`) exactly as
`workspace` already is.

**Every new element is behind a guard**: affordances 2–6 behind `kind === 'team'` (and 3, 4, 6
additionally behind owner), affordance 7 behind the admin flag. That is the mechanical form of
SC-008 and SC-018: a person who owns only personal workspaces and is not an admin sees **zero** new
controls. The one exception is affordance 1's kind toggle at creation, which is the door into the
feature and is visible to everyone by design (FR-001).

**i18n.** Every key above lands in `src/i18n/dict.ts` with **both** `ru` and `en` — the dictionary type
makes a missing language a compile error (`dict.ts:5-8`), so this is enforced, not remembered. No
existing string is reworded (CLAUDE.md, `designer` role rule, applied here too).

**Not touched**: `src/views/` at all — Board, Timeline and Notes are unchanged (FR-025). Proven by
reviewer diff control plus a `git diff --stat` receipt showing zero lines changed under `src/views/`.

**Serves**: FR-024, FR-025, FR-026, SC-008.

### D-12 — F-5 (sign-out ordering): **re-record** as an accepted risk with an expiry — owner's word required

**Decision (recommended, not settleable by an agent).** Take option (b) of the spec's F-5 clause:
re-record on the `supabase-auth` map entry as
`accepted-risk: "sign-out ordering uncovered; browser-bound. Owner: Andrii Tkhorenko, 2026-09-13,
expires end of P2 (Playwright arrives, ADR-0003)"`.

**Why (b) over (a).** The spec's own framing for taking (a) is that "this feature changes the last
step of that order (the wipe)". **D-10 does not change it.** `signOut()` keeps
`forgetSession()` → `supabase.auth.signOut()` → `wipeLocal()` (`useSession.ts:112-118`) verbatim, and
`Settings.leave()` keeps `holdGcal()` → `flushQueue()` → confirm-if-unsent → `signOut()`
(`Settings.tsx:208-224`) verbatim. `wipeLocal()` itself is unchanged (D-10). So the premise that made
coverage urgent has evaporated; what remains uncovered is exactly what P0 left uncovered, no more. The
genuinely browser-bound part — that the four steps happen *in that order, from a click* — needs
Playwright, which has a phase (ADR-0003, P2).

**What P1 does NOT change, stated so the reviewer can check it mechanically**: no line of
`src/auth/useSession.ts` and no line of `Settings.tsx`'s `AccountSection` sign-out path is in this
feature's diff. FR-023 ("the first three steps MUST NOT be reordered") is satisfied by the file not
being touched at all.

**Owner gate.** The spec says option (b) "needs the owner's word (CLAUDE.md, agent roles)". This plan
recommends it and cannot adopt it. **See Owner questions, Q-B.**

**Serves**: FR-023, FR-032, SC-011.

### D-13 — Evidence: ten new test files, four harness additions, zero P0 edits

**Decision.**

```text
tests/stack/
  members-two-accounts.test.ts      # US2 — add by email, list, remove, re-add idempotence,
                                    #       member-cannot-administer, non-member sees nothing,
                                    #       DA404 shape + zero rows created  (FR-004..010, SC-010)
  team-rls-both-halves.test.ts      # US3 — the eight predicate halves, each direction;
                                    #       plus the executed inversion demo (below)  (FR-012/013, SC-005)
  assignee-clear-on-removal.test.ts # US5 — set, read from the other account, remove, observe null;
                                    #       non-member assignment coerced to null, not refused;
                                    #       access outcomes identical with/without an assignee  (SC-006/007)
  member-offline-round-trip.test.ts # US6 — B offline edits a team task; reconnects; A sees it;
                                    #       two-member LWW at both points; removal-while-offline
                                    #       refusal does not stall other tables  (FR-019/020)
  team-triggers.test.ts             # FR-014 — keep_newer, stay_deleted_with_workspace,
                                    #       follow_workspace_delete each demonstrated firing on a
                                    #       personal workspace AND on a team one
  personal-unchanged.test.ts        # US4 — smoke: a personal workspace's read/write outcomes for
                                    #       owner and stranger, and the delete cascade, after the swap
  logins-provisioning.test.ts       # US7 — all ten acceptances, and the R-15 canary: create a login
                                    #       through create_login, SIGN IN with those minted
                                    #       credentials through supabase-js, set a new password, sign
                                    #       in again, old password refused, remove it, sign-in
                                    #       refused; plus DA001/DA010/DA011/DA012/DA013/DA014/DA015,
                                    #       first-login-is-admin, and a non-admin refused on all five
                                    #       routines  (FR-037..046, SC-015/016/018/021)
  kind-switch.test.ts               # US8 — team->personal purges every membership and clears each
                                    #       departing member's assignees; personal->team seeds exactly
                                    #       one owner row and un-deletes rather than duplicating; a
                                    #       member's switch attempt refused; round trip ends with
                                    #       exactly 1 owner row  (FR-034..036, SC-019)
  push-refusal-fallback.test.ts     # D-18 — a removed member's queued edit provokes a real 42501;
                                    #       assert every other table's dirty count reaches 0 within
                                    #       ONE push cycle, and that the refused row is not re-sent
                                    #       on the next  (FR-041, US6 acceptance 6, SC-017)
tests/local/
  db-api-p1-surface.test.ts         # the db-api debt row — written FIRST, against today's behaviour
  no-wipe-on-reach-growth.test.ts   # SC-012, both halves  (D-10)
```

**Harness additions** (`tests/harness/accounts.ts` gains helpers; no existing export changes
signature, because P0 files import them):
- `createTestUsers(n, label)` — a third account is needed for "knows the id, is not a member"
  (US3 acceptance 4) and for "same person in several team workspaces" (edge case 9).
- `asUser(testUser)` — memoized `clientFor`, so a file that switches between A, B and C repeatedly
  does not re-authenticate on every assertion.
- `seedTeamWorkspace(owner, members[])` in `tests/harness/seed.ts` — creates a team workspace through
  the same `src/db/api.ts` path `seedWorkspaceWithTask` uses, then adds members via the RPC, so the
  seed exercises the real creation path rather than inserting rows behind it.
- **`adminClient(testUser)`** — the deterministic admin, and the one **test-only** privilege in the
  suite. `tests/harness/accounts.ts` provisions its users through
  `auth.admin.createUser` with the local stack's `SERVICE_ROLE_KEY`, so "the first account created is
  the admin" (FR-037) lands on whichever account a given file happened to create first, and on a
  re-run of a dirty database on none at all. `adminClient` therefore **inserts a row into
  `public.instance_admins` over the direct `pg` connection** the harness already opens, then returns
  the ordinary anon-key client for that user. It never touches `service_role` from application code,
  it is imported by no `src/` file, and it exists only because the trigger it substitutes for is
  itself asserted separately, on a database with an empty `instance_admins`, inside
  `logins-provisioning.test.ts`. Documented as test-only at its definition, and a reviewer finding if
  it ever appears outside `tests/`.

**R-2 and R-3, extended.** The `pg_proc` check (R-2) now covers all eight functions plus
`seed_first_admin` and `on_workspace_kind_change`: every one must report `prosecdef = true` and a
non-empty `proconfig` carrying `search_path`. The anon-refusal check (R-3) likewise now calls **all**
of them with the anon key and asserts each is refused — an unauthenticated `create_login` reaching
the database would be an open account factory.

**The executed inversion demo (FR-013, SC-005) — this time actually executed.** P0's T018 recorded a
deviation: the live single-sided swap was refused by the session's tool-safety layer because it meant
a security-policy change against a live database. This plan removes that objection by making the swap
**never leave a transaction**:

```
begin;
  drop policy own_rows on public.tasks;
  create policy own_rows on public.tasks for all
    using (<inverted half>) with check (<the other half, unchanged>);
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"<B''s uuid>"}';   -- auth.uid() reads this
  <assert the outcome flips>
rollback;
```

One `pg` connection, one transaction, DDL rolled back — Postgres DDL is transactional, so nothing is
ever committed, no other connection can observe it, and a crashed test leaves the database untouched.
`auth.uid()` resolves from `request.jwt.claims`, so the assertion is made against the real predicate
with a real caller identity rather than against a mirror of it. Run once per direction per half,
for a personal workspace and for a team workspace (SC-005).

**Fallback, named in advance and never silent**: if the environment still refuses to execute the
block, the P0 fallback applies verbatim (FR-013) — the shadow-predicate mutation technique that
`tests/stack/lww-conflict.test.ts` already uses, plus the reproduction steps in the test's header and
a hand-trace in `receipts.md`, explicitly labelled as a deviation.

**Every P0 file is unedited.** The diff must show zero changes under `tests/stack/*.test.ts` and
`tests/local/claim-cache.test.ts` as they exist at `f498c24`. Harness files may gain exports; they may
not change one.

**Serves**: FR-013, FR-014, FR-029, FR-030, SC-002, SC-003, SC-005, SC-014.

### D-14 — The hosted demo runbook is owner-run, manual, and outside the suite

**Decision.** The **eighteen-step** walk (spec, *First demo*) is performed by the owner on the
existing hosted deployment, after the unattended suite is green, following a runbook recorded in
`specs/002-team-workspaces/receipts.md`:

1. Re-run the whole of `supabase/schema.sql` in the hosted project's SQL editor (it is idempotent;
   this is upstream's own convention, ADR-0005). Expect no error and no row change. This is what
   installs `instance_admins`, `is_admin()`, `users_seed_first_admin` and the five provisioning
   routines on the hosted origin.
2. **Confirm the hosted project already has the owner's own account, and that it is an instance
   admin.** The account predates this change, so `users_seed_first_admin` never fired for it: run
   `insert into public.instance_admins (user_id, granted_by) select id, null from auth.users
   where email = '<owner>' on conflict do nothing;` once, in the SQL editor. This is a **one-time
   backfill on an existing origin**, not a step a fresh instance needs — on a fresh origin the
   trigger does it, which is exactly what `logins-provisioning.test.ts` asserts. It is also the
   **only** manual database intervention SC-001 permits, and it replaces the old step 2 (creating
   account B by hand): account B is now minted **in the app**, which is the point of the demo.
3. **Order matters: the admin must exist before the door closes.** Only after step 2 reports one row,
   turn **off** public sign-up in the dashboard — Authentication → Providers → Email →
   *Allow new users to sign up* → off (FR-046, ADR-0006 §F). Doing this before step 2 would leave an
   origin with no admin and no way to make one without the dashboard. The local
   `supabase/config.toml` keeps `enable_signup = true` and is **not** edited: the P0 harness
   provisions through GoTrue and must keep passing unedited (FR-030). The two configurations differ
   on purpose.
4. `npm run build` and `npx wrangler deploy`, with the **same** `VITE_SUPABASE_URL` /
   `VITE_SUPABASE_ANON_KEY` values already in use. They are supplied from the operator's environment,
   never from a file in the repository (FR-033, SC-013). There is no new variable: provisioning uses
   the caller's own session, and **no `service_role` key is added to any environment** (SC-020).
5. Walk steps 1–18 on two browsers or two devices, A and B, recording pass/fail per step. Step 1 is
   A minting B's login in the Logins section and reading the credential out to hand over; the walk
   only reaches B's device once that has happened.
6. Verify the closed door from the outside: attempt a sign-up against the hosted origin and record
   the refusal (FR-046).
7. Capture `git diff --stat` for FR-025's zero-change-under-`src/views` claim.

**Receipts go in `specs/002-team-workspaces/receipts.md`**, in the shape P0 established: full-suite
receipt, CI receipt, the walk with a line per step, FINDINGS with dispositions, and
`Sign-off: Andrii Tkhorenko (single-operator)`.

**No key, token or hosted URL enters the repository at any point** (FR-033) — and that now explicitly
includes **the password minted in walk step 1**: the receipt records that a login was created and that
it signed in, never the credential itself (FR-044, SC-020). Nothing in the automated suite touches a
hosted project (SC-013); the hosted walk touches no automated suite.

**Serves**: SC-001, SC-013, SC-020, FR-025, FR-033, FR-044, FR-046.

### D-15 — Map entries and receipts land in the same change as the behaviour

**Decision.** `docs/validation-map.md` gains `membership`, `team-rls`, `multi-account-cache` and
**`account-provisioning`** as HIGH entries with the tiers, `paths` and `depends-on` that
ARCHITECTURE §2 (plus ADR-0006 Consequences for the fourth) assigns them; the `supabase-schema` and
`local-cache` entries gain the new paths and are re-verified; **`sync-engine` is re-verified and
re-signed because D-18 changes its code**, with `push-refusal-fallback.test.ts` added to its `tests:`
list; `db-api` flips on its own new tests. Each flip to `VALIDATED` carries the command, the
revision, the date and `Andrii Tkhorenko (single-operator)` — in the **same** PR as the behaviour
(FR-031). A component whose `paths` change without its map entry changing is a reviewer FINDING
(CLAUDE.md, reviewer duty 5).

`account-provisioning`'s entry, written out so the task that adds it has nothing to invent:

```yaml
account-provisioning:
  tier: HIGH
  status: UNTESTED
  paths:
    - supabase/schema.sql          # fork blocks D and E
    - src/db/api.ts                # isAdmin/createLogin/setLoginPassword/deleteLogin/setLoginAdmin/listLogins
    - src/sync/sync.ts             # the *Remote wrappers
    - src/components/Settings.tsx  # the logins section
  depends-on: [supabase-auth, supabase-schema, db-api]
  verify: "npm test -- --run --project stack tests/stack/logins-provisioning.test.ts"
  tests: [tests/stack/logins-provisioning.test.ts]
  last-verified: <sha> <date>
  sign-off: Andrii Tkhorenko (single-operator)
```

### D-16 — Provisioning is five `security definer` routines plus an admin table, and no key at all

*Source: ADR-0006 §B/§C/§F, FR-037..FR-046, US7.*

**Decision.** The instance's front door lives in Postgres, in `supabase/schema.sql`, as two fork
blocks:

- **Block D — the flag.** `public.instance_admins(user_id uuid primary key references auth.users(id)
  on delete cascade, granted_by uuid references auth.users(id) on delete set null, created_at
  timestamptz not null default now())`, with **RLS enabled and no policy at all**; `public.is_admin()`
  (`language sql stable security definer set search_path = public, pg_temp`) as the only way the flag
  is readable; and `users_seed_first_admin`, an `after insert on auth.users` trigger that inserts into
  `instance_admins` **only while that table is empty** — the first account on an origin is an admin
  structurally, so an instance is never adminless and no runbook step has to remember (FR-037).
- **Block E — the routines.** `create_login`, `set_login_password`, `delete_login`,
  `set_login_admin`, `list_logins`. Every one is `security definer`, carries
  `set search_path = public, auth, extensions, pg_temp`, is revoked from `public` and `anon` and
  granted to `authenticated`, and **begins by refusing a caller for whom `is_admin()` is false**
  (`DA001`). Signatures, guards, returns and the full error-code register are contracted in
  [contracts/rpc.md](./contracts/rpc.md), which is authoritative for this block; `policies.sql`
  carries blocks A–D and points at it.

The routines write GoTrue's own tables — `auth.users` with
`encrypted_password = extensions.crypt(pw, extensions.gen_salt('bf'))` and `email_confirmed_at =
now()`, plus the matching `auth.identities` row with `provider = 'email'` and `provider_id =
user_id::text`. The exact column set is **probe-verified** (coordinator, 2026-09-13, GoTrue
v2.196.0) and is reproduced verbatim in `contracts/rpc.md`; a login minted that way signs in through
`signInWithPassword` with no further step, a password update refuses the old password and accepts the
new, and the account can be taken out of service.

**Error codes** (register in `contracts/rpc.md`): `DA001` not an admin · `DA010` malformed identifier
· `DA011` password shorter than 8 · `DA012` duplicate identifier · `DA013` refusing self-removal ·
`DA014` the login owns a live team workspace · `DA015` refusing to revoke the last admin · `DA404`
no such login. The client branches on `error.code` only, never on message text — the server stays
English while the interface renders ru or en (same discipline as `DA404` in D-9).

**`delete_login` bans; it does not delete — decided from the schema, against ADR-0006 §B's wording.**
ADR-0006 says `delete from auth.users`. The schema forbids it: `workspaces` (line 18), `labels` (32),
`tasks` (44) and `notes` (81) each declare `user_id uuid not null references auth.users (id)
**on delete cascade**`. Deleting the account row would therefore delete every task, label and note
that login ever created — including rows living in a team workspace other people are still using —
which is precisely what the spec's "their rows remain, the creator id is kept" and SC-016 forbid. So
the routine sets `banned_until = 'infinity'`, scrambles `encrypted_password` to an unusable value,
drops any `instance_admins` row, and **soft-deletes that login's `members` rows** with
`updated_at = greatest(updated_at, now())` so `members_zz_clear_assignee` clears their assignees
exactly as a manual removal does. Sign-in is refused by GoTrue; the data and the authorship stay.
Consequences are recorded as **R-18**. The `DA013`/`DA014` guards are unaffected.

**Why in Postgres rather than an Edge Function or a Worker route.** ADR-0006's alternatives (a)–(d),
not re-argued here. The operative consequence for this plan: **no `service_role` key exists in the
repo, in a build, in a platform secret or in the deployed client** (SC-020), and the whole surface is
testable in the tier every other P1 claim is proven in. The coupling to GoTrue's table shape is the
accepted cost, pinned by the canary in D-13 and recorded as **R-15**.

**Client layering is D-9's, extended**: `src/db/api.ts` exposes `isAdmin`, `createLogin`,
`setLoginPassword`, `deleteLogin`, `setLoginAdmin`, `listLogins`; each delegates to a `*Remote`
wrapper in `src/sync/sync.ts`, which stays the only module holding the Supabase client. These
mutators are **online-only and never queued** — a queued account creation would be a password sitting
in Dexie (FR-044).

**Serves**: FR-037..FR-046, US7, SC-015, SC-016, SC-018, SC-020, SC-021.

### D-17 — The client's admin flag: an `is_admin()` answer cached per device, never an authority

*Source: FR-038, FR-043, SC-018; the same shape as Q-A Option B.*

**Decision.** `src/db/api.ts` exposes `isAdmin(): Promise<boolean>`, which returns the Dexie `meta`
value under the key **`is-admin`** immediately and refreshes it from `is_admin()` (through
`isAdminRemote()` in `src/sync/sync.ts`) **on every successful pull**, writing the new value back to
`meta`. Settings renders the `logins` section from that cached value.

**Why a cache at all.** Settings must decide what to draw before any network round trip completes, and
on a device that is offline it must still draw *something*. Asking on every render would flicker the
section in and out; asking once at boot and never again would leave a just-revoked admin holding the
controls until a reload.

**Why it is never authoritative, and why that is safe.** The flag decides *rendering only*. Every one
of the five routines re-checks `is_admin()` inside the database, so a stale `true` buys a `DA001` and
nothing else, and a stale `false` hides a control the person may still use after their next pull. That
is exactly SC-018's split: the hidden UI is a convenience, the refusal is the control. Nothing in the
system ever reads this key to decide access.

**Storage and lifecycle.** A single `meta` key, so Dexie v3 needs no new store (D-10) and the cache
is cleared for free by `wipeLocal()`'s existing `db.meta.clear()` — a device switching accounts cannot
inherit the previous account's flag (FR-021, SC-012). `claimCache` is untouched.

**Rejected alternatives.** (a) A synced `instance_admins` table in Dexie — it would put the whole
instance's admin roster on every device and make the flag look like data the client owns; the table
is deliberately unreachable through PostgREST (D-16). (b) A JWT claim — it would need a GoTrue hook
and would go stale until the token refreshed, with no way to revoke early. (c) Calling `is_admin()`
per render — flicker plus an RPC per keystroke in Settings.

**Serves**: FR-038, FR-043, SC-018.

### D-18 — A refused row does not wedge the queue: per-row retry in push

*Source: ADR-0006 §E, FR-041, US6 acceptance 6, SC-017. Corrects D-7's reading of the refusal path,
and fixes the seam recorded as R-14.*

**The defect, precisely.** In `src/sync/sync.ts`'s push loop (lines ~176-300), each table's dirty rows
are chunked and sent as batch upserts; `const { data, error } = await supabase.from(table).upsert(...)
.select('id')` is followed by `if (error) throw error`, and the per-table `catch` at **274-277** sets
`failed = true` and logs. An RLS refusal raises `42501` for the **whole batch**, so no row in it is
ever marked clean, the same batch is re-sent every cycle, and that table's queue never drains. A
removed member's queued edit, a banned login's queued edit and a team → personal switch all produce
exactly that row.

**The change, stated as lines.** Inside the existing per-table `try`, around the batch upsert only:

1. keep the batch upsert as the fast path — on success, nothing changes at all, including the
   refused-id bookkeeping at **240-272**;
2. on `error`, instead of `throw error`, **retry that batch row by row**: one upsert per row, same
   payload construction, same `onConflict: 'id'`, same `.select('id')`;
3. a row that succeeds alone proceeds through the **normal** landed/refused bookkeeping — it is
   marked `_dirty: 0` exactly as a batch-landed row is;
4. a row that **errors alone** is marked `_dirty: 0` locally and left for the next pull to reconcile:
   the pull brings down the server's truth — a tombstone, or nothing at all if the row is no longer
   visible. **For a row belonging to a workspace the user can no longer reach, delete it from
   Dexie**, because "no longer visible" means the pull will never send a correcting version and the
   row would otherwise sit in the cache forever showing an edit the server refused. Which of the two
   applies is decided by whether the local `workspaces` row is still reachable after the pull, not by
   inspecting the error;
5. `pushFailed` is set **only** for transport-level failures (a thrown fetch, a 5xx) — never for a
   row the server deliberately refused. A refusal is an answer, not an outage, and letting it set
   `pushFailed` is what would keep the banner up forever.

**What is explicitly not touched.** `mergeRows` (**409-458**) and the server's `keep_newer`
(`supabase/schema.sql:142-153`) are **unchanged, in the same change set and after it** — the conflict
rule keeps one definition with two enforcement points, so ADR-0001 §3's lockstep and FR-020 hold
exactly as before (ADR-0006 §E is an amendment about the path *around* the rule). The pull loop is
untouched. The refused-id path at 240-272 is untouched. `SYNCED_TABLES` ordering is untouched.

**Cost.** A batch that fails costs N extra round trips. Refusals are rare by construction — they
happen once per removal, not per cycle — and the alternative is an infinite number of round trips,
which is today's behaviour.

**Test-first, non-negotiable (P-gate, ADR-0002).** `tests/stack/push-refusal-fallback.test.ts` is
written and **red** before `src/sync/sync.ts` is edited. It provokes a *real* `42501` — account B
queues an edit in a team workspace while removed, with dirty rows in other tables behind it — and
asserts (i) every other table's dirty count reaches **0 within one push cycle**, (ii) the refused row
is not re-sent on the next cycle, and (iii) `pushFailed` is false, because nothing failed to
transport. `sync-engine`'s three P0 checks must pass **unedited** in the same run (FR-030): they are
the proof the conflict rule did not move.

**Map consequence.** `sync-engine` goes `VALIDATED → changed → re-verified`, with a receipt dated to
this change set and `push-refusal-fallback.test.ts` added to its `tests:` list (D-15, SC-004).

**Serves**: FR-041, FR-020 (by not breaking it), US6 acceptance 6, SC-017, SC-004.

## Project Structure

### Documentation (this feature)

```text
specs/002-team-workspaces/
├── plan.md              # This file
├── spec.md              # Input
├── data-model.md        # Entities, columns, wire contract, Dexie version   (produced)
├── contracts/
│   ├── policies.sql     # The replaced predicates + helpers, as they will be written  (produced)
│   └── rpc.md           # the 8 backend operations: membership + provisioning, with the
│                         #   verbatim GoTrue column set and the error-code register  (produced)
├── checklists/          # Existing
├── receipts.md          # Written during implementation (D-14, D-15)
└── tasks.md             # NOT created by /speckit-plan — next step
```

`research.md` and `quickstart.md` are deliberately not produced: Phase-0 research is the **Key
technical decisions** section above (house style, `specs/001-validation-spine/plan.md`), and the
quickstart is still one command — `npm test` — documented in `docs/project-structure.md`.

### Source Code (repository root), by owning agent role

```text
# ── data  (owns supabase/, src/db/, src/sync/, src/auth/) ──────────────────────
supabase/schema.sql                   # kind, members, assignee, helpers, 7 new triggers,
                                      #   replaced own_rows on 4 tables, members_access  (D-1..D-9)
                                      #   + fork block D: instance_admins, is_admin(),
                                      #     users_seed_first_admin on auth.users          (D-16)
                                      #   + fork block E: create_login, set_login_password,
                                      #     delete_login, set_login_admin, list_logins    (D-16)
                                      #   + workspaces_zz_kind_change (no pin trigger)    (D-6')
                                      #   NO migration-007                                (D-2)
src/db/types.ts                       # Member, WorkspaceKind; Workspace.kind; Task.assignee;
                                      #   SYNCED_TABLES + SYNCED_COLUMNS                  (D-8, D-10)
src/db/local.ts                       # Dexie v3: members store + additive backfill;
                                      #   claimCache/wipeLocal UNCHANGED                  (D-10)
src/db/api.ts                         # createWorkspace(name, kind); listMembers; memberEmails;
                                      #   addMemberByEmail; removeMember; TaskPatch.assignee (D-9, D-11)
                                      #   + isAdmin (meta-cached), createLogin,
                                      #     setLoginPassword, deleteLogin, setLoginAdmin,
                                      #     listLogins                                   (D-16, D-17)
src/db/hooks.ts                       # one useLiveQuery wrapper for members
src/sync/sync.ts                      # the two online-only member calls, the six *Remote
                                      #   provisioning/admin wrappers, and the per-row
                                      #   refusal fallback in PUSH ONLY                   (D-9, D-16, D-18)
                                      #   mergeRows (409-458) and the pull loop UNCHANGED  (FR-020)
src/auth/useSession.ts                # UNTOUCHED — FR-023, D-12

# ── ui  (owns src/views/, src/components/, src/styles/) ────────────────────────
src/components/Header.tsx             # affordance 1 — kind choice at creation
src/components/Settings.tsx           # affordances 2-4 — members section, team-only;
                                      #   affordance 6 — kind switch, owner-only, in the
                                      #     existing workspace section                    (D-6')
                                      #   affordance 7 — logins section, admin-only       (D-16, D-17)
                                      #   the sign-out path is UNTOUCHED                  (D-12)
src/components/TaskDialog.tsx         # affordance 5 — assignee field, team-only
src/components/Settings.css, TaskDialog.css   # styling for the above, nothing else
src/i18n/dict.ts                      # the ~29 new keys, ru + en                         (D-11)
src/views/**                          # ZERO CHANGES — FR-025, checked by git diff --stat

# ── infra  (owns vite.config.ts, manifest/SW, wrangler.jsonc, .github/, README.md) ──
.github/workflows/ci.yml              # no change expected; the suite grows, the steps do not
                                      #   (a change here is a FINDING, not a task)

# ── evidence (shared; written by data, reviewed by reviewer) ───────────────────
tests/stack/{members-two-accounts,team-rls-both-halves,assignee-clear-on-removal,
             member-offline-round-trip,team-triggers,personal-unchanged,
             logins-provisioning,kind-switch,push-refusal-fallback}.test.ts
tests/local/{db-api-p1-surface,no-wipe-on-reach-growth}.test.ts
tests/harness/{accounts,seed}.ts      # additive exports only, incl. the TEST-ONLY
                                      #   adminClient()                                   (D-13)

# ── docs (coordinator) ────────────────────────────────────────────────────────
docs/validation-map.md                # 4 new HIGH entries (incl. account-provisioning)
                                      #   + re-verifications, incl. sync-engine           (D-15, D-18)
docs/ARCHITECTURE.md, docs/architecture-index.md
                                      # only if an architecture fact changes — and then only with
                                      #   a new ADR + a STALE cascade + a regenerated index, in
                                      #   the same PR (CLAUDE.md, Git). Not expected: §2/§3 already
                                      #   describe the fork target this feature implements.
```

**Structure Decision**: single project, unchanged shape. The split above is by **agent role
ownership** (CLAUDE.md, *Agent roles*) so tasks can be assigned by layer without anyone crossing a
boundary: `data` owns everything under `supabase/`, `src/db/`, `src/sync/`, `src/auth/` and writes the
evidence; `ui` owns the seven affordances and the dictionary and must wait until `data` has landed the
membership model; `infra` is expected to have nothing to do, which is itself a checkable claim.

## Risks, seams and candidate FINDINGS

Recorded at planning time. Each is confirmed or dismissed during implementation; a confirmed one
goes to the owner as a FINDING rather than becoming an unplanned refactor.

- **R-1 (certain, designed around): policy recursion on `members`.** A policy on `members` whose
  predicate selects from `members` recurses; Postgres says
  `infinite recursion detected in policy for relation "members"`. D-5's `security definer` helpers are
  the fix, and this is the reason they are not optional. **Test obligation**: one assertion that a
  plain authenticated select on `members` returns without error — the cheapest possible canary.
- **R-2 (high): `security definer` + `search_path` hijack.** Every definer function in D-3, D-5, D-6,
  D-6′, D-9 and **D-16** must carry `set search_path` — the provisioning routines carry
  `public, auth, extensions, pg_temp`, and they are the ones where a hijack would mint accounts. One that does not is a privilege-escalation hole, not a style
  nit. **Test obligation**: a query over `pg_proc` asserting `prosecdef and proconfig is not null` for
  every function this feature adds — a structural check that cannot be forgotten in review.
- **R-3 (high): PostgREST exposes every `public` function as RPC, to `anon` by default.**
  `add_member_by_email` reachable by `anon` would be a membership-granting endpoint with no caller
  identity. The `revoke … from public, anon` / `grant … to authenticated` lines in D-5/D-9 are
  load-bearing, and doubly so for **`create_login`**, which reachable by `anon` would be an open
  account factory on a closed instance. **Test obligation**: an unauthenticated client calling each of
  the **eight** RPCs is refused.
- **R-4 (certain, bounded): the upstream merge surface moves into `schema.sql`.** ADR-0005 predicted
  it; this feature is where it becomes real. Upstream's policy block is now rewritten by the fork, so
  every future upstream change to those lines conflicts. Mitigation, and a reviewer check: the fork's
  additions live in **separate guarded blocks**, upstream's four-element `foreach` arrays are **not**
  edited to add `members`, and the write half's personal branch is upstream's clause character for
  character — so a conflict resolves by inspection rather than by re-deriving intent.
- **R-5 (medium): hard vs soft delete of members, against LWW.** Settled as soft (D-7). The residual
  risk is a helper that forgets `and not m.deleted` — a removed member with full access, the worst
  failure in this codebase. **Test obligation**: US3 acceptance 6 (post-removal, every read returns
  nothing and every write is refused) is the direct check, and it must assert on *both* halves.
- **R-6 (medium): the owner deletes a team workspace while a member has queued edits.** The spec says
  the existing cascade decides it. `follow_workspace_delete` updates children by `workspace_id` with
  no `user_id` filter (`schema.sql:158-175`), and `stay_deleted_with_workspace` checks only that the
  parent workspace is deleted (`schema.sql:177-190`) — so both are already membership-blind and should
  be correct for a team workspace unchanged. **Verify, do not assume**: `team-triggers.test.ts`
  demonstrates each on a team workspace, and P0's `soft-delete.test.ts` must still pass unedited.
  A member's late-arriving live child must be forced to `deleted`, not refused — if the replaced
  `with check` refuses it instead, the trigger becomes unreachable on rows it used to see, which is a
  FR-014 regression and a FINDING.
- **R-7 (medium): `user_id` drift on member edits.** Covered by D-4's `<t>_zz_keep_creator` trigger.
  The risk is that the trigger is forgotten, in which case `user_id` silently becomes "last writer"
  and FR-011 is violated with no visible symptom. **Test obligation**: B edits A's task in the team
  workspace; assert server-side that `user_id` is still A's.
- **R-8 (medium): assignee pointing at a non-member after removal.** Structurally prevented by D-3's
  clear trigger plus the D-3 membership trigger. The residual case is a *hard* delete of a member row
  from the dashboard — hence the `after delete` mirror. **Test obligation**: SC-006 measured directly,
  and the one-cycle convergence on the client (US5 acceptance 3).
- **R-9 (medium): Dexie upgrade on a device with cached rows.** v3 must add a store and backfill two
  fields, never modify an existing store's key or index. A device that was on v2 with thousands of
  cached rows must open, keep every row, and keep `meta` — including the pull cursors. **Test
  obligation**: `no-wipe-on-reach-growth.test.ts` opens a v2-shaped database, upgrades, and asserts
  row counts and cursor values survive.
- **R-10 (medium): a fifth entry in `SYNCED_TABLES` reaching a P0 test.** Several P0 files import
  `SYNCED_TABLES`/`SYNCED_COLUMNS`. If any of them asserts on the *set* rather than on a member of it,
  it will fail — and per FR-030 that is a FINDING for the owner, **not** an edit. Checked as its own
  task, before the UI work starts.
- **R-11 (low, real): a member can edit children but not the workspace row; a queued workspace edit
  by a member wedges the queue.** D-4 deliberately keeps workspace writes owner-only, while children
  are member-writable — so a member invoking `deleteWorkspace()` from `db-api` would soft-delete every
  child and then be refused on the workspace row, leaving an empty-looking live workspace. Within the
  contract (a member is a full read/write participant in children, spec Assumptions), but the
  interface must not offer the control: Settings' delete-workspace button is hidden for a non-owner.
  The same is true of the rename field (`Settings.tsx:153-155`, `useAutosave` → `renameWorkspace` →
  dirty workspace row → push): a member's rename is refused by the unchanged workspace `with check`
  (RLS `42501`), and before D-18 the push loop's per-table catch would then re-send that same refused
  row every cycle. **D-18 fixes that consequence** — the queue drains and the refused row is dropped —
  but the guard stands unchanged and for its own reason: a member must not be *offered* rename or
  delete at all, because the half-state (children soft-deleted, workspace row refused) is what the
  control produces, not the wedge. So **both** the rename field and the delete button are hidden for a
  non-owner of a team workspace, not the delete button alone. Flagged because it is exactly the kind
  of half-state a demo finds.
- **R-12 (low): the members-email cache — ANSWERED.** Owner question Q-A is decided: **Option B**,
  the per-device unsynced cache in Dexie `meta` (see Owner questions, below). The residual risk is the
  one Option B was chosen with open eyes about: a name can be one sync cycle stale. The same shape
  now also carries the admin flag (D-17), so the discipline — display-only, never authoritative,
  cleared by `wipeLocal()` — applies to two keys rather than one.
- **R-13 (low): `add_member_by_email` and case.** Supabase stores emails lower-cased, but the owner
  types free text. The lookup trims and lower-cases both sides; otherwise "no account on this origin"
  fires for an account that exists, which is SC-010's message pointing at the wrong cause.
- **R-14 (medium, inherited seam) — FIXED IN THIS FEATURE by D-18.** The push loop had no per-row
  refusal path (`sync.ts:274-277`): a single refused row re-failed its table's batch every cycle. The
  original plan worked *around* it — every new server rule coerces or silently drops (D-3,
  `keep_newer`), and the one UI path that would produce a refused row is hidden (R-11) — and deferred
  the seam to P2. ADR-0006 §E overtakes that: removal, a banned login and team → personal each
  produce a genuinely refused row that no guard can hide, so the seam is closed here instead, by
  per-row retry in push (D-18), proven by `push-refusal-fallback.test.ts` and re-signed on the
  `sync-engine` entry. What remains for P2 is only *surfacing* a refusal to the person who made the
  edit; dropping it silently and reconciling on the next pull is what P1 does.

- **R-15 (high, owner-accepted 2026-09-13 — ADR-0006's named cost): the fork is coupled to GoTrue's table shape.**
  `create_login` and `set_login_password` write `auth.users` / `auth.identities` column by column, and
  the bcrypt convention, the empty-string token columns and the identity row are all GoTrue internals
  that no contract promises to keep. A Supabase upgrade can change them. **The canary is the sign-in
  test**: `logins-provisioning.test.ts` mints a login through the routine and then signs in with
  `supabase.auth.signInWithPassword` — if the shape moves, that assertion fails loudly on the next run
  rather than in production, and ADR-0006 alternative (a), the Edge Function holding `service_role`,
  is the prepared replacement. Pinning the CLI version is not enough on its own, because the hosted
  project upgrades independently of the local stack; the hosted walk (D-14) is therefore the second
  place this is exercised.

- **R-16 (medium, owner-accepted 2026-09-13): does a trigger on `auth.users` survive a Supabase upgrade?**
  Owner's word: an admin is provided either by the first-login trigger **or** by editing
  `public.instance_admins` directly in the Supabase SQL editor (`insert into public.instance_admins
  (user_id) select id from auth.users where email = '<owner>'`). The trigger is a convenience, the
  table is the truth; a lost trigger costs one SQL-editor line, not access.
  `users_seed_first_admin` lives in the `auth` schema's blast radius, and GoTrue owns that schema's
  migrations. The pattern is the platform's own (the documented `handle_new_user` recipe has the same
  shape), and `schema.sql` is idempotent and re-runnable, so the recovery is cheap: re-run it. But a
  silent *drop* of the trigger would not fail any test on an existing origin — `instance_admins` is
  already non-empty there, so the trigger would never have fired anyway. Recorded rather than solved.
  **Obligation**: the schema-apply check asserts the trigger exists after apply, so the re-run that
  fixes it is at least detectable in CI; on the hosted origin it is a step in the D-14 runbook.

- **R-17 (low, structural): `extensions.crypt` needs `pgcrypto` in the `extensions` schema.** The
  routines call `extensions.crypt` / `extensions.gen_salt('bf')`. Supabase installs `pgcrypto` into
  `extensions` on every project, and the local stack matches — but a plain Postgres, or a project
  where someone moved it, would fail at *call* time with a confusing "function does not exist" rather
  than at apply time. **Obligation**: `schema.sql` does **not** try to `create extension` (it would
  need privileges the file does not assume); instead the schema-apply check asserts the extension is
  present and in that schema, so the failure is one clear line at the start of the suite.

- **R-18 (medium, owner-accepted 2026-09-13): `delete_login` bans rather than deletes, and that is not
  reversible into "never existed".** Forced by the FK cascade on `user_id` (D-16). Consequences worth
  stating: the `auth.users` row persists, so the identifier stays taken and `create_login` with the
  same email returns `DA012` — re-hiring the same person means lifting the ban, which P1 exposes no
  control for; `list_logins()` keeps showing the row, so the admin sees removed logins unless the
  query filters them, and it does **not** filter them, because a hidden row that still holds an
  identifier is worse than a visible one; and a banned login's active JWT stays valid until it
  expires, so "access ends" means at most one token lifetime, not instantly. Each is a candidate
  FINDING if the demo trips on it, and each is cheaper than losing a team's rows.

- **R-19 (low, answered by design): a kind switch racing a member's concurrent write.** Owner flips
  team → personal while a member is mid-edit. The membership purge and the member's task edit are
  separate rows, so LWW does not arbitrate between them: the purge lands, the member's next push is
  refused by the (now personal) workspace's predicate, and D-18 drops that row rather than wedging the
  queue. The only genuine race — a *stale* kind flip arriving after the roster was rebuilt — cannot
  fire the purge at all, because `workspaces_zz_kind_change` is AFTER UPDATE and `keep_newer` has
  already cancelled the stale update before it (D-6′). **Test obligation**: `kind-switch.test.ts`
  asserts a membership purge does not happen for a kind write with an older `updated_at`.

## Owner questions

Two were raised at planning time. **Q-A is now answered** (owner session 2026-09-13, recorded with
the ADR-0006 decisions): **Option B**. Q-B remains open and is the only question this plan still
carries. Everything ADR-0006 settled — provisioning in Postgres, kind mutable, the refusal fallback,
sign-up disabled on the hosted project — is decided and is written into D-6′, D-16, D-17 and D-18
rather than asked again here.

**Q-A — May member emails be cached on the device, or are they online-only? — ANSWERED: Option B.**
The per-device cache is adopted: `meta` holds `member-email:<uuid>`, refreshed on each successful
`workspace_member_emails` call, never synced, never authoritative, cleared by `wipeLocal()`. The
implementation follows `contracts/rpc.md` and D-10; D-17 reuses the same shape for the admin flag.
The original framing is kept below because it is the reasoning the decision was taken against.
FR-007 and clarification Q1 forbid "a second copy of the email" that can drift. That plainly rules out
a `profiles` table (D-9 complies). It is **not** clear whether it also rules out a per-device,
unsynced cache in Dexie `meta` — the same shape as the existing `gcal:<taskId>` signatures
(`src/gcal/sync.ts:26-27`), wiped with the cache and refreshed on every successful RPC call.
The choice is visible in the product:
- **Option A — no cache (strict reading).** Emails are fetched live whenever the member list or a task
  card is opened. Offline, the member list and the assignee on a task show an identity-less placeholder.
  Demo step 5 (B sees the assignee) works online; step 7–8 (B offline) shows the assignment without a
  name.
- **Option B — per-device derived cache (recommended).** `meta` holds `member-email:<uuid>`, refreshed
  on each successful `workspace_member_emails` call and cleared by `wipeLocal()`. Names survive
  offline; the copy is per-device, never synced, never authoritative, and cannot outlive a sign-out.
  Drift is bounded to one sync cycle.
**Recommendation: B**, because "a client that was offline learns … on its next cycle" (FR-019) reads
as the intended standard for derived data, and because an assignee with no name is a worse product than
a name that is one cycle stale. **Owner's answer: B.** Q1's prohibition is read as forbidding a
*server-side second copy of record* (a `profiles` table), not a device-local render cache that cannot
outlive a sign-out.

**Q-B — F-5: re-record with an expiry, as D-12 recommends?**
The spec says F-5 must end this feature covered **or** re-recorded with the owner's name, the date and
an expiry, and that an agent may not settle option (b) alone. D-12 recommends re-recording with expiry
*"end of P2 (Playwright arrives)"*, on the grounds that P1 turns out not to change the sign-out order
at all — `useSession.ts` and `Settings.tsx`'s sign-out path are not in this feature's diff. The owner
is asked to confirm the wording, the name and the expiry, or to require option (a) instead.

## Complexity Tracking

> Filled because the post-design Constitution re-check produced four items worth recording.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| `src/db/api.ts` gains two operations that cannot complete offline (`addMemberByEmail`, `memberEmails`), where every existing `db-api` mutator is offline-capable | An email→uuid lookup can only happen where `auth.users` lives (FR-008), and FR-026 forbids the UI calling the backend directly. Both layering rules are preserved by delegating through `src/sync/sync.ts` (D-9) | Calling the RPC straight from the component violates FR-026 outright. Storing a local copy of emails so the lookup could be offline is a `profiles` table by another name — forbidden by FR-007 and Q1. Removing the affordance fails FR-024 |
| `src/db/api.ts` gains **six more** online-only operations — the provisioning surface and `isAdmin` (D-16, D-17) | Account creation can only happen where `auth.users` lives, and a queued one would be a password sitting in Dexie (FR-044). They widen the same layering rule the row above already widened, through the same `*Remote` delegation, so the shape is one exception rather than two | Queueing them offline would persist credentials on the device. Calling the RPC from the component violates FR-026. Leaving provisioning in the Supabase dashboard is ADR-0006 alternative (c), rejected by the owner |
| `src/sync/sync.ts`'s push loop gains a second, slower path (per-row retry) where it had exactly one (D-18) | An RLS refusal raises `42501` for the whole batch and otherwise wedges that table's queue forever (FR-041, SC-017), and P1 now produces genuinely refused rows that no UI guard can hide | Hiding every path that can be refused is what the original plan did — it no longer covers removal, `delete_login` or team → personal. Surfacing the refusal to the user is a bigger change than P1 needs. Dropping the whole batch would lose innocent rows |
| A **test-only** privileged helper, `adminClient()`, inserts into `instance_admins` over the direct `pg` connection (D-13) | The harness provisions users through the admin API, so "the first account is the admin" lands nondeterministically inside a suite; tests need a deterministic admin without asserting the trigger's behaviour as a side effect | Relying on creation order makes every provisioning test order-dependent and silently wrong on a dirty database. Exposing a real grant-first-admin routine to the client would be a privilege-escalation hole. The trigger itself is still asserted directly, on an empty `instance_admins` |
