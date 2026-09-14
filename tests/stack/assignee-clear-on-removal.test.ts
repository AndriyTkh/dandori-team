// T014 (US5) — the assignee lifecycle: set, clear, coerce-on-non-member,
// clear-on-removal, and the SC-007 no-access-meaning demonstration.
//
// Task-card mapping (specs/002-team-workspaces/tasks.md, read against the
// actual T020-T026 bodies rather than assumed):
//   - Before T020: RED — `workspaces.kind` does not exist yet either (the
//     only `kind` hit in `supabase/schema.sql` is the unrelated `notes.kind`
//     check), so the first statement to fail in every case below is
//     `insertTeamWorkspace`'s `insert ... kind ...` with
//     `column "kind" of relation "workspaces" does not exist` (42703) — not
//     `public.members` (42P01) and not `tasks.assignee` (42703), which never
//     get a chance to run. Never a typo, never an incidental harness error.
//   - T020 (fork block A — `members` table, `tasks.assignee` column):
//     the column exists, but `assignee_must_be_member` and
//     `clear_assignee_on_removal` do not yet, so the coercion and
//     clear-on-removal cases stay RED.
//   - T021 (fork block B — `is_member`/`is_owner`): not on this file's
//     critical path at all. Nothing here calls either function; the
//     `members_access` policy that would need them is T023's surface, not
//     this trigger-and-column card's (see the per-test notes below).
//   - T022 (fork block C — `assignee_must_be_member`, `clear_assignee_on_removal`,
//     among the rest of block C): most cases in this file go GREEN here —
//     see the per-case table below, not "every case". T021 is not needed by
//     anything in this file (nothing here calls `is_member`/`is_owner`), and
//     T024 is not needed either (every case seeds membership over raw `pg`,
//     never `add_member_by_email`).
//
//     | case | green at | needs |
//     |---|---|---|
//     | acceptance 1, assignment stored (~231) | T020 | `kind`, `members`, `tasks.assignee` — fork block A only |
//     | acceptance 2, default + clear (~248) | T020 | block A only |
//     | acceptance 6/D-3, coercion (~267) | T022 | `assignee_must_be_member` |
//     | SC-006, direct count (~288) | T022 | `assignee_must_be_member` (else the stranger task keeps its assignee -> count 1) |
//     | acceptance 3 & 4, clear on removal (~308) | T022 | `clear_assignee_on_removal` and `tasks_zz_assignee_member`; the stale-write arm rides upstream's existing `tasks` `keep_newer`, not T022's `members_keep_newer` |
//     | SC-007 (~394) | T020 | block A only; unchanged at T023 |
//     | acceptance 1, B reads the assignee back (~469) | T023 | the widened `tasks` read half |
//
// Coordinator note (found while writing this file, flagged per instructions
// rather than silently worked around): spec.md US5 acceptance 6 and FR-016's
// final sentence, as literally written ("an attempt to assign a task to
// someone who is not a member of that workspace, Then the write is
// refused" / "An assignment to a non-member MUST be refused"), matches
// spec.md as corrected 2026-09-14 — the coordinator has since corrected both
// clauses to coercion-to-empty, citing plan.md D-3 and
// `contracts/policies.sql:164-178`. This file asserts the coercion (D-3,
// FR-018, plan R-14), not literal acceptance 6 or FR-016's uncorrected
// wording, exactly as the card instructs.
//
// Read: spec.md US5 acceptances 1-6, FR-016..FR-018, SC-006, SC-007;
// data-model.md §2 "Assignee" (the null <--> member_id lifecycle,
// `greatest(updated_at, now())`), §5 (trigger firing order,
// `tasks_zz_assignee_member` / `members_zz_clear_assignee(_del)`);
// contracts/policies.sql (`assignee_must_be_member`, `clear_assignee_on_removal`);
// plan.md D-3, R-8, R-14; supabase/schema.sql:142-153 (`keep_newer`, read-only).
//
// `pg` returns `Date` objects for `timestamptz` columns (`pg-types`
// `getTypeParser(1184)`), not strings — every comparison below uses
// `.getTime()` rather than `Date.parse()` (which truncates to whole seconds
// via `Date#toString()`) or a bare `toBe` on two `Date` instances (always
// false — `Object.is` on distinct objects). See
// `tests/stack/offline-round-trip.test.ts:82-88` for the same note in situ.
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clientFor, createTestUsers, deleteTestUser, type TestUser } from '../harness/accounts'
import { DB_URL, assertStackReachable } from '../harness/stack'

