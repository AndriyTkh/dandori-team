import Dexie from 'dexie'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { claimCache, db, getMeta, setMeta } from '../../src/db/local'
import { SYNCED_TABLES } from '../../src/db/types'

/*
 * SC-012 (R-9), Docker-free, both halves in one file, per D-10 (plan.md):
 *
 *   1. A device that was last on Dexie v2 must open, keep every cached row and
 *      every `meta` pull cursor, and gain a `members` store — turns green at
 *      T029 (`src/db/local.ts` adds `this.version(3)`), which itself needs
 *      T028 (`src/db/types.ts` adds `members` to `SYNCED_TABLES`/`SYNCED_COLUMNS`
 *      and the `kind`/`assignee` fields) to compile against.
 *   2. Growing what an already-claimed account can *reach* (a team workspace
 *      it is newly a member of arrives on a later pull) must not be mistaken
 *      for a *different* account: re-claiming as the same user wipes nothing;
 *      claiming as a genuinely different user still wipes everything — this
 *      half exercises `claimCache`/`wipeLocal` as they stand today
 *      (`src/db/local.ts:102-125`) and needs no source change to turn green.
 *
 * Deliberately NOT covered here: the `members` *table's* row-level content or
 * its RLS (stack-tier territory); the v1→v2 upgrade path (already covered by
 * `local-cache`'s existing evidence, unchanged by this feature); and anything
 * about *when* a pull actually arrives — "a team workspace A newly reaches" is
 * modelled directly as rows already sitting in Dexie's `workspaces`/`tasks`
 * tables between the two claims, because reach is a pull-cursor-and-RLS
 * question the local cache has no opinion on (D-10: "team mode changes what
 * one account can reach, not how many accounts a device holds").
 *
 * Assumption a later reader would otherwise have to rediscover: part 1 seeds
 * a *separate* raw `Dexie('dandori')` handle, opened and closed before the
 * real `db` (imported from `src/db/local.ts`) ever touches the database, so
 * that `db.open()` genuinely walks whatever upgrade path today's source
 * defines, rather than the seeding code and the production schema racing to
 * define the same store. Today that raw handle is declared only at
 * `version(2)` (identical stores to `src/db/local.ts`'s own `version(1)` —
 * `version(2)` changes no store or index, only backfills fields on rows that
 * already exist, so a fresh v2-shaped seed needs no separate `version(1)`
 * step). Case 1's row-count and cursor assertions are trivially green today
 * for a reason that has nothing to do with upgrade correctness: `db` is
 * already at its own current version 2, so `db.open()` runs no upgrade at
 * all. They become a real test of upgrade correctness — rather than a no-op
 * that would pass even if the upgrade were deleted — only once T029 declares
 * `version(3)` and an upgrade actually has something to do.
 *
 * The "unchanged" claim above is narrower than it sounds, and scopes to case
 * 1's *seed* only. T028 (`specs/002-team-workspaces/tasks.md:306`) makes
 * `Workspace.kind` and `Task.assignee` required, non-optional fields. Cases 2
 * and 3 build rows through the typed `EntityTable` path (`db.workspaces.add`,
 * `db.tasks.add`), so once T028 lands every row literal in those two cases
 * must gain `kind`/`assignee` or the file stops typechecking — that is a
 * required edit here, not drift to resist. Case 1's seed is the opposite: it
 * must *not* gain `kind`/`assignee`, on purpose — a genuinely v2-shaped row
 * has no `kind`, and giving the seed one would stop testing the upgrade and
 * start testing a no-op. So: once T029 lands, this file's case-1 *seed* is
 * unchanged and the same v2-shaped rows exercise a real v2→v3 upgrade; the
 * *row literals in cases 2 and 3* are not unchanged, and must be edited
 * alongside T028, as above.
 *
 * Forward note for whoever lands T028: in case 2, `ws-team-newly-reached`
 * takes `kind: 'team'` (it models a team workspace newly reached by a pull),
 * while `ws-a-own` keeps `kind: 'personal'`. Today the two differ only by
 * their `name` string — that is prose standing in for schema until T028's
 * edit makes it real; do not "fix" case 1's seed to match.
 */

const ACCOUNT_A = 'user-aaaaaaaa'
const ACCOUNT_B = 'user-bbbbbbbb'

/** The exact store/index shape of `src/db/local.ts`'s `version(2)`. */
const V2_STORES = {
  workspaces: 'id, position, _dirty',
  labels: 'id, workspace_id, _dirty',
  tasks: 'id, workspace_id, _dirty',
  notes: 'id, workspace_id, _dirty',
  meta: 'key',
}

