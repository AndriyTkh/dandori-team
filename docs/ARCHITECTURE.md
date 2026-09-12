# Dandori (fork) — Architecture

Reconstructed from the code and the read-only audit of upstream `nitatsuu/Dandori` @ `88e74aa`
(`docs/validation-map.md`). Every claim about **current** behaviour carries a `file:line`.
Claims about the **fork target** carry no citation on purpose — they describe what does not exist
yet, and each is anchored to an ADR instead.

Fixed skeleton §0–§6 per the structure contract (`docs/project-structure.md`). Cite ranges as
`ARCHITECTURE.md §N`, resolved through `docs/architecture-index.md`. Never read this file whole.

---

## §0 Outcome — the idea sentence and the first demo

**Idea sentence.** A small team self-hosts a planner where each person keeps their own private
workspaces on infrastructure they own, and shares a team workspace hosted by whoever created it.

**First demo (end of P1).** Two accounts on one deployment. Account A creates a team workspace
and adds B as a member; B signs in on a second device, sees the workspace and its tasks, edits a
task offline, comes back online, and A sees the edit. A's *personal* workspaces never appear on
B's screen, and A's personal experience is byte-for-byte what upstream ships today.

**The differentiator is the agent-edit layer, and it is a first-class product surface — not an
afterthought bolted on at the end.** Coding agents already live in a repository and already read
and write files there. So the fork meets them where they are: **agents interact with the planner
through local task files.** The database remains the source of truth; a per-project set of task
files is a **working copy** of it, kept in step by a `dandori` CLI in both directions — pull the
project's tasks down into files, edit them in the repo (by hand or by an agent), push the changes
back. Agents therefore get **read and edit access to tasks and nodes** the same way they get
access to source: as files, with no bespoke protocol to learn. MCP arrives later and stays
**thin** — a convenience surface over the same CLI-shaped operations, never a second, divergent
way in. Speckit `tasks.md` ingestion and a teamlead view with stuck-detection sit on top of that
layer. Board features, by contrast, stay deliberately boring — upstream's minimalism survives as
"no feature outside `specs/`" (ADR-0001 §6).

**Where the data lives is a decision, not a default.** Each person hosts at most one Supabase
origin; a shared workspace lives wholly on its host's origin; **data never crosses origins**
(ADR-0004). The app composes several independent backends client-side. Your private workspaces
cannot be taken away by someone else deleting their project.

**What is explicitly preserved.** Upstream's product — a single-user offline-first planner PWA —
remains a shipping mode of this fork, not a substrate that gets consumed. `kind: personal`
workspaces must not regress (ADR-0001 §6).

---

## §1 Users & scenarios

Two user shapes. The first exists today; the second is what the fork adds.

- **Solo planner (today).** One account, several devices, all workspaces private. Signs in with
  email + password — there is no sign-up in the app, accounts are made by hand in the Supabase
  dashboard (`src/components/SignIn.tsx:8`, `src/auth/useSession.ts:98`).
- **Team member (fork).** Same app, plus workspaces they did not create and do not own. Membership
  is two-level: `owner` (invites, removes, deletes the workspace) or `member` (everything else).
  A member holds an account **on the host's origin** — there is no global account (ADR-0004).
- **Origin holder (fork).** Anyone who runs their own Supabase project. Zero or one per person;
  their private workspaces live there, sovereign. Not a separate persona in the UI — it is the
  same person, plus a backend they control.
- **Agent (P3).** A coding agent working in a project repository, reading and editing the
  project's tasks as **local files** kept in step with the database by the `dandori` CLI. A
  first-class consumer of the data, not a scripting hack on top of the UI.
- **Teamlead (P3).** A team member with a dashboard over the team's task state, including
  stuck-detection. Not v1.

The scenarios below are the map's scenario entries (`docs/validation-map.md`). Six exist today and
are all `UNTESTED`; the fork adds the last three, which do not exist yet.

| Scenario | Chain | Phase |
|---|---|---|
| `s-offline-edit-sync` | local-cache → db-api → sync-engine → supabase-schema | exists; **P0 first test** |
| `s-conflict-lww` | sync-engine → supabase-schema | exists; P0 |
| `s-workspace-delete-cascade` | supabase-schema → sync-engine | exists; P0 |
| `s-auth-session-recovery` | supabase-auth → local-cache | exists; P0 |
| `s-account-switch-wipe` | local-cache → supabase-auth | exists; P0, reworked in P1 |
| `s-gcal-round-trip` | gcal-integration → db-api | exists; P2 |
| `s-team-member-sees-shared` *(new)* | membership → supabase-schema → sync-engine | P1 |
| `s-personal-stays-private` *(new)* | membership → supabase-schema | P1 — the regression guard |
| `s-two-accounts-one-device` *(new)* | local-cache → supabase-auth | P1 |
| `s-origin-isolation` *(new)* | origin-registry → multi-account-cache → sync-engine | P2/P3, owner-scheduled |

