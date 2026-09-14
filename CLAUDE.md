# Dandori (fork) — agent contract

**This is the fork's contract. It supersedes upstream's `CLAUDE.md`**, which is preserved verbatim
at `docs/upstream-CLAUDE.md` for merge reference. Where the two disagree, this file wins. Where
this file is silent, upstream's product decisions (board, timeline, notes, reminders, PWA
behaviour) still stand — they were not forked away.

---

## Fork vision

Upstream Dandori is a deliberately minimal single-user offline-first personal planner PWA. This
fork turns it into a **self-hosted, open-source team planner** without taking the personal planner
away: a workspace is `kind: personal` — behaving exactly as upstream ships it — or `kind: team`,
where access is resolved through two-level membership instead of a single owner. v1 is the minimal
transform that makes that true.

**Where the data lives is decided, not defaulted.** Each person hosts at most one Supabase origin;
a shared workspace lives wholly on its host's origin; **data never crosses origins** (ADR-0004).
Nobody's private workspaces can be deleted out from under them by someone else's project going
away.

**The differentiator is the agent-edit layer, and it is a first-class product surface.** Coding
agents already read and write files in a repository, so the fork meets them there: **agents
interact with the planner through local task files.** The database stays the source of truth; a
per-project set of task files is a **working copy** of it, synced both ways by a `dandori` CLI —
pull tasks into files, edit them in the repo by hand or by agent, push them back. Agents get
read/edit access to tasks and nodes the same way they get access to source. MCP arrives later and
stays **thin**: a convenience surface over the same operations, never a second, divergent way in.
Speckit `tasks.md` ingestion and a teamlead stuck-detection view sit on top of that layer.

Board features, by contrast, stay boring on purpose.

---

## Read order

Every session, in this order. Stop as soon as you have what the task needs.

1. **This file** — contract, phase state, roles, git rules.
2. **`project-profile.yaml`** — `current_stage` and that stage's `rigor` (how much evidence a
   promotion owes) and `autonomy` (how often the owner is interrupted). Separate axes; neither
   substitutes for the other. The SessionStart hook prints them, plus `docs/state.md` and the
   decision-debt count. Every off-plan decision gets a row in `docs/assumptions.md` §A; every owner
   question gets a B1..B5 class and a row in `docs/owner-approvals.md` (ADR-0008).
3. **`docs/validation-map.md`** — what is actually known to work. Cheapest context in the repo:
   it is the only place that distinguishes "written" from "verified".
4. **`docs/architecture-index.md`** → the cited **`ARCHITECTURE.md §N` ranges** in
   `docs/ARCHITECTURE.md`. Index first, ranged read. Never the whole file.
5. **`docs/decisions/ADR-000N-*.md`** — when a choice surprises you, or before you change one.
6. **`specs/README.md`** → **`specs/NNN-<feature>/`** — the feature you are implementing.

Reference, not read-order: `docs/project-structure.md` (repo layout + map grammar,
`structure-version: 5`), `docs/upstream-CLAUDE.md` (upstream's contract, for merge diffs only —
**never** quote it as fork policy).

One fact, one home. Link, don't restate.

---

## The contract (ADR-0001 + ADR-0004 + ADR-0005, summarized — the ADRs are authoritative)

- **Workspace kind.** `workspaces.kind` is `personal` or `team`, defaulting to `personal`.
  Personal behaves exactly as upstream ships it. Team resolves access through membership.
- **Membership is two-level**: `owner` (invite, remove, delete the workspace) and `member`
  (everything else). Not flat, and not a general role system. A read-only viewer level is not in
  v1 and would need a new ADR.
- **`assignee` is a label, not a permission.** The planned nullable per-task `assignee` points at a
  user of the same origin and carries **no** authorization meaning at v1 — RLS never reads it.
- **Data never crosses origins** (ADR-0004). A shared workspace lives wholly on its host's origin;
  every `user_id`, `workspace_id` and `assignee` refers to *that* origin's `auth.users`. No
  cross-origin foreign keys, no identity federation, no global account, no cross-origin queries.
  If you are asked to make one workspace visible from two origins, that is not a feature — it
  deletes the model, and it needs an ADR that replaces ADR-0004.
- **Federation needs zero schema support**, so P1 must **not** anticipate it: an "origin" column or
  table in the P1 migration is wrong, not early.
- **Additive tables, replaced policies.** Tables and columns are only ever *added*; no upstream
  table or column is repurposed. RLS policy predicates are the **one** sanctioned replacement
  surface — team access cannot be expressed additively, because permissive policies only ever
  widen. Both halves of each `own_rows` policy are replaced, and the existing read/write asymmetry
  is preserved, not flattened.
- **LWW lockstep.** Client merge (`src/sync/sync.ts:409-458`) and the server `keep_newer()` trigger
  (`supabase/schema.sql:142-153`) are *one rule with two enforcement
  points*. Neither changes without the other, in the same change set.
- **Triggers survive.** `keep_newer`, `stay_deleted_with_workspace`, `follow_workspace_delete` must
  behave identically after the predicate swap.
