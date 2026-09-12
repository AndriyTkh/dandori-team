# Feature Specification: P0 Validation Spine

**Feature Branch**: `001-validation-spine`

**Created**: 2026-09-12

**Status**: Draft

**Input**: User description: "P0 validation spine — executable evidence for the existing (upstream, unmodified) behavior of the four HIGH-tier surfaces, so the P1 team transform lands on validated substrate."

## User Scenarios & Testing *(mandatory)*

The "users" of this feature are the fork owner, any future second operator, and CI. The value
delivered is **evidence**: each story turns one currently-unproven claim about existing behavior
into a receipt that a machine re-checks on every change. No end-user-visible behavior changes.

Every story below describes behavior that **already exists upstream**. A story whose evidence
contradicts the documented behavior does not get a softened assertion — it becomes a recorded
FINDING for the owner (ADR-0002, "a failing P0 test is a finding, not a blocker").

### User Story 1 - Offline edit survives the round trip (Priority: P1)

An operator can prove that an edit made while a device is offline reaches the server when
connectivity returns, comes back to a second device unchanged, and is still there after that
device restarts. Today this claim rests only on a manual walk that nobody has performed twice the
same way (`s-offline-edit-sync`, currently UNTESTED).

**Why this priority**: It is the spine's spine. It exercises the whole chain — local cache, the
write API, push, the server, pull, cursor advance — end to end, so it is the single cheapest piece
of evidence that the substrate the fork stands on works at all. ADR-0002 names it as P0's first
test.

**Independent Test**: Runnable alone against a fresh backend stand-in, with nothing else in the
suite present. Delivers, on its own, the first non-toolchain receipt this repo has ever had.

**Acceptance Scenarios**:

1. **Given** an operator's device with no connectivity and an existing task, **When** the task is
   edited, **Then** the edit is durably held on the device and marked as not-yet-sent.
2. **Given** that device regains connectivity, **When** a sync cycle runs, **Then** the edit is
   accepted by the backend, the row's server-side record matches what was sent (except for the
   server-authored sync stamp), and the local not-yet-sent mark clears.
3. **Given** a second client belonging to the same account starting from an empty local cache,
   **When** it syncs, **Then** it receives the edited row with the same content and does not
   receive it repeatedly on subsequent cycles.
4. **Given** the second client is restarted with its local cache preserved, **When** it reads the
   row, **Then** the edited content is still present without another round trip.

---

### User Story 2 - A stale edit cannot overwrite a newer one (Priority: P1)

Two devices edit the same row while one is offline; both eventually send. The older edit must lose,
and it must lose in the same way on both sides of the wire — the backend refuses it, and the client
independently declines to overwrite a newer local row. Today these two enforcement points are
documented as agreeing and nothing would notice if they stopped (ARCHITECTURE §4 "LWW contract",
ADR-0001 §3 lockstep invariant; scenario `s-conflict-lww`).

**Why this priority**: This is the fork's most dangerous surface. P1 changes ownership rules on the
same rows; without this evidence, a divergence between the two enforcement points would appear as
silent data loss, not as a failure.

**Independent Test**: Runnable alone. Two writers against the same row, one deliberately stamped
older; assert the outcome at the backend and, separately, at the client merge step.

**Acceptance Scenarios**:

1. **Given** a row whose stored edit is newer, **When** an older edit for the same row arrives at
   the backend, **Then** the stored content is unchanged and the server-side sync stamp does not
   move.
2. **Given** that same refusal, **When** the losing device continues syncing, **Then** it stops
   re-sending the losing edit — the queue does not retry it forever, and the refusal does not stall
   other rows or other tables.
3. **Given** an incoming row from the backend that is older than the local unsent copy, **When** the
   client merges, **Then** the local copy is kept.
4. **Given** an incoming row carrying the *same* instant as the local copy, **When** the client
   merges, **Then** the documented equal-stamp outcome holds (equal stamps are accepted by design,
   because bookkeeping-only writes do not advance the edit clock).
5. **Given** the evidence set as a whole, **Then** it fails if either enforcement point alone is
   changed — so the lockstep invariant is machine-checked rather than asserted in prose.

---

### User Story 3 - Two accounts cannot see or write each other's rows (Priority: P1)

