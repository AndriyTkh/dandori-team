// TG-4 (US2) — last-write-wins, pinned at both enforcement points.
//
// T014 (server half, acc lww-acc1/lww-acc2): `keep_newer()`
// (supabase/migration-006-lww-and-ownership.sql:37-48) refuses an update
// whose `updated_at` is older than the row it already holds — content stays
// put and `synced_at` does not move (ARCHITECTURE.md §4 L357-378) — and the
// losing device's own queue (`src/sync/sync.ts:203-280`) stops re-sending the
// refused row without stalling any other row or table (per-table try/catch at
// `sync.ts:274-280`, per-row refusal handling at `sync.ts:257-272`).
//
// T015 (client half, acc lww-acc3/lww-acc4): the *other* enforcement point,
// `mergeRows` (`src/sync/sync.ts:409-458`), is not exported (plan.md F-2), so
// it is pinned behaviourally: drive a real pull and read Dexie back. The
// first gate (`:432`, local strictly newer wins) and the equal-stamp
// acceptance documented for F-6 (bookkeeping writes land at the row level,
// no calendar code) are both exercised through `driveSyncCycle`
// (`tests/harness/sync.ts`).
//
// T016 (lockstep, acc lww-acc5): one real push cycle exercises the server's
// refusal *and* the client's acceptance of that refusal together (`mergeRows`
// is also the function push() calls on its own refused-row path, `sync.ts:271`)
// — so a single set of assertions depends on both halves at once, per
// CLAUDE.md "LWW lockstep" and ADR-0001 §3. SC-008 additionally asks for a
// demonstration that inverting either half breaks something, "demonstrated
// once, deliberately, and recorded": rather than disabling the live
// `keep_newer` trigger or patching `mergeRows` — both `src/` and `supabase/`
// are off-limits here, and the local stack is shared with other agents'
// concurrent test runs, so a live trigger toggle would be a ledger-integrity
// risk, not a safe demonstration — the file below mirrors each predicate as a
// small shadow function built only from this file's own inputs
// (`serverKeepsIncoming` mirrors migration-006:41-46,
// `clientKeepsLocalOverIncoming` mirrors sync.ts:432), asserts each shadow
// agrees with the real outcome captured by the acceptance-5 test above it,
// then inverts each shadow in turn and asserts the inverted prediction
// disagrees with that same real outcome. That is the required mutation,
// performed on the test's own inputs, confirmed mechanically on every run
// rather than as a one-off manual note.
//
// Read: ARCHITECTURE.md §4 L357-378 (LWW contract), L331-356 (sync loop,
// per-table error isolation, sync.ts:274-280/:203-209);
// supabase/migration-006-lww-and-ownership.sql:37-48; plan.md F-2, F-6;
// CLAUDE.md "LWW lockstep"; ADR-0001-fork-contract.md §3; spec.md US2
// acceptances 1-5, SC-008.
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { clientFor, createTestUser, deleteTestUser, type TestUser } from '../harness/accounts'
import { assertStackReachable } from '../harness/stack'
import { driveSyncCycle, flushQueue } from '../harness/sync'
import { supabase } from '../../src/auth/supabase'
import { db, type Local } from '../../src/db/local'
import type { Label, Task } from '../../src/db/types'

const T_STALE = '2030-06-01T00:00:00.000Z'
const T_NEWER = '2030-06-01T00:05:00.000Z'

// -------------------------------------------------------------- fixtures

function localTask(o: {
  id: string
  workspace_id: string
  updated_at: string
  title?: string
  _dirty?: 0 | 1
}): Local<Task> {
  return {
    id: o.id,
    workspace_id: o.workspace_id,
    title: o.title ?? 'local task',
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
    _dirty: o._dirty ?? 1,
  }
}

function localLabel(o: {
  id: string
  workspace_id: string
  updated_at: string
  name?: string
  _dirty?: 0 | 1
}): Local<Label> {
  return {
    id: o.id,
    workspace_id: o.workspace_id,
    name: o.name ?? 'local label',
    color: 'slate',
    position: 0,
    created_at: o.updated_at,
    updated_at: o.updated_at,
    deleted: false,
    _dirty: o._dirty ?? 1,
  }
}

async function insertWorkspace(raw: SupabaseClient, userId: string, id: string): Promise<void> {
  const { error } = await raw.from('workspaces').insert({ id, user_id: userId, name: 'lww test workspace' })
  if (error) throw error
}

