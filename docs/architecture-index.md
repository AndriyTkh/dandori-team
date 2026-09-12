# architecture-index — docs/ARCHITECTURE.md

Section → line ranges. **Read the cited range, never the whole file.**
Regenerate this index in the same commit as any edit to `docs/ARCHITECTURE.md` — a stale index is
a contract violation, not a nit (`docs/project-structure.md`, "Other parse rules").

Source: `docs/ARCHITECTURE.md` — 593 lines, regenerated 2026-09-12 after the owner-review
amendments (ADR-0004 federation, two-level membership, agent-edit layer), against repo SHA
`88e74aa`.

```
## §0 Outcome — the idea sentence and the first demo: L13–L46
## §1 Users & scenarios: L47–L92
## §2 Components — tiers, responsibilities, dependencies: L93–L204
## §3 Data — entities, ownership, storage: L205–L320
## §4 Interfaces & contracts: L321–L460
## §5 Environment: L461–L525
## §6 Risks & decisions: L526–L593
```

Preamble (how to read the file, what the citations mean): L1–L12.

## Sub-anchors inside §2 and §3

```
§2 Today (component table + tiers):                 L103–L118
§2 Fork target — new components:                    L119–L137
§2 Layering — today:                                L138–L157
§2 Layering — fork target (federation + agents):    L158–L204
§3 Entities (today):                                L207–L225
§3 The three timestamps:                            L226–L242
§3 Ownership (today) — single-owner:                L243–L262
§3 Local storage:                                   L263–L279
§3 Ownership (fork target):                         L280–L296
§3 Federation and storage (ADR-0004):               L297–L320
```

## Sub-anchors inside §4 — the file's largest section

§4 is 140 lines and rarely wanted whole. Narrower ranges:

```
The wire contract — SYNCED_COLUMNS:                 L323–L330
The sync loop:                                      L331–L356
The LWW contract (HIGH, two enforcement points):    L357–L378
Triggers — what the predicate swap must not break:  L379–L393
Session guard — sign-out ordering:                  L394–L406
The db-api surface:                                 L407–L424
Google Calendar — one-way, browser-direct:          L425–L440
App shell:                                          L441–L460
```

## Where else to look

| Want | Read |
|---|---|
| Current status of any component | `docs/validation-map.md` (ids match §2 one-for-one) |
| Why a fork choice was made | `docs/decisions/ADR-000N-*.md` |
| Upstream's own contract | `docs/upstream-CLAUDE.md` (verbatim, not fork policy) |
| Repo layout + map grammar | `docs/project-structure.md` |
