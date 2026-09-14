# Data model — 002-team-workspaces

Companion to [plan.md](./plan.md). Every decision reference below (`D-N`) points into that file's
*Key technical decisions* section. SQL as it will be written lives in
[contracts/policies.sql](./contracts/policies.sql); the eight backend operations live in
[contracts/rpc.md](./contracts/rpc.md).

Scope: **two new tables, two new columns, one Dexie version, one new wire entry.** Nothing existing
is repurposed (ADR-0001 §2). No `origin` column or table anywhere (ADR-0004, FR-027). The second new
table — `public.instance_admins` — is *not* synced and never enters the wire contract (ADR-0006 §C,
D-16).

## 1. Entities

### `public.workspaces` (existing, one column added)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | unchanged |
| `user_id` | uuid → `auth.users` | unchanged meaning: **creator/owner**, even in a team workspace |
| `name` | text | unchanged |
| **`kind`** | **text not null default `'personal'`** | **new.** `check (kind in ('personal','team'))`. Chosen at creation and **mutable afterwards by the owner** — an ordinary column write under `keep_newer`, whose consequences are drawn by `workspaces_zz_kind_change` (D-6′, ADR-0006 §D, FR-001, FR-034) |
| `created_at` / `updated_at` / `synced_at` / `deleted` | — | unchanged housekeeping |

Existing rows become `personal` by the column default at `add column` time — no backfill, therefore
no `migration-007` (D-2, ADR-0005).

### `public.members` (new)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | surrogate, because the generic sync loop upserts `on_conflict: 'id'` and Dexie keys on `id` |
| `user_id` | uuid → `auth.users` on delete cascade | **who created the row** (the inviting owner). Same meaning as every other table. Re-stamped by the push path, which is exactly why `member_id` exists separately (D-1) |
| `workspace_id` | uuid → `public.workspaces` on delete cascade | |
| `member_id` | uuid → `auth.users` on delete cascade | **whose membership this is** |
| `level` | text not null default `'member'` | `check (level in ('owner','member'))` — two levels, not a role system (ADR-0001 §1) |
| `created_at` / `updated_at` / `synced_at` | timestamptz not null default `now()` | the same four housekeeping columns every synced table has |
| `deleted` | boolean not null default false | removal is a **soft** delete (D-7) |

Indexes: `unique (workspace_id, member_id)` — unconditional, *not* partial on `not deleted`, so
re-adding a removed person flips the same row back (US2 acceptance 6); plus `(member_id, synced_at)`
for the RLS helper and the pull cursor.

**Identity invariant.** `member_id`, `user_id` and `tasks.assignee` are all ids in **this** origin's
`auth.users`. There is no cross-origin reference of any kind (ADR-0004, FR-027, SC-009).

### `public.tasks` (existing, one column added)

| Column | Type | Notes |
|---|---|---|
| **`assignee`** | **uuid null → `auth.users` on delete set null** | **new.** A label, never an authorization input — no RLS predicate mentions it (FR-017, SC-007). Must be a live member of the task's workspace, enforced by `tasks_zz_assignee_member` (D-3). Cleared structurally on removal by `members_zz_clear_assignee` (D-3) |

`labels` and `notes` are unchanged in shape.

### `public.instance_admins` (new, **not** synced)

The instance-admin layer (ADR-0006 §C, D-16, FR-037..FR-039). A *second* role layer, orthogonal to
membership: it says who may mint and manage logins, and nothing at all about who may read a row.

| Column | Type | Notes |
|---|---|---|
| `user_id` | uuid pk → `auth.users` on delete cascade | one row per admin; the flag *is* the row's existence |
| `granted_by` | uuid null → `auth.users` on delete set null | who granted it; `null` for the first account, which the backend granted itself |
| `created_at` | timestamptz not null default `now()` | no `updated_at`, `synced_at` or `deleted` — this table never syncs |

RLS is **enabled with no policy**: the table is unreachable through PostgREST by anyone. It is read
only by `public.is_admin()` and written only by the provisioning routines, all `security definer`.
The client learns its own flag from `is_admin()` and caches it per-device (D-17).

**Hard invariant, enforced by review as well as by code:** no access policy on any table may read
`instance_admins`. An admin has no extra reach into anyone's workspaces or rows (FR-039); a policy
that consults this table is a standing reviewer finding (ADR-0006 Consequences).

## 2. State and lifecycle

