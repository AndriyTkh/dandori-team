import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTask,
  createWorkspace,
  deleteWorkspace,
  isAdmin,
  listMembers,
  listWorkspaces,
  refreshIsAdmin,
  removeMember,
  renameWorkspace,
  updateTask,
} from '../../src/db/api'
import { db, wipeLocal, type Local } from '../../src/db/local'
import type { Label, Member, Note, Task, Workspace } from '../../src/db/types'
import { translate } from '../../src/i18n'

/*
 * 002-team-workspaces T001 — pins the `db-api` functions P1 touches *as they
 * behave today*, before `src/db/api.ts` changes (plan.md "Validation
 * substrate": the `db-api` debt row is the first task of the feature).
 *
 * Targets `src/db/api.ts` read-only; this file writes no source. Every mutator
 * is a Dexie `rw` read-modify-write followed by `queue()`, which asks the sync
 * layer for a debounced push (ARCHITECTURE.md §4 "The db-api surface"). The
 * sync module is replaced wholesale here: `requestPush` becomes a spy, so
 * "queued" is asserted as a call and no debounce timer, session read or network
 * ever runs. Dexie itself runs against `fake-indexeddb` (tests/setup.ts), the
 * same substrate as tests/local/claim-cache.test.ts.
 *
 * `updated_at` is the LWW clock and is authored by the device
 * (ARCHITECTURE.md §3 "The three timestamps"); `Date` alone is faked so the
 * bump is asserted against an exact value, while fake-indexeddb keeps its real
 * scheduling.
 *
 * T040 extends this file with the rest of the P1 `db-api` surface T001 could
 * not yet pin (`src/db/api.ts` post-T031/T033): `createWorkspace(name, 'team')`,
 * `listMembers`, `removeMember`, `updateTask`'s `assignee` field (plan.md D-6,
 * D-11), and the `is-admin` meta cache (`isAdmin`/`refreshIsAdmin`, D-17, T033)
 * behind a mock of `isAdminRemote` at the same `src/sync/sync.ts` module
 * boundary `requestPush` is already isolated at, above. **Not** pinned here:
 * `memberEmails` and `addMemberByEmail` are online-only — both reach through
 * that same boundary for an email<->uuid lookup that can only happen where
 * `auth.users` lives (D-9, FR-024 affordance 4, FR-026) — so they cannot be
 * exercised in this Docker-free tier; TG-1's stack tests cover them instead.
 */

vi.mock('../../src/sync/sync', () => ({
  requestPush: vi.fn(),
  isAdminRemote: vi.fn(),
}))

import { isAdminRemote, requestPush } from '../../src/sync/sync'

const requestPushMock = vi.mocked(requestPush)
const isAdminRemoteMock = vi.mocked(isAdminRemote)

const T0 = '2026-03-01T10:00:00.000Z'
const T1 = '2026-03-01T10:05:00.000Z'
const OLD = '2026-01-01T00:00:00.000Z'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function workspaceRow(over: Partial<Local<Workspace>> = {}): Local<Workspace> {
  return {
    id: 'ws-seed',
    name: 'Seeded',
    position: 1000,
    gcal_sync: false,
    gcal: null,
    kind: 'personal',
    created_at: OLD,
    updated_at: OLD,
    deleted: false,
    _dirty: 0,
    ...over,
  }
}

function taskRow(over: Partial<Local<Task>> = {}): Local<Task> {
  return {
    id: 'task-seed',
    workspace_id: 'ws-seed',
    title: 'Seeded task',
    description: 'keep me',
    start_date: null,
    due_date: null,
    done: false,
    remind_days_before: 2,
    muted: false,
    note_id: null,
    position: 1000,
    label_ids: ['label-x'],
    custom_fields: [{ name: 'k', value: 'v' }],
    gcal: null,
    gcal_placed: null,
    assignee: null,
    created_at: OLD,
    updated_at: OLD,
    deleted: false,
    _dirty: 0,
    ...over,
  }
}