`s-personal-stays-private` is the mechanical form of ADR-0001 §6: if it ever fails, the fork has
broken the product it forked. `s-origin-isolation` is the same thing for ADR-0004's invariant: no
row, cursor or session from one origin may ever be observable through another.

**How the two-account scenarios are tested** (decided, ADR-0002): two supabase-js clients in one
vitest process, signed in as different users of the `supabase` CLI local stack, observing each
other at the API layer. RLS is the thing under test and the API layer is where it lives, so no
browser is needed and Playwright is not pulled forward.

---

## §2 Components — tiers, responsibilities, dependencies

Ids in **Today** match `docs/validation-map.md` one-for-one. The **Fork target** ids do not exist
in the map yet — each becomes a map entry (`UNTESTED`, with the tier below) in the phase that
creates it. **Criticality tiers are assigned here** and are the
owner's; tier definitions live in the `tracking-validated-components` skill.

The tier rule used: HIGH = a silent failure loses or leaks data. NORMAL = a visible failure
annoys. LOW = a failure is cosmetic.

### Today

| id | kind | tier | responsibility | depends-on |
|---|---|---|---|---|
| `env-boot` | env | **HIGH** | Toolchain: install, typecheck, lint, build | — |
| `local-cache` | store | **HIGH** | Dexie/IndexedDB `dandori` DB; dirty flags; cache ownership claim and wipe | — |
| `db-api` | lib | **HIGH** | The only write path the UI may use; read-modify-write in a Dexie transaction, then enqueue a push | `local-cache` |
| `sync-engine` | adapter | **HIGH** | Push/pull loop, per-table cursors, LWW merge, session guard, sync status | `local-cache`, `supabase-auth`, `supabase-schema` |
| `supabase-schema` | adapter | **HIGH** | Postgres tables, RLS policies, triggers, migrations | — |
| `supabase-auth` | adapter | **HIGH** | Supabase client, session bootstrap and offline fast path, sign-in/out ordering | — |
| `gcal-integration` | adapter | NORMAL | One-way reconciliation of tasks into Google Calendar | `db-api`, `sync-engine` |
| `views-core` | ui | NORMAL | Board, Timeline, Notes | `db-api` |
| `task-dialog` | ui | NORMAL | The task card as a modal | `db-api` |
| `chrome-components` | ui | LOW | Header, tab bar, sign-in, settings, sync badge, filters, banner | `supabase-auth`, `sync-engine` |
| `i18n-state` | lib | LOW | Two-language dictionary, persisted UI state, date arithmetic | — |

### Fork target — new components

| id | kind | tier | responsibility | depends-on | phase |
|---|---|---|---|---|---|
| `membership` | store | **HIGH** | Workspace `kind`, the members table with its two levels (`owner`/`member`), and the per-task `assignee` column; the one source of "who may see this workspace" | `supabase-schema` | P1 |
| `team-rls` | adapter | **HIGH** | The replaced policy predicates on all four tables, both halves | `membership`, `supabase-schema` | P1 |
| `multi-account-cache` | store | **HIGH** | `claimCache`/`wipeLocal` reworked so one device can hold more than one account's reach; keyed so ADR-0004's `(origin, account)` is a widening, not a rewrite | `local-cache` | P1 |
| `runtime-origin-config` | lib | **HIGH** | Supabase URL + anon key read at runtime instead of inlined at build time; one artifact, any origin | `supabase-auth` | may land independently, before the registry |
| `origin-registry` | store | **HIGH** | The local profile's list of origins — zero or one hosted, unlimited joined — and per-origin client/session/cache/cursor instances | `runtime-origin-config`, `multi-account-cache`, `supabase-auth` | P2/P3, owner-scheduled |
| `agent-sync-cli` | job | NORMAL | `dandori` CLI: two-way sync between an origin's tasks and a per-project set of local task files | `db-api`, `sync-engine`, `origin-registry` | P3 |
| `speckit-ingest` | job | NORMAL | `tasks.md` ingestion | `agent-sync-cli` | P3 |
| `teamlead-dashboard` | ui | NORMAL | Stuck-detection view over team task state | `membership`, `db-api` | P3 |
| `mcp-v2` | adapter | NORMAL | Thin MCP surface over the same operations the CLI exposes — never a second way in | `agent-sync-cli` | P3 |

