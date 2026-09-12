// US5 — a deletion stays deleted (spec.md "User Story 5", acceptances 1-4).
//
// T021 drives the real client through `src/db/api.ts` and the real sync
// engine (plan.md D-5), simulating a second client by wiping the local Dexie
// cache and re-pulling from scratch — the app has only one local database
// per process, so "another device" is "the same account, no local state".
//
// T022 goes one layer down: `stay_deleted_with_workspace` and
// `follow_workspace_delete` are server triggers (ARCHITECTURE.md §4
// L379-393; supabase/schema.sql:158-190, 207-218), reachable from any
// authenticated write — including one that never goes through the app at
// all, which is exactly what an offline device's queued push looks like on
// the wire (`src/sync/sync.ts:223-227`). A signed-in supabase-js client
// exercises them directly, respecting RLS the same way the app's own push
// does, without adding anything under src/ or supabase/.
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { clientFor, createTestUser } from '../harness/accounts'
import { seedWorkspaceWithTask } from '../harness/seed'
import { assertStackReachable } from '../harness/stack'
import { supabase } from '../../src/auth/supabase'
import { db } from '../../src/db/local'
import { deleteTask } from '../../src/db/api'
import { onSyncState, startSync, type SyncState } from '../../src/sync/sync'

beforeAll(async () => {
  await assertStackReachable()
}, 60_000)

afterEach(async () => {
  await supabase.auth.signOut()
})

/**
 * `tests/harness/sync.ts`'s `driveSyncCycle` resolves on the FIRST settle
 * after `startSync()` — but `push()` (`src/sync/sync.ts`) calls its own
 * `settle()` at its own end, before `cycle()`'s `await pull()` even starts:
 * a push-only settle for an already-clean queue looks, from the outside,
 * identical to a full push+pull cycle. A harness fix is tracked separately
 * (coordinator note, 2026-09-12; found by TG-3/US1). "A second client pulls
 * a deletion it never pushed itself" needs the pull half to have actually
 * run, so this waits for the SECOND settle-after-syncing instead of the
 * first — the same workaround TG-3 used locally in its own test file.
 */
async function drivePushAndPullCycle(timeoutMs = 10_000): Promise<void> {
  const handle = startSync()
  try {
    await new Promise<void>((resolve, reject) => {
      let settles = 0
      let leftInitial = false
      const timer = setTimeout(() => {
        unsubscribe()
        reject(new Error(`drivePushAndPullCycle: timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const unsubscribe = onSyncState((state: SyncState) => {
        if (state === 'syncing') {
          leftInitial = true
          return
        }
        if (!leftInitial) return
        leftInitial = false
        settles += 1
        if (settles >= 2) {
          clearTimeout(timer)
          unsubscribe()
          resolve()
        }
      })
    })
  } finally {
    handle.stop()
  }
}

describe('US5 — soft-delete propagation (T021: acceptances 1, 4)', () => {
  it('acceptance 1: a row deleted on one client arrives deleted at a second client', async () => {
    const testUser = await createTestUser('soft-delete-a1')
    const { taskId } = await seedWorkspaceWithTask(testUser)
    await drivePushAndPullCycle() // pushes the seeded create

    await deleteTask(taskId)
    await drivePushAndPullCycle() // pushes the delete

    // "A second client": no local state at all for this row — wipe the cache
    // and the cursor, then pull from scratch, exactly as a device that was
    // never told about the delete any other way would.
    await db.tasks.clear()
    await db.meta.clear()
    await drivePushAndPullCycle()

    const arrived = await db.tasks.get(taskId)
    expect(arrived).toBeDefined()
    expect(arrived?.deleted).toBe(true)
  })

  it('acceptance 4: no deleted row flips back to live across repeated cycles', async () => {
    const testUser = await createTestUser('soft-delete-a4')
    const { taskId } = await seedWorkspaceWithTask(testUser)
    await drivePushAndPullCycle()

    await deleteTask(taskId)
    await drivePushAndPullCycle()

    for (let cycle = 0; cycle < 3; cycle++) {
      await drivePushAndPullCycle()
      const row = await db.tasks.get(taskId)
      expect(row?.deleted).toBe(true)
    }
  })
})

describe('US5 — soft-delete propagation (T022: acceptances 2, 3)', () => {
  it('forces a live late child deleted, and cascades every existing child on workspace delete', async () => {
    const testUser = await createTestUser('soft-delete-cascade')
    const client = await clientFor(testUser)
    const stamp = () => new Date().toISOString()

    const workspaceId = crypto.randomUUID()
    const existingTaskId = crypto.randomUUID()

    const { error: workspaceInsertError } = await client.from('workspaces').insert({
      id: workspaceId,
      user_id: testUser.user.id,
      name: 'to be deleted',
      position: 1000,
      gcal_sync: false,
      gcal: null,
      created_at: stamp(),
      updated_at: stamp(),
      deleted: false,
    })
    expect(workspaceInsertError).toBeNull()

    const { error: existingTaskInsertError } = await client.from('tasks').insert({
      id: existingTaskId,
      user_id: testUser.user.id,
      workspace_id: workspaceId,
      title: 'already there when the workspace was deleted',
      created_at: stamp(),
      updated_at: stamp(),
      deleted: false,
    })
    expect(existingTaskInsertError).toBeNull()

    // Acceptance 3: deleting the workspace — an ordinary UPDATE, exactly what
    // `deleteWorkspace()`'s push would send — must reach every child that was
    // already live via `follow_workspace_delete` (AFTER UPDATE,
    // schema.sql:158-175).
    const { error: workspaceDeleteError } = await client
      .from('workspaces')
      .update({ deleted: true, updated_at: stamp() })
      .eq('id', workspaceId)
    expect(workspaceDeleteError).toBeNull()

    const { data: existingAfterCascade, error: existingReadError } = await client
      .from('tasks')
      .select('deleted')
      .eq('id', existingTaskId)
      .single()
    expect(existingReadError).toBeNull()
    expect(existingAfterCascade?.deleted).toBe(true)

    // Acceptance 2: a live child sent *after* the workspace is already
    // deleted — an offline device's queued push that never learned of the
    // delete — is forced deleted on arrival by `stay_deleted_with_workspace`
    // (BEFORE INSERT, schema.sql:177-190), not stored live.
    const lateTaskId = crypto.randomUUID()
    const { data: lateTask, error: lateInsertError } = await client
      .from('tasks')
      .insert({
        id: lateTaskId,
        user_id: testUser.user.id,
        workspace_id: workspaceId,
        title: 'sent after the workspace was already deleted',
        created_at: stamp(),
        updated_at: stamp(),
        deleted: false, // what the offline device still believes
      })
      .select('deleted')
      .single()
    expect(lateInsertError).toBeNull()
    expect(lateTask?.deleted).toBe(true)
  })
})
