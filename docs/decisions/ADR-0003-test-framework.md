# ADR-0003 — Vitest now; Playwright deferred to P2

- **Status:** Accepted
- **Date:** 2026-09-12
- **Decider:** Andrii Tkhorenko (AndriyTkh) — fork owner, solo operator
- **Depends on:** ADR-0002 (phase gates)

## Context

The repo has **zero test files and no test runner** (`docs/validation-map.md`, audit @ `88e74aa`).
A framework has to be chosen before P0 can write its first line.

The P0 targets are logic, not pixels: the sync loop's push/pull sequencing and cursor handling,
the LWW comparators (`src/sync/sync.ts:104-141`, `409-458`), the Dexie cache claim/wipe
(`src/db/local.ts:89-125`), and the shape of what crosses the wire
(`SYNCED_COLUMNS`, `src/db/types.ts:187-214`). None of that needs a browser to be *exercised*;
some of it needs a browser-ish environment (IndexedDB) to be *run*.

The build is already Vite 8 + TS 6. A second, separate toolchain config for tests would be a
standing divergence from the one config that already resolves this project's modules.

The real question was not "vitest or Playwright" — those answer different questions — but
whether deferring Playwright to P2 costs more later than adopting it now.

## Decision

**Vitest is the test framework from P0.** It reuses `vite.config.ts` resolution, runs the unit
and integration tier, and is the runner the CI `test` step will uncomment
(`.github/workflows/ci.yml`, the commented P0 line).

**Playwright is deferred to P2**, where route scenarios, the happy-walk and MCP-driven testing
land together. It is not "maybe later": it has a phase.

**Cost-of-later was assessed and found equal.** Nothing written in P0 or P1 has to be rewritten
to accommodate Playwright in P2: the two tiers do not share fixtures, assertions or a runner
contract, and adding Playwright is an additive dependency plus a config file whenever it happens.
Adopting it in P0 would therefore buy nothing and would spend P0's budget on browser plumbing
instead of on the substrate tests that gate P1.

## Consequences

- Supabase is represented by the **`supabase` CLI local stack** — decided in ADR-0002, not open.
  Vitest drives it over supabase-js, including two clients at once for two-account scenarios.
- P0 still must decide how to run **IndexedDB**-dependent tests (a DOM-ish environment, or a Dexie
  backing-store substitute). That one is genuinely a P0 design task and this ADR does not
  prejudge it.
- Until P2 there is **no test that exercises the real UI**. The views (`views-core`,
  `task-dialog`, `chrome-components`) stay `UNTESTED` through P1 by design, and their NORMAL/LOW
  tiers are what make that acceptable.
- The CI `test` step stays commented until the first vitest suite exists. A green CI before then
  means "compiles and builds", nothing more — the workflow file says so in a comment so the badge
  cannot be misread.
- No new dependency is installed at foundations time. Adding vitest is P0's first task, not this
  ADR's side effect.

## Reconsider when

- A P0 test turns out to be genuinely impossible to write without driving a real browser (then
  Playwright is pulled forward into P0 for that test only, and this ADR is superseded).
- ~~The team transform (P1) produces a multi-account scenario whose only honest test is two real
  browser sessions side by side.~~ **Resolved 2026-09-12, owner review:** two supabase-js clients
  in one vitest process against the local stack observe each other at the API layer, which is
  where the RLS guarantee actually lives. Playwright is not pulled forward. The trigger that
  remains is a scenario whose claim is about *rendering* — what a second person's screen shows —
  rather than about access.
