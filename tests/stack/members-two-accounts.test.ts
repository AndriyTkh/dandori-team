import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asUser, createTestUsers, deleteTestUser, type TestUser } from '../harness/accounts'
import { assertStackReachable, DB_URL } from '../harness/stack'

/*
 * T010 (tasks.md) — US2 (spec.md): the owner adds and removes members by
 * email. Red-first against schema and RPCs that do not exist yet:
 * `public.members`, `public.add_member_by_email` and
 * `public.workspace_member_emails` land at T020/T024, but this file also
 * needs T022 (`workspaces_seed_owner`, for block 1's owner-row assertion)
 * and T023 (`members_access` plus the widened `workspaces`/`tasks` read
 * halves, for blocks 8 and 10).
 * Every assertion below is written against the contract as documented in
 * `contracts/rpc.md` and `plan.md` D-7/D-9/R-13, not against today's schema —
 * this file is expected to fail today (no `public.members` table, no `kind`
 * column, neither RPC exists) and to go green with no edit once T020-T024
 * land.
 *
 * Two workspaces keep the acceptance scenarios independent of one another's
 * mutations, so a later `it` never has to reason about an earlier one's
 * side effects:
 *   - `wsMain`     — never has a membership removed. Carries acceptance 1,
 *     acceptance 2 / edge case 4 (DA404, SC-010), acceptance 3's add-refusal,
 *     acceptance 6 (add-twice) and edge case 5 (owner's own email).
 *   - `wsRemoval`  — carries acceptance 3's remove-refusal, acceptance 4
 *     (removal and its two halves) and acceptance 5 (non-member listing),
 *     because those scenarios end with B removed from it.
 *
 * Error-code note (FR-008, contracts/rpc.md "Error-code register"): only
 * `add_member_by_email` is a `security definer` RPC that raises `DA001`
 * explicitly for a non-owner caller. Removing a member is *not* an RPC
 * (rpc.md "Removal is not an RPC" — it is an ordinary write to
 * `public.members`, carried by the same upsert the generic sync push uses),
 * so a non-owner's removal attempt is refused by RLS instead, with `42501`
 * (the register's own line for "any ordinary table write"). Both are "the
 * backend refuses" (US2 acceptance 3); they are refused by two different
 * mechanisms and are asserted here exactly as the register documents them —
 * never conflated, never read off message text.
 */

let userA: TestUser
let userB: TestUser
let userC: TestUser
let userD: TestUser
let wsMain: string
let wsRemoval: string
let wsBPersonal: string
let bPersonalTaskId: string

async function withPg<T>(fn: (pg: Client) => Promise<T>): Promise<T> {
  const pg = new Client({ connectionString: DB_URL })
  await pg.connect()
  try {
    return await fn(pg)
  } finally {
    await pg.end()
  }
}

/** SC-010's "0 rows anywhere" is measured, not assumed: a direct count over the pg connection. */
async function countRows(table: string): Promise<number> {
  return withPg(async (pg) => {
    const { rows } = await pg.query(`select count(*)::int as n from ${table}`)
    return rows[0].n as number
  })
}

async function membershipRow(
  ws: string,
  memberId: string,
): Promise<{ id: string; level: string; deleted: boolean } | null> {
  return withPg(async (pg) => {
    const { rows } = await pg.query(
      'select id, level, deleted from public.members where workspace_id = $1 and member_id = $2',
      [ws, memberId],
    )
    return (rows[0] as { id: string; level: string; deleted: boolean } | undefined) ?? null
  })
}

beforeAll(async () => {
  await assertStackReachable()
  ;[userA, userB, userC, userD] = await createTestUsers(4, 'members')
}, 60_000)

afterAll(async () => {
  // Defensive, ahead of the `auth.users` cascade below — not required for
  // isolation, since that cascade already covers `public.members`.
  //
  // Tolerates `public.members` not existing: this file is committed red, and before T020
  // lands the table the cleanup targets is absent. Letting a 42P01 escape here fails the
  // suite at the file level *and* skips the `deleteTestUser` calls below, leaking four
  // accounts into every later run on the same stack.
  try {
    try {
      await withPg(async (pg) => {
        const workspaceIds = [wsMain, wsRemoval, wsBPersonal].filter(Boolean)
        if (workspaceIds.length > 0) {
          await pg.query('delete from public.members where workspace_id = any($1)', [workspaceIds])
        }
      })
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code !== '42P01') throw err
    }
  } finally {
    // Cascades (auth.users -> workspaces/members/labels/tasks/notes, `on
    // delete cascade`) take the rest of what this file created with them.
    // Run regardless of the cleanup above so a non-42P01 failure there
    // cannot leak these four accounts into every later run on the stack.
    await deleteTestUser(userA)
    await deleteTestUser(userB)
    await deleteTestUser(userC)
    await deleteTestUser(userD)
  }
})

