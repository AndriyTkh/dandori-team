# Session state

Agent-maintained. Named by `project-profile.yaml` → `autonomy.state_file`; the SessionStart hook
prints it, so keep it under ~30 lines: where work stopped, what is in flight, what the next session
does first. Not a log — overwrite, don't append.

- **Stage:** `demo-rush` (rushed / high / solo), ends 2026-09-16. Then `demo-harden` to 2026-09-20.
- **2026-09-14 deploy:** **LIVE** at `https://dandori.otherbadeng.workers.dev` (worker `dandori`,
  version `2fe65111`). TG-5 T058-T061 all PASS, receipts in `specs/002-team-workspaces/receipts.md`.
  Hosted origin `Dandori_host`: HEAD `schema.sql` applied (A-018), the one pre-existing workspace
  stayed `personal`, `instance_admins` = 1 (andriytkh@icloud.com, seeded by the trigger, not by the
  backfill), sign-ups closed (`disable_signup: true`, verified `422 signup_disabled`).
- **Supabase access from a session:** Management API with `SUPABASE_ACCESS_TOKEN` from the
  environment (`POST /v1/projects/{ref}/database/query` for SQL, `/config/auth` for auth config);
  `.mcp.json` also wires `@supabase/mcp-server-supabase` with ref + token via `${}` expansion —
  set `SUPABASE_PROJECT_REF` and restart to use it. No hosted ref or key in any tracked file;
  `.env.local` is gitignored (`*.local`).
- **Branch:** `002-team-workspaces`; PR #1 -> main still open (deploy went direct from this
  machine, so the merge is no longer on the deploy path).
- **Owed (post-deploy debt, A-019):** **T057** whole-branch review, **T056** member-email cache
  (names show as raw ids offline), T052/T053 receipts, **T062** eighteen-step walk, T063 close;
  map flips (`supabase-schema`->f6ed810, `membership`/`team-rls`/`account-provisioning`/
  `multi-account-cache` UNTESTED->VALIDATED, `sync-engine` T039 re-stamp, `local-cache`/`db-api`
  re-stamp, widen `chrome-components` paths to `src/components/`).
- **Known UX gap for T062:** owner-only controls stay hidden until the seeded owner row is pulled
  (offline right after creating a team workspace) - inherent to D-6.
- **Spec 003 draft:** branch `spec/003-agent-edit-layer` @ 3b87c87 - 9 owner questions in plan.md.
- **Decision debt:** A-001..A-020 all reviewed. **0 open / 5.** Open owner gate: gate 3 deferred.
- **Next session, first:** T062 walk on two devices against the live URL (A = andriytkh@icloud.com;
  mint B inside the app's Logins section), then T057.
