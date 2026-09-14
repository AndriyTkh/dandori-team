# Owner approvals — numbered gates

Appended to, never rewritten. `status` is `OPEN`, `APPROVED <date>` or `REJECTED <date>`. A ruling
recorded anywhere else (chat, commit message, code comment) does not count until it has a row here.
Blocker `class` is one of B1..B5 (project-compass `references/blocker-taxonomy.md`). Owner:
Andrii Tkhorenko (AndriyTkh), fork owner, `mode: solo` — no backup; open gates queue until the
owner's next check-in.

| gate | what is being decided | default in use | class | status |
|---|---|---|---|---|
| 1 | Profile stage values (audit Gate 3b): stage `demo-rush`, rigor `rushed`, autonomy `high`, mode `solo`, gate `sprint`, ends 2026-09-16; then `demo-harden`, rigor `standard`, autonomy `high`, ends 2026-09-20 | as ruled | B1 | APPROVED 2026-09-14 (owner in chat: "rushed till wednesday and then standard; high autonomy; solo") |
| 2 | Demo deadline day: Friday 2026-09-18 or Sunday 2026-09-20 (§B U-001) | 2026-09-20 | B1 | OPEN |
| 3 | Where `rushed` rigor and the fork's "test-first on UNTESTED HIGH" rule disagree, the fork rule wins (§B U-003) | fork rule wins | B4 | OPEN |
| 4 | Post-demo stage: stay `standard` + `solo`, or add a second human so `regulated` becomes legal (§B U-004, U-005) | `standard` / `normal` / `solo` | B4 | OPEN |
