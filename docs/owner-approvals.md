# Owner approvals — numbered gates

Appended to, never rewritten. `status` is `OPEN`, `APPROVED <date>` or `REJECTED <date>`. A ruling
recorded anywhere else (chat, commit message, code comment) does not count until it has a row here.
Blocker `class` is one of B1..B5 (project-compass `references/blocker-taxonomy.md`). Owner:
Andrii Tkhorenko (AndriyTkh), fork owner, `mode: solo` — no backup; open gates queue until the
owner's next check-in.

| gate | what is being decided | default in use | class | status |
|---|---|---|---|---|
| 1 | Profile stage values (audit Gate 3b): stage `demo-rush`, rigor `rushed`, autonomy `high`, mode `solo`, gate `sprint`, ends 2026-09-16; then `demo-harden`, rigor `standard`, autonomy `high`, ends 2026-09-20 | as ruled | B1 | APPROVED 2026-09-14 (owner in chat: "rushed till wednesday and then standard; high autonomy; solo") |
| 2 | Demo deadline day: Friday 2026-09-18 or Sunday 2026-09-20 (§B U-001) | 2026-09-20 | B1 | APPROVED 2026-09-14 (owner: "B1 sun is correct") |
| 3 | Where `rushed` rigor and the fork's "test-first on UNTESTED HIGH" rule disagree, the fork rule wins (§B U-003) | fork rule wins | B4 | OPEN — owner deferred 2026-09-14 ("we'll measure after"); default stays in force |
| 4 | Post-demo stage: stay `standard` + `solo`, or add a second human so `regulated` becomes legal (§B U-004, U-005) | `standard` / `normal` / `solo` | B4 | APPROVED 2026-09-14 (owner: "keep on standard" — `(single-operator)` sign-offs accepted permanently) |
| 5 | Owner remark "move that high to normal, it's self hosted anyway" — stage autonomy or component tier? | no change | B4 | APPROVED 2026-09-14 as **no change** (owner: "accept it as is, don't change, we'll measure after") — autonomy stays `high`, all six HIGH tiers stay; revisit with ledger numbers at the first post-demo sprint plan |
| 6 | Run spec 002 as parallel feature lanes — schema (primary), sync-cache (`wt/sync-cache`), ui (`wt/ui`, after `db/api.ts` signatures land) — overriding the plan's TG-1→TG-2→TG-3 hard gate; one review per lane instead of one closer per card; test-first cards stay red until their code lands; stack tests serialized on the primary at integration | lanes | B4 | APPROVED 2026-09-14 (owner: "Yes, all lanes") |
| 7 | Start planning spec 003 (agent-edit layer: task files as working copy, `dandori` CLI pull/push) now, parallel to 002, in a separate dev-plan lane; implementation waits for its own spec gate | plan now | B4 | APPROVED 2026-09-14 (owner: "Yes, plan it now") |
| 8 | Gate audit on the one-file schema lane: keep test-first (ADR-0002) and the substrate check; drop per-card closers and per-card receipts in favour of one reviewer + one receipt per lane at merge; collapse remaining verbatim-contract schema cards into one dispatch (A-005) | as A-005 | B4 | APPROVED 2026-09-14 (owner: "those gate edit suggestions DO make sense. Change them now") |
| 9 | P0 test files `tests/local/claim-cache.test.ts` (3 sites) and `tests/stack/lww-conflict.test.ts` (1 site) fail `tsc -b` on fixture literals after T028 made `kind`/`assignee` required (FR-030: a P0 check that must change is an owner finding) | type-only fixture edits, zero assertion change, diff gated like T004 | B4 | APPROVED 2026-09-14 (owner: "Allow type-only fixture edits") |
| 10 | Blocker batch 2026-09-14: (1) T031a db-api additions for T043/T049, (2) `tests/setup.ts` members clear, (3) T042 `AskName` collapse at lane review, (4) decision-debt rows A-001/002/004/006/008/009/010, (5) `banned_until` doc correction in rpc.md + ADR-0006 §B | as proposed | B1 | APPROVED 2026-09-14 (owner: "approved and review. You can continue"); also: deploy a stable build for live testing when ready |
