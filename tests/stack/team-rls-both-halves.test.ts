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
 * Scope: T012 (the executed inversion demonstration, FR-013/SC-005) is written here, as the
 * file's last `describe` block, directly reusing `teamWorkspaceId`/`aPersonalWorkspaceId`/
 * `userA`/`userB`/`userC` and one raw `pg` transaction per demonstration (see that block's own
 * header comment for the technique and the table/technique choices).
 *
 * T013 (the R-7 `user_id`-does-not-drift assertion, FR-011) lives inside the labels/tasks/notes
 * `describe.each` block above, as the third `it` per table, immediately after the "write half —
 * B creates, edits and deletes" case whose seeded row (`seededRowIds[table]`, created by A) it
 * reuses. It greens at T022 (the `<t>_zz_keep_creator` trigger) + T023 (the widened child write
 * half) together — T022 alone leaves the write refused outright (no membership branch yet to
 * admit B), and T023 alone leaves the trigger absent to reset `user_id` back to A.
 *
 * T012 joins the same pre-T020 red as every other case in this file, and for the same reason:
 * this file's top-level `beforeAll` throws before any `it` runs, so T012's cases never reach
 * their own bodies today either — see that block's header comment for whether a *personal*-only
 * demonstration could, in principle, run without `kind`/`members` (it could not, in this file:
 * the shared seed dies on the team-workspace insert, which comes first, before any personal
 * workspace is ever created).
 *
 * NOT discriminated by the insert-only cases elsewhere in this file: T023's membership branch
 * being conjoined with `auth.uid() = user_id` (rather than OR'd, as it must be) on the
 * child-table write half. Every write-half insert case here has B insert with
 * `user_id = userB.user.id` (a true membership grant), so `auth.uid() = user_id` is trivially
 * true regardless of how the branches combine — a wrongly-conjoined predicate would pass those
 * cases exactly as a correctly-OR'd one would. T013's case is what catches it, incidentally: it
 * sends `user_id: userB.user.id` too (mirroring `sync.ts:216`'s push payload exactly), but
 * `<t>_zz_keep_creator` resets `new.user_id` back to A's id *before* WITH CHECK is evaluated
 * (BEFORE ROW triggers run first), so by the time the predicate runs, `auth.uid()` (B) and
 * `user_id` (A) genuinely differ — the one shape this file otherwise never produces.
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
// ---------------------------------------------------------------------------------------------
// T012 helpers — the executed inversion demonstration (FR-013, SC-005, plan.md D-13).
//
// Each demonstration below opens its own `pg` connection and one transaction that always rolls
// back (`try { … } finally { rollback }`, never a bare sequential rollback an assertion's throw
// could skip), drops and recreates `own_rows` with one half's *actual, currently-deployed* text
// negated, and observes the outcome flip under `set local role authenticated` + `set local
// request.jwt.claims` — exactly the plan.md D-13 pseudocode, one connection, one transaction, DDL
// that Postgres never commits.
//
// The predicate text is read back from `pg_policies` rather than retyped from
// `contracts/policies.sql`: this makes the demonstration correct against whatever is *actually*
// deployed at run time — today's pre-T020 `auth.uid() = user_id` as much as T023's membership
// predicate — rather than a guess of what T023 will land verbatim. A hand-copied assumption would
// be the thing to distrust here, not the introspected text.
//
// Technique chosen — invert (negate), not equalize: FR-013/the card allow either, but on a
// *personal* workspace, equalizing tasks' read half to its write half is a no-op with these
// fixtures (`is_member` is always false for a personal workspace, and the write half's ownership
// `exists(...)` clause is tautologically true whenever `auth.uid() = user_id`, which is exactly
// when the read half already admits the caller) — so equalizing would not flip anything on
// personal and would silently fail to demonstrate SC-005 there. Negation flips every combination
// below deterministically, so it is used uniformly for personal and team alike.
//
// Tables chosen — `tasks` AND `workspaces`, not `labels`/`notes`. FR-013 names no table at all,
// so `tasks` alone discharges it; SC-005's own text is "either half of either table", and a
// reviewer applying that literally would not accept one table as "either table" — so `workspaces`
// is demonstrated too, closing SC-005 on its plain reading rather than leaving an argument for
// T057's whole-branch review. `tasks` is the sharpest of the three child tables (read AND write
// halves both carry a membership branch), and `labels`/`notes` carry the exact same predicate
// shape as `tasks` — two more near-identical copies would buy no additional coverage and only
// make this block harder to read, so they are deliberately left out.
//
// `workspaces` is structurally different from the child tables in a way worth calling out before
// the four cases below: its read half is the interesting one at T023 (it widens with
// `public.is_member(id)`, so the team case below exercises owner, member AND stranger, same as
// `tasks`), but its write half is owner-only unconditionally for both kinds — there is no
// membership branch to invert there at all. SC-005 does not ask that personal and team differ on
// this half, only that inverting it fails a check, so both kinds are demonstrated anyway; the two
// write-half cases end up looking structurally similar (one flips the owner alone, the personal
// case, because `workspaces` has no related-row `exists()` clause the way the child tables do, so
// USING excludes a personal stranger before WITH CHECK is ever reached; the other flips the owner
// AND the member, the team case, because membership admits the member past USING first). That
// similarity is intentional, not a copy-paste leftover — see each case's own comment.
//
// Independent of execution order — each demonstration re-affirms (via `ensureTeamMembership`,
// upserted inside its own transaction, as the bypass-RLS `postgres` role, and rolled back with
// everything else) that A is owner and B is member of `teamWorkspaceId`, rather than trusting
// whatever state a sibling `describe` (in particular "post-removal", which soft-deletes B's
// membership in its own `beforeAll` with no reversal) happened to leave behind. Depending on
// declaration-order execution to still find B a live member would be exactly the kind of
// cross-block state bleed the file's other structural traps warn about.
async function runAsClaim(client: Client, userId: string, sql: string, params: unknown[] = []): Promise<unknown[]> {
  await client.query('set local role authenticated')
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId })])
  const res = await client.query(sql, params)
  await client.query('reset role')
  return res.rows
}

