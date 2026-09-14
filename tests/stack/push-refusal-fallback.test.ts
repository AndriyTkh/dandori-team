// D-18 (FR-041, US6 acceptance 6, SC-017) — a refused row must not wedge the
// push queue.
//
// What this proves. Today's push loop (`src/sync/sync.ts:203-278`) sends each
// table's dirty rows as one `upsert` batch (`:223-227`) and, on `error`,
// simply `throw`s (`:227`) into the per-table `catch` at `:274-277`, which
// logs and moves on to the *next table* — it never inspects which row inside
// the batch was the problem. When PostgREST refuses the batch with `42501`
// (an RLS `with check` failure), the whole batch is rejected: nothing in it
// is marked `_dirty: 0` (`:240-249` never runs — it sits after the `throw`),
// so on the next cycle the exact same batch — refused row and all the
// innocent rows queued behind it in the same table — is sent again, forever.
// That is the defect this file pins.
//
// This file's red phase is that DEFECT, not an unfinished schema. The
// refusal is produced with nothing but upstream's own `own_rows` policy
// (`supabase/schema.sql:238-254`, pinned already by
// `tests/stack/rls-two-accounts.test.ts` acceptance 2): a row in a table with
// a workspace-ownership `with check` (labels/tasks/notes), pointed at a
// workspace a *different* account owns, is refused on INSERT with `42501` —
// no `members` table, no `workspaces.kind`, no fork schema of any kind is
// needed to reach that error. This is deliberately the fresh-INSERT shape
// (a row id never before written to the server), because `upsert` only
// evaluates `WITH CHECK` on that path; a row that instead hit the UPDATE half
// of an existing id would be filtered out by `USING` first and PostgREST
// would report 0 rows changed with `error === null` — no exception at all,
// and not the code path D-18 describes. See `T035`'s card and the domain
// notes above `refusedTaskId` below for exactly why the fixture is shaped
// this way.
//
// Turns green on: T036 (`src/sync/sync.ts`'s push loop gains the per-row
// retry D-18 specifies). Until then, this file is expected to fail on the
// assertions marked "central claim" below.
//
// `mergeRows` (`src/sync/sync.ts:409-458`) was read in full while writing
// this file and is confirmed untouched by what T036 does: D-18's own text
// says the retry is inserted "inside the existing per-table `try`, around
// the batch upsert only" (points 1-5), and the refused-id reconciliation path
// that already calls `mergeRows` at `:257-272` is explicitly listed as
// untouched ("The refused-id path at 240-272 is untouched"). Nothing in this
// file calls or stubs `mergeRows` directly — the pull side of the lockstep
// (`ARCHITECTURE.md §4`, CLAUDE.md "LWW lockstep") is exercised exactly as
// `driveSyncCycle` always exercises it, unmodified, as the reconciliation
// step after the drop.
//
// Why the host-clock stamps below are safe (`keep_newer` is not a
// confounder). Every row this file pushes carries a fresh `randomUUID()` id
// (`refusedTaskId`, `innocentTaskId`, `innocentLabelId`, and the control
// case's `taskId`/`labelId`), so all three writes take the INSERT path, never
// UPDATE. `keep_newer()` (`supabase/schema.sql:142-153`) is attached `before
// update` only — see the trigger loop at `supabase/schema.sql:199-205`,
// specifically `before update` at `:202` — never `before insert or update`;
// contrast `touch_synced_at`, attached `before insert or update` at
// `supabase/schema.sql:124`. So `keep_newer` never evaluates for anything
// this file writes, which is what makes `new Date().toISOString()`
// (`:194`, `:306`) safe here without the fixed `T_NEWER`/`T_STALE` constants
// `tests/stack/lww-conflict.test.ts` uses — that file deliberately drives the
// UPDATE path and needs them; this one deliberately never does. A future
// edit that reuses an existing id here would need those same fixed stamps,
// or a `42501`-shaped red risks silently becoming a `keep_newer`-refused
// UPDATE (`error === null`, 0 rows changed) instead.
//
// What `not.toBe('error')` stands in for. D-18 point 5 asks for "`pushFailed`
// is false"; `pushFailed` is module-private (`src/sync/sync.ts:56`) and only
// reaches the outside through `settle()` (`:65-68`), never directly. The
// `getSyncState()` assertions below (`:221`, `:409`) are taken after a full
// `driveSyncCycle()`, so they are an indirect stand-in: `'error'` also covers
// a pull failure, which this file cannot yet distinguish from a push
// failure through this seam. That is the right call — no source change is
// in scope here — but it means these assertions prove "no push OR pull
// failure", not "no push failure" precisely.
//
// What this file deliberately does not cover: the exact wire shape of the
// per-row retry (one request per row vs. the initial batch request) is not
// asserted by counting network calls — that would pin an implementation
// detail T036 is free to choose (a `Promise.all` of single-row upserts is as
// valid as a sequential loop) rather than the outcome D-18 and FR-041 actually
// require. What is asserted is the observable outcome: the innocent row lands
// and the refused row stops being offered, within the bound the harness gives
// it.
//
// Read: src/sync/sync.ts:203-277 (push loop), :409-458 (mergeRows, confirmed
// untouched); plan.md D-18, D-7 correction, R-11, R-14; spec.md FR-041,
// SC-017; tests/stack/offline-round-trip.test.ts, tests/stack/lww-conflict.test.ts
// (sync-driving conventions); tests/harness/sync.ts (driveSyncCycle,
// flushQueue); tests/stack/rls-two-accounts.test.ts acceptance 2 (the same
// upstream-only refusal, pinned independently).
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { clientFor, createTestUser, deleteTestUser } from '../harness/accounts'
import { assertStackReachable } from '../harness/stack'
import { driveSyncCycle, flushQueue } from '../harness/sync'
import { supabase } from '../../src/auth/supabase'
import { db, getMeta, wipeLocal, type Local } from '../../src/db/local'
import { getSyncState } from '../../src/sync/sync'
import type { Label, Task } from '../../src/db/types'

