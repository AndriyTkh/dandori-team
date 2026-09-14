# Session state

Agent-maintained. Named by `project-profile.yaml` → `autonomy.state_file`; the SessionStart hook
prints it, so keep it under ~30 lines: where work stopped, what is in flight, what the next session
does first. Not a log — overwrite, don't append.

- **Stage:** `demo-rush` (rushed / high / solo), ends 2026-09-16. Then `demo-harden` to 2026-09-20.
- **Branch in flight:** `002-team-workspaces`. Schema lane T022–T027 done (schema at c5fda53);
  lane review FAIL → **T023a** (RLS DELETE split, `keep_creator` on workspaces, FR-010 owner
  invariant trigger, `_create_login_impl` revoke) in flight on primary, test-first. Map flips for
  `supabase-schema`/`membership`/`team-rls`/`account-provisioning` held until T023a green.
- **Lane `wt/sync-cache`** (C:\ProjectsC\KSE\Dandori-wt-sync): T028–T037, T040 done; **T031a**
  (`updateWorkspace`, `currentUserId`, `useCurrentUserId`, setup.ts members clear) in flight. Then
  T038 review, T039 `sync-engine` re-stamp, merge with one serialized full stack run.
- **Lane `wt/ui`** (C:\ProjectsC\KSE\Dandori-wt-ui): T041, T042, T047 done; **T044+T048** in flight
  (Settings.tsx serial). T043/T045/T046/T049 need T031a merged into wt/ui first. Then T050, lane
  review (collapse T042's `WorkspaceNameForm` into `AskName`, A-012).
- **Owner asks:** deploy a stable build for live testing when ready (gate 10). Deploy scout in flight.
  Hosted schema re-run (T058) and first-admin insert (T059) are owner-manual SQL steps.
- **Spec 003 draft:** branch `spec/003-agent-edit-layer` @ 3b87c87 — 9 owner questions in plan.md.
- **Decision debt:** A-001..A-012 reviewed 2026-09-14; open: A-013, A-014 (2/5).
- **Open owner gates:** gate 3 deferred (fork test-first rule in force).
- **Next session, first:** read this file, then the `[in-progress: …]` markers in
  `specs/002-team-workspaces/tasks.md`.
