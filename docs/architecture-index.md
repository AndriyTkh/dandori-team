# architecture-index — docs/ARCHITECTURE.md

Section → line ranges. **Read the cited range, never the whole file.**
Regenerate this index in the same commit as any edit to `docs/ARCHITECTURE.md` — a stale index is
a contract violation, not a nit (`docs/project-structure.md`, "Other parse rules").

Source: `docs/ARCHITECTURE.md` — 648 lines, regenerated 2026-09-14 after ADR-0008 (§7 Stages,
structure-version 5), against repo SHA `c34172e`.

```
## §0 Outcome — the idea sentence and the first demo: L14–L47
## §1 Users & scenarios: L48–L93
## §2 Components — tiers, responsibilities, dependencies: L94–L206
## §3 Data — entities, ownership, storage: L207–L322
## §4 Interfaces & contracts: L323–L476
## §5 Environment: L477–L544
## §6 Risks & decisions: L545–L617
## §7 Stages: L618–L648
```

Preamble (how to read the file, what the citations mean): L1–L13.

## Sub-anchors inside §2 and §3

```
§2 Today (component table + tiers):                 L104–L119
§2 Fork target — new components:                    L120–L138
§2 Layering — today:                                L139–L159
§2 Layering — fork target (federation + agents):    L160–L206
§3 Entities (today):                                L209–L227
§3 The three timestamps:                            L228–L244
§3 Ownership (today) — single-owner:                L245–L264
§3 Local storage:                                   L265–L281
§3 Ownership (fork target):                         L282–L298
§3 Federation and storage (ADR-0004):               L299–L322
```

## Sub-anchors inside §4 — the file's largest section

§4 is 154 lines and rarely wanted whole. Narrower ranges:

```
The wire contract — SYNCED_COLUMNS:                 L325–L332
The sync loop:                                      L333–L358
The LWW contract (HIGH, two enforcement points):    L359–L380
Triggers — what the predicate swap must not break:  L381–L395
Session guard — sign-out ordering:                  L396–L408
The db-api surface:                                 L409–L426
Google Calendar — deletion read-back, worker token: L427–L456
App shell:                                          L457–L476
```

## Where else to look

| Want | Read |
|---|---|
| Current status of any component | `docs/validation-map.md` (ids match §2 one-for-one) |
| Why a fork choice was made | `docs/decisions/ADR-000N-*.md` |
| Upstream's own contract | `docs/upstream-CLAUDE.md` (verbatim, not fork policy) |
| Repo layout + map grammar | `docs/project-structure.md` |
| Current stage, rigor, autonomy, deadlines | `project-profile.yaml` (§7 mirrors it) |
| Open owner gates / decision ledger | `docs/owner-approvals.md`, `docs/assumptions.md` |
