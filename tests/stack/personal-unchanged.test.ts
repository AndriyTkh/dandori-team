// US4 (spec.md "A's personal experience is unchanged") — the smoke test that
// the P1 membership swap (T023) did not change what a **personal** workspace
// does. T016.
//
// Every read/write outcome asserted below is chosen to be *identical* to
// tests/stack/rls-two-accounts.test.ts's outcomes for the same operation,
// run here against a personal (not team) workspace: this file adds no new
// access rule of its own, it re-runs the existing one after the T023
// predicate replacement and shows nothing moved. See the per-`it` comments
// below for the acceptance each mirrors.
//
// Red today, for a named reason: `workspaces.kind` and the `members` table
// (T020) do not exist yet. Every assertion below that touches `kind`
// currently fails with Postgres's "column kind does not exist" (42703, or
// PostgREST's equivalent "column not found" on a `.select('kind')`).
// Nothing here is stubbed, skipped or guarded to hide that — it goes green
// only once T020 lands the schema, with no edit to this file. Nothing here
// needs T021-T023: every non-`kind` assertion exercises the *existing*,
// unchanged `own_rows` predicate, which does not move until T023 replaces it
// (and this file's whole point is that it should not observably move then
// either).
//
// Closer review, corrected 2026-09-14 — a cross-test state dependency
// previously meant one failure was a foreign-key violation, not a `kind`
// failure, and three recorded passes were vacuous:
//
//   `wsA` used to be assigned inside the second `it`, by a client insert
//   that also (in the same request) asked PostgREST to `.select('kind')` —
//   the very column that doesn't exist pre-T020. That made the whole
//   insert-plus-returning statement fail and roll back, so **no workspace
//   row was ever created**, even though the module-level `wsA` variable was
//   already holding a UUID that named nothing. Every later `it` in the file
//   read or wrote against that phantom id: three of them (`B` selecting it,
//   updating it, and being refused an insert into it) came back empty or
//   erroring for the *right-looking, wrong reason* — the row simply didn't
//   exist, not because RLS excluded it — and a fourth (the raw `pg` insert
//   of an orphan task pointing at `wsA`) hit `tasks_workspace_id_fkey`
//   (23503) and failed outright, a failure that touches no `kind` column at
//   all.
//
//   Fixed by seeding `wsA` in `beforeAll`, with a raw `pg` insert naming no
//   `kind` (never inside an `it`), so its existence cannot depend on an
//   assertion elsewhere in the file passing or failing, `kind`-related or
//   not. The former second `it` now only asserts the column default, on a
//   workspace of its own; a new `it` right after seeds A's task (plus, per
//   finding 4 below, a label and a note) into the now-real `wsA`. The
//   B-insert-refused assertion is also tightened to the specific RLS error
//   code (`42501`), since with `wsA` genuinely present the refusal really is
//   a policy refusal now, not a foreign-key one — see the immutability note
//   below for why that distinction holds even for `kind`-only writes.
//   Two positive controls were added (finding 3): the "B sees nothing"
//   assertions are now paired with "A still sees its own rows", so a T023
//   swap that broke isolation in the *restrictive* direction (nobody sees
//   anything) cannot leave this file silently green. `labels` and `notes`
//   get the same T023 predicate replacement as `tasks` but were previously
//   untouched by this file (and by rls-two-accounts.test.ts) — finding 4
//   folds one of each into the existing seed/list/refuse assertions rather
//   than adding parallel tests for them.
//
// `kind` immutability, corrected mid-task (coordinator note, 2026-09-14):
// the card as first briefed described `kind` as pinned back by a
// `pin_workspace_kind` trigger on any update (plan.md's original D-6). That
// half of D-6 was withdrawn and replaced by D-6' (plan.md:423-482,
// contracts/policies.sql:116-155): `kind` is an ordinary column, mutable in
// either direction by the workspace's owner (FR-034), with no pin trigger at
// all — `pin_workspace_kind` and `workspaces_zz_kind_fixed` do not exist.
// What personal-unchanged actually has standing to assert is:
//   - a THIRD value (anything but 'personal'/'team') is refused by
//     `workspaces_kind_check`, at creation and at an update alike (FR-001,
//     US1 acceptance 4) — a genuine check-constraint violation, 23514.
//   - a non-owner's (B's) attempt to change `kind` on A's personal
//     workspace is bound by the SAME unchanged `workspaces` write predicate
//     every other write of B's against A's workspace already hits in this
//     file: `with check (auth.uid() = user_id)` is not satisfied by B, and
//     — because `kind` is an ordinary column with no special privilege path
//     (contracts/policies.sql:116-122) — the effect is exactly the
//     "invisible row" shape RLS's `using` clause produces for every other
//     write of B's here (see "B's insert into A's workspace id is refused"
//     below for the one exception: an INSERT's `with check` failure raises;
//     an UPDATE whose `using` clause excludes the row outright does not —
//     it matches zero rows, silently, like a plain `WHERE` that matched
//     nothing). T017's kind-switch.test.ts owns the owner's successful
//     switch and its consequences; this file does not duplicate it.
//
// SC-002 coverage note (spec.md:864 — "A's personal workspaces and their
// rows, by listing, by identifier, by read or by write"): this file
// exercises the by-identifier read on `workspaces` only ("by identifier —
// B selects A's workspace by id" below). The child tables (`tasks`,
// `labels`, `notes`) get the listing form and the by-workspace-id write
// form, but no `.eq('id', <A's row id>)` read of a child row by B — same
// `own_rows` predicate either way, so this is a gap in what this file's
// receipt can claim was exercised, not in the rule itself.
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { clientFor, createTestUser, deleteTestUser, type TestUser } from '../harness/accounts'
import { assertStackReachable, DB_URL } from '../harness/stack'

