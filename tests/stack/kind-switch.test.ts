// US8 (spec.md), FR-034-FR-036 -- the evidence that gates D-6''s trigger,
// `on_workspace_kind_change` (contracts/policies.sql fork block C;
// data-model.md §2 "Workspace kind"; plan.md D-6', D-7 correction, R-19).
//
// Red-first (T017): `workspaces.kind`, `public.members` and
// `on_workspace_kind_change` do not exist yet -- T020 (fork block A, the
// column + the table), T021 (fork block B, `is_member`/`is_owner`) and T022
// (fork block C, the trigger itself) land them. Every scenario below fails
// today for that reason, not because of a logic bug in this file, and turns
// green, unedited, once that schema lands (plan.md "Within TG-1" ordering:
// T007-T019 authored before T020-T026).
//
// `seedTeamWorkspace` (tests/harness/seed.ts, T019) and `add_member_by_email`
// (contracts/rpc.md, T024) do not exist yet either, so team workspaces and
// membership rows are seeded directly here: workspaces through the normal
// per-account supabase-js client (`clientFor`, same as every other stack
// test), and `public.members` rows through a raw `pg` client, because
// `members` gets `enable row level security` in T020's fork block A with **no
// policy** until T023 replaces the policy block -- until then nothing but a
// superuser connection can touch it at all. This file's job is the trigger
// (T020-T022), not the membership policy (T023), so it deliberately does not
// route membership reads/writes through RLS.
//
// (a) and (e) are both flagged as needing T023 as well as T020-T022:
//
// (e) exercises "a caller who is a *member* but not the owner", which only
// becomes visible under the workspaces read policy once T023 lands `using
// (... or public.is_member(id))` (contracts/policies.sql "policy block").
// Before T023, a non-owner cannot even see the row (`auth.uid() = user_id`
// alone), so the update matches zero rows and never reaches the point where
// a write-check failure could produce Postgres' `42501`. This file's (e) is
// only the member half of that refusal -- a non-member outsider reaching
// zero rows with no error at all is T016's case, not this file's, and is not
// re-asserted here.
//
// (a) needs a positive control on its "ex-member can no longer read tasks"
// claim: that otherMember could read the task *while* still a member, which
// itself only holds once T023's `tasks` read policy carries `or
// public.is_member(workspace_id)`. Without T023 the negative assertion at
// the end of (a) would be satisfied by a policy that never grants team reads
// at all, which is not what (a) is testing.
//
// T022's verify list names this whole file; (a) and (e) are the parts of it
// that need T023 too -- flagged in this file's own header rather than
// silently worked around.
//
// Cleanup: every account here is a fresh `createTestUsers` throwaway, and
// every row this file writes -- `workspaces`, `tasks`, `members` -- carries a
// `user_id` and/or `member_id` foreign key to one of those accounts with `on
// delete cascade` (contracts/policies.sql fork block A). `deleteTestUser` in
// `afterAll` takes every row this file seeded with it, the same pattern
// `rls-two-accounts.test.ts` uses. `tests/setup.ts` is a P0 file and stays
// unedited (owner decision, 2026-09-14); this file does its own teardown
// rather than relying on it, and never touches `db` (the Dexie local cache)
// at all -- everything here goes straight at the stack.
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clientFor, createTestUsers, deleteTestUser, type TestUser } from '../harness/accounts'
import { assertStackReachable, DB_URL } from '../harness/stack'

async function pgClient(): Promise<Client> {
  const client = new Client({ connectionString: DB_URL })
  await client.connect()
  return client
}

/** Runs one query against a fresh, short-lived superuser connection. */
async function runSql<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[],
): Promise<T[]> {
  const pg = await pgClient()
  try {
    const res = await pg.query(sql, params)
    return res.rows as T[]
  } finally {
    await pg.end()
  }
}

async function insertMemberRow(o: {
  workspaceId: string
  createdBy: string
  memberId: string
  level: 'owner' | 'member'
}): Promise<string> {
  const id = randomUUID()
  await runSql(
    `insert into public.members (id, user_id, workspace_id, member_id, level)
     values ($1, $2, $3, $4, $5)`,
    [id, o.createdBy, o.workspaceId, o.memberId, o.level],
  )
  return id
}