- **Migrations.** Upstream's convention kept, as amended by upstream `a3a7572` and adopted in
  ADR-0005: `supabase/schema.sql` is the one idempotent home of every definition (tables, guarded
  column adds, functions, triggers, policies) and is re-run to upgrade a database; a
  `migration-00N-*.sql` carries only one-off row edits. Hand-written, run manually in the Supabase
  SQL editor. Fork migrations, when one is needed, start at **migration-007**. No down-migrations —
  recorded as an owner-accepted risk.
- **Upstream merges** are routine and expected. Upstream stays personal-only. Nothing is
  contributed back by default. `docs/upstream-CLAUDE.md` stays byte-identical to upstream so every
  divergence is diffable.
- **Solo operator.** Sign-offs are `Andrii Tkhorenko (single-operator)` — a real receipt and an
  acknowledged weakness at the same time, never independent review.

### What replaces upstream's "What must not exist"

Upstream's closed list is **explicitly superseded** for this fork — its first bullet forbids
collaboration, which is the fork's whole point. Two rules replace it, and they are just as binding:

1. **Personal workspaces must not regress.** Any change whose effect on a `kind: personal`
   workspace is observable — in data, in sync behaviour, in the views — is a defect, unless the
   owner decided otherwise in an ADR.
2. **No feature outside `specs/`.** Upstream's minimalism principle survives intact; only its gate
   moved. "If it is not in this file it must not exist" became "if it is not in a spec it must not
   exist". An extra button is still a failed requirement, not a bonus.

---

## Phase state

Phases are hard-gated, in order, per ADR-0002: **P0** validation spine on existing behaviour →
**P1** minimal team transform → **P2** route scenarios, happy-walk, MCP-driven testing, Playwright
→ **P3** agent layer.

**The gate: no phase starts while the substrate it stands on is `UNTESTED`.**

**P0's backend is the `supabase` CLI local stack** — real Postgres, RLS and triggers in Docker,
well-known development keys, nothing secret in the repo, run as a CI service. Two-account
scenarios are two supabase-js clients in one vitest process, not a browser.

**Owner-scheduled, at the P2/P3 boundary:** ADR-0004's origin registry and per-origin client layer.
Not automatically next after P1, not a P3 prerequisite. Runtime origin config may land earlier on
its own self-hosting merit.

Current phase and what is blocking it are **not recorded here** — they are read from
`docs/validation-map.md`, which is the single source of truth for status. As of the 2026-09-12
audit (`88e74aa`): only `env-boot` is `VALIDATED`, and its receipts prove the toolchain compiles,
nothing more. Everything else is `UNTESTED`. That means **P0**.

A task that is not clearing map debt, and is not P0 work, needs the owner's word before it starts.

---

## Agent roles

The split is by layer — upstream's, kept because it is good. An agent does not touch files owned by
others: if a change is needed beyond its boundary, it says so in its report and the coordinator
decides who makes it. Layer agents do not have each other's context and must not invent it. Not
enough information — ask the coordinator.

### `coordinator` — main session

Stands above everyone. The only agent with the full project context: the fork's history, the ADRs
and why they were made, the state of every layer at once.

- Assigns tasks, accepts reports, resolves disputes between layers, adjusts ownership boundaries.
- Decides what to do with `reviewer` findings.
- **The only one who talks to the owner.** A fork that cannot be resolved from this file, the ADRs
  and the map goes to the owner as 2–4 questions with answer options.
- Keeps this file and the ADRs current: a new owner decision lands in an **ADR** first, is
  summarized here, and only then reaches the code.
- Owns phase gates. Nobody else declares a phase started or a gate cleared.

### `data` — data and sync

Owns: `supabase/`, `src/db/`, `src/sync/`, `src/auth/`, `src/gcal/`.

This is the fork's HIGH-tier surface and the only layer that can lose or leak data. Everything in
the ADR-0001 contract above binds it directly.

- Postgres schema, migrations, RLS policies, the two-level membership model, the `assignee` column.
- Supabase client, authentication, session, sign-out ordering.
- Dexie local cache, the offline queue, conflict resolution, the multi-account rework — written so
  that ADR-0004's `(origin, account)` key is a **widening** of it, never a later rewrite.
- Later, and only when the owner schedules it: the origin registry and the per-origin client layer.
  Everything that is a singleton today — client, session, cache, cursors, sync status — becomes
  per-origin then. Do not pre-build it.
- Before changing anything in `src/sync/` or `supabase/`: read `ARCHITECTURE.md §4` (LWW,
  triggers, session guard) and check the map entry's status. Changing an `UNTESTED` HIGH-tier
  component without writing its test first is a P-gate violation, not a shortcut.

### `ui` — interface

Owns: `src/views/`, `src/components/`, `src/styles/`, `src/i18n/` (adding keys in both languages; rewording an existing string is a `designer`-rule violation for every role).

