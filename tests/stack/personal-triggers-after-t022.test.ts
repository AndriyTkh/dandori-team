// T026A — the personal-side smoke for T022's OWN new triggers, which nothing
// else observes. T015's team-triggers.test.ts proves upstream's three
// EXISTING triggers (keep_newer, stay_deleted_with_workspace,
// follow_workspace_delete) fire identically on both kinds; T016's
// personal-unchanged.test.ts re-runs the existing own_rows predicate on a
// personal workspace after T023's swap. Neither watches what T022's THREE NEW
// triggers -- keep_creator, assignee_must_be_member, seed_workspace_owner --
// do to a kind: 'personal' row. This file is that gap, and only that gap.
//
// All three cases below turn green at T022 and stay green, unedited, through
// T023 and T026: none of them exercises the policy block T023 replaces
// (contracts/policies.sql:237-280). Every read here of `public.members` goes
// over the raw `pg` connection, never through a signed-in client -- so no
// case ever depends on the `members_access` policy T023 writes. This file's
// `workspaces` fixture inserts go through the OWNER's own client, whose
// personal-path `with check` on `workspaces` is upstream's own_rows text
// unchanged by T023 (contracts/policies.sql:243-246). Case (a)'s writes are
// to `labels`/`tasks`/`notes`, whose replaced `with check`
// (contracts/policies.sql:256-263) is NOT byte identical to upstream's:
// T023 appends `or public.is_member(workspace_id)` to it, so only the first
// branch (contracts/policies.sql:257-261) is upstream's own_rows text
// character for character (supabase/schema.sql:249-253). The appended
// branch is false on every workspace this file creates, because
// `public.is_member(workspace_id)` requires a live `members` row and a
// `kind: 'personal'` workspace seeds none (case (c) is the direct assertion
// of that) -- so the disjunction collapses to the first branch and case (a)'s
// personal path is identical to pre-T023 in effect, not merely in text. The
// mechanisms this file actually exercises -- keep_creator (unconditional on
// kind), assignee_must_be_member (reads `members`, never a policy),
// seed_workspace_owner (guarded `if new.kind = 'team'`, security definer, run
// by the trigger machinery rather than through RLS at all) -- are none of
// them the thing T023 touches.
//
// Case (a) only exercises an update whose payload also renames `user_id` --
// it never runs an ORDINARY owner update (same `user_id` in the payload).
// That is proved by inference, not by a case of its own: keep_creator
// (contracts/policies.sql:212-217) runs `new.user_id := old.user_id`
// unconditionally, so an ordinary update -- which already carries
// `old.user_id` as its `user_id` -- gets the identical assignment and the
// identical post-trigger row; the impostor construction this file actually
// runs is the strictly stronger claim, and the ordinary case follows a
// fortiori. The "an ordinary update still lands at all" half is held green
// elsewhere and untouched by this card: P0's lww-conflict.test.ts and
// offline-round-trip.test.ts already perform ordinary owner updates on
// personal tasks and are gated unedited through T027.
//
// Red today, for two named structural reasons, per T020 (fork block A,
// contracts/policies.sql:19-51): `workspaces.kind` and `public.tasks.assignee`
// do not exist yet (every insert/select naming them fails PGRST204, "Could
// not find the '<col>' column of '<table>'"), and `public.members` does not
// exist yet (any query against it fails 42P01, "relation ... does not
// exist"). Case (a) does not touch either -- it is red instead because
// `<labels|tasks|notes>_zz_keep_creator` (T022, contracts/policies.sql:212-228)
// does not exist yet, so the impostor update is refused outright by the
// unchanged own_rows `with check` (42501, "new row violates row-level
// security policy"), which is the right gate for a case whose whole point is
// that trigger's effect (see the case's own comment for why "case (a) is red
// before T022" is not a coincidence).
//
// What this file deliberately does NOT cover:
//   - `members_zz_clear_assignee` (after update/delete on `members`) --
//     that is `tests/stack/assignee-clear-on-removal.test.ts`'s subject, and
//     needs a live member to remove, which a personal workspace never has.
//   - `workspaces_zz_kind_change` -- personal-unchanged.test.ts's own note
//     already narrows what this file's kind can assert about it (a
//     non-owner's write is refused, same as any other write); the switch's
//     OWN consequences are `tests/stack/kind-switch.test.ts`'s card.
//   - Whether an assignment to an actual live member is preserved -- this
//     file's workspaces are all `kind: 'personal'` and therefore never HAVE
//     a live member (that is case (b)'s and (c)'s whole point); the positive
//     "assignee survives" case for a real member belongs to team-side
//     coverage, not here.
//
// Case (b)'s null readback (a personal task's own creator, self-assigned,
// reads back `assignee: null`) is contractually intended, not a defect for a
// later reader to "fix": plan D-3 (plan.md:255-266, "coercing, not raising")
// has `assignee_must_be_member` coerce any non-member assignee to null
// unconditionally, and a personal workspace's owner is never a `members` row
// (case (c)), so the owner's own id is coerced exactly like a stranger's
// would be. See the case's own describe-block comment for the same note.
//
// A note on `pg` vs the wire, following team-triggers.test.ts's convention:
// every "newer" stamp below is derived from a value Postgres itself already
// wrote (the row's own `updated_at`, read back), never from `new Date()` in
// this vitest process: the container's clock and the host's can differ by
// more than a test's own elapsed time under Docker Desktop / WSL2, and a
// host-stamped write would then risk `keep_newer` dropping it as stale for a
// reason that has nothing to do with this file's actual subject.
import type { SupabaseClient } from '@supabase/supabase-js'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clientFor, createTestUser, deleteTestUser, type TestUser } from '../harness/accounts'
import { assertStackReachable, DB_URL } from '../harness/stack'

