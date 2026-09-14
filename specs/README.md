# specs — feature map

One row per `specs/NNN-<feature>/`. `phase` is the fork's phase per ADR-0002; `tracker` is
`spec-kit` for every feature in this repo (anything else would mark the feature out of the
structure contract's scope — `docs/project-structure.md`, "Other parse rules").

| NNN | name | phase | tracker |
|---|---|---|---|
| 001 | validation-spine — executable evidence for upstream's four HIGH-tier surfaces | P0 | spec-kit |
| 002 | team-workspaces — the minimal team transform (`kind`, two-level membership, `assignee`) | P1 | spec-kit |

Each feature folder carries spec-kit's native `spec.md`, `plan.md` (+ `## Validation substrate`),
`tasks.md` (+ the extensions in `docs/project-structure.md`), and the fork's `receipts.md`.
