// US6 (spec.md acceptances 1, 2, 3, 6) + FR-019/FR-020 — a member's offline
// edit survives the round trip, the same way P0 pinned it for personal rows,
// now that the writer may be someone other than the workspace's own account.
//
// Modeled on the P0 stack pair this story repeats with a team workspace and a
// non-owner writer: `tests/stack/offline-round-trip.test.ts` (the personal
// twin — same offline/reconnect driver shape, US1 acceptances 1-2) and
// `tests/stack/lww-conflict.test.ts` (T014-T016 — the same LWW lockstep,
// server `keep_newer()` and client `mergeRows`, pinned here for a write
// authorized by `is_member` rather than by `own_rows`). Every push/pull is
// driven through the harness's `driveSyncCycle`/`flushQueue`
// (`tests/harness/sync.ts`) — never a private two-settle copy (002 receipts,
// "sync-engine flake receipt", T003's F-1 finding) — and every account comes
// from `tests/harness/accounts.ts`. Team fixtures come from
// `tests/harness/seed.ts`'s `seedTeamWorkspace` (T019): it signs the owner in
// on the app singleton, creates the workspace through `src/db/api.ts`, flips
// it to `kind: 'team'` and adds members through `add_member_by_email` — the
// same real creation path a member-facing test should exercise, not rows
// inserted behind it.
//
// Acceptances 4 and 5 (device-claim wipe semantics on account switch) are not
// repeated here — they belong to `tests/local/no-wipe-on-reach-growth.test.ts`
// (T030) and the existing P0 claim-cache coverage, neither of which this card
// touches.
//
// Turns green:
//  - acceptance 1 (offline edit reaches the owner on reconnect) and
//    acceptance 3 (a membership row travels the generic sync loop) need only
//    T028-T032 (`members` as the fifth synced table, D-8) plus T019's harness
//    helper, all landed on this branch already.
//  - acceptance 2 (LWW between two members) needs the same: the comparators
//    are table-agnostic and the `is_member` write half is already live
//    (T023, prior spec), so this is pinning behaviour that exists, not new
//    behaviour.
//  - acceptance 6 / edge case 1 (a removed member's queued edit is refused
//    without wedging the queue) depends on **T036** (`src/sync/sync.ts`'s
//    per-row retry, D-18): without it, the push loop throws on the whole
//    batch (pre-T036 shape) before any row in it is marked clean, so the
//    innocent row queued behind the refused one in the same table stays
//    dirty forever — exactly the defect `tests/stack/push-refusal-fallback.test.ts`
//    (T035) pins for upstream's `own_rows`. This file's last case is the same
//    shape, one layer up: the refusal comes from `is_member` turning false
//    instead of from writing into a workspace you never owned. T036 is
//    landed on this branch as of this file's authoring, so all four cases
//    below are green; the case is written and asserted exactly as it would
//    need to be to catch a regression of D-18, not written against a red
//    baseline.
//
// Read: spec.md US6 acceptances 1-6, FR-019, FR-020; plan.md D-7 (soft
// delete, and its 2026-09-13 ADR-0006 §E correction — a WITH CHECK failure on
// an existing membership is a `42501` batch throw, not the silent
// fewer-ids-back path), D-8 (`members` on the generic loop), R-14 (fixed by
// D-18); `tests/stack/push-refusal-fallback.test.ts` (the D-18/T036 red
// pattern this file's last case mirrors: a fresh, never-before-written row
// pointed at a workspace the writer can no longer reach); `tests/stack/members-two-accounts.test.ts`
// acceptance 4 (the exact removal-then-refused-insert shape, `42501`, proven
// against raw clients — this file drives the same shape through the app's
// sync engine instead).
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { createLabel, createTask, createWorkspace, updateTask, type TaskPatch } from '../../src/db/api'
import { supabase } from '../../src/auth/supabase'
import { db, wipeLocal, type Local } from '../../src/db/local'
import type { Task } from '../../src/db/types'
import { clientFor, createTestUsers, deleteTestUser } from '../harness/accounts'
import { seedTeamWorkspace } from '../harness/seed'
import { assertStackReachable } from '../harness/stack'
import { driveSyncCycle, flushQueue } from '../harness/sync'
import { getSyncState } from '../../src/sync/sync'
import type { SupabaseClient } from '@supabase/supabase-js'

const T_STALE = '2031-06-01T00:00:00.000Z'
const T_NEWER = '2031-06-01T00:05:00.000Z'

