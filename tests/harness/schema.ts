// Ordered SQL apply against the local stack's Postgres (plan.md D-1).
//
// The CLI's `db reset` reads `supabase/migrations/`, which this repo does not
// have — upstream's migrations sit at `supabase/migration-00N-*.sql` in the
// package root (plan.md F-4). Making `db reset` work would mean moving or
// duplicating that SQL, which is exactly what spec FR-002 forbids. So this
// reads the files from their existing location with a plain `pg` client and
// applies them in the one order that matters, instead.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Client } from 'pg'
import { DB_URL } from './stack'

/** Exact apply order (plan.md D-1). Every file is written idempotent. */
const SQL_FILES = [
  'schema.sql',
  'migration-002-note-link-and-mute.sql',
  'migration-003-synced-at.sql',
  'migration-004-gcal.sql',
  'migration-005-gcal-placed.sql',
  'migration-006-lww-and-ownership.sql',
] as const

const SUPABASE_DIR = path.resolve(__dirname, '../../supabase')

/**
 * Connects to the local Postgres and runs each file in `SQL_FILES`, in
 * order. Re-running on an already-seeded stack is safe — the files are
 * idempotent (`create or replace`, `if not exists`, `drop ... if exists`).
 * On failure the thrown error names the file and carries the original
 * Postgres error.
 */
export async function applySchema(): Promise<void> {
  const client = new Client({ connectionString: DB_URL })
  await client.connect()
  try {
    for (const file of SQL_FILES) {
      const sql = readFileSync(path.join(SUPABASE_DIR, file), 'utf8')
      try {
        await client.query(sql)
      } catch (err) {
        throw new Error(`Applying ${file} failed: ${(err as Error).message}`, { cause: err })
      }
    }
  } finally {
    await client.end()
  }
}
