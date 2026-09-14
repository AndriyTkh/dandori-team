# architecture-index — docs/ARCHITECTURE.md

Section → line ranges. **Read the cited range, never the whole file.**
Regenerate this index in the same commit as any edit to `docs/ARCHITECTURE.md` — a stale index is
a contract violation, not a nit (`docs/project-structure.md`, "Other parse rules").

Source: `docs/ARCHITECTURE.md` — 611 lines, regenerated 2026-09-14 after ADR-0007 (upstream gcal
worker route), against repo SHA `db23c6d`.

```
## §0 Outcome — the idea sentence and the first demo: L13–L46
## §1 Users & scenarios: L47–L92
## §2 Components — tiers, responsibilities, dependencies: L93–L205
## §3 Data — entities, ownership, storage: L206–L321
## §4 Interfaces & contracts: L322–L475
## §5 Environment: L476–L543
## §6 Risks & decisions: L544–L611
```

Preamble (how to read the file, what the citations mean): L1–L12.

## Sub-anchors inside §2 and §3

```
§2 Today (component table + tiers):                 L103–L118
§2 Fork target — new components:                    L119–L137
§2 Layering — today:                                L138–L158
§2 Layering — fork target (federation + agents):    L159–L205
§3 Entities (today):                                L208–L226
§3 The three timestamps:                            L227–L243
§3 Ownership (today) — single-owner:                L244–L263
§3 Local storage:                                   L264–L280
§3 Ownership (fork target):                         L281–L297
§3 Federation and storage (ADR-0004):               L298–L321
```

## Sub-anchors inside §4 — the file's largest section

§4 is 154 lines and rarely wanted whole. Narrower ranges:

```
The wire contract — SYNCED_COLUMNS:                 L324–L331
The sync loop:                                      L332–L357
The LWW contract (HIGH, two enforcement points):    L358–L379
Triggers — what the predicate swap must not break:  L380–L394
Session guard — sign-out ordering:                  L395–L407
The db-api surface:                                 L408–L425
Google Calendar — deletion read-back, worker token: L426–L455
App shell:                                          L456–L475
```

## Where else to look

| Want | Read |
|---|---|
| Current status of any component | `docs/validation-map.md` (ids match §2 one-for-one) |
| Why a fork choice was made | `docs/decisions/ADR-000N-*.md` |
| Upstream's own contract | `docs/upstream-CLAUDE.md` (verbatim, not fork policy) |
| Repo layout + map grammar | `docs/project-structure.md` |
