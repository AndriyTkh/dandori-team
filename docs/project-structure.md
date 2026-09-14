# Project Structure Contract

`structure-version: 5`  (v5: the on-disk format of `docs/assumptions.md` §A/§B is pinned here — markdown tables, fixed column order, verbatim headings — and `docs/defects.jsonl` joins the layout. v4: the component/scenario entry grammar becomes single-home here — scenario entries gain `e2e-check` and `fixture`, and `tracking-validated-components` stops restating the format; `docs/owner-approvals.md` and `docs/state.md` named, §B column grammar fixed. v3: adds `artifacts/metrics/events.jsonl` and the B1..B5 blocker vocabulary — see [ledger-events.md](ledger-events.md), [blocker-taxonomy.md](blocker-taxonomy.md); adds the `autonomy` axis, `decision_debt_max`, `docs/assumptions.md` as a named file — ADR-0005. v2: adds `project-profile.yaml`, ARCHITECTURE §7 Stages, rigor vocabulary — see [project-profile.md](project-profile.md))

The fixated, machine-parseable repo layout for validated-development projects. Skills materialize and maintain it; tooling (team-lead / metrics apps) parses repos against it. This file is the tiebreaker: a format change anywhere (including a spec-kit template upgrade) requires bumping `structure-version` here first — otherwise the repo is non-conforming, not the contract wrong. Parsers fail soft: report non-conforming, never crash.

**Distribution:** master copy lives in the project-compass skill. `establishing-project-foundations` (output 8) and `auditing-existing-project` (Gate 3) copy it into the repo as `docs/project-structure.md` so tools parse per-repo.

## Layout

```
repo/
  CLAUDE.md                      # agent read order; fixed section names
  project-profile.yaml           # type / mode / deadlines / stages / current_stage / agents defaults — contract: project-profile.md (compass reference)
  project-profile.local.yaml     # per-user, GITIGNORED; only agents: (model/effort tiers) is honoured
  .claude/agents/dev-main.md     # rendered from local agents tiers; GITIGNORED
  .claude/agents/dev-worker.md   # rendered from local agents tiers; GITIGNORED
  ARCHITECTURE.md                # fixed skeleton §0–§7 (foundations skill); §7 Stages mirrors the profile's stage list
  architecture-index.md          # section → line ranges; regenerated same commit as any ARCHITECTURE.md edit
  docs/
    project-structure.md         # this contract, copied at foundations/audit time
    validation-map.md            # component + scenario entries (or docs/map/ shard dir, one file per component group)
    assumptions.md               # §A decision log: id · date · stage · task · decision · why · reversible · reviewed
                                 # §B known unknowns: id | question | default in use since | costs if wrong | owner gate
                                 # required at autonomy > low; every decision logged unconditionally
    owner-approvals.md           # numbered owner gates: gate | what is being decided | default in use | class (B1..B5) | status
                                 # appended to, never rewritten; OPEN | APPROVED <date> | REJECTED <date>
    state.md                     # session state, when the profile names one in autonomy.state_file
    defects.jsonl                # one JSON object per defect, when the profile names metrics.defects
  decisions/
    NNNN-<slug>.md               # ADR; NNNN zero-padded; one decision per file; immutable — supersede by new number
  specs/
    README.md                    # feature map table: | NNN | name | phase | tracker |
    NNN-<feature>/
      spec.md                    # spec-kit native, unmodified format
      plan.md                    # spec-kit native + "## Validation substrate" section
      tasks.md                   # spec-kit native + extensions below
  artifacts/
    metrics/events.jsonl         # append-only ledger; schema: ledger-events.md (compass reference); GITIGNORED, nothing gates on it
  _handoffs/                     # optional; ≤50-line session handoffs; deleted on merge
```

## Validation map — entry grammar

Component entry, exact field names, this order:

```yaml
- id: <kebab-slug>
  kind: <env | route | store | adapter | job | ui | lib>
  criticality: <HIGH | NORMAL | LOW>
  status: <UNTESTED | BROKEN | VALIDATED | STALE | DEAD>
  paths: <glob(s) — CI lint flips status to STALE when a PR touches them without a map update>
  verify: <exact command>
  tests: <test file(s)>
  depends-on: [<entry ids>]
  scenarios: [<scenario ids>] | —
  last-verified: <SHA> <YYYY-MM-DD> | —
  sign-off: <name> — <receipt ref> | <name> (single-operator) — <receipt ref> | —
  accepted-risk: <name>; <specific reason>; expires <YYYY-MM-DD>   # optional; only a named human
```

Scenario entry:

```yaml
- id: s-<kebab-slug>
  status: <same closed vocabulary>
  chain: [<component ids traversed>]
  happy-path: <script or named manual walk>
  e2e-check: <end-to-end command (CLI / MCP / app), or a named human check>
  fixture: <fixture id + version> | —
  expected: <output + one failure example>
  last-verified: <SHA> <YYYY-MM-DD> | —
  sign-off: <as above>
```

This grammar has one home — here. Skills reference it; none restate it. `kind` is a closed list: `env | route | store | adapter | job | ui | lib` (`job` covers background/worker jobs, `ui` covers screens). Scenario ids carry the `s-` prefix so a scenario id is never mistakable for a component id.

Closed vocabularies (nothing else exists):
- Map status: `UNTESTED | BROKEN | VALIDATED | STALE | DEAD`
- Receipt status: `PASS | FAIL | BLOCKED | NOT RUN | ACCEPTED RISK`
- Tiers: `HIGH | NORMAL | LOW` (per component, static)
- Rigor: `rushed | standard | regulated` (per stage, from `project-profile.yaml`); evidence required = tier × rigor lookup in tracking-validated-components
- Autonomy: `high | normal | low` (per stage, from `project-profile.yaml`); sets owner-interrupt frequency only — never an evidence discount. `decision_debt_max` is a non-negative integer, defaulting 5 / 2 / 0 by level, overridable per run.
- Phase: `P0 | P1 | P2 | P3`; gate cadence: `decision | sprint | feature`
- `(single-operator)` sign-off flag: solo-project promotion; parsers render it as reduced assurance, never as independent review.

## tasks.md grammar (spec-kit + extensions)

- Checkboxes: `- [ ]` open, `- [x]` done.
- Claim marker: `[in-progress: <lane-or-agent>]` appended to a task line at dispatch; removed on completion or abandonment. Never two claims on one task.
- Subtask marker: `[sub-of: <task-id>]` — a mid-flight discovery task, inserted under its parent, same taskgroup.
- Per-task fields (indented lines under the checkbox): `Write:` (files it may touch), `Read:` (its complete required context), `substrate:` (map entry ids it builds on).
- Taskgroup headers: `## TG-N` — a hard sequencing gate; TG-N+1 never starts before TG-N is fully merged and checked.
- Feature-level `## Workfile & conflict map` table: `| Task | Lane | Files |` — lane is `wt/<name>` or `serial`.

## plan.md extension

`## Validation substrate` — table of map entries the feature builds on + their status at planning time. Debt rows (UNTESTED/STALE/BROKEN) become the feature's first tasks.

## `docs/assumptions.md` — section format

Both sections are **GitHub-flavoured markdown tables**, one row per entry, columns in exactly the order listed in the layout above, header row plus separator, no extra columns and no reordering. A cell with no value is an em dash. This is stated because field *names* are not a format: two agents given only the names wrote a table and a bullet list, and neither could read the other.

```markdown
## §A Decision log

| id | date | stage | task | decision | why | reversible | reviewed |
|---|---|---|---|---|---|---|---|
| D-001 | 2026-09-14 | S1-scaffold | T-014 | … | … | yes | no |

## §B Known unknowns

| id | question | default in use since | costs if wrong | owner gate |
|---|---|---|---|---|
| U-001 | … | 2026-09-14 | … | Gate 4 |
```

Heading text is `## §A Decision log` and `## §B Known unknowns`, verbatim — the profile's `autonomy.decision_log` and `autonomy.assumptions` may name the same file, and the section heading is what distinguishes them. Both keys pointing at one path is normal, not a duplicate.

## Other parse rules