const EDIT: TaskPatch = {
  title: 'edited offline by a member',
  description: 'written with no connectivity, by B',
  done: true,
}

/** Row as `tasks` actually stores it — enough columns for this file's own checks, not the full wire whitelist (that is `offline-round-trip.test.ts`'s job). */
async function fetchTask(raw: SupabaseClient, id: string): Promise<Record<string, unknown>> {
  const { data, error } = await raw.from('tasks').select('*').eq('id', id).single()
  if (error) throw error
  return data as Record<string, unknown>
}

/** A fabricated local task row, standing in for "already edited before this device ever pulled a clean copy" — same shape as `lww-conflict.test.ts`'s own `localTask`, with `assignee` added so `tsc -b` is clean against the current `Task` interface. */
function localTask(o: {
  id: string
  workspace_id: string
  updated_at: string
  title?: string
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
    assignee: null,
    created_at: o.updated_at,
    updated_at: o.updated_at,
    deleted: false,
    _dirty: 1,
  }
}

async function signIn(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`signIn(${email}) failed: ${error.message}`)
}

beforeAll(async () => {
  await assertStackReachable()
}, 30_000)

afterEach(async () => {
  await supabase.auth.signOut()
  await wipeLocal()
  // Owner decision, TG-1 intro: every 002 test that seeds `members` clears
  // `db.members` itself rather than leaning on `tests/setup.ts` (a P0 file
  // that stays unedited) to know the fork's fifth table exists. `wipeLocal()`
  // already clears it (T029); this is the explicit, load-bearing statement of
  // that convention, not a second mechanism.
  await db.members.clear()
  // Every case below flips `navigator.onLine`; leaving it `false` would start
  // the next case's own "regains connectivity" cycle from a lie (same
  // rationale as `offline-round-trip.test.ts`'s own `afterEach`).
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
})

afterAll(async () => {
  await wipeLocal()
  await db.members.clear()
})

it(
  'acceptance 1: a member’s offline edit to a team task is held locally, marked unsent, and reaches the owner once the member reconnects',
  async () => {
    const [ownerA, memberB] = await createTestUsers(2, 'us6-acc1')
    try {
      const seeded = await seedTeamWorkspace(ownerA, [memberB])
      const taskId = await createTask(seeded.workspaceId, { title: 'seeded by the owner' })
      await driveSyncCycle()
      await supabase.auth.signOut()

      // B claims this device fresh and pulls the team workspace + the task
      // before ever going offline.
      await signIn(memberB.email, memberB.password)
      await driveSyncCycle()
      expect(await db.tasks.get(taskId)).toBeTruthy()

      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
      await updateTask(taskId, EDIT)

      const local = await db.tasks.get(taskId)
      expect(local?._dirty).toBe(1)
      expect(local?.title).toBe(EDIT.title)
      expect(local?.description).toBe(EDIT.description)
      expect(local?.done).toBe(EDIT.done)

      // Still offline: the owner's own read of the row is untouched.
      const rawOwner = await clientFor(ownerA)
      const beforeReconnect = await fetchTask(rawOwner, taskId)
      expect(beforeReconnect.title).not.toBe(EDIT.title)

      Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
      await driveSyncCycle()

      // "A sees it": read through the owner's own authenticated client, the
      // same RLS path A's own device would use.
      const afterReconnect = await fetchTask(rawOwner, taskId)
      expect(afterReconnect.title).toBe(EDIT.title)
      expect(afterReconnect.description).toBe(EDIT.description)
      expect(afterReconnect.done).toBe(EDIT.done)

      const localAfter = await db.tasks.get(taskId)
      expect(localAfter?._dirty).toBe(0)
    } finally {
      await supabase.auth.signOut()
      await deleteTestUser(ownerA)
      await deleteTestUser(memberB)
    }
  },
  30_000,
)

