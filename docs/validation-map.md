# Validation Map — Dandori

Bootstrapped by audit (`auditing-existing-project` skill), read-only pass, no source edits.
Repo: inherited from upstream `nitatsuu` (single-user personal planner). Fork will add team
workspaces, agent task-file sync, speckit ingestion — this map covers what EXISTS today only.

Bootstrap rule applied: every entry starts `UNTESTED` unless a receipt below proves otherwise.
No inherited/green history was trusted. Bootstrapped at `structure-version: 1`; the repo moved to
`structure-version: 5` on 2026-09-14 (ADR-0008) — entry grammar unchanged, so no entry was re-stamped.

Repo has **no `docs/`, `specs/`, `decisions/` before this audit** — non-conforming to the full
structure contract; this file and a stub `docs/project-structure.md` are the first step, not a
claim the rest exists.

---

## ENV

```yaml
- id: env-boot
  kind: env
  criticality: HIGH
  status: VALIDATED
  paths: [package.json, vite.config.ts, tsconfig*.json, .env.example]
  verify: "npm install && npx tsc -b --noEmit && npm run build && npm run lint"
  tests: —
  depends-on: []
  scenarios: —
  last-verified: 88e74aa 2026-09-12
  sign-off: audit-agent (single-operator) — receipts below
```

**Receipts (this session, SHA `88e74aa`):**
- `npm install` — PASS. `node_modules` was absent; installed clean, 400 packages. 3 high
  npm-audit advisories reported (transitive deps) — not investigated further, see queue.
- `npx tsc -b --noEmit` — PASS, zero errors, zero output.
- `npm run build` (`tsc -b && vite build`) — PASS. Built in 1.08s, PWA precache generated
  (13 entries, 266 KB), no warnings.
- `npm run lint` (`oxlint`) — PASS, exit 0, no findings.
- `.env.local` — **absent**, not created, not read. README states the app "does not start
  and says so explicitly" without it — this was not verified live (would require touching
  real Supabase credentials, out of scope per session rules). `npm run dev` was **not run**.
- No CI config found (`.github/` absent) — these checks have never run automatically.

These receipts establish the toolchain boots and compiles cleanly. They establish **nothing**
about runtime correctness, Supabase connectivity, RLS behavior, or sync correctness — see Gate 2
distinctions below.

---

## Data & sync layer (fork substrate — HIGH)

