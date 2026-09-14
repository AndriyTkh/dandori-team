import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asUser, createTestUsers, deleteTestUser, type TestUser } from '../harness/accounts'
import { assertStackReachable, DB_URL } from '../harness/stack'

/*
 * US3 (spec.md, acceptances 1-6) + FR-011 + FR-012 + SC-002 + plan.md R-5.
 *
 * The eight predicate halves this file exercises — read (USING) and write (WITH CHECK) on
 * each of `workspaces`, `labels`, `tasks`, `notes` — are the replacement surface plan.md D-4
 * writes out and `contracts/policies.sql`'s "policy block" contracts. `ARCHITECTURE.md §3`
 * L243-262 and docs/validation-map.md lines 124-144 (the 2026-09-12 foundations-pass
 * correction) are why this file exists at all: the asymmetry is deliberate — reads stay
 * looser than writes on the child tables — and a P1 rewrite that pastes one membership
 * predicate into both halves would flatten it silently. FR-012 requires both halves replaced
 * *separately*; this file is the check that would fail if they were not.
 *
 * RED TODAY, FOR A NAMED REASON: neither `public.workspaces.kind` nor `public.members` exist
 * yet on this branch (they land at T020, blocked by this task per tasks.md's dependency
 * graph) and the policy block still has no membership branch anywhere: `workspaces` reads
 * `using (auth.uid() = user_id)` and writes `with check (auth.uid() = user_id)`
 * unconditionally, while `labels`/`tasks`/`notes` read `using (auth.uid() = user_id)` and
 * write `with check (auth.uid() = user_id and exists (… w.user_id = auth.uid()))` — an
 * ownership check, not a membership one, and exactly the write-half asymmetry this file
 * exists to keep from being flattened (`schema.sql:238-254`). Every seeding step below that
 * inserts a `kind: 'team'` workspace or a `public.members`
 * row fails — "column \"kind\" of relation \"workspaces\" does not exist" or "relation
 * \"public.members\" does not exist" — and every acceptance built on membership (reads/writes
 * a member should be allowed) fails for the mirror reason: the deployed predicate has no
 * `is_member`/`is_owner` branch to grant them. It turns green once T020 (kind column +
 * members table), T021 (is_member/is_owner) and T023 (the replaced policy block itself) all
 * land. T022 (seed_workspace_owner and friends) sits between T021 and T023 in the same file,
 * `supabase/schema.sql` — a serial lane, not a parallel one — and lands too, but no assertion
 * in this file depends on what T022 does; it is required only because it is in the way. T023 is
 * what actually flips the assertions, which is why the card's `verify` line reads "red before
 * T023, green after".
 *
 * PRE-T020 RED, PRECISELY: the seed lives in a `beforeAll`, not an `it`, specifically so that
 * this one structural failure aborts the whole file loudly and at the top — one `describe`
 * fails to even start, naming the Postgres `code`/`message` verbatim in the thrown error — rather
 * than silently unseeding every downstream case, which would otherwise fail or skip for reasons
 * unrelated to what each claims to test (an empty-string/undefined-UUID `22P02`, or a `42501`
 * arriving from upstream's ownership clause instead of from an absent membership branch). Expect
 * one clean, honest, single-cause abort pre-T020; the per-acceptance evidence this file's `it`
 * blocks were written to produce arrives only once T020–T023 land.
 *
 * Seeding uses a direct `pg` client against `DB_URL`, exactly as `rls-two-accounts.test.ts`
 * seeds its orphan row: RLS is not under test at seeding time, only at the point each
 * assertion below calls through a real `supabase-js` client held by `asUser` (plan.md D-3,
 * D-6) — never the app's singleton, never a hand-rolled client.
 *
 * `db.members` is cleared by this file itself in `afterAll`: `tests/setup.ts` is a P0 file
 * and stays unedited (owner decision, 2026-09-14), so every 002 test that seeds `members`
 * owns its own cleanup.
 *
 * The post-removal write half (below, "write half — B can no longer write %s rows") asserts
 * only INSERT, unlike the pre-removal write half which creates, edits and deletes. That is
 * deliberate, not a gap: the policy is `for all`, so once INSERT is refused, UPDATE and DELETE
 * ride the exact same USING clause already asserted (as `[]`, not `42501`) by the read-half
 * `it.each` immediately above it — asserting them again here would just re-assert the read half
 * under a different name.
 *
 * Scope: T012 (the executed inversion demonstration, FR-013/SC-005) and T013 (the R-7
 * `user_id`-does-not-drift assertion) are separate, later cards and are deliberately NOT
 * written here. T012's block belongs directly after this file's describe blocks, before the
 * closing of the outer suite — it needs the same `teamWorkspaceId`/`userA`/`userB` fixtures
 * already seeded below and one raw `pg` transaction of its own. T013's assertion belongs
 * inside (or immediately after) the "write half" cases of the labels/tasks/notes
 * describe.each block below, since it needs the exact row B edits there.
 *
 * NOT discriminated by this file: T023's membership branch being conjoined with
 * `auth.uid() = user_id` (rather than OR'd, as it must be) on the child-table write half. Every
 * write-half case here has B insert with `user_id = userB.user.id` (a true membership grant) and
 * has C refused by both the ownership and the membership branch regardless of how they combine
 * — so a wrongly-conjoined predicate would pass every acceptance in this file exactly as a
 * correctly-OR'd one would. That specific defect is T013's to catch, not this file's.
 */