type TaskRow = {
  id: string
  workspace_id: string
  user_id: string
  title: string
  assignee: string | null
  updated_at: Date
}

type MemberRow = {
  id: string
  workspace_id: string
  member_id: string
  level: string
  deleted: boolean
  updated_at: Date
}

let pg: Client
let owner: TestUser // A
let member: TestUser // B — added as a live member of each test's workspace
let stranger: TestUser // C — holds an account on this origin, never added to any workspace here

beforeAll(async () => {
  await assertStackReachable()
  pg = new Client({ connectionString: DB_URL })
  await pg.connect()
  ;[owner, member, stranger] = await createTestUsers(3, 'assignee')
}, 60_000)

afterAll(async () => {
  await pg?.end()
  await deleteTestUser(owner).catch(() => {})
  await deleteTestUser(member).catch(() => {})
  await deleteTestUser(stranger).catch(() => {})
})

// -------------------------------------------------------------- setup helpers
// Raw `pg`, bypassing RLS entirely and never touching `add_member_by_email`
// (T024) or `workspaces_seed_owner` (T022's own auto-seed) — this file only
// needs a team workspace and one live member row for B, both written
// directly, so it is green as soon as T022 lands its two D-3 triggers and
// never waits on T023's policies or T024's RPC.
//
// Coordinator decision: `insertTeamWorkspace`/`insertMember` below duplicate
// T019's `seedTeamWorkspace` (landed on `002-team-workspaces` as `b930f30`/
// `3d6c86c`, not present in this worktree) on purpose — keep the local
// raw-`pg` helpers. T019's helper goes through `add_member_by_email` (T024)
// and would push this file's green point to T024, which the card forbids.
// Do not replace these with a third copy of that helper.

async function insertTeamWorkspace(id: string, creator: TestUser, name: string): Promise<void> {
  await pg.query(`insert into public.workspaces (id, user_id, name, kind) values ($1, $2, $3, 'team')`, [
    id,
    creator.user.id,
    name,
  ])
}

/** Inserts one live membership row directly. Never the workspace owner's own row — see header note on `workspaces_seed_owner`. */
async function insertMember(workspaceId: string, creator: TestUser, subject: TestUser, level: 'owner' | 'member'): Promise<string> {
  const id = randomUUID()
  await pg.query(
    `insert into public.members (id, user_id, workspace_id, member_id, level) values ($1, $2, $3, $4, $5)`,
    [id, creator.user.id, workspaceId, subject.user.id, level],
  )
  return id
}

async function fetchMember(id: string): Promise<MemberRow> {
  const { rows } = await pg.query<MemberRow>(
    `select id, workspace_id, member_id, level, deleted, updated_at from public.members where id = $1`,
    [id],
  )
  return rows[0]
}

async function softDeleteMember(id: string, updatedAt: string | null = null): Promise<void> {
  await pg.query(`update public.members set deleted = true, updated_at = coalesce($2::timestamptz, now()) where id = $1`, [
    id,
    updatedAt,
  ])
}

async function insertTask(
  workspaceId: string,
  creator: TestUser,
  o: { title?: string; assignee?: string | null; updatedAt?: string } = {},
): Promise<string> {
  const { rows } = await pg.query<{ id: string }>(
    `insert into public.tasks (id, user_id, workspace_id, title, assignee, updated_at)
     values ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()))
     returning id`,
    [randomUUID(), creator.user.id, workspaceId, o.title ?? 'assignee test task', o.assignee ?? null, o.updatedAt ?? null],
  )
  return rows[0].id
}

async function fetchTask(id: string): Promise<TaskRow> {
  const { rows } = await pg.query<TaskRow>(
    `select id, workspace_id, user_id, title, assignee, updated_at from public.tasks where id = $1`,
    [id],
  )
  return rows[0]
}

