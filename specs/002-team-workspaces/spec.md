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
  Supabase dashboard — an accepted consequence.
- Q: Can a workspace change kind after creation? → A: No. Kind is fixed at creation in P1, in
  either direction.
- Q: Story priorities vs phase gates? → A: `Priority: P1/P2` on user stories is this
  specification's own ordering of stories; it is unrelated to the fork's phase gates P0–P3. Every
  story here ships inside phase P1.

## User Scenarios & Testing *(mandatory)*

`Priority:` on a story is this specification's own ordering, not a phase gate (see
Clarifications).

The actors are **A**, who hosts this origin and creates workspaces on it, and **B**, who holds an
account on the same origin and is added to one of A's workspaces. Every claim below is proven the
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
no sign-up, accounts are created in the Supabase dashboard, exactly as upstream leaves it. The owner
can also remove a member.

**Why this priority**: Membership is the access rule. It is also the only administrative surface
this feature adds, and the only one whose mistakes are silent.

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
   the write is refused.

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
6. **Given** B was removed from the workspace while offline with unsent edits to it, **When** B
   reconnects, **Then** those edits are refused by the backend, B is not left retrying them forever,
   and no other row or table is stalled by the refusal.

---

## First demo — the acceptance walk (end of P1)

This is the feature's definition of done in walk form (ARCHITECTURE §0). It is performed on **one
deployment with two accounts**, and its data-layer equivalent runs unattended in the suite.

1. **A signs in** on their device and creates a workspace, choosing **team**. A is its owner.
2. **A adds tasks** to it — at least one with a due date, at least one with a label.
3. **A opens the member list**, sees themselves, and **adds B by B's email**. B already holds an
   account on this origin.
4. **A assigns one task to B** and leaves another unassigned.
5. **B signs in on a second device** and sees the team workspace in their workspace list, with A's
   tasks, labels and notes in it, and sees the assignee on the assigned task.
6. **B's list contains none of A's personal workspaces** — not greyed out, not empty, not present.
7. **B goes offline** and edits one of the tasks, then creates a new one.
8. **B comes back online.** The queued edits are accepted.
9. **A sees B's edit and B's new task**, without doing anything special to fetch them.
10. **A's personal workspaces behave exactly as before** on A's own device throughout — and the
    entire P0 evidence set passes unchanged against the same backend.
11. **A removes B.** B's next cycle shows the workspace gone from B's list, and the task B was
    assigned to reads as unassigned for A.

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
- **Sync.** The conflict outcome for a personal row is unchanged, at both enforcement points.
- **Cache.** The local cache is wiped on account mismatch and on nothing else, and a wipe still clears
  the pull positions.
- **Sign-out.** The four-step sign-out order is unchanged in its first three steps.
- **Views.** A person who owns only personal workspaces sees no new control, no new column, no new
  banner, no reordering.
- **Mechanical proof.** Every check in `tests/` written by `001-validation-spine` passes **unedited**.
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
  This is the visible edge of "there is no sign-up UI" and of ADR-0004 — an account elsewhere is not
  an account here.
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

## Requirements *(mandatory)*

### Functional Requirements

**Workspace kind**

- **FR-001**: A workspace MUST carry a kind that is exactly one of **personal** or **team**, defaulting
  to personal for every pre-existing row and every row created without an explicit choice. Any other
  value MUST be refused by the backend. **Kind is fixed at creation and MUST NOT be changed
  afterwards, in either direction.**
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
  second copy of the email MUST be stored.
- **FR-008**: Adding a member MUST be done by email and MUST succeed only when that email belongs to an
  existing account **on this same origin**. Otherwise the operation MUST fail with an outcome that is
  distinguishable from every other failure, and MUST create no row of any kind. No sign-up capability
  is added.
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
  to a non-member MUST be refused.
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

- **FR-024**: The interface MUST add exactly these five affordances and nothing else: choose team when
  creating a workspace; see the member list; add a member by email (owner only); remove a member (owner
  only); set or clear a task's assignee — with the assignee visible on the task.
- **FR-025**: Board, timeline and notes MUST be otherwise unchanged. Any additional control, column,
  banner or reordering is a failed requirement, not a bonus. This is proven by reviewer diff control
  — no change under `src/views`, `src/components` beyond the five named affordances — plus a
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
  change is a FINDING for the owner, not an edit.