// Tables whose pull cursor must not move backwards because of anything this
// file does to the `tasks` table's queue (D-18's own scope: "the pull loop is
// untouched").
const OTHER_TABLES = ['workspaces', 'labels', 'notes'] as const

function localTask(o: {
  id: string
  workspace_id: string
  updated_at: string
  title: string
}): Local<Task> {
  return {
    id: o.id,
    workspace_id: o.workspace_id,
    title: o.title,
    description: '',
    start_date: null,
    due_date: null,
    done: false,
    remind_days_before: null,
    muted: false,
    note_id: null,
    position: 0,
    label_ids: [],
    custom_fields: [],
    gcal: null,
    gcal_placed: null,
    created_at: o.updated_at,
    updated_at: o.updated_at,
    deleted: false,
    _dirty: 1,
  }
}

function localLabel(o: {
  id: string
  workspace_id: string
  updated_at: string
  name: string
}): Local<Label> {
  return {
    id: o.id,
    workspace_id: o.workspace_id,
    name: o.name,
    color: 'slate',
    position: 0,
    created_at: o.updated_at,
    updated_at: o.updated_at,
    deleted: false,
    _dirty: 1,
  }
}

async function readCursors(): Promise<Record<(typeof OTHER_TABLES)[number], string | null>> {
  const out = {} as Record<(typeof OTHER_TABLES)[number], string | null>
  for (const table of OTHER_TABLES) out[table] = await getMeta(`synced_at:${table}`)
  return out
}

beforeAll(async () => {
  await assertStackReachable()
}, 30_000)

afterEach(async () => {
  // Belt-and-suspenders: each `it` below also signs out and wipes in its own
  // `finally`. This catches a mid-test throw that skipped that cleanup so
  // the next stack file in the same process does not inherit a signed-in
  // singleton or a dirty cache.
  await supabase.auth.signOut()
  await wipeLocal()
})

it(
  'positive control: with no refused row anywhere in the batch, queued rows land and clear _dirty within one cycle',
  async () => {
    // Without this, "the innocent row is still dirty" below proves nothing:
    // it would be equally true if the whole push path were broken, if sync
    // never ran, or if the row were never queued at all. This is the same
    // shape as the main scenario below (an app-signed-in account pushing a
    // task and a label it owns, into a workspace it owns) with the one
    // difference that matters: nothing in this batch is refused.
    const user = await createTestUser('push-refusal-control')
    try {
      const raw = await clientFor(user)
      const workspaceId = randomUUID()
      const { error: wsErr } = await raw
        .from('workspaces')
        .insert({ id: workspaceId, user_id: user.user.id, name: 'control workspace (reachable)' })
      expect(wsErr).toBeNull()

      const { error: signInErr } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: user.password,
      })
      expect(signInErr).toBeNull()

      const stamp = new Date().toISOString()
      const taskId = randomUUID()
      const labelId = randomUUID()
      await db.tasks.put(localTask({ id: taskId, workspace_id: workspaceId, updated_at: stamp, title: 'lands fine' }))
      await db.labels.put(
        localLabel({ id: labelId, workspace_id: workspaceId, updated_at: stamp, name: 'lands fine too' }),
      )

      const remaining = await flushQueue()
      expect(remaining).toBe(0)

      const localTaskAfter = await db.tasks.get(taskId)
      const localLabelAfter = await db.labels.get(labelId)
      expect(localTaskAfter?._dirty).toBe(0)
      expect(localLabelAfter?._dirty).toBe(0)

      const { data: serverTask, error: serverTaskErr } = await raw.from('tasks').select('id').eq('id', taskId)
      const { data: serverLabel, error: serverLabelErr } = await raw
        .from('labels')
        .select('id')
        .eq('id', labelId)
      expect(serverTaskErr).toBeNull()
      expect(serverLabelErr).toBeNull()
      expect(serverTask).toHaveLength(1)
      expect(serverLabel).toHaveLength(1)

      // A normal cycle must not report a failure either.
      expect(getSyncState()).not.toBe('error')
    } finally {
      await supabase.auth.signOut()
      await deleteTestUser(user)
      await wipeLocal()
    }
  },
  30_000,
)