function labelRow(over: Partial<Local<Label>> = {}): Local<Label> {
  return {
    id: 'label-seed',
    workspace_id: 'ws-seed',
    name: 'Seeded label',
    color: 'red',
    position: 1000,
    created_at: OLD,
    updated_at: OLD,
    deleted: false,
    _dirty: 0,
    ...over,
  }
}

function noteRow(over: Partial<Local<Note>> = {}): Local<Note> {
  return {
    id: 'note-seed',
    workspace_id: 'ws-seed',
    parent_id: null,
    kind: 'file',
    name: 'Seeded note',
    content: '',
    position: 1000,
    created_at: OLD,
    updated_at: OLD,
    deleted: false,
    _dirty: 0,
    ...over,
  }
}

function memberRow(over: Partial<Local<Member>> = {}): Local<Member> {
  return {
    id: 'member-seed',
    workspace_id: 'ws-seed',
    member_id: 'user-seed',
    level: 'member',
    created_at: OLD,
    updated_at: OLD,
    deleted: false,
    _dirty: 0,
    ...over,
  }
}

describe('db-api P1 surface (T001, Docker-free tier)', () => {
  beforeEach(() => {
    requestPushMock.mockClear()
    isAdminRemoteMock.mockReset()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(T0))
    // Same hard line as claim-cache.test.ts: this tier makes no network call.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('network access attempted in a Docker-free (local) test')
      }),
    )
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    // tests/setup.ts's own afterEach clears workspaces/labels/tasks/notes/meta
    // but predates the `members` table (D-10) and does not know about it; this
    // file is the first local-tier suite to write to db.members, so it clears
    // its own leftovers rather than reaching into that shared file.
    await db.members.clear()
  })

  // ------------------------------------------------------------ createWorkspace

  describe('createWorkspace(name, kind)', () => {
    it('writes a full, dirty row stamped with the device clock and queues a push', async () => {
      const id = await createWorkspace('  Alpha  ')

      expect(id).toMatch(UUID_V4)
      const row = await db.workspaces.get(id)
      expect(row).toEqual({
        id,
        name: 'Alpha', // trimmed
        gcal_sync: false,
        gcal: null,
        kind: 'personal', // T031: defaulted kind param, identical to before it otherwise
        position: 1000, // first row: (0) + POS_STEP
        created_at: T0,
        updated_at: T0, // created_at === updated_at at birth
        deleted: false,
        _dirty: 1,
      })
      expect(requestPushMock).toHaveBeenCalledTimes(1)
    })

    it("writes kind: 'team' when asked, and only the workspace row — no local members row (D-6)", async () => {
      const id = await createWorkspace('Squad', 'team')

      const row = await db.workspaces.get(id)
      expect(row).toMatchObject({ kind: 'team' })
      // The owner's own membership row is `seed_workspace_owner`'s server-side
      // effect and reaches this device on its next pull; writing one locally
      // here would collide with `members_one_per_person` and wedge the queue.
      expect(await db.members.count()).toBe(0)
      expect(requestPushMock).toHaveBeenCalledTimes(1)
    })

    it('gap-allocates position after the last live workspace, ignoring deleted ones', async () => {
      await db.workspaces.bulkAdd([
        workspaceRow({ id: 'ws-a', position: 1000 }),
        workspaceRow({ id: 'ws-b', position: 2000 }),
        workspaceRow({ id: 'ws-gone', position: 9000, deleted: true }),
      ])

      const id = await createWorkspace('Gamma')

      // listWorkspaces() is what createWorkspace reads, so a deleted row at
      // 9000 does not push the new one to 10000.
      expect((await db.workspaces.get(id))?.position).toBe(3000)
    })

    it('takes the dictionary default for a blank name and keeps it as data', async () => {
      const id = await createWorkspace('   ')

      expect((await db.workspaces.get(id))?.name).toBe(translate('common.untitled'))
    })
  })

  // ------------------------------------------------------------ renameWorkspace

  describe('renameWorkspace(id, name)', () => {
    it('trims the name, bumps updated_at, re-dirties a clean row, and queues a push', async () => {
      await db.workspaces.add(workspaceRow({ id: 'ws-1', name: 'Before' }))
      vi.setSystemTime(new Date(T1))

      await renameWorkspace('ws-1', '  After  ')

      const row = await db.workspaces.get('ws-1')
      expect(row).toEqual({
        ...workspaceRow({ id: 'ws-1' }),
        name: 'After',
        updated_at: T1,
        _dirty: 1,
      })
      expect(row?.created_at).toBe(OLD) // untouched
      expect(requestPushMock).toHaveBeenCalledTimes(1)
    })

    it('keeps the old name for a blank input, yet still bumps updated_at and dirties the row', async () => {
      await db.workspaces.add(workspaceRow({ id: 'ws-1', name: 'Keep' }))
      vi.setSystemTime(new Date(T1))

      await renameWorkspace('ws-1', '   ')

      const row = await db.workspaces.get('ws-1')
      expect(row?.name).toBe('Keep')
      expect(row?.updated_at).toBe(T1)
      expect(row?._dirty).toBe(1)
    })

    it('is a no-op on an unknown id, but still queues a push', async () => {
      await renameWorkspace('ws-missing', 'Anything')

      expect(await db.workspaces.count()).toBe(0)
      expect(requestPushMock).toHaveBeenCalledTimes(1)
    })
  })

  // ------------------------------------------------------------ deleteWorkspace

  describe('deleteWorkspace(id)', () => {
    it('soft-deletes the workspace and every live label, task and note under it', async () => {
      await db.workspaces.add(workspaceRow({ id: 'ws-1' }))
      await db.labels.add(labelRow({ id: 'label-1', workspace_id: 'ws-1' }))
      await db.tasks.add(taskRow({ id: 'task-1', workspace_id: 'ws-1' }))
      await db.notes.add(noteRow({ id: 'note-1', workspace_id: 'ws-1' }))
      vi.setSystemTime(new Date(T1))

      await deleteWorkspace('ws-1')

      const ws = await db.workspaces.get('ws-1')
      expect(ws).toMatchObject({ deleted: true, updated_at: T1, _dirty: 1 })
      expect(ws?.name).toBe('Seeded') // nothing but the flag and the clock moved

      for (const [table, id] of [
        [db.labels, 'label-1'],
        [db.tasks, 'task-1'],
        [db.notes, 'note-1'],
      ] as const) {
        const row = await table.get(id)
        expect(row, id).toBeDefined()
        expect(row, id).toMatchObject({ deleted: true, updated_at: T1, _dirty: 1 })
      }

      // Soft everywhere: nothing left the tables.
      expect(await db.workspaces.count()).toBe(1)
      expect(await db.labels.count()).toBe(1)
      expect(await db.tasks.count()).toBe(1)
      expect(await db.notes.count()).toBe(1)
      expect(requestPushMock).toHaveBeenCalledTimes(1)
    })

    it('leaves already-deleted children alone (no clock bump, no re-dirty)', async () => {
      await db.workspaces.add(workspaceRow({ id: 'ws-1' }))
      await db.tasks.add(taskRow({ id: 'task-gone', workspace_id: 'ws-1', deleted: true }))
      vi.setSystemTime(new Date(T1))

      await deleteWorkspace('ws-1')

      const gone = await db.tasks.get('task-gone')
      expect(gone).toMatchObject({ deleted: true, updated_at: OLD, _dirty: 0 })
    })

    it('does not touch rows of other workspaces', async () => {
      await db.workspaces.bulkAdd([workspaceRow({ id: 'ws-1' }), workspaceRow({ id: 'ws-2' })])
      await db.tasks.add(taskRow({ id: 'task-2', workspace_id: 'ws-2' }))
      await db.labels.add(labelRow({ id: 'label-2', workspace_id: 'ws-2' }))
      await db.notes.add(noteRow({ id: 'note-2', workspace_id: 'ws-2' }))
      vi.setSystemTime(new Date(T1))

      await deleteWorkspace('ws-1')

      expect(await db.workspaces.get('ws-2')).toEqual(workspaceRow({ id: 'ws-2' }))
      expect(await db.tasks.get('task-2')).toEqual(taskRow({ id: 'task-2', workspace_id: 'ws-2' }))
      expect(await db.labels.get('label-2')).toEqual(labelRow({ id: 'label-2', workspace_id: 'ws-2' }))
      expect(await db.notes.get('note-2')).toEqual(noteRow({ id: 'note-2', workspace_id: 'ws-2' }))
    })

    it('cascades to children even when the workspace row itself is absent locally', async () => {
      // Current behaviour: the workspace lookup is `if (ws)`, the child loop is
      // unconditional. Orphans under an id the cache never held are still
      // soft-deleted.
      await db.tasks.add(taskRow({ id: 'task-orphan', workspace_id: 'ws-absent' }))
      vi.setSystemTime(new Date(T1))

      await deleteWorkspace('ws-absent')

      expect(await db.workspaces.get('ws-absent')).toBeUndefined()
      expect(await db.tasks.get('task-orphan')).toMatchObject({
        deleted: true,
        updated_at: T1,
        _dirty: 1,
      })
      expect(requestPushMock).toHaveBeenCalledTimes(1)
    })
  })

  // ------------------------------------------------------------------- members

  describe('listMembers(workspaceId)', () => {
    it('reads from Dexie: filters to the given workspace and excludes soft-deleted rows', async () => {
      await db.members.bulkAdd([
        memberRow({ id: 'm-1', workspace_id: 'ws-1', member_id: 'user-1', level: 'owner' }),
        memberRow({ id: 'm-2', workspace_id: 'ws-1', member_id: 'user-2', deleted: true }),
        memberRow({ id: 'm-3', workspace_id: 'ws-2', member_id: 'user-3', level: 'owner' }),
      ])

      const rows = await listMembers('ws-1')

      expect(rows.map((m) => m.member_id)).toEqual(['user-1'])
      expect(requestPushMock).not.toHaveBeenCalled()
    })

    it('returns [] for a workspace with no member rows cached', async () => {
      expect(await listMembers('ws-empty')).toEqual([])
    })
  })

  describe('removeMember(workspaceId, memberId)', () => {
    it('soft-deletes the row matched by member_id, bumps updated_at, and queues a push with no network call', async () => {
      await db.members.add(memberRow({ id: 'm-1', workspace_id: 'ws-1', member_id: 'user-1' }))
      vi.setSystemTime(new Date(T1))

      await removeMember('ws-1', 'user-1')

      const row = await db.members.get('m-1')
      expect(row).toMatchObject({ deleted: true, updated_at: T1, _dirty: 1 })
      expect(requestPushMock).toHaveBeenCalledTimes(1)
      // Same discipline as the fetch stub above: had this reached the network,
      // the stub would have thrown instead of letting the call return quietly.
      expect(fetch).not.toHaveBeenCalled()
    })

    it('matches by the person id (member_id), not the row\'s own surrogate id', async () => {
      await db.members.add(memberRow({ id: 'row-surrogate', workspace_id: 'ws-1', member_id: 'user-1' }))

      await removeMember('ws-1', 'row-surrogate')

      // 'row-surrogate' is not anyone's member_id here, so nothing matches.
      expect((await db.members.get('row-surrogate'))?.deleted).toBe(false)
    })

    it('is a no-op when memberId does not match a row in that workspace, but still queues a push', async () => {
      await db.members.add(memberRow({ id: 'm-1', workspace_id: 'ws-2', member_id: 'user-1' }))

      await removeMember('ws-1', 'user-1')

      expect((await db.members.get('m-1'))?.deleted).toBe(false)
      expect(requestPushMock).toHaveBeenCalledTimes(1)
    })
  })

  // ---------------------------------------------------------------- instance admin

  describe('isAdmin() / refreshIsAdmin() — the is-admin meta cache (T033, D-17)', () => {
    it('isAdmin() reads false when nothing has been cached yet', async () => {
      expect(await isAdmin()).toBe(false)
      expect(isAdminRemoteMock).not.toHaveBeenCalled()
    })

    it('refreshIsAdmin() calls isAdminRemote(), writes the result to meta, and isAdmin() then reads it back', async () => {
      isAdminRemoteMock.mockResolvedValueOnce(true)

      const result = await refreshIsAdmin()

      expect(result).toBe(true)
      expect(isAdminRemoteMock).toHaveBeenCalledTimes(1)
      expect(await isAdmin()).toBe(true)
    })

    it('refreshIsAdmin() overwrites a stale cached value with a fresh false', async () => {
      await db.meta.put({ key: 'is-admin', value: 'true' })
      isAdminRemoteMock.mockResolvedValueOnce(false)

      await refreshIsAdmin()

      expect(await isAdmin()).toBe(false)
    })

    it('wipeLocal() clears the cache back to absent, and isAdmin() reads false again', async () => {
      await db.meta.put({ key: 'is-admin', value: 'true' })

      await wipeLocal()

      expect(await db.meta.get('is-admin')).toBeUndefined()
      expect(await isAdmin()).toBe(false)
    })
  })

  // ----------------------------------------------------------------- updateTask

  describe('updateTask(id, patch)', () => {
    it('merges the patch over the row, bumps updated_at, dirties, and preserves untouched fields', async () => {
      await db.tasks.add(taskRow({ id: 'task-1' }))
      vi.setSystemTime(new Date(T1))

      await updateTask('task-1', { title: 'Renamed', done: true })

      const row = await db.tasks.get('task-1')
      expect(row).toEqual({
        ...taskRow({ id: 'task-1' }),
        title: 'Renamed',
        done: true,
        updated_at: T1,
        _dirty: 1,
      })
      expect(requestPushMock).toHaveBeenCalledTimes(1)
    })

    it('does not trim, default or otherwise normalise a patched title', async () => {
      // Unlike createTask, updateTask writes the patch verbatim.
      await db.tasks.add(taskRow({ id: 'task-1' }))

      await updateTask('task-1', { title: '   ' })

      expect((await db.tasks.get('task-1'))?.title).toBe('   ')
    })

    it('replaces array fields wholesale (label_ids, custom_fields) rather than merging them', async () => {
      await db.tasks.add(taskRow({ id: 'task-1' }))

      await updateTask('task-1', { label_ids: ['label-y'], custom_fields: [] })

      const row = await db.tasks.get('task-1')
      expect(row?.label_ids).toEqual(['label-y'])
      expect(row?.custom_fields).toEqual([])
    })

    it('round-trips assignee through TaskPatch: set it, then clear it back to null', async () => {
      await db.tasks.add(taskRow({ id: 'task-1' }))

      await updateTask('task-1', { assignee: 'user-1' })
      expect((await db.tasks.get('task-1'))?.assignee).toBe('user-1')

      await updateTask('task-1', { assignee: null })
      expect((await db.tasks.get('task-1'))?.assignee).toBeNull()
    })

    it('keeps position when the task stays in its day column', async () => {
      await db.tasks.add(taskRow({ id: 'task-1', due_date: '2026-03-10', position: 4000 }))

      await updateTask('task-1', { description: 'still 2026-03-10' })

      expect((await db.tasks.get('task-1'))?.position).toBe(4000)
    })

    it('moves the task to the end of the new day column when taskDate() changes', async () => {
      await db.tasks.bulkAdd([
        taskRow({ id: 'task-1', due_date: '2026-03-10', position: 4000 }),
        taskRow({ id: 'task-in-target', due_date: '2026-03-11', position: 7000 }),
        taskRow({ id: 'task-deleted-in-target', due_date: '2026-03-11', position: 99000, deleted: true }),
      ])

      await updateTask('task-1', { due_date: '2026-03-11' })

      // max(live positions in the 2026-03-11 column) + POS_STEP; the deleted
      // row at 99000 is filtered out by listTasks.
      expect((await db.tasks.get('task-1'))?.position).toBe(8000)
    })

    it('reads the column through taskDate(): a start_date move relocates a task with no deadline', async () => {
      await db.tasks.add(taskRow({ id: 'task-1', start_date: '2026-03-10', due_date: null, position: 4000 }))

      await updateTask('task-1', { start_date: '2026-03-12' })

      // Empty target column: max(0) + POS_STEP.
      expect((await db.tasks.get('task-1'))?.position).toBe(1000)
    })

    it('leaves a task with a deadline where it is when only start_date changes', async () => {
      await db.tasks.add(
        taskRow({ id: 'task-1', start_date: '2026-03-01', due_date: '2026-03-10', position: 4000 }),
      )

      await updateTask('task-1', { start_date: '2026-03-05' })

      expect((await db.tasks.get('task-1'))?.position).toBe(4000)
    })

    it('is a no-op on an unknown id, but still queues a push', async () => {
      await updateTask('task-missing', { title: 'x' })

      expect(await db.tasks.count()).toBe(0)
      expect(requestPushMock).toHaveBeenCalledTimes(1)
    })

    it('createTask + updateTask round-trip: a freshly created row keeps its birth fields under a patch', async () => {
      const wsId = await createWorkspace('WS')
      const id = await createTask(wsId, { title: '  New  ', due_date: '2026-03-10' })
      requestPushMock.mockClear()
      vi.setSystemTime(new Date(T1))

      await updateTask(id, { muted: true })

      const row = await db.tasks.get(id)
      expect(row).toMatchObject({
        id,
        workspace_id: wsId,
        title: 'New', // createTask trimmed it; updateTask did not touch it
        description: '',
        due_date: '2026-03-10',
        start_date: null,
        done: false,
        remind_days_before: null,
        muted: true,
        note_id: null,
        position: 1000,
        label_ids: [],
        custom_fields: [],
        gcal: null,
        gcal_placed: null,
        created_at: T0,
        updated_at: T1,
        deleted: false,
        _dirty: 1,
      })
      expect(requestPushMock).toHaveBeenCalledTimes(1)
    })
  })

  // ------------------------------------------------------------- listWorkspaces

  describe('listWorkspaces()', () => {
    it('returns live rows ordered by position and excludes soft-deleted ones', async () => {
      await db.workspaces.bulkAdd([
        workspaceRow({ id: 'ws-c', position: 3000 }),
        workspaceRow({ id: 'ws-gone', position: 500, deleted: true }),
        workspaceRow({ id: 'ws-a', position: 1000 }),
        workspaceRow({ id: 'ws-b', position: 2000 }),
      ])

      const rows = await listWorkspaces()

      expect(rows.map((w) => w.id)).toEqual(['ws-a', 'ws-b', 'ws-c'])
    })

    it('returns the local rows as stored, `_dirty` flag included', async () => {
      // The return type is Workspace[], but the value is the Dexie row; the
      // local-only flag is not stripped on the way to the UI.
      await db.workspaces.add(workspaceRow({ id: 'ws-a', _dirty: 1 }))

      const rows = await listWorkspaces()

      expect(rows).toEqual([workspaceRow({ id: 'ws-a', _dirty: 1 })])
    })

    it('does not queue a push and returns [] on an empty cache', async () => {
      expect(await listWorkspaces()).toEqual([])
      expect(requestPushMock).not.toHaveBeenCalled()
    })
  })
})
