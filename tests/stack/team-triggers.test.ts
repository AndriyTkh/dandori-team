// T015 (FR-014, R-6): demonstrates the three EXISTING triggers -- keep_newer,
// stay_deleted_with_workspace, follow_workspace_delete (all defined today at
// supabase/schema.sql:142-190, read-only for this file and unedited by this
// feature per plan.md R-4 / the fork block C guard on upstream's four-element
// loops) -- still fire identically on a personal workspace and on a team
// workspace, plus R-6's specific case: a team member's late-arriving live
// child on an owner-deleted workspace must be coerced to deleted, never
// refused.
//
// Task-card map (read tasks.md T020-T023 yourself before trusting a summary
// -- a previous card in this feature caught the coordinator's own arithmetic
// wrong, and that correction is on record in tasks.md):
//   - Before T020: RED. `workspaces.kind` and `public.members` do not exist.
//     Every insert below that sets `kind` fails PGRST204 ("Could not find the
//     'kind' column of 'workspaces'") -- including the R-6 fixture's
//     `insertWorkspace` call, which throws that same PGRST204 before the
//     direct-SQL `public.members` insert a few lines below it is ever
//     reached. (That later insert would itself hit a plain Postgres "relation
//     \"public.members\" does not exist", 42P01, but in practice never gets
//     the chance to.)
//   - T020 (fork block A: `workspaces.kind` + `public.members`, added
//     together in one guarded block -- contracts/policies.sql lines 19-51):
//     the six base describe.each cases (3 triggers x 2 kinds) go GREEN. None
//     of them needs a membership row, `is_member()`, or the policy swap --
//     every write in those six cases is the workspace's own creator acting
//     under the UNCHANGED `own_rows` predicate, which already lets a creator
//     write rows in a workspace they created regardless of what `kind` says.
//     `kind` is a label these six cases carry, not a gate they depend on.
//   - T021 (fork block B: is_member/is_owner) and T022 (fork block C: the
//     fork's OWN new triggers -- seed_workspace_owner,
//     on_workspace_kind_change, assignee_must_be_member,
//     clear_assignee_on_removal) touch neither the three existing triggers
//     nor the policy predicates. Nothing here changes between T020 and T023:
//     the R-6 case stays RED through both.
//   - T023 (policy block replaced wholesale, contracts/policies.sql lines
//     237-280): R-6 goes GREEN. Only here does a member's own write to a
//     task acquire a path through `with check` at all (the
//     `public.is_member(workspace_id)` branch on tasks/labels/notes) --
//     before T023 a member cannot even create the fixture row this case
//     needs, let alone reach it again after the workspace dies.
//
// Read: spec.md FR-014 + the "owner deletes the team workspace" edge case;
// ARCHITECTURE.md §4 L379-394 (trigger table, name-order firing);
// supabase/schema.sql:142-190 (keep_newer, follow_workspace_delete,
// stay_deleted_with_workspace), :196-212 (alphabetical firing order --
// `<t>_keep_newer` before `<t>_stay_deleted` before `<t>_synced_at`, all
// BEFORE); plan.md D-4, D-6/D-6′, R-6; contracts/policies.sql fork blocks
// A/B/C and the replaced policy block; tests/stack/soft-delete.test.ts (the
// P0 personal-side equivalent this file extends to team workspaces).
//
// THE R-6 CASE IS THE POINT OF THIS FILE. It asserts the CONTRACT's required
// outcome -- coercion, not refusal (spec.md edge case "The owner deletes the
// team workspace..."; plan.md R-6). If a future run instead shows the
// member's update matching zero rows (no error, `deleted` and `title` both
// left exactly as they were), that is the with-check-refuses-instead-of-
// coerces regression FR-014 and R-6 name explicitly: the replaced predicate
// made a trigger unreachable on a row it used to see. Softening this
// assertion to fit whatever the stack actually does would hide precisely the
// regression this test exists to catch -- if it comes out that way, it is
// reported to the owner as a FINDING, never patched here.
//
// A note on `pg` vs the wire: this file inserts one row directly over
// Postgres (the R-6 fixture's `members` row, deliberately bypassing
// PostgREST/RLS -- membership provisioning is T023/T024's card, not this
// one) but never reads a timestamp column back through that connection.
// Every timestamp this file compares travels through the `supabase-js`
// client instead, so both sides of every comparison are strings, not one
// string against a `pg`-returned `Date` (that hazard is real elsewhere, e.g.
// `tests/stack/offline-round-trip.test.ts:74-89`, but does not apply here).
// That is not enough for raw string equality, though: PostgREST's own
// rendering of a `timestamptz` differs from `Date#toISOString()`'s --
// `+00:00` instead of `Z`, and the fractional part dropped entirely at zero
// milliseconds -- so two strings naming the identical instant routinely
// compare unequal byte-for-byte. Every stamp comparison in this file
// therefore goes through `Date.parse()` on both sides, never raw `toBe()` on
// the strings themselves. Every "stale" / "newer" / "late" stamp is built
// relative to a stamp this same test just read back -- a value Postgres
// itself wrote -- never against `new Date()` in this vitest process (the
// host clock): a stamp compared against a value Postgres wrote must itself
// be derived from a value Postgres wrote, because the container's clock and
// the vitest process's host clock can differ by more than the test's own
// elapsed time under Docker Desktop / WSL2.
//
// Coverage residue, noted rather than closed (neither is required by this
// card's done-when):
//   - `keep_newer`'s contractual EQUAL-stamp acceptance ("Equal stamps are
//     accepted on purpose", `schema.sql:138-141`) has no assertion here --
//     this file only exercises strictly-older (dropped) and strictly-newer
//     (accepted, at +/- 60s, well off the equality boundary).
//   - FR-014's "or reachable on rows it never saw" half is exercised for
//     only one of the three triggers -- `stay_deleted_with_workspace`, via
//     R-6. `keep_newer` and `follow_workspace_delete` above are exercised
//     solely through the workspace's own creator, whose write path is
//     unchanged character-for-character by T023's policy swap.
import type { SupabaseClient } from '@supabase/supabase-js'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clientFor, createTestUser, deleteTestUser, type TestUser } from '../harness/accounts'
import { DB_URL, assertStackReachable } from '../harness/stack'