```yaml
- id: local-cache
  kind: store
  criticality: HIGH
  status: VALIDATED
  paths: [src/db/local.ts, src/db/types.ts, src/db/hooks.ts]
  verify: "npx vitest run tests/local/claim-cache.test.ts"
  tests: [tests/local/claim-cache.test.ts]
  depends-on: []
  scenarios: [s-account-switch-wipe]
  last-verified: 5448a0d 2026-09-13
  sign-off: Andrii Tkhorenko (single-operator) — specs/001-validation-spine/receipts.md

- id: db-api
  kind: lib
  criticality: HIGH
  status: VALIDATED
  paths: [src/db/api.ts, src/db/dates.ts]
  verify: "npm test -- --run --project local tests/local/db-api-p1-surface.test.ts"
  tests: tests/local/db-api-p1-surface.test.ts
  depends-on: [local-cache]
  scenarios: [s-offline-edit-sync]
  last-verified: 9bc5687 2026-09-13
  sign-off: Andrii Tkhorenko (single-operator) — specs/002-team-workspaces/receipts.md "db-api receipt (T002)"

- id: sync-engine
  kind: adapter
  criticality: HIGH
  status: VALIDATED
  paths: [src/sync/sync.ts]
  verify: "npx vitest run tests/stack/offline-round-trip.test.ts tests/stack/lww-conflict.test.ts tests/stack/soft-delete.test.ts"
  tests: [tests/stack/offline-round-trip.test.ts, tests/stack/lww-conflict.test.ts, tests/stack/soft-delete.test.ts]
  depends-on: [local-cache, supabase-auth, supabase-schema]
  scenarios: [s-offline-edit-sync, s-conflict-lww]
  last-verified: ec12db6 2026-09-13
  sign-off: Andrii Tkhorenko (single-operator) — specs/001-validation-spine/receipts.md "2026-09-13 — sync-engine receipt repaired (002 T003–T005)"

- id: supabase-schema
  kind: adapter
  criticality: HIGH
  status: VALIDATED
  paths: [supabase/schema.sql, supabase/migration-002-note-link-and-mute.sql, supabase/migration-003-synced-at.sql, supabase/migration-004-gcal.sql, supabase/migration-005-gcal-placed.sql, supabase/migration-006-lww-and-ownership.sql]
  verify: "npx vitest run tests/stack/schema-apply.test.ts tests/stack/rls-two-accounts.test.ts"
  tests: [tests/stack/schema-apply.test.ts, tests/stack/rls-two-accounts.test.ts]
  depends-on: []
  scenarios: [s-conflict-lww, s-workspace-delete-cascade]
  last-verified: 381122b 2026-09-14
  sign-off: Andrii Tkhorenko (single-operator) — specs/002-team-workspaces/receipts.md "T022 receipt — fork block C" (re-verified after fork blocks A, B and C; specs/001-validation-spine/receipts.md remains the original P0 receipt)

- id: account-provisioning
  kind: store
  criticality: HIGH
  status: UNTESTED
  paths: [supabase/schema.sql, src/db/api.ts, src/sync/sync.ts, src/components/Settings.tsx]
  verify: "npx vitest run --project stack tests/stack/logins-provisioning.test.ts tests/stack/team-schema-guards.test.ts tests/stack/logins-mint-empty-password.test.ts"
  tests: [tests/stack/logins-provisioning.test.ts, tests/stack/logins-mint-empty-password.test.ts]
  depends-on: [supabase-schema, supabase-auth, db-api]
  scenarios: []
  last-verified: —
  sign-off: —
  accepted-risk: "entry created UNTESTED ahead of its code so the 002 cards T008 and T018 cite a substrate that exists in the map (ADR-0006 Consequences, \"Validation map\"); covers the provisioning routines, the first-account trigger on auth.users and the admin guards. T025/T026 have now landed and the verify command above is green (21 files / 204 tests, exit 0, @ 18d6828, 2026-09-14) — this entry stays UNTESTED only because a HIGH-tier promotion is the owner’s to sign: it is QUEUED FOR SIGN-OFF, not unproven. Nothing reaches VALIDATED without a receipt naming command, revision, date and the (single-operator) sign-off (coordinator, 2026-09-14)"

- id: membership
  kind: store
  criticality: HIGH
  status: UNTESTED
  paths: [supabase/schema.sql, src/db/api.ts]
  verify: "NONE — needs writing; becomes `npx vitest run --project stack tests/stack/members-two-accounts.test.ts tests/stack/kind-switch.test.ts` once T020–T024 land"
  tests: —
  depends-on: [supabase-schema, supabase-auth]
  scenarios: []
  last-verified: —
  sign-off: —
  accepted-risk: "entry created UNTESTED ahead of its code so the 002 cards T010, T014, T017, T019, T021, T022, T024 and T026 cite a substrate that exists in the map (ADR-0006 Consequences, \"Validation map\"); covers `public.members`, the `members_one_per_person` constraint, `is_member`/`is_owner`, `on_workspace_kind_change` and the two membership RPCs. The red-first tests these cards write are committed **red** on purpose and prove nothing until the schema cards land; nothing reaches VALIDATED without a receipt naming command, revision, date and the (single-operator) sign-off (coordinator, 2026-09-14)"

- id: team-rls
  kind: store
  criticality: HIGH
  status: UNTESTED
  paths: [supabase/schema.sql]
  verify: "NONE — needs writing; becomes `npx vitest run --project stack tests/stack/team-rls-both-halves.test.ts tests/stack/rls-two-accounts.test.ts tests/stack/personal-unchanged.test.ts` once T023 lands"
  tests: —
  depends-on: [supabase-schema, membership]
  scenarios: []
  last-verified: —
  sign-off: —
  accepted-risk: "entry created UNTESTED ahead of its code so the 002 cards T011–T017 and T023 cite a substrate that exists in the map (ADR-0006 Consequences, \"Validation map\"); covers the replaced `own_rows` predicate block on `workspaces`/`labels`/`tasks`/`notes` and the fork-only `members_access` policy. **The asymmetry documented in the fork-substrate note below is the thing at risk**: both halves of each policy are replaced separately, and a single predicate pasted into both would change the security model silently. Until T023 lands and T011–T013 run green, the fork has no executed evidence that team access resolves correctly or that personal access is unchanged; nothing reaches VALIDATED without a receipt naming command, revision, date and the (single-operator) sign-off (coordinator, 2026-09-14)"

- id: multi-account-cache
  kind: store
  criticality: HIGH
  status: UNTESTED
  paths: [src/db/local.ts, src/db/api.ts]
  verify: "npx vitest run --project local tests/local/no-wipe-on-reach-growth.test.ts tests/local/claim-cache.test.ts"
  tests: [tests/local/no-wipe-on-reach-growth.test.ts, tests/local/claim-cache.test.ts]
  depends-on: [local-cache]
  scenarios: []
  last-verified: —
  sign-off: —

- id: supabase-auth
  kind: adapter
  criticality: HIGH
  status: UNTESTED
  paths: [src/auth/supabase.ts, src/auth/useSession.ts]
  verify: "NONE — needs writing"
  tests: —
  depends-on: []
  scenarios: [s-auth-session-recovery, s-account-switch-wipe]
  last-verified: —
  sign-off: —
  accepted-risk: "sign-out ordering uncovered; browser-bound. Owner: Andrii Tkhorenko, 2026-09-13, expires end of P2 (Playwright arrives, ADR-0003)"
  accepted-risk: "UNTESTED supabase-auth accepted as incidental substrate for the 002 P1 harness cards T007–T019 (owner, 2026-09-14; specs/002-team-workspaces/receipts.md \"Owner decisions 2026-09-14\" #1)"
```

