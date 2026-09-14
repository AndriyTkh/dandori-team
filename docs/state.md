# Session state

Agent-maintained. Named by `project-profile.yaml` → `autonomy.state_file`; the SessionStart hook
prints it, so keep it under ~30 lines: where work stopped, what is in flight, what the next session
does first. Not a log — overwrite, don't append.

- **Stage:** `demo-rush` (rushed / high / solo), ends 2026-09-16. Then `demo-harden` to 2026-09-20.
- **2026-09-14 close:** all three lanes merged into `002-team-workspaces` @ f6ed810 (T023a incl.
  no-JWT exemption on the FR-010 trigger; sync + ui lanes). Pushed; **PR #1 → main** open.
  Full suite: schema-apply 6/6, then 201/203 in the parallel run (`soft-delete` acc. 1/4 flaked,
  3/3 alone — A-017); second full run **203/203 green** (merge receipt in receipts.md).
  Local DB had stale split policies from T023a's first attempt; dropped by hand (hosted unaffected).
- **Deploy status:** NOT deployed from this machine — no `.env.local`/`VITE_*` here, so a local
  `wrangler deploy` would ship a client without a Supabase URL. Path: owner runs T058 (hosted
  `schema.sql`) + T059 (first admin), merges PR #1, Cloudflare's GitHub build deploys from `main`
  with the dashboard's build vars; then T060. Alternative: owner creates `.env.local` locally and
  runs `npm run build && npx wrangler deploy` (token already in env).
- **Owed after merge:** map flips (`supabase-schema`→f6ed810, `membership`/`team-rls`/
  `account-provisioning`/`multi-account-cache` UNTESTED→VALIDATED, `sync-engine` T039 re-stamp,
  `local-cache`/`db-api` re-stamp, widen `chrome-components` paths to `src/components/`), T052,
  T053 receipts, **T057 whole-branch review**, T062 owner walk.
- **Known UX gap to raise at T057/T058:** owner-only controls stay hidden until the seeded owner
  row is pulled (offline right after creating a team workspace) — inherent to D-6.
- **Spec 003 draft:** branch `spec/003-agent-edit-layer` @ 3b87c87 — 9 owner questions in plan.md.
- **Decision debt:** A-001..A-016 reviewed; A-017 open (1/5). Open owner gate: gate 3 deferred.
- **Next session, first:** read this file, `git status` in all three checkouts, then the
  `[in-progress: …]` markers in `specs/002-team-workspaces/tasks.md`.