The three P1 entries are HIGH for the same reason: each of them, wrong, shows one account's rows
to another account. That is this system's worst possible failure and its least visible one.
`runtime-origin-config` and `origin-registry` are HIGH for the sibling reason: wrong, they point a
client at the wrong backend or leak one origin's cache into another's view.

### Layering — today

```
views / components ──► db-api ──► local-cache (Dexie)
                                      ▲
                                      │
                          sync-engine ─┴─► Supabase (Postgres + RLS)
gcal-integration ──► Google Calendar API (browser-direct, no server)
```

Two rules hold the layering up, both upstream's:

- The UI never touches Supabase; it goes through `db-api` (`src/db/api.ts:20-21`) and reads through
  `useLiveQuery` wrappers (`src/db/hooks.ts:16-18`).
- `db-api` never touches the network. It writes Dexie and calls `requestPush()`; the sync engine
  is the only thing that talks to Postgres.

The fork does not change this shape. `membership` is a table the sync engine carries like any
other; `team-rls` is invisible from the client.

### Layering — fork target

Two additions, and neither disturbs the stack above.

**Federation is a client-side composition** (ADR-0004). What is one column in the diagram becomes
*n* independent columns, one per origin, that never touch each other:

```
                 ┌── origin A (yours, hosted) ──── Supabase A
app profile ─────┼── origin B (joined) ─────────── Supabase B
  registry       └── origin C (joined) ─────────── Supabase C
```

Each column has its own Supabase client, its own auth session, its own Dexie cache, its own queue
and its own per-table cursors. **No arrow crosses between columns** — no foreign key, no query,
no identity, no sync. A shared workspace lives wholly inside one column. The UI merges the
workspace *lists* for display; nothing below the UI merges anything.

**The agent-edit layer is a second client of the same data**, sitting beside the app rather than
inside it:

```
database (one origin) ──► dandori CLI ──► per-project task files ──► agent / human edits
        ▲                                                                    │
        └────────────────────── dandori CLI (push) ◄─────────────────────────┘
                                      ▲
                                 MCP (thin, later)
```

The rules that make this safe to build later, stated now so P3 does not invent them under
pressure:

- **The database is the source of truth. Files are a working copy.** A file is never authoritative
  and never the only copy of anything.
- **The CLI is the only sync path**, and MCP is a thin surface over the *same* operations — not a
  parallel implementation with its own semantics.
- **Task files belong to one project on one origin.** The invariant applies here too: a project's
  files never mix tasks from two origins.
- **Agent edits are ordinary edits.** They land through the same `updated_at` LWW contract as a
  phone edit (§4), with no privileged path and no conflict exemption.

Nothing about this layer requires schema support beyond what P1 already adds. It is deferred to
P3 because it is worth building on validated substrate, not because it is peripheral — it is the
differentiator.

---

## §3 Data — entities, ownership, storage

### Entities (today)

Four synced tables, mirrored between Postgres and Dexie: `workspaces`, `labels`, `notes`, `tasks`
— pushed and pulled in that order because a task FKs a note (`src/db/types.ts:155-159`).

- `workspaces` — `supabase/schema.sql:16-28`: `id`, `user_id`, `name`, `position`, `gcal_sync`,
  `gcal jsonb`, housekeeping.
- `labels` — `schema.sql:30-40`: `+ workspace_id`, `name`, `color`, `position`.
- `tasks` — `schema.sql:42-77`: `+ title`, `description`, `start_date`/`due_date` (`date`, never
  `timestamp`), `done`, `remind_days_before`, `muted`, `note_id` (FK, `on delete set null`,
  wired out-of-line at `schema.sql:95-102`), `position`, `label_ids jsonb`, `custom_fields jsonb`,
  `gcal jsonb`, `gcal_placed text`.
- `notes` — `schema.sql:79-91`: `+ parent_id` (self-FK), `kind` with `check (kind in
  ('folder','file'))`, `name`, `content`, `position`.

Labels are denormalized into `tasks.label_ids` — no join table, justified upstream by there being
one user (`schema.sql:60`). **The fork keeps this.** Membership is about workspaces, not tasks; a
label join table would be a schema change buying nothing.

### The three timestamps

This is the single most important thing to understand before touching sync.

| column | authored by | means |
|---|---|---|
| `created_at` | device | when the row was made |
| `updated_at` | **device** | settles conflicts — the LWW clock (`src/db/api.ts:32-34`) |
| `synced_at` | **server** | what a device pulls by (`supabase/schema.sql:106-113`) |