describe('Dexie v2 -> v3 upgrade keeps every row and every cursor (R-9)', () => {
  beforeEach(() => {
    // Same Docker-free discipline as claim-cache.test.ts (T020): a network
    // call anywhere in this path is itself a defect for a Docker-free tier.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('network access attempted in a Docker-free (local) test')
      }),
    )
  })

  it('turns green at T029: upgrading a v2-shaped cache loses no row and no cursor, and gains `members`', async () => {
    // --- Arrange: a v2-shaped database, seeded and closed, standing in for
    // "a device that was last opened before this feature shipped". A second,
    // independent Dexie handle is used deliberately (see file header) so this
    // case seeds through the *same* schema shape production code used to
    // write these rows, not through the class under test.
    const seed = new Dexie('dandori')
    seed.version(2).stores(V2_STORES)
    await seed.open()

    await seed.table('meta').put({ key: 'owner', value: ACCOUNT_A })
    for (const table of SYNCED_TABLES) {
      await seed.table('meta').put({ key: `synced_at:${table}`, value: '2026-01-01T00:00:00.000Z' })
    }
    await seed.table('workspaces').add({
      id: 'ws-legacy',
      name: 'Pre-upgrade workspace',
      position: 0,
      gcal_sync: false,
      gcal: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      deleted: false,
      _dirty: 0,
    })
    await seed.table('tasks').bulkAdd([
      {
        id: 'task-legacy-1',
        workspace_id: 'ws-legacy',
        title: 'Pre-upgrade task 1',
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
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        deleted: false,
        _dirty: 0,
      },
      {
        id: 'task-legacy-2',
        workspace_id: 'ws-legacy',
        title: 'Pre-upgrade task 2',
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
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        deleted: false,
        _dirty: 0,
      },
    ])

    // Positive control: the seed actually landed, on the seeding handle,
    // before we hand the database to the class under test.
    expect(await seed.table('workspaces').count()).toBe(1)
    expect(await seed.table('tasks').count()).toBe(2)
    expect(await seed.table('meta').get('owner')).toMatchObject({ value: ACCOUNT_A })
    seed.close()

    // --- Act: open the database through the real production class. Whatever
    // versions `src/db/local.ts` defines today is what runs here — no version
    // is declared by this test.
    await db.open()

    // --- Assert: nothing lost across whatever upgrade (if any) just ran.
    expect(await db.workspaces.count()).toBe(1)
    expect(await db.tasks.count()).toBe(2)
    expect(await getMeta('owner')).toBe(ACCOUNT_A)
    for (const table of SYNCED_TABLES) {
      expect(await getMeta(`synced_at:${table}`)).toBe('2026-01-01T00:00:00.000Z')
    }

    // The named structural reason this case is red today: T028/T029 have not
    // landed, so `src/db/local.ts` defines no `version(3)` and no `members`
    // store — there is nothing yet to gain. Expected failure until T029:
    // `expect(db.tables.some((t) => t.name === 'members')).toBe(true)` ->
    // `expected false to be true`.
    expect(db.tables.some((t) => t.name === 'members')).toBe(true)

    // Pin that an upgrade actually ran, not merely that nothing broke: a
    // green run above would also happen if the file quietly reverted to
    // seeding at `version(3)` already-current with no upgrade to walk.
    expect(db.verno).toBeGreaterThan(2)

    // R-9 also requires the upgrade to *backfill* the two new fields onto
    // rows that predate them (plan.md:1260-1261), not merely add the store.
    // The legacy rows were seeded through the untyped raw handle (see file
    // header), so reading them back through the typed `db` needs a cast.
    const legacyWorkspace = (await db.workspaces.get('ws-legacy')) as unknown as {
      kind: string
    }
    expect(legacyWorkspace.kind).toBe('personal')
    const legacyTask = (await db.tasks.get('task-legacy-1')) as unknown as {
      assignee: unknown
    }
    expect(legacyTask.assignee).toBeNull()
  })
})

