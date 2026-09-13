# Contract — backend operations exposed to the client

002-team-workspaces adds **eight** callable backend operations: two for membership (below), and six
for the instance-admin layer that mints and manages logins (ADR-0006 §B/§C, plan D-16). Everything
else the feature does reaches the database through the existing generic sync loop and needs no
contract of its own. See [../plan.md](../plan.md) D-9 (why they exist and how they are layered),
D-5 (the helpers they use) and D-16 (the provisioning surface). The DDL for blocks A–D is in
[policies.sql](./policies.sql); the provisioning routines are fork block E, and **this file is
authoritative for them**.

Every one of the eight is `security definer`, every one is **revoked from `public` and `anon`** and
granted only to `authenticated`. PostgREST publishes every function in `public` as an RPC endpoint;
without the revoke, `add_member_by_email` would be a membership-granting endpoint reachable with no
caller identity, and `create_login` would be an open account factory (plan R-3). The two membership
functions carry `set search_path = public, auth, pg_temp`; the provisioning routines carry
`set search_path = public, auth, extensions, pg_temp`, because they call `extensions.crypt` and
`extensions.gen_salt` (plan R-17).

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

**Freshness / offline.** The call itself is online-only by construction. Owner question Q-A is
**answered: Option B** — the returned `member_id → email` pairs are cached per-device in Dexie `meta`
under `member-email:<uuid>` keys, rendered from cache while offline, and overwritten by the next
successful call. The cache is display-only and never authoritative: it grants nothing, and
`wipeLocal()` already clears `meta`, so a device switching accounts loses it (plan D-12).

---

# The instance-admin surface (ADR-0006, FR-037..FR-046)

A second, independent role layer: instance admin, held in `public.instance_admins` (policies.sql,
fork block D). It is **not** a workspace permission — no access policy reads that table, and an admin
has no extra reach into anyone's rows (FR-039). Every routine below is admin-gated in the routine
itself, never only in the UI (FR-038, SC-018).

**Shared preconditions.** Each of the five provisioning routines begins with

```sql
if not public.is_admin() then
  raise exception using errcode = 'DA001', message = 'not an instance admin';
end if;
```

and each validates its input (FR-042) before touching anything. Nothing is emailed, ever: no
verification mail, no magic link, no recovery flow. An instance with no SMTP configured is a fully
working instance (ADR-0006 §F).

## `public.is_admin() returns boolean`

Whether the calling session holds instance admin. Any authenticated caller may ask about
**themselves**; there is no form of this function that asks about someone else. Never raises.
Defined in policies.sql fork block D because `instance_admins` has RLS enabled and no policy, which
makes this function the only way the flag is readable at all (plan D-17).

## `public.create_login(email text, password text, admin boolean default false) returns table (user_id uuid, email text, is_admin boolean)`

Mints a login on this origin. FR-040, US7 acceptances 1–4.

**Authorization**: admin only — `DA001`.

**Input rules** (FR-042), applied in this order, all server-side:

| SQLSTATE | Condition |
|---|---|
| `DA001` | caller is not an instance admin |
| `DA010` | identifier does not match `^[^@\s]+@[^@\s]+$` after `lower(trim(...))` |
| `DA011` | `length(password) < 8` |
| `DA012` | an `auth.users` row already holds that normalised identifier |

**Effect** — the exact column set, probe-verified against this repo's own local stack on 2026-09-13
(GoTrue **v2.196.0**): a login inserted with these columns signs in through
`supabase.auth.signInWithPassword` with no further step. This shape is the contract; it is what the
R-15 canary test pins.

