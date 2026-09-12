import 'fake-indexeddb/auto'
import { afterEach } from 'vitest'
import { db } from '../src/db/local'

/*
 * `db` (the Dexie `dandori` database, src/db/local.ts:20-66) is a module-level
 * singleton, so every test file in this vitest process shares the same
 * fake-indexeddb-backed instance unless it is cleared between files. Emptying
 * every table after each test keeps cached rows from one file leaking into
 * the next; it does not touch schema/version handling, which Dexie still
 * drives from the unmodified source.
 */
afterEach(async () => {
  await db.workspaces.clear()
  await db.labels.clear()
  await db.tasks.clear()
  await db.notes.clear()
  await db.meta.clear()
})