/** Sets `assignee` and `updated_at` directly, exactly the shape a device's queued push would carry. Returns 0 rows when `keep_newer` abandons the write. */
async function setAssigneeDirect(id: string, assignee: string | null, updatedAt?: string): Promise<TaskRow[]> {
  const { rows } = await pg.query<TaskRow>(
    `update public.tasks set assignee = $2, updated_at = coalesce($3::timestamptz, now())
       where id = $1
       returning id, workspace_id, user_id, title, assignee, updated_at`,
    [id, assignee, updatedAt ?? null],
  )
  return rows
}

/** SC-006, measured directly: count of this workspace's tasks whose assignee names someone who is not a live member. */
async function nonMemberAssigneeCount(workspaceId: string): Promise<number> {
  const { rows } = await pg.query<{ count: string }>(
    `select count(*)::text as count
       from public.tasks t
      where t.workspace_id = $1
        and t.assignee is not null
        and not exists (
          select 1 from public.members m
           where m.workspace_id = t.workspace_id
             and m.member_id = t.assignee
             and not m.deleted
        )`,
    [workspaceId],
  )
  return Number(rows[0].count)
}

/**
 * Positive control for `nonMemberAssigneeCount`: count of this workspace's
 * tasks whose assignee names someone who *is* a live member. Pins the
 * workspace scoping and the non-vacuity of the match set — without this, a
 * `nonMemberAssigneeCount` of 0 could just as well mean the query matched an
 * empty set (wrong workspace, misrouted inserts) as it could mean the
 * trigger actually worked.
 */
async function liveMemberAssigneeCount(workspaceId: string): Promise<number> {
  const { rows } = await pg.query<{ count: string }>(
    `select count(*)::text as count
       from public.tasks t
      where t.workspace_id = $1
        and t.assignee is not null
        and exists (
          select 1 from public.members m
           where m.workspace_id = t.workspace_id
             and m.member_id = t.assignee
             and not m.deleted
        )`,
    [workspaceId],
  )
  return Number(rows[0].count)
}

// ------------------------------------------------------------------------