```sql
-- 1. the account
insert into auth.users (
  instance_id,               -- '00000000-0000-0000-0000-000000000000'
  id,                        -- gen_random_uuid(), kept as uid below
  aud,                       -- 'authenticated'
  role,                      -- 'authenticated'
  email,                     -- lower(trim(email))
  encrypted_password,        -- extensions.crypt(password, extensions.gen_salt('bf'))
  email_confirmed_at,        -- now()  -- no verification mail is ever sent
  raw_app_meta_data,         -- '{"provider":"email","providers":["email"]}'::jsonb
  raw_user_meta_data,        -- '{}'::jsonb
  created_at, updated_at,    -- now(), now()
  confirmation_token,        -- ''   <- empty string, NOT null: GoTrue scans these columns
  recovery_token,            -- ''
  email_change_token_new,    -- ''
  email_change,              -- ''
  is_sso_user                -- false
) values (...);

-- 2. the email identity, without which signInWithPassword does not resolve the account
insert into auth.identities (
  id,                        -- gen_random_uuid()
  user_id,                   -- uid
  provider_id,               -- uid::text
  identity_data,             -- jsonb_build_object('sub', uid::text, 'email', <email>, 'email_verified', true)
  provider,                  -- 'email'
  last_sign_in_at,           -- now()
  created_at, updated_at     -- now(), now()
) values (...);
```

If `admin` is true, a row is also inserted into `public.instance_admins` with
`granted_by = auth.uid()`.

**Returns** one row: the new `user_id`, the normalised `email`, and `is_admin`. The client shows the
new login in the list immediately, without a round trip through `list_logins()`.

**The password never persists client-side** (FR-044): it exists in a `type=password` field until the
call returns, is never written to Dexie, never put in a URL, and never logged. Only hashes exist
server-side, which is why there is no "show me the passwords" view to build.

## `public.set_login_password(user_id uuid, password text) returns void`

Replaces a login's password. FR-040, US7 acceptance 5.

**Authorization**: admin only — `DA001`. An admin may set their own password through this routine;
that is the only self-service path in P1 (a coworker cannot change their own — ADR-0006 Consequences).

**Errors**: `DA001`, `DA011` (shorter than 8), `DA404` (no such login).

**Effect**: `update auth.users set encrypted_password = extensions.crypt(password,
extensions.gen_salt('bf')), updated_at = now() where id = user_id`. Probe-verified: after this, the
old password is refused and the new one signs in. Existing sessions on other devices are **not**
revoked by this — it changes the credential, not the issued JWTs, and the spec does not promise
otherwise.

## `public.delete_login(user_id uuid) returns void`

Ends a login's access to the instance. FR-040, FR-045, US7 acceptances 6–8, SC-016.

**Authorization**: admin only — `DA001`.

**Errors**

| SQLSTATE | Condition |
|---|---|
| `DA001` | caller is not an instance admin |
| `DA404` | no such login |
| `DA013` | the target is the caller — an admin may not remove their own login |
| `DA014` | the target owns at least one live (`deleted = false`) workspace with `kind = 'team'` |

`DA014` is what makes an orphaned team workspace structurally impossible: the admin deletes or
empties those workspaces first. Ownership transfer does not exist in P1.

**Effect — ban, not `delete from auth.users`.** ADR-0006 §B says delete; the schema says it cannot
be. Every fork- and upstream-owned data table declares

```sql
user_id uuid not null references auth.users (id) on delete cascade
```

(`supabase/schema.sql` — `workspaces:18`, `labels:32`, `tasks:44`, `notes:81`). Deleting the
`auth.users` row would therefore cascade away **every task, label and note that login ever created**,
including the ones sitting in a team workspace that other people are still using — which directly
violates the spec's "their rows remain, the creator id is kept" and SC-016. So the routine bans:

```sql
update auth.users
   set banned_until        = 'infinity',
       encrypted_password  = extensions.crypt(gen_random_uuid()::text || gen_random_uuid()::text,
                                              extensions.gen_salt('bf')),
       updated_at          = now()
 where id = target;

delete from public.instance_admins where user_id = target;     -- loses the flag too

update public.members
   set deleted = true, updated_at = greatest(updated_at, now())
 where member_id = target and not deleted;                     -- every membership ends
```

The `members` update goes through the ordinary removal path, so `members_zz_clear_assignee` fires
per row and clears that person's assignees exactly as a manual removal does (FR-014). The banned
login is refused at sign-in by GoTrue; its rows, its authorship and its history stay. Removing a
login is therefore **not** reversible into "never existed" — it is reversible only by an admin
setting a new password and lifting the ban, which P1 does not expose. Recorded as risk R-18.

