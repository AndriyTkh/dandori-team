# Data model — 002-team-workspaces

Companion to [plan.md](./plan.md). Every decision reference below (`D-N`) points into that file's
*Key technical decisions* section. SQL as it will be written lives in
[contracts/policies.sql](./contracts/policies.sql); the two backend operations live in
[contracts/rpc.md](./contracts/rpc.md).

Scope: **one new table, two new columns, one Dexie version, one new wire entry.** Nothing existing
is repurposed (ADR-0001 §2). No `origin` column or table anywhere (ADR-0004, FR-027).

## 1. Entities

### `public.workspaces` (existing, one column added)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | unchanged |
| `user_id` | uuid → `auth.users` | unchanged meaning: **creator/owner**, even in a team workspace |
| `name` | text | unchanged |
| **`kind`** | **text not null default `'personal'`** | **new.** `check (kind in ('personal','team'))`. Fixed at creation — pinned by `workspaces_zz_kind_fixed` (D-6) |
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

## 2. State and lifecycle

**Workspace kind.** `personal | team`, chosen at creation, immutable afterwards. The mutation is
*silently coerced* back (`new.kind := old.kind`) rather than raised, because a raise inside a sync
batch would abort the batch and stick the queue (D-6). A third value is refused loudly by
`workspaces_kind_check`.

**Membership.**

```
(absent) --add_member_by_email--> owner|member(deleted=false)
          --removeMember--------> member(deleted=true)      # access ends here, row remains
          --add again-----------> same row, deleted=false    # never a second row
```

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
ownerless cache rather than wiping it. ADR-0004's eventual `(origin, account)` key is formed by
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
| `workspaces_zz_kind_fixed` | before update | `new.kind := old.kind` — silent pin | D-6 |
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
