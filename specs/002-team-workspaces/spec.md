# Feature Specification: P1 Team Workspaces — the minimal team transform

**Feature Branch**: `002-team-workspaces`

**Created**: 2026-09-13

**Status**: Draft

**Input**: User description: "P1 — minimal team transform, to the first demo. A workspace is `kind: personal` (exactly upstream's behaviour, byte-for-byte) or `kind: team`. A team workspace has two-level membership: `owner` (invite members, remove members, delete the workspace, plus everything a member may) and `member` (create/read/edit/delete tasks, labels, notes). Access to a team workspace's rows is resolved through membership instead of the row's `user_id`; `user_id` keeps meaning 'who created the row'. Every `own_rows` RLS policy on the four tables has BOTH halves replaced separately, preserving the existing read/write asymmetry. Triggers behave identically after the swap. A nullable per-task `assignee` points at a user of the same origin, carries no authorization meaning, and is auto-cleared when that member is removed. Members are shown by email; the owner adds a member by email and that member must already hold an account on this same origin. Minimal UI only. First demo: two accounts on one deployment."

## Clarifications

### Session 2026-09-13

- Q: How is a member's email shown to co-members? → A: Through a purpose-built, narrowly-scoped
  backend read path that returns emails only to co-members of the same workspace. The account
  table is never made readable and no second copy of the email is stored.
- Q: Can ownership move (promote, transfer, owner leaves)? → A: No. In P1 a team workspace has
  exactly one owner, its creator; the owner cannot be removed and cannot leave; the workspace ends
  by deletion. A workspace whose owner's account disappears is resolved by the operator in the
  Supabase dashboard — an accepted consequence. **Narrowed 2026-09-13 (late):** FR-045 now prevents
  that state from being reachable through the app at all — removing a login that owns a team
  workspace is refused.
- Q: Can a workspace change kind after creation? → A: No. Kind is fixed at creation in P1, in
  either direction. — **SUPERSEDED 2026-09-13 (late) by owner decision C below: kind is switchable
  at any time by the workspace owner, in either direction.**
- Q: Story priorities vs phase gates? → A: `Priority: P1/P2` on user stories is this
  specification's own ordering of stories; it is unrelated to the fork's phase gates P0–P3. Every
  story here ships inside phase P1.

#### Owner gate, 2026-09-13 (evening)

- Spec, plan, tasks, ADR-0005 adoption: **approved** by the owner.
- Q-A member emails: **Option B adopted** — per-device, unsynced Dexie `meta` cache
  (`member-email:<uuid>`), refreshed on each successful `workspace_member_emails` call, cleared by
  `wipeLocal()`. Clarification Q1's prohibition is read as "no second *synced/authoritative* copy";
  a derived per-device cache is inside the rule. FR-007 stays; one sentence is added to FR-007's
  text noting the derived cache.
- Q-B F-5: **option (b) approved** — re-recorded as an accepted risk, owner Andrii Tkhorenko,
  2026-09-13, expiry end of P2 (Playwright, ADR-0003).
- ADR-0001 Consequences wording on the cache rework: **amendment approved** (D-10 stands: cache
  unchanged in P1, Dexie v3 additive) — lands as an amendment note in ADR-0001, not a new ADR.
- T004's single FR-030 exception: **approved**.
- `src/i18n/` owned by `ui` for key additions: **approved**.

### Session 2026-09-13 (late) — owner decisions A–G

Final. Recorded to be encoded, not re-litigated. ADR-0006 carries the reasoning for B–G.

- **A — One deployment for everyone.** The host runs **one** Supabase project and **one** Cloudflare
  static site; every coworker opens that same URL on their own device. This is ADR-0004's
  single-origin instance, stated as an Assumption below. No federation, no second origin, nothing
  crossing an origin boundary.
- **B — In-app login provisioning is in P1 and in the first demo.** An instance admin creates logins
  — an email-shaped identifier and a password — **with no email verification and no deliverability
  of any kind**. They are shared credentials, handed to the coworker out of band. The admin can list
  logins, set a new password on one, and remove one. The Google-Docs analogy the owner used: you
  share by adding people; here the admin also mints the people.