With two real accounts against the same backend, account B can never read account A's rows, and
account B can never write a row into a workspace it does not own — even when it knows the workspace
identifier. The read rule and the write rule are **not the same rule**: reads are scoped by row
ownership alone, while writes additionally check workspace ownership (`supabase/schema.sql:249-253`,
ARCHITECTURE §3 "Ownership (today)"). That asymmetry is deliberate and load-bearing.

**Why this priority**: P1 replaces both halves of this rule separately. The most likely way that
transform goes wrong quietly is one predicate pasted into both halves. Evidence that fails if
*either half* changes is the only thing that catches it.

**Independent Test**: Runnable alone with two accounts on the stand-in backend, observing each other
at the data-access layer. No user interface is involved.

**Acceptance Scenarios**:

1. **Given** account A owns a workspace and rows in it, **When** account B lists those rows,
   **Then** B receives nothing — not an error page, an empty result.
2. **Given** account B knows account A's workspace identifier, **When** B attempts to create a child
   row in it, **Then** the write is refused by the backend.
3. **Given** account B owns its own workspace, **When** B writes a child row into it, **Then** the
   write succeeds — proving the refusal in (2) is about ownership, not about writes in general.
4. **Given** the read rule were tightened to match the write rule (or the write rule loosened to
   match the read rule), **Then** at least one of these checks fails — the asymmetry is pinned in
   both directions.

---

### User Story 4 - A device cache belongs to exactly one account (Priority: P2)

When a device's locally cached data was populated by account A and account B signs in on the same
device, the cache is wiped before any of B's data is drawn — and it is *not* wiped when the same
account signs in again. Today this is a single-owner check (`src/db/local.ts:89-125`,
`s-account-switch-wipe`).

**Why this priority**: This is the behavior whose failure mode is one account's rows appearing on
another account's screen — the worst outcome this codebase can produce, and the least likely to be
noticed by hand. It is P2 only because it is narrower than stories 1–3 and does not gate them.

**Independent Test**: Runnable alone against a local-storage stand-in; no backend and no browser
required.

**Acceptance Scenarios**:

1. **Given** a cache claimed by account A, **When** account A claims it again, **Then** nothing is
   wiped and the pull cursors survive.
2. **Given** a cache claimed by account A, **When** account B claims it, **Then** all cached rows
   are removed before B's data can be read, and the recorded owner becomes B.
3. **Given** a wipe has occurred, **Then** the stored pull cursors are also cleared, so the next
   sync starts from the beginning rather than silently skipping rows.
4. **Given** an unclaimed (fresh) cache, **When** any account claims it, **Then** no wipe is
   reported and the account is recorded as owner.

---

### User Story 5 - A deletion stays deleted (Priority: P2)

Deletion in this system is a flag, never a removal, so that a device which was offline at delete
time still learns about it. A row marked deleted propagates to other clients as deleted, and a row
arriving late into an already-deleted parent workspace is forced to deleted rather than appearing
alive under a dead parent (ARCHITECTURE §4 "Triggers"; `s-workspace-delete-cascade`).

**Why this priority**: It is the only scenario where the backend rewrites content the client sent,
and the rewrite is invisible unless asserted. P1's predicate swap must not make this rewrite
unreachable.

**Independent Test**: Runnable alone: mark deleted, sync elsewhere, assert still deleted; then send
a live child into a deleted workspace and assert it lands deleted.

**Acceptance Scenarios**:

1. **Given** a row marked deleted on one client, **When** a second client syncs, **Then** the row is
   received and is deleted there too — it does not reappear as live.
2. **Given** a workspace that has been deleted, **When** a client that was offline sends a live child
   row belonging to it, **Then** the stored child row is deleted, not live.
3. **Given** a deleted workspace, **When** its children are examined, **Then** none is live — the
   cascade reached them.
4. **Given** a client repeatedly syncs after these events, **Then** no deleted row flips back to
   live on any cycle.

---

### User Story 6 - The whole body of evidence runs unattended (Priority: P1)

A second operator, or automation, can start from a fresh clone and reproduce every receipt above
with **one documented command**, and the same body of evidence runs automatically on every change to
the repository and blocks the change when it fails.

**Why this priority**: Evidence that only one person can reproduce is not evidence. The automated
run is what turns the map from "was green once" into "is green now", and ADR-0002's phase gate is
unenforceable without it.

**Independent Test**: Fresh clone on a machine with only the documented prerequisites; run the one
command; observe every check pass. Separately, observe the automated run reach the same verdict.

**Acceptance Scenarios**:

1. **Given** a fresh clone and the documented prerequisites, **When** the operator runs the single
   documented command, **Then** the backend stand-in starts, every check runs, and the result is
   pass — with no manual setup step outside the documented prerequisites.
2. **Given** no secret values are supplied by the operator, **When** the command runs, **Then** it
   still passes — nothing in the evidence depends on a credential, and no credential is stored in
   the repository.
3. **Given** a change is proposed to the repository, **When** automation runs, **Then** the same
   body of evidence executes and a failure blocks the change.
4. **Given** the run finishes, **Then** its outcome is recorded against the affected validation-map
   entries, with the identifying revision and date, so the map's status is traceable to a specific
   run.

### Edge Cases

- **The stand-in backend is unavailable** (container runtime not installed or not running): the run
  must say so plainly and name the missing prerequisite, rather than passing with the
  backend-dependent checks silently skipped. A skipped check is never a pass.
- **A check fails against current behavior**: it is recorded as a FINDING with the observed versus
  documented behavior, and the affected map entry becomes `BROKEN` pending an owner decision. The
  assertion is not relaxed to make the run green.
- **Existing code cannot be exercised without a structural change** (no seam to observe or inject
  at): this is a FINDING for the owner, not a refactor. No source file is modified in this feature.
- **Migration files applied out of order, or one fails**: the run stops and names the file — since
  applying them in order on every run is the only automated check the hand-run migration convention
  receives.
- **Clock/format differences between what a client writes and what the backend returns** (differing
  timestamp representations of the same instant): comparisons are by instant, never by text, and the
  evidence must fail if that ever stops being true.
- **Ordering-dependent evidence**: two checks that share the same backend state must not be able to
  make each other pass or fail depending on which ran first.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The repository MUST gain an executable body of evidence covering the existing behavior
  described in User Stories 1–5, as automated checks rather than documented manual walks.
- **FR-002**: The evidence MUST be produced **without modifying any existing source file**. Only new
  test, harness, fixture, documentation and automation files are added. If a behavior cannot be
  exercised without a source change, the outcome is a recorded FINDING for the owner, not a change.
- **FR-003**: Behavior that is enforced by the backend (staleness refusal, access rules, deletion
  persistence) MUST be exercised against a **real backend of the same kind the product uses**, with
  the real access policies and the real row-level behavior in effect — never against a substitute
  that re-states the assumption under test.
- **FR-004**: The backend stand-in MUST be created by applying the repository's own schema file and
  every numbered migration, **in order**, on each run — so the hand-run migration convention is
  exercised as part of the evidence.
- **FR-005**: Two-account evidence MUST be produced by two independently authenticated clients
  observing each other at the data-access layer, in one run, with no browser and no user-interface
  automation.
- **FR-006**: The evidence MUST distinguish the read rule from the write rule for access control, and
  MUST fail if either is changed to match the other.
- **FR-007**: The evidence MUST cover both enforcement points of the staleness rule — the backend's
  refusal and the client's own decision not to overwrite — and MUST fail if only one of them changes.
- **FR-008**: Locally-cached-data behavior MUST be exercised with a local-storage stand-in that
  requires no browser.
- **FR-009**: **No credential may be committed to the repository, and no run may touch a hosted
  project.** The fixed, publicly documented development keys of the local backend stand-in are not
  credentials for this purpose and may be committed.
- **FR-010**: The complete body of evidence MUST be runnable with **one documented command**, and
  that command MUST be recorded in the repository's documentation.
- **FR-011**: The repository's automation MUST run the same command on every proposed change,
  starting the backend stand-in as part of that run, and MUST report failure as a blocking result.
  The automation's existing checks that do not need the stand-in MUST remain runnable without it.
- **FR-012**: On a passing run, the validation-map entries for the sync engine, the access policies,
  the local cache, and the schema/migration surface MUST move from `UNTESTED` to `VALIDATED`, each
  carrying the command that proves it, the identifying revision, the date, and the sign-off — and the
  corresponding scenario entries MUST be updated in the same change.
- **FR-013**: A check that fails against current behavior MUST be recorded as a FINDING with observed
  versus documented behavior; the affected entry becomes `BROKEN` pending owner decision, and the
  check is not weakened.
- **FR-014**: The run MUST fail loudly, naming the missing prerequisite, when the backend stand-in
  cannot start. Silently skipping backend-dependent checks is prohibited.
