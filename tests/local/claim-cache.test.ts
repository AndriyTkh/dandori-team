import { beforeEach, describe, expect, it, vi } from 'vitest'
import { claimCache, db, getMeta, setMeta, wipeLocal } from '../../src/db/local'
import { SYNCED_TABLES } from '../../src/db/types'

/*
 * US4 (spec.md) — a device cache belongs to exactly one account.
 * Targets `claimCache`/`wipeLocal`, `src/db/local.ts:89-125` (read-only; this
 * file writes no source). ARCHITECTURE.md §3 L263-279: `meta` carries the pull
 * cursors (`synced_at:<table>`) alongside the cache owner; plan.md D-4 runs
 * Dexie against `fake-indexeddb` under jsdom, not a substitute store.
 */

const ACCOUNT_A = 'user-aaaaaaaa'
const ACCOUNT_B = 'user-bbbbbbbb'

async function seedCache(owner: string): Promise<void> {
  await setMeta('owner', owner)
  for (const table of SYNCED_TABLES) {
    await setMeta(`synced_at:${table}`, '2026-01-01T00:00:00.000Z')
  }
  await db.workspaces.add({
    id: 'ws-1',
    name: 'Test workspace',
    position: 0,
    gcal_sync: false,
    gcal: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    deleted: false,
    _dirty: 0,
  })
  await db.tasks.add({
    id: 'task-1',
    workspace_id: 'ws-1',
    title: 'Seeded task',
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
  })
}

describe('claimCache / wipeLocal (US4, Docker-free tier)', () => {
  beforeEach(() => {
    // T020: this tier proves it needs no network. A thrown fetch is the
    // hardest possible assertion — any attempted network call fails the test
    // immediately, regardless of which code path reaches for it.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('network access attempted in a Docker-free (local) test')
      }),
    )
  })

  it('acceptance 1: same-account re-claim wipes nothing and keeps cursors', async () => {
    await seedCache(ACCOUNT_A)

    await claimCache(ACCOUNT_A)

    expect(await getMeta('owner')).toBe(ACCOUNT_A)
    expect(await db.workspaces.count()).toBe(1)
    expect(await db.tasks.count()).toBe(1)
    for (const table of SYNCED_TABLES) {
      expect(await getMeta(`synced_at:${table}`)).toBe('2026-01-01T00:00:00.000Z')
    }
  })

  it('acceptance 2: a different account claim wipes all cached rows before any read, and records the new owner', async () => {
    await seedCache(ACCOUNT_A)

    await claimCache(ACCOUNT_B)

    expect(await getMeta('owner')).toBe(ACCOUNT_B)
    expect(await db.workspaces.count()).toBe(0)
    expect(await db.tasks.count()).toBe(0)
  })

  it('acceptance 3: a wipe also clears the synced_at:<table> cursors', async () => {
    await seedCache(ACCOUNT_A)

    await claimCache(ACCOUNT_B)

    for (const table of SYNCED_TABLES) {
      expect(await getMeta(`synced_at:${table}`)).toBeNull()
    }
  })

  it('acceptance 4: a fresh, unclaimed cache claims without a wipe', async () => {
    // No owner meta key at all — a build that predates the owner check, per
    // the doc comment at src/db/local.ts:98-100.
    await db.workspaces.add({
      id: 'ws-unclaimed',
      name: 'Pre-existing workspace',
      position: 0,
      gcal_sync: false,
      gcal: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      deleted: false,
      _dirty: 0,
    })

    await claimCache(ACCOUNT_A)

    expect(await getMeta('owner')).toBe(ACCOUNT_A)
    // Adopted, not wiped: the row from before the owner check survives.
    expect(await db.workspaces.count()).toBe(1)
  })

  it('T020: wipeLocal alone also makes no network call, and requires no Docker/stack access', async () => {
    await seedCache(ACCOUNT_A)

    await expect(wipeLocal()).resolves.toBeUndefined()

    expect(await db.workspaces.count()).toBe(0)
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
