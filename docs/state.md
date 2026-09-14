# Session state

Agent-maintained. Named by `project-profile.yaml` → `autonomy.state_file`; the SessionStart hook
prints it, so keep it under ~30 lines: where work stopped, what is in flight, what the next session
does first. Not a log — overwrite, don't append.

- **Stage:** `demo-rush` (rushed / high / solo), ends 2026-09-16. Then `demo-harden` to 2026-09-20.
- **Branch in flight:** `002-team-workspaces` — spec 002 TG-1. T020, T021 done; **T022** (fork block
  C triggers) in progress (coder dispatched 2026-09-14), then T023 policy swap, T024 RPCs, T025
  admins, T026 provisioning, T027 gate. Schema cards pipeline: closer(N) reads while coder(N+1)
  writes; `supabase/schema.sql` stays one write lane.
- **Process branch:** `tg/plumbline-v5` — merged (fast-forward) into `002-team-workspaces` at
  `dab2b70`, 2026-09-14. Branch may be deleted.
- **Open owner gates:** `docs/owner-approvals.md` gate 3 (deferred; fork test-first rule in force).
- **Next session, first:** read this file, then the `[in-progress: …]` marker in
  `specs/002-team-workspaces/tasks.md`.