describe('claimCache does not mistake growing reach for a different account (SC-012, D-10)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('network access attempted in a Docker-free (local) test')
      }),
    )
  })

  it('re-claiming as the same account, after its reach has grown, wipes nothing', async () => {
    // --- Arrange: A claims a cache holding only A's own workspace.
    await claimCache(ACCOUNT_A)
    for (const table of SYNCED_TABLES) {
      await setMeta(`synced_at:${table}`, '2026-01-01T00:00:00.000Z')
    }
    await db.workspaces.add({
      id: 'ws-a-own',
      name: "A's own workspace",
      kind: 'personal',
      position: 0,
      gcal_sync: false,
      gcal: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      deleted: false,
      _dirty: 0,
    })
    await db.tasks.add({
      id: 'task-a-own',
      workspace_id: 'ws-a-own',
      title: "Task in A's own workspace",
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
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      deleted: false,
      _dirty: 0,
    })

    // --- A's reach grows: a team workspace it was newly added to, plus its
    // task, arrives on a later pull — modelled as rows simply appearing, the
    // same way a real pull would leave them (see file header).
    await db.workspaces.add({
      id: 'ws-team-newly-reached',
      name: 'Team workspace A newly reaches',
      kind: 'team',
      position: 1,
      gcal_sync: false,
      gcal: null,
      created_at: '2026-01-02T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      deleted: false,
      _dirty: 0,
    })
    await db.tasks.add({
      id: 'task-team-newly-reached',
      workspace_id: 'ws-team-newly-reached',
      title: 'Task in the newly-reached team workspace',
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
      created_at: '2026-01-02T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      deleted: false,
      _dirty: 0,
    })
    await setMeta('synced_at:workspaces', '2026-01-02T00:00:00.000Z')

    // Positive control, taken right before the re-claim: the seeded rows and
    // the just-written cursor are actually there, and actually non-zero.
    expect(await db.workspaces.count()).toBe(2)
    expect(await db.tasks.count()).toBe(2)
    expect(await getMeta('synced_at:workspaces')).toBe('2026-01-02T00:00:00.000Z')
    expect(await getMeta('owner')).toBe(ACCOUNT_A)

    // --- Act: A signs in again, now able to reach one more workspace than
    // at the first claim.
    await claimCache(ACCOUNT_A)

    // --- Assert: nothing wiped, cursors intact, owner unchanged.
    expect(await getMeta('owner')).toBe(ACCOUNT_A)
    expect(await db.workspaces.count()).toBe(2)
    expect(await db.tasks.count()).toBe(2)
    expect(await getMeta('synced_at:workspaces')).toBe('2026-01-02T00:00:00.000Z')
    for (const table of SYNCED_TABLES) {
      if (table === 'workspaces') continue
      expect(await getMeta(`synced_at:${table}`)).toBe('2026-01-01T00:00:00.000Z')
    }
  })

  it('claiming as a different account still wipes everything, reach or no reach', async () => {
    // --- Arrange: same shape as the case above — A's own workspace plus a
    // team workspace A newly reaches, and a fresh cursor.
    await claimCache(ACCOUNT_A)
    for (const table of SYNCED_TABLES) {
      await setMeta(`synced_at:${table}`, '2026-01-01T00:00:00.000Z')
    }
    await db.workspaces.bulkAdd([
      {
        id: 'ws-a-own-2',
        name: "A's own workspace",
        kind: 'personal',
        position: 0,
        gcal_sync: false,
        gcal: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        deleted: false,
        _dirty: 0,
      },
      {
        id: 'ws-team-newly-reached-2',
        name: 'Team workspace A newly reaches',
        kind: 'team',
        position: 1,
        gcal_sync: false,
        gcal: null,
        created_at: '2026-01-02T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
        deleted: false,
        _dirty: 0,
      },
    ])
    await db.tasks.add({
      id: 'task-a-own-2',
      workspace_id: 'ws-a-own-2',
      title: "Task in A's own workspace",
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
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      deleted: false,
      _dirty: 0,
    })

    // Positive control: the seed landed before B claims the cache — a task
    // row too, so the zero-count assertion below measures a real transition
    // rather than asserting 0 against a table that was already 0.
    expect(await db.workspaces.count()).toBe(2)
    expect(await db.tasks.count()).toBe(1)
    for (const table of SYNCED_TABLES) {
      expect(await getMeta(`synced_at:${table}`)).toBe('2026-01-01T00:00:00.000Z')
    }

    // --- Act: a genuinely different account claims the same device.
    await claimCache(ACCOUNT_B)

    // --- Assert: the wipe fires — every row and every cursor is gone.
    expect(await getMeta('owner')).toBe(ACCOUNT_B)
    expect(await db.workspaces.count()).toBe(0)
    expect(await db.tasks.count()).toBe(0)
    for (const table of SYNCED_TABLES) {
      expect(await getMeta(`synced_at:${table}`)).toBeNull()
    }
  })
})