- **FR-031**: The validation map MUST gain entries for the membership model, the replaced policies and
  the reworked cache, each moving to `VALIDATED` only with a receipt naming the command, the revision,
  the date and the sign-off — in the same change that adds the behaviour.
- **FR-032**: The inherited F-5 risk MUST be either covered or re-recorded with the owner's name, the
  date and an expiry. Leaving it silently as it is MUST NOT happen.
- **FR-033**: No credential, key or token may enter the repository. The local stack's fixed development
  keys are not credentials for this purpose.

### Key Entities

- **Workspace** — the container for tasks, labels and notes. Now carries a **kind**: personal (one
  person, upstream's behaviour) or team (membership-resolved).
- **Membership** — a person's place in a team workspace, at one of two levels, `owner` or `member`. The
  single source of the answer to "who may see this workspace".
- **Assignee** — an optional pointer from a task to a person who is a member of that task's workspace.
  A label; never an access input.
- **Creator (`user_id`)** — who made a row. Unchanged in meaning; no longer the sole answer to who may
  read it.
- **Origin** — one Supabase project, hosted by one person. Every identity in this feature belongs to
  exactly one origin and never relates to another. Not represented anywhere in the schema — deliberately.
- **Access policy half** — the read predicate and the write predicate of a table's single access policy.
  Two separate things that must stay different from one another.

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
- **Sign-up UI.** Accounts are created in the Supabase dashboard, unchanged from upstream.
- Browser-driven or rendering-level evidence (P2, ADR-0003).
- Ownership transfer and promotion between levels, unless Q2 is answered otherwise.
- Converting an existing workspace between kinds, unless Q3 is answered otherwise.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The eleven-step first-demo walk completes end to end on one deployment with two accounts,
  with **zero** manual database intervention beyond creating the second account in the dashboard.
- **SC-002**: Of A's personal workspaces and their rows, the number reachable by B — by listing, by
  identifier, by read or by write — is **0**, measured at the data-access layer.
- **SC-003**: Every check written by `001-validation-spine` passes with **0** edits to those checks.
- **SC-004**: High-criticality entries for the membership model, the replaced policies and the reworked
  cache reach `VALIDATED` with receipts: unproven HIGH-tier entries introduced by this feature
  **3 → 0**.
- **SC-005**: Inverting or equalizing **either** half of **either** table's access rule causes at least
  one check to fail — demonstrated deliberately once, for a personal workspace and for a team workspace,
  and recorded, per the execution and fallback terms of FR-013.
- **SC-006**: After a member is removed, the number of tasks in that workspace whose assignee names a
  non-member is **0**, on the backend and, after one sync cycle, on every client.
- **SC-007**: The number of access decisions that read the assignee is **0**.
- **SC-008**: The interface gains exactly **5** new affordances (FR-024) and **0** other visible
  changes for a person who owns only personal workspaces.
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

## Open Questions

These three questions were answered by the coordinator on 2026-09-13, with the defaults below,
pending the owner's gate — the owner may overturn any of them at the gate (see Clarifications).

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
  team → personal ever allowed? **Adopted (pending owner gate):** kind is fixed at creation in P1.
  No conversion in either direction. Converting personal → team is the smaller, plausible follow-up;
  team → personal raises "what happens to the other members' rows", which is a spec of its own.

## Assumptions

- **Any signed-in person on this origin may create workspaces of either kind.** Being a member of
  someone else's team workspace neither grants nor restricts that. Recorded rather than asked, because
  no other reading is consistent with "your own workspaces are yours".
- **Everything in this feature happens within one origin.** ADR-0004 settles where a team workspace
  lives; this specification never relates two origins, and needs no schema support in order not to.
- **The backend stack, the test runner and the no-browser two-account approach are owner-decided and
  not reopenable** (ADR-0002, ADR-0003). They constrain the evidence; this specification does not
  re-choose them.
- **Accounts are created in the Supabase dashboard**, as upstream leaves them. "Add a member by email"
  therefore means "connect an account that already exists here", not "invite a stranger".
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