it(
  'acceptance 2: between two members editing the same team row, the older edit loses at the backend and, independently, at the client merge step',
  async () => {
    const [ownerA, member1, member2] = await createTestUsers(3, 'us6-acc2')
    try {
      const seeded = await seedTeamWorkspace(ownerA, [member1, member2])
      await supabase.auth.signOut()

      const rawMember1 = await clientFor(member1)

      // Positive control: an ordinary, uncontested member write lands first —
      // proves the refusal below is the conflict, not a member being unable
      // to write a team row at all.
      const { error: controlErr } = await rawMember1.from('tasks').insert({
        id: randomUUID(),
        user_id: member1.user.id,
        workspace_id: seeded.workspaceId,
        title: 'member1: uncontested write',
      })
      expect(controlErr).toBeNull()

      // The already-stored, newer edit — landed directly, as if from
      // member1's own other device.
      const taskId = randomUUID()
      const { error: storeErr } = await rawMember1.from('tasks').upsert(
        {
          id: taskId,
          user_id: member1.user.id,
          workspace_id: seeded.workspaceId,
          title: 'winning (member1, already stored)',
          updated_at: T_NEWER,
          deleted: false,
        },
        { onConflict: 'id' },
      )
      expect(storeErr).toBeNull()
      const storedBefore = await fetchTask(rawMember1, taskId)

      // member2 signs in on this device. Unlike `lww-conflict.test.ts`'s
      // T016 acceptance 5 (a single account throughout that file's
      // `it`), this test signs *two* different accounts in on the same app
      // singleton within one case (owner, then member2) — an account switch
      // that `claimCache` (`src/db/local.ts`) rightly wipes on member2's
      // first push. One harmless cycle first lands that wipe (and pulls
      // member2's own clean baseline) before the stale, unsent edit is
      // fabricated below, so the wipe does not eat the very row this test is
      // about.
      await signIn(member2.email, member2.password)
      await driveSyncCycle()
      await db.tasks.put(
        localTask({
          id: taskId,
          workspace_id: seeded.workspaceId,
          updated_at: T_STALE,
          title: 'losing (member2, stale, unsent)',
        }),
      )

      const remaining = await flushQueue()
      expect(remaining).toBe(0) // the queue drains — the losing edit is not retried forever

      // ---- backend enforcement point (keep_newer) ----
      const serverAfter = await fetchTask(rawMember1, taskId)
      expect(serverAfter.title).toBe('winning (member1, already stored)')
      expect(Date.parse(serverAfter.synced_at as string)).toBe(Date.parse(storedBefore.synced_at as string))

      // ---- client enforcement point (mergeRows, refused-row path) ----
      const localAfter = await db.tasks.get(taskId)
      expect(localAfter?.title).toBe('winning (member1, already stored)')
      expect(localAfter?._dirty).toBe(0)
    } finally {
      await supabase.auth.signOut()
      await deleteTestUser(ownerA)
      await deleteTestUser(member1)
      await deleteTestUser(member2)
    }
  },
  30_000,
)

it(
  'acceptance 3: a membership change made while a member is offline reaches that client’s cache on its next cycle',
  async () => {
    const [ownerA, existingMember, newMember] = await createTestUsers(3, 'us6-acc3')
    try {
      const seeded = await seedTeamWorkspace(ownerA, [existingMember])
      const rawOwner = await clientFor(ownerA)
      await supabase.auth.signOut()

      await signIn(existingMember.email, existingMember.password)
      await driveSyncCycle()

      // Positive control / contrast: before the membership change, the new
      // member's row is not yet in this device's cache — so finding it there
      // afterward is attributable to the sync cycle below, not to seeding.
      const before = await db.members.where('workspace_id').equals(seeded.workspaceId).toArray()
      expect(before.some((m) => m.member_id === newMember.user.id)).toBe(false)

      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })

      // The owner adds the new member from an entirely separate connection —
      // this device never touches it, the same "another device lands a row
      // directly" shape `lww-conflict.test.ts` uses for its server-side half.
      const { error: addErr } = await rawOwner.rpc('add_member_by_email', {
        ws: seeded.workspaceId,
        email: newMember.email,
      })
      expect(addErr).toBeNull()

      Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
      await driveSyncCycle()

      const after = await db.members.where('workspace_id').equals(seeded.workspaceId).toArray()
      const newRow = after.find((m) => m.member_id === newMember.user.id)
      expect(newRow).toBeTruthy()
      expect(newRow?.level).toBe('member')
      expect(newRow?.deleted).toBe(false)
    } finally {
      await supabase.auth.signOut()
      await deleteTestUser(ownerA)
      await deleteTestUser(existingMember)
      await deleteTestUser(newMember)
    }
  },
  30_000,
)