**Fork-substrate note (per task):** `sync-engine` + `supabase-schema` are the components the
fork stands on directly:
- **Conflict layer** = `sync-engine`'s whole-row LWW merge (`sameRow`/`isNewer`, `sync.ts:104-141,409-458`)
  paired with the server-side `keep_newer()` trigger (`schema.sql:142-153`).
  Two independent enforcement points, currently in agreement — a membership model must not
  silently change one without the other.
- **RLS/ownership model** (`schema.sql:228-255`, `schema.sql:16-91`) is
  **single-owner only**: every row carries one `user_id` and `workspaces` has no
  membership/collaborator concept at all.

  **Correction (foundations pass, 2026-09-12): the policy predicates are NOT uniformly
  `auth.uid() = user_id`.** Each table has exactly one `for all` policy named `own_rows`, and its
  two halves differ:
  - **Reads** (`USING`) are `auth.uid() = user_id` alone — `schema.sql:241` (workspaces),
    `schema.sql:248` (labels/tasks/notes).
  - **Writes** (`WITH CHECK`) on `labels`/`tasks`/`notes` *additionally* require the target
    workspace to be yours — `schema.sql:249-253`, re-issued verbatim at
    `schema.sql:244-254`. A foreign key checks that a workspace exists,
    never whose it is, so without this clause anyone who learned a workspace id could insert into
    it (rationale `schema.sql:222-228`).

  The asymmetry is deliberate and load-bearing: reads stay loose so a not-yet-synced workspace
  cannot hide your own rows. **P1 must replace both halves separately and preserve the
  asymmetry.** A membership predicate written once and pasted into both would silently change the
  security model — the most likely way this transform goes wrong quietly.

  Team workspaces is not additive
  here — it replaces the ownership predicate on 4 tables and the local `claimCache`/`wipeLocal`
  single-owner cache model (`src/db/local.ts:89-125`), which assumes exactly one account per
  device cache.
