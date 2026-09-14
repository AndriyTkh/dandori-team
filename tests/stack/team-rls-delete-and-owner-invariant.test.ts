// T023a subtask (A-013) — the schema-lane review's findings 1-5 (receipts.md "Schema lane
// review — 67a56d8..c5fda53"), pinned as executed evidence rather than left as prose findings.
//
// RED AT c5fda53, for five distinct, named reasons (cases a-d, f below) — this file is written
// against the FIX (`contracts/policies.sql`/`supabase/schema.sql` as T023a edits them), not
// against c5fda53's deployed schema, and is run once before that edit lands (to confirm the red
// is the claimed red, for the claimed reason) and once after (to confirm green):
//   (a) finding 1 — `workspaces_access for all`'s widened `using` also widens DELETE: at c5fda53
//       a member's hard-DELETE of the team workspace SUCCEEDS (cascades away labels/tasks/
//       notes/members). Fixed by splitting into `workspaces_select/insert/update/delete`, the
//       last carrying `using (auth.uid() = user_id)` alone (FR-005/FR-006).
//   (b) finding 2 — same shape on `members_access`: at c5fda53 a member's hard-DELETE of any
//       membership row, owner's included, SUCCEEDS. Fixed the same way: `members_delete for
//       delete using (public.is_owner(workspace_id))`.
//   (c) finding 3 — `PATCH workspaces {user_id: self}` passes both halves at c5fda53 (WITH CHECK
//       is `auth.uid() = user_id`, and a member setting `user_id` to their own id trivially
//       satisfies it) — a creator hijack. Fixed by installing `workspaces_zz_keep_creator`
//       (`new.user_id := old.user_id`, BEFORE UPDATE), so by the time WITH CHECK runs the
//       injected value is already reverted and the check fails on the real mismatch.
//   (d) finding 4 (FR-010) — nothing today refuses a sole owner soft-deleting or demoting
//       themselves, or promoting/transferring another member to `level = 'owner'`. Fixed by
//       `members_zz_owner_invariant` (new trigger), raising `DA016` for each.
//   (f) finding 5 — `_create_login_impl` is revoked from `public` only at c5fda53; Supabase's
//       default privileges leave `anon`/`authenticated` still holding EXECUTE, so the guarded
//       body (`is_admin()`) is reached and answers `DA001`, not the intended `42501` privilege
//       refusal a caller with no route to this function at all should get. Fixed by revoking
//       from `public, anon, authenticated` explicitly.
//   (e) is NOT part of the red: it pins three exemptions the new `members_zz_owner_invariant`
//       trigger must not break, all already true at c5fda53 (there is no such trigger there to
//       break them) and required to stay true once it lands — kind-switch purge (team->personal,
//       mirroring `kind-switch.test.ts` (a)/(c)), owner hard-DELETE-of-workspace cascade, and an
//       ordinary owner soft-delete of the workspace itself (children still soft-cascade via the
//       unchanged `follow_workspace_delete`).
//
// Seeding: `seedTeamWorkspace` (tests/harness/seed.ts) for every workspace below, per the
// dispatch — it drives the real `createWorkspace` -> flush -> kind-flip -> `add_member_by_email`
// path, not a raw insert, so what this file exercises RLS against is a workspace that reached
// `kind = 'team'` and its `members` rows exactly the way the app and the RPC surface produce
// them. Each lettered case gets its OWN workspace (never shared) so a hard-DELETE or a
// FK-cascade in one case cannot starve or contaminate another's fixture. Verification reads that
// must not go through RLS (confirming a row is/isn't there, reading `pg_policies`-adjacent
// state) use a direct `pg` client, exactly as every other stack test in this suite does.
//
// Deviation (recorded again in the receipt): the dispatch's case (c) names its control as
// "member PATCH of `name` succeeds." That contradicts FR-005 and `team-rls-both-halves.test.ts`
// ("write half — B (a member, not the owner) cannot rename the team workspace; the write stays
// owner-only") — `workspaces_update`'s WITH CHECK is owner-only, unwidened by this fix, so NO
// member write to `workspaces` ever succeeds, `name` included. The control implemented below is
// the owner's own ordinary rename of the same workspace succeeding instead — proving the split
// `workspaces_update` policy still admits a legitimate write, not just that it correctly refuses
// bad ones — which is the discriminating purpose a "positive control" serves here.
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, asUser, createTestUsers, deleteTestUser, type TestUser } from '../harness/accounts'
import { ANON_KEY, API_URL, assertStackReachable, DB_URL } from '../harness/stack'
import { seedTeamWorkspace } from '../harness/seed'