const CHILD_TABLES = ['labels', 'tasks', 'notes'] as const
type ChildTable = (typeof CHILD_TABLES)[number]

/** Minimal valid insert payload for each child table (schema.sql's not-null-without-default columns). */
function childRowPayload(table: ChildTable, extra: Record<string, unknown>): Record<string, unknown> {
  switch (table) {
    case 'labels':
      return { id: randomUUID(), name: 'a label', ...extra }
    case 'tasks':
      return { id: randomUUID(), title: 'a task', ...extra }
    case 'notes':
      return { id: randomUUID(), kind: 'file', name: 'a note', ...extra }
  }
}

let userA: TestUser
let userB: TestUser
let userC: TestUser

let teamWorkspaceId: string
let aPersonalWorkspaceId: string
let bPersonalWorkspaceId: string

/** One row per child table, created by A in the team workspace, seeded before every describe block runs. */
const seededRowIds: Record<ChildTable, string> = { labels: '', tasks: '', notes: '' }

/** One row per child table, created by B (the member, not the owner) during the pre-removal
 * write half ("write half — B creates, edits and deletes a %s row in the team workspace"), as a
 * *second*, still-live insert distinct from the row that same test edits and then soft-deletes —
 * deliberately, so the post-removal own-row read control below is asserted against a live row,
 * not a tombstone; no predicate in schema.sql/contracts/policies.sql filters on `deleted` today,
 * but this keeps the control honest against a future read path that does. Read by the
 * post-removal read-half `it.each` to prove B's own row stays readable after membership is
 * removed — the property docs/validation-map.md:137-139 calls load-bearing (reads stay loose so a
 * not-yet-synced workspace cannot hide your own rows). Left as '' if that `it` never ran or threw
 * before assigning it; the post-removal block guards against that explicitly rather than trusting
 * this silently. */
const bOwnRowIds: Record<ChildTable, string> = { labels: '', tasks: '', notes: '' }

async function pg(): Promise<Client> {
  const client = new Client({ connectionString: DB_URL })
  await client.connect()
  return client
}

/** Direct-pg cleanup of every row this file created, most load-bearing for `public.members`
 * (tests/setup.ts, a P0 file, is never edited to know about a fork-only table — 002 tests own
 * their own members cleanup). Workspaces/labels/tasks/notes are also cascaded away by
 * `deleteTestUser` (auth.users -> ... on delete cascade), so this is belt-and-suspenders for
 * members specifically and a no-op if the table does not exist yet. */
async function cleanupMembers(): Promise<void> {
  const client = await pg()
  try {
    await client.query(
      `delete from public.members where workspace_id = $1`,
      [teamWorkspaceId],
    ).catch((err: { code?: string }) => {
      // This file is committed red pre-T020: `public.members` does not exist yet, so the
      // delete above raises 42P01 ("relation does not exist") — nothing to clean up, and that
      // specific SQLSTATE must not propagate, or it fails `afterAll` at the file level (unrelated
      // to any assertion) and skips the three `deleteTestUser` calls below it, leaking accounts
      // into every later run on this stack. Anything other than 42P01 is a real failure and must
      // still surface.
      if (err?.code !== '42P01') {
        throw err
      }
    })
  } finally {
    await client.end()
  }
}

beforeAll(async () => {
  await assertStackReachable()
  ;[userA, userB, userC] = await createTestUsers(3, 'us3-rls')
}, 60_000)