- **Schema migration pattern**: numbered, hand-written, idempotent SQL files run manually in the
  Supabase SQL editor (`supabase/migration-00N-*.sql`, guarded `create or replace` / `if not exists`
  / `drop ... if exists`). No migration tool, no down-migrations, no automated apply step — the
  fork's new migrations must follow this same manual-idempotent convention or diverge from it
  explicitly.
- **Workspace model**: `public.workspaces` is a flat per-user table (`schema.sql:16-28`); nothing
  resembling a members/roles join table exists anywhere in schema or code.

---

## Google Calendar integration (NORMAL — optional, side-effecting)

```yaml
- id: gcal-integration
  kind: adapter
  criticality: NORMAL
  status: UNTESTED
  paths: [src/gcal/api.ts, src/gcal/client.ts, src/gcal/sync.ts, src/components/Gcal.tsx, worker/index.ts]
  verify: "NONE — needs writing; would require live Google OAuth + Calendar API, not touched this session"
  tests: —
  depends-on: [db-api, sync-engine]
  scenarios: [s-gcal-round-trip]
  last-verified: —
  sign-off: —
```

Reconciliation-on-tick design (`src/gcal/sync.ts:1-14`): no write path hooks the event directly;
a periodic pass diffs every task's desired event against a local `meta` signature and sends the
difference. One-way (app → Calendar) as stated in the task brief; nothing here reads back edits
made in Google Calendar itself.

---

## UI layer (NORMAL/LOW)

```yaml
- id: views-core
  kind: ui
  criticality: NORMAL
  status: UNTESTED
  paths: [src/views/Board.tsx, src/views/board/, src/views/Timeline.tsx, src/views/timeline/, src/views/Notes.tsx]
  verify: "NONE — needs writing"
  tests: —
  depends-on: [db-api]
  scenarios: —
  last-verified: —
  sign-off: —

- id: task-dialog
  kind: ui
  criticality: NORMAL
  status: UNTESTED
  paths: [src/components/TaskDialog.tsx]
  verify: "NONE — needs writing"
  tests: —
  depends-on: [db-api]
  scenarios: —
  last-verified: —
  sign-off: —

- id: chrome-components
  kind: ui
  criticality: LOW
  status: UNTESTED
  paths: [src/components/Header.tsx, src/components/Settings.tsx, src/components/SignIn.tsx, src/components/SyncBadge.tsx, src/components/TabBar.tsx, src/components/Confirm.tsx, src/components/LabelFilter.tsx, src/components/ReminderBanner.tsx]
  verify: "NONE — needs writing"
  tests: —
  depends-on: [supabase-auth, sync-engine]
  scenarios: —
  last-verified: —
  sign-off: —

- id: i18n-state
  kind: lib
  criticality: LOW
  status: UNTESTED
  paths: [src/i18n/dict.ts, src/i18n/dates.ts, src/i18n/index.ts, src/state/ui.ts, src/state/useToday.ts, src/lib/]
  verify: "NONE — needs writing"
  tests: —
  depends-on: []
  scenarios: —
  last-verified: —
  sign-off: —
```

---

## Scenarios