let userA: TestUser
let userB: TestUser
let wsA: string

beforeAll(async () => {
  await assertStackReachable()
  userA = await createTestUser('personal-a')
  userB = await createTestUser('personal-b')

  // wsA is seeded here, never inside an `it`, and by a raw insert naming no
  // `kind` at all — the same statement the pre-existing-row test below uses
  // on its own row. That makes wsA's existence independent of T020 landing
  // and independent of any assertion in this file passing: every later `it`
  // that references wsA by id is now grounded in a real row (see the
  // closer-review note above for what went wrong when it wasn't).
  wsA = randomUUID()
  const pg = new Client({ connectionString: DB_URL })
  await pg.connect()
  try {
    await pg.query('insert into public.workspaces (id, user_id, name) values ($1, $2, $3)', [
      wsA,
      userA.user.id,
      'A personal workspace',
    ])
  } finally {
    await pg.end()
  }
}, 60_000)

afterAll(async () => {
  // Cascades (auth.users -> workspaces/labels/tasks/notes, `on delete
  // cascade`) take every row this file created with them. Nothing here
  // seeds `public.members` (no team workspace is ever created in this
  // file), so there is nothing of this file's own to clear there.
  try {
    await deleteTestUser(userA)
  } finally {
    await deleteTestUser(userB)
  }
})

