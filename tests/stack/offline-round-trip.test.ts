// US1 — offline edit survives the round trip (spec.md US1, acceptance 1-4).
//
// One story, one file, in acceptance order: edit while offline (1), the edit
// reaches the server unchanged except the server's own stamp and the local
// dirty mark clears (2), a second client starting from an empty local cache
// pulls the same content once and not again (3), and the edit survives a
// local-cache restart with no network round trip (4).
//
// "Offline" is `navigator.onLine = false` (`ARCHITECTURE.md §4 L336-338`):
// `push()`/`runPull()` both check it first and no-op into `offline` state
// without touching `_dirty` (`src/sync/sync.ts:180-183, 334-337`), so the
// 400ms auto-push every `db-api` write schedules (`src/db/api.ts:36-38`)
// cannot smuggle the edit out while the device is meant to have no
// connectivity.
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { updateTask, type TaskPatch } from '../../src/db/api'
import { db, wipeLocal } from '../../src/db/local'
import { SYNCED_COLUMNS, type ID } from '../../src/db/types'
import { createTestUser, deleteTestUser, type TestUser } from '../harness/accounts'
import { seedWorkspaceWithTask } from '../harness/seed'
import { DB_URL, assertStackReachable } from '../harness/stack'
import { driveSyncCycle } from '../harness/sync'

// The full push+pull cycle is driven by the harness's `driveSyncCycle`
// (`tests/harness/sync.ts`), which waits for both push's and pull's settle
// and first drains the debounced push queue so no stray `push()` can be
// counted as the pull (002 receipts, "sync-engine flake receipt (T003)").
// The private two-settle driver this file used to carry is gone with it.

const TASK_COLUMNS = Object.keys(SYNCED_COLUMNS.tasks)

const EDIT: TaskPatch = {
  title: 'edited offline',
  description: 'written with no connectivity',
  done: true,
  muted: true,
  label_ids: ['9f7f7f2e-0000-4000-8000-000000000001'],
  custom_fields: [{ name: 'priority', value: 'high' }],
}

let testUser: TestUser
let pg: Client
let taskId: ID

beforeAll(async () => {
  await assertStackReachable()
  testUser = await createTestUser('us1-offline-round-trip')
  pg = new Client({ connectionString: DB_URL })
  await pg.connect()
}, 60_000)

afterAll(async () => {
  await pg?.end()
  if (testUser) await deleteTestUser(testUser)
})

// tests/setup.ts also clears the local cache after every test in this
// process; this repeats it explicitly so each acceptance states its own
// starting condition rather than borrowing one from global teardown.
afterEach(async () => {
  await wipeLocal()
  // Every acceptance below flips `navigator.onLine` to simulate connectivity
  // changing; leaving it `false` would make the next test's own "regains
  // connectivity" cycle start from a lie, and `push()`/`runPull()` short-circuit
  // straight to `offline` without ever passing through `syncing`
  // (`src/sync/sync.ts:180-183, 334-337`) — a state `driveSyncCycle` never
  // treats as a settled cycle (`tests/harness/sync.ts:60-69`), so a stale
  // `false` here hangs the next test until its timeout instead of failing fast.
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
})

/** Row as `tasks` actually stores it, projected to the same whitelist the wire contract uses. */
async function serverTaskRow(id: ID): Promise<Record<string, unknown> & { synced_at: Date | null }> {
  const { rows } = await pg.query(
    `select ${TASK_COLUMNS.join(', ')}, synced_at from tasks where id = $1`,
    [id],
  )
  return rows[0]
}

/** `Date` columns (`created_at`/`updated_at`) come back from `pg` as `Date`; local rows hold ISO strings. */
function normalize(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Date ? value.toISOString() : value
  }
  return out
}

/** Counts writes Dexie actually applies to one task row, to tell "arrived on the wire again" apart from "changed anything locally". */
function watchTaskWrites(id: ID) {
  let count = 0
  const onCreating = (primKey: unknown) => {
    if (primKey === id) count += 1
  }
  const onUpdating = (_mods: unknown, primKey: unknown) => {
    if (primKey === id) count += 1
  }
  db.tasks.hook('creating', onCreating)
  db.tasks.hook('updating', onUpdating)
  return {
    writes: () => count,
    stop: () => {
      db.tasks.hook('creating').unsubscribe(onCreating)
      db.tasks.hook('updating').unsubscribe(onUpdating)
    },
  }
}

it(
  'acceptance 1: an edit made with no connectivity is held locally, marked unsent, and never reaches the server',
  async () => {
    const seeded = await seedWorkspaceWithTask(testUser, { workspaceName: 'us1 workspace' })
    taskId = seeded.taskId
    // Establish the "existing task" baseline on the server before going
    // offline — `seedWorkspaceWithTask` only writes through `db-api` locally
    // (tests/harness/seed.ts), it does not itself sync.
    await driveSyncCycle()

    const original = await serverTaskRow(taskId)
    expect(original).toBeTruthy()

    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    try {
      await updateTask(taskId, EDIT)
    } finally {
      // Nothing queued while offline should be allowed to leak out later in
      // this test from a stray timer; the debounced auto-push already saw
      // `onLine === false` and no-op'd (src/sync/sync.ts:180-183).
    }

    const local = await db.tasks.get(taskId)
    expect(local?._dirty).toBe(1)
    expect(local?.title).toBe(EDIT.title)
    expect(local?.description).toBe(EDIT.description)
    expect(local?.done).toBe(EDIT.done)
    expect(local?.muted).toBe(EDIT.muted)
    expect(local?.label_ids).toEqual(EDIT.label_ids)
    expect(local?.custom_fields).toEqual(EDIT.custom_fields)

    // Still offline: the server has not seen the edit.
    const untouched = await serverTaskRow(taskId)
    expect(untouched.title).toBe(original.title)
    expect(untouched.updated_at).toEqual(original.updated_at)
  },
  20_000,
)