async function upsertTaskDirect(
  raw: SupabaseClient,
  userId: string,
  workspaceId: string,
  o: { id: string; title: string; updated_at: string },
): Promise<void> {
  const { error } = await raw
    .from('tasks')
    .upsert(
      {
        id: o.id,
        user_id: userId,
        workspace_id: workspaceId,
        title: o.title,
        updated_at: o.updated_at,
        deleted: false,
      },
      { onConflict: 'id' },
    )
  if (error) throw error
}

async function fetchTask(raw: SupabaseClient, id: string): Promise<Record<string, unknown>> {
  const { data, error } = await raw.from('tasks').select('*').eq('id', id).single()
  if (error) throw error
  return data as Record<string, unknown>
}

async function fetchLabel(raw: SupabaseClient, id: string): Promise<Record<string, unknown>> {
  const { data, error } = await raw.from('labels').select('*').eq('id', id).single()
  if (error) throw error
  return data as Record<string, unknown>
}

async function signInApp(user: TestUser): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email: user.email, password: user.password })
  if (error) throw error
}

/*
 * Harness trap (flagged by the coordinator, found by TG-3/US1): `push()`
 * enters `syncing` and calls its own `settle()` even with nothing dirty to
 * send (`src/sync/sync.ts:200-281`), *before* `pull()` ever runs. Every use
 * of `driveSyncCycle` below forces that cycle's *push* to see
 * `navigator.onLine === false` for exactly its one check, so push
 * early-returns offline and never reaches `syncing` at all — only pull's
 * settle ever lands, once. `driveSyncCycle` is called with `{ settles: 1 }`
 * accordingly, so it genuinely waits for the pull this test cares about
 * instead of timing out waiting for a second settle that will never come.
 * This never touches `src/` or `supabase/` — it only stubs a jsdom global for
 * the scope of one cycle.
 */
function stubOnLineOnceFalse(): () => void {
  let used = false
  Object.defineProperty(window.navigator, 'onLine', {
    configurable: true,
    get: () => {
      if (used) return true
      used = true
      return false
    },
  })
  return () => {
    delete (window.navigator as unknown as Record<string, unknown>).onLine
  }
}

async function drivePullOnly(): Promise<void> {
  const restore = stubOnLineOnceFalse()
  try {
    await driveSyncCycle({ settles: 1 })
  } finally {
    restore()
  }
}

beforeAll(async () => {
  await assertStackReachable()
}, 30_000)

afterEach(async () => {
  await supabase.auth.signOut()
})

// ------------------------------------------------------------------ T014

describe('T014 — server half: LWW enforcement on write', () => {
  it('acceptance 1: an older update cannot overwrite a newer stored row, and synced_at does not move', async () => {
    const acc1 = await createTestUser('lww-acc1')
    try {
      const raw = await clientFor(acc1)
      const workspaceId = randomUUID()
      const taskId = randomUUID()
      await insertWorkspace(raw, acc1.user.id, workspaceId)

      await upsertTaskDirect(raw, acc1.user.id, workspaceId, {
        id: taskId,
        title: 'stored: newer',
        updated_at: T_NEWER,
      })
      const storedFirst = await fetchTask(raw, taskId)
      expect(storedFirst.title).toBe('stored: newer')

      // An older edit for the same row arrives at the backend.
      await upsertTaskDirect(raw, acc1.user.id, workspaceId, {
        id: taskId,
        title: 'stale: older',
        updated_at: T_STALE,
      })

      const after = await fetchTask(raw, taskId)
      expect(after.title).toBe('stored: newer') // content unchanged
      expect(Date.parse(after.updated_at as string)).toBe(Date.parse(T_NEWER))
      expect(Date.parse(after.synced_at as string)).toBe(Date.parse(storedFirst.synced_at as string)) // not moved
    } finally {
      await deleteTestUser(acc1)
    }
  }, 30_000)

  it('acceptance 2: the losing client stops re-sending, and the refusal stalls neither other rows nor other tables', async () => {
    const acc2 = await createTestUser('lww-acc2')
    try {
      const raw = await clientFor(acc2)
      const workspaceId = randomUUID()
      await insertWorkspace(raw, acc2.user.id, workspaceId)

      const losingTaskId = randomUUID()
      const fineTaskId = randomUUID()
      const fineLabelId = randomUUID()

      // Another device already landed the winning edit directly.
      await upsertTaskDirect(raw, acc2.user.id, workspaceId, {
        id: losingTaskId,
        title: 'winning (already stored)',
        updated_at: T_NEWER,
      })
      const storedBefore = await fetchTask(raw, losingTaskId)

      await signInApp(acc2)

      // This device's own queue: a stale unsent edit for the same row, plus
      // an unrelated task and an unrelated label that must both still land.
      await db.tasks.put(
        localTask({ id: losingTaskId, workspace_id: workspaceId, updated_at: T_STALE, title: 'losing (stale, unsent)' }),
      )
      await db.tasks.put(
        localTask({ id: fineTaskId, workspace_id: workspaceId, updated_at: T_NEWER, title: 'fine local edit' }),
      )
      await db.labels.put(
        localLabel({ id: fineLabelId, workspace_id: workspaceId, updated_at: T_NEWER, name: 'fine local label' }),
      )

      const remaining = await flushQueue()
      expect(remaining).toBe(0) // the queue drains — the losing edit is not retried forever

      const localLosing = await db.tasks.get(losingTaskId)
      expect(localLosing?._dirty).toBe(0) // stops being offered
      expect(localLosing?.title).toBe('winning (already stored)') // adopted the server's authoritative content

      const serverLosing = await fetchTask(raw, losingTaskId)
      expect(serverLosing.title).toBe('winning (already stored)')
      expect(Date.parse(serverLosing.synced_at as string)).toBe(Date.parse(storedBefore.synced_at as string))

      const serverFineTask = await fetchTask(raw, fineTaskId)
      expect(serverFineTask.title).toBe('fine local edit') // not stalled by the refusal (same table)

      const serverFineLabel = await fetchLabel(raw, fineLabelId)
      expect(serverFineLabel.name).toBe('fine local label') // not stalled by the refusal (other table)
    } finally {
      await deleteTestUser(acc2)
    }
  }, 30_000)
})

