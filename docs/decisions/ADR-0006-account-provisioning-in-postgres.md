# ADR-0006 — Account provisioning lives in Postgres, kind is mutable, refusals do not wedge the queue

- **Status:** Proposed (coordinator), owner decision recorded 2026-09-13
- **Date:** 2026-09-13
- **Decider:** Andrii Tkhorenko (AndriyTkh) — fork owner, solo operator
- **Depends on:** ADR-0001 (fork contract), ADR-0004 (single origin per instance), ADR-0005
  (`schema.sql` is the canonical home of every definition)
- **Amends:** ADR-0001 §1 (workspace kind — now mutable, §D below) and ADR-0001 §3 (LWW lockstep —
  a bounded change to the *push* path that does not touch the conflict rule, §E below)

**On where the amendments live — explicit, as asked.** ADR-0001 is Accepted and merged; its own
amendment note says every change after the first commit gets a new number instead of an in-place
edit. So decisions C (kind mutable) and F (per-row refusal fallback) are recorded **here**, in this
ADR, as named amendments to ADR-0001 §1 and §3 — **not** as a new amendment note inside ADR-0001,
and **not** as two further ADRs. One owner session, one origin for all three decisions, one number.
`plan.md`'s D-6 (kind pinned immutable by trigger) and D-7 (refused rows assumed to take the silent
drop path) are superseded by §D and §E of this ADR respectively; a later agent updates the plan.

## Context

The fork's deployment shape is now decided (owner, 2026-09-13): **one deployment for everyone**.
The host runs one Supabase project and one Cloudflare static site, and every coworker opens that
same URL on their own device. This is exactly ADR-0004's single-origin instance — one origin, one
`auth.users`, no federation, nothing crossing an origin boundary.

That shape makes account creation the instance's front door, and today the front door is the
Supabase dashboard. The client is a static bundle holding only the anon key (`src/auth/supabase.ts`),
there is no server code anywhere in the deploy (Cloudflare Workers static assets), and the app
offers sign-in only — `src/auth/useSession.ts` exposes `signIn` and `signOut` and no `signUp`. So
the owner's stated onboarding model — *the admin keeps a list of logins in the app, creates them,
changes their passwords, removes them, and hands each coworker a URL and a credential* — has no
privileged place to execute today.

The owner has put that model **in P1 and in the first demo**, so the question "where does the
privilege live" can no longer be deferred to a later spec. Two adjacent decisions arrived in the
same session and are settled here with it, because both fall out of the same removal semantics:
whether a workspace's kind can change after creation, and what a client does with a row the backend
refuses.

Also relevant: the local stack's `supabase/config.toml` keeps `[auth] enable_signup = true`, because
the P0 harness provisions its test accounts through GoTrue's ordinary sign-up path. The hosted
project does not get to keep that.

## Decision

### A. One deployment, one origin

Restated, not re-decided (ADR-0004): one Supabase project and one static site per instance; every
coworker of that instance holds an account in **that** project's `auth.users`. No second origin is
involved in anything below, and nothing below needs schema support for one.

### B. Provisioning is a `security definer` Postgres routine, called by an admin with their own anon-key session

Login provisioning — create, set password, remove, and the admin grants themselves — is implemented
as `security definer` functions in `schema.sql` that write `auth.users` and `auth.identities`
directly:

- create: insert into `auth.users` with `encrypted_password = extensions.crypt(pw, gen_salt('bf'))`
  and `email_confirmed_at = now()`, plus the matching `auth.identities` row with `provider = 'email'`
  and `provider_id` equal to the new user id;
- set password: update `encrypted_password` the same way;
- remove: `delete from auth.users` — `auth.identities` cascades with it.

Each function refuses unless the caller is an instance admin (§C), and each validates its input
(§F) before touching anything.

**Probe-verified today** against the repo's own local stack (GoTrue v2.196.0): a login created this
way signs in with `signInWithPassword`; after a password update the old password is refused and the
new one works; after the delete, sign-in is refused. Zero new infrastructure, **no `service_role`
key anywhere** — not in the repo, not in a platform secret, not in a deploy — and the whole surface
is testable in the existing stack tier (supabase-js clients plus a direct pg connection), which is
the tier every other P1 claim is proven in.

