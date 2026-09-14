# Session state

Agent-maintained. Named by `project-profile.yaml` → `autonomy.state_file`; the SessionStart hook
prints it, so keep it under ~30 lines: where work stopped, what is in flight, what the next session
does first. Not a log — overwrite, don't append.

- **Stage:** `demo-rush` (rushed / high / solo), ends 2026-09-16. Then `demo-harden` to 2026-09-20.
- **Branch in flight:** `002-team-workspaces` — spec 002 TG-1. T020, T021 done; **T022** (fork block
  C triggers) is next, then T023 policy swap, T024 RPCs, T025 admins, T026 provisioning, T027 gate.
- **Process branch:** `tg/plumbline-v5` — structure-contract upgrade v1 → v5 (profile, ledger,
  approvals, §7 Stages, ADR-0008). Owner merges into `002-team-workspaces`.
- **Open owner gates:** `docs/owner-approvals.md` 2, 3, 4.
- **Next session, first:** read this file, then `specs/002-team-workspaces/tasks.md` T022.
