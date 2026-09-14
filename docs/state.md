# Session state

Agent-maintained. Named by `project-profile.yaml` → `autonomy.state_file`; the SessionStart hook
prints it, so keep it under ~30 lines: where work stopped, what is in flight, what the next session
does first. Not a log — overwrite, don't append.

- **Stage:** `demo-rush` (rushed / high / solo), ends 2026-09-16. Then `demo-harden` to 2026-09-20.
- **Session ended 2026-09-14 with two agents possibly mid-flight — check `git status` first:**
  - primary (`002-team-workspaces`): **T023a** coder — `supabase/schema.sql`, `contracts/policies.sql`
    (partially committed at 9b35710), new `tests/stack/team-rls-delete-and-owner-invariant.test.ts`.
    If uncommitted edits exist and the new test + whole stack tier are green, commit as
    `rls: split policies so DELETE stays creator-only; owner invariant; keep_creator on workspaces (T023a)`.
    If unfinished, re-dispatch T023a from its card; its receipt may already be in receipts.md.
  - `wt/ui` (C:\ProjectsC\KSE\Dandori-wt-ui @ 0f4f5db): ui-lane fix pass — `Header.tsx`, `Confirm.tsx`,
    `Settings.tsx` (password state clear; A-012 `AskName` collapse). Commit if tsc/lint/build pass.
- **Lane `wt/sync-cache`** @ c783b3e: code complete, reviewed (T038 PASS). Owed at merge: T039
  `sync-engine` re-verify, map re-stamps `local-cache`, `db-api`; `multi-account-cache` flip.
- **Lane `wt/ui`**: T041–T050 done, reviewed PASS; fix pass above. Owed: nothing else.
- **Merge order:** commit T023a → `supabase db reset` + schema apply → merge `wt/sync-cache` then
  `wt/ui` into `002-team-workspaces` → `npm test -- --run` twice (full green expected now) →
  map flips (`supabase-schema`, `membership`, `team-rls`, `account-provisioning`, T051/T052) →
  T053 receipts → **T057 whole-branch review** → deploy.
- **Deploy (owner gate 10):** blocked until the above. Owner-manual first: T058 run `supabase/schema.sql`
  in the hosted SQL editor, T059 first-admin insert; then agent: `npm run build && npx wrangler deploy`
  (token already in env, never `wrangler login`); then owner T060 disable e-mail sign-ups.
- **Known UX gap to raise at T057/T058:** owner-only controls stay hidden until the seeded owner
  row is pulled (offline right after creating a team workspace) — inherent to D-6.
- **Spec 003 draft:** branch `spec/003-agent-edit-layer` @ 3b87c87 — 9 owner questions in plan.md.
- **Decision debt:** A-001..A-016 all reviewed (0/5 open). Open owner gate: gate 3 deferred.
- **Next session, first:** read this file, `git status` in all three checkouts, then the
  `[in-progress: …]` markers in `specs/002-team-workspaces/tasks.md`.