**Workspace kind.** `personal | team`, chosen at creation and **mutable in both directions by the
owner** (D-6′, ADR-0006 §D, FR-001, FR-034..FR-036). The write half of `workspaces_access` is
already owner-only, so "only the owner may switch" needs no new predicate. A third value is still
refused loudly by `workspaces_kind_check`.

```
personal --owner sets kind='team'-----> team
   ^                                     |
   |                                     | seed/un-delete exactly one owner membership row
   |                                     v
   +--owner sets kind='personal'------- team
          every live members row soft-deleted, updated_at = greatest(updated_at, now())
```

Both consequences are drawn by one `after update` trigger, `workspaces_zz_kind_change`, guarded by
`when (new.kind is distinct from old.kind)`:

- **team → personal**: every live `members` row of that workspace is soft-deleted *row by row*, so
  `members_zz_clear_assignee` fires for each and clears that person's assignees exactly as a manual
  removal does (FR-035). A member sees the workspace leave their list on the next pull,
  indistinguishably from having been removed (FR-036).
- **personal → team**: the owner's own row is upserted on `(workspace_id, member_id)` — un-deleted
  and re-levelled to `owner` if one is already there. Former members are **not** restored; the owner
  re-adds them. Round-tripping therefore leaves exactly one owner row, never two (ADR-0006 §D).

AFTER timing is the point: `keep_newer` (BEFORE) has already abandoned a stale flip by then, so a
late-arriving kind write never triggers a membership purge (R-19).

**Membership.** Three ways in, three ways out:

```
(absent) --add_member_by_email--> owner|member(deleted=false)
         --workspaces_seed_owner-> owner(deleted=false)        # at team creation
         --kind personal->team---> owner(deleted=false)        # upsert, un-deletes an old row

         --removeMember---------> member(deleted=true)         # access ends here, row remains
         --kind team->personal--> owner|member(deleted=true)    # every row at once
         --delete_login---------> member(deleted=true)         # every membership of that login
          --add again-----------> same row, deleted=false    # never a second row
```

Every exit is the *same* soft delete with `updated_at = greatest(updated_at, now())`, which is what
makes the assignee clear and the queued-edit outranking work identically for all three.

A team workspace's creator is inserted as `level='owner'` by `workspaces_seed_owner`, an
`after insert` `security definer` trigger — so it holds for every path into the table, including a
workspace created offline and pushed later (D-6, FR-002). `members_access`'s owner-only write half
plus the absence of any owner-demotion operation makes "at least one owner, always" structural
(FR-010).

**Assignee.**

```
null <--> member_id       # set/cleared by the task dialog through updateTask
     <--  null            # forced on removal, with updated_at = greatest(updated_at, now())
```

The `greatest(...)` is deliberate and copied from `follow_workspace_delete`: the clear must outrank an
edit already queued on the removed member's device, or that device pushes the assignment back
(FR-018, SC-006, US5 acceptance 3).

## 3. Wire contract

`SYNCED_TABLES` becomes `['workspaces', 'members', 'labels', 'notes', 'tasks']` — `members` after
`workspaces` (it FKs one), before the leaf tables (D-8).

| Table | Columns added to `SYNCED_COLUMNS` |
|---|---|
| `workspaces` | `kind` |
| `tasks` | `assignee` |
| `members` *(new entry)* | `id, workspace_id, member_id, level, created_at, updated_at, deleted` |

`user_id` and `synced_at` are **not** in any `SYNCED_COLUMNS` entry: push stamps `user_id`, pull
strips both — unchanged behaviour, and the reason `members.member_id` is a separate column.

The `satisfies { [K in SyncedTable]: ColumnsOf<SyncedRow[K]> }` check in `src/db/types.ts` turns a
forgotten column into a **compile error**, which is the guard for this whole table.

TypeScript:

```ts
export type WorkspaceKind = 'personal' | 'team';
export type MemberLevel   = 'owner' | 'member';

export interface Workspace { /* … */ kind: WorkspaceKind }
export interface Task      { /* … */ assignee: ID | null }
export interface Member {
  id: ID; workspace_id: ID; member_id: ID; level: MemberLevel;
  created_at: string; updated_at: string; deleted: boolean;
  _dirty?: 1;
}
```

## 4. Local cache (Dexie `dandori`, 2 → 3)

**Additive only** (D-10):