let pg: Client

/** True once `public.members` exists (T020) -- guards cleanup only; every
 *  case's own assertions are left to fail red on their own terms when the
 *  table is absent, per the card's per-`it` red-first requirement. */
async function membersTableExists(): Promise<boolean> {
  const { rows } = await pg.query<{ to_regclass: string | null }>("select to_regclass('public.members')")
  return rows[0]?.to_regclass !== null
}

beforeAll(async () => {
  await assertStackReachable()
  pg = new Client({ connectionString: DB_URL })
  await pg.connect()
}, 60_000)

afterAll(async () => {
  await pg?.end()
})

describe('T026A — personal-side smoke for T022 (keep_creator, assignee_must_be_member, seed_workspace_owner)', () => {
  describe('(a) <labels|tasks|notes>_zz_keep_creator is a no-op on a personal row, rather than a silent rewrite', () => {
    // Shared fixture: one personal workspace, owned by `owner`. Each `it`
    // below seeds its own row into it, so a failure in one table's case
    // cannot starve the others of a workspace to write into.
    let owner: TestUser
    let impostor: TestUser // never signs in; exists only to supply a real, FK-valid "someone else" id.
    let ownerClient: SupabaseClient
    let workspaceId = ''

    beforeAll(async () => {
      owner = await createTestUser('t026a-keepcreator-owner')
      impostor = await createTestUser('t026a-keepcreator-impostor')
      ownerClient = await clientFor(owner)

      workspaceId = crypto.randomUUID()
      const { error } = await ownerClient
        .from('workspaces')
        .insert({ id: workspaceId, user_id: owner.user.id, name: 't026a keep_creator fixture' })
      expect(error, `fixture workspace insert failed: ${error?.code ?? '(no code)'} ${error?.message ?? ''}`)
        .toBeNull()
    }, 60_000)

    afterAll(async () => {
      try {
        if (owner) await deleteTestUser(owner)
      } finally {
        if (impostor) await deleteTestUser(impostor)
      }
    })

    // Each table's case is written the same way and for the same reason: an
    // owner's update carries a payload that NAMES a different user_id (the
    // impostor's, a real FK-valid id) alongside a genuinely newer stamp.
    //
    //   - BEFORE T022 (no keep_creator trigger): the BEFORE-trigger chain
    //     never touches `new.user_id`, so the unchanged own_rows `with check`
    //     (`auth.uid() = user_id`) evaluates against the IMPOSTOR's id --
    //     `owner`'s own `auth.uid()` does not equal it, so the write is
    //     refused outright (42501), the row is untouched, and `title` never
    //     lands. That is today's honest red -- not a `kind`/`members`
    //     failure, because this case touches neither.
    //   - AT T022: `<table>_zz_keep_creator` (BEFORE UPDATE) forces
    //     `new.user_id := old.user_id` before the check ever runs, so the
    //     check sees the OWNER's own id again and passes. The update lands
    //     (title changes -- the positive control that this is a real write,
    //     not a refusal that happens to leave `user_id` alone) and `user_id`
    //     reads back unchanged from before the update: the trigger made the
    //     impostor's user_id a no-op, never a silent rewrite to it, and never
    //     a refusal either.
    //
    // This is exactly why the negative half ("user_id unchanged") is not
    // vacuous: without the trigger, the SAME assertion would be trivially
    // true too, but for the wrong reason (nothing landed at all, since the
    // whole statement was refused). Requiring `titleErr`/`error` to be null
    // AND the title to have changed rules that out.
    it.each([
      { table: 'labels' as const, field: 'name' as const, seedValue: "owner's label", newValue: 'renamed by owner' },
      { table: 'tasks' as const, field: 'title' as const, seedValue: "owner's task", newValue: 'renamed by owner' },
      { table: 'notes' as const, field: 'name' as const, seedValue: "owner's note", newValue: 'renamed by owner' },
    ])('$table: an update naming a different user_id lands with user_id unchanged', async ({ table, field, seedValue, newValue }) => {
      const rowId = crypto.randomUUID()
      const seedPayload: Record<string, unknown> = {
        id: rowId,
        user_id: owner.user.id,
        workspace_id: workspaceId,
        [field]: seedValue,
      }
      if (table === 'notes') seedPayload.kind = 'file' // notes.kind ('folder'|'file'): unrelated to workspaces.kind.

      const { data: seeded, error: seedErr } = await ownerClient
        .from(table)
        .insert(seedPayload)
        .select('updated_at')
        .single()
      expect(seedErr, `${table} fixture insert failed: ${seedErr?.code ?? '(no code)'} ${seedErr?.message ?? ''}`)
        .toBeNull()

      // A genuinely newer stamp, derived from what Postgres just wrote --
      // never from the host clock (see file header).
      const newer = new Date(new Date(seeded!.updated_at as string).getTime() + 60_000).toISOString()

      const { data: updatedRow, error: updateErr } = await ownerClient
        .from(table)
        .update({ [field]: newValue, user_id: impostor.user.id, updated_at: newer })
        .eq('id', rowId)
        .select(`${field}, user_id`)
        .single()
      expect(
        updateErr,
        `${table} update must land (keep_creator, not a refusal, is what fixes user_id back): ` +
          `${updateErr?.code ?? '(no code)'} ${updateErr?.message ?? ''}`,
      ).toBeNull()
      const updated = updatedRow as Record<string, unknown> | null

      // Positive control: the write actually landed -- rules out "the whole
      // statement was refused, which trivially also left user_id alone".
      expect(updated?.[field], 'the update must land, not merely appear to').toBe(newValue)
      // The case itself: keep_creator forced the impostor's id back to the
      // original creator's, silently and without refusing anything else in
      // the same statement.
      expect(updated?.user_id, 'keep_creator must force user_id back to the original creator, not the impostor').toBe(
        owner.user.id,
      )
    })
  })

  describe("(b) a personal task self-assigned by its own creator reads back assignee = null (guard: no members row exists to satisfy it)", () => {
    // seed_workspace_owner (contracts/policies.sql:101-114) is guarded
    // `if new.kind = 'team'` -- a personal workspace's owner is never
    // inserted into `public.members` at all (case (c) below is the direct
    // assertion of that). `tasks_zz_assignee_member` (contracts/policies.sql:
    // 164-178) therefore finds no live member row for ANY id on a personal
    // workspace's tasks, including the workspace owner's own id -- so
    // self-assignment is coerced to null exactly like assignment to a
    // stranger would be. That is contractually intended (plan D-3: the
    // trigger assigns `new.assignee := null` and returns `new`, never
    // raises -- a raise inside a sync batch would abort the whole upsert and
    // wedge the tasks queue), not a bug for a later card to "fix".
    let owner: TestUser
    let ownerClient: SupabaseClient

    beforeAll(async () => {
      owner = await createTestUser('t026a-selfassign-owner')
      ownerClient = await clientFor(owner)
    }, 60_000)

    afterAll(async () => {
      if (owner) await deleteTestUser(owner)
    })

    it('assignee reads back null, and the task row itself is the one that was inserted (in-block positive control)', async () => {
      const workspaceId = crypto.randomUUID()
      const { error: wsErr } = await ownerClient
        .from('workspaces')
        .insert({ id: workspaceId, user_id: owner.user.id, name: 't026a self-assign fixture', kind: 'personal' })
      expect(wsErr, `fixture workspace insert failed: ${wsErr?.code ?? '(no code)'} ${wsErr?.message ?? ''}`)
        .toBeNull()

      const taskId = crypto.randomUUID()
      const taskTitle = "owner's self-assigned task"
      const { data: inserted, error: taskErr } = await ownerClient
        .from('tasks')
        .insert({
          id: taskId,
          user_id: owner.user.id,
          workspace_id: workspaceId,
          title: taskTitle,
          assignee: owner.user.id, // self-assignment: the creator naming themselves.
        })
        .select('title, assignee')
        .single()
      expect(
        taskErr,
        `self-assign insert must not be refused (assignee_must_be_member coerces, it never raises): ` +
          `${taskErr?.code ?? '(no code)'} ${taskErr?.message ?? ''}`,
      ).toBeNull()

      // Positive control (card's own instruction): assert the row itself
      // came back, with the title it was given -- so a missing/wrong row
      // cannot be mistaken for a coerced-null assignee.
      expect(inserted?.title, 'the inserted row must be the fixture task, not some other/absent row').toBe(
        taskTitle,
      )
      // The case itself.
      expect(
        inserted?.assignee,
        'assignee_must_be_member must coerce even a self-assignment to null on a personal workspace, ' +
          'because seed_workspace_owner never seeded a members row for its owner (contracts/policies.sql:101-114)',
      ).toBeNull()

      // Re-read over a second, independent path (raw pg, bypassing
      // PostgREST/RLS entirely) so the null above is not an artifact of
      // supabase-js's own `.select()` shape.
      const { rows } = await pg.query<{ title: string; assignee: string | null }>(
        'select title, assignee from public.tasks where id = $1',
        [taskId],
      )
      expect(rows, 're-read over pg must find the same row').toHaveLength(1)
      expect(rows[0]?.title).toBe(taskTitle)
      expect(rows[0]?.assignee).toBeNull()
    })
  })

  describe('(c) creating a personal workspace seeds no members row', () => {
    // Negative assertion (personal: zero rows) paired with a positive
    // control of the identical query shape (team: exactly one owner row) in
    // the SAME case, per the card's instruction -- a zero count alone would
    // be equally "true" if the query were wrong, if the workspace were never
    // created, or if `members` were simply empty for every workspace; the
    // team half proves the query and the trigger both work when `kind`
    // actually is `'team'`.
    let owner: TestUser
    let ownerClient: SupabaseClient

    beforeAll(async () => {
      owner = await createTestUser('t026a-noseed-owner')
      ownerClient = await clientFor(owner)
    }, 60_000)

    afterAll(async () => {
      try {
        if (owner && (await membersTableExists())) {
          // Defensive, ahead of the auth.users cascade -- not required for
          // isolation (members_id -> auth.users on delete cascade already
          // covers this), but keeps this cleanup honest about what it
          // touches. Never guarded more broadly than "table absent": a
          // genuine failure here must still fail the suite.
          await pg.query('delete from public.members where user_id = $1', [owner.user.id])
        }
      } finally {
        if (owner) await deleteTestUser(owner)
      }
    })

    it('personal: no members row; team (same case, same query shape): exactly one owner row', async () => {
      const personalWorkspaceId = crypto.randomUUID()
      const { error: personalErr } = await ownerClient.from('workspaces').insert({
        id: personalWorkspaceId,
        user_id: owner.user.id,
        name: 't026a no-seed fixture (personal)',
        kind: 'personal',
      })
      expect(
        personalErr,
        `personal fixture workspace insert failed: ${personalErr?.code ?? '(no code)'} ${personalErr?.message ?? ''}`,
      ).toBeNull()

      const { rows: personalMembers } = await pg.query(
        'select id from public.members where workspace_id = $1',
        [personalWorkspaceId],
      )
      expect(
        personalMembers,
        'seed_workspace_owner is guarded `if new.kind = \'team\'` (contracts/policies.sql:101-114): ' +
          'a personal workspace must seed no members row at all, not even for its own owner',
      ).toHaveLength(0)

      const teamWorkspaceId = crypto.randomUUID()
      const { error: teamErr } = await ownerClient.from('workspaces').insert({
        id: teamWorkspaceId,
        user_id: owner.user.id,
        name: 't026a no-seed fixture (team, positive control)',
        kind: 'team',
      })
      expect(teamErr, `team fixture workspace insert failed: ${teamErr?.code ?? '(no code)'} ${teamErr?.message ?? ''}`)
        .toBeNull()

      const { rows: teamMembers } = await pg.query<{ member_id: string; level: string; deleted: boolean }>(
        'select member_id, level, deleted from public.members where workspace_id = $1',
        [teamWorkspaceId],
      )
      expect(
        teamMembers,
        'positive control: the same query shape must find exactly the owner row a team workspace seeds, ' +
          'proving the zero count above is the trigger being guarded, not the query or fixture being broken',
      ).toHaveLength(1)
      expect(teamMembers[0]?.member_id).toBe(owner.user.id)
      expect(teamMembers[0]?.level).toBe('owner')
      expect(teamMembers[0]?.deleted).toBe(false)
    })
  })
})