/** A write attempt as a specific claimed user, savepointed so a `42501` (or any other error)
 * leaves the outer transaction usable for the next attempt — without the savepoint, one refused
 * insert would abort every statement after it, including the later `rollback`'s sibling
 * assertions and the policy-swap DDL itself. */
async function tryWriteAsClaim(
  client: Client,
  userId: string,
  sql: string,
  params: unknown[],
): Promise<{ ok: boolean; code?: string }> {
  await client.query('savepoint t012_attempt')
  try {
    await client.query('set local role authenticated')
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId })])
    await client.query(sql, params)
    await client.query('reset role')
    await client.query('release savepoint t012_attempt')
    return { ok: true }
  } catch (err) {
    await client.query('rollback to savepoint t012_attempt')
    await client.query('reset role')
    return { ok: false, code: (err as { code?: string }).code }
  }
}

/** An UPDATE attempt as a specific claimed user, for tables (namely `workspaces`) where "refused"
 * can mean either of two different things and the demonstration needs to tell them apart: a row
 * that fails the read half's USING clause simply matches nothing (`rowCount: 0`, no exception —
 * the same 204-with-no-error shape PostgREST returns), while a row that passes USING but whose
 * new values then fail WITH CHECK raises a real `42501`. `tryWriteAsClaim`'s INSERT-only,
 * exception-or-nothing shape can't distinguish these, so this is a separate helper rather than a
 * shared one pretending an UPDATE is an INSERT. Savepointed for the same reason as
 * `tryWriteAsClaim`. */
async function tryUpdateAsClaim(
  client: Client,
  userId: string,
  sql: string,
  params: unknown[],
): Promise<{ rowCount: number; code?: string }> {
  await client.query('savepoint t012_attempt')
  try {
    await client.query('set local role authenticated')
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId })])
    const res = await client.query(sql, params)
    await client.query('reset role')
    await client.query('release savepoint t012_attempt')
    return { rowCount: res.rowCount ?? 0 }
  } catch (err) {
    await client.query('rollback to savepoint t012_attempt')
    await client.query('reset role')
    return { rowCount: 0, code: (err as { code?: string }).code }
  }
}

