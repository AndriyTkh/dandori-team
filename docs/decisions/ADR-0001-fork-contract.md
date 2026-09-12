# ADR-0001 — Fork contract: workspace kind, additive tables, replaced policies

- **Status:** Accepted
- **Date:** 2026-09-12
- **Decider:** Andrii Tkhorenko (AndriyTkh) — fork owner, solo operator
- **Baseline:** upstream `github.com/nitatsuu/Dandori` @ `88e74aa`, audited read-only
  (`docs/validation-map.md`)
- **Amended:** 2026-09-12, in owner review, before first commit — membership is two-level rather
  than flat (§1), a per-task `assignee` pointer is planned (§1), and ADR-0004 (multi-origin
  federation) settles *where* a team workspace lives. Recorded as an in-place amendment because
  this ADR had not yet been merged; every change after the first commit gets a new number instead.
- **Supersedes:** upstream `CLAUDE.md` "What must not exist" first bullet
  (*"Collaboration: users, roles, invites, assignees, comments, mentions"*), for this fork only.
  Upstream's copy is preserved verbatim at `docs/upstream-CLAUDE.md`.

## Context

Upstream Dandori is a deliberately minimal single-user personal planner PWA: Vite + React + TS,
plain CSS, Dexie/IndexedDB offline cache, Supabase (Postgres + Auth + RLS), one-way Google
Calendar sync, Cloudflare Workers static hosting. Zero tests, zero CI — audit-confirmed.

This fork's outcome is a **self-hosted, open-source team planner**, whose eventual
differentiator is an agent task-file sync layer (not v1). The personal planner is not a
throwaway substrate: it stays a shipping product inside the fork.

Three facts from the audit shape everything below:

1. **Ownership is single-owner all the way down.** Every table carries one `user_id`, and each of
   the four tables has exactly one `for all` policy named `own_rows`. Read side is
   `auth.uid() = user_id` (`supabase/schema.sql:238-248`); write side on `labels`/`tasks`/`notes`
   additionally requires that the target workspace is yours
   (`supabase/schema.sql:249-253`, re-issued at
   `supabase/migration-006-lww-and-ownership.sql:125-137`). `workspaces` has no membership or
   collaborator concept anywhere in schema or code — no members table, no role column, no
   `auth.jwt()` claim inspection, no `security definer` widening.
2. **Conflict resolution is enforced twice, in lockstep.** Client-side whole-row LWW
   (`src/sync/sync.ts:104-141,409-458`) and the server trigger `keep_newer()`
   (`supabase/migration-006-lww-and-ownership.sql:37-48`) currently agree. Changing one without
   the other silently corrupts merges.
3. **The local cache assumes exactly one account per device.** `claimCache`/`wipeLocal`
   (`src/db/local.ts:89-125`) wipes the whole IndexedDB cache wholesale on owner mismatch.

The fork will keep merging from upstream, which stays personal-only. So the shape of the
divergence — not just its content — is a decision with a long tail.

## Decision

### 1. Workspace kind

`workspaces` grows a `kind` column with exactly two values: `personal` and `team`.

- A **personal** workspace behaves exactly as it does today. Not "mostly": the same rows, the
  same policies' effect, the same sync, the same views. This is the fork's load-bearing
  invariant — see *Personal must not regress* below.
- A **team** workspace resolves access through a membership table instead of a single `user_id`.
- Default for existing and newly created rows is `personal`, so an unmigrated client and an
  upstream client see unchanged behaviour.

**Membership is two-level: `owner` and `member`.** Not flat, and not a general role system.

| level | may |
|---|---|
| `owner` | invite members, remove members, delete the workspace — plus everything a member may |
| `member` | everything else: create, read, edit and delete tasks, labels and notes in the workspace |

Two levels rather than flat because "who can remove me from this workspace" has to have an answer,
and rather than three-plus because no third capability has been identified that anyone has asked
for. A viewer/read-only level is **not** in v1; adding one is a new ADR, not a config flag.

**A per-task `assignee` is planned ahead**: a nullable pointer to a user of the **same origin**
(ADR-0004), expressing the basic "this task is set to a certain person". It is an additive column
under the rule below, landing with the P1 membership migration or immediately after it.
**No roles, permissions or access consequences attach to `assignee` at v1** — it is a label on a
task, not an authorization input. Assignment does not grant, restrict or imply anything; RLS does
not read it.
**Removal auto-clears assignment** (owner decision, 2026-09-12): removing a member from a
workspace sets their `assignee` pointers in it to null — the task shows honestly unassigned rather
than pointing at a departed user. Enforced structurally (`ON DELETE SET NULL` against the
membership row, or the equivalent trigger), never left to the client.

Scope of v1 is the **minimal** transform that makes team workspaces work: the membership table
with its two levels, the policy predicate swap, the `assignee` column, and the multi-account
rework of the local cache. Comments, dashboards, per-assignee permissions and the agent layer are
explicitly out of v1.

**Where a team workspace lives** is settled separately by **ADR-0004**: each person hosts at most
one Supabase origin, a shared workspace lives wholly on its host's origin, and data never crosses
origins. Everything in this ADR operates *within* one origin, which is why federation needs no
schema support and does not change v1's scope.

### 2. Additive tables, replaced policies

The one sanctioned shape of divergence from upstream:

- **Tables and columns are only ever added.** No upstream table is repurposed, renamed, dropped
  or given new meaning for an existing column. `user_id` keeps meaning "the row's creator/owner",
  even in a team workspace.
- **RLS policy predicates are the one replacement surface.** Team access cannot be expressed
  additively: Postgres `PERMISSIVE` policies OR together, so an added membership policy would
  widen access without ever narrowing it, and a `RESTRICTIVE` companion would then have to
  re-encode the personal case anyway. So both halves of each `own_rows` policy — the `USING`
  read predicate and the `WITH CHECK` write predicate, including its existing
  workspace-ownership `EXISTS` clause — are *replaced* by predicates that admit both cases: the
  owner, or a member of a team workspace. The replacement must preserve the existing
  read/write asymmetry (reads looser than writes, `supabase/schema.sql:222-228`) rather than
  quietly flattening it.
- **Triggers are preserved, not rewritten.** `keep_newer()`, `stay_deleted_with_workspace` and
  `follow_workspace_delete` must survive the predicate swap unchanged in behaviour. A predicate
  change that makes a trigger unreachable (or reachable on rows it never saw before) is a
  regression, not a side effect.

### 3. LWW lockstep invariant

Client LWW and the server `keep_newer()` trigger are **one rule with two enforcement points**.
Neither may be changed without the other in the same change set, and P0 pins the current joint
behaviour in tests before P1 touches anything near it.

### 4. Migration convention

Keep upstream's convention: hand-written, numbered, idempotent SQL files
(`supabase/migration-00N-*.sql`, guarded with `create or replace` / `if not exists` /
`drop ... if exists`), applied manually in the Supabase SQL editor. Fork migrations start at
**migration-007**. No migration tool is introduced in v1.

**Accepted risk (owner-recorded):** there are **no down-migrations**. A bad migration is rolled
back by writing a new forward migration, by hand, against a live database. Accepted because the
fork is self-hosted, single-operator, and the cost of a migration toolchain in v1 exceeds the
cost of this exposure. Revisit if a second operator or a second deployment appears.

### 5. Upstream merge discipline

- `upstream` remote stays configured; merges from upstream are expected regularly and are
  routine, not events.
- The fork's write surface at foundations time is `docs/`, `.github/`, and the root `CLAUDE.md`.
  Fork documents live under `docs/` precisely so that the merge surface stays one file.
- Root `CLAUDE.md` is the fork's contract; upstream's is preserved byte-identical at
  `docs/upstream-CLAUDE.md` so every divergence is diffable against the contract it departed
  from. When an upstream merge changes `CLAUDE.md`, the change lands in
  `docs/upstream-CLAUDE.md` and is then *decided upon* for the root file — never auto-merged
  into fork policy.
- Nothing is contributed back upstream by default. Upstream stays personal-only.

### 6. Personal must not regress

Upstream's closed "What must not exist" list does not survive the fork — a team planner
contradicts its first bullet. It is replaced by two rules, which are the fork's minimalism
contract:

1. **Personal workspaces must not regress.** Any change whose effect on a `kind: personal`
   workspace is observable — in data, in sync behaviour, in the views — is a defect unless the
   owner has explicitly decided otherwise in an ADR.
2. **No feature outside `specs/`.** Upstream's "if it is not in this file it must not exist"
   becomes "if it is not in a spec it must not exist". The gate moved; it did not open.

### 7. Solo operator

The fork is operated by one person. Validation-map sign-offs are recorded as
`Andrii Tkhorenko (single-operator)`. Per the structure contract this renders as **reduced
assurance, never as independent review** — a self-signed HIGH-tier entry is a real receipt and
an acknowledged weakness at the same time.

## Consequences

- Every upstream merge that touches `supabase/*.sql` needs a policy-predicate conflict check by
  hand. This is the permanent, known tax of the fork; the additive-tables rule keeps the tax
  bounded to policy bodies rather than table definitions.
- An upstream client pointed at a fork database still works for personal workspaces, and cannot
  see team workspaces (its queries never match the membership branch). This is intentional and
  is a cheap smoke test of the "personal did not regress" invariant.
- `src/db/local.ts` multi-account rework is unavoidable in P1 — a device that participates in two
  workspaces still has one cache, and today's wholesale wipe is keyed to a single owner. Write it
  so that ADR-0004's per-origin caching is a **widening of the same key**, not a later rewrite:
  the eventual key is `(origin, account)`, and P1 implements the `account` half of it.
- Team RLS predicates cost a membership lookup per row check. Not measured; not a v1 concern at
  self-hosted scale, but named here so a later slowdown has a suspect.

## Reconsider when

- Upstream itself grows any multi-user concept (then divergence shrinks, and §2 should be
  renegotiated rather than maintained).
- A second operator joins (kills the `(single-operator)` sign-off and the no-down-migration
  accepted risk simultaneously).
- Team access needs anything richer than the two levels — a read-only viewer, per-task
  permissions derived from `assignee`, or sharing across workspaces — at which point "replaced
  policies" stops being sufficient and a new ADR decides the model. Sharing **across origins** is
  categorically different: it deletes ADR-0004's invariant and replaces that ADR rather than
  extending this one.
- A P0 test proves client LWW and `keep_newer()` do **not** currently agree. The lockstep
  invariant would then be describing a bug, not a contract.