it(
  'acceptance 2: a sync cycle after connectivity returns pushes the edit — server matches except synced_at, local dirty clears',
  async () => {
    // Re-seed: the previous acceptance's row was wiped by afterEach, and this
    // acceptance is stated as its own "given" (an edited-but-unsent task).
    const seeded = await seedWorkspaceWithTask(testUser, { workspaceName: 'us1 workspace 2' })
    taskId = seeded.taskId
    await driveSyncCycle()

    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    await updateTask(taskId, EDIT)
    const localBeforeSync = await db.tasks.get(taskId)
    expect(localBeforeSync?._dirty).toBe(1)

    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
    await driveSyncCycle()

    const server = await serverTaskRow(taskId)
    expect(server).toBeTruthy()
    // Every wire column matches what the device holds, project-for-project —
    // the whitelist itself (`SYNCED_COLUMNS.tasks`) is the comparison, so a
    // column silently dropped from the wire contract fails this the same way
    // a column silently added to it would (ARCHITECTURE §4 L323-330).
    const expected: Record<string, unknown> = {}
    for (const column of TASK_COLUMNS) {
      expected[column] = (localBeforeSync as unknown as Record<string, unknown>)[column]
    }
    // The one column that is never sent and is never expected to match: the
    // server's own stamp, assigned by the `<t>_synced_at` trigger. Checked
    // separately, then dropped before the rest is compared column-for-column.
    expect(server.synced_at).toBeTruthy()
    const { synced_at: _serverSyncedAt, ...serverWithoutStamp } = server
    expect(normalize(serverWithoutStamp)).toEqual(normalize(expected))

    const localAfterSync = await db.tasks.get(taskId)
    expect(localAfterSync?._dirty).toBe(0)
    expect(localAfterSync?.title).toBe(EDIT.title)
  },
  20_000,
)

it(
  'acceptance 3: a second client from an empty local cache pulls the identical row once, and does not re-apply it on a second cycle',
  async () => {
    const seeded = await seedWorkspaceWithTask(testUser, { workspaceName: 'us1 workspace 3' })
    taskId = seeded.taskId
    await driveSyncCycle()
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    await updateTask(taskId, EDIT)
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
    await driveSyncCycle()
    const server = await serverTaskRow(taskId)

    // "Second client, empty local cache": same signed-in account (the app
    // singleton session is untouched), local cache and cursors wiped — same
    // shape `claimCache` gives a device that has never seen this account
    // (plan.md D-6; ARCHITECTURE §3 L280-296).
    await wipeLocal()
    expect(await db.tasks.get(taskId)).toBeUndefined()

    await driveSyncCycle()

    const pulled = await db.tasks.get(taskId)
    expect(pulled).toBeTruthy()
    expect(pulled?.title).toBe(server.title)
    expect(pulled?.description).toBe(server.description)
    expect(pulled?.done).toBe(server.done)
    expect(pulled?.muted).toBe(server.muted)
    expect(pulled?.label_ids).toEqual(server.label_ids)
    expect(pulled?.custom_fields).toEqual(server.custom_fields)
    expect(pulled?._dirty).toBe(0)

    // "Does not receive it repeatedly": `CURSOR_SLACK_MS` (5s) holds the
    // cursor behind the newest row taken, so a row can legally come back over
    // the wire again this soon after the first pull (`ARCHITECTURE.md §4
    // L340-343`) — asserting "no row on the wire" would be asserting
    // something the contract does not promise. What the contract does
    // promise is `mergeRows`' clean/value-identical skip
    // (`src/sync/sync.ts:453`): a local row that is `_dirty: 0` and matches
    // the incoming row column-for-column is never written again. So this
    // asserts no *applied* change — no Dexie `creating`/`updating` write
    // lands for this row's id — which is the thing acceptance 3 actually
    // claims ("does not receive it repeatedly", not "is never sent again").
    const watch = watchTaskWrites(taskId)
    try {
      await driveSyncCycle()
    } finally {
      watch.stop()
    }
    expect(watch.writes()).toBe(0)

    const stillPulled = await db.tasks.get(taskId)
    expect(stillPulled?.title).toBe(server.title)
  },
  20_000,
)

it(
  'acceptance 4: the edited row survives a local-cache restart, read back with no network round trip',
  async () => {
    const seeded = await seedWorkspaceWithTask(testUser, { workspaceName: 'us1 workspace 4' })
    taskId = seeded.taskId
    await driveSyncCycle()
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    await updateTask(taskId, EDIT)
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
    await driveSyncCycle()

    // "Restart, cache preserved": close and reopen the same Dexie database —
    // fake-indexeddb keeps its backing store across a close/open pair, the
    // same as a real IndexedDB surviving a page reload — without driving any
    // sync cycle or touching the network in between.
    db.close()
    await db.open()

    const reopened = await db.tasks.get(taskId)
    expect(reopened).toBeTruthy()
    expect(reopened?.title).toBe(EDIT.title)
    expect(reopened?.description).toBe(EDIT.description)
    expect(reopened?.done).toBe(EDIT.done)
    expect(reopened?.muted).toBe(EDIT.muted)
    expect(reopened?.label_ids).toEqual(EDIT.label_ids)
    expect(reopened?.custom_fields).toEqual(EDIT.custom_fields)
    expect(reopened?._dirty).toBe(0)
  },
  20_000,
)