it(
  'red (D-18): an innocent row queued behind a refused row in the same table batch must not be wedged',
  async () => {
    const owner = await createTestUser('push-refusal-owner') // owns the unreachable workspace
    const acting = await createTestUser('push-refusal-acting') // the account whose queue is on trial
    try {
      const rawOwner = await clientFor(owner)
      const rawActing = await clientFor(acting)

      // The unreachable workspace. `acting` has no relationship to it at
      // all — no membership model exists yet to remove them from, so this
      // stands in for D-18's "a row belonging to a workspace they were just
      // removed from": from the push loop's point of view the two are
      // identical, because upstream's own `own_rows` (schema.sql:238-254)
      // is what refuses the row either way, and the fork's own D-18 text
      // calls that predicate untouched by this change.
      const unreachableWorkspaceId = randomUUID()
      const { error: unreachableWsErr } = await rawOwner
        .from('workspaces')
        .insert({ id: unreachableWorkspaceId, user_id: owner.user.id, name: 'unreachable to acting' })
      expect(unreachableWsErr).toBeNull()

      // `acting`'s own, reachable workspace, for the innocent rows.
      const ownWorkspaceId = randomUUID()
      const { error: ownWsErr } = await rawActing
        .from('workspaces')
        .insert({ id: ownWorkspaceId, user_id: acting.user.id, name: 'acting workspace (reachable)' })
      expect(ownWsErr).toBeNull()

      const { error: signInErr } = await supabase.auth.signInWithPassword({
        email: acting.email,
        password: acting.password,
      })
      expect(signInErr).toBeNull()

      // Establish the three pull cursors before anything in this test is
      // seeded dirty. `readCursors()` reads `synced_at:<table>`
      // (`src/sync/sync.ts:21`), which `pullTable` only ever sets from a page
      // it actually received (`src/sync/sync.ts:392-405`) — nothing before
      // this point in the test has driven a pull at all, so every cursor
      // would otherwise read `null` for the rest of the test and the
      // obligation-(iv) loop near the bottom would skip every table via its
      // own `null` guard without ever comparing a real timestamp. `acting`
      // already owns one server row at this point (`ownWorkspaceId`, inserted
      // above directly through `rawActing`), so this cycle's pull hands back
      // at least the `workspaces` cursor; `labels` and `notes` legitimately
      // stay `null` here, because `acting` has not written a row in either
      // table yet, and the guard exists for exactly that case.
      await driveSyncCycle()
      const cursorsBefore = await readCursors()
      // Canary against the loop silently rotting back into dead code: at
      // least one cursor actually left `null`, so the `if (before === null)
      // continue` guard in the loop near the bottom is not the path taken by
      // every table on every run.
      expect(Object.values(cursorsBefore).some((v) => v !== null)).toBe(true)

      // Out-of-band proof that the refusal mechanic D-18 assumes is real,
      // pinned to the exact SQLSTATE rather than "an error happened": a fresh
      // INSERT (never-before-written id, so PostgREST takes the INSERT path
      // and evaluates `with check`, not `using`) into a workspace `acting`
      // does not own is refused with exactly `42501`, by upstream's own
      // `own_rows` policy (`supabase/schema.sql:244-254`) — never a
      // structural code (`PGRST202`, `PGRST205`, `PGRST204`, `42P01`,
      // `42703`, `23503`, `23514`, `22P02`). This never touches the sync
      // loop, so it stays valid after T036 rewrites the push loop's own
      // error handling (see header) — unlike the `console.error` spy this
      // file used to lean on for the same fact.
      const { error: probe } = await rawActing.from('tasks').insert({
        id: randomUUID(),
        user_id: acting.user.id,
        workspace_id: unreachableWorkspaceId,
        title: 'refusal probe',
      })
      expect(probe?.code).toBe('42501')

      const stamp = new Date().toISOString()
      const refusedTaskId = randomUUID()
      const innocentTaskId = randomUUID()
      const innocentLabelId = randomUUID()

      /*
       * The refused row. A FRESH id (never written to the server before), so
       * its `upsert` takes the INSERT path and PostgREST evaluates only
       * `with check` — never `using`. That is deliberate: a row whose id
       * already existed on the server would instead go through the UPDATE
       * half of `upsert`, `using` would match nothing (this account owns
       * neither the row nor its workspace), and PostgREST would report 0
       * rows changed with `error === null` — no exception raised, and not
       * D-18's code path at all. `own_rows`'s write half for tasks
       * (schema.sql:249-253) requires `auth.uid() = user_id` (satisfied —
       * the push loop always sets `user_id` to the signed-in account,
       * `sync.ts:216`) AND the target workspace to be owned by that same
       * account (NOT satisfied — `unreachableWorkspaceId` belongs to
       * `owner`) — so the INSERT's `with check` fails and PostgREST answers
       * `42501`.
       */
      await db.tasks.put(
        localTask({
          id: refusedTaskId,
          workspace_id: unreachableWorkspaceId,
          updated_at: stamp,
          title: 'refused: points at a workspace acting cannot reach',
        }),
      )
      // The innocent row: same table ('tasks'), same push batch (both are
      // the only two dirty rows in `tasks`, well under PAGE_SIZE), acting's
      // own reachable workspace.
      await db.tasks.put(
        localTask({
          id: innocentTaskId,
          workspace_id: ownWorkspaceId,
          updated_at: stamp,
          title: 'innocent: queued behind the refused row, same table',
        }),
      )
      // A second table's innocent row. Today's per-table `catch`
      // (`sync.ts:274-277`) already isolates *other* tables from a refusal —
      // that much is not the defect and must hold both before and after
      // T036 — so this is a same-cycle canary, not part of the central claim.
      await db.labels.put(
        localLabel({
          id: innocentLabelId,
          workspace_id: ownWorkspaceId,
          updated_at: stamp,
          name: 'innocent: a different table entirely',
        }),
      )

      // Bounded at exactly three cycles: `flushQueue`'s own retry limit
      // (`src/sync/sync.ts` `flushQueue`, `attempt < 3`) — not a number this
      // file invented. Three chances is what today's loop gets before the
      // assertions below run. (The refusal itself was already pinned
      // out-of-band above, independent of this cycle.)
      const remaining = await flushQueue()

      // Not the defect, both before and after T036: a different table's
      // innocent row was never wedged by another table's refusal.
      const labelAfter = await db.labels.get(innocentLabelId)
      expect(labelAfter?._dirty).toBe(0)

      // ---- the central claim ----
      // Before T036: this is FALSE. Three full cycles pass and the innocent
      // task is STILL `_dirty === 1`, because today's push loop throws on
      // the whole `tasks` batch (`sync.ts:227`) before the landed/refused
      // bookkeeping at `:240-249` ever runs, so neither row in the batch is
      // ever marked clean, and the identical batch — refused row and all —
      // goes out again next cycle. After T036: the retried-alone innocent
      // row lands like any other, converging within a single cycle, so it
      // is `_dirty === 0` well within the three cycles this test allows.
      const innocentTaskAfter = await db.tasks.get(innocentTaskId)
      expect(innocentTaskAfter?._dirty).toBe(0)

      const { data: serverInnocentTask, error: serverInnocentErr } = await rawActing
        .from('tasks')
        .select('id')
        .eq('id', innocentTaskId)
      expect(serverInnocentErr).toBeNull()
      expect(serverInnocentTask).toHaveLength(1)

      // The queue actually drains — the refused row stops being offered
      // rather than being retried forever.
      expect(remaining).toBe(0)

      /*
       * Reconciliation. `acting` cannot reach `unreachableWorkspaceId` at
       * all — there was never a server row under `acting`'s own `user_id`
       * for `refusedTaskId` to begin with, so no pull will ever hand back a
       * correcting version of it. D-18 point 4 says exactly this case is
       * deleted from Dexie, not merely marked clean over stale content. A
       * full cycle (push, already drained above, then pull) is what would
       * carry out that reconciliation.
       */
      await driveSyncCycle()
      const refusedAfterPull = await db.tasks.get(refusedTaskId)
      expect(refusedAfterPull).toBeUndefined()

      // A refusal is an answer, not an outage (D-18 point 5): it must not
      // leave the sync banner in 'error'.
      expect(getSyncState()).not.toBe('error')

      // No other table's pull cursor moved backwards because of any of
      // this — the pull loop is untouched by D-18, and this is the cheapest
      // check that stays true.
      const cursorsAfter = await readCursors()
      for (const table of OTHER_TABLES) {
        const before = cursorsBefore[table]
        const after = cursorsAfter[table]
        if (before === null) continue
        expect(after).not.toBeNull()
        expect(Date.parse(after as string)).toBeGreaterThanOrEqual(Date.parse(before))
      }
    } finally {
      await supabase.auth.signOut()
      await deleteTestUser(owner)
      await deleteTestUser(acting)
      await wipeLocal()
    }
  },
  30_000,
)

afterAll(async () => {
  await wipeLocal()
})