Pull orders on `synced_at`, never `updated_at`, and the reason is load-bearing
(`src/sync/sync.ts:342-349`): an edit made offline keeps the time it was made, so a device paging
by `updated_at` would never ask for anything that old again.

Deletion is soft everywhere: `deleted boolean`. A hard delete on the phone would never reach a
laptop that was offline (`src/db/types.ts:26-32`).

### Ownership (today) — single-owner, enforced twice

- Every row carries one `user_id`, `not null references auth.users(id) on delete cascade`
  (`schema.sql:18, 32, 44, 81`).
- Exactly one RLS policy per table, all named `own_rows`, all `for all`
  (`schema.sql:238-254`, re-issued `supabase/migration-006-lww-and-ownership.sql:125-137`).
- **Reads** are `auth.uid() = user_id` alone (`schema.sql:241, 248`).
- **Writes** on `labels`/`tasks`/`notes` additionally require the target workspace to be yours
  (`schema.sql:249-253`) — because a foreign key checks that a workspace exists, never whose it
  is (rationale `schema.sql:222-228`).

This read/write asymmetry is intentional and must be preserved through the fork's predicate swap
(ADR-0001 §2). A membership predicate that flattens reads and writes into one expression is a
divergence, not a simplification.

`user_id` **is not a field of any TypeScript type.** It is attached at push time from the current
session (`src/sync/sync.ts:216`) and stripped on pull (`src/sync/sync.ts:418`). Locally, the only
record of whose data this is lives in the Dexie `meta` table under the key `owner`
(`src/db/local.ts:108-110`).

### Local storage

- **Dexie DB `dandori`**, one per browser, no per-account suffix (`src/db/local.ts:28`). v1 stores
  `src/db/local.ts:33-37`: `workspaces: 'id, position, _dirty'`, the other three
  `'id, workspace_id, _dirty'`, plus `meta: 'key'`. Only three query shapes exist — by workspace,
  dirty-scan, by id — so sorting is done in memory (`src/db/local.ts:29-31`). v2 is a data-only
  backfill of the calendar columns (`src/db/local.ts:47-62`).
- `_dirty: 0|1` is local-only, stripped before anything leaves the device
  (`src/db/local.ts:11-13, 78-81`).
- `meta` carries the pull cursors (`synced_at:<table>`), the cache owner, and the per-task Google
  Calendar signatures (`gcal:<taskId>`, `src/gcal/sync.ts:26-27`).
- **`localStorage`** holds UI state only, deliberately unsynced: `dandori.workspace|tab|theme|
  boardMode|timelineZoom|lang` (`src/state/ui.ts:4-16`), plus `dandori.gcalConnected`
  (`src/gcal/client.ts:64-81`) and Supabase's own `sb-*-auth-token`.
- **The Google access token is never persisted** — module variable only
  (`src/gcal/client.ts:53, 59-63`).

### Ownership (fork target)

`workspaces` gains `kind: 'personal' | 'team'`, defaulting to `personal`. A new members table maps
`(workspace_id, user_id)` to a **two-level** membership — `owner` (invite, remove, delete the
workspace) or `member` (everything else). `tasks` gains a nullable **`assignee`** pointing at a
user of the same origin: a label expressing "this task is set to a certain person", with **no
authorization meaning at v1** — RLS never reads it. Every `own_rows` predicate — **both halves,
replaced separately** — becomes *owner, or member of a team workspace*. `user_id` keeps meaning
"who created the row"; it is never repurposed as an access key. Tables and columns are only ever
added (ADR-0001 §2).

The single-account local cache is the other half. `claimCache` today stores one owner id and wipes
everything on mismatch (`src/db/local.ts:102-112`) — including `meta`, which destroys the cursors
and forces the next pull to restart from epoch (`src/db/local.ts:115-125`). Team mode does not by
itself change how many accounts a device uses at once; it changes what one account can reach, and
P1 must confirm the wipe still triggers on the case it was built for and on nothing else.

### Federation and storage (ADR-0004)

**Every identifier in this section is scoped to one origin.** A `user_id` is an id in *that*
origin's `auth.users` and means nothing anywhere else; a `workspace_id`, a `note_id`, an
`assignee` likewise. There are no cross-origin foreign keys and no global account, so there is
nothing in the schema that federation has to add — and, correspondingly, nothing in P1's
migration that may anticipate it.