type Kind = 'personal' | 'team'
type TaskRow = { deleted: boolean; title: string; updated_at: string }

/**
 * Inserts one workspace row as its own creator/owner. Asserts the insert
 * succeeded, naming the PostgREST error when it did not -- the expected
 * shape of "red" before T020 (`kind` does not exist yet).
 */
async function insertWorkspace(client: SupabaseClient, userId: string, kind: Kind): Promise<string> {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const { error } = await client.from('workspaces').insert({
    id,
    user_id: userId,
    name: `team-triggers fixture (${kind})`,
    kind,
    position: 1000,
    gcal_sync: false,
    gcal: null,
    created_at: now,
    updated_at: now,
    deleted: false,
  })
  expect(
    error,
    `workspace insert (kind: ${kind}) failed: ${error?.code ?? '(no code)'} ${error?.message ?? ''}`,
  ).toBeNull()
  return id
}

/** Inserts one task row and returns its id plus the row as the server actually stored it. */
async function insertTask(
  client: SupabaseClient,
  userId: string,
  workspaceId: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string } & TaskRow> {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const { data, error } = await client
    .from('tasks')
    .insert({
      id,
      user_id: userId,
      workspace_id: workspaceId,
      title: 'team-triggers fixture task',
      created_at: now,
      updated_at: now,
      deleted: false,
      ...overrides,
    })
    .select('deleted, title, updated_at')
    .single()
  expect(error, `task insert failed: ${error?.code ?? '(no code)'} ${error?.message ?? ''}`).toBeNull()
  return { id, deleted: data!.deleted, title: data!.title, updated_at: data!.updated_at }
}