```ts
this.version(3)
  .stores({ members: 'id, workspace_id, _dirty' })   // added; no existing store touched
  .upgrade(async (tx) => {
    await tx.table('workspaces').toCollection().modify((w) => { w.kind ??= 'personal'; });
    await tx.table('tasks').toCollection().modify((t) => { t.assignee ??= null; });
  });
```

No store's key or index changes, so Dexie rebuilds nothing and every cached row and every `meta`
entry — including the per-table pull cursors — survives the upgrade (R-9).

**`claimCache` and `wipeLocal` are unchanged.** Same signature, same `meta` key `owner`, same value
(the bare user id), same semantics. Renaming the key would make every existing cache look ownerless
after upgrade and silently skip the **next** account-switch wipe, because `claimCache` adopts an
ownerless cache rather than wiping it. Two new `meta` keys ride along and need no store change:
`member-email:<uuid>` (Q-A Option B) and `is-admin` (D-17) — both display-only, both cleared for free
by `wipeLocal()`'s existing `db.meta.clear()`, and neither ever authoritative: RLS and the
provisioning routines decide, the cache only decides what to draw before the next answer arrives. ADR-0004's eventual `(origin, account)` key is formed by
*adding* the origin half beside this value — a widening, as FR-022 requires. `wipeLocal()` grows
`members` in its table list; nothing else about it changes (FR-021, SC-012).

## 5. Triggers introduced, and firing order

Postgres fires same-timing triggers in **name order**. The existing pinned order on a child row is
`keep_newer` → `stay_deleted` → `synced_at` (documented at `schema.sql:193-195`) and must be
untouched (FR-014), so every new BEFORE trigger is named `…_zz_…` and therefore runs **last** — after
`keep_newer` has already abandoned a stale row.

| Trigger | Timing | Purpose | D |
|---|---|---|---|
| `workspaces_seed_owner` | after insert | creator becomes `owner` of a team workspace, in the same operation | D-6 |
| `workspaces_zz_kind_change` | after update, `when (new.kind is distinct from old.kind)` | draws the consequences of a kind switch: purge memberships one way, seed/un-delete the owner row the other | D-6′ |
| `users_seed_first_admin` | after insert on **`auth.users`** | the first account ever created on the origin becomes an instance admin, and only while `instance_admins` is empty (FR-037) | D-16 |
| `tasks_zz_assignee_member` | before insert/update | coerce `assignee` to `null` when it is not a live member (never raise — a raise would wedge the tasks sync queue, D-3) | D-3 |
| `members_zz_clear_assignee` | after update (+ after delete) | clear assignments on removal, with an outranking `updated_at` | D-3 |
| `<labels\|tasks\|notes>_zz_keep_creator` | before update | `new.user_id := old.user_id` so a member's edit does not rewrite the creator | D-4 |
| `members_synced_at`, `members_keep_newer` | before insert/update | the *same* housekeeping every synced table has, added in a fork-only guarded block rather than by editing upstream's four-element arrays | D-8 |

## 6. What is deliberately absent

- **No `profiles` table.** Emails are read live from `auth.users` by a `security definer` function; a
  mirror would drift (FR-007, Q1, D-9).
- **No `origin` column or table.** Federation needs zero schema support (ADR-0004, FR-027).
- **No `migration-007`.** Nothing needs a row edit (ADR-0005, D-2).
- **No viewer level, no per-assignee permission, no ownership transfer.** Each is a new ADR
  (ADR-0001 §1; spec Q2, Out of Scope).
- **No `profiles`-like mirror of the admin flag either.** `instance_admins` is not synced, not in
  `SYNCED_TABLES`, and not in Dexie as a table; the per-device `is-admin` meta key is a cached answer
  to `is_admin()`, not a copy of the table (D-17).
- **No hard delete of an account.** `delete_login` **bans** — `banned_until = '9999-12-31 23:59:59+00'` (finite, A-009) plus a
  scrambled password hash — because every data table declares
  `user_id ... references auth.users (id) on delete cascade` (`supabase/schema.sql` workspaces:18,
  labels:32, tasks:44, notes:81). A real `delete from auth.users` would cascade away that login's
  tasks, labels and notes inside team workspaces other people are still using, which is exactly what
  FR-045/SC-016 forbid. The membership rows are soft-deleted explicitly by the routine instead of by
  the FK, so the assignee clear still fires. See [contracts/rpc.md](./contracts/rpc.md)
  `delete_login`, and plan R-18.