What federation does change is the **client**, once the registry lands: a device signed into three
origins holds three Supabase clients, three auth sessions, three Dexie caches and three sets of
per-table cursors, none of which may observe each other. Today every one of these is a singleton
— the client (`src/auth/supabase.ts:12-17`), the session (`src/auth/useSession.ts:28-41`), the
database name `dandori` (`src/db/local.ts:28`), the cursors and sync status
(`src/sync/sync.ts:21-22, 43-48`). The eventual cache key is **`(origin, account)`**; P1
implements the `account` half of it, which is why the P1 rework should be written as a widening
rather than something to be redone.

The honest limitation, recorded rather than hidden: **private notes alongside a team workspace you
do not host require your own origin.** There is no personal corner inside someone else's project.
That follows directly from the invariant and is not a gap to be closed by a later sync-back
feature.

---

## §4 Interfaces & contracts

### The wire contract — `SYNCED_COLUMNS`

`src/db/types.ts:187-214` is a per-table column whitelist, typed `satisfies` so a missing or extra
column is a **compile error** (`src/db/types.ts:214`). `forServer` projects a row down to exactly
those columns before it is sent (`src/sync/sync.ts:147-153`). The comment at
`src/db/types.ts:176-186` records why: a stray field from another build poisoned an entire batch,
permanently. Any fork column that must sync is added here, or it silently does not exist on the wire.

### The sync loop

One cycle is **push, then pull**, in that order (`src/sync/sync.ts:476-481`); pull walks tables in
`SYNCED_TABLES` order (`src/sync/sync.ts:354-356`).

- **Triggers**: a 400 ms debounced `requestPush()` from every `db-api` write
  (`src/sync/sync.ts:168-174`, `src/db/api.ts:36-38`), a 60 s interval, the `online` event, and
  `visibilitychange` (`src/sync/sync.ts:485-496`). Started and stopped from one effect in the app
  shell (`src/App.tsx:175-184`).
- **Cursors**: one per table in Dexie `meta` as `synced_at:<table>`, default epoch
  (`src/sync/sync.ts:21-22`), held back by `CURSOR_SLACK_MS = 5_000` and only ever advanced
  (`src/sync/sync.ts:30, 404-405`). Per-table so a busy table cannot drag a quiet one's cursor past
  rows still in flight (`src/sync/sync.ts:350-352`).
- **Paging** is keyset on `(synced_at, id)`, 500 rows a page (`src/sync/sync.ts:378-401`), not
  offset — PostgREST silently caps at 1000 (`src/sync/sync.ts:33-38`).
- **Push** upserts `on_conflict: id` and clears `_dirty` only if the whole re-serialized row still
  matches what was sent (`src/sync/sync.ts:240-249`) — a stamp-only check would falsely clear a row
  whose calendar placement was written without re-stamping `updated_at`.
- **Errors**: push catches per table and continues to the next, setting a sticky `pushFailed`
  (`src/sync/sync.ts:274-280`); a stuck table must not stick the queue
  (`src/sync/sync.ts:203-209`).
- **Status** is a module-global `'idle' | 'syncing' | 'offline' | 'error'` with a listener set
  (`src/sync/sync.ts:43-78`); `settle()` is the only writer of a resting state
  (`src/sync/sync.ts:65-68`), and the badge renders nothing when idle
  (`src/components/SyncBadge.tsx:17`).

### The LWW contract — HIGH, and enforced in two places

**This is the fork's most dangerous surface.** Last-writer-wins on `updated_at`, whole-row, with
the server as judge (`src/sync/sync.ts:12-17`).

- **Server:** `keep_newer()` — `if new.updated_at < old.updated_at then return null`
  (`supabase/schema.sql:142-153`, origin `supabase/migration-006-lww-and-ownership.sql:37-48`).
  Equal stamps are accepted on purpose: a device rewriting only `gcal_placed` does not bump
  `updated_at`. Returning null also means `synced_at` is not moved.
- **Client:** `mergeRows` (`src/sync/sync.ts:409-458`) applies three skip gates before writing —
  local strictly newer wins (`:432`); same instant and still unsent keeps local unless this is the
  refused-row path (`:435-437`); a clean, value-identical local row is skipped so live queries do
  not wake (`:453`). Comparators: `isNewer`/`isSameMoment` parse rather than string-compare,
  because local writes `…Z` and PostgREST returns `…+00:00` (`src/sync/sync.ts:100-110`);
  `canonical` sorts object keys so `jsonb` reordering is not a change (`src/sync/sync.ts:118-128`);
  `sameRow` compares only whitelisted columns, `_at` columns by instant
  (`src/sync/sync.ts:131-141`).