async function pg(): Promise<Client> {
  const client = new Client({ connectionString: DB_URL })
  await client.connect()
  return client
}

async function runSql<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await pg()
  try {
    const res = await client.query(sql, params)
    return res.rows as T[]
  } finally {
    await client.end()
  }
}

async function workspaceExists(id: string): Promise<boolean> {
  const rows = await runSql('select 1 from public.workspaces where id = $1', [id])
  return rows.length === 1
}

async function memberRow(
  workspaceId: string,
  memberId: string,
): Promise<{ id: string; level: string; deleted: boolean; user_id: string } | null> {
  const rows = await runSql<{ id: string; level: string; deleted: boolean; user_id: string }>(
    `select id, level, deleted, user_id from public.members where workspace_id = $1 and member_id = $2`,
    [workspaceId, memberId],
  )
  return rows[0] ?? null
}

async function countMembers(workspaceId: string): Promise<number> {
  const rows = await runSql<{ n: number }>(
    'select count(*)::int as n from public.members where workspace_id = $1',
    [workspaceId],
  )
  return rows[0]!.n
}

let owner: TestUser
let memberA: TestUser
let memberB: TestUser

beforeAll(async () => {
  await assertStackReachable()
  ;[owner, memberA, memberB] = await createTestUsers(3, 't023a')
}, 60_000)

afterAll(async () => {
  for (const u of [owner, memberA, memberB]) {
    if (u) await deleteTestUser(u)
  }
})

