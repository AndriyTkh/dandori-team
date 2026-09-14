# Assumptions — decision log and known unknowns

Ledger named by `project-profile.yaml` → `autonomy.decision_log` and `autonomy.assumptions`.
Format pinned by `docs/project-structure.md` (§ `docs/assumptions.md` — section format): two
GitHub-flavoured markdown tables, columns in this exact order, em dash for an empty cell.

§A gets a row for **every** decision an agent takes off-plan, at every autonomy level, whether or
not the owner was consulted; `reviewed` is `no` (counts against `decision_debt_max`), `yes <date>`
or `reverted <date>`. §B holds the questions nobody could answer, with the default in use and what
it costs if wrong. A defaulted **owner** answer lives in §B, never in §A.

## §A Decision log

| id | date | stage | task | decision | why | reversible | reviewed |
|---|---|---|---|---|---|---|---|

## §B Known unknowns

| id | question | default in use since | costs if wrong | owner gate |
|---|---|---|---|---|
| U-001 | "End of this week" for the demo deadline — Friday 2026-09-18 or Sunday 2026-09-20? | 2026-09-20 (2026-09-14) | Two days of user-testing time planned that do not exist; `demo-harden` underwater without anyone noticing until Friday. | Gate 2 |
| U-002 | The fork's own P0–P3 (ADR-0002: spine → team transform → scenarios → agent layer) versus plumbline's P0–P3 (Foundations → Scaffold → Feature → Harden): is `demo-rush` really plumbline **P1** while spec 002 is fork P1? | Mapped 1:1, `demo-rush: P1`, `demo-harden: P2`, `post-demo: P3` (2026-09-14) | Ledger `phase` field mis-stamped; planning-leak numbers grouped under the wrong phase. Nothing gates on it. | — (recorded in ADR-0008) |
| U-003 | `rushed` rigor in `demo-rush` against the fork's own rule that an `UNTESTED` HIGH-tier component gets its test before it changes (CLAUDE.md, `data` role) — which wins where they disagree? | The fork rule wins: HIGH floor in `table[tier][rigor]` is never below "test exists and runs"; `rushed` only thins NORMAL/LOW evidence (2026-09-14) | If `rushed` is read as permission to skip HIGH-tier tests, spec 002's RLS swap lands on unproven substrate — the exact failure ADR-0002 exists to prevent. | Gate 3 |
| U-004 | Owner wants post-demo to be "more regulated"; `rigor: regulated` is invalid with `mode: solo`. Add a second human, or accept `standard` permanently? | `post-demo: standard / normal`, dates null (2026-09-14) | Post-demo HIGH-tier promotions carry `(single-operator)` sign-offs forever — a real receipt, never independent review. | Gate 4 |
| U-005 | Does the upstream teammate's one-way flow (their commits fetched into this fork) ever need them as a `team:2` member here — e.g. reviewing RLS policy bodies after a `supabase/*.sql` conflict? | `mode: solo`; upstream is a merge source only (2026-09-14) | Conflict resolution in policy bodies stays single-operator, on the fork's HIGH-tier surface. | Gate 4 |