```yaml
- id: s-offline-edit-sync
  status: VALIDATED
  chain: [local-cache, db-api, sync-engine, supabase-schema]
  happy-path: "tests/stack/offline-round-trip.test.ts — 4 acceptances PASS."
  expected: "Row lands server-side unchanged except server-assigned synced_at; local _dirty clears; no duplicate/loop pull."
  last-verified: e7f258d 2026-09-12
  sign-off: Andrii Tkhorenko (single-operator) — specs/001-validation-spine/receipts.md

- id: s-conflict-lww
  status: VALIDATED
  chain: [sync-engine, supabase-schema]
  happy-path: "tests/stack/lww-conflict.test.ts — 6 tests PASS, both enforcement points + SC-008 demonstration."
  expected: "Server keeps the newer updated_at (keep_newer trigger + client isNewer/sameRow check agree); loser's push is silently dropped, not retried forever."
  last-verified: e7f258d 2026-09-12
  sign-off: Andrii Tkhorenko (single-operator) — specs/001-validation-spine/receipts.md

- id: s-workspace-delete-cascade
  status: VALIDATED
  chain: [supabase-schema, sync-engine]
  happy-path: "tests/stack/soft-delete.test.ts — 3 tests / 4 acceptances PASS."
  expected: "follow_workspace_delete + stay_deleted_with_workspace jointly soft-delete the late-arriving row; nothing orphaned live under a deleted workspace."
  last-verified: e7f258d 2026-09-12
  sign-off: Andrii Tkhorenko (single-operator) — specs/001-validation-spine/receipts.md

- id: s-gcal-round-trip
  status: UNTESTED
  chain: [gcal-integration, db-api]
  happy-path: "Give a task a due date + gcal config; wait one tick; edit it; wait a tick; clear the date. Manual walk only."
  expected: "Event created, then updated in place (not duplicated), then deleted; gcal_placed cleared."
  last-verified: —
  sign-off: —

- id: s-auth-session-recovery
  status: UNTESTED
  chain: [supabase-auth, local-cache]
  happy-path: "Open the app fully offline with a previously-persisted session. Manual walk only."
  expected: "App renders signed-in within AUTH_TIMEOUT_MS (1500ms) from localStorage, never blocks on network."
  last-verified: —
  sign-off: —

- id: s-account-switch-wipe
  status: VALIDATED
  chain: [local-cache, supabase-auth]
  happy-path: "tests/local/claim-cache.test.ts — 5 tests PASS, Docker-free."
  expected: "claimCache detects owner mismatch, wipes local tables before B's data is drawn; no A row ever flashes on B's screen."
  last-verified: e7f258d 2026-09-12
  sign-off: Andrii Tkhorenko (single-operator) — specs/001-validation-spine/receipts.md
```

---

## Quarantine list (DEAD-looking — never delete, owner decides)

**None found this pass.** No orphaned files, no commented-out blocks, no unreferenced exports
were identified in the areas read. Superseded-looking items are historical, not dead:
`supabase/migration-002` through `-005` are prior schema steps folded into the running schema —
normal migration lineage, not quarantine candidates. Re-check if a deeper sweep of `src/lib/` and
`src/state/` turns up unused exports; this pass did not do an unused-export scan (would need a
bundler/lint pass beyond `oxlint`'s default ruleset — noted in the owner-decision queue).

---

## What this map does NOT establish (Gate 2 truth table)

| What exists | What it does NOT establish |
|---|---|
| `npm run build` is clean | The sync engine, RLS policies, or Google Calendar integration behave correctly at runtime |
| `tsc -b --noEmit` is clean | Logical correctness — only that types are internally consistent |
| Detailed, careful code comments throughout `sync.ts` / migration SQL | That the documented invariants actually hold under concurrent load — no test exercises them |
| `oxlint` is clean | Anything beyond its (narrow, fast) default rule set — no type-aware lint, no unused-export sweep |
| Git history is clean, commits are small and frequent | Recent commits touch the exact HIGH-tier surfaces (gcal sign-out ordering, LWW ownership, touch-target sizing) — active, not settled, code |
| No test files anywhere in the repo | The app is untested by definition, not "tested but not visible to this scan" |