describe('US4 — a personal workspace is unchanged after the T023 swap (T016)', () => {
  it('a row inserted without naming kind reads personal (FR-001 default)', async () => {
    // A direct pg insert naming no `kind` at all — standing in for a row
    // that has been in the table since before this feature ever ran,
    // exactly as FR-001's guarded column add leaves it. This proves the
    // column *default*, not a backfill: globalSetup applies the schema to
    // an empty database, so no row here can genuinely predate T020's `add
    // column`. FR-001's pre-existing-row clause needs no execution of its
    // own because there is no separate backfill step to get wrong: `add
    // column ... not null default 'personal'` is a fast default (PG 11+),
    // so every pre-existing row reads 'personal' by the same column
    // default a freshly-inserted row reads from at insert time — the
    // column default *is* the backfill.
    const pg = new Client({ connectionString: DB_URL })
    await pg.connect()
    try {
      const preexistingId = randomUUID()
      await pg.query('insert into public.workspaces (id, user_id, name) values ($1, $2, $3)', [
        preexistingId,
        userA.user.id,
        'pre-existing workspace',
      ])
      const { rows } = await pg.query('select kind from public.workspaces where id = $1', [preexistingId])
      expect(rows[0]?.kind).toBe('personal')
    } finally {
      await pg.end()
    }
  })

  it('a workspace created without expressing a choice is personal (US1 acceptance 2)', async () => {
    const clientA = await clientFor(userA)
    const { data: created, error: wsErr } = await clientA
      .from('workspaces')
      .insert({ id: randomUUID(), user_id: userA.user.id, name: "A's own-default workspace" })
      .select('kind')
      .single()
    expect(wsErr).toBeNull()
    expect(created?.kind).toBe('personal')
  })

  it("seeds A's task, label and note into wsA", async () => {
    // Left as an `it`, not moved into `beforeAll` alongside `wsA`: unlike
    // `wsA`'s raw-`pg` seed, the three inserts below go through `clientA`
    // and assert `taskErr`/`labelErr`/`noteErr` are all null — i.e. that
    // A's own write still succeeds through the RLS-gated client for
    // `labels` and `notes` specifically (the `tasks` case is also covered
    // by the delete-cascade `it` below, but `labels`/`notes` A-insert-
    // success has no other coverage in this file). A `beforeAll` raw-`pg`
    // seed carries no such assertion, so moving these would silently drop
    // that coverage rather than just remove a dependency.
    const clientA = await clientFor(userA)

    const { error: taskErr } = await clientA
      .from('tasks')
      .insert({ id: randomUUID(), user_id: userA.user.id, workspace_id: wsA, title: "A's task" })
    expect(taskErr).toBeNull()

    // Finding 4: labels and notes get the same T023 own_rows replacement as
    // tasks, and this repo's rls-two-accounts.test.ts doesn't exercise
    // either — so without these, two of the three child tables the swap
    // touches would be unguarded anywhere. Seeded here so the list-empty
    // and insert-refused assertions below can cover all three.
    const { error: labelErr } = await clientA
      .from('labels')
      .insert({ id: randomUUID(), user_id: userA.user.id, workspace_id: wsA, name: "A's label" })
    expect(labelErr).toBeNull()

    const { error: noteErr } = await clientA
      .from('notes')
      // `kind: 'file'` here is notes.kind ('folder'|'file'), unrelated to
      // this feature's workspaces.kind — just a valid note row to seed.
      .insert({ id: randomUUID(), user_id: userA.user.id, workspace_id: wsA, kind: 'file', name: "A's note" })
    expect(noteErr).toBeNull()
  })

  it("mirrors rls-two-accounts acceptance 1 — B lists A's rows and gets an empty result, not an error", async () => {
    const clientA = await clientFor(userA)
    const clientB = await clientFor(userB)

    // Positive control (finding 3): confirm A still sees A's own rows
    // before checking B sees none of them. Without this half, a T023 swap
    // that broke isolation in the *restrictive* direction — nobody sees
    // anything, personal included — would leave every "B sees nothing"
    // assertion below green for the wrong reason.
    const { data: aWorkspaces, error: aWsErr } = await clientA.from('workspaces').select('*')
    expect(aWsErr).toBeNull()
    expect(aWorkspaces?.some((w) => w.id === wsA)).toBe(true)

    const { data: aTasks, error: aTaskErr } = await clientA.from('tasks').select('*')
    expect(aTaskErr).toBeNull()
    expect(aTasks?.some((t) => t.workspace_id === wsA)).toBe(true)

    const { data: aLabels, error: aLabelErr } = await clientA.from('labels').select('*')
    expect(aLabelErr).toBeNull()
    expect(aLabels?.some((l) => l.workspace_id === wsA)).toBe(true)

    const { data: aNotes, error: aNoteErr } = await clientA.from('notes').select('*')
    expect(aNoteErr).toBeNull()
    expect(aNotes?.some((n) => n.workspace_id === wsA)).toBe(true)

    const { data: workspaces, error: wsErr } = await clientB.from('workspaces').select('*')
    expect(wsErr).toBeNull()
    expect(workspaces).toEqual([])

    const { data: tasks, error: taskErr } = await clientB.from('tasks').select('*')
    expect(taskErr).toBeNull()
    expect(tasks).toEqual([])

    const { data: labels, error: labelErr } = await clientB.from('labels').select('*')
    expect(labelErr).toBeNull()
    expect(labels).toEqual([])

    const { data: notes, error: noteErr } = await clientB.from('notes').select('*')
    expect(noteErr).toBeNull()
    expect(notes).toEqual([])
  })

  it("by identifier — B selects A's workspace by id and gets an empty result, not an error (SC-002)", async () => {
    // Positive control (finding 3 / advisory a4): confirm A can still read
    // its own workspace by id before checking B cannot — otherwise a T023
    // swap that broke the `using` clause for everyone would leave the
    // empty-result assertion below green for the wrong reason.
    const clientA = await clientFor(userA)
    const { data: aData, error: aErr } = await clientA.from('workspaces').select('*').eq('id', wsA)
    expect(aErr).toBeNull()
    expect(aData).toHaveLength(1)

    const clientB = await clientFor(userB)
    const { data, error } = await clientB.from('workspaces').select('*').eq('id', wsA)
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it("mirrors rls-two-accounts acceptance 2 — B's insert into A's workspace id is refused", async () => {
    const clientB = await clientFor(userB)
    const { data, error } = await clientB
      .from('tasks')
      .insert({ id: randomUUID(), user_id: userB.user.id, workspace_id: wsA, title: "B's task in A's workspace" })
      .select()

    // Finding 2: with wsA genuinely seeded (in beforeAll, owned by A), this
    // refusal is the RLS write predicate's `with check` failing — 42501 —
    // not a foreign-key violation on an absent row (23503). Tightening this
    // is legitimate here (unlike rls-two-accounts.test.ts:111's deliberate
    // looseness, which is bound by T027's P0-unedited gate): this file is
    // new and outside that gate.
    expect(error?.code).toBe('42501')
    expect(data).toBeNull()

    const { data: labelData, error: labelError } = await clientB
      .from('labels')
      .insert({ id: randomUUID(), user_id: userB.user.id, workspace_id: wsA, name: "B's label in A's workspace" })
      .select()
    expect(labelError?.code).toBe('42501')
    expect(labelData).toBeNull()

    const { data: noteData, error: noteError } = await clientB
      .from('notes')
      // `kind: 'file'` here is notes.kind ('folder'|'file'), unrelated to
      // this feature's workspaces.kind — just a valid note row to attempt.
      .insert({
        id: randomUUID(),
        user_id: userB.user.id,
        workspace_id: wsA,
        kind: 'file',
        name: "B's note in A's workspace",
      })
      .select()
    expect(noteError?.code).toBe('42501')
    expect(noteData).toBeNull()
  })

  it("by identifier, on write — B's update of A's workspace by id matches nothing, not an error (SC-002)", async () => {
    // Positive control (finding 3 / advisory a4): confirm A can still
    // update its own workspace by id before checking B's update matches
    // nothing — otherwise a T023 swap that broke the `workspaces` UPDATE
    // predicate for everyone would leave `error === null, data === []`
    // green for the wrong reason.
    const clientA = await clientFor(userA)
    const { data: aData, error: aErr } = await clientA
      .from('workspaces')
      .update({ name: 'renamed by A' })
      .eq('id', wsA)
      .select()
    expect(aErr).toBeNull()
    expect(aData).toHaveLength(1)

    const clientB = await clientFor(userB)
    const { data, error } = await clientB
      .from('workspaces')
      .update({ name: 'renamed by B' })
      .eq('id', wsA)
      .select()

    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('a third kind value is refused by the backend, at creation (US1 acceptance 4, FR-001)', async () => {
    const clientA = await clientFor(userA)
    const { data, error } = await clientA
      .from('workspaces')
      .insert({ id: randomUUID(), user_id: userA.user.id, name: 'bad kind at creation', kind: 'bogus' })
      .select()

    expect(error?.code).toBe('23514') // check_violation: workspaces_kind_check
    expect(data).toBeNull()
  })

  it('a third kind value is refused by the backend, at an update (US1 acceptance 4, FR-001)', async () => {
    const clientA = await clientFor(userA)
    const { data, error } = await clientA.from('workspaces').update({ kind: 'bogus' }).eq('id', wsA).select()

    expect(error?.code).toBe('23514') // check_violation: workspaces_kind_check
    expect(data).toBeNull()

    const { data: reread } = await clientA.from('workspaces').select('kind').eq('id', wsA).single()
    expect(reread?.kind).toBe('personal')
  })

  it(
    "a non-owner's attempt to change kind on a personal workspace matches nothing, same as B's other " +
      'writes against it above (contracts/policies.sql:116-122, D-6′ — no pin trigger, ordinary ' +
      'column, unchanged owner-only write predicate)',
    async () => {
      const clientB = await clientFor(userB)
      const { data, error } = await clientB.from('workspaces').update({ kind: 'team' }).eq('id', wsA).select()

      expect(error).toBeNull()
      expect(data).toEqual([])

      const clientA = await clientFor(userA)
      const { data: reread } = await clientA.from('workspaces').select('kind').eq('id', wsA).single()
      expect(reread?.kind).toBe('personal')
    },
  )

  it("mirrors rls-two-accounts acceptance 3 — B's insert into B's own workspace succeeds", async () => {
    const clientB = await clientFor(userB)
    const wsB = randomUUID()
    const { error: wsErr } = await clientB
      .from('workspaces')
      .insert({ id: wsB, user_id: userB.user.id, name: 'B personal workspace' })
    expect(wsErr).toBeNull()

    const { data, error } = await clientB
      .from('tasks')
      .insert({ id: randomUUID(), user_id: userB.user.id, workspace_id: wsB, title: "B's own task" })
      .select()

    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  })

  it(
    "mirrors rls-two-accounts acceptance 4 — B still sees a row of B's own that points at a workspace " +
      'B does not own (read half stays loose)',
    async () => {
      const clientB = await clientFor(userB)

      // Seeded directly against the running stack, exactly as
      // rls-two-accounts does, so it exists regardless of the write-side
      // policy: simulates a row that arrived by sync before its workspace
      // synced, not one that could pass B's own insert check above.
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

  it('the delete cascade and stay-deleted behaviour are observably as before (US4 acceptance 3)', async () => {
    const clientA = await clientFor(userA)
    const stamp = () => new Date().toISOString()

    const workspaceId = randomUUID()
    const existingTaskId = randomUUID()

    const { error: wsInsertError } = await clientA.from('workspaces').insert({
      id: workspaceId,
      user_id: userA.user.id,
      name: 'to be deleted (personal)',
      created_at: stamp(),
      updated_at: stamp(),
      deleted: false,
    })
    expect(wsInsertError).toBeNull()

    const { error: existingTaskInsertError } = await clientA.from('tasks').insert({
      id: existingTaskId,
      user_id: userA.user.id,
      workspace_id: workspaceId,
      title: 'already there when the workspace was deleted',
      created_at: stamp(),
      updated_at: stamp(),
      deleted: false,
    })
    expect(existingTaskInsertError).toBeNull()

    // follow_workspace_delete (AFTER UPDATE) reaches every child already
    // live, same as soft-delete.test.ts's T022 acceptance 3.
    const { error: wsDeleteError } = await clientA
      .from('workspaces')
      .update({ deleted: true, updated_at: stamp() })
      .eq('id', workspaceId)
    expect(wsDeleteError).toBeNull()

    const { data: existingAfterCascade, error: existingReadError } = await clientA
      .from('tasks')
      .select('deleted')
      .eq('id', existingTaskId)
      .single()
    expect(existingReadError).toBeNull()
    expect(existingAfterCascade?.deleted).toBe(true)

    // stay_deleted_with_workspace (BEFORE INSERT) forces a late child
    // deleted on arrival, same as soft-delete.test.ts's T022 acceptance 2.
    const lateTaskId = randomUUID()
    const { data: lateTask, error: lateInsertError } = await clientA
      .from('tasks')
      .insert({
        id: lateTaskId,
        user_id: userA.user.id,
        workspace_id: workspaceId,
        title: 'sent after the workspace was already deleted',
        created_at: stamp(),
        updated_at: stamp(),
        deleted: false, // what an offline device still believes
      })
      .select('deleted')
      .single()
    expect(lateInsertError).toBeNull()
    expect(lateTask?.deleted).toBe(true)
  })
})