it(
  'acceptance 6 / edge case 1: a member removed while offline has unsent edits refused on reconnect, dropped without retrying forever, and without stalling any other row or table',
  async () => {
    const [ownerA, memberB] = await createTestUsers(2, 'us6-acc6')
    try {
      const seeded = await seedTeamWorkspace(ownerA, [memberB])
      const rawOwner = await clientFor(ownerA)
      await supabase.auth.signOut()

      await signIn(memberB.email, memberB.password)
      await driveSyncCycle()

      Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })

      // B's own, still-reachable workspace and its innocent rows — created
      // while offline too. `SYNCED_TABLES` pushes `workspaces` and `labels`
      // ahead of `tasks` (D-8), so none of this needs a separate cycle to
      // land first.
      const bOwnWorkspaceId = await createWorkspace('b own reachable workspace')
      const innocentTaskId = await createTask(bOwnWorkspaceId, {
        title: 'innocent: same table, different (reachable) workspace',
      })
      const innocentLabelId = await createLabel(bOwnWorkspaceId, 'innocent: a different table entirely', 'slate')

      // The refused row: a brand-new task, never before on the server,
      // pointed at the team workspace B is about to be removed from — the
      // same fresh-INSERT shape `push-refusal-fallback.test.ts` (T035) pins
      // for upstream's `own_rows`, here produced by `is_member` instead.
      const refusedTaskId = await createTask(seeded.workspaceId, {
        title: 'refused: B is removed before this ever lands',
      })

      // The owner removes B from an entirely separate connection — this
      // device's cache is never touched by it, same shape as acceptance 3
      // above and as `members-two-accounts.test.ts` acceptance 4.
      const { data: bMemberRow, error: findErr } = await rawOwner
        .from('members')
        .select('id')
        .eq('workspace_id', seeded.workspaceId)
        .eq('member_id', memberB.user.id)
        .single()
      expect(findErr).toBeNull()
      const { error: removeErr } = await rawOwner.from('members').upsert(
        {
          id: bMemberRow!.id,
          user_id: ownerA.user.id,
          workspace_id: seeded.workspaceId,
          member_id: memberB.user.id,
          level: 'member',
          deleted: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'id' },
      )
      expect(removeErr).toBeNull()

      Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })

      // Out-of-band proof the refusal mechanism is live for this exact
      // membership, independent of this test's own queue — mirrors
      // `push-refusal-fallback.test.ts`'s own probe.
      const rawB = await clientFor(memberB)
      const { error: probeErr } = await rawB.from('tasks').insert({
        id: randomUUID(),
        user_id: memberB.user.id,
        workspace_id: seeded.workspaceId,
        title: 'refusal probe',
      })
      expect(probeErr?.code).toBe('42501')

      const remaining = await flushQueue()

      // ---- the innocent rows: not stalled ----
      // Different tables (`workspaces`, `labels`) were never wedged by
      // `tasks`'s refusal even before T036 — today's per-table `catch`
      // already isolates them (`sync.ts:274-277`). This is a same-cycle
      // canary, not the central claim.
      expect((await db.workspaces.get(bOwnWorkspaceId))?._dirty).toBe(0)
      expect((await db.labels.get(innocentLabelId))?._dirty).toBe(0)

      // The central claim (RED before T036): the innocent task, queued in
      // the SAME table batch as the refused one, must still land within this
      // cycle rather than staying wedged behind it forever.
      expect((await db.tasks.get(innocentTaskId))?._dirty).toBe(0)
      const { data: serverInnocentTask, error: innocentErr } = await rawB
        .from('tasks')
        .select('id')
        .eq('id', innocentTaskId)
      expect(innocentErr).toBeNull()
      expect(serverInnocentTask).toHaveLength(1)

      // The queue actually drains — the refused row stops being offered
      // rather than being retried forever (RED before T036).
      expect(remaining).toBe(0)

      // Reconciliation: B can no longer reach the team workspace at all, and
      // there was never a server row under B's own `user_id` for
      // `refusedTaskId` to begin with, so nothing will ever hand back a
      // correcting version of it — D-18 point 4 (mirrored from
      // `push-refusal-fallback.test.ts`'s identical assertion).
      await driveSyncCycle()
      expect(await db.tasks.get(refusedTaskId)).toBeUndefined()

      // A refusal is an answer, not an outage (D-18 point 5).
      expect(getSyncState()).not.toBe('error')
    } finally {
      await supabase.auth.signOut()
      await deleteTestUser(ownerA)
      await deleteTestUser(memberB)
    }
  },
  30_000,
)