Per ADR-0005 these definitions — including the functions and the trigger in §C, which live in the
`auth` schema's blast radius — are written in `supabase/schema.sql`, guarded and idempotent, and a
`migration-007-*.sql` is created only if a row backfill turns out to be needed.

### C. Two role layers: per-workspace, and instance admin

The per-workspace levels are unchanged: `owner` and `member` (ADR-0001 §1). A **second, independent
layer** is added for the instance itself:

- `public.instance_admins(user_id primary key, granted_by, created_at)` — a fork-owned table, purely
  additive, holding the flag. Not a column on `auth.users`, not a third membership level.
- **The first account ever created on the origin becomes admin structurally** — a trigger on
  `auth.users` insert that grants admin when, and only when, no admin exists yet. The host's own
  account is therefore an admin without anyone typing anything, and the instance is never adminless.
- An admin may grant and revoke admin on other logins. An admin **may not remove their own login**
  and **may not revoke the last admin**. Both guards are enforced in the routine, not in the UI.
- Only admins see the Logins section, and every provisioning routine refuses a non-admin caller.
- Instance admin is **not** a workspace permission. Any authenticated login may create workspaces
  and, as owner, add existing logins by email — US2's flow is untouched. An admin has no extra
  reach into anyone's workspaces or rows; RLS never reads `instance_admins`.

### D. Workspace kind is mutable — amendment to ADR-0001 §1

A workspace's kind may be switched at any time **by its owner**, in either direction. This
supersedes spec clarification Q3 and plan decision D-6 (which pinned kind with a trigger).

- **team → personal**: every membership of that workspace ends — the `members` rows are soft-deleted
  the same way any row is, and assignees clear through the existing removal path. A member whose
  team workspace turned personal sees it leave their list on their next pull, indistinguishably from
  having been removed.
- **personal → team**: the owner's own membership row is seeded, re-activating a previously
  soft-deleted one if there is one. **Members who were in it before are not restored**; the owner
  re-adds whoever should be there.
- Round-tripping (personal → team → personal → team) leaves exactly one owner membership row, never
  two.

Kind remains exactly two values; a third is still refused by the backend.

### E. A refused row does not wedge the queue — amendment to ADR-0001 §3

Today `src/sync/sync.ts` pushes each table as a batch upsert and catches per table
(`src/sync/sync.ts:274-277`). An RLS refusal is **not** a silent drop: PostgREST raises `42501` for
the whole batch, so one refused row keeps the entire table's queue failing and re-sending forever.
Removal, login deletion and team → personal all produce exactly that row.

Owner-approved, bounded change to the **push** path only:

- when a batch upsert errors, the push retries that batch **row by row**;
- a row refused on its own is dropped from the queue — marked clean, so the next pull's tombstone or
  its absence reconciles it;
- every other row in the batch proceeds, and no other table is stalled behind it.

**The conflict rule is untouched.** Client merge (`src/sync/sync.ts:409-458`) and the server
`keep_newer()` trigger (`supabase/schema.sql:142-153`) are not changed, so ADR-0001 §3's lockstep
invariant and the spec's FR-020 hold unchanged — this ADR amends §3 only to record that the push
path around the rule moved, and to require that the move be proven before it lands. The
`sync-engine` validation-map entry is re-verified in the same change set.

### F. Provisioning input rules

- The identifier must match `^[^@\s]+@[^@\s]+$` — GoTrue's sign-in path requires an email shape —
  and is lower-cased and trimmed **on the server**, not only in the form.
- Password minimum length 8.
- A duplicate identifier is refused with an error code distinct from every other failure; so are a
  malformed identifier and a short password.
- **Nothing is sent anywhere.** No verification mail, no magic link, no deliverability of any kind:
  these are shared credentials handed over out of band. An instance with no SMTP configured is a
  fully working instance.
- The password is never stored or logged client-side beyond the form field that is being typed into;
  the admin sees it only while typing it. There is no "show me the passwords" list, because there is
  nothing to show — only hashes exist.