**Lockstep invariant (ADR-0001 §3):** these are one rule with two enforcement points. Neither may
change without the other in the same change set. P0 pins the current joint behaviour before P1
goes near it.

### Triggers — the other contract the predicate swap must not break

Names are chosen so alphabetical firing order is meaningful (`supabase/schema.sql:196-198`). On a
child row update: `keep_newer` → `stay_deleted` → `synced_at`, all `BEFORE`.

| trigger | timing | tables | does |
|---|---|---|---|
| `<t>_keep_newer` | BEFORE UPDATE | all four | drops a stale update whole (`schema.sql:199-205`) |
| `<t>_stay_deleted` | BEFORE INSERT/UPDATE | labels, tasks, notes | forces `deleted` on a row arriving into an already-deleted workspace (`schema.sql:177-190, 207-213`) |
| `<t>_synced_at` | BEFORE INSERT/UPDATE | all four | stamps the server clock (`schema.sql:106-113, 122-126`) |
| `workspaces_cascade_delete` | **AFTER** UPDATE | workspaces | soft-deletes the workspace's children with `updated_at = greatest(updated_at, now())` so the delete outranks an edit in flight (`schema.sql:158-175, 216-218`) |

A replaced policy predicate that makes a trigger unreachable — or reachable on rows it never saw
before — is a regression, not a side effect (ADR-0001 §2).

### Session guard — sign-out ordering

A monotonic counter (`src/sync/sync.ts:88-98`) is captured as `const mine = session` before every
network call and re-checked at each await boundary (`src/sync/sync.ts:195-198, 228, 265, 366,
390-396`), so an in-flight reply can never write rows or a cursor into a just-wiped database
(`src/sync/sync.ts:80-87`).

Sign-out is a four-step order, and each guard's comment names the concrete bug it fixed:
`holdGcal()` → `flushQueue()` (with an owner prompt if rows remain unsent)
(`src/components/Settings.tsx:212-246`), then `forgetSession()` → `supabase.auth.signOut()` →
`wipeLocal()` (`src/auth/useSession.ts:112-118`). **Treat this ordering as a contract.** P1's
multi-account rework changes the last step; it must not reorder the first three.

### The db-api surface

`src/db/api.ts` is the UI's only write path. Every mutator is a Dexie `rw` transaction doing
read-modify-write, then `queue()` (`src/db/api.ts:69-74` records the bug that forced this: two
concurrent field saves clobbering each other). Ids are client-generated uuid v4
(`src/db/api.ts:29`). Positions are gap-allocated in steps of 1000 (`src/db/api.ts:42`).
Nothing hard-deletes.

Grouped: workspaces (`listWorkspaces`, `createWorkspace`, `renameWorkspace`, `deleteWorkspace`
— cascades soft-delete to children, `setWorkspaceGcal`); labels (`listLabels`, `createLabel`,
`updateLabel`, `deleteLabel` — strips the id from every task's `label_ids`); tasks (`listTasks`,
`createTask`, `updateTask`, `toggleTaskDone`, `setTaskGcal`, `deleteTask`, `moveTask`); notes
(`listNotes`, `createNote`, `updateNote`, `deleteNote` — soft-deletes the subtree and nulls
`task.note_id`); export (`exportAll`).

Fork note: this is where a workspace `kind` becomes visible to the UI, and where team-only
operations will live. It is also the narrowest place to enforce "personal behaves as before".

### Google Calendar — one-way, browser-direct, no server

There is no server component anywhere in this project (`src/gcal/client.ts:1-13`); the browser
calls `googleapis.com/calendar/v3` directly (`src/gcal/api.ts:14`) using a Google Identity
Services token client loaded on demand (`src/gcal/client.ts:15, 131-157`).

Design is reconciliation-on-tick, not write-hooks (`src/gcal/sync.ts:1-14`): every 60 s
(`src/gcal/sync.ts:22, 274`) a pass walks all tasks and sends the difference between what each task
*wants* and a stored signature of what was last sent (`src/gcal/sync.ts:64-78`, stored in Dexie
`meta` under `gcal:<taskId>`, per-device, unsynced). The event id is the task uuid with dashes
stripped (`src/gcal/api.ts:97-99`), so no event id is ever stored and two devices converge on one
event. Quota refusals back off 5 minutes (`src/gcal/sync.ts:23, 244`). `placed()` writes
`_dirty: 1` **without touching `updated_at`** so bookkeeping cannot win a conflict
(`src/gcal/sync.ts:106-115`) — this is exactly the case `keep_newer()`'s equal-stamp acceptance
exists for.

