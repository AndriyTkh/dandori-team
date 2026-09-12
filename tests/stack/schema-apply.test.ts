import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applySchema } from '../harness/schema'
import { assertStackReachable, DB_URL } from '../harness/stack'

const TABLES = ['workspaces', 'labels', 'tasks', 'notes'] as const
/** Tables carrying `<t>_stay_deleted` (plan.md D-1; ARCHITECTURE §4 L379-393: workspaces has none). */
const CHILD_TABLES = ['labels', 'tasks', 'notes'] as const

let client: Client

beforeAll(async () => {
  await assertStackReachable()
  client = new Client({ connectionString: DB_URL })
  await client.connect()
}, 60_000)

afterAll(async () => {
  await client?.end()
})

describe('ordered schema apply (T007)', () => {
  it('applies schema.sql + migration-002..006 in order against a reachable stack', async () => {
    await expect(applySchema()).resolves.toBeUndefined()
  }, 60_000)

  it('is idempotent: a second apply against the same stack also succeeds', async () => {
    await expect(applySchema()).resolves.toBeUndefined()
  }, 60_000)

  it('creates all four tables', async () => {
    const { rows } = await client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_name = any($1::text[])`,
      [TABLES],
    )
    const found = rows.map((r) => r.table_name).sort()
    expect(found).toEqual([...TABLES].sort())
  })

  it('creates the own_rows policy on all four tables', async () => {
    const { rows } = await client.query<{ tablename: string }>(
      `select tablename from pg_policies
        where schemaname = 'public' and policyname = 'own_rows' and tablename = any($1::text[])`,
      [TABLES],
    )
    const found = rows.map((r) => r.tablename).sort()
    expect(found).toEqual([...TABLES].sort())
  })

  it('creates the keep_newer and synced_at triggers on all four tables', async () => {
    for (const t of TABLES) {
      const { rows } = await client.query<{ tgname: string }>(
        `select tgname from pg_trigger
          where tgrelid = ('public.' || $1)::regclass and not tgisinternal`,
        [t],
      )
      const names = rows.map((r) => r.tgname)
      expect(names).toContain(`${t}_keep_newer`)
      expect(names).toContain(`${t}_synced_at`)
    }
  })

  it('creates the stay_deleted trigger on labels, tasks and notes (not workspaces)', async () => {
    for (const t of CHILD_TABLES) {
      const { rows } = await client.query<{ tgname: string }>(
        `select tgname from pg_trigger
          where tgrelid = ('public.' || $1)::regclass and not tgisinternal`,
        [t],
      )
      expect(rows.map((r) => r.tgname)).toContain(`${t}_stay_deleted`)
    }

    const { rows: workspaceTriggers } = await client.query<{ tgname: string }>(
      `select tgname from pg_trigger where tgrelid = 'public.workspaces'::regclass and not tgisinternal`,
    )
    expect(workspaceTriggers.map((r) => r.tgname)).not.toContain('workspaces_stay_deleted')
  })
})