describe('T023a — RLS delete reachability + FR-010 owner invariant (schema lane review findings 1-5)', () => {
  describe('(a) finding 1 — member cannot hard-DELETE the team workspace; owner still can', () => {
    let wsId: string

    beforeAll(async () => {
      ;({ workspaceId: wsId } = await seedTeamWorkspace(owner, [memberA]))
    }, 30_000)

    it("member's hard-DELETE of the workspace affects 0 rows; the workspace is still there via the owner", async () => {
      const clientMember = await asUser(memberA)
      const { data, error } = await clientMember.from('workspaces').delete().eq('id', wsId).select()

      // A refused DELETE with a non-matching USING clause is a silent 0-row success in
      // PostgREST (no SQLSTATE), not a 42501 — the same shape asserted for the analogous
      // `workspaces` write-half case in team-rls-both-halves.test.ts.
      expect(error).toBeNull()
      expect(data).toEqual([])
      expect(await workspaceExists(wsId)).toBe(true)

      const clientOwner = await asUser(owner)
      const { data: seenByOwner, error: ownerReadErr } = await clientOwner
        .from('workspaces')
        .select('id')
        .eq('id', wsId)
      expect(ownerReadErr).toBeNull()
      expect(seenByOwner).toHaveLength(1)
    })

    it('control — the owner can still hard-DELETE their own team workspace (FR-006 unaffected)', async () => {
      const clientOwner = await asUser(owner)
      const { data, error } = await clientOwner.from('workspaces').delete().eq('id', wsId).select()
      expect(error).toBeNull()
      expect(data).toHaveLength(1)
      expect(await workspaceExists(wsId)).toBe(false)
    })
  })

  describe('(b) finding 2 — member cannot hard-DELETE any `members` row; owner still can', () => {
    let wsId: string

    beforeAll(async () => {
      ;({ workspaceId: wsId } = await seedTeamWorkspace(owner, [memberA, memberB]))
    }, 30_000)

    it("member's hard-DELETE of the owner's own membership row affects 0 rows", async () => {
      const ownerRow = await memberRow(wsId, owner.user.id)
      expect(ownerRow).not.toBeNull()

      const clientMemberA = await asUser(memberA)
      const { data, error } = await clientMemberA.from('members').delete().eq('id', ownerRow!.id).select()
      expect(error).toBeNull()
      expect(data).toEqual([])
      expect(await memberRow(wsId, owner.user.id)).not.toBeNull()
    })

    it("member's hard-DELETE of another member's row affects 0 rows", async () => {
      const targetRow = await memberRow(wsId, memberB.user.id)
      expect(targetRow).not.toBeNull()

      const clientMemberA = await asUser(memberA)
      const { data, error } = await clientMemberA.from('members').delete().eq('id', targetRow!.id).select()
      expect(error).toBeNull()
      expect(data).toEqual([])
      expect(await memberRow(wsId, memberB.user.id)).not.toBeNull()
    })

    it('control — the owner can hard-DELETE a plain member row (FR-015 unaffected)', async () => {
      const targetRow = await memberRow(wsId, memberB.user.id)
      expect(targetRow).not.toBeNull()

      const clientOwner = await asUser(owner)
      const { data, error } = await clientOwner.from('members').delete().eq('id', targetRow!.id).select()
      expect(error).toBeNull()
      expect(data).toHaveLength(1)
      expect(await memberRow(wsId, memberB.user.id)).toBeNull()
    })
  })

  describe('(c) finding 3 — creator hijack via `PATCH workspaces {user_id: self}` is neutralized', () => {
    let wsId: string

    beforeAll(async () => {
      ;({ workspaceId: wsId } = await seedTeamWorkspace(owner, [memberA]))
    }, 30_000)

    it("member's PATCH of user_id to their own id leaves user_id unchanged (refused, or reverted by keep_creator before WITH CHECK)", async () => {
      const clientMember = await asUser(memberA)
      const { data, error } = await clientMember
        .from('workspaces')
        .update({ user_id: memberA.user.id })
        .eq('id', wsId)
        .select()

      // Either shape is acceptable evidence of the fix: WITH CHECK rejects the row outright
      // (42501, nothing written) once keep_creator has reverted user_id to the owner's, or
      // (if a future rewrite ever let the write proceed) the row still reads back with the
      // owner's id. What must NOT happen is what happened at c5fda53: a clean 200 with
      // user_id == memberA.
      if (error === null) {
        expect((data?.[0] as Record<string, unknown> | undefined)?.user_id).toBe(owner.user.id)
      } else {
        expect(error.code).toBe('42501')
      }

      const rows = await runSql<{ user_id: string }>('select user_id from public.workspaces where id = $1', [wsId])
      expect(rows[0]!.user_id).toBe(owner.user.id)
    })

    it('control — the owner can still rename this workspace (the split write half admits a legitimate write)', async () => {
      const clientOwner = await asUser(owner)
      const { data, error } = await clientOwner
        .from('workspaces')
        .update({ name: 'renamed by owner after T023a' })
        .eq('id', wsId)
        .select()
      expect(error).toBeNull()
      expect(data).toHaveLength(1)
      expect(data?.[0]?.name).toBe('renamed by owner after T023a')
    })
  })

  describe('(d) finding 4 (FR-010) — the sole owner cannot strip, demote or transfer their own ownership', () => {
    // Each case below seeds its OWN fresh workspace, deliberately not shared across the five
    // `it`s the way (a)/(b)/(c) share one: at c5fda53 (pre-fix) every one of these writes
    // actually SUCCEEDS — that is the whole point of the red run — and a shared `wsId` would
    // let case 1's successful self-soft-delete (owner row now `deleted`) silently corrupt
    // `is_owner()`/`is_member()` for every case after it (both read `not m.deleted`), turning
    // cases 2-5's reds into an artifact of case 1's mutation rather than each independently
    // demonstrating its own named exploit. Costs four extra `seedTeamWorkspace` calls; buys one
    // clean, attributable reason per case, at c5fda53 and after the fix alike.

    it('owner soft-deleting their own owner row is refused (DA016)', async () => {
      const { workspaceId: wsId } = await seedTeamWorkspace(owner, [memberA])
      const ownerRow = await memberRow(wsId, owner.user.id)
      const clientOwner = await asUser(owner)
      const { data, error } = await clientOwner
        .from('members')
        .update({ deleted: true })
        .eq('id', ownerRow!.id)
        .select()
      expect(error).not.toBeNull()
      expect(error?.code).toBe('DA016')
      expect(data).toBeNull()
      expect((await memberRow(wsId, owner.user.id))?.deleted).toBe(false)
    })

    it("owner demoting themselves to 'member' is refused (DA016)", async () => {
      const { workspaceId: wsId } = await seedTeamWorkspace(owner, [memberA])
      const ownerRow = await memberRow(wsId, owner.user.id)
      const clientOwner = await asUser(owner)
      const { data, error } = await clientOwner
        .from('members')
        .update({ level: 'member' })
        .eq('id', ownerRow!.id)
        .select()
      expect(error).not.toBeNull()
      expect(error?.code).toBe('DA016')
      expect(data).toBeNull()
      expect((await memberRow(wsId, owner.user.id))?.level).toBe('owner')
    })

    it("owner promoting another member to 'owner' by UPDATE is refused (DA016) — no transfer in P1", async () => {
      const { workspaceId: wsId } = await seedTeamWorkspace(owner, [memberA])
      const targetRow = await memberRow(wsId, memberA.user.id)
      const clientOwner = await asUser(owner)
      const { data, error } = await clientOwner
        .from('members')
        .update({ level: 'owner' })
        .eq('id', targetRow!.id)
        .select()
      expect(error).not.toBeNull()
      expect(error?.code).toBe('DA016')
      expect(data).toBeNull()
      expect((await memberRow(wsId, memberA.user.id))?.level).toBe('member')
    })

    it("owner INSERTing a brand-new row for another member at level='owner' is refused (DA016) — no promote on add", async () => {
      const { workspaceId: wsId } = await seedTeamWorkspace(owner, [memberA])
      const clientOwner = await asUser(owner)
      const { data, error } = await clientOwner
        .from('members')
        .insert({
          id: randomUUID(),
          user_id: owner.user.id,
          workspace_id: wsId,
          member_id: memberB.user.id,
          level: 'owner',
        })
        .select()
      expect(error).not.toBeNull()
      expect(error?.code).toBe('DA016')
      expect(data).toBeNull()
      expect(await memberRow(wsId, memberB.user.id)).toBeNull()
    })

    it("control — the owner can still soft-delete a plain member's row", async () => {
      const { workspaceId: wsId } = await seedTeamWorkspace(owner, [memberA])
      const targetRow = await memberRow(wsId, memberA.user.id)
      const clientOwner = await asUser(owner)
      const { data, error } = await clientOwner
        .from('members')
        .update({ deleted: true })
        .eq('id', targetRow!.id)
        .select()
      expect(error).toBeNull()
      expect(data).toHaveLength(1)
      expect((await memberRow(wsId, memberA.user.id))?.deleted).toBe(true)
    })
  })

  describe('(e) exemptions — members_zz_owner_invariant must not block the paths that legitimately touch an owner row', () => {
    it('(e1) team -> personal kind switch still purges every live membership, owner row included (mirrors kind-switch.test.ts (a)/(c))', async () => {
      const { workspaceId: wsId } = await seedTeamWorkspace(owner, [memberA])
      const clientOwner = await asUser(owner)

      const [{ updated_at }] = await runSql<{ updated_at: Date }>(
        'select updated_at from public.workspaces where id = $1',
        [wsId],
      )
      const outranking = new Date(updated_at.getTime() + 5_000).toISOString()

      const { error } = await clientOwner
        .from('workspaces')
        .update({ kind: 'personal', updated_at: outranking })
        .eq('id', wsId)
      expect(error).toBeNull() // the invariant trigger must not raise here

      const ownerRow = await memberRow(wsId, owner.user.id)
      const memberARow = await memberRow(wsId, memberA.user.id)
      expect(ownerRow?.deleted).toBe(true)
      expect(memberARow?.deleted).toBe(true)
    })

    it('(e2) owner hard-DELETE of the team workspace still cascades away every members row, owner row included', async () => {
      const { workspaceId: wsId } = await seedTeamWorkspace(owner, [memberA])
      expect(await countMembers(wsId)).toBe(2)

      const clientOwner = await asUser(owner)
      const { error, data } = await clientOwner.from('workspaces').delete().eq('id', wsId).select()
      expect(error).toBeNull() // the invariant trigger must not block the FK cascade
      expect(data).toHaveLength(1)
      expect(await countMembers(wsId)).toBe(0)
    })

    it('(e3) owner soft-delete of the workspace itself still soft-cascades its children (follow_workspace_delete unaffected)', async () => {
      const { workspaceId: wsId } = await seedTeamWorkspace(owner, [memberA])
      const clientOwner = await asUser(owner)

      const taskId = randomUUID()
      const { error: taskErr } = await clientOwner
        .from('tasks')
        .insert({ id: taskId, user_id: owner.user.id, workspace_id: wsId, title: 'e3 probe' })
      expect(taskErr).toBeNull()

      const [{ updated_at }] = await runSql<{ updated_at: Date }>(
        'select updated_at from public.workspaces where id = $1',
        [wsId],
      )
      const outranking = new Date(updated_at.getTime() + 5_000).toISOString()

      const { error: delErr } = await clientOwner
        .from('workspaces')
        .update({ deleted: true, updated_at: outranking })
        .eq('id', wsId)
      expect(delErr).toBeNull() // no members write happens on this path; asserted so a future
      // regression that routes soft-delete through members cannot silently start tripping DA016

      const [{ deleted: taskDeleted }] = await runSql<{ deleted: boolean }>(
        'select deleted from public.tasks where id = $1',
        [taskId],
      )
      expect(taskDeleted).toBe(true)

      // members rows are untouched by a soft-delete of the workspace, by design (only a
      // kind-switch or a hard-delete purges membership) — asserted explicitly so this reads as
      // a documented fact, not an unfilled TODO.
      const ownerRow = await memberRow(wsId, owner.user.id)
      expect(ownerRow?.deleted).toBe(false)
    })
  })

  describe('(f) finding 5 — `_create_login_impl` is unreachable by anon (42501), not merely guarded (DA001)', () => {
    it('anon RPC call to _create_login_impl is refused with the privilege code, not the body\'s own DA001', async () => {
      const anon = createClient(API_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
      const { error } = await anon.rpc('_create_login_impl', {
        p_email: `t023a-anon-probe-${randomUUID()}@example.test`,
        p_password: randomUUID(),
        p_admin: false,
      })
      expect(error).not.toBeNull()
      expect(
        error?.code,
        `expected the privilege refusal 42501 (unreachable), got ${error?.code ?? '(none)'}: ${error?.message ?? ''}`,
      ).toBe('42501')
      expect(error?.message).toContain('permission denied for function _create_login_impl')
    })

    it('control — the admin-only front door (create_login) still works for a real instance admin, proving the tightened grant did not break the legitimate path', async () => {
      const admin = await adminClient(owner)
      const email = `t023a-admin-control-${randomUUID()}@example.test`
      const { data, error } = await admin.rpc('create_login', { email, password: randomUUID() })
      expect(error).toBeNull()
      expect(data?.[0]?.email).toBe(email)

      // Cleanup: this creates a real auth.users row outside the createTestUsers pool.
      await deleteTestUser({ user: { id: data![0].user_id } } as TestUser)
    })
  })
})