async function readTask(client: SupabaseClient, id: string): Promise<TaskRow> {
  const { data, error } = await client
    .from('tasks')
    .select('deleted, title, updated_at')
    .eq('id', id)
    .single()
  expect(error, `task read failed: ${error?.code ?? '(no code)'} ${error?.message ?? ''}`).toBeNull()
  return data!
}

let pg: Client

beforeAll(async () => {
  await assertStackReachable()
  pg = new Client({ connectionString: DB_URL })
  await pg.connect()
}, 60_000)

afterAll(async () => {
  await pg?.end()
})

describe.each<{ kind: Kind }>([{ kind: 'personal' }, { kind: 'team' }])(
  'the three existing triggers fire identically ($kind)',
  ({ kind }) => {
    let owner: TestUser
    let ownerClient: SupabaseClient

    beforeAll(async () => {
      owner = await createTestUser(`triggers-${kind}-owner`)
      ownerClient = await clientFor(owner)
    }, 60_000)

    afterAll(async () => {
      await deleteTestUser(owner).catch((err) =>
        console.error(`team-triggers: teardown failed to delete test user ${owner?.user?.id}:`, err),
      )
    })

    it('keep_newer: drops a stale-stamped update whole, but a genuinely newer one lands', async () => {
      const workspaceId = await insertWorkspace(ownerClient, owner.user.id, kind)
      const initial = await insertTask(ownerClient, owner.user.id, workspaceId)

      // The negative half: a stamp strictly OLDER than the row's own
      // `updated_at` (`schema.sql:142-153`). The BEFORE UPDATE trigger
      // returns null, so the statement matches this row but writes nothing
      // to it -- the row is absent from `.select()`'s result entirely, not
      // merely unchanged in a returned row.
      const stale = new Date(new Date(initial.updated_at).getTime() - 60_000).toISOString()
      const { data: staleResult, error: staleError } = await ownerClient
        .from('tasks')
        .update({ title: 'must be dropped, never applied', updated_at: stale })
        .eq('id', initial.id)
        .select('title, updated_at')
      expect(staleError, `stale update errored: ${staleError?.message ?? ''}`).toBeNull()
      expect(staleResult, 'keep_newer must drop the stale write from the result entirely').toEqual([])

      const afterStale = await readTask(ownerClient, initial.id)
      expect(afterStale.title, 'keep_newer must leave the title exactly as it was').toBe(initial.title)
      expect(
        Date.parse(afterStale.updated_at),
        'keep_newer must leave updated_at exactly as it was',
      ).toBe(Date.parse(initial.updated_at))

      // Positive control, in the same block: a write carrying a genuinely
      // NEWER stamp is not caught by the same mechanism. Without this half,
      // the assertions above would equally be satisfied by a write path that
      // silently drops every update -- proving the drop above is keep_newer
      // specifically, not a broken write path, requires showing a write
      // *does* land.
      const newer = new Date(new Date(initial.updated_at).getTime() + 60_000).toISOString()
      const { data: newerResult, error: newerError } = await ownerClient
        .from('tasks')
        .update({ title: 'this must land', updated_at: newer })
        .eq('id', initial.id)
        .select('title, updated_at')
      expect(newerError, `newer update errored: ${newerError?.message ?? ''}`).toBeNull()
      expect(
        newerResult,
        'a newer-stamped update must land -- the stale drop above is keep_newer, not a broken write path',
      ).toHaveLength(1)
      expect(newerResult?.[0]?.title).toBe('this must land')
      expect(Date.parse(newerResult?.[0]?.updated_at ?? '')).toBe(Date.parse(newer))
    })

    it('stay_deleted_with_workspace: forces deleted only on arrival after the workspace has died', async () => {
      const workspaceId = await insertWorkspace(ownerClient, owner.user.id, kind)

      // Positive control: while the workspace is still alive, an ordinary
      // live insert stays exactly what it claims to be.
      const liveArrival = await insertTask(ownerClient, owner.user.id, workspaceId, { deleted: false })
      expect(
        liveArrival.deleted,
        'positive control: an insert into a still-live workspace must stay live',
      ).toBe(false)

      const { error: workspaceDeleteError } = await ownerClient
        .from('workspaces')
        .update({ deleted: true, updated_at: new Date().toISOString() })
        .eq('id', workspaceId)
      expect(
        workspaceDeleteError,
        `workspace delete failed: ${workspaceDeleteError?.message ?? ''}`,
      ).toBeNull()

      // The negative half: the identical shape of insert, still claiming
      // `deleted: false` -- exactly what an offline device that never
      // learned of the delete would still believe (`schema.sql:177-190`) --
      // arriving after the workspace is already dead. Only the workspace's
      // own state differs from the positive control above, so any different
      // outcome is this trigger's doing.
      const lateArrival = await insertTask(ownerClient, owner.user.id, workspaceId, { deleted: false })
      expect(
        lateArrival.deleted,
        'stay_deleted_with_workspace must force deleted=true on arrival into a dead workspace',
      ).toBe(true)
    })

    it("follow_workspace_delete: cascades only this workspace's own already-live children", async () => {
      const workspaceId = await insertWorkspace(ownerClient, owner.user.id, kind)
      const siblingWorkspaceId = await insertWorkspace(ownerClient, owner.user.id, kind)

      const existing = await insertTask(ownerClient, owner.user.id, workspaceId)
      const siblingTask = await insertTask(ownerClient, owner.user.id, siblingWorkspaceId)
      expect(existing.deleted, 'fixture task must start live').toBe(false)
      expect(siblingTask.deleted, 'sibling fixture task must start live').toBe(false)

      const { error: workspaceDeleteError } = await ownerClient
        .from('workspaces')
        .update({ deleted: true, updated_at: new Date().toISOString() })
        .eq('id', workspaceId)
      expect(
        workspaceDeleteError,
        `workspace delete failed: ${workspaceDeleteError?.message ?? ''}`,
      ).toBeNull()

      const after = await readTask(ownerClient, existing.id)
      expect(
        after.deleted,
        'follow_workspace_delete must cascade the still-live child to deleted',
      ).toBe(true)

      // Positive control: the sibling workspace was never touched, so its
      // own child must still be live -- proving the cascade is scoped by
      // `workspace_id` (`schema.sql:158-175`), not "every task became
      // deleted" from some unrelated write.
      const siblingAfter = await readTask(ownerClient, siblingTask.id)
      expect(
        siblingAfter.deleted,
        "a sibling workspace's child must be unaffected by another workspace's delete",
      ).toBe(false)
    })
  },
)