- §N citation format: `ARCHITECTURE.md §N` — resolve via architecture-index.md lines `## §N <title>: Lstart–Lend`; never full-file scan.
- specs/README.md `tracker` column values: `spec-kit` | `beads` | other. Anything but `spec-kit` marks the feature out of contract scope (legacy tracker).
- CLAUDE.md must state the read order: instructions → project-profile (current stage + rigor + autonomy) → architecture-index → cited §N ranges → validation map.
- A repo with `ARCHITECTURE.md` but no `project-profile.yaml` is non-conforming at v2; audit adds the profile.
- A repo whose profile sets `autonomy` above `low` but has no `docs/assumptions.md` is non-conforming at v3; audit adds the ledger.
- A profile naming `autonomy.state_file` for a file that does not exist is non-conforming — create it or drop the field.
- `docs/owner-approvals.md` is required wherever a gate has ever been queued. An approval recorded anywhere else (a commit message, a chat line, a code comment) does not count: the gate table is the only place an owner ruling is readable later. A stage with `autonomy:` absent is read as `low`, never as a permission.
- A repo missing `docs/validation-map.md` or `ARCHITECTURE.md` is non-conforming regardless of everything else present.

---

## Repo-local instantiation

Copied verbatim from the master (`project-compass/references/project-structure.md`,
`structure-version: 5`, suite `plumbline@0.9`) on 2026-09-14 by the audit route (Gate 3), replacing
the `structure-version: 1` copy of 2026-09-12; ADR-0008. The master is the tiebreaker: a format
change anywhere requires bumping `structure-version` **there** first. Nothing above this rule is
edited; this section is the only fork-authored text in the file.

Three path deviations, decided by the fork owner at foundations time. All are **location-only** —
file format, section skeleton, grammar and vocabularies are unchanged. A parser that resolves these
paths reads this repo as fully conforming.

| Master path | This repo | Why |
|---|---|---|
| `ARCHITECTURE.md` (root) | `docs/ARCHITECTURE.md` | The fork's write surface is `docs/` + `.github/` + root `CLAUDE.md`. Upstream `nitatsuu/Dandori` owns the repo root and merges land there regularly; keeping fork-only documents inside `docs/` keeps the merge surface to one file (`CLAUDE.md`). See ADR-0001 §Merge contract. |
| `architecture-index.md` (root) | `docs/architecture-index.md` | Follows its source file. |
| `decisions/NNNN-<slug>.md` | `docs/decisions/ADR-NNNN-<slug>.md` | Same reason; the `ADR-` prefix is the fork's convention and the number stays zero-padded to 4. |

In the master location, present: `CLAUDE.md`, `project-profile.yaml`, `docs/project-structure.md`
(this file), `docs/validation-map.md`, `docs/assumptions.md`, `docs/owner-approvals.md`,
`docs/state.md`, `docs/defects.jsonl`, `specs/README.md`, `specs/001-*`, `specs/002-*`.
Gitignored and generated: `artifacts/`, `project-profile.local.yaml`, `.claude/agents/dev-*.md`.
Not used: `_handoffs/`.

`CLAUDE.md` stays at the repo root as the master requires — it is the one root file the fork
replaces, and `docs/upstream-CLAUDE.md` holds upstream's version verbatim for merge reference.

### Running tests (fork-specific, kept from the v1 copy)

One command, both tiers: `npm test` (vitest, watch mode; `npm test -- --run` for one-shot).

- `tests/stack/**` — stack project. Needs Docker. `globalSetup` starts the local `supabase` CLI
  stack via `npx supabase start` if it's down, then applies `supabase/schema.sql` plus
  `migration-002`…`-006` in order via `pg`. Runs serially, pinned to a single forked worker — one
  shared Postgres instance, no racing schema apply or account provisioning.
- `tests/local/**` — local project. Docker-free, parallel, no `globalSetup`. `npx vitest run
  tests/local/` passes in seconds with Docker stopped.

No `.env.local`, no secret required: well-known local dev keys are committed in
`vitest.config.ts` (ADR-0002 corollary — these aren't credentials, only the fixed values
`supabase start` prints for the local stack).

Single-file runs: `npx vitest run tests/stack/<file>` / `npx vitest run tests/local/<file>`.

Rule: tests never modify `src/` or `supabase/` (spec 001 FR-002).