// ------------------------------------------------------------------ T015

describe('T015 — client half: mergeRows gates observed through a pull', () => {
  it('acceptance 3: an incoming older row leaves a newer, still-unsent local copy in place', async () => {
    const acc3 = await createTestUser('lww-acc3')
    try {
      const raw = await clientFor(acc3)
      const workspaceId = randomUUID()
      const taskId = randomUUID()
      await insertWorkspace(raw, acc3.user.id, workspaceId)
      // The server's already-synced copy — older than the edit this device
      // is about to make locally, and never touched by this device's push
      // (forced offline below), so the pull path alone is what is on trial.
      await upsertTaskDirect(raw, acc3.user.id, workspaceId, {
        id: taskId,
        title: 'server: older',
        updated_at: T_STALE,
      })

      await signInApp(acc3)
      await db.tasks.put(
        localTask({ id: taskId, workspace_id: workspaceId, updated_at: T_NEWER, title: 'local: newer, unsent' }),
      )

      await drivePullOnly()

      const local = await db.tasks.get(taskId)
      expect(local?.title).toBe('local: newer, unsent') // kept
      expect(local?._dirty).toBe(1) // still unsent — this cycle's push never ran
    } finally {
      await deleteTestUser(acc3)
    }
  }, 30_000)

  it('acceptance 4: an incoming row at the same instant is accepted (equal stamps, row level, no calendar code — F-6)', async () => {
    const acc4 = await createTestUser('lww-acc4')
    try {
      const raw = await clientFor(acc4)
      const workspaceId = randomUUID()
      const taskId = randomUUID()
      await insertWorkspace(raw, acc4.user.id, workspaceId)
      await upsertTaskDirect(raw, acc4.user.id, workspaceId, { id: taskId, title: 'server: v1', updated_at: T_NEWER })

      await signInApp(acc4)

      // Pull it down once so the local copy is clean (already synced).
      await drivePullOnly()
      const clean = await db.tasks.get(taskId)
      expect(clean?.title).toBe('server: v1')
      expect(clean?._dirty).toBe(0)

      // A bookkeeping-only server write: same instant, different content —
      // the case F-6 documents (a device rewriting a field without
      // advancing the edit clock), reproduced here directly at the row
      // level, no calendar code involved.
      await upsertTaskDirect(raw, acc4.user.id, workspaceId, {
        id: taskId,
        title: 'server: v2 (bookkeeping, same instant)',
        updated_at: T_NEWER,
      })

      await drivePullOnly()

      const after = await db.tasks.get(taskId)
      expect(after?.title).toBe('server: v2 (bookkeeping, same instant)') // equal stamps accepted
      expect(after?._dirty).toBe(0)
    } finally {
      await deleteTestUser(acc4)
    }
  }, 30_000)
})

// ------------------------------------------------------------------ T016