type MemberRow = {
  id: string
  member_id: string
  level: string
  deleted: boolean
  updated_at: Date
}

async function selectMembers(workspaceId: string): Promise<MemberRow[]> {
  return runSql<MemberRow>(
    `select id, member_id, level, deleted, updated_at from public.members where workspace_id = $1`,
    [workspaceId],
  )
}

async function selectOneMember(workspaceId: string, memberId: string): Promise<MemberRow[]> {
  return runSql<MemberRow>(
    `select id, member_id, level, deleted, updated_at from public.members
      where workspace_id = $1 and member_id = $2`,
    [workspaceId, memberId],
  )
}

function stamp(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString()
}

let owner: TestUser
let otherMember: TestUser

beforeAll(async () => {
  await assertStackReachable()
  ;[owner, otherMember] = await createTestUsers(2, 'kind-switch')
}, 60_000)

afterAll(async () => {
  await deleteTestUser(owner)
  await deleteTestUser(otherMember)
})

describe('kind-switch (T017): US8, FR-034-FR-036 -- gates on_workspace_kind_change', () => {
  // (a) and (b) share one workspace deliberately: (b)'s "re-creates rather
  // than duplicates" claim is only meaningful against a row that (a)'s purge
  // already soft-deleted for this exact workspace.
  let roundTripWs: string
  let originalOwnerRowId: string

  it(
    '(a) team -> personal soft-deletes every live members row, the owner included, ' +
      "and the ex-member's next select on the workspace's tasks returns nothing",
    async () => {
      const clientOwner = await clientFor(owner)
      roundTripWs = randomUUID()

      const { error: wsErr } = await clientOwner
        .from('workspaces')
        .insert({ id: roundTripWs, user_id: owner.user.id, name: 'kind-switch round trip', kind: 'team' })
      expect(wsErr).toBeNull()

      const taskId = randomUUID()
      const { error: taskErr } = await clientOwner
        .from('tasks')
        .insert({ id: taskId, user_id: owner.user.id, workspace_id: roundTripWs, title: "owner's task" })
      expect(taskErr).toBeNull()

      // `workspaces_seed_owner` (after insert, T022) is expected to have
      // already seeded the owner's own row above; capture its id so (b) can
      // later prove the same row is reused, not duplicated.
      const [ownerRowBefore] = await selectOneMember(roundTripWs, owner.user.id)
      expect(ownerRowBefore).toBeDefined()
      expect(ownerRowBefore.deleted).toBe(false)
      originalOwnerRowId = ownerRowBefore.id

      const otherMemberRowId = await insertMemberRow({
        workspaceId: roundTripWs,
        createdBy: owner.user.id,
        memberId: otherMember.user.id,
        level: 'member',
      })

      // Positive control (needs T023's `tasks` read policy, `or
      // public.is_member(workspace_id)`): otherMember really could read this
      // task while still a live member, so the negative assertion below --
      // taken after the purge -- actually shows membership loss revoking the
      // read, not merely a policy that never granted team reads at all.
      const clientExMember = await clientFor(otherMember)
      const { data: seenWhileMember, error: seenWhileMemberErr } = await clientExMember
        .from('tasks')
        .select('id')
        .eq('workspace_id', roundTripWs)
      expect(seenWhileMemberErr).toBeNull()
      expect(seenWhileMember).toHaveLength(1) // membership actually grants the read

      const { error: switchErr } = await clientOwner
        .from('workspaces')
        .update({ kind: 'personal', updated_at: stamp(5_000) })
        .eq('id', roundTripWs)
      expect(switchErr).toBeNull()

      const rowsAfter = await selectMembers(roundTripWs)
      expect(rowsAfter).toHaveLength(2)
      const ownerRowAfter = rowsAfter.find((r) => r.id === originalOwnerRowId)
      const otherMemberRowAfter = rowsAfter.find((r) => r.id === otherMemberRowId)
      expect(ownerRowAfter?.deleted).toBe(true) // the owner's own row too -- "every live row"
      expect(otherMemberRowAfter?.deleted).toBe(true)

      const { data: tasksSeenByExMember, error: exMemberErr } = await clientExMember
        .from('tasks')
        .select('*')
        .eq('workspace_id', roundTripWs)
      expect(exMemberErr).toBeNull()
      expect(tasksSeenByExMember).toEqual([])
    },
  )

  it(
    '(b) personal -> team re-creates exactly one owner row for user_id, un-deleting ' +
      'the previous one rather than inserting a duplicate (members_one_per_person, R-8)',
    async () => {
      expect(originalOwnerRowId).toBeDefined() // (a) must have run to completion first
      const clientOwner = await clientFor(owner)

      const { error: switchBackErr } = await clientOwner
        .from('workspaces')
        .update({ kind: 'team', updated_at: stamp(5_000) })
        .eq('id', roundTripWs)
      expect(switchBackErr).toBeNull()

      const ownerRows = await runSql<MemberRow>(
        `select id, member_id, level, deleted, updated_at from public.members
          where workspace_id = $1 and member_id = $2`,
        [roundTripWs, owner.user.id],
      )
      // members_one_per_person is unconditional (not partial on `not
      // deleted`), so a second insert for the same person would itself have
      // failed a unique-constraint violation -- this asserts the row count
      // directly rather than merely that no error was thrown.
      expect(ownerRows).toHaveLength(1)
      expect(ownerRows[0].id).toBe(originalOwnerRowId) // same row, un-deleted -- not a new one
      expect(ownerRows[0].deleted).toBe(false)
      expect(ownerRows[0].level).toBe('owner')

      // Former members are NOT restored on the way back (spec.md FR-036,
      // data-model.md §2): otherMember's row from (a) stays deleted.
      const [otherMemberRow] = await selectOneMember(roundTripWs, otherMember.user.id)
      expect(otherMemberRow.deleted).toBe(true)
    },
  )

  it(
    "(c) the purge stamps updated_at = greatest(updated_at, now()), so a stale write " +
      'queued before the purge cannot out-rank it on arrival after',
    async () => {
      const clientOwner = await clientFor(owner)
      const ws = randomUUID()

      const { error: wsErr } = await clientOwner
        .from('workspaces')
        .insert({ id: ws, user_id: owner.user.id, name: 'kind-switch purge stamp', kind: 'team' })
      expect(wsErr).toBeNull()

      await insertMemberRow({ workspaceId: ws, createdBy: owner.user.id, memberId: otherMember.user.id, level: 'member' })

      // Force the row's stamp into the future first: this is the case that
      // discriminates `greatest(updated_at, now())` from a bare `now()`.
      // Under a bare `now()` the purge below would set `updated_at` to a
      // value *older* than this future stamp, and `keep_newer` (BEFORE
      // UPDATE) would cancel the purge write whole, leaving the row live --
      // silently passing the weaker assertions this finding replaces. Under
      // `greatest`, the purge keeps the future stamp and the soft-delete
      // lands.
      const future = new Date(Date.now() + 300_000)
      await runSql(
        `update public.members set updated_at = $1 where workspace_id = $2 and member_id = $3`,
        [future.toISOString(), ws, otherMember.user.id],
      )
      const [beforePurge] = await selectOneMember(ws, otherMember.user.id)
      expect(beforePurge.updated_at.getTime()).toBe(future.getTime())

      const { error: switchErr } = await clientOwner
        .from('workspaces')
        .update({ kind: 'personal', updated_at: stamp(5_000) })
        .eq('id', ws)
      expect(switchErr).toBeNull()

      const [afterPurge] = await selectOneMember(ws, otherMember.user.id)
      expect(afterPurge.deleted).toBe(true) // the purge landed -- greatest(...) kept the future stamp, not a bare now()
      expect(afterPurge.updated_at.getTime()).toBe(future.getTime()) // stamp unchanged -- it was already the greater value
      const postPurgeUpdatedAt = afterPurge.updated_at.getTime()

      // A write that queued before the purge and lands after it, carrying an
      // `updated_at` older than the purge's own stamp -- keep_newer must
      // cancel it whole, the same as any other stale row.
      const prePurgeUpdatedAt = postPurgeUpdatedAt - 60_000
      await runSql(
        `update public.members set deleted = false, updated_at = $1 where workspace_id = $2 and member_id = $3`,
        [new Date(prePurgeUpdatedAt).toISOString(), ws, otherMember.user.id],
      )

      const [afterStaleWrite] = await selectOneMember(ws, otherMember.user.id)
      expect(afterStaleWrite.deleted).toBe(true) // unmoved -- the stale write had no effect
      expect(afterStaleWrite.updated_at.getTime()).toBe(postPurgeUpdatedAt) // stamp unmoved too
    },
  )

  it(
    '(d) R-19 -- a kind flip carrying an older updated_at is cancelled by keep_newer ' +
      'before the AFTER-UPDATE trigger can fire, so no membership purge happens at all',
    async () => {
      const clientOwner = await clientFor(owner)
      const ws = randomUUID()

      const { error: wsErr } = await clientOwner
        .from('workspaces')
        .insert({ id: ws, user_id: owner.user.id, name: 'kind-switch stale flip', kind: 'team' })
      expect(wsErr).toBeNull()

      await insertMemberRow({ workspaceId: ws, createdBy: owner.user.id, memberId: otherMember.user.id, level: 'member' })

      const [{ updated_at: currentWsUpdatedAt, kind: currentKind }] = await runSql<{
        updated_at: Date
        kind: string
      }>('select updated_at, kind from public.workspaces where id = $1', [ws])
      expect(currentKind).toBe('team')

      const membersBefore = await selectMembers(ws)
      expect(membersBefore.every((r) => r.deleted === false)).toBe(true)

      // A device that queued this flip before it went offline, now pushing it
      // late: `updated_at` strictly older than what the workspace already
      // holds.
      const staleUpdatedAt = new Date(currentWsUpdatedAt.getTime() - 60_000).toISOString()
      const { error: staleFlipErr } = await clientOwner
        .from('workspaces')
        .update({ kind: 'personal', updated_at: staleUpdatedAt })
        .eq('id', ws)
      expect(staleFlipErr).toBeNull() // keep_newer drops the row silently, it does not raise

      const [{ kind: kindAfter, updated_at: updatedAtAfter }] = await runSql<{ kind: string; updated_at: Date }>(
        'select kind, updated_at from public.workspaces where id = $1',
        [ws],
      )
      expect(kindAfter).toBe('team') // the flip never landed
      expect(updatedAtAfter).toEqual(currentWsUpdatedAt) // stamp untouched -- keep_newer, not the app, refused it

      // The observable consequence, never trigger timing: no purge ran at all.
      const membersAfter = await selectMembers(ws)
      expect(membersAfter).toHaveLength(membersBefore.length)
      for (const before of membersBefore) {
        const after = membersAfter.find((r) => r.id === before.id)
        expect(after?.deleted).toBe(false)
        expect(after?.updated_at).toEqual(before.updated_at)
      }
    },
  )

  it(
    '(e) a kind flip on a workspace the caller does not own is refused by the ' +
      "unchanged workspace write half (42501), because kind is an ordinary column " +
      'and carries no special privilege path',
    async () => {
      const clientOwner = await clientFor(owner)
      const ws = randomUUID()

      const { error: wsErr } = await clientOwner
        .from('workspaces')
        .insert({ id: ws, user_id: owner.user.id, name: 'kind-switch non-owner refusal', kind: 'team' })
      expect(wsErr).toBeNull()

      await insertMemberRow({ workspaceId: ws, createdBy: owner.user.id, memberId: otherMember.user.id, level: 'member' })

      const clientMember = await clientFor(otherMember)
      const { data, error } = await clientMember
        .from('workspaces')
        .update({ kind: 'personal', updated_at: stamp(5_000) })
        .eq('id', ws)
        .select()

      expect(error).not.toBeNull()
      expect(error?.code).toBe('42501')
      expect(data).toBeNull()

      const [{ kind: kindAfter }] = await runSql<{ kind: string }>('select kind from public.workspaces where id = $1', [
        ws,
      ])
      expect(kindAfter).toBe('team') // unchanged
    },
  )
})