describe("R-6: a team member's late-arriving live child on an owner-deleted workspace", () => {
  let owner: TestUser
  let member: TestUser
  let ownerClient: SupabaseClient
  let memberClient: SupabaseClient

  beforeAll(async () => {
    owner = await createTestUser('triggers-r6-owner')
    member = await createTestUser('triggers-r6-member')
    ownerClient = await clientFor(owner)
    memberClient = await clientFor(member)
  }, 60_000)

  afterAll(async () => {
    await deleteTestUser(owner).catch((err) =>
      console.error(`team-triggers: teardown failed to delete test user ${owner?.user?.id}:`, err),
    )
    await deleteTestUser(member).catch((err) =>
      console.error(`team-triggers: teardown failed to delete test user ${member?.user?.id}:`, err),
    )
  })

  it('is forced to deleted, not refused (FR-014; a refusal here is a FINDING, not a fix)', async () => {
    const workspaceId = await insertWorkspace(ownerClient, owner.user.id, 'team')

    // Membership inserted directly over Postgres, bypassing PostgREST/RLS
    // entirely -- this file is about the three EXISTING triggers, not about
    // `members_access` or the two membership RPCs (T023's own policy and
    // T024's RPCs belong to other cards). `public.members` does not exist
    // before T020, so this is one more thing that is expected RED (a plain
    // Postgres "relation does not exist", 42P01) until then.
    await pg.query(
      `insert into public.members (id, user_id, workspace_id, member_id, level, deleted)
       values ($1, $2, $3, $4, 'member', false)`,
      [crypto.randomUUID(), owner.user.id, workspaceId, member.user.id],
    )

    // Positive control, doing double duty as the fixture: the member creates
    // their own live task in the team workspace. Before T023 widens the
    // write half to `... or public.is_member(workspace_id)`, this insert has
    // no path through `with check` at all and fails -- which is why this
    // whole case is RED before T023, not merely before T020. Its success
    // here is the proof that the member's write path is reachable at all,
    // the thing the negative assertion below depends on to mean anything.
    const memberTask = await insertTask(memberClient, member.user.id, workspaceId)
    expect(memberTask.deleted, "positive control: the member's own fixture task must start live").toBe(
      false,
    )

    // The owner deletes the workspace. `follow_workspace_delete` (AFTER,
    // membership-blind, `schema.sql:158-175`) cascades every row live at
    // that moment, including the member's -- covered on its own above, not
    // the point of this case.
    const { error: workspaceDeleteError } = await ownerClient
      .from('workspaces')
      .update({ deleted: true, updated_at: new Date().toISOString() })
      .eq('id', workspaceId)
    expect(
      workspaceDeleteError,
      `workspace delete failed: ${workspaceDeleteError?.message ?? ''}`,
    ).toBeNull()

    // The member's own "queued" edit arrives after the workspace is already
    // dead on the server -- exactly what an offline device's late push looks
    // like, and it explicitly still claims `deleted: false` (what that
    // device still believes). `stay_deleted_with_workspace` (BEFORE,
    // unedited by this feature, `schema.sql:177-190`) must force `deleted =
    // true` on the way in; the row must still be reachable at all under the
    // member's OWN `with check` (`public.is_member(workspace_id)`,
    // independent of the workspace's own `deleted` flag) for that coercion
    // to have anywhere to land. A refusal instead -- zero rows matched, no
    // error, `title` and `deleted` both left exactly as they were -- means
    // the replaced predicate made this trigger unreachable on a row it used
    // to see: an FR-014 regression, reported as a FINDING, never patched
    // around here.
    //
    // The "late" stamp is built relative to the row's own `updated_at` as it
    // stands after the cascade, not against `new Date()` (the host clock):
    // `follow_workspace_delete` just stamped this row via `greatest(updated_at,
    // now())` using the CONTAINER's clock (`schema.sql:158-175`), and
    // `tasks_keep_newer` fires before `tasks_stay_deleted`
    // (`schema.sql:196-212`) -- so a host clock that lags the container's
    // would make `keep_newer` drop this update as stale, producing the exact
    // "zero rows matched, no error" shape this case is designed to catch,
    // for a reason that has nothing to do with `stay_deleted_with_workspace`.
    // This read itself depends on a precondition the R-6 fix introduced: the
    // member must still be able to READ this task after the workspace is
    // dead. That holds today under the unchanged `own_rows` read half
    // (`memberTask.user_id = member.user.id`), independent of `deleted` on
    // either the task or the workspace -- but if a future T023 read
    // predicate ever gated on workspace liveness, this line would fail as
    // `task read failed: PGRST116`, not as the coercion assertion below.
    const cascaded = await readTask(memberClient, memberTask.id)
    const late = new Date(new Date(cascaded.updated_at).getTime() + 60_000).toISOString()
    const { data: lateResult, error: lateError } = await memberClient
      .from('tasks')
      .update({
        title: 'queued edit arriving after the workspace died',
        updated_at: late,
        deleted: false,
      })
      .eq('id', memberTask.id)
      .select('deleted, title')
    expect(lateError, `member's late update errored: ${lateError?.message ?? ''}`).toBeNull()
    expect(
      lateResult,
      'the member update must match the row -- coercion requires the row be reachable at all',
    ).toHaveLength(1)
    expect(
      lateResult?.[0]?.deleted,
      'stay_deleted_with_workspace must force this late-arriving edit to deleted=true, not refuse it',
    ).toBe(true)
    expect(
      lateResult?.[0]?.title,
      "the coerced row must still carry the member's edit -- forced deleted, not merely blocked",
    ).toBe('queued edit arriving after the workspace died')
  })
})