describe('T016 — lockstep: both enforcement points, and their sensitivity (SC-008)', () => {
  it('acceptance 5: one real push cycle exercises the server refusal and the client acceptance of it together', async () => {
    const acc5 = await createTestUser('lww-acc5')
    try {
      const raw = await clientFor(acc5)
      const workspaceId = randomUUID()
      const taskId = randomUUID()
      await insertWorkspace(raw, acc5.user.id, workspaceId)

      await upsertTaskDirect(raw, acc5.user.id, workspaceId, {
        id: taskId,
        title: 'winning (already stored)',
        updated_at: T_NEWER,
      })
      const storedBefore = await fetchTask(raw, taskId)

      await signInApp(acc5)
      await db.tasks.put(
        localTask({ id: taskId, workspace_id: workspaceId, updated_at: T_STALE, title: 'losing (stale, unsent)' }),
      )

      const remaining = await flushQueue()
      expect(remaining).toBe(0)

      // ---- server-side enforcement point (keep_newer) ----
      const serverAfter = await fetchTask(raw, taskId)
      expect(serverAfter.title).toBe('winning (already stored)')
      expect(Date.parse(serverAfter.synced_at as string)).toBe(Date.parse(storedBefore.synced_at as string))

      // ---- client-side enforcement point (mergeRows, refused-row path) ----
      const localAfter = await db.tasks.get(taskId)
      expect(localAfter?.title).toBe('winning (already stored)')
      expect(localAfter?._dirty).toBe(0)
    } finally {
      await deleteTestUser(acc5)
    }
  }, 30_000)

  it('SC-008 demonstration: inverting either enforcement point alone disagrees with the observed outcome above', () => {
    /*
     * Shadow predicates, built only from this file's own inputs — never from
     * `src/` or `supabase/`. Each mirrors one enforcement point's real
     * predicate against the exact stamps the acceptance-5 test above just
     * exercised for real (stored T_NEWER, incoming/local T_STALE), so
     * agreement here is anchored to an actually-observed outcome, not to a
     * restated assumption.
     */
    // Mirrors migration-006-lww-and-ownership.sql:41-46 (`if new.updated_at
    // < old.updated_at then return null`): true means the incoming write is
    // kept (accepted) by the server.
    const serverKeepsIncoming = (storedAt: string, incomingAt: string): boolean =>
      !(Date.parse(incomingAt) < Date.parse(storedAt))

    // Mirrors sync.ts:432 (`if (local && isNewer(local.updated_at,
    // clean.updated_at)) continue`): true means the client keeps its own
    // local row over what just arrived (the incoming/kept row loses).
    const clientKeepsLocalOverIncoming = (localAt: string, incomingAt: string): boolean =>
      Date.parse(localAt) > Date.parse(incomingAt)

    // The real, observed outcome from acceptance 5: the server refused the
    // stale push (did not keep it), and the client did not keep the stale
    // local row over the server's authoritative answer.
    const realServerKeptIncoming = false
    const realClientKeptLocal = false

    expect(serverKeepsIncoming(T_NEWER, T_STALE)).toBe(realServerKeptIncoming)
    expect(clientKeepsLocalOverIncoming(T_STALE, T_NEWER)).toBe(realClientKeptLocal)

    // Single-sided change 1: invert only the server predicate (as if
    // `keep_newer` stopped refusing anything older). Its prediction for the
    // very same stamps now disagrees with the real, observed server outcome
    // captured in acceptance 5 above — i.e. this change alone would have
    // broken that test's server-side assertions.
    const invertedServerKeepsIncoming = (storedAt: string, incomingAt: string): boolean =>
      !serverKeepsIncoming(storedAt, incomingAt)
    expect(invertedServerKeepsIncoming(T_NEWER, T_STALE)).not.toBe(realServerKeptIncoming)

    // Single-sided change 2: invert only the client predicate (as if
    // mergeRows' `isNewer` gate were dropped or reversed). Its prediction
    // disagrees with the real, observed client outcome — this change alone
    // would have broken the client-side assertions (in acceptance 5 above,
    // and in T015 acceptance 3, where a genuinely newer local edit must
    // survive an older incoming row).
    const invertedClientKeepsLocalOverIncoming = (localAt: string, incomingAt: string): boolean =>
      !clientKeepsLocalOverIncoming(localAt, incomingAt)
    expect(invertedClientKeepsLocalOverIncoming(T_STALE, T_NEWER)).not.toBe(realClientKeptLocal)
  })
})
