# Receipts — 001-validation-spine

## Full-suite receipt
- Command `npm test -- --run` (vitest: projects stack+local). 6 files / 29 tests. PASS, twice
  consecutively at e7f258d on the primary checkout (durations ~16s each). Stack: local supabase
  CLI stack in Docker (API 127.0.0.1:54321), schema.sql + migration-002..006 applied in order by
  globalSetup.

## Fresh-operator receipt (T025, spec SC-004/FR-015)
- Clean `git clone` of the repo at e7f258d into an empty directory, `npm install`, then
  `npm test -- --run`. No `.env.local` present (verified), no secret supplied — the committed
  well-known local dev keys in vitest.config.ts were sufficient. Result: PASS, 6 files / 29 tests,
  16.67s. Date 2026-09-12.
- First attempt at 8025ee1 FAILED on vitest's 5s default test timeout under cold-start load
  (soft-delete acceptance 1; 842ms warm). Fixed as T008c (stack project testTimeout 30s), re-run
  PASS. Honest history kept.

## MCP-driven usage probe (owner condition, 2026-09-12)
- Self-designed in-place probe (scratch script, not committed): JSON-RPC 2.0 against the local
  stack's Supabase MCP server (Kong URL http://127.0.0.1:54321/mcp returns 400 — served in
  practice by Studio at http://127.0.0.1:54323/api/mcp; server "supabase 0.11.0").
- Steps and results, all PASS: initialize + tools/list (11 tools incl. execute_sql); execute_sql:
  public tables = labels,notes,tasks,workspaces; own_rows policies = 4; triggers present =
  labels/notes/tasks/workspaces_keep_newer, _stay_deleted (x3), _synced_at (x4 incl
  workspaces_synced_at); live LWW round-trip — inserted a probe workspace via MCP, sent an
  older-stamp update, keep_newer refused it (name unchanged), probe row deleted after. PROBE
  RESULT: PASS.

## CI receipt (T024)
- `.github/workflows/ci.yml` test + start-supabase steps uncommented at this feature. Actual CI
  run: PASS — first push (2026-09-13, owner-authorized, temp private repo
  AndriyTkh/dandori-team) at 6727ec4:
  https://github.com/AndriyTkh/dandori-team/actions/runs/34739227659 — install, typecheck, lint,
  build, start supabase, test all green in 3m10s on ubuntu-latest.

## FINDINGS (T028, spec FR-013)
Each: observed vs documented, and disposition. No assertion was weakened to make the suite green.

- F-1 — ACCEPTED RISK: confirmed; pull has no exported awaitable entry point; the settle-wait seam
  proved genuinely treacherous — push() settles once even with zero dirty rows before pull() runs,
  so a first-settle wait skips the pull entirely (T010a), and a pull-only cycle with push
  suppressed offline never enters `syncing` on the push side, yielding one settle, not two
  (T015a). Both handled in tests/harness/sync.ts (SETTLES_PER_FULL_CYCLE=2 + `settles` option).
  Seam observation for P1: an exported awaitable cycle would remove this class.
- F-2 — PASS: pinned behaviourally as planned; client LWW comparators module-internal; US2 client
  acceptances pinned behaviourally through Dexie after a pull, per plan. No unreachable case found.
- F-3 — PASS: no cross-file auth-state leak observed — stack files run in a single forked
  worker serially, harness clients use persistSession:false, suite green twice.
- F-5 — ACCEPTED RISK (owner, per plan): sign-out ordering uncovered in P0; lives in
  useSession.ts/Settings.tsx, undrivable without a browser. P1 inherits and must cover it.
- F-6 — PASS: equal-stamp LWW pinned at row level (equal stamps accepted), no calendar code
  involved (lww-conflict.test.ts acceptance 4).
- T018 deviation — ACCEPTED RISK: the live single-sided RLS policy-swap demonstration
  (SC-008-style, US3) was refused by the session's tool-safety layer (security-policy change
  against a live DB). Recorded instead: hand-trace against the deployed predicates plus the live
  assertions themselves, which exercise both directions (B's own row pointing at A's workspace
  readable; cross-account insert refused). Reproduction steps for the swap are in the header of
  tests/stack/rls-two-accounts.test.ts.
- Harness/vitest traps found and fixed inside the test surface (no src/ or supabase/ change
  anywhere): root-level globalSetup auto-started the stack for the Docker-free tier (T008a);
  per-project fileParallelism:false is NOT honored in full multi-project runs — JSON-reporter
  timestamps showed all five stack files overlapping, causing 40P01 deadlocks (schema re-apply vs
  concurrent REST), GoTrue "Database error creating new user" storms, and settle timeouts; fixed
  by single forked worker (T008b) plus bounded 40P01 retry in applySchema (T007a) and 30s stack
  testTimeout (T008c).

Sign-off: Andrii Tkhorenko (single-operator, owner-delegated 2026-09-12)

## 2026-09-13 — upstream merge a3a7572 (15 commits), re-verification

- Merge commit c7dedae on main (001-validation-spine fast-forwarded first). Conflict only in
  CLAUDE.md: fork's kept, upstream's body copied verbatim into docs/upstream-CLAUDE.md.
- Upstream diff review: src/sync/ untouched (LWW merge unchanged); supabase/schema.sql unchanged;
  migration-003 and migration-006 reduced to comments + the one-off orphan-row update (their
  definitions already lived in schema.sql). Dexie schema version and table shapes unchanged;
  new exports taskDate (types.ts) and moveNote (api.ts); no test-imported signature changed.
- Map: local-cache and supabase-schema paths were touched (types.ts; migration-003/006) →
  re-verified, last-verified moved to 5448a0d. db-api / views / gcal stay UNTESTED as before.
- Verify: npm run lint PASS; npm run build PASS; npm test -- --run → 6 files / 29 tests PASS,
  exit 0 (at 5448a0d, local stack restarted first — auth container had gone unhealthy after 2h).
- Trap found and fixed inside the test surface: Node's global BroadcastChannel under jsdom made
  Dexie emit 13 unhandled cross-realm MessageEvent errors per full run (exit 1) — present at
  f498c24 too, locally; CI at f498c24 was green. tests/setup-env.ts removes the global before
  Dexie loads. No src/ or supabase/ change.
- Stale line citations to migration-006 (CLAUDE.md, validation-map, ADR-0001, ARCHITECTURE.md
  §4, lww-conflict.test.ts) repointed to schema.sql:142-153 / :244-254.

Sign-off: Andrii Tkhorenko (single-operator)
