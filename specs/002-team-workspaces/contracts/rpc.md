# Contract — backend operations exposed to the client

002-team-workspaces adds exactly **two** callable backend operations. Everything else the feature
does reaches the database through the existing generic sync loop and needs no contract of its own.
See [../plan.md](../plan.md) D-9 (why they exist and how they are layered) and D-5 (the helpers they
use). The DDL is in [policies.sql](./policies.sql).

Both are `security definer`, both carry `set search_path = public, auth, pg_temp`, and both are
**revoked from `public` and `anon`** and granted only to `authenticated`. PostgREST publishes every
function in `public` as an RPC endpoint; without the revoke, `add_member_by_email` would be a
membership-granting endpoint reachable with no caller identity (plan R-3).

---

## `public.add_member_by_email(ws uuid, email text) returns public.members`

Adds a person to a team workspace by their email address on **this** origin. FR-007, FR-008.

**Authorization**: `public.is_owner(ws)` must be true. Otherwise raises `DA001`. A member (not
owner) calling this is refused (FR-015, US2 acceptance 3).

**Lookup**: `auth.users.email` compared `lower(trim(...))` on both sides. Supabase stores emails
lower-cased; the owner types free text, and without normalising, an existing account would report
"no account on this origin" — SC-010's message pointing at the wrong cause (plan R-13).

**Effect** on success:

```sql
insert into public.members (id, user_id, workspace_id, member_id, level)
values (gen_random_uuid(), auth.uid(), ws, <found uuid>, 'member')
on conflict (workspace_id, member_id)
do update set deleted = false, updated_at = now()
returning *;
```

Re-adding a removed person flips the **same** row back — never a second row (US2 acceptance 6).
Adding the owner's own email hits the same conflict target and returns the existing `owner` row with
`deleted` already false: no duplicate, and **no demotion to `member`** (edge case 5) — the
`do update` set-list deliberately does not touch `level`.

**Errors**

| SQLSTATE | Meaning | Client rendering |
|---|---|---|
| `DA001` | caller is not an owner of `ws` | generic refusal; the affordance should not have been offered |
| `DA404` | no account with this email exists on this origin | the dedicated translated string `members.noAccountHere` |

The client branches on `error.code`, never on the message text — so the Russian interface renders a
Russian string while the server stays English (FR-008: "distinguishable from every other failure").
**No row of any kind is created on the `DA404` path** (SC-010): the lookup precedes the insert inside
one statement-level transaction.

**Returns** the membership row, which the caller writes straight into Dexie so the member list is
correct before the next pull.

---

## `public.workspace_member_emails(ws uuid) returns table (member_id uuid, email text, level text)`

Displays the people in a team workspace. FR-007.

**Authorization**: returns **zero rows** unless `public.is_member(ws)` — a refusal is indistinguishable
from an empty workspace to a non-member, which is what US2 acceptance 5 asks for.

**Why this instead of a `profiles` table.** A mirrored copy of the email drifts the moment an account
changes it, and nothing keeps the mirror honest. FR-007 and clarification Q1 forbid the second copy
outright. A `security definer` function reading `auth.users` at call time cannot drift and never makes
the account table readable: it returns only the co-members of a workspace the caller belongs to, and
only these three fields — no password hash, no metadata, no confirmation state.

**Freshness / offline.** Online-only by construction. Whether the returned emails may be cached
per-device in Dexie `meta` is **open — owner question Q-A in plan.md**. Until it is answered,
implement Option A (no cache) and keep the call site in one function so switching to Option B is a
local change.

---

## Client layering

FR-026 says the interface reaches data only through `src/db/api.ts`; `ARCHITECTURE.md` §2 says
`db-api` never touches the network. An email→uuid lookup is inherently online, so:

```
component  ->  src/db/api.ts        ->  src/sync/sync.ts        ->  PostgREST rpc
               addMemberByEmail()       addMemberByEmailRemote()
               memberEmails()           memberEmailsRemote()
               removeMember()       ->  Dexie write + queue()   (no network at all)
               listMembers()        ->  Dexie read              (no network at all)
```

`src/sync/sync.ts` stays the only module holding the Supabase client; `src/db/api.ts` stays the UI's
only door. The rule that bends — every `db-api` mutator being offline-capable — is recorded in the
plan's Complexity Tracking rather than absorbed silently.

**Removal is not an RPC.** `removeMember` is an ordinary soft-delete write plus `queue()`, exactly
like `deleteTask`, carried by the generic push. That is what makes it work offline and what puts it
under the same LWW rule as everything else (plan D-7, D-8).
