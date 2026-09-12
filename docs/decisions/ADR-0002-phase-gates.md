# ADR-0002 — Phased roadmap, hard-gated on validation

- **Status:** Accepted
- **Date:** 2026-09-12
- **Decider:** Andrii Tkhorenko (AndriyTkh) — fork owner, solo operator
- **Depends on:** ADR-0001 (fork contract)
- **Amended:** 2026-09-12, in owner review, before first commit — the P0 Supabase stand-in is
  decided (below), and ADR-0004's origin registry is placed as an owner-scheduled P2/P3 item.

## Context

The 2026-09-12 audit produced a validation map where **every component is `UNTESTED`** except
`env-boot`, and `env-boot`'s receipts prove only that the toolchain compiles — not that anything
behaves (`docs/validation-map.md`, "What this map does NOT establish").

The fork's intended change set lands squarely on the HIGH-tier substrate: the sync engine, the
RLS policies, the local cache. Three properties of that substrate make "build the team feature
first, test later" specifically dangerous here:

- Conflict resolution is enforced in two places that must agree (ADR-0001 §3). There is currently
  no test that would notice if they stopped agreeing.
- The RLS predicate swap changes the *access* semantics of rows that sync already round-trips.
  A wrong predicate does not crash; it silently shows or hides rows.
- The local cache wipe is keyed to a single owner (`src/db/local.ts:89-125`). Reworking it wrong
  leaks one account's rows onto another account's screen, which is the worst failure this
  codebase can produce and the one least likely to be caught by hand.

Post-hoc tests on changed behaviour cannot tell you whether they pin the old contract or bless
the new bug. Tests written *before* the change can.

## Decision

Four phases, in this order, each a hard gate on the next.

**P0 — validation spine on EXISTING behaviour.** Stand up vitest (ADR-0003). First test is the
offline-edit sync round-trip (scenario `s-offline-edit-sync`). Then tests pinning the *current*
LWW conflict behaviour (`s-conflict-lww` — both enforcement points) and the current RLS
expectations. No fork feature work in P0. The deliverable is a map where the HIGH-tier substrate
entries the fork stands on are `VALIDATED` against upstream behaviour, not fork behaviour.

**The P0 backend is the `supabase` CLI local stack** — decided, no longer an open question.
Real Postgres, real RLS, real triggers, in Docker. This matters for what the tests are worth: the
three things P0 most needs to pin — the `keep_newer()` trigger, the `own_rows` policies, and the
trigger firing order — are *Postgres* behaviour, and a hand-written fake would only re-assert the
assumptions under test. Applying `supabase/schema.sql` to a local stack also exercises the
hand-run migration convention (ADR-0001 §4) on every test run, which is the only automated check
that convention will ever get.

Corollaries:
- **Zero credentials in the repo.** The local stack's keys are fixed, well-known development
  values printed by `supabase start`; nothing secret is committed, and no hosted project is
  touched by tests.
- **CI runs the stack as a service**, so the `test` step in `.github/workflows/ci.yml` is
  genuinely the same check a developer runs locally.
- **Two-account scenarios need no browser.** `s-personal-stays-private` and the rest are written
  as **two supabase-js clients in one vitest process**, signed in as different users of the local
  stack, observing each other at the API layer. This resolves the question of whether the
  two-account guard forces Playwright forward: it does not (ADR-0003 stands unchanged).

**P1 — minimal team transform.** Workspace `kind`, membership table, RLS predicate replacement,
`claimCache`/`wipeLocal` multi-account rework. Every P0 test still passes, unchanged, for
personal workspaces — that is the mechanical form of ADR-0001 §6's "personal must not regress".

**P2 — scenarios and end-to-end.** Route scenarios, the happy-walk, MCP-driven testing,
Playwright enters here (ADR-0003).

**P2/P3 boundary, owner-scheduled — the origin registry.** ADR-0004's origin registry and
per-origin client layer sit here. They are *not* automatically next after P1 and are *not* a P3
prerequisite; the owner picks when they land. Runtime origin configuration (ADR-0004 consequence
(a)) may land independently and earlier, since it stands on its own self-hosting merit.

**P3 — agent layer.** CLI task-file sync (`dandori` CLI, Supabase as source of truth, local
per-project task files as working copy), speckit `tasks.md` ingestion, thin MCP v2, teamlead
dashboard with stuck-detection. This is the differentiator; it is also the phase with the least
substrate underneath it, which is why it is last.

**The gate rule (P-gate):** *no phase starts while the substrate it stands on is `UNTESTED`.*
Concretely, a phase's first task is always to clear the map debt its `plan.md`
"Validation substrate" table reports. A phase is not "started early" by writing a spec for it —
only by writing code against untested substrate.

## Consequences

- The first weeks of the fork produce **no visible product change**. That is the cost, and it is
  paid once. Accepted explicitly by the owner; it is not to be renegotiated mid-P0 because team
  mode feels close.
- P0's tests describe upstream behaviour, so they also serve as the regression net for every
  future upstream merge — a payoff that lands well beyond P1.
- P0 acquires a Docker dependency for its test tier (the `supabase` CLI stack). Accepted: it is
  the price of testing RLS and triggers rather than testing a fake of them. The build, typecheck
  and lint steps stay Docker-free, so a contributor without Docker can still get four of the five
  CI checks locally.
- A P0 test that fails against current behaviour is a **finding, not a blocker**: it becomes a
  map entry with status `BROKEN` and an owner decision, not a reason to soften the test.

## Reconsider when

- P0 proves substantially more expensive than the team transform itself (then the phase split,
  not the gate, is wrong — reorder, do not remove the gate).
- A second operator joins and phases can genuinely run in parallel lanes.
- An external deadline forces team mode before P0 completes. That requires a new ADR recording
  the untested substrate as an **accepted risk with an expiry date and a named human**, per the
  validation-map grammar — never a silent skip.