- Board (three modes), timeline, notes, task card, workspace switcher, label filter, banners.
- Themes, density, phone behaviour.
- **Takes data only through `src/db/api.ts`. Never talks to Supabase directly** — this is
  upstream's rule and the fork keeps it (`src/db/api.ts:20-21`).
- Team affordances are UI too, but they land only against a spec, and only after `data` has the
  membership model in place.

### `infra` — build and deploy

Owns: `vite.config.ts`, the manifest and service worker, `wrangler.jsonc`, `worker/`, `.github/`,
`README.md`.

- Build config, PWA, deploy to Cloudflare Workers static assets, hosted Supabase.
- CI (`.github/workflows/ci.yml`): install, typecheck, lint, build. The `test` step and the
  `supabase` local-stack service beside it are committed commented out, and are uncommented
  together by P0's first vitest suite — not before.
- Secrets never enter the repository, under any circumstances. The three `VITE_` vars are inlined
  at build time; there is no client secret and no `service_role` key here. The local test stack's
  keys are fixed development values, which is why they may be committed and a hosted project's
  never may. The Google client secret used by `worker/index.ts` lives only in Cloudflare Worker
  secrets — never in the repository, never in the bundle (ADR-0007).
- Later: moving origin config from build-time `VITE_` inlining to **runtime** (ADR-0004). One
  artifact, any origin — the thing that makes a published build usable by a self-hoster who did
  not build it.

### `designer` — visual design

Owns nothing on the main branch. Works in a separate worktree on a `design` branch, never pushes,
never deploys. A bad pass is thrown away by deleting the branch.

Touches `src/styles/` and the `.css` of views and components, plus the smallest markup change a
style genuinely needs. Never `src/db/`, `src/sync/`, `src/auth/`.

- Spacing, type scale, colour tokens, borders, shadows, hover and focus states; parity between the
  two themes and between laptop and phone.
- **Adds nothing.** Restyling what exists is design; adding an element is a finding. Reordering
  what is already on screen needs the owner's word.
- Interface text is not reworded, shortened or retranslated. Both languages live in `src/i18n/`;
  a string changes there or not at all.

### `reviewer` — review, regression control, map discipline

Owns nothing, only reads. Looks at every piece before it is committed. Five duties:

1. Code quality: correctness, dead code, duplication.
2. **Personal-must-not-regress control.** Does this diff change what a `kind: personal` workspace
   does? If yes and no ADR says so, it is a finding.
3. **Spec control.** A feature, button or field that is not in a spec is a finding, not an
   improvement.
4. **Origin-invariant control.** Anything that relates two origins — a cross-origin reference,
   query, shared identity or token — is a finding, no matter how convenient. So is an "origin"
   column or table appearing in P1, which anticipates a model that needs no schema support.
5. **Map discipline.** A PR touching a component's `paths` without updating its map entry is a
   finding. So is a `VALIDATED` claim with no receipt, and a sign-off on your own work presented
   as anything other than `(single-operator)`.

Verdict is short: a list of findings, or "clean". Anything debatable goes to the owner via the
coordinator, not decided by an agent.

---

## Git

- **Commits are authored by the fork owner, using the normal local git identity**
  (`git config user.name` / `user.email`). Do **not** set an `--author` override, and do **not**
  author as `nitatsuu` — that identity belongs to upstream and using it misattributes fork work.
- **No mentions of the assistant.** No `Co-Authored-By` trailer, no "Generated with" line — not in
  commits, not in the README, not in code comments. `.claude/settings.json` keeps
  `includeCoAuthoredBy: false`.
- Commit after every finished piece, not in one dump at the end.
- Messages stay in upstream's style: `<area>: <what was done>`. Areas: `board`, `timeline`,
  `notes`, `ui`, `db`, `sync`, `auth`, `pwa`, `build`, `docs`, plus the fork's `team`, `rls`,
  `test`, `ci`.
- Keys and tokens never enter the repository. Everything local goes in `.gitignore`.
- **Upstream merges**: merge from the `upstream` remote regularly. An upstream change to
  `CLAUDE.md` lands in `docs/upstream-CLAUDE.md` (whose body stays byte-identical to upstream
  below its one comment header) and is then *decided upon* for this file — never auto-merged into fork policy. Conflicts in `supabase/*.sql` are
  expected on policy bodies and are checked by hand; that is the known, bounded tax of the fork.
- An architecture change is a **new ADR + a `STALE` cascade on the affected map entries + a
  regenerated `docs/architecture-index.md`, all in the same PR.** Editing `docs/ARCHITECTURE.md`
  without an ADR, or without regenerating the index, are both violations.

---

## Definition of done

A piece is done when all of these hold — not when it works on your machine:

- Its map entry in `docs/validation-map.md` is updated in the same PR: status, `last-verified`
  SHA + date, `sign-off`, and the receipt that backs it.
- Its `verify` command was actually run and passed. A silently skipped check is not a pass.
- CI is green: install, typecheck, lint, build (plus tests, once P0 has landed them).
- Personal workspaces are unchanged — demonstrably, not assumed.
- Nothing in the diff exists outside a spec.
- No credential, key or token is anywhere in the diff.