### App shell

There is **no router** (`src/App.tsx:35, 125-139`): the view is a persisted string from
`TABS = ['board','timeline','notes']` (`src/state/ui.ts:53`), drawn in the header and, on a phone,
a bottom bar. State is plain `useState` in one `Shell` component plus localStorage helpers
(`src/App.tsx:33-49`). Auth gates it: loading renders nothing, signed-out renders `SignIn`
(`src/App.tsx:24-25`).

Session bootstrap races `getSession()` against `AUTH_TIMEOUT_MS = 1500`
(`src/auth/useSession.ts:20, 66`); on timeout it reads the persisted session straight out of
`localStorage` (`src/auth/useSession.ts:28-41`) so an offline launch still paints. Signed-in is
gated on `claimCache(userId)` (`src/auth/useSession.ts:43-53`).

i18n is two languages, `ru` default, chosen manually from `localStorage` with no
`navigator.language` detection (`src/state/ui.ts:97, 107-137`); the dictionary holds both columns
per key (`src/i18n/dict.ts`), plurals go through `Intl.PluralRules`, never `n > 1`
(`src/i18n/index.ts:29-49`).

---

## §5 Environment

### Boot

```
cp .env.example .env.local      # fill VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm install
npm run dev
```

Requirements: Node 22+, a Supabase project, a Cloudflare account for deploy (`README.md:8-10`).
Schema is applied **by hand**: Supabase dashboard → SQL Editor → paste `supabase/schema.sql` → Run
(`supabase/README.md:4`).

