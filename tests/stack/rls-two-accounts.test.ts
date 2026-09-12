import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clientFor, createTestUser, deleteTestUser, type TestUser } from '../harness/accounts'
import { assertStackReachable } from '../harness/stack'

/*
 * US3 (spec.md) — pins the read/write asymmetry at ARCHITECTURE.md §3 L243-262
 * (`schema.sql:241` workspaces read+write both `auth.uid() = user_id`;
 * `schema.sql:248` labels/tasks/notes read `auth.uid() = user_id` alone;
 * `schema.sql:249-253` labels/tasks/notes write additionally requires the
 * target workspace to belong to the same `auth.uid()`). docs/validation-map.md
 * lines 124-138 (the 2026-09-12 foundations-pass correction) is the reason
 * this file exists: the predicates are NOT the same expression twice, and a
 * P1 membership rewrite that pastes one predicate into both halves would
 * silently change the security model. plan.md D-3/D-6: two independently
 * constructed, non-persisting supabase-js clients (never the app singleton)
 * hold sessions A and B at once so RLS is observed at the API layer used by
 * the real client, not by direct Postgres inspection.
 *
 * SC-008 direction-catching map (T018, acceptance 4):
 *
 *   Direction 1 — tightening the READ half to match the WRITE half (i.e.
 *   requiring the target workspace to be yours before a row is even visible,
 *   not just before it can be written):
 *     BROKEN BY -> "B still sees the orphan task that points at A's
 *     workspace" (below). That task is B's own row (`user_id` = B) but its
 *     `workspace_id` points at a workspace B does not own — exactly the
 *     "not-yet-synced workspace must not hide your own rows" case
 *     (schema.sql:226-228). Read-tightened, this row would vanish from B's
 *     select and the assertion fails.
 *
 *   Direction 2 — loosening the WRITE half to match the READ half (i.e.
 *   dropping the workspace-ownership `exists` clause and checking only
 *   `auth.uid() = user_id`, same as reads):
 *     BROKEN BY -> "B's insert into A's workspace is refused" (below). Write-
 *     loosened, nothing stops B from inserting a task whose `workspace_id` is
 *     A's; the insert would succeed instead of erroring and the assertion
 *     fails.
 *
 * Both directions were reasoned from the deployed predicates themselves
 * (`schema.sql:238-254`; confirmed present via
 * `tests/stack/schema-apply.test.ts`'s own_rows/trigger checks): swapping
 * either half, live, requires re-running the `own_rows` policy DDL for
 * `tasks` against the shared local Postgres. That live mutation was
 * attempted (a raw `client.query(...)` against 127.0.0.1:54322, never a
 * change to `supabase/*.sql` or any repo file) and was refused by this
 * environment's own tool-safety classifier as a live security-policy
 * change — a stricter boundary than this task's own "never touch src/ or
 * supabase/" rule. Recorded here rather than routed around: the two
 * assertions above were traced by hand against the exact predicates at
 * `schema.sql:241` (workspaces, read=write) and `schema.sql:248-253`
 * (labels/tasks/notes, read loose / write strict) instead of an executed
 * mutation. If a maintainer with permission to alter live RLS policy wants
 * the executed version, swap each half of `tasks.own_rows` in turn, rerun
 * `npx vitest run tests/stack/rls-two-accounts.test.ts`, and restore with
 * `applySchema()` (idempotent).
 */

let userA: TestUser
let userB: TestUser
let wsA: string
let wsB: string

beforeAll(async () => {
  await assertStackReachable()
  userA = await createTestUser('rls-a')
  userB = await createTestUser('rls-b')
}, 60_000)

afterAll(async () => {
  // Cascades (auth.users -> workspaces/labels/tasks/notes, `on delete
  // cascade`) take the rows this file created with them.
  await deleteTestUser(userA)
  await deleteTestUser(userB)
})

describe('RLS read/write asymmetry, two accounts (T017-T018)', () => {
  it("seeds A's own workspace and task", async () => {
    const clientA = await clientFor(userA)
    wsA = randomUUID()
    const { error: wsErr } = await clientA
      .from('workspaces')
      .insert({ id: wsA, user_id: userA.user.id, name: 'A workspace' })
    expect(wsErr).toBeNull()

    const { error: taskErr } = await clientA
      .from('tasks')
      .insert({ id: randomUUID(), user_id: userA.user.id, workspace_id: wsA, title: "A's task" })
    expect(taskErr).toBeNull()
  })

  it("acceptance 1 — B lists A's rows and gets an empty result, not an error", async () => {
    const clientB = await clientFor(userB)

    const { data: workspaces, error: wsErr } = await clientB.from('workspaces').select('*')
    expect(wsErr).toBeNull()
    expect(workspaces).toEqual([])

    const { data: tasks, error: taskErr } = await clientB.from('tasks').select('*')
    expect(taskErr).toBeNull()
    expect(tasks).toEqual([])
  })

  it("acceptance 2 — B's insert into A's workspace id is refused", async () => {
    const clientB = await clientFor(userB)
    const { data, error } = await clientB
      .from('tasks')
      .insert({ id: randomUUID(), user_id: userB.user.id, workspace_id: wsA, title: "B's task in A's workspace" })
      .select()

    expect(error).not.toBeNull()
    expect(data).toBeNull()
  })

  it("acceptance 3 — B's insert into B's own workspace succeeds", async () => {
    const clientB = await clientFor(userB)
    wsB = randomUUID()
    const { error: wsErr } = await clientB
      .from('workspaces')
      .insert({ id: wsB, user_id: userB.user.id, name: 'B workspace' })
    expect(wsErr).toBeNull()

    const { data, error } = await clientB
      .from('tasks')
      .insert({ id: randomUUID(), user_id: userB.user.id, workspace_id: wsB, title: "B's own task" })
      .select()

    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  })

  it(
    'acceptance 4 — B still sees a row of B\'s own that points at a workspace B does not own ' +
      '(pins the read half staying loose; direction 1 above)',
    async () => {
      const clientB = await clientFor(userB)

      // Simulates a row that arrived (e.g. by sync, before its workspace
      // synced) rather than one that could pass B's own insert check above:
      // seeded directly against the running stack, not through the anon
      // client, so it exists regardless of the write-side policy.
      const { Client } = await import('pg')
      const { DB_URL } = await import('../harness/stack')
      const pg = new Client({ connectionString: DB_URL })
      await pg.connect()
      const orphanTaskId = randomUUID()
      try {
        await pg.query(
          'insert into public.tasks (id, user_id, workspace_id, title) values ($1, $2, $3, $4)',
          [orphanTaskId, userB.user.id, wsA, "B's row pointing at A's workspace"],
        )
      } finally {
        await pg.end()
      }

      const { data, error } = await clientB.from('tasks').select('*').eq('id', orphanTaskId)
      expect(error).toBeNull()
      expect(data).toHaveLength(1)
      expect(data?.[0]?.workspace_id).toBe(wsA)
    },
  )
})