- **FR-015**: A second operator MUST be able to reproduce every receipt from a fresh clone using only
  the documented prerequisites and the single documented command.
- **FR-016**: This feature MUST produce **no visible product change**. That is an accepted,
  explicitly recorded cost (ADR-0002, Consequences).

### Out of Scope

- Any team, workspace-membership, role or assignee capability (that is P1).
- Any modification to existing source files, including refactors "to make testing easier".
- Browser-driven or rendering-level checks (deferred to P2 by ADR-0003).
- Calendar-integration evidence — that surface is NORMAL tier and stays `UNTESTED` through this
  feature by design.
- Triage of the outstanding dependency-advisory findings recorded during the audit.

### Key Entities

- **Validation-map entry** — one component's proven status: identifier, criticality, status, the
  command that proves it, the revision and date last proven, and who signed it off.
- **Scenario** — a named end-to-end walk across several components, with an expected outcome; the
  unit a user story pins.
- **Receipt** — the recorded outcome of running a proving command at a specific revision; what makes
  a `VALIDATED` status traceable rather than asserted.
- **Finding** — an observed divergence between documented and actual behavior, awaiting an owner
  decision; never resolved by weakening the check.
- **Synced row** — a record belonging to exactly one account, carrying a device-authored edit clock,
  a server-authored sync stamp, and a deletion flag that is set rather than removed.
- **Backend stand-in** — a disposable local instance of the real backend, built from the repository's
  own schema and migrations, using publicly documented development keys.
- **Local cache** — the per-device store of rows, its pull position markers, and the single account
  identifier that claims it.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The four high-criticality substrate entries — sync engine, access policies, local
  cache, and schema/migrations — move from `UNTESTED` to `VALIDATED`, each with a receipt naming the
  command, revision and date. Count of high-criticality `UNTESTED` substrate entries: **4 → 0**.
- **SC-002**: Scenarios `s-offline-edit-sync`, `s-conflict-lww`, `s-account-switch-wipe` and
  `s-workspace-delete-cascade` change from "manual walk only" to automated, with recorded outcomes.
  Count of these scenarios with no automated evidence: **4 → 0**.
- **SC-003**: The full body of evidence runs from **one command**, documented in the repository.
- **SC-004**: A second operator, starting from a fresh clone with only the documented prerequisites,
  reaches a passing run **without asking the owner anything** and without supplying any secret.
- **SC-005**: Automation runs the same body of evidence on every proposed change and blocks a change
  whose run fails; the checks that do not require the stand-in remain runnable without it.
- **SC-006**: **Zero** credentials are added to the repository and **zero** runs touch a hosted
  project.
- **SC-007**: **Zero** existing source files are modified by this feature; any untestable surface is
  written up as a FINDING instead.
- **SC-008**: Removing or inverting either half of the access rule, or either of the two staleness
  enforcement points, causes at least one check to fail — demonstrated once, deliberately, and
  recorded.
- **SC-009**: The product's visible behavior is unchanged — **zero** user-facing differences.

## Assumptions

- The feature description's named surfaces map onto the existing validation map as follows:
  "sync-engine" → `sync-engine`, "rls-policies" and "migrations" → `supabase-schema` (the map holds
  the access policies and the migration files under that single entry), "local-cache" →
  `local-cache`. `supabase-auth` and `db-api` are exercised incidentally by these stories; whether
  their status also flips is an outcome of the evidence, not a goal of this feature. Recorded because
  the description's four names are not literal map identifiers.
- The backend stand-in, the test runner, and the no-browser two-account approach are **owner-decided
  and not reopenable** (ADR-0002, ADR-0003). They appear here as constraints on the evidence, not as
  choices this specification makes.
- The container runtime needed by the backend stand-in is an accepted prerequisite for the
  evidence-producing checks only; compile, build and lint checks stay free of it (ADR-0002,
  Consequences).
- The project's governance document is still an unfilled template, so no additional governance
  constraint applies beyond the accepted ADRs.
- The automation's staged, commented-out block is the intended home for the automated run; completing
  it is expected to be a change to automation configuration, not to product source.
- Existing behavior is assumed correct unless evidence says otherwise; the purpose here is to *pin*
  it, not to judge it. Divergences become FINDINGS.
- "Reload survives" in User Story 1 means a client reconstructed from persisted local data, not a
  rendered page reload — no browser is involved.
- Evidence runs against a disposable backend and must leave no state that another run depends on.