/** Seeds A's team workspace (with B as a member), A's and B's personal workspaces, and one row
 * per child table created by A — moved here from an `it` body so that a seed failure aborts the
 * whole file loudly and at the top, instead of leaving the module-level ids and `seededRowIds`
 * unset and nineteen downstream cases to fail or skip for reasons unrelated to what they claim to
 * test. Every throw below carries the Postgres `code` and `message` verbatim so the pre-T020 red
 * names the actual structural cause ("column \"kind\" of relation \"workspaces\" does not exist",
 * 42703, or "relation \"public.members\" does not exist", 42P01) once, unmistakably, at the top
 * of the run — see the file header for why that is the red this file aims for pre-T020. */
beforeAll(async () => {
  const client = await pg()
  try {
    teamWorkspaceId = randomUUID()
    aPersonalWorkspaceId = randomUUID()
    bPersonalWorkspaceId = randomUUID()

    try {
      // A's team workspace. `kind` does not exist pre-T020 — this insert is exactly the
      // structural failure point named in the header above.
      await client.query(
        `insert into public.workspaces (id, user_id, name, kind) values ($1, $2, $3, 'team')`,
        [teamWorkspaceId, userA.user.id, "A's team workspace"],
      )

      // A's untouched personal workspace — the thing SC-002 requires B to see zero of.
      await client.query(
        `insert into public.workspaces (id, user_id, name, kind) values ($1, $2, $3, 'personal')`,
        [aPersonalWorkspaceId, userA.user.id, "A's personal workspace"],
      )

      // B's own personal workspace — acceptance 3 requires B's list to contain the team
      // workspace *and* B's own workspaces; nothing exercised the second half without this.
      await client.query(
        `insert into public.workspaces (id, user_id, name, kind) values ($1, $2, $3, 'personal')`,
        [bPersonalWorkspaceId, userB.user.id, "B's personal workspace"],
      )

      // Membership: A as owner, B as member. `public.members` does not exist pre-T020 either
      // — the mirror structural failure point. Seeded directly (bypassing RLS, which is not
      // under test here) rather than through a not-yet-existent add-member RPC (that surface
      // is T010's, not this file's).
      await client.query(
        `insert into public.members (id, user_id, workspace_id, member_id, level)
         values ($1, $2, $3, $2, 'owner')
         on conflict (workspace_id, member_id) do nothing`,
        [randomUUID(), userA.user.id, teamWorkspaceId],
      )
      await client.query(
        `insert into public.members (id, user_id, workspace_id, member_id, level)
         values ($1, $2, $3, $4, 'member')
         on conflict (workspace_id, member_id) do nothing`,
        [randomUUID(), userA.user.id, teamWorkspaceId, userB.user.id],
      )

      // One row per child table, created by A, in the team workspace.
      for (const table of CHILD_TABLES) {
        const payload = childRowPayload(table, { user_id: userA.user.id, workspace_id: teamWorkspaceId })
        seededRowIds[table] = payload.id as string
        const columns = Object.keys(payload)
        const values = columns.map((_, i) => `$${i + 1}`).join(', ')
        await client.query(
          `insert into public.${table} (${columns.join(', ')}) values (${values})`,
          columns.map((c) => payload[c]),
        )
      }
    } catch (err) {
      const pgErr = err as { code?: string; message?: string }
      // Carry the Postgres SQLSTATE and message verbatim so the red names the actual structural
      // cause once, at the top, instead of each of the nineteen downstream cases failing or
      // skipping for an incidental reason of its own.
      throw new Error(
        `team-rls-both-halves seed failed — pre-T020 structural gap (see file header): ` +
          `code=${pgErr.code ?? '(none)'} message=${pgErr.message ?? String(err)}`,
      )
    }
  } finally {
    await client.end()
  }
}, 60_000)

afterAll(async () => {
  await cleanupMembers()
  // Cascades (auth.users -> workspaces/labels/tasks/notes, `on delete cascade`) take the
  // workspaces and rows this file created with them.
  //
  // Guarded per-user rather than three unconditional calls: if the first `beforeAll`
  // (`assertStackReachable`/`createTestUsers`) throws, `userA`/`userB`/`userC` are never
  // assigned, and `deleteTestUser(userA)` would throw on reading `userA.user.id` off
  // `undefined` — replacing the real cause with an unrelated `TypeError` in `afterAll`.
  for (const u of [userA, userB, userC]) {
    if (u) {
      await deleteTestUser(u)
    }
  }
})