- **Public sign-up is disabled on the hosted project** by the owner in the dashboard (a runbook
  step, not a repo change). The local `config.toml` keeps `enable_signup = true`, because the P0
  harness provisions its test users through GoTrue and that harness must keep passing unedited
  (FR-030).

## Alternatives considered

- **(a) Supabase Edge Function holding the platform-provided `service_role` env.** The textbook
  answer, and the fallback if a GoTrue upgrade breaks §B. Rejected for now: it adds a second
  deployable and a second runtime to a stack whose whole pitch is "one project, one static site",
  it puts a full-superuser key into the instance's blast radius where today there is none, and it
  is not exercisable from the existing stack tier without standing the function up in CI. Kept
  explicitly as the escape hatch: if the canary test in Consequences fails after a Supabase
  upgrade, this is what replaces §B, and it replaces it without changing anything the spec promises
  a user.
- **(b) Cloudflare Worker route with a secret binding.** Same shape as (a) with worse properties for
  this fork: it moves a Supabase superuser credential into a second vendor's secret store, turns the
  static-assets deploy into a server deploy, and makes the app's privileged path untestable against
  the local Supabase stack.
- **(c) Dashboard only — the status quo.** What the spec assumed until today. Rejected by the owner:
  it makes onboarding a coworker a database-administration task, and the first demo explicitly
  starts from the admin minting a login inside the app.
- **(d) Owner-side `signUp` through a throwaway client.** Needs no secret, but requires public
  sign-up to stay enabled on the hosted project, which is precisely the opposite of a closed team
  instance. Rejected on that ground alone.

## Consequences

- **The fork is coupled to GoTrue's internal table shape** — `auth.users` and `auth.identities`
  column names and the bcrypt hashing convention. This is the accepted risk of this decision, taken
  knowingly. It is pinned by a **canary test in the stack tier**: provision a login through the
  routine, sign in with it through supabase-js, set a new password, sign in again, remove it, fail
  to sign in. If a Supabase upgrade changes the shape, that test fails loudly on the next run rather
  than in production, and alternative (a) is the prepared answer.
- **Sign-up is disabled on the hosted origin** and enabled locally. The two configurations differ on
  purpose, and the difference is written down here so it is not "fixed" by making them match.
- **`auth`-schema functions and a trigger on `auth.users` live in `schema.sql`** (ADR-0005), which
  means an upstream merge touching that file now has one more hand-checked region. Upstream has no
  such definitions, so a conflict there means upstream grew something adjacent, which is worth
  noticing anyway.
- **Reviewer duty, standing:** a `service_role` key, or any credential at all, appearing anywhere in
  the repository or in a build is a finding, at any severity ceiling, no exceptions. So is a
  provisioning routine without its admin check, and so is an access policy that reads
  `instance_admins`.
- **Validation map:** a new HIGH-criticality entry, `account-provisioning`, covering the routines,
  the first-account trigger and the admin guards; the existing `sync-engine` entry returns to
  re-verification because of §E. Neither reaches `VALIDATED` without a receipt naming command,
  revision, date and the `(single-operator)` sign-off.
- **An orphaned team workspace is now structurally impossible through this path**: removal of a login
  that owns a team workspace is refused with its own error code (the spec's edge case), rather than
  leaving a workspace whose owner uuid no longer resolves. The cost is that the admin must delete or
  hand over those workspaces first, and ownership transfer does not exist in P1 — so in practice,
  delete first. P2 may add transfer.
- **Password self-service does not exist.** A coworker cannot change the password they were handed;
  the admin sets a new one. This is a real gap, scoped out of P1 deliberately, and it means a shared
  credential stays exactly as shared as the moment it was handed over.

## Reconsider when

- A GoTrue upgrade breaks the canary test — switch to alternative (a).
- Supabase publishes a supported, anon-key-reachable admin surface for user management — it replaces
  §B outright and removes the coupling.
- The instance grows past one host and a handful of coworkers, at which point shared out-of-band
  credentials and no self-service password change stop being proportionate.
- Anyone asks for an instance admin to be able to *see into* workspaces they are not a member of.
  That is not an extension of §C; it is a different access model and needs its own ADR.