## `public.set_login_admin(user_id uuid, admin boolean) returns void`

Grants or revokes instance admin. FR-038, US7 acceptances 9–10.

**Authorization**: admin only — `DA001`.

**Errors**: `DA001`, `DA404` (no such login), `DA015` — revoking would leave the instance with **no**
admin. An admin may revoke themselves, as long as another admin remains; the last one cannot be
removed by anybody, including themselves. Combined with the first-account trigger (policies.sql fork
block D), the instance is adminless in no reachable state.

**Effect**: insert into or delete from `public.instance_admins`, `granted_by = auth.uid()` on insert,
idempotent in both directions.

## `public.list_logins() returns table (user_id uuid, email text, is_admin boolean, created_at timestamptz)`

The Logins section's list. FR-040, FR-043.

**Authorization**: admin only. Unlike `workspace_member_emails`, this one **raises `DA001`** rather
than returning zero rows: a non-admin has no legitimate reading of an empty list here, and the
distinction between "no logins" and "not allowed" matters for the receipt (SC-018 asserts the
refusal, not an empty result).

**Returns** four fields, ordered by `created_at`. No password hash, no metadata, no confirmation or
ban state beyond what is listed — the list exists to be acted on, not to profile people.

---

## Client layering

FR-026 says the interface reaches data only through `src/db/api.ts`; `ARCHITECTURE.md` §2 says
`db-api` never touches the network. An email→uuid lookup and every provisioning call are inherently
online, so:

```
component  ->  src/db/api.ts        ->  src/sync/sync.ts        ->  PostgREST rpc
               addMemberByEmail()       addMemberByEmailRemote()
               memberEmails()           memberEmailsRemote()
               isAdmin()                isAdminRemote()          (+ Dexie meta cache, D-17)
               createLogin()            createLoginRemote()
               setLoginPassword()       setLoginPasswordRemote()
               deleteLogin()            deleteLoginRemote()
               setLoginAdmin()          setLoginAdminRemote()
               listLogins()             listLoginsRemote()
               removeMember()       ->  Dexie write + queue()   (no network at all)
               listMembers()        ->  Dexie read              (no network at all)
```

`src/sync/sync.ts` stays the only module holding the Supabase client; `src/db/api.ts` stays the UI's
only door. The rule that bends — every `db-api` mutator being offline-capable — is recorded in the
plan's Complexity Tracking rather than absorbed silently. The provisioning mutators bend it further
and deliberately: they are **online-only**, never queued, and fail loudly when offline, because a
queued account creation would be a credential sitting in Dexie (FR-044).

**Removal is not an RPC.** `removeMember` is an ordinary soft-delete write plus `queue()`, exactly
like `deleteTask`, carried by the generic push. That is what makes it work offline and what puts it
under the same LWW rule as everything else (plan D-8). A removed member's already-queued edit is
refused by RLS with `42501`; it does not wedge the queue, because of the per-row fallback in plan
D-18 (FR-041).

**Kind switching is not an RPC either.** Flipping `workspaces.kind` is an ordinary column write on an
ordinary synced row; the consequences are a backend trigger (policies.sql,
`workspaces_zz_kind_change`), not a call (plan D-6′, FR-034..FR-036).

---

## Error-code register

One table, so a code is never reused for two meanings.

| Code | Raised by | Meaning |
|---|---|---|
| `DA001` | all eight | caller lacks the required authority (workspace owner, or instance admin) |
| `DA404` | `add_member_by_email`, `set_login_password`, `delete_login`, `set_login_admin` | the named account does not exist on this origin |
| `DA010` | `create_login` | malformed identifier |
| `DA011` | `create_login`, `set_login_password` | password shorter than 8 characters |
| `DA012` | `create_login` | identifier already in use |
| `DA013` | `delete_login` | refusing to remove the caller's own login |
| `DA014` | `delete_login` | the login owns a live team workspace |
| `DA015` | `set_login_admin` | refusing to revoke the last remaining admin |
| `42501` | any ordinary table write | RLS refusal — not an RPC code; handled by the push fallback (plan D-18) |