/** The two halves of `own_rows` on `table`, exactly as currently deployed — introspected, never
 * retyped from the contract, so the demonstration is honest about what it is actually inverting. */
async function fetchPolicyHalves(client: Client, table: string): Promise<{ qual: string; withCheck: string }> {
  const { rows } = await client.query(
    `select qual, with_check from pg_policies where schemaname = 'public' and tablename = $1 and policyname = 'own_rows'`,
    [table],
  )
  if (rows.length !== 1) {
    throw new Error(`fetchPolicyHalves(${table}): expected exactly one own_rows policy, found ${rows.length}`)
  }
  return { qual: rows[0].qual as string, withCheck: rows[0].with_check as string }
}

async function installPolicy(client: Client, table: string, usingClause: string, checkClause: string): Promise<void> {
  await client.query(`drop policy own_rows on public.${table}`)
  await client.query(`create policy own_rows on public.${table} for all using (${usingClause}) with check (${checkClause})`)
}

/** Upserts A as owner and B as an active member of `workspaceId`, regardless of what a sibling
 * `describe` in this file left behind — see the block comment above for why this must not depend
 * on declaration order. Run as the bypass-RLS `postgres` role, inside the caller's own
 * rolled-back transaction. */
async function ensureTeamMembership(client: Client, workspaceId: string, ownerId: string, memberId: string): Promise<void> {
  await client.query(
    `insert into public.members (id, user_id, workspace_id, member_id, level, deleted)
     values ($1, $2, $3, $2, 'owner', false)
     on conflict (workspace_id, member_id) do update set deleted = false, level = 'owner'`,
    [randomUUID(), ownerId, workspaceId],
  )
  await client.query(
    `insert into public.members (id, user_id, workspace_id, member_id, level, deleted)
     values ($1, $2, $3, $4, 'member', false)
     on conflict (workspace_id, member_id) do update set deleted = false, level = 'member'`,
    [randomUUID(), ownerId, workspaceId, memberId],
  )
}

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

    it(`write half — B's edit of A's ${table} row does not drift user_id from A (R-7, FR-011; card T013)`, async () => {
      // `seededRowIds[table]` is the row A created in the shared `beforeAll`, untouched by the
      // "write half — B creates, edits and deletes" case above (that test operates on its own,
      // separately-inserted row) — so its `user_id` is still genuinely A's going in.
      //
      // The stamp must genuinely outrank the row's own, or `keep_newer()` (schema.sql:142-153)
      // silently cancels the whole update — a 204 with `error === null` that would leave
      // `user_id` trivially unchanged and this case green while proving nothing. Read the row's
      // current `updated_at` back from Postgres and add to it, rather than using the host clock
      // (Docker Desktop / WSL2 clock skew trap).
      const seedClient = await pg()
      let newStamp: string
      try {
        const { rows } = await seedClient.query(
          `select updated_at from public.${table} where id = $1`,
          [seededRowIds[table]],
        )
        expect(rows).toHaveLength(1)
        const currentUpdatedAt = rows[0].updated_at as Date
        newStamp = new Date(currentUpdatedAt.getTime() + 60_000).toISOString()
      } finally {
        await seedClient.end()
      }

      // `notes` has no `title` column (schema.sql:79-90) — only `tasks` is titled, the other
      // two child tables are named.
      const editFieldKey = table === 'tasks' ? 'title' : 'name'

      // Mirrors `src/sync/sync.ts:216`'s push payload exactly: the client stamps its own
      // `user_id` on every row it sends, member or not — `payload = batch.map((row) => ({
      // ...forServer(table, row), user_id: userId }))`. This is *why* `<t>_zz_keep_creator`
      // is needed at all: without it, B's genuinely-sent `user_id` would land untouched. An
      // update that only sets `editFieldKey` would never give the trigger anything to
      // overwrite, and such a case would stay green even with the trigger dropped — exactly
      // the decorative trap this card is written against.
      const clientB = await asUser(userB)
      const { data: edited, error: editErr } = await clientB
        .from(table)
        .update({ [editFieldKey]: 'edited by B (R-7)', user_id: userB.user.id, updated_at: newStamp })
        .eq('id', seededRowIds[table])
        .select()

      // Positive control, in the same block: B's edit actually landed. Without this half, a
      // T023 regression that refuses B's writes outright would leave the row untouched —
      // `user_id` trivially still A's — and the assertion below would pass while proving
      // nothing. `.select()` is load-bearing for the same reason noted above: a PostgREST
      // UPDATE whose USING half matches nothing returns 204 with no error at all.
      expect(editErr).toBeNull()
      expect(edited).toHaveLength(1)
      expect((edited?.[0] as Record<string, unknown> | undefined)?.[editFieldKey]).toBe('edited by B (R-7)')

      // The R-7 assertion itself, read back server-side over a direct `pg` connection (not
      // merely trusted from the PostgREST response): `user_id` still names A, who created the
      // row — never B, who only edited it. `<t>_zz_keep_creator` is what resets
      // `new.user_id := old.user_id` before WITH CHECK is ever evaluated; drop it and B's
      // genuinely-sent `user_id` lands untouched, and this assertion goes red.
      const verifyClient = await pg()
      try {
        const { rows } = await verifyClient.query(
          `select user_id from public.${table} where id = $1`,
          [seededRowIds[table]],
        )
        expect(rows).toHaveLength(1)
        expect(rows[0].user_id).toBe(userA.user.id)
      } finally {
        await verifyClient.end()
      }
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

  describe('T012 — executed inversion demonstration on own_rows (FR-013, SC-005)', () => {
    it("read half inverted — personal workspace: the owner's access and a stranger's both flip", async () => {
      const client = await pg()
      try {
        await client.query('begin')
        const taskId = randomUUID()
        // Seeded as the bypass-RLS `postgres` role — RLS is not under test at seeding time,
        // exactly as the file's own beforeAll seeds (see file header).
        await client.query(
          `insert into public.tasks (id, user_id, workspace_id, title) values ($1, $2, $3, $4)`,
          [taskId, userA.user.id, aPersonalWorkspaceId, 'T012 personal probe'],
        )

        const { qual, withCheck } = await fetchPolicyHalves(client, 'tasks')

        // Baseline, under the real, currently-deployed read half: the owner sees the row (a
        // positive control for the stranger's zero right below it), the stranger sees nothing.
        const baselineOwner = await runAsClaim(client, userA.user.id, 'select id from public.tasks where id = $1', [taskId])
        const baselineStranger = await runAsClaim(client, userB.user.id, 'select id from public.tasks where id = $1', [taskId])
        expect(baselineOwner).toHaveLength(1)
        expect(baselineStranger).toHaveLength(0)

        await installPolicy(client, 'tasks', `not (${qual})`, withCheck)

        const mutatedOwner = await runAsClaim(client, userA.user.id, 'select id from public.tasks where id = $1', [taskId])
        const mutatedStranger = await runAsClaim(client, userB.user.id, 'select id from public.tasks where id = $1', [taskId])

        // The flip itself, not merely a new outcome: each caller's mutated result must differ
        // from that same caller's baseline above.
        expect(mutatedOwner).not.toHaveLength(baselineOwner.length)
        expect(mutatedStranger).not.toHaveLength(baselineStranger.length)
        expect(mutatedOwner).toHaveLength(0)
        expect(mutatedStranger).toHaveLength(1)
      } finally {
        await client.query('rollback').catch(() => {})
        await client.end()
      }
    })

    it("read half inverted — team workspace: owner, member and a non-member stranger all flip", async () => {
      const client = await pg()
      try {
        await client.query('begin')
        await ensureTeamMembership(client, teamWorkspaceId, userA.user.id, userB.user.id)
        const taskId = seededRowIds.tasks

        const { qual, withCheck } = await fetchPolicyHalves(client, 'tasks')

        // Baseline: owner and member both see A's seeded row (each a positive control for the
        // stranger's zero); the stranger sees nothing.
        const baselineOwner = await runAsClaim(client, userA.user.id, 'select id from public.tasks where id = $1', [taskId])
        const baselineMember = await runAsClaim(client, userB.user.id, 'select id from public.tasks where id = $1', [taskId])
        const baselineStranger = await runAsClaim(client, userC.user.id, 'select id from public.tasks where id = $1', [taskId])
        expect(baselineOwner).toHaveLength(1)
        expect(baselineMember).toHaveLength(1)
        expect(baselineStranger).toHaveLength(0)

        await installPolicy(client, 'tasks', `not (${qual})`, withCheck)

        const mutatedOwner = await runAsClaim(client, userA.user.id, 'select id from public.tasks where id = $1', [taskId])
        const mutatedMember = await runAsClaim(client, userB.user.id, 'select id from public.tasks where id = $1', [taskId])
        const mutatedStranger = await runAsClaim(client, userC.user.id, 'select id from public.tasks where id = $1', [taskId])

        expect(mutatedOwner).not.toHaveLength(baselineOwner.length)
        expect(mutatedMember).not.toHaveLength(baselineMember.length)
        expect(mutatedStranger).not.toHaveLength(baselineStranger.length)
        expect(mutatedOwner).toHaveLength(0)
        expect(mutatedMember).toHaveLength(0)
        expect(mutatedStranger).toHaveLength(1)
      } finally {
        await client.query('rollback').catch(() => {})
        await client.end()
      }
    })

    it("write half inverted — personal workspace: the owner's insert and a stranger's insert both flip", async () => {
      const client = await pg()
      try {
        await client.query('begin')
        const { qual, withCheck } = await fetchPolicyHalves(client, 'tasks')

        const insertSql = `insert into public.tasks (id, user_id, workspace_id, title) values ($1, $2, $3, $4)`
        const ownerRowId = randomUUID()
        const strangerRowId = randomUUID()

        // Baseline, under the real, currently-deployed write half: the owner's own insert is
        // accepted (a positive control for the stranger's refusal right below it), the
        // stranger's is refused with a real 42501.
        const baselineOwner = await tryWriteAsClaim(client, userA.user.id, insertSql, [
          ownerRowId,
          userA.user.id,
          aPersonalWorkspaceId,
          'T012 owner insert',
        ])
        const baselineStranger = await tryWriteAsClaim(client, userB.user.id, insertSql, [
          strangerRowId,
          userB.user.id,
          aPersonalWorkspaceId,
          'T012 stranger insert',
        ])
        expect(baselineOwner.ok).toBe(true)
        expect(baselineStranger.ok).toBe(false)
        expect(baselineStranger.code).toBe('42501')

        await installPolicy(client, 'tasks', qual, `not (${withCheck})`)

        const mutatedOwner = await tryWriteAsClaim(client, userA.user.id, insertSql, [
          randomUUID(),
          userA.user.id,
          aPersonalWorkspaceId,
          'T012 owner insert (mutated)',
        ])
        const mutatedStranger = await tryWriteAsClaim(client, userB.user.id, insertSql, [
          randomUUID(),
          userB.user.id,
          aPersonalWorkspaceId,
          'T012 stranger insert (mutated)',
        ])

        expect(mutatedOwner.ok).not.toBe(baselineOwner.ok)
        expect(mutatedStranger.ok).not.toBe(baselineStranger.ok)
        expect(mutatedOwner.ok).toBe(false)
        expect(mutatedOwner.code).toBe('42501')
        expect(mutatedStranger.ok).toBe(true)
      } finally {
        await client.query('rollback').catch(() => {})
        await client.end()
      }
    })

    it('write half inverted — team workspace: owner, member and a non-member stranger all flip', async () => {
      const client = await pg()
      try {
        await client.query('begin')
        await ensureTeamMembership(client, teamWorkspaceId, userA.user.id, userB.user.id)
        const { qual, withCheck } = await fetchPolicyHalves(client, 'tasks')

        const insertSql = `insert into public.tasks (id, user_id, workspace_id, title) values ($1, $2, $3, $4)`

        // Baseline: owner (ownership branch) and member (membership branch) both succeed, each a
        // positive control for the non-member stranger's refusal right below them.
        const baselineOwner = await tryWriteAsClaim(client, userA.user.id, insertSql, [
          randomUUID(),
          userA.user.id,
          teamWorkspaceId,
          'T012 owner insert',
        ])
        const baselineMember = await tryWriteAsClaim(client, userB.user.id, insertSql, [
          randomUUID(),
          userB.user.id,
          teamWorkspaceId,
          'T012 member insert',
        ])
        const baselineStranger = await tryWriteAsClaim(client, userC.user.id, insertSql, [
          randomUUID(),
          userC.user.id,
          teamWorkspaceId,
          'T012 stranger insert',
        ])
        expect(baselineOwner.ok).toBe(true)
        expect(baselineMember.ok).toBe(true)
        expect(baselineStranger.ok).toBe(false)
        expect(baselineStranger.code).toBe('42501')

        await installPolicy(client, 'tasks', qual, `not (${withCheck})`)

        const mutatedOwner = await tryWriteAsClaim(client, userA.user.id, insertSql, [
          randomUUID(),
          userA.user.id,
          teamWorkspaceId,
          'T012 owner insert (mutated)',
        ])
        const mutatedMember = await tryWriteAsClaim(client, userB.user.id, insertSql, [
          randomUUID(),
          userB.user.id,
          teamWorkspaceId,
          'T012 member insert (mutated)',
        ])
        const mutatedStranger = await tryWriteAsClaim(client, userC.user.id, insertSql, [
          randomUUID(),
          userC.user.id,
          teamWorkspaceId,
          'T012 stranger insert (mutated)',
        ])

        expect(mutatedOwner.ok).not.toBe(baselineOwner.ok)
        expect(mutatedMember.ok).not.toBe(baselineMember.ok)
        expect(mutatedStranger.ok).not.toBe(baselineStranger.ok)
        expect(mutatedOwner.ok).toBe(false)
        expect(mutatedOwner.code).toBe('42501')
        expect(mutatedMember.ok).toBe(false)
        expect(mutatedMember.code).toBe('42501')
        expect(mutatedStranger.ok).toBe(true)
      } finally {
        await client.query('rollback').catch(() => {})
        await client.end()
      }
    })

    // -----------------------------------------------------------------------------------------
    // `workspaces` counterparts (coordinator review: SC-005 says "either table", and one table
    // alone would leave that reading open to argument at T057). Read half is the one that widens
    // with `is_member(id)` at T023 — the team case below asserts owner, member AND stranger, same
    // shape as `tasks`' read-half cases. Write half is owner-only, unconditionally, for both
    // kinds — see the block's own header comment for why the two write-half cases below look
    // structurally different from each other in how many callers flip (one for personal, two for
    // team) despite testing "the same" owner-only clause: that asymmetry is `workspaces` having no
    // related-row `exists()` clause the way the child tables do, so USING alone excludes a
    // personal stranger before WITH CHECK is ever reached, whereas team membership admits the
    // member past USING first. Neither case is a placeholder or a copy of the other.

    it("read half inverted — personal workspace (workspaces): the owner's access and a stranger's both flip", async () => {
      const client = await pg()
      try {
        await client.query('begin')
        const { qual, withCheck } = await fetchPolicyHalves(client, 'workspaces')

        // Baseline, under the real, currently-deployed read half: the owner sees the workspace (a
        // positive control for the stranger's zero right below it), the stranger sees nothing.
        const baselineOwner = await runAsClaim(client, userA.user.id, 'select id from public.workspaces where id = $1', [
          aPersonalWorkspaceId,
        ])
        const baselineStranger = await runAsClaim(client, userB.user.id, 'select id from public.workspaces where id = $1', [
          aPersonalWorkspaceId,
        ])
        expect(baselineOwner).toHaveLength(1)
        expect(baselineStranger).toHaveLength(0)

        await installPolicy(client, 'workspaces', `not (${qual})`, withCheck)

        const mutatedOwner = await runAsClaim(client, userA.user.id, 'select id from public.workspaces where id = $1', [
          aPersonalWorkspaceId,
        ])
        const mutatedStranger = await runAsClaim(client, userB.user.id, 'select id from public.workspaces where id = $1', [
          aPersonalWorkspaceId,
        ])

        expect(mutatedOwner).not.toHaveLength(baselineOwner.length)
        expect(mutatedStranger).not.toHaveLength(baselineStranger.length)
        expect(mutatedOwner).toHaveLength(0)
        expect(mutatedStranger).toHaveLength(1)
      } finally {
        await client.query('rollback').catch(() => {})
        await client.end()
      }
    })

    it('read half inverted — team workspace (workspaces): owner, member and a non-member stranger all flip', async () => {
      const client = await pg()
      try {
        await client.query('begin')
        await ensureTeamMembership(client, teamWorkspaceId, userA.user.id, userB.user.id)
        const { qual, withCheck } = await fetchPolicyHalves(client, 'workspaces')

        // Baseline: owner and member both see the team workspace (each a positive control for the
        // stranger's zero); the stranger sees nothing — this is the half that is supposed to
        // widen at T023 (`is_member(id)`), so a dead membership branch here is exactly what this
        // case exists to catch.
        const baselineOwner = await runAsClaim(client, userA.user.id, 'select id from public.workspaces where id = $1', [
          teamWorkspaceId,
        ])
        const baselineMember = await runAsClaim(client, userB.user.id, 'select id from public.workspaces where id = $1', [
          teamWorkspaceId,
        ])
        const baselineStranger = await runAsClaim(client, userC.user.id, 'select id from public.workspaces where id = $1', [
          teamWorkspaceId,
        ])
        expect(baselineOwner).toHaveLength(1)
        expect(baselineMember).toHaveLength(1)
        expect(baselineStranger).toHaveLength(0)

        await installPolicy(client, 'workspaces', `not (${qual})`, withCheck)

        const mutatedOwner = await runAsClaim(client, userA.user.id, 'select id from public.workspaces where id = $1', [
          teamWorkspaceId,
        ])
        const mutatedMember = await runAsClaim(client, userB.user.id, 'select id from public.workspaces where id = $1', [
          teamWorkspaceId,
        ])
        const mutatedStranger = await runAsClaim(client, userC.user.id, 'select id from public.workspaces where id = $1', [
          teamWorkspaceId,
        ])

        expect(mutatedOwner).not.toHaveLength(baselineOwner.length)
        expect(mutatedMember).not.toHaveLength(baselineMember.length)
        expect(mutatedStranger).not.toHaveLength(baselineStranger.length)
        expect(mutatedOwner).toHaveLength(0)
        expect(mutatedMember).toHaveLength(0)
        expect(mutatedStranger).toHaveLength(1)
      } finally {
        await client.query('rollback').catch(() => {})
        await client.end()
      }
    })

    it("write half inverted — personal workspace (workspaces): the owner's rename flips; a stranger's stays refused throughout", async () => {
      const client = await pg()
      try {
        await client.query('begin')
        const { qual, withCheck } = await fetchPolicyHalves(client, 'workspaces')
        const updateSql = 'update public.workspaces set name = $1 where id = $2'

        // Baseline, under the real, currently-deployed write half: the owner's own rename is
        // accepted (a positive control for the mutated refusal below), the stranger's matches no
        // row at all — `workspaces` has no related-row `exists()` clause, so the read half alone
        // (unchanged by this demonstration) already excludes a personal stranger; that refusal
        // shape (rowCount 0, no error) cannot flip by inverting WITH CHECK, because the row is
        // never reached — this is the read half's job, tested separately above, not this one's.
        const baselineOwner = await tryUpdateAsClaim(client, userA.user.id, updateSql, ['renamed by A', aPersonalWorkspaceId])
        const baselineStranger = await tryUpdateAsClaim(client, userB.user.id, updateSql, [
          'renamed by B',
          aPersonalWorkspaceId,
        ])
        expect(baselineOwner.rowCount).toBe(1)
        expect(baselineStranger.rowCount).toBe(0)
        expect(baselineStranger.code).toBeUndefined()

        await installPolicy(client, 'workspaces', qual, `not (${withCheck})`)

        const mutatedOwner = await tryUpdateAsClaim(client, userA.user.id, updateSql, [
          'renamed by A (mutated)',
          aPersonalWorkspaceId,
        ])
        const mutatedStranger = await tryUpdateAsClaim(client, userB.user.id, updateSql, [
          'renamed by B (mutated)',
          aPersonalWorkspaceId,
        ])

        // The flip: the owner, previously accepted, is now refused with a real 42501 (passed
        // USING, failed the inverted CHECK). The stranger is asserted unchanged (still rowCount
        // 0, still no error) — named explicitly so it reads as a deliberate domain fact, not a
        // forgotten second flip.
        expect(mutatedOwner.rowCount).not.toBe(baselineOwner.rowCount)
        expect(mutatedOwner.rowCount).toBe(0)
        expect(mutatedOwner.code).toBe('42501')
        expect(mutatedStranger.rowCount).toBe(0)
        expect(mutatedStranger.code).toBeUndefined()
      } finally {
        await client.query('rollback').catch(() => {})
        await client.end()
      }
    })

    it('write half inverted — team workspace (workspaces): the owner and the member both flip; a non-member stranger stays refused throughout', async () => {
      const client = await pg()
      try {
        await client.query('begin')
        await ensureTeamMembership(client, teamWorkspaceId, userA.user.id, userB.user.id)
        const { qual, withCheck } = await fetchPolicyHalves(client, 'workspaces')
        const updateSql = 'update public.workspaces set name = $1 where id = $2'

        // Baseline: the owner's rename is accepted; the member's is admitted by USING (membership
        // widens the read half) but refused by the unchanged owner-only WITH CHECK — a real
        // 42501, the same shape the file's own FR-005 acceptance test above asserts directly. The
        // stranger, not a member, never reaches USING at all (rowCount 0, no error) — the read
        // half's job, not this one's, exactly as in the personal case above.
        const baselineOwner = await tryUpdateAsClaim(client, userA.user.id, updateSql, ['renamed by A', teamWorkspaceId])
        const baselineMember = await tryUpdateAsClaim(client, userB.user.id, updateSql, ['renamed by B', teamWorkspaceId])
        const baselineStranger = await tryUpdateAsClaim(client, userC.user.id, updateSql, ['renamed by C', teamWorkspaceId])
        expect(baselineOwner.rowCount).toBe(1)
        expect(baselineMember.rowCount).toBe(0)
        expect(baselineMember.code).toBe('42501')
        expect(baselineStranger.rowCount).toBe(0)
        expect(baselineStranger.code).toBeUndefined()

        await installPolicy(client, 'workspaces', qual, `not (${withCheck})`)

        const mutatedOwner = await tryUpdateAsClaim(client, userA.user.id, updateSql, [
          'renamed by A (mutated)',
          teamWorkspaceId,
        ])
        const mutatedMember = await tryUpdateAsClaim(client, userB.user.id, updateSql, [
          'renamed by B (mutated)',
          teamWorkspaceId,
        ])
        const mutatedStranger = await tryUpdateAsClaim(client, userC.user.id, updateSql, [
          'renamed by C (mutated)',
          teamWorkspaceId,
        ])

        // Two-way flip: the owner is now refused (42501); the member, previously refused, now
        // succeeds — USING still admits the member via membership, and the inverted CHECK now
        // accepts what it used to refuse. The stranger stays unmatched throughout, same reasoning
        // as the personal case's stranger.
        expect(mutatedOwner.rowCount).not.toBe(baselineOwner.rowCount)
        expect(mutatedMember.rowCount).not.toBe(baselineMember.rowCount)
        expect(mutatedOwner.rowCount).toBe(0)
        expect(mutatedOwner.code).toBe('42501')
        expect(mutatedMember.rowCount).toBe(1)
        expect(mutatedMember.code).toBeUndefined()
        expect(mutatedStranger.rowCount).toBe(0)
        expect(mutatedStranger.code).toBeUndefined()
      } finally {
        await client.query('rollback').catch(() => {})
        await client.end()
      }
    })
  })
})