describe('Membership by email, two accounts (T010, US2)', () => {
  it("seeds A's team workspace (wsMain) — creation seeds A as owner (FR-002)", async () => {
    const clientA = await asUser(userA)
    wsMain = randomUUID()
    const { error } = await clientA
      .from('workspaces')
      .insert({ id: wsMain, user_id: userA.user.id, name: 'Team main', kind: 'team' })
    expect(error).toBeNull()

    const owner = await membershipRow(wsMain, userA.user.id)
    expect(owner).not.toBeNull()
    expect(owner?.level).toBe('owner')
    expect(owner?.deleted).toBe(false)
  })

  it('acceptance 1 — A adds B by email; B is a member and appears in the member list by email', async () => {
    const clientA = await asUser(userA)
    const { data, error } = await clientA.rpc('add_member_by_email', {
      ws: wsMain,
      email: userB.email,
    })
    expect(error).toBeNull()
    expect(data).toMatchObject({ workspace_id: wsMain, member_id: userB.user.id, level: 'member' })

    const { data: list, error: listErr } = await clientA.rpc('workspace_member_emails', {
      ws: wsMain,
    })
    expect(listErr).toBeNull()
    expect(list).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ member_id: userB.user.id, email: userB.email, level: 'member' }),
      ]),
    )
  })

  it(
    'acceptance 2 / edge case 4 — an email with no account on this origin adds nothing, ' +
      'returns DA404, and creates 0 rows anywhere (SC-010)',
    async () => {
      const clientA = await asUser(userA)
      const ghostEmail = `no-account-${randomUUID()}@example.test`

      const membersBefore = await countRows('public.members')
      const usersBefore = await countRows('auth.users')

      const { data, error } = await clientA.rpc('add_member_by_email', {
        ws: wsMain,
        email: ghostEmail,
      })

      expect(data).toBeNull()
      expect(error).not.toBeNull()
      expect(error?.code).toBe('DA404') // FR-008: asserted on error.code, never message text

      expect(await countRows('public.members')).toBe(membersBefore)
      expect(await countRows('auth.users')).toBe(usersBefore) // no phantom account either
    },
  )

  it('acceptance 3 (add) — B, a member, attempting to add anyone is refused with DA001', async () => {
    const clientB = await asUser(userB)
    const before = await countRows('public.members')

    const { data, error } = await clientB.rpc('add_member_by_email', {
      ws: wsMain,
      email: userC.email,
    })

    expect(data).toBeNull()
    expect(error).not.toBeNull()
    expect(error?.code).toBe('DA001')
    expect(await countRows('public.members')).toBe(before)
  })

  it('acceptance 6 — adding B a second time leaves exactly one membership row for B', async () => {
    const clientA = await asUser(userA)
    const { error } = await clientA.rpc('add_member_by_email', { ws: wsMain, email: userB.email })
    expect(error).toBeNull()

    const rows = await withPg(async (pg) => {
      const { rows } = await pg.query(
        'select id from public.members where workspace_id = $1 and member_id = $2',
        [wsMain, userB.user.id],
      )
      return rows
    })
    expect(rows).toHaveLength(1)

    // level and deleted are asserted too, not just "still one row" — but
    // B's row here was never deactivated, so deleted is already false and
    // this does not exercise add_member_by_email's reactivation branch
    // (contracts/rpc.md lines 38/42, `do update set deleted = false`).
    const row = await membershipRow(wsMain, userB.user.id)
    expect(row?.level).toBe('member')
    expect(row?.deleted).toBe(false)
  })

  it(
    "edge case 5 — adding the owner's own email returns the existing owner row, " +
      'never a second row and never a demotion',
    async () => {
      const clientA = await asUser(userA)
      const before = await countRows('public.members')

      const { data, error } = await clientA.rpc('add_member_by_email', {
        ws: wsMain,
        email: userA.email,
      })

      expect(error).toBeNull()
      expect(data).toMatchObject({ workspace_id: wsMain, member_id: userA.user.id, level: 'owner' })
      expect(await countRows('public.members')).toBe(before) // no second row

      // Asserted server-side, not just off the RPC's return value.
      const owner = await membershipRow(wsMain, userA.user.id)
      expect(owner?.level).toBe('owner') // never demoted to 'member'
    },
  )

  it('seeds wsRemoval (team) with B and D added, and B\'s own personal workspace', async () => {
    const clientA = await asUser(userA)
    wsRemoval = randomUUID()
    const { error: wsErr } = await clientA
      .from('workspaces')
      .insert({ id: wsRemoval, user_id: userA.user.id, name: 'Team removal', kind: 'team' })
    expect(wsErr).toBeNull()

    const { error: addBErr } = await clientA.rpc('add_member_by_email', {
      ws: wsRemoval,
      email: userB.email,
    })
    expect(addBErr).toBeNull()
    const { error: addDErr } = await clientA.rpc('add_member_by_email', {
      ws: wsRemoval,
      email: userD.email,
    })
    expect(addDErr).toBeNull()

    const { error: taskErr } = await clientA
      .from('tasks')
      .insert({ id: randomUUID(), user_id: userA.user.id, workspace_id: wsRemoval, title: 'A task in wsRemoval' })
    expect(taskErr).toBeNull()

    // B's own personal workspace, entirely unrelated to wsRemoval — seeded
    // now so acceptance 4's second half has something to check is untouched.
    const clientB = await asUser(userB)
    wsBPersonal = randomUUID()
    const { error: bWsErr } = await clientB
      .from('workspaces')
      .insert({ id: wsBPersonal, user_id: userB.user.id, name: "B's own workspace" })
    expect(bWsErr).toBeNull()
    bPersonalTaskId = randomUUID()
    const { error: bTaskErr } = await clientB
      .from('tasks')
      .insert({ id: bPersonalTaskId, user_id: userB.user.id, workspace_id: wsBPersonal, title: "B's own task" })
    expect(bTaskErr).toBeNull()
  })

  it(
    "acceptance 3 (remove) — B, a member, attempting to remove D is refused " +
      "(ordinary write, RLS 42501 — not the add RPC's DA001)",
    async () => {
      const clientB = await asUser(userB)
      const dRow = await membershipRow(wsRemoval, userD.user.id)
      expect(dRow).not.toBeNull()

      const { data, error } = await clientB
        .from('members')
        .upsert(
          {
            id: dRow!.id,
            user_id: userB.user.id, // stamped by the caller, exactly as sync.ts's push does
            workspace_id: wsRemoval,
            member_id: userD.user.id,
            level: 'member',
            deleted: true,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'id' },
        )
        .select()

      expect(data).toBeNull()
      expect(error).not.toBeNull()
      expect(error?.code).toBe('42501')

      const stillThere = await membershipRow(wsRemoval, userD.user.id)
      expect(stillThere?.deleted).toBe(false)
    },
  )

  it("acceptance 5 — a non-member (C) listing wsRemoval's members receives nothing", async () => {
    const clientC = await asUser(userC)
    const { data, error } = await clientC.rpc('workspace_member_emails', { ws: wsRemoval })
    expect(error).toBeNull()
    expect(data).toEqual([])

    // Positive control: wsRemoval does return members for someone who is
    // actually in it, so the empty result above proves C's exclusion and not
    // a listing that returns [] for everyone.
    const clientA = await asUser(userA)
    const { data: asOwner, error: ownerListErr } = await clientA.rpc('workspace_member_emails', {
      ws: wsRemoval,
    })
    expect(ownerListErr).toBeNull()
    expect(asOwner?.length).toBeGreaterThan(0)
  })

  it(
    "acceptance 4 — A removes B: B's reads/writes of wsRemoval stop immediately, " +
      "and B's own personal workspaces are untouched",
    async () => {
      const clientA = await asUser(userA)
      const clientB = await asUser(userB)

      const bRow = await membershipRow(wsRemoval, userB.user.id)
      expect(bRow).not.toBeNull()

      // Sanity: B could read wsRemoval's task before removal.
      const before = await clientB.from('tasks').select('*').eq('workspace_id', wsRemoval)
      expect(before.error).toBeNull()
      expect(before.data).toHaveLength(1)

      const { error: removeErr } = await clientA
        .from('members')
        .upsert(
          {
            id: bRow!.id,
            user_id: userA.user.id, // A performs the removal, stamped as A's write
            workspace_id: wsRemoval,
            member_id: userB.user.id,
            level: 'member',
            deleted: true,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'id' },
        )
        .select()
      expect(removeErr).toBeNull()

      const { data: afterTasks, error: afterErr } = await clientB
        .from('tasks')
        .select('*')
        .eq('workspace_id', wsRemoval)
      expect(afterErr).toBeNull()
      expect(afterTasks).toEqual([])

      const { data: writeData, error: writeErr } = await clientB
        .from('tasks')
        .insert({
          id: randomUUID(),
          user_id: userB.user.id,
          workspace_id: wsRemoval,
          title: "B's write after removal",
        })
        .select()
      expect(writeData).toBeNull()
      expect(writeErr?.code).toBe('42501')

      // B's own personal workspace and its task are untouched by the removal.
      const { data: ownWs, error: ownWsErr } = await clientB
        .from('workspaces')
        .select('*')
        .eq('id', wsBPersonal)
      expect(ownWsErr).toBeNull()
      expect(ownWs).toHaveLength(1)

      const { data: ownTask, error: ownTaskErr } = await clientB
        .from('tasks')
        .select('*')
        .eq('id', bPersonalTaskId)
      expect(ownTaskErr).toBeNull()
      expect(ownTask).toHaveLength(1)

      const { data: ownWrite, error: ownWriteErr } = await clientB
        .from('tasks')
        .update({ title: "B's own task, edited after removal" })
        .eq('id', bPersonalTaskId)
        .select()
      expect(ownWriteErr).toBeNull()
      expect(ownWrite).toHaveLength(1)
      expect(ownWrite?.[0].title).toBe("B's own task, edited after removal")
    },
  )
})