- **C — Workspace kind is switchable at any time** by the workspace owner: team ("public/shared", in
  the owner's words) ↔ personal ("private"). Supersedes clarification Q3. Semantics, decided by the
  coordinator and recorded here: **team → personal** ends every membership of that workspace (its
  `members` rows are soft-deleted; assignees clear through the existing removal path), and a member
  sees the workspace leave their list on their next pull, exactly as removal looks. **personal →
  team** seeds the owner's membership row, re-activating a previously soft-deleted one if present;
  **members who were in it before are not restored** — the owner re-adds them.
- **D — Roles are two independent layers.** Per-workspace `owner`/`member` is unchanged. A new
  **instance admin** flag sits beside it: the **first account ever created on the origin becomes
  admin structurally** (a trigger on account insert, granting only while no admin exists); admins may
  grant and revoke admin on other logins; an admin **cannot remove their own login** and **cannot
  revoke the last admin**. Only admins see the Logins section and only admins may provision. Any
  authenticated login may create workspaces and, as owner, add existing logins by email — US2's flow
  is untouched. Instance admin grants **no** reach into anyone's workspaces or rows.
- **E — Where the privilege lives: in Postgres.** Coordinator decision, probe-verified 2026-09-13
  against the repo's local stack (GoTrue v2.196.0): `security definer` routines write `auth.users`
  and `auth.identities` directly (bcrypt via `extensions.crypt`/`gen_salt`, `email_confirmed_at`
  stamped, identity `provider='email'`). Create → `signInWithPassword` succeeds; password update →
  the old password is refused; delete → sign-in is refused. **Zero new infrastructure, no
  `service_role` key anywhere**, testable in the existing stack tier. The coupling to GoTrue's
  internal table shape is the accepted risk, pinned by a canary test that provisions a login and
  signs in with it. Fallback if a GoTrue upgrade breaks it: a Supabase Edge Function using the
  platform-provided service role — recorded as ADR-0006's rejected-for-now alternative (a), with
  dashboard-only as (c). On the **hosted** project the owner disables public sign-up in the
  dashboard (a runbook step); the **local** `config.toml` keeps sign-up enabled, because the P0
  harness provisions its test users through GoTrue and must keep passing unedited.
- **F — A refused queued row must not wedge the queue.** US6 acceptance 6 already promised this, but
  plan decision D-7 assumed RLS refusals travel the silent-drop path. They do not: PostgREST raises
  `42501` for the **whole** upsert batch, and `src/sync/sync.ts:274-277` catches per table and
  re-sends forever. Owner-approved scope, bounded to the **push** path: when a batch upsert errors,
  the push retries that batch **row by row**; a row refused on its own is dropped from the queue
  (marked clean — the next pull's tombstone or its absence reconciles it) and the rest proceed. The
  LWW merge rule and `keep_newer()` are **untouched**, so FR-020's lockstep is intact. Required by
  member removal, by login removal and by team → personal alike. The `sync-engine` map entry is
  re-verified in the same change set.
- **G — Provisioning input rules.** The identifier MUST match `^[^@\s]+@[^@\s]+$` (GoTrue's sign-in
  requires an email shape) and is lower-cased and trimmed **on the server**; the password MUST be at
  least 8 characters; a duplicate identifier is refused with its **own** error code, distinct from
  every other failure. Nothing is sent anywhere. Passwords are never stored or logged client-side
  beyond the form field being typed into — the admin sees a password only while typing it.

## User Scenarios & Testing *(mandatory)*

`Priority:` on a story is this specification's own ordering, not a phase gate (see
Clarifications).

The actors are **A**, who hosts this origin and creates workspaces on it, and **B**, who holds an
account on the same origin and is added to one of A's workspaces. A is also this instance's
**admin** — the first account ever created here, which is what makes it one (decision D) — and B's
login exists because A minted it (decision B). A third actor, **C**, appears only where a second
admin or a second non-admin is needed to prove a guard. Every claim below is proven the
way ADR-0002/ADR-0003 require: **two supabase-js clients in one vitest process against the local
supabase stack**, with the real schema, the real policies and the real triggers — never a browser,
never a stand-in that re-states the rule under test.

This feature is the first one in the fork that can leak one account's rows to another. Every story
is therefore written so that its evidence fails if *either half* of an access rule changes.

### User Story 1 - A workspace can be created as a team workspace (Priority: P1)

A signed-in person creates a workspace and chooses, at creation, whether it is a personal workspace
(what upstream ships) or a team workspace. Everything created before this feature, and everything
created without choosing, is personal.

**Why this priority**: It is the switch every other story hangs off. Without a durable, defaulted
`kind`, "team" has nothing to attach to and "personal must not regress" has nothing to assert
against.

**Independent Test**: Create one workspace of each kind and read them back; confirm a workspace
created by an unmodified client, and every workspace that already existed, reads as personal.

**Acceptance Scenarios**:

1. **Given** an existing deployment with workspaces created before this feature, **When** they are
   read after the change is applied, **Then** every one of them is personal — no row changed value,
   no row became team by omission.
2. **Given** a signed-in person, **When** they create a workspace without expressing a choice,
   **Then** it is personal.
3. **Given** a signed-in person, **When** they create a workspace and choose team, **Then** it is a
   team workspace and they are recorded as its owner in the same act — a team workspace never exists
   with nobody able to administer it.
4. **Given** any workspace, **When** anything attempts to set its kind to a third value, **Then** the
   write is refused by the backend, not merely discouraged by the interface.

---

### User Story 2 - The owner adds and removes members by email (Priority: P1)

The owner of a team workspace sees who is in it, listed by email, and can add another person by
typing that person's email. The person must already hold an account on this same origin — there is
still no self-service sign-up; an account exists because an instance admin minted it (US7). The
owner can also remove a member.

**Why this priority**: Membership is the access rule. It is the workspace-level administrative
surface this feature adds — the instance-level one is US7 — and its mistakes are the silent kind.

**Independent Test**: With two accounts on the local stack, add the second by email, list members,
remove, list again — all at the data-access layer, no interface involved.

**Acceptance Scenarios**:

1. **Given** A owns a team workspace and B holds an account on the same origin, **When** A adds B by
   B's email, **Then** B is a member of that workspace and appears in its member list, shown by
   email.
2. **Given** A types an email that has no account on this origin, **When** A submits it, **Then**
   nothing is added, A is told plainly that no such account exists on this origin, and no placeholder,
   pending or invitation row is created anywhere.
3. **Given** B is a member, **When** B attempts to add or remove anyone, **Then** the backend refuses
   — member is not a level that administers membership, and the refusal does not depend on the
   interface hiding a button.
4. **Given** A removes B, **Then** B immediately stops being able to read or write that workspace's
   rows, and B's own personal workspaces are untouched.
5. **Given** A lists the members of a workspace A is not in, **Then** A receives nothing — the member
   list of a workspace is visible only to that workspace's own members.
6. **Given** A adds B a second time, **Then** the result is still exactly one membership row for B,
   not two.

---

### User Story 3 - A member reaches the team workspace's rows, and nothing else (Priority: P1)

B, a member, reads and writes the tasks, labels and notes of the team workspace as freely as A does.
B can reach nothing else of A's: not A's personal workspaces, not A's other team workspaces, not any
row in them. Access is decided by membership, not by who created the row.

**Why this priority**: This is the transform. It is also the fork's worst possible failure — one
account's rows on another account's screen — and the least likely to be noticed by hand.

**Independent Test**: Two authenticated clients against the local stack, each attempting reads and
writes across the other's boundary, asserting outcomes on both sides.

**Acceptance Scenarios**:

1. **Given** B is a member of A's team workspace, **When** B lists that workspace's tasks, labels and
   notes, **Then** B receives them — including rows A created.
2. **Given** B is a member, **When** B creates, edits and deletes a task, a label and a note in that
   workspace, **Then** each write succeeds, and the created rows record B as their creator while
   remaining visible to A.
3. **Given** B is a member of one of A's workspaces, **When** B lists workspaces, **Then** B sees the
   team workspace and B's own workspaces, and **zero** of A's personal workspaces.
4. **Given** B knows the identifier of a workspace B is not a member of, **When** B attempts to create
   a child row in it, **Then** the write is refused — knowing an identifier grants nothing.
5. **Given** the read rule were tightened to match the write rule, or the write rule loosened to match
   the read rule, **Then** at least one check fails — the asymmetry that exists today is pinned in
   both directions after the swap, exactly as it was before it.
6. **Given** B is removed from the workspace, **When** B repeats scenarios 1 and 2, **Then** every one
   of them now returns nothing or is refused.

---

### User Story 4 - A's personal experience is unchanged (Priority: P1)

A, who does not use team workspaces at all, cannot tell this feature shipped. The same rows, the same
sync behaviour, the same views, the same sign-in and sign-out.

**Why this priority**: It is the fork's load-bearing invariant (ADR-0001 §6). A team planner that
quietly degrades the personal planner has failed at the thing the fork promised to preserve.

**Independent Test**: The P0 suite, unchanged, run against the transformed schema. Its passing *is*
the test — no new assertions needed to state the invariant, only to extend it.

**Acceptance Scenarios**:

1. **Given** the P0 evidence written in `001-validation-spine`, **When** it runs against the
   transformed schema and client, **Then** every check passes **without any edit to those checks**.
2. **Given** a personal workspace, **When** its rows are read and written by their owner and by a
   second account, **Then** the outcomes are identical to what they were before this feature — the
   owner reaches everything, the other account reaches nothing.
3. **Given** a personal workspace, **When** it is deleted, **Then** the cascade and the
   stay-deleted behaviour are observably the same as before.
4. **Given** an upstream (unmodified) client pointed at the transformed backend, **When** it is used
   against personal workspaces, **Then** it works, and it can see no team workspace at all.

---

### User Story 5 - A task can be marked as someone's (Priority: P2)

Inside a team workspace, a task can carry an assignee — one person, chosen from that workspace's
members, shown on the task. It is a label, nothing more: it grants nothing, restricts nothing, and
no access decision reads it. When that person is removed from the workspace, their assignments in it
clear themselves, so a task never points at someone who is no longer there.

**Why this priority**: It is the smallest thing that makes a shared board mean something, and it is
independent of the access transform — the demo is still a demo without it, which is why it is P2 and
not P1.

**Independent Test**: Set an assignee, read it back from the other account, remove that member,
observe the assignment cleared — all at the data layer.

**Acceptance Scenarios**:

1. **Given** a team workspace with members A and B, **When** A sets B as a task's assignee, **Then**
   B's identity is stored on the task and both A and B see it on that task.
2. **Given** an assigned task, **When** the assignee is cleared, **Then** the task reads as
   unassigned, which is also its default state.
3. **Given** an assigned task, **When** the assignee is removed from the workspace, **Then** the
   task's assignee becomes empty — enforced by the backend, and still true for a client that was
   offline while it happened.
4. **Given** a task assigned to B, **When** B is removed from the workspace, **Then** B's access ends
   and nothing about the assignment slowed, blocked or survived that removal.
5. **Given** any access question about any row, **Then** its outcome is identical whether or not the
   row carries an assignee — assignment is never an input to an access decision.
6. **Given** an attempt to assign a task to someone who is not a member of that workspace, **Then**
   the write is accepted with the assignee coerced to `null`. **Coordinator correction 2026-09-14
   (T014 closer's finding):** this clause previously read "the write is refused". It was wrong, and
   plan decision D-3 with `contracts/policies.sql:164-178` says why — `assignee_must_be_member` does
   `new.assignee := null; return new;` and never raises, because a raise inside a sync batch would
   abort the whole upsert and wedge the tasks queue. Coercion, not refusal. FR-016's last sentence
   carried the same error and is corrected with it.

---

### User Story 6 - A member's offline edit survives the round trip (Priority: P2)

B edits a team task while offline, comes back online, and the edit reaches A. The conflict rule that
decided this before the transform decides it the same way after it, and the local cache still belongs
to exactly one account at a time.

**Why this priority**: The transform changes who may write a row, which is the input to the sync
path that P0 pinned. Evidence that the pinned behaviour survived the change is what keeps the
lockstep invariant a contract rather than a hope.

**Independent Test**: The P0 offline round-trip and conflict checks, repeated with a team workspace
and a non-creating member as the writer.

**Acceptance Scenarios**:

1. **Given** B is a member and offline, **When** B edits a team task, **Then** the edit is held
   locally and marked unsent; **When** B reconnects, **Then** it is accepted and A sees it.
2. **Given** two members edit the same team row and one edit is older, **When** both arrive, **Then**
   the older loses — at the backend and, independently, at the client merge step, exactly as P0 pinned
   it for personal rows.
3. **Given** membership and assignee information, **When** a client syncs, **Then** that information
   reaches the local cache and the sync engine like any other synced data, and a client that was
   offline learns about a membership change on its next cycle.
4. **Given** a device whose cache was claimed by A, **When** B signs in on it, **Then** the cache is
   wiped before any of B's data is drawn, and the stored pull positions are cleared with it.
5. **Given** a device whose cache was claimed by A, **When** A signs in again — now reaching a team
   workspace A did not reach before — **Then** **nothing** is wiped. Team mode changes what one
   account can reach, never how many accounts a device holds.
6. **Given** B was removed from the workspace while offline with unsent edits to it — and equally,
   **Given** the workspace was switched to personal, or B's login was removed, while B was offline —
   **When** B reconnects, **Then** those edits are refused by the backend, **and** each refused row
   is **dropped** from B's queue rather than re-sent on every subsequent cycle, **and** B's other
   queued rows in the same batch, and every other table, are sent and accepted in that same cycle.
   A refusal must not be able to hold a device's queue open indefinitely, and a batch must not fail
   as a whole because one row in it was refused (decision F, FR-041).

---

### User Story 7 - The admin mints and manages logins (Priority: P1)

A, the instance admin, opens a **Logins** section inside the app and creates a login for a coworker:
an email-shaped identifier and a password. Nothing is emailed and nothing is verified — A hands the
coworker the URL and the credential out of band, and the coworker signs in on their own device. A
can also list the logins of this instance, set a new password on one, remove one, and grant or
revoke admin on another login. Nobody who is not an admin can see any of this, or do any of it.

**Why this priority**: It is the instance's front door. Without it, onboarding a coworker is a
Supabase-dashboard task, and the owner's first demo — which starts from minting B's login inside the
app — cannot be walked. It is also the only surface in the fork that writes account records, which
makes it the one whose mistakes are least recoverable.

**Independent Test**: One admin client and one non-admin client against the local stack, plus a
direct database connection: provision a login, sign in with a third freshly-built client using
exactly those credentials, set a new password and re-prove both directions, remove the login and
prove sign-in is refused — all unattended, with no browser and no dashboard.

**Acceptance Scenarios**:

1. **Given** a fresh origin with no accounts, **When** the first account is created, **Then** that
   account is an instance admin, without anyone having granted it — and **When** a second account is
   created afterwards, **Then** it is **not** an admin.
2. **Given** A is an admin, **When** A creates a login for B, **Then** a new sign-in-capable account
   exists on this origin, **and** a client signing in with exactly that identifier and password
   succeeds, **and** that session sees nothing but its own fresh, empty personal state — zero of A's
   workspaces, tasks, labels or notes.
3. **Given** B is signed in and is not an admin, **When** B calls any provisioning operation —
   create, set password, remove, grant admin, revoke admin, or list logins — **Then** every one is
   refused by the backend, and the refusal does not depend on the interface hiding the Logins
   section. **And** the Logins section is not present in B's interface at all.
4. **Given** a login exists, **When** A sets a new password on it, **Then** signing in with the old
   password is refused and signing in with the new password succeeds.
5. **Given** A removes B's login, **Then** signing in as B is refused; B's memberships end; every
   task assigned to B reads as unassigned; **and** the rows B created in team workspaces remain
   exactly as they were, still carrying B's identifier as their creator.
6. **Given** A is an admin, **When** A attempts to remove A's own login, **Then** it is refused; and
   **Given** A is the only admin, **When** A attempts to revoke A's own admin, **Then** it is
   refused. An instance can never be left with no admin and no way to sign in as one.
7. **Given** A grants admin to C, **When** C provisions a login, **Then** it succeeds; **When** A
   then revokes C's admin, **Then** C's next provisioning attempt is refused.
8. **Given** a login already exists for an identifier, **When** A creates it again — in any casing,
   with any surrounding whitespace — **Then** the operation is refused with an error code distinct
   from every other failure, and **zero** rows are created.
9. **Given** A submits an identifier that does not match `^[^@\s]+@[^@\s]+$`, or a password shorter
   than 8 characters, **Then** each is refused with its **own** distinct code, and zero rows are
   created. The identifier that is accepted is stored lower-cased and trimmed, decided by the
   backend rather than by the form.
10. **Given** any provisioning operation at all, **When** it runs, **Then** nothing is sent anywhere
    — no verification mail, no magic link, no outbound request of any kind — and the instance works
    identically with no mail transport configured.

---

### User Story 8 - The owner switches a workspace's kind (Priority: P1)

A workspace's owner can make a personal workspace shared, and make a shared workspace private again,
at any time, from the workspace's settings. Turning a team workspace personal ends everyone else's
access to it; turning a personal workspace team makes the owner its first member and nobody else.

**Why this priority**: It is how the owner actually described the product — "some private groups of
tasks, some set as team" — and it is the one place where access can be taken away from several
people in a single act, which is exactly the act most likely to strand a queued edit on someone
else's device (US6 acceptance 6, decision F).

**Independent Test**: Two clients against the local stack: switch kinds in both directions and
assert reachability from both sides after each switch, then round-trip and count membership rows
directly in the database.

**Acceptance Scenarios**:

1. **Given** A owns a personal workspace, **When** A switches it to team, **Then** it is a team
   workspace with exactly one membership row — A, as owner — and no other person gains anything by
   the switch alone.
2. **Given** A owns a team workspace with member B, **When** A switches it to personal, **Then**
   every membership of that workspace ends, B can no longer read or write any of its rows, and every
   task in it that was assigned to B reads as unassigned.
3. **Given** B was a member of a workspace that A has just switched to personal, **When** B's client
   next pulls, **Then** the workspace is gone from B's list — the same observable outcome as having
   been removed.
4. **Given** A switches a workspace personal → team → personal → team, **Then** it ends with
   **exactly one** owner membership row for A, never two, and no membership row for anyone who was
   a member during an earlier team period.
5. **Given** B is not the owner of a team workspace, **When** B attempts to switch its kind in
   either direction, **Then** the backend refuses — kind is an owner capability, and the refusal
   does not depend on the interface hiding a toggle.
6. **Given** B was offline with a queued edit to a team task, **When** A switches that workspace to
   personal and B reconnects, **Then** B's edit is refused and **dropped** — not retried forever —
   and B's edits to every other workspace and every other table in the same cycle land normally.
7. **Given** any switch, **When** it is attempted with a kind that is neither personal nor team,
   **Then** the backend refuses it, exactly as it refuses a third value at creation (FR-001).

---

## First demo — the acceptance walk (end of P1)

This is the feature's definition of done in walk form (ARCHITECTURE §0). It is performed on **one
deployment** — one Supabase project and one static site (decision A) — with **two devices and two
accounts**, and its data-layer equivalent runs unattended in the suite. It starts where the owner
said onboarding starts: with the admin minting the coworker's login inside the app.

1. **A signs in** on their device with the instance's first account, which is therefore the instance
   admin. No dashboard is opened at any point in this walk.
2. **A opens the Logins section** — visible because A is an admin — and sees the instance's logins,
   A's own among them.
3. **A creates a login for B**: an email-shaped identifier and a password. Nothing is sent anywhere;
   no verification is required or possible. A hands B the site URL and those credentials out of band.
4. **A creates a workspace, choosing personal**, and adds a private note to it. This is A's own
   material, and it stays A's for the whole walk.
5. **A creates a second workspace, choosing team.** A is its owner.
6. **A adds tasks** to the team workspace — at least one with a due date, at least one with a label.
7. **A opens the member list**, sees themselves, and **adds B by B's identifier** — the login A
   minted in step 3, already an account on this origin.
8. **A assigns one task to B** and leaves another unassigned.
9. **B signs in on a second device**, at the same URL, with the credentials A handed over. B sees
   the team workspace in their workspace list, with A's tasks, labels and notes in it, and sees the
   assignee on the assigned task.
10. **B's list contains none of A's personal workspaces** — not greyed out, not empty, not present.
11. **B goes offline** and edits one of the tasks, then creates a new one.
12. **B comes back online.** The queued edits are accepted.
13. **A sees B's edit and B's new task**, without doing anything special to fetch them.
14. **A switches the team workspace to personal.** On B's next cycle it is gone from B's list, and
    on A's device it behaves as any personal workspace does — including A's own tasks and B's, which
    are still there with their creators intact.
15. **A switches it back to team.** A is again its only member; B is **not** restored. A adds B
    again by identifier, and B sees the workspace return on the next cycle.
16. **A removes B from the workspace.** B's next cycle shows it gone again, and the task B was
    assigned to reads as unassigned for A.
17. **A removes B's login** from the Logins section. B's next sign-in attempt on the second device
    is refused; the rows B created in the team workspace are still there.
18. **A's personal workspaces behave exactly as before** on A's own device throughout — and the
    entire P0 evidence set passes unchanged against the same backend.

---

## Personal must not regress *(mandatory — ADR-0001 §6)*

The observable invariants. Each is a defect if it changes, regardless of how convenient the change is:

- **Data.** No existing row's values change as a result of this feature. `kind` arrives with a default
  that makes every pre-existing workspace personal without a rewrite; `assignee` arrives empty.
- **Access.** For a personal workspace, the read outcome and the write outcome of every request are
  identical to what they were before the transform — including the read/write asymmetry, including the
  workspace-ownership check on child writes.
- **Triggers.** `keep_newer`, `stay_deleted_with_workspace` and `follow_workspace_delete` fire on the
  same rows, in the same order, with the same effect. A predicate that makes one of them unreachable
  — or reachable on rows it never saw — is a regression, not a side effect.
- **Sync.** The conflict outcome for a personal row is unchanged, at both enforcement points. The
  push-path change of FR-041 is in scope here and must be shown not to disturb this: a personal row
  that is *accepted* follows exactly the path it followed before, and the row-by-row retry is
  reachable only after a batch has already been refused — a state a personal workspace reaches only
  when its rows were going to be refused anyway.
- **Cache.** The local cache is wiped on account mismatch and on nothing else, and a wipe still clears
  the pull positions.
- **Sign-out.** The four-step sign-out order is unchanged in its first three steps.
- **Views.** A person who owns only personal workspaces sees no new control, no new column, no new
  banner, no reordering — beyond the kind choice at creation and the kind switch in their own
  workspace's settings, which are the two ways a personal workspace can ever become a team one and
  are therefore in FR-024's enumerated set (SC-008). A person who is **not** an instance admin sees
  no trace of the Logins section: not disabled, not empty, not present.
- **Mechanical proof.** Every check in `tests/` written by `001-validation-spine` passes **unedited**,
  subject to FR-030's single owner-approved exception for FR-041 and to nothing else.
  Editing a P0 check to accommodate this feature is the single clearest signal that personal
  regressed; if one genuinely must change, that is a FINDING for the owner, not a fix.

---

## Inherited accepted risk — F-5, sign-out ordering *(mandatory)*

`supabase-auth` is `UNTESTED` and carries an accepted risk recorded in P0: **sign-out ordering is
uncovered and is not drivable without a browser** (validation map, `supabase-auth`;
`specs/001-validation-spine/receipts.md` F-5). This feature changes the last step of that order
(the wipe), which is precisely the step the uncovered ordering protects.

P1 must do one of two things, and **silently skipping is prohibited**:

- **(a) Cover it** — with whatever coverage is reachable without a browser (the ordering of the
  non-interface steps and the wipe's effect can be exercised directly), leaving only the genuinely
  browser-bound part uncovered and saying so; or
- **(b) Re-record it** as an accepted risk with the **owner's name**, the **date**, and an **expiry**
  (a phase or a date at which it must be revisited), carried on the `supabase-auth` map entry.

Neither option may be settled by an agent alone: option (b) needs the owner's word (CLAUDE.md, agent
roles).

---

## Edge Cases

- **A member is removed while offline with pending edits to that workspace.** The queued edits are
  refused when they arrive. The device must not retry them forever, must not stall unrelated rows or
  tables behind them, and must not present them to the person as saved. What the person is told is a
  UI concern; that the data does not land is a backend guarantee.
- **The owner deletes the team workspace while a member has queued edits.** The existing delete
  cascade decides it: the workspace is soft-deleted, its children are soft-deleted with a stamp that
  outranks an edit in flight, and a late-arriving live child is forced to deleted. The member's edits
  therefore land — deleted — or are refused; in neither case does a live row survive under a dead
  workspace, and in neither case does the member's device get stuck.
- **The last owner tries to leave or be removed.** A team workspace must never reach a state where
  nobody can administer it. The removal is refused. See Q2.
- **An email is added that has no account on this origin.** Refused, with a message that says exactly
  that: no account on **this** origin. No placeholder user, no pending invitation, no row of any kind.
  This is the visible edge of "there is no self-service sign-up" and of ADR-0004 — an account
  elsewhere is not an account here. The fix is for an admin to mint the login first (US7); the two
  acts stay separate, and adding a member never creates an account as a side effect.
- **The owner adds their own email.** They are already a member (as owner). The result is one
  membership row, unchanged, and a plain message — never a second row and never a silent demotion of
  the owner to member.
- **A member creates a personal workspace of their own.** Entirely unaffected: it is theirs, on this
  origin, invisible to the team workspace's owner. Being a member of someone's team workspace grants
  that someone nothing.
- **A task's assignee points at someone who has been removed.** Cannot persist: removal clears the
  pointer structurally. If a client held a stale copy, it converges to unassigned on its next cycle
  rather than rendering an unknown person.
- **A member deletes a row another member created.** Allowed — `member` is a full read/write level
  inside the workspace, and `user_id` records who created a row without reserving it.
- **The same person is a member of several team workspaces on this origin.** Each membership is
  independent; reach in one grants nothing in another.
- **A team workspace with exactly one member (its owner).** A legitimate state, at creation and after
  the last member is removed. It behaves like a workspace, not like an error.
- **A login is removed while that person has queued edits on another device.** Their session's token
  still has a lifetime, so edits can arrive after the account is gone. Every one of them is refused
  by the backend; decision F's per-row fallback drops each refused row from that device's queue
  rather than re-sending it forever, and the device's other queues are unaffected. The device is not
  told a story about having saved them.
- **An admin removes a login that owns a team workspace.** **Refused, with its own error code.** The
  safer and more structural of the two readings: the alternative — letting the workspace and its rows
  survive with an owner uuid that no longer resolves — creates a team workspace nobody can administer,
  and P1 has no ownership transfer with which to rescue it. So the admin must first delete those
  workspaces (or switch them to personal, which is still the departing owner's own act). Accepted P1
  cost, recorded deliberately; **P2 may add ownership transfer**, at which point this refusal becomes
  "transfer, then remove".
- **An admin removes a login that owns only personal workspaces.** Allowed. Those workspaces and
  their rows go with the account through the existing cascade; nobody else could see them anyway.
- **A workspace's kind is switched while a member is offline.** The member learns of it on their next
  pull, not before, and the observable outcome is identical to removal: the workspace leaves their
  list. Anything they queued for it in the meantime is refused and dropped (decision F). A client
  that never comes back online simply holds a stale copy it can do nothing with; the backend is the
  authority and it has already stopped answering for that workspace.
- **Two admins revoke each other at the same moment.** Last-writer-wins is irrelevant here — these are
  serial backend calls, not synced rows. Whichever lands first takes effect; the second then runs
  against the state the first produced, and the last-admin guard refuses it if it would leave the
  instance with no admin. There is no interleaving in which both succeed and none remains.
- **An admin grants admin to someone who is already an admin.** One flag, unchanged — never a second
  row, never an error that reads like a failure of the grant.
- **A login is minted for someone who already has one.** Refused by the duplicate-identifier code
  (decision G), including when the identifier differs only in casing or surrounding whitespace. No
  second account is ever created for the same identifier.

## Requirements *(mandatory)*

### Functional Requirements

**Workspace kind**

- **FR-001**: A workspace MUST carry a kind that is exactly one of **personal** or **team**, defaulting
  to personal for every pre-existing row and every row created without an explicit choice. Any other
  value MUST be refused by the backend. **Kind is mutable after creation, in either direction, and
  only by the workspace's owner** (owner decision C, 2026-09-13, superseding clarification Q3 and
  plan decision D-6; see FR-034).
- **FR-002**: Creating a team workspace MUST record its creator as its **owner** in the same operation.
  A team workspace MUST NOT be able to exist with no owner.
- **FR-003**: A personal workspace's behaviour MUST be unchanged in every respect listed under
  *Personal must not regress*.

**Membership**

- **FR-004**: Membership MUST have exactly **two** levels — `owner` and `member` — mapping a person to
  a workspace. A person MUST hold at most one membership per workspace.
- **FR-005**: `owner` MUST be able to add members, remove members and delete the workspace, plus
  everything `member` may do. `member` MUST be able to create, read, edit and delete tasks, labels and
  notes in that workspace, and MUST NOT be able to add members, remove members or delete the workspace.
- **FR-006**: These capability limits MUST be enforced by the backend. A refusal MUST NOT depend on the
  interface hiding a control.
- **FR-007**: A member list MUST be readable only by that workspace's own members, and each member MUST
  be identifiable there by **email**. That email MUST be served by a narrowly-scoped read path
  available only to co-members of that workspace; the account table MUST NOT be made readable, and no
  second copy of the email MUST be stored. A per-device, unsynced local cache of emails already
  returned by that read path (owner gate, 2026-09-13 evening, Q-A Option B) is not a second copy for
  this purpose: it is derived, never authoritative, and is cleared by `wipeLocal()`.
- **FR-008**: Adding a member MUST be done by email and MUST succeed only when that email belongs to an
  existing account **on this same origin**. Otherwise the operation MUST fail with an outcome that is
  distinguishable from every other failure, and MUST create no row of any kind. **No self-service
  sign-up capability is added**, and adding a member MUST NOT create an account as a side effect —
  minting a login is a separate, admin-only act (FR-038).
- **FR-009**: Removing a member MUST end that person's access to the workspace's rows immediately, and
  MUST leave every workspace of their own untouched.
- **FR-010**: A team workspace MUST always have at least one owner; an operation that would leave it
  with none MUST be refused. In P1 the owner is exactly one person — the creator — who cannot be
  removed, cannot leave, and cannot promote or transfer ownership to anyone else.

**Access rules**

- **FR-011**: Access to a team workspace's rows MUST be resolved through membership. `user_id` MUST
  keep meaning "who created the row" and MUST NOT be repurposed as an access key.
- **FR-012**: On each of the four tables, **both halves** of the existing single access policy — the
  read predicate and the write predicate, the latter including its workspace-ownership clause — MUST
  be replaced **separately**, and the existing read/write asymmetry MUST be preserved rather than
  flattened. One predicate written once and used for both halves is a defect.
- **FR-013**: The evidence MUST fail if either half is changed to match the other, for a personal
  workspace and for a team workspace alike. The demonstration MUST run inside the vitest stack tier
  against the local Docker Postgres — a scratch predicate applied and rolled back within one test, or
  the reproduction steps carried in that test's header. If the environment refuses to execute it, the
  P0 fallback applies: a hand-trace recorded in receipts with the reproduction steps in the test's
  header, named as such, never silently.
- **FR-014**: The three existing triggers MUST behave identically after the replacement: same rows,
  same order, same effect. The evidence MUST demonstrate each of them still firing, on a personal
  workspace and on a team workspace.
- **FR-015**: Membership rows themselves MUST be governed by access rules of the same rigour: a person
  may read the memberships of workspaces they belong to, and only an owner may write memberships of
  their workspace.

**Assignee**

- **FR-016**: A task MUST be able to carry at most one **assignee**, empty by default, naming a person
  who holds an account on **this same origin** and is a member of that task's workspace. An assignment
  to a non-member MUST be accepted with the assignee coerced to empty (see US5 acceptance 6's
  coordinator correction, plan decision D-3, `contracts/policies.sql:164-178`).
- **FR-017**: The assignee MUST carry **no authorization meaning**. No access decision may read it, and
  every access outcome MUST be identical with and without it.
- **FR-018**: Removing a member from a workspace MUST clear that person's assignments within it,
  enforced structurally by the backend rather than by the client.

**Client, cache and sync**

- **FR-019**: Membership and assignee information MUST reach the local cache and the sync engine
  through the same path as other synced data, so that a client which was offline learns of a membership
  change on its next cycle.
- **FR-020**: The conflict rule MUST remain **one rule with two enforcement points**. Any change to it
  MUST land at the client and at the backend **in the same change set**; evidence MUST fail if only one
  of them changes.
- **FR-021**: The local cache MUST still be wiped on account mismatch and on **nothing else**, and a
  wipe MUST still clear the stored pull positions. Reaching a newly-shared workspace MUST NOT trigger a
  wipe.
- **FR-022**: The cache's identity key MUST be written so that a later per-origin key is a **widening**
  of it, not a rewrite — without introducing any origin concept now (see FR-027). This is verified by
  reviewer reading, not by a runtime check; it is falsified if a per-origin key would require renaming
  or re-deriving the account half.
- **FR-023**: The first three steps of the sign-out order MUST NOT be reordered.

**Interface**

- **FR-024**: The interface MUST add exactly these **seven** affordances and nothing else:
  1. choose personal or team when **creating** a workspace;
  2. **switch** an existing workspace's kind, in workspace settings, **owner only**;
  3. see the **member list** of a workspace you belong to;
  4. **add a member** by email — owner only;
  5. **remove a member** — owner only;
  6. set or clear a task's **assignee**, with the assignee visible on the task;
  7. a **Logins** section — **instance admin only**, invisible to everyone else — containing exactly
     five controls and no others: **list** the instance's logins, **create** a login, **set a new
     password** on one, **remove** one, and **grant or revoke admin** on one.

  Nothing else. Any further control, column, banner or reordering is a failed requirement (FR-025).
- **FR-025**: Board, timeline and notes MUST be otherwise unchanged. Any additional control, column,
  banner or reordering is a failed requirement, not a bonus. This is proven by reviewer diff control
  — no change under `src/views`, `src/components` beyond the seven named affordances — plus a
  `git diff --stat` receipt, and a manual walk in the demo; no vitest claim is made for it.
- **FR-026**: The interface MUST continue to reach data only through the existing data-access layer,
  never the backend directly.

**Boundaries and evidence**

- **FR-027**: Nothing in this feature may introduce an origin column, an origin table, a cross-origin
  reference, a cross-origin query, or any notion of identity spanning origins. Federation requires zero
  schema support; such a thing would be wrong, not early (ADR-0004).
- **FR-028**: Schema changes MUST land in the single idempotent schema file — the membership table, the
  two new columns as guarded additions, the replaced policies and any new trigger — with a numbered
  migration added **only** if a row backfill is genuinely needed. Tables and columns are only ever
  added; no existing table or column is repurposed.
- **FR-029**: Two-account behaviour MUST be proven by two independently authenticated clients in one
  unattended run against the local backend stack, with no browser and no interface automation.
- **FR-030**: Every check written by `001-validation-spine` MUST pass **unedited**. A P0 check that must
  change is a FINDING for the owner, not an edit. **One bounded exception, owner-approved
  2026-09-13:** the push-path change required by FR-041 may alter behaviour the P0 `sync-engine`
  checks observe. It is permitted only **test-first** — the refusal behaviour is pinned by a new
  check that fails before the change and passes after it — and only with the `sync-engine` map entry
  **re-verified with a fresh receipt** in the same change set. If a P0 check nevertheless has to be
  edited, that remains a FINDING for the owner, not a fix. This exception covers FR-041 and nothing
  else.
- **FR-031**: The validation map MUST gain entries for the membership model, the replaced policies,
  the reworked cache and **account provisioning** (HIGH criticality — it writes account records),
  each moving to `VALIDATED` only with a receipt naming the command, the revision, the date and the
  sign-off, in the same change that adds the behaviour. The existing **`sync-engine`** entry MUST be
  **re-verified** with a fresh receipt in the change set that lands FR-041; carrying its old receipt
  forward is a finding.
- **FR-032**: The inherited F-5 risk MUST be either covered or re-recorded with the owner's name, the
  date and an expiry. Leaving it silently as it is MUST NOT happen.
- **FR-033**: No credential, key or token may enter the repository. The local stack's fixed development
  keys are not credentials for this purpose.

**Switching a workspace's kind** *(owner decision C)*

- **FR-034**: A workspace's owner MUST be able to change its kind after creation, in either
  direction. Anyone who is not that workspace's owner MUST be refused by the backend, not merely by
  a hidden control. The two-value constraint of FR-001 applies to a switch exactly as it applies to
  a creation.
- **FR-035**: **team → personal** MUST end every membership of that workspace — the membership rows
  are soft-deleted through the same path a removal uses, and assignees within the workspace are
  cleared by the same structural mechanism FR-018 requires. A former member's next pull MUST show
  the workspace gone from their list, indistinguishably from removal.
- **FR-036**: **personal → team** MUST seed exactly one membership row — the owner's, at level
  `owner` — re-activating a previously soft-deleted row for that person rather than adding a second.
  It MUST NOT restore anyone else who was a member during an earlier team period; the owner re-adds
  them. A personal → team → personal → team round trip MUST leave **exactly one** owner membership
  row.

**Instance admins and login provisioning** *(owner decisions B, D, E, G)*

- **FR-037**: The instance MUST carry a second, independent role layer: an **instance admin** flag on
  an account, held in a fork-owned additive table and never as a third membership level. **The first
  account ever created on this origin MUST become an instance admin structurally** — granted by the
  backend at account creation, and only while no admin exists — so that an instance is never
  adminless and nobody has to be told to grant it. Every account created after that MUST NOT be an
  admin by default.
- **FR-038**: An instance admin MUST be able to **list** this instance's logins, **create** a login,
  **set a new password** on one, **remove** one, and **grant or revoke** instance admin on another
  login. Every one of these MUST be refused by the backend for a caller who is not an admin. An
  admin MUST NOT be able to remove their **own** login, and MUST NOT be able to revoke the **last**
  remaining admin; both guards MUST be enforced by the backend.
- **FR-039**: Instance admin MUST carry **no** workspace authorization meaning. No access rule may
  read it, and every access outcome MUST be identical with and without it. An admin reaches exactly
  the workspaces and rows their own memberships give them, and no others. Conversely, any
  authenticated login — admin or not — MUST be able to create workspaces of either kind and, as
  owner, add existing logins by email (FR-008 is unchanged).
- **FR-040**: Provisioning MUST be performed by the backend under its own privilege, invoked by an
  admin holding nothing but their ordinary signed-in session. **No `service_role` key, and no
  credential of any kind, may exist in the repository, in a build artifact, or in the deployed
  client** (ADR-0006 §B). A login created this way MUST be immediately able to sign in with the
  identifier and password given, with **no verification step**, and MUST start with no workspaces,
  no tasks, no labels and no notes.
- **FR-041**: A queued row that the backend refuses MUST NOT wedge the queue. When a batch of queued
  rows is refused, the client MUST retry the batch **row by row**; a row refused on its own MUST be
  dropped from the queue — marked clean, leaving the next pull's tombstone or absence to reconcile
  it — and every other row and every other table MUST proceed unaffected in the same cycle. This is
  a change to the **push** path only: the conflict rule and its two enforcement points are untouched,
  so FR-020's lockstep holds unchanged. It lands test-first under FR-030's single exception, with the
  `sync-engine` map entry re-verified.
- **FR-042**: A provisioning identifier MUST match `^[^@\s]+@[^@\s]+$` and MUST be lower-cased and
  trimmed **by the backend**, not only by the form. A password MUST be at least **8** characters. A
  duplicate identifier, a malformed identifier and a short password MUST each be refused with an
  outcome **distinguishable from one another and from every other failure**, and MUST create no row
  of any kind.
- **FR-043**: Provisioning MUST send nothing anywhere — no verification mail, no magic link, no
  outbound request — and the instance MUST behave identically with no mail transport configured.
  Credentials are handed over out of band by the admin.
- **FR-044**: A password MUST NOT be stored or logged client-side beyond the form field being typed
  into. There MUST be no surface, anywhere, that displays an existing login's password; only hashes
  exist to display.
- **FR-045**: Removing a login MUST end that person's memberships, MUST clear their assignees, and
  MUST leave the rows they created in team workspaces in place with their creator identifier intact.
  Removing a login that **owns a team workspace** MUST be refused, with an outcome distinguishable
  from every other failure — P1 has no ownership transfer, so an orphaned team workspace is
  prevented rather than repaired.
- **FR-046**: Public sign-up MUST be **disabled on the hosted origin** — a documented runbook step
  for the operator, never a credential or a secret in the repository. The local test stack keeps
  sign-up enabled, because the P0 harness provisions its test accounts through it; this difference is
  deliberate and MUST be documented rather than reconciled.

### Key Entities

- **Workspace** — the container for tasks, labels and notes. Now carries a **kind**: personal (one
  person, upstream's behaviour) or team (membership-resolved). **Mutable**, in either direction, by
  the workspace's owner (FR-034) — decision C supersedes the fixed-at-creation reading.
- **Membership** — a person's place in a team workspace, at one of two levels, `owner` or `member`. The
  single source of the answer to "who may see this workspace". Membership rows are created by adding a
  member, by creating a team workspace, and now also by **personal → team**; they end by removal, by
  workspace deletion, and now also by **team → personal** — one end state, reached three ways, with
  one observable consequence for the person.
- **Instance admin** — `public.instance_admins(user_id primary key, granted_by, created_at)`: a
  fork-owned, purely additive table naming the accounts that may provision logins on this origin. The
  first account created on the origin is granted structurally; admins grant and revoke it on others,
  never removing the last one. It is an **instance** capability, never a workspace one: no access rule
  reads it (FR-039).
- **Login** — an account on this origin, identified by an email-shaped identifier and reached by a
  password. Not a new table: it is the account record the backend already keeps, surfaced to admins
  through a narrowly-scoped read path in the same spirit as FR-007's member emails. The admin mints,
  re-passwords and removes logins; nobody's password is ever readable.
- **Assignee** — an optional pointer from a task to a person who is a member of that task's workspace.
  A label; never an access input.
- **Creator (`user_id`)** — who made a row. Unchanged in meaning; no longer the sole answer to who may
  read it.
- **Origin** — one Supabase project, hosted by one person. Every identity in this feature belongs to
  exactly one origin and never relates to another. Not represented anywhere in the schema — deliberately.
- **Access policy half** — the read predicate and the write predicate of a table's single access policy.
  Two separate things that must stay different from one another.

## Onboarding model — how a coworker joins *(in scope; owner decisions A–E)*

**As stated by the owner (paraphrased faithfully):** a coworker joins an *existing* self-hosted
system like this. The host self-hosts Supabase, registers the first account through it — that is
the admin's own account. They sign in with it, have personal notes, and can create workspaces for
themselves or for the team and choose which kind each is. Workspace switching is the second layer
that replaces switching accounts: one sign-in, then a choice of workspaces — some private groups of
tasks, some set as team/public. In that same signed-in interface the admin keeps a **list of
logins** — email-identified accounts with passwords — creates them, changes them, removes them, and
hands each coworker their login, password and the hosted URL, so the coworker signs in and already
has access to the shared task base.

**All of it is in P1, and the first demo walks it.** Where each part lives:

- *One sign-in; personal and team workspaces side by side in the existing switcher* — US1, US3, and
  the existing workspace switcher. Workspace switching is the second layer that replaces switching
  accounts, exactly as the owner described it.
- *The admin keeps a list of logins — creates them, changes their passwords, removes them* — **US7**
  and FR-037–FR-046. The privilege lives in the backend itself (decision E, ADR-0006), reached by an
  admin holding nothing but their ordinary session; no `service_role` key exists anywhere in this
  fork, and no second deployable is introduced.
- *Hands each coworker their login, password and the hosted URL* — decision A: **one deployment**,
  one URL for everyone, credentials handed over out of band because nothing is emailed (FR-043).
- *Chooses which kind each workspace is* — **US8** and FR-034–FR-036: at creation **and** at any time
  afterwards, in either direction, by that workspace's owner.
- *The coworker signs in and already has access to the shared task base* — US3, unchanged: their
  membership is what they see, and they see nothing else.

Two consequences of putting it in scope, recorded so they are not mistaken for gaps:

1. **"Remove login" and "remove member" are different acts.** Removing a member ends one
   membership; removing a login ends the account, and with it every membership, every assignment
   pointing at that person, and the ability to sign in at all (FR-045). The rows that person created
   in team workspaces stay — `user_id` records who made a row, and a departed creator does not take
   the team's work with them.
2. **Password self-service does not exist in P1.** The admin sets the initial password and can set a
   new one; the coworker cannot change their own. A change-password affordance is out of scope
   (below), which means a handed-over credential stays exactly as shared as the moment it was handed
   over.

**Origin invariant unchanged:** all of the above lives on one origin (ADR-0004); nothing here is
federation, and nothing here needs schema support for one.

## Out of Scope

Explicitly not in P1. Each would need its own spec, and several would need a new ADR:

- A **read-only viewer** level, or any third membership level (new ADR — ADR-0001 §1).
- **Comments**, mentions, notifications of any kind.
- **Dashboards**, including the teamlead stuck-detection view (P3).
- **Per-assignee permissions** — anything that makes assignment mean more than a label.
- Any **origin column, origin table, or cross-origin notion** whatsoever (ADR-0004).
- The **origin registry** and the **per-origin client layer** (P2/P3, owner-scheduled).
- **Runtime origin config** — may land independently on its self-hosting merit, but not as part of this
  feature.
- The **agent layer**: the `dandori` CLI, task-file sync, Speckit ingestion, MCP (P3).
- **Public sign-up.** There is still no self-service registration: an account exists because an
  instance admin minted it (US7). Sign-up is disabled on the hosted origin (FR-046).
- **Password self-change by the coworker** (P2). The admin sets a new password; the person holding
  the login cannot. Named here because it is the most obvious missing half of US7, and it is missing
  on purpose.
- **Email delivery of any kind** — verification, invitations, magic links, password resets, SMTP
  configuration. Credentials are handed over out of band (FR-043).
- **Ownership transfer** of a workspace, and promotion between the two membership levels. Its absence
  is why removing a login that owns a team workspace is refused (FR-045); P2 may add it.
- Browser-driven or rendering-level evidence (P2, ADR-0003).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The eighteen-step first-demo walk completes end to end on one deployment with two
  devices and two accounts, with **zero** manual database intervention and **zero** visits to the
  Supabase dashboard — the second account is minted from inside the app.
- **SC-002**: Of A's personal workspaces and their rows, the number reachable by B — by listing, by
  identifier, by read or by write — is **0**, measured at the data-access layer.
- **SC-003**: Every check written by `001-validation-spine` passes with **0** edits to those checks —
  including under FR-030's single exception, which permits a behaviour change, never an edited check.
- **SC-004**: High-criticality entries for the membership model, the replaced policies, the reworked
  cache and account provisioning reach `VALIDATED` with receipts: unproven HIGH-tier entries
  introduced by this feature **4 → 0**. The `sync-engine` entry ends the feature re-verified, with a
  receipt dated to this change set, not to P0.
- **SC-005**: Inverting or equalizing **either** half of **either** table's access rule causes at least
  one check to fail — demonstrated deliberately once, for a personal workspace and for a team workspace,
  and recorded, per the execution and fallback terms of FR-013.
- **SC-006**: After a member is removed, the number of tasks in that workspace whose assignee names a
  non-member is **0**, on the backend and, after one sync cycle, on every client.
- **SC-007**: The number of access decisions that read the assignee is **0**.
- **SC-008**: The interface gains exactly **7** new affordances (FR-024) and **0** others. For a
  non-admin person who owns only personal workspaces, the number of those seven that are visible is
  **2** — the kind choice at creation and the kind switch in their own workspace's settings, which
  are the same affordance seen twice and are how a personal workspace ever becomes a team one — and
  the number of other visible changes is **0**: no member list, no assignee, no Logins section.
- **SC-009**: The number of origin columns, origin tables and cross-origin references added is **0**.
- **SC-010**: Adding an email with no account on this origin creates **0** rows and produces a message
  naming that exact cause.
- **SC-011**: The inherited F-5 risk ends this feature in exactly one of two states — covered by a
  passing check, or re-recorded with an owner name, a date and an expiry. The number of ways it may end
  silently unaddressed is **0**.
- **SC-012**: A device switching between accounts wipes its cache exactly **once per switch** and
  **0** times when the same account signs in again, including when that account's reach has grown by a
  new membership.
- **SC-013**: **0** credentials, keys or tokens are added to the repository, and **0** runs touch a
  hosted project.
- **SC-014**: The entire body of evidence for this feature runs from the same single documented command
  as P0's, unattended, with no browser.
- **SC-015**: A login provisioned inside the suite signs in successfully within that same unattended
  run: provisioned **1**, successful sign-ins **1**, dashboard steps **0**, outbound messages **0**.
- **SC-016**: After a login is removed, the number of successful sign-ins with its credentials is
  **0**, and the number of its rows in team workspaces that disappeared is **0**.
- **SC-017**: A refusal wedges **0** queues. Measured in one push cycle following a deliberate
  refusal: the count of unsent rows for every **other** table reaches **0**, the refused row's own
  unsent count reaches **0** rather than persisting, and the number of re-send attempts for that row
  in the following cycle is **0**.
- **SC-018**: Admin-only controls are visible to a non-admin **0** times, and provisioning operations
  called by a non-admin succeed **0** times out of the six that exist — measured at the backend, not
  by inspecting the interface.
- **SC-019**: A personal → team → personal → team round trip ends with exactly **1** owner membership
  row and **0** memberships for anyone who was a member during an earlier team period.
- **SC-020**: The number of `service_role` keys, platform secrets, or credentials of any kind added by
  this feature to the repository, to a build artifact or to the deployed client is **0** — and the
  number of separately deployed server components added is **0**.
- **SC-021**: The number of guard states in which the instance can be left with no admin, or an admin
  can delete their own login, is **0**, including under two admins acting at the same moment.

## Open Questions

**None of these is open any more.** Q1 and Q2 were settled at the owner gate on the evening of
2026-09-13 as proposed; Q3 was **overturned** there, and Q4 and Q5 were answered in the same late
session. They are kept, with their resolutions, so the reasoning that produced each one stays
readable — see Clarifications for the decisions themselves.

- **Q1 — How is a member's email shown?** Reading another person's email means exposing account
  records that are not normally readable. **Adopted (pending owner gate):** the backend exposes
  emails only to co-members of the same workspace, through a purpose-built, narrowly-scoped read
  path — never by making the account table readable, and never by storing a second copy of the
  email that can drift.

- **Q2 — Can ownership move?** May an owner promote a member to owner, or hand the workspace over,
  and may an owner then leave? **Adopted (pending owner gate):** no promotion and no transfer in
  P1. A team workspace has exactly one owner — its creator. The owner cannot be removed and cannot
  leave; the workspace ends by being deleted. This keeps FR-010 trivially true and leaves the richer
  model to a later spec. (Consequence to accept: a workspace whose owner disappears is administratively
  stuck, and the operator resolves it in the dashboard.)

- **Q3 — Can a workspace change kind after creation?** Is personal → team conversion in P1, and is
  team → personal ever allowed? ~~**Adopted (pending owner gate):** kind is fixed at creation in
  P1.~~ **RESOLVED 2026-09-13 (late), owner decision C — overturned at the gate:** kind is
  switchable at any time, in either direction, by the workspace's owner. Semantics in FR-034–FR-036
  and US8; ADR-0006 §D records it as the amendment to ADR-0001 §1.

- **Q4 — In-app login provisioning.** Where does the privilege to create/change/remove logins live?
  **RESOLVED 2026-09-13 (late), owner decisions B, D, E:** in Postgres — `security definer` routines
  called by an admin's ordinary session, with no `service_role` key and no second deployable
  (ADR-0006 §B). In P1 and in the first demo. Edge Function with the platform service role is the
  recorded fallback, dashboard-only the recorded status quo, both rejected for now.

- **Q5 — Kind switchability.** Does "choose the kind" mean at creation only or at any time?
  **RESOLVED 2026-09-13 (late), owner decision C:** at any time. Same resolution as Q3.

## Assumptions

- **Any signed-in person on this origin may create workspaces of either kind.** Being a member of
  someone else's team workspace neither grants nor restricts that. Recorded rather than asked, because
  no other reading is consistent with "your own workspaces are yours".
- **Everything in this feature happens within one origin.** ADR-0004 settles where a team workspace
  lives; this specification never relates two origins, and needs no schema support in order not to.
- **The backend stack, the test runner and the no-browser two-account approach are owner-decided and
  not reopenable** (ADR-0002, ADR-0003). They constrain the evidence; this specification does not
  re-choose them.
- **There is one deployment for everyone** (owner decision A): one Supabase project and one static
  site, and every coworker opens that same URL on their own device. This is ADR-0004's single-origin
  instance; there is no federation here, no second origin, and nothing needing schema support for
  one. A person's account is an account *on this instance*, and nowhere else.
- **Accounts are minted inside the app by an instance admin** (owner decision B), not in the Supabase
  dashboard. "Add a member by email" still means "connect an account that already exists here" — it
  is just that the admin can now make one exist without leaving the app. There is still no
  self-service sign-up.
- **Shared credentials are the model, deliberately.** Nothing is emailed and nothing is verified; the
  admin hands over an identifier and a password out of band, and the coworker cannot change it in P1.
  This is proportionate for one host and a handful of coworkers and is named as such rather than
  discovered later.
- **Coupling to the authentication service's internal account tables is accepted** (owner decision E,
  ADR-0006). Provisioning writes those records directly, which is what makes it possible with no
  `service_role` key, no second deployable and no untestable surface. The risk is that an upgrade to
  that service changes their shape; it is pinned by a canary check that provisions a login and signs
  in with it, and the recorded fallback is a platform function holding the service role.
- **A member is a full read/write participant.** Nothing in P1 reserves a row to its creator inside a
  workspace both people belong to.
- **The delete cascade is the answer to workspace deletion**, not a new mechanism. Members inherit the
  behaviour personal workspaces already have.
- **`assignee` names a person, not a membership.** It is cleared when the membership ends, but a task
  is assigned to a human, and the same human re-added later does not silently reacquire old
  assignments.
- **The project's governance document is still an unfilled template**, so no additional governance
  constraint applies beyond the accepted ADRs.
- **Performance of membership-based access checks is not a v1 criterion.** The extra lookup per row is
  named in ADR-0001's consequences so that a future slowdown has a suspect; it is not measured here.