describe('team RLS — both halves (T011, US3)', () => {
  it("seed landed — all three workspaces, both members rows and all three child rows read back with the expected kind/level/user_id", async () => {
    // Every id used below was assigned in `beforeAll`, which throws (loudly, naming the
    // Postgres code/message) before this test ever runs if the seed did not land — so none of
    // these are ever an empty-string or undefined UUID.
    const client = await pg()
    try {
      const { rows: workspaceRows } = await client.query(
        `select id, user_id, kind from public.workspaces where id = any($1::uuid[])`,
        [[teamWorkspaceId, aPersonalWorkspaceId, bPersonalWorkspaceId]],
      )
      const byId = new Map(workspaceRows.map((r) => [r.id as string, r]))
      expect(byId.get(teamWorkspaceId)).toMatchObject({ user_id: userA.user.id, kind: 'team' })
      expect(byId.get(aPersonalWorkspaceId)).toMatchObject({ user_id: userA.user.id, kind: 'personal' })
      expect(byId.get(bPersonalWorkspaceId)).toMatchObject({ user_id: userB.user.id, kind: 'personal' })

      const { rows: memberRows } = await client.query(
        `select member_id, level from public.members where workspace_id = $1 order by level`,
        [teamWorkspaceId],
      )
      expect(memberRows).toHaveLength(2)
      const byMember = new Map(memberRows.map((r) => [r.member_id as string, r.level as string]))
      expect(byMember.get(userA.user.id)).toBe('owner')
      expect(byMember.get(userB.user.id)).toBe('member')

      for (const table of CHILD_TABLES) {
        const { rows } = await client.query(
          `select id, user_id, workspace_id from public.${table} where id = $1`,
          [seededRowIds[table]],
        )
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ user_id: userA.user.id, workspace_id: teamWorkspaceId })
      }
    } finally {
      await client.end()
    }
  })

  describe('workspaces — read and write halves (acceptances 1, 3, 5; SC-002)', () => {
    it('read half — B\'s workspace list contains the team workspace and zero of A\'s personal workspaces', async () => {
      const clientB = await asUser(userB)
      const { data, error } = await clientB.from('workspaces').select('*')
      expect(error).toBeNull()

      // Existence control: A's personal workspace actually exists (seeded in beforeAll above)
      // — without this, `not.toContain` below would pass vacuously if the workspace never
      // landed at all.
      const clientA = await asUser(userA)
      const { data: aOwnList, error: aOwnErr } = await clientA
        .from('workspaces')
        .select('*')
        .eq('id', aPersonalWorkspaceId)
      expect(aOwnErr).toBeNull()
      expect(aOwnList).toHaveLength(1)

      const ids = (data ?? []).map((row) => row.id as string)
      expect(ids).toContain(teamWorkspaceId)
      expect(ids).toContain(bPersonalWorkspaceId)
      expect(ids).not.toContain(aPersonalWorkspaceId)

      // SC-002, sharper than `not.toContain` above: of A's *other* personal workspaces (i.e.
      // rows owned by A that are not the shared team workspace), B's result set contains none —
      // a form that would still catch a second, future A-personal workspace, not just this one id.
      const aOtherPersonalRowsVisibleToB = (data ?? []).filter(
        (row) => row.user_id === userA.user.id && row.id !== teamWorkspaceId,
      )
      expect(aOtherPersonalRowsVisibleToB).toHaveLength(0)
    })

    it("write half — B (a member, not the owner) cannot rename the team workspace; the write stays owner-only", async () => {
      const clientB = await asUser(userB)
      const { data, error } = await clientB
        .from('workspaces')
        .update({ name: 'renamed by B' })
        .eq('id', teamWorkspaceId)
        .select()

      // The USING half (read) already admits B to this row — B is a member — so the UPDATE
      // finds a row to act on; it is the WITH CHECK half, owner-only on `workspaces`, that
      // refuses the new row. Postgres surfaces that as a policy violation on the write
      // itself (42501), not as a silently-empty result the way a plain unmatched USING would.
      expect(error).not.toBeNull()
      expect(error?.code).toBe('42501')
      expect(data).toBeNull()

      const clientA = await asUser(userA)
      const { data: check } = await clientA.from('workspaces').select('name').eq('id', teamWorkspaceId)
      expect(check?.[0]?.name).toBe("A's team workspace")
    })
  })

  describe.each(CHILD_TABLES)('%s — read and write halves (acceptances 1, 2)', (table) => {
    it(`read half — B lists ${table} of the team workspace, including the row A created`, async () => {
      const clientB = await asUser(userB)
      const { data, error } = await clientB.from(table).select('*').eq('workspace_id', teamWorkspaceId)

      expect(error).toBeNull()
      const ids = (data ?? []).map((row) => row.id as string)
      expect(ids).toContain(seededRowIds[table])
    })

    it(`write half — B creates, edits and deletes a ${table} row in the team workspace`, async () => {
      const clientB = await asUser(userB)

      const insertPayload = childRowPayload(table, {
        user_id: userB.user.id,
        workspace_id: teamWorkspaceId,
      })
      const { data: created, error: createErr } = await clientB
        .from(table)
        .insert(insertPayload)
        .select()

      expect(createErr).toBeNull()
      expect(created).toHaveLength(1)
      // The created row records B as its creator.
      expect(created?.[0]?.user_id).toBe(userB.user.id)

      // A second row, also created by B, that this test does not edit or soft-delete below —
      // recorded for the post-removal own-row read control instead of `insertPayload.id`, which
      // is soft-deleted a few lines down. The control proves a *live* row stays readable by B
      // even after B's membership is removed (own-row read stays loose by design); asserting it
      // against a tombstone would happen to pass today (no predicate filters on `deleted`) but
      // would say nothing once one did.
      const liveOwnPayload = childRowPayload(table, {
        user_id: userB.user.id,
        workspace_id: teamWorkspaceId,
      })
      const { data: liveOwnCreated, error: liveOwnErr } = await clientB
        .from(table)
        .insert(liveOwnPayload)
        .select()
      expect(liveOwnErr).toBeNull()
      expect(liveOwnCreated).toHaveLength(1)
      bOwnRowIds[table] = liveOwnPayload.id as string

      // ... and remains visible to A (the other member of the same workspace).
      const clientA = await asUser(userA)
      const { data: seenByA, error: seenErr } = await clientA
        .from(table)
        .select('*')
        .eq('id', insertPayload.id as string)
      expect(seenErr).toBeNull()
      expect(seenByA).toHaveLength(1)

      // `notes` has no `title` column (schema.sql:79-90) — only `tasks` is titled, the other
      // two child tables are named.
      const editFieldKey = table === 'tasks' ? 'title' : 'name'
      const editField = { [editFieldKey]: 'edited by B' }
      const { data: edited, error: editErr } = await clientB
        .from(table)
        .update(editField)
        .eq('id', insertPayload.id as string)
        .select()
      // `.select()` is load-bearing: a PostgREST UPDATE whose `using` half matches nothing
      // returns 204 with no error and no SQLSTATE, so `editErr` alone would go green even if
      // the child write half's `using` clause refused B outright.
      expect(editErr).toBeNull()
      expect(edited).toHaveLength(1)
      expect((edited?.[0] as Record<string, unknown> | undefined)?.[editFieldKey]).toBe('edited by B')

      const { data: softDeleted, error: deleteErr } = await clientB
        .from(table)
        .update({ deleted: true })
        .eq('id', insertPayload.id as string)
        .select()
      expect(deleteErr).toBeNull()
      expect(softDeleted).toHaveLength(1)
      expect(softDeleted?.[0]?.deleted).toBe(true)
    })
  })

  describe('third account — knows the workspace id but is not a member (acceptance 4)', () => {
    it.each(CHILD_TABLES)(
      "C's insert of a %s row into the team workspace is refused, knowing the id grants nothing",
      async (table) => {
        const clientC = await asUser(userC)
        const payload = childRowPayload(table, {
          user_id: userC.user.id,
          workspace_id: teamWorkspaceId,
        })
        const { data, error } = await clientC.from(table).insert(payload).select()

        expect(error).not.toBeNull()
        expect(error?.code).toBe('42501')
        expect(data).toBeNull()

        // Control: A's seeded row of this table is still there and still readable by A — the
        // workspace and A's membership are intact, so the 42501 above is attributable to C's
        // non-membership and to nothing else (not to a missing workspace or a failed seed).
        const clientA = await asUser(userA)
        const { data: stillThere, error: controlErr } = await clientA
          .from(table)
          .select('*')
          .eq('id', seededRowIds[table])
        expect(controlErr).toBeNull()
        expect(stillThere).toHaveLength(1)
      },
    )
  })

  describe('post-removal — every read and write of the team workspace now returns nothing or is refused (R-5, acceptance 6, asserted on both halves)', () => {
    beforeAll(async () => {
      const client = await pg()
      try {
        // Soft-delete B's membership row directly, the same removal mechanism US2's
        // remove-member path uses (plan.md D-7) and the one `is_member`/`is_owner` read
        // (`and not m.deleted`, plan.md D-5) — R-5's residual risk named in plan.md is exactly
        // a helper that forgets this clause.
        await client.query(
          `update public.members set deleted = true where workspace_id = $1 and member_id = $2`,
          [teamWorkspaceId, userB.user.id],
        )
      } finally {
        await client.end()
      }
    })

    it("read half — B's workspace list no longer contains the team workspace", async () => {
      // Positive control: the team workspace itself still exists and is still readable by A —
      // so B's empty result below is attributable to lost membership, not to the workspace
      // having vanished (a failed removal, a cascade, or a wrong id would all otherwise also
      // satisfy `[]`).
      const clientA = await asUser(userA)
      const { data: stillThere, error: controlErr } = await clientA
        .from('workspaces')
        .select('*')
        .eq('id', teamWorkspaceId)
      expect(controlErr).toBeNull()
      expect(stillThere).toHaveLength(1)

      const clientB = await asUser(userB)
      const { data, error } = await clientB.from('workspaces').select('*').eq('id', teamWorkspaceId)
      expect(error).toBeNull()
      expect(data).toEqual([])
    })

    it.each(CHILD_TABLES)(
      'read half — B can no longer read %s rows of the team workspace, but its own rows stay readable',
      async (table) => {
        // Positive control: A's seeded row is still there and still readable by A — so B's empty
        // result below is attributable to lost membership, not to a lost row.
        const clientA = await asUser(userA)
        const { data: stillThere, error: controlErr } = await clientA
          .from(table)
          .select('*')
          .eq('id', seededRowIds[table])
        expect(controlErr).toBeNull()
        expect(stillThere).toHaveLength(1)

        // Scoped to A's row specifically, not the whole workspace: B created and still owns one
        // row per child table (`insertPayload.id`, `user_id = B`), and the read half's first
        // branch (`auth.uid() = user_id`) correctly still admits B to its own rows after removal.
        // A workspace-wide `[]` assertion here would be a false red against that correctly-kept
        // behaviour.
        const clientB = await asUser(userB)
        const { data, error } = await clientB.from(table).select('*').eq('id', seededRowIds[table])
        expect(error).toBeNull()
        expect(data).toEqual([])

        // Own-row control, discriminating the read half from a flattened write predicate: if the
        // membership branch were (wrongly) conjoined into `using` the same way it is in `with
        // check`, this would also come back `[]`. It must not — B's own row (created in the
        // pre-removal write half) stays readable even though B is no longer a member of the
        // workspace it lives in (docs/validation-map.md:137-139).
        expect(
          bOwnRowIds[table],
          `bOwnRowIds.${table} was never set — the pre-removal "write half — B creates, edits ` +
            `and deletes a ${table} row in the team workspace" it did not run or threw before ` +
            `assigning it`,
        ).not.toBe('')
        const { data: ownRow, error: ownRowErr } = await clientB
          .from(table)
          .select('*')
          .eq('id', bOwnRowIds[table])
        expect(ownRowErr).toBeNull()
        expect(ownRow).toHaveLength(1)
        expect(ownRow?.[0]?.user_id).toBe(userB.user.id)
      },
    )

    it.each(CHILD_TABLES)('write half — B can no longer write %s rows of the team workspace', async (table) => {
      const clientB = await asUser(userB)
      const payload = childRowPayload(table, {
        user_id: userB.user.id,
        workspace_id: teamWorkspaceId,
      })
      const { data, error } = await clientB.from(table).insert(payload).select()

      expect(error).not.toBeNull()
      expect(error?.code).toBe('42501')
      expect(data).toBeNull()

      // Control: A (still a member) can still insert into this workspace — so B's refusal
      // above is attributable to B's removed membership, not to the workspace or the write
      // half generally having stopped accepting inserts.
      const clientA = await asUser(userA)
      const controlPayload = childRowPayload(table, {
        user_id: userA.user.id,
        workspace_id: teamWorkspaceId,
      })
      const { data: controlData, error: controlErr } = await clientA
        .from(table)
        .insert(controlPayload)
        .select()
      expect(controlErr).toBeNull()
      expect(controlData).toHaveLength(1)
    })
  })
})
