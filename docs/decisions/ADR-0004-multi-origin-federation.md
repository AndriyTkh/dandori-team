# ADR-0004 — Multi-origin federation: data never crosses origins

- **Status:** Accepted (target model; scheduling owner-controlled)
- **Date:** 2026-09-12
- **Decider:** Andrii Tkhorenko (AndriyTkh) — fork owner, solo operator
- **Amends:** ADR-0001 (fork contract) — see *Effect on ADR-0001* below
- **Affects:** ADR-0002 (phase gates), `docs/ARCHITECTURE.md` §0, §2, §3, §5

## Context

ADR-0001 settled *how a team workspace is shared*. It did not settle *where a team workspace
lives*, and the fork is self-hosted, so that question has an owner: whoever runs the Supabase
project.

Left unanswered, the default answer is "one Supabase project per team" — which means your private
workspaces, your notes and your projects sit inside infrastructure someone else controls. When
that person deletes the project, leaves the team, stops paying, or simply lets it lapse, your
own private data goes with it. For a tool whose selling point is self-hosting, that is the wrong
default: it recreates the dependency the fork exists to remove, one layer down.

**Free-tier capacity is explicitly not the driver here.** A five-person text workload (tasks,
notes, labels — no attachments) fits inside Supabase's 500 MB database / 5 GB egress allowance for
years; the free tier's real constraints are the two-active-project cap and the ~1-week inactivity
pause, neither of which a shared-vs-sovereign choice changes. This decision is about
**sovereignty**, not about quota. Recorded so a future reader does not "optimize" the model back
into one shared project on cost grounds that were never the reason.

## Decision

### The model

- **Each person hosts zero or one Supabase origin of their own.** Their private workspaces and
  their projects live there. That origin is theirs: nobody else's account deletion, billing lapse
  or change of mind can take it away.
- **Joining someone else's team workspace means holding an account on *that* origin.** You are a
  user of their Supabase project, in their `auth.users`, exactly as their own account is.
- **One local app profile manages an origin registry**: zero or one *hosted* origin (your own),
  plus an unlimited number of *joined* origins (other people's). The app presents them as one
  workspace list; underneath they are entirely separate backends.

### The invariant — load-bearing, everything else follows from it

> **Data never crosses origins.**

A shared workspace lives **wholly** on its host's origin. Its tasks, notes, labels, memberships
and assignee pointers all reference **that origin's own `auth.users`** and nothing else.

Concretely, and without exception:

- **No cross-origin foreign keys.** A row on origin A never references a row on origin B.
- **No identity federation.** There is no global account, no shared identity provider, no token
  minted on one origin and honoured on another. The same human holds separate, unrelated accounts
  on every origin they participate in, and those accounts know nothing about each other.
- **No cross-origin queries, joins, sync or mirroring.** The sync engine talks to one origin at a
  time and never relates two.
- **Private notes in a team context require your own origin.** If you want private material
  alongside a team workspace you do not host, you host an origin. This is a real limitation and
  it is the honest consequence of the invariant — it is not a gap to be closed later by a
  sync-back feature.

The invariant is what makes the model safe to reason about: every access question stays a
single-origin RLS question, which is precisely the question ADR-0001's replaced policies already
answer. Federation adds **no** schema support, no new policy shape, and no new trust boundary
inside the database. It is entirely a client-side composition of independent backends.

### What this is not

Not a distributed database, not eventual consistency across hosts, not a peer-to-peer protocol.
Two origins never talk to each other. Only the client holds more than one at once.

## Consequences

### (a) Origin configuration becomes runtime, not build-time

Today `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are `VITE_`-prefixed and therefore **inlined
at build time** (`README.md:42-69`, `src/auth/supabase.ts:6-10`): the artifact is welded to one
origin, and rotating a value is a redeploy.

An origin registry cannot work that way — one artifact must be able to address several origins,
chosen by the user at runtime. So origin config moves to runtime.

This is worth doing **regardless of federation**: one-artifact-any-origin is what self-hosting
wants anyway. Today, every self-hoster must build their own bundle to point it at their own
Supabase project. Runtime config makes a published build usable by anyone. Federation makes it
mandatory; self-hosting already made it desirable.

### (b) The whole client data layer becomes per-origin

Everything that is currently a singleton keyed to "the one backend" becomes keyed to an origin:

- **The Supabase client** — today a module-level singleton (`src/auth/supabase.ts:12-17`).
- **The auth session** — today one persisted `sb-*-auth-token` and one `useSession`
  (`src/auth/useSession.ts:28-41`). A device signed into three origins holds three live sessions
  at once.
- **The Dexie cache** — today one database named `dandori`, no per-account or per-origin suffix
  (`src/db/local.ts:28`), with a single `meta.owner` key (`src/db/local.ts:102-112`).
- **The offline queue and the sync loop** — today module-global state: one status, one session
  counter, one set of per-table cursors (`src/sync/sync.ts:21-22, 43-48, 88`).

**This generalizes the multi-account cache rework already flagged in ADR-0001 rather than adding
a second, competing one.** `claimCache`/`wipeLocal` exist because one cache could be claimed by
one owner; the per-origin model replaces "which owner claims the single cache" with "one cache
per (origin, account)". P1's rework should be written so this generalization is a widening, not a
rewrite — but P1 is **not** required to implement it (see (c)).

Note the asymmetry this creates in the sync status UI: a badge that today reports one global state
(`src/components/SyncBadge.tsx:11-19`) must eventually report per-origin state, or aggregate
honestly. Not a P1 concern; named so it is not discovered as a surprise.

### (c) Phasing — P1 is unaffected

- **P1 stays single-origin.** Membership and the replaced RLS predicates operate within one
  origin, which is all they ever need to do. **Federation requires zero schema support**, so
  nothing in P1's migration changes because of this ADR. P1 must not grow an "origin" column, an
  origin table, or any cross-origin notion — under this model such a thing would be wrong, not
  early.
- **The origin registry + per-origin client layer is its own phase item**, sitting at the
  **P2/P3 boundary**, and is **owner-scheduled** — it is not automatically the next thing after
  P1, and it is not a P3 prerequisite. The owner picks when it lands.
- **Runtime origin config (consequence (a)) may land independently and earlier** than the registry
  itself, because it stands on its own self-hosting merit. It is a small, testable change with no
  dependency on membership.

### (d) Effect on ADR-0001

ADR-0001 is amended, not superseded:

- Its *additive tables, replaced policies* rule is untouched and is in fact reinforced —
  federation adds nothing to the schema, so the fork's entire database divergence from upstream
  remains exactly what ADR-0001 described.
- Its "self-hosted deploy: Cloudflare Workers + hosted Supabase" stays true **per origin**. Each
  person's origin is a Supabase project; the static app may be deployed once and pointed anywhere.
- Its `multi-account-cache` component is re-scoped as described in (b).
- Nothing in ADR-0001 contradicts this ADR. The full contradiction sweep is recorded in the
  amendment note in ADR-0001 and in `docs/ARCHITECTURE.md` §6.

## Reconsider when

- Someone asks for a workspace shared **across** two origins. Under this model that is not a
  feature request, it is a request to delete the invariant; it needs a new ADR that replaces this
  one wholesale, not an exception carved into it.
- Private-notes-without-your-own-origin becomes the dominant complaint. The answer inside this
  model is "host an origin"; if that answer stops being acceptable, the model is wrong and should
  be replaced rather than patched.
- The agent layer (P3) needs an identity that spans origins — worth checking early, because the
  `dandori` CLI syncing task files for a person who participates in three origins is the first
  place the invariant will be tested in practice.
