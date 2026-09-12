# Project Structure Contract — Dandori fork

`structure-version: 1`

Instantiated from the master copy in the `project-compass` skill
(`references/project-structure.md`) by `establishing-project-foundations`, 2026-09-12.
The master is the tiebreaker: a format change anywhere requires bumping `structure-version`
**there** first — otherwise this repo is non-conforming, not the contract wrong. Parsers fail
soft: report non-conforming, never crash.

This repo-local copy carries the master text plus a **§ Repo-local instantiation** section at the
end recording the two paths where this repo deviates, and why. Nothing else is edited.

## Layout

```
repo/
  CLAUDE.md                      # agent read order; fixed section names
  ARCHITECTURE.md                # fixed skeleton §0–§6 (foundations skill)
  architecture-index.md          # section → line ranges; regenerated same commit as any ARCHITECTURE.md edit
  docs/
    project-structure.md         # this contract, copied at foundations/audit time
    validation-map.md            # component + scenario entries (or docs/map/ shard dir, one file per component group)
  decisions/
    NNNN-<slug>.md               # ADR; NNNN zero-padded; one decision per file; immutable — supersede by new number
  specs/
    README.md                    # feature map table: | NNN | name | phase | tracker |
    NNN-<feature>/
      spec.md                    # spec-kit native, unmodified format
      plan.md                    # spec-kit native + "## Validation substrate" section
      tasks.md                   # spec-kit native + extensions below
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
  expected: <output + one failure example>
  last-verified: <SHA> <YYYY-MM-DD> | —
  sign-off: <as above>
```

Closed vocabularies (nothing else exists):
- Map status: `UNTESTED | BROKEN | VALIDATED | STALE | DEAD`
- Receipt status: `PASS | FAIL | BLOCKED | NOT RUN | ACCEPTED RISK`
- Tiers: `HIGH | NORMAL | LOW`
- `(single-operator)` sign-off flag: solo-project promotion; parsers render it as reduced assurance, never as independent review.

## tasks.md grammar (spec-kit + extensions)

- Checkboxes: `- [ ]` open, `- [x]` done.
- Claim marker: `[in-progress: <lane-or-agent>]` appended to a task line at dispatch; removed on completion or abandonment. Never two claims on one task.
- Subtask marker: `[sub-of: <task-id>]` — a mid-flight discovery task, inserted under its parent, same taskgroup.
- Per-task fields (indented lines under the checkbox): `Write:` (files it may touch), `Read:` (its complete required context), `substrate:` (map entry ids it builds on).
- Taskgroup headers: `## TG-N` — a hard sequencing gate; TG-N+1 never starts before TG-N is fully merged and checked.
- Feature-level `## Workfile & conflict map` table: `| Task | Lane | Files |` — lane is `wt/<name>` or `serial`.

## plan.md extension

`## Validation substrate` — table of map entries the feature builds on + their status at planning
time. Debt rows (UNTESTED/STALE/BROKEN) become the feature's first tasks.

## Other parse rules

- §N citation format: `ARCHITECTURE.md §N` — resolve via architecture-index.md lines `## §N <title>: Lstart–Lend`; never full-file scan.
- specs/README.md `tracker` column values: `spec-kit` | `beads` | other. Anything but `spec-kit` marks the feature out of contract scope (legacy tracker).
- CLAUDE.md must state the read order: instructions → architecture-index → cited §N ranges → validation map.
- A repo missing `docs/validation-map.md` or `ARCHITECTURE.md` is non-conforming regardless of everything else present.

---

## Repo-local instantiation

Two path deviations, decided by the fork owner at foundations time. Both are **location-only** —
file format, section skeleton, grammar and vocabularies are unchanged. A parser that resolves
these two paths reads this repo as fully conforming.

| Master path | This repo | Why |
|---|---|---|
| `ARCHITECTURE.md` (root) | `docs/ARCHITECTURE.md` | The fork's write surface is `docs/` + `.github/` + root `CLAUDE.md`. Upstream `nitatsuu/Dandori` owns the repo root and merges land there regularly; keeping fork-only documents inside `docs/` keeps the merge surface to one file (`CLAUDE.md`). See ADR-0001 §Merge contract. |
| `architecture-index.md` (root) | `docs/architecture-index.md` | Follows its source file. |
| `decisions/NNNN-<slug>.md` | `docs/decisions/ADR-NNNN-<slug>.md` | Same reason; the `ADR-` prefix is the fork's convention and the number stays zero-padded to 4. |

Unchanged and in the master location: `docs/project-structure.md` (this file),
`docs/validation-map.md`, `specs/` (not yet created — a later `dev-plan` route creates it),
`_handoffs/` (optional, not yet used).

`CLAUDE.md` stays at the repo root as the master requires — it is the one root file the fork
replaces, and `docs/upstream-CLAUDE.md` holds upstream's version verbatim for merge reference.