describe('US5 — task assignee lifecycle and removal clearing (T014)', () => {
  it('acceptance 1, FR-016: A assigns B, a live member of the workspace, and the assignment is stored', async () => {
    const workspaceId = randomUUID()
    await insertTeamWorkspace(workspaceId, owner, 'assignee ws — acceptance 1')
    await insertMember(workspaceId, owner, member, 'member')

    const taskId = await insertTask(workspaceId, owner, { assignee: member.user.id })

    const task = await fetchTask(taskId)
    // "both A and B see it on that task" (US5 acceptance 1) is measured here
    // at the data layer, exactly as the card's own Independent Test puts it
    // ("all at the data layer"). Reading it back through PostgREST *as B*
    // specifically needs the widened team read half, which is T023's surface
    // (tests/stack/team-rls-both-halves.test.ts), not this trigger-and-column
    // card's — this file asserts what the backend stores, not who can query it.
    expect(task.assignee).toBe(member.user.id)
  })

  it('acceptance 2, data-model.md §2: a task defaults to unassigned, and clearing an assignment returns it to that default', async () => {
    const workspaceId = randomUUID()
    await insertTeamWorkspace(workspaceId, owner, 'assignee ws — acceptance 2')
    await insertMember(workspaceId, owner, member, 'member')

    const freshTaskId = await insertTask(workspaceId, owner)
    const fresh = await fetchTask(freshTaskId)
    expect(fresh.assignee).toBeNull() // default, unassigned

    const taskId = await insertTask(workspaceId, owner, { assignee: member.user.id })
    const assigned = await fetchTask(taskId)
    expect(assigned.assignee).toBe(member.user.id) // positive control: actually set first

    const [cleared] = await setAssigneeDirect(taskId, null)
    expect(cleared.assignee).toBeNull()
    const reread = await fetchTask(taskId)
    expect(reread.assignee).toBeNull() // same as the fresh task's default state
  })

  it('acceptance 6 (superseded by D-3 — see header), FR-016, plan R-14: assigning a non-member is coerced to null and accepted, never refused', async () => {
    const workspaceId = randomUUID()
    await insertTeamWorkspace(workspaceId, owner, 'assignee ws — coercion')
    await insertMember(workspaceId, owner, member, 'member')

    // Positive control, identical call shape: assigning a live member is accepted and stored (paired with acceptance 1).
    const memberTaskId = await insertTask(workspaceId, owner, { assignee: member.user.id })
    const memberTask = await fetchTask(memberTaskId)
    expect(memberTask.assignee).toBe(member.user.id)

    // `stranger` holds a real account on this origin (created in beforeAll)
    // but was never added to this workspace's members. If
    // `assignee_must_be_member` ever became a raise instead of a coerce, the
    // `insertTask` call below would itself throw and fail this test loudly —
    // deliberately not wrapped in a try/catch that would mask that (D-3,
    // FR-018, plan R-14: "never as an error").
    const nonMemberTaskId = await insertTask(workspaceId, owner, { assignee: stranger.user.id })
    const nonMemberTask = await fetchTask(nonMemberTaskId)
    expect(nonMemberTask.assignee).toBeNull() // coerced, not refused — the row exists and was written
  })

  it('SC-006, measured directly: 0 tasks in the workspace have an assignee naming a non-member, even after an attempted non-member assignment', async () => {
    const workspaceId = randomUUID()
    await insertTeamWorkspace(workspaceId, owner, 'assignee ws — SC-006')
    await insertMember(workspaceId, owner, member, 'member')

    await insertTask(workspaceId, owner, { assignee: member.user.id }) // a valid assignment
    await insertTask(workspaceId, owner, { assignee: stranger.user.id }) // coerced to null by the trigger
    await insertTask(workspaceId, owner) // unassigned

    const count = await nonMemberAssigneeCount(workspaceId)
    expect(count).toBe(0)

    // Positive control, same workspace and same rows: the query does count
    // something when there is something to count — pins the scoping, the
    // three inserts above and the join shape, so the `0` above cannot be an
    // artefact of an empty match set.
    const liveCount = await liveMemberAssigneeCount(workspaceId)
    expect(liveCount).toBe(1)
  })

  it('acceptance 3 & 4, FR-018, D-3 (greatest(updated_at, now())): removing B clears the assignment on the backend with a stamp that outranks a queued edit already in flight', async () => {
    const workspaceId = randomUUID()
    await insertTeamWorkspace(workspaceId, owner, 'assignee ws — removal clears')
    const memberRowId = await insertMember(workspaceId, owner, member, 'member')

    // Two arms, same removal event: a past-stamped task (control — its stamp
    // must move forward to roughly now()) and a future-stamped task (the
    // actual discriminator — see below).
    const OLD_STAMP = '2020-01-01T00:00:00.000Z'
    const taskId = await insertTask(workspaceId, owner, { assignee: member.user.id, updatedAt: OLD_STAMP })

    // `greatest(updated_at, now())` and a bare `now()` are observationally
    // identical for any row whose `updated_at` is in the past — both produce
    // `now()`. Only a row stamped *ahead* of wall-clock tells the two
    // implementations apart: `greatest` must leave it exactly as it was,
    // while a bare `now()` would pull it backwards. FR-018/D-3's whole point
    // is that the clear must out-rank a stamp already ahead of wall-clock, so
    // this arm is the one that actually tests it.
    const FUTURE = new Date(Date.now() + 600_000)
    const futureTaskId = await insertTask(workspaceId, owner, {
      assignee: member.user.id,
      updatedAt: FUTURE.toISOString(),
    })

    const before = await fetchTask(taskId)
    expect(before.assignee).toBe(member.user.id) // positive control: actually assigned before removal
    expect(before.updated_at.getTime()).toBe(Date.parse(OLD_STAMP))

    const futureBefore = await fetchTask(futureTaskId)
    expect(futureBefore.assignee).toBe(member.user.id) // positive control: actually assigned before removal
    expect(futureBefore.updated_at.getTime()).toBe(FUTURE.getTime())

    await softDeleteMember(memberRowId)

    const memberRow = await fetchMember(memberRowId)
    expect(memberRow.deleted).toBe(true) // acceptance 4: B's access ends — structurally, at the membership row

    const after = await fetchTask(taskId)
    expect(after.assignee).toBeNull() // acceptance 3: assignee cleared, on the backend
    expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime()) // outranks the old stamp
    expect(after.updated_at.getTime()).toBe(memberRow.updated_at.getTime()) // the same `greatest(updated_at, now())` stamp the removal itself carries

    // The discriminator: `greatest(updated_at, now())` re-writes the
    // future-stamped row with its own unchanged value, so
    // `new.updated_at = old.updated_at` and `keep_newer`
    // (`if new.updated_at < old.updated_at then return null`) does not
    // abandon it — the row is written and the clear lands. A bare `now()`
    // would instead produce `new.updated_at = now() < old.updated_at`,
    // which *does* trip `keep_newer`'s guard, so the whole update — clear
    // included — is abandoned wholesale, not merely stamped differently.
    // That makes the assertion below, not the one after it, the
    // discriminator: it goes red under a bare `now()` because the clear
    // never lands at all.
    const futureAfter = await fetchTask(futureTaskId)
    expect(futureAfter.assignee).toBeNull() // DISCRIMINATOR: red under a bare now() — keep_newer would abandon this write outright, leaving the assignee still set
    // Supporting invariant only, not the discriminator: this stays green
    // under both implementations — abandonment (bare now()) leaves the old
    // stamp in place, and greatest() rewrites it back to the same value —
    // so it merely confirms the stamp is never pulled backwards.
    expect(futureAfter.updated_at.getTime()).toBe(FUTURE.getTime())

    // A "queued edit already on B's device" arriving late: an update carrying
    // an `updated_at` *older* than the clear's own stamp, trying to put the
    // assignment back. `keep_newer` (BEFORE UPDATE, sorts ahead of the `zz_`
    // triggers by name and so fires first) cancels it silently — no error,
    // zero rows affected — and `tasks_zz_assignee_member` never even runs for
    // this abandoned row. This is what "still true for a client that was
    // offline while it happened" (US5 acceptance 3) and SC-006's "after one
    // sync cycle, on every client" mean.
    const QUEUED_STALE_STAMP = '2020-06-01T00:00:00.000Z' // after OLD_STAMP, still long before the clear's real-time stamp
    const staleRows = await setAssigneeDirect(taskId, member.user.id, QUEUED_STALE_STAMP)
    expect(staleRows).toHaveLength(0) // keep_newer abandoned the row — 0 rows affected, no error

    const stillCleared = await fetchTask(taskId)
    expect(stillCleared.assignee).toBeNull() // the queued edit did not survive
    expect(stillCleared.updated_at.getTime()).toBe(after.updated_at.getTime()) // unchanged

    // Positive control for the stale-write arm above: a *newer*-stamped write
    // is not abandoned by `keep_newer` — it is accepted. Without this, a
    // regression that abandoned every `tasks` update (or an inverted
    // `keep_newer`) would leave `staleRows` empty for the wrong reason and
    // nothing here would tell the two cases apart.
    const NEWER_STAMP = new Date(Date.now() + 1_200_000).toISOString() // ahead of FUTURE and of now()
    const acceptedRows = await setAssigneeDirect(taskId, member.user.id, NEWER_STAMP)
    expect(acceptedRows).toHaveLength(1) // keep_newer accepted the write — it is not permanently abandoned

    // ...but B was removed by this point, so `tasks_zz_assignee_member`
    // (D-3's coercion trigger) fires on this very write and coerces the
    // reassignment right back to null — proving the two triggers agree: a
    // removed member cannot be re-assigned even via a direct, newer-stamped
    // write.
    expect(acceptedRows[0].assignee).toBeNull()
  })

  it('SC-007, FR-017: every access outcome is identical whether the task carries an assignee or not', async () => {
    const workspaceId = randomUUID()
    await insertTeamWorkspace(workspaceId, owner, 'assignee ws — SC-007')
    await insertMember(workspaceId, owner, member, 'member')

    const withAssignee = await insertTask(workspaceId, owner, { assignee: member.user.id })
    const withoutAssignee = await insertTask(workspaceId, owner)

    const clientOwner = await clientFor(owner)
    const clientStranger = await clientFor(stranger)

    // Positive control: the creator can read both rows, assignee or not — the
    // read outcome does not depend on the column at all.
    const { data: ownerSeesAssigned, error: ownerErr1 } = await clientOwner.from('tasks').select('*').eq('id', withAssignee)
    expect(ownerErr1).toBeNull()
    expect(ownerSeesAssigned).toHaveLength(1)

    const { data: ownerSeesUnassigned, error: ownerErr2 } = await clientOwner
      .from('tasks')
      .select('*')
      .eq('id', withoutAssignee)
    expect(ownerErr2).toBeNull()
    expect(ownerSeesUnassigned).toHaveLength(1)

    // Negative control, the same pair: `stranger` (a real account on this
    // origin, never a member of this workspace and not its creator) is
    // refused identically for both. This is a *read* refusal — the `using`
    // half fails, so the select matches zero rows with `error === null`; it
    // never raises 42501, which only happens on a write whose row passes
    // `using` and then fails `with check` (the 42501-vs-zero-rows mechanic).
    const { data: strangerSeesAssigned, error: strangerErr1 } = await clientStranger
      .from('tasks')
      .select('*')
      .eq('id', withAssignee)
    expect(strangerErr1).toBeNull()
    expect(strangerSeesAssigned).toEqual([])

    const { data: strangerSeesUnassigned, error: strangerErr2 } = await clientStranger
      .from('tasks')
      .select('*')
      .eq('id', withoutAssignee)
    expect(strangerErr2).toBeNull()
    expect(strangerSeesUnassigned).toEqual([])

    // FR-017 measured directly and structurally, not inferred from the four
    // behavioural checks above alone: no deployed policy predicate anywhere
    // in the schema mentions `assignee` at all — "the number of access
    // decisions that read the assignee is 0" (SC-007).
    const { rows: policies } = await pg.query<{ policyname: string; qual: string | null; withcheck: string | null }>(
      `select policyname, qual, with_check as withcheck from pg_policies where schemaname = 'public'`,
    )
    const readingAssignee = policies.filter(
      (p) => p.qual?.toLowerCase().includes('assignee') || p.withcheck?.toLowerCase().includes('assignee'),
    )
    expect(
      readingAssignee.map((p) => p.policyname),
      'a policy predicate reads assignee — FR-017/SC-007 violation',
    ).toEqual([])
  })

  // Coordinator decision (already made — not re-litigated here): US5
  // acceptance 1's "both A and B see it on that task" was discharged
  // nowhere — not by acceptance 1 above (data layer only, by design; see its
  // in-line note) and not by T011's `tasks.md:161` case, which covers a
  // member reading the team workspace's rows at all and says nothing about
  // the `assignee` column's value. This case closes that gap directly: B
  // reads the task through its own supabase-js client and checks the column.
  //
  // This one case turns green at T023, not T022, because it needs the
  // widened `tasks` read half (today, before T023, `tasks`' read policy is
  // still upstream's `auth.uid() = user_id`, so B cannot select a row A
  // created at all — the select would return zero rows, not the assignee).
  // Same carve-out the coordinator already made for `kind-switch.test.ts`
  // case (e) in T022's verify line; the coordinator will amend T022's verify
  // line for this file accordingly.
  it('acceptance 1: B, the assignee, reads the assignment back through its own client [green at T023]', async () => {
    const workspaceId = randomUUID()
    await insertTeamWorkspace(workspaceId, owner, 'assignee ws — B reads back')
    await insertMember(workspaceId, owner, member, 'member')

    const taskId = await insertTask(workspaceId, owner, { assignee: member.user.id })

    const clientMember = await clientFor(member)
    const { data, error } = await clientMember.from('tasks').select('*').eq('id', taskId)
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data?.[0].assignee).toBe(member.user.id)
  })
})
