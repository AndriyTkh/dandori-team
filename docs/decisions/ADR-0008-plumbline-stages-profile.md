# ADR-0008 — The repo adopts structure-version 5: a staged profile with rigor and autonomy as owner rulings

- **Status:** Accepted (owner, 2026-09-14 — "rushed till wednesday and then standard; high autonomy;
  solo; run fixes, implement correct new filestructure, permission granted")
- **Date:** 2026-09-14
- **Decider:** Andrii Tkhorenko (AndriyTkh) — fork owner, solo operator
- **Depends on:** ADR-0001 (fork contract, solo operator), ADR-0002 (phase gates — the fork's
  P0–P3 stay authoritative)
- **Amends:** the process layer only. No product decision, no schema, no sync rule changes.
  `docs/ARCHITECTURE.md` gains §7; §0–§6 are untouched, so no map entry goes `STALE`.

## Context

The repo was bootstrapped on 2026-09-12 against the plumbline suite's `structure-version: 1`:
architecture document with skeleton §0–§6, validation map, ADRs, the structure contract copied
into `docs/`. The installed suite is now `plumbline@0.9` — `structure-version: 5`,
`profile-version: 5` — and the repo satisfied none of the artifacts that version reads:
`project-profile.yaml`, the decision ledger (`docs/assumptions.md`), the owner-gate table
(`docs/owner-approvals.md`), `specs/README.md`, the metrics ledger's gitignore, and `§7 Stages`.
The suite's SessionStart hook therefore printed nothing, its Stop hook stamped events with a
fallback version, and every `dev-*` skill would have had to invent a rigor per entry — exactly the
failure the profile contract names.

Until now the fork's ceremony was governed by two things: ADR-0002's hard phase gates (no phase
starts on `UNTESTED` substrate) and `CLAUDE.md`'s roles. Neither says how much evidence a promotion
owes *this week* versus after the demo, nor how often the owner wants to be interrupted. Both were
being answered per task, in chat.

## Decision

1. **The repo conforms to `structure-version: 5`.** `docs/project-structure.md` is re-copied from
   the master verbatim, keeping only the fork's `## Repo-local instantiation` tail (three path
   deviations: `docs/ARCHITECTURE.md`, `docs/architecture-index.md`, `docs/decisions/ADR-NNNN-*`).
2. **`project-profile.yaml` at the repo root is the home of the ceremony dials**, per the profile
   contract, with three stages the owner ruled on in one question:

   | id | phase | rigor | autonomy | gate | ends |
   |---|---|---|---|---|---|
   | `demo-rush` | P1 | rushed | high | sprint | 2026-09-16 |
   | `demo-harden` | P2 | standard | high | sprint | 2026-09-20 |
   | `post-demo` | P3 | standard | normal | feature | open |

   `mode: solo` throughout. Rigor and autonomy are **rulings, not observations** — they are never
   inferred from how the previous work ran, and they change only at a sprint plan.
3. **Rigor never lowers the fork's own floor.** Where `rushed` and the `data` role's rule ("an
   `UNTESTED` HIGH-tier component gets its test before it changes") disagree, the fork rule wins.
   `rushed` thins NORMAL/LOW evidence and shortens receipts; it does not skip a HIGH test. Recorded
   as §B U-003 and owner gate 3 so the owner can overrule it explicitly rather than by omission.
4. **`escalate_always` carries the fork's invariants** in addition to the contract's fixed list:
   `personal-regression`, `origin-crossing`, `lww-lockstep-split`, `default-branch-write`,
   `secret-in-diff`. Raising autonomy never shortens this list.
5. **Every off-plan decision gets a §A row, unconditionally**; owner questions get a B1..B5 class
   and a row in `docs/owner-approvals.md`. Budget: 5 unreviewed rows in the `high` stages, 2 in
   `post-demo`, checked at exec-block start.
6. **`post-demo` is `standard`, not `regulated`.** The profile contract forbids `regulated` with
   `mode: solo` because regulated HIGH requires independent sign-off. The owner's stated wish for a
   "more regulated" phase is **open gate 4**: add a second human, or accept `(single-operator)`
   sign-offs permanently. It is not silently rounded down here.
7. **Phase labels.** plumbline's `P1/P2/P3` (scaffold / feature / harden) are used in the profile
   and stamped on ledger events; they coincide with the fork's ADR-0002 phases and ADR-0002's gates
   remain the authority. If they ever diverge, the profile follows ADR-0002, and this ADR is
   superseded.
8. **Generated output is gitignored:** `artifacts/`, `project-profile.local.yaml`,
   `.claude/agents/dev-main.md`, `.claude/agents/dev-worker.md`. Nothing gates on the ledger.

## Consequences

- `CLAUDE.md` read order gains the profile as step 2 (instructions → profile → map → index →
  ranges), as the structure contract requires.
- `docs/architecture-index.md` is regenerated in the same change set (new §7 range; §6 grew by
  four ADR rows).
- No map entry changes status: §0–§6 are byte-identical apart from the §6 decisions table, which
  is a pointer list, not an architectural claim. The `paths` of every entry are untouched.
- The upstream teammate remains outside the project's `mode`: a merge source, no sign-off. If a
  `supabase/*.sql` policy-body conflict ever wants a second reviewer, that is gate 4 reopening
  (§B U-005).
- The suite's hooks were found to have three defects while this landed (ledger path collapsed to a
  root-level file, a UTF-8 BOM on JSONL, stage lookup by `name` where the contract says `id`);
  fixed at the plugin source as `plumbline@0.9.1`. Outside this repo; noted so the ledger's first
  rows are readable.

## Alternatives rejected

- **Stay on structure-version 1 and keep answering ceremony in chat.** Rejected: the suite reads
  the profile, not the chat; without it every skill defaults to `low` autonomy and invents rigor.
- **One stage, `rushed`, until the demo, then decide.** Rejected: `demo-harden`'s user testing is
  the demo's point and needs `standard` evidence planned in from Monday, not discovered on Thursday.
- **`regulated` for `post-demo`.** Illegal in `mode: solo` (profile contract, parse rules).