Three env vars, all `VITE_`-prefixed and therefore **inlined at build time**, so changing one
requires a redeploy (`README.md:42-69`): `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (both
required — the client throws without them, `src/auth/supabase.ts:6-10`), and
`VITE_GOOGLE_CLIENT_ID` (optional; absent means Google Calendar reports `unconfigured`). There is
no client secret anywhere and no `service_role` key in the repo (`.env.example:9-10`,
`supabase/README.md:12-13`) — the anon key plus the four `own_rows` policies is the entire
authorization story.

**Fork target: origin config becomes runtime, not build-time** (ADR-0004, consequence (a)). Today
the artifact is welded to one Supabase project, so every self-hoster must build their own bundle
and every credential rotation is a redeploy. The origin registry cannot work that way at all — one
artifact must address several origins chosen by the user. Worth doing on self-hosting grounds
alone, which is why it may land before the registry does.

### Second-operator check

A second operator, on a clean machine, should be able to: clone → `npm ci` → `npx tsc -b
--noEmit` → `npm run lint` → `npm run build`, all green, **without any credential**. That is
exactly what `.github/workflows/ci.yml` runs today.

From P0 there is a fifth check, `npm run test`, which needs **Docker and the `supabase` CLI local
stack** (ADR-0002) — real Postgres, real RLS, real triggers, well-known development keys, still
**no credential in the repo and no hosted project touched**. CI runs the stack as a service so the
CI check and the local one are the same check. The four Docker-free steps stay Docker-free, so a
contributor without Docker still gets most of the way.

### Build and deploy

`npm run build` is `tsc -b && vite build`. Vite config: React plugin + `VitePWA` with
`registerType: 'autoUpdate'` but `injectRegister: null`, because registration is hand-rolled in
`src/main.tsx:23-31` with an hourly update check. Workbox precaches js/css/html/svg/png/woff2 and
falls back navigations to `/index.html` (`vite.config.ts:31-42`).

Hosting is Cloudflare Workers **static assets with no worker script** — `assets.directory:
"./dist"`, `not_found_handling: "single-page-application"` (`wrangler.jsonc:1-12`). Deploy is
dashboard-connected GitHub: build `npm run build`, deploy `npx wrangler deploy`, the three `VITE_`
vars set as **build** env vars (`README.md:42-69`).

The fork keeps self-hosted deploy on Cloudflare Workers + hosted Supabase (ADR-0001). Nothing in
the P1 transform needs a server; it is schema plus predicates plus client logic.

### CI

`.github/workflows/ci.yml` automates the audit's four checks: `npm ci`, `npx tsc -b --noEmit`,
`npm run lint` (oxlint), `npm run build`. The `test` step is committed **commented out**, next to
the commented-out `supabase` local-stack service it will need — both are uncommented together by
P0's first vitest suite (ADR-0002, ADR-0003). Before that, a green CI means "compiles and builds",
nothing more.

---

## §6 Risks & decisions

### Decisions

| ADR | Decision |
|---|---|
| `docs/decisions/ADR-0001-fork-contract.md` | Workspace `kind`; additive tables / replaced policies; LWW lockstep; migration convention (hand-run idempotent SQL from migration-007, no down-migrations = accepted risk); upstream merge discipline; "personal must not regress" replacing upstream's "What must not exist"; solo operator |
| `docs/decisions/ADR-0002-phase-gates.md` | P0 validation spine → P1 team transform → P2 scenarios/e2e → P3 agent layer; no phase starts on `UNTESTED` substrate |
| `docs/decisions/ADR-0003-test-framework.md` | Vitest from P0 against the `supabase` CLI local stack; Playwright deferred to P2, cost-of-later assessed as equal |
| `docs/decisions/ADR-0004-multi-origin-federation.md` | Each person hosts 0–1 Supabase origin; a shared workspace lives wholly on its host's origin; **data never crosses origins**; origin config becomes runtime; registry is an owner-scheduled P2/P3 item |

Changing this file's architecture requires a **new ADR plus a `STALE` cascade on the affected map
entries, in the same PR** — and regenerating `docs/architecture-index.md`.

### Risks

1. **Everything below `env-boot` is `UNTESTED`.** Not "probably fine": the audit's truth table is
   explicit that a clean build, a clean `tsc` and a clean oxlint establish nothing about sync, RLS
   or Google Calendar behaviour. This is the risk ADR-0002 exists to retire.
2. **The LWW pair could already disagree** and nothing would notice. P0's conflict test is as much
   a discovery as a regression net; if it fails, the lockstep invariant is describing a bug
   (ADR-0001, *Reconsider when*).
3. **The account-switch wipe is the highest-consequence code in the repo.** Wrong, it draws one
   account's rows on another account's screen. P1 rewrites it. Test it before, not after.
4. **No down-migrations** — accepted risk, owner-recorded (ADR-0001 §4). A bad migration is undone
   by hand, forward, against a live database.
5. **Upstream merge friction on `supabase/*.sql`** is permanent by construction. Bounded to policy
   bodies by the additive-tables rule; never zero.
6. **Three high npm-audit advisories, untriaged** (transitive, reported during the audit's
   `npm install`). Queued deliberately, not fixed: triaging them was out of the audit's read-only
   scope and they gate nothing in P0.
7. **Read/write RLS asymmetry is load-bearing and easy to lose.** Reads are looser than writes on
   purpose (`supabase/schema.sql:222-228`). A membership predicate written once and pasted into
   both halves would quietly change the security model.
8. **`VITE_`-inlined config** means a credential rotation is a redeploy, and a leaked build carries
   the anon key. That is upstream's posture and RLS is what makes it safe — which is another
   reason the predicate swap is HIGH. ADR-0004 retires the inlining; until it does, the risk
   stands.
9. **The federation invariant is easy to erode by request, not by bug.** "Just let this one
   workspace be visible from both origins" is the shape it will arrive in. Under ADR-0004 that is
   not an exception, it is the deletion of the model — it needs a replacing ADR, not a flag.
10. **P1 anticipating federation would be a real defect.** Federation needs zero schema support, so
    an "origin" column or table appearing in the P1 migration is wrong rather than early. Named
    here because "build it in now while we're in the file" is the natural instinct.
11. **The agent-edit layer's files are a working copy, not a second truth.** If a later
    implementation lets a file be authoritative — or lets MCP diverge from the CLI's semantics —
    the system acquires a second source of truth quietly. §2 states the rules; nothing yet
    enforces them.

### Open questions

Resolved in owner review, 2026-09-12 — kept visible because the reasoning matters:

- ~~What stands in for Supabase in P0 tests?~~ **The `supabase` CLI local stack** (ADR-0002): real
  Postgres, RLS and triggers, zero credentials in the repo, run as a CI service.
- ~~Flat membership or roles in v1?~~ **Two levels, `owner` and `member`** (ADR-0001 §1). Plus a
  per-task `assignee` pointer with no authorization meaning.
- ~~Does the two-account regression guard force Playwright forward?~~ **No** — two supabase-js
  clients in one vitest process, observing each other at the API layer (ADR-0002, ADR-0003).

Still open, carried to the owner:

- **When does the origin registry land?** ADR-0004 places it at the P2/P3 boundary and marks it
  owner-scheduled. Runtime origin config may go earlier on its own merit; the registry's timing is
  a product call, not a technical one.
- **Does `assignee` need to survive a member's removal from a workspace?** A nullable pointer to a
  user who is no longer a member is either a dangling label or an automatic un-assign. Cheap to
  decide now, awkward to change once rows exist.
