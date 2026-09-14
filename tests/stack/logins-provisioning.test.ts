import { randomUUID } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { Client } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  adminClient,
  asUser,
  createTestUser,
  createTestUsers,
  type TestUser,
} from '../harness/accounts'
import { ANON_KEY, API_URL, assertStackReachable, DB_URL } from '../harness/stack'

/*
 * US7 (spec.md), FR-037–FR-045, SC-015–SC-018, SC-021 — the whole
 * instance-admin provisioning surface (ADR-0006 §B/§C, plan.md D-16/D-17),
 * red-first per tasks.md T018. Letters (a)-(j) below are the card's own
 * lettering; the coordinator's clause (j) discharges T008's deferred verify
 * half (is_admin() called directly) verbatim.
 *
 * RED TODAY, for one reason: none of fork blocks A-E exist yet in
 * `supabase/schema.sql` -- no `workspaces.kind`, no `public.members`, no
 * `public.instance_admins`, no `is_admin()`/`is_owner()`/`is_member()`, none
 * of the five provisioning routines or `add_member_by_email` (tasks.md
 * T020-T026 land them in that order). Every `.rpc(...)` call and every
 * `kind: 'team' | 'personal'` insert below therefore fails at its first
 * query today; this file goes green with no edit once those cards land.
 *
 * FR-044 / R-15 discipline: every password below is obvious throwaway test
 * data, asserted only through `signInWithPassword`'s success/failure -- never
 * a real credential, never logged, never written to receipts.md.
 *
 * Fixture discipline: `tests/setup.ts` is an unedited P0 file (owner
 * decision 2026-09-14) and only clears Dexie tables, so this file clears its
 * own Postgres fixtures -- `public.members` before every test (`beforeEach`
 * below) and `public.instance_admins` explicitly, per test, through
 * `setAdmins()` -- rather than assuming either starts empty.
 */

let pg: Client
const createdUserIds = new Set<string>()

function track(id: string | undefined | null): void {
  if (id) createdUserIds.add(id)
}

let loginSeq = 0
/** Unique throwaway identifier for a login minted through `create_login`, distinct from
 *  the harness's own `createTestUser` accounts so a failure is traceable to this file. */
function uniqueLoginEmail(label: string): string {
  loginSeq += 1
  return `t018-${label}-${Date.now()}-${process.pid}-${loginSeq}@example.test`
}

/** Throwaway credential for a minted login -- never a literal, so nothing resembling a real
 *  password is ever typed into this file (FR-044 / R-15). Precedent: `tests/harness/accounts.ts:39`. */
function throwawayPassword(): string {
  return randomUUID()
}

/** A deliberately-short generated password for the DA011 "too short" case -- still not a
 *  literal, just truncated below the 8-character minimum. */
function shortThrowawayPassword(): string {
  return randomUUID().slice(0, 6)
}

/** Replaces the whole `instance_admins` table with exactly these ids -- deterministic
 *  admin state for a test, regardless of what an earlier test or trigger left behind. */
async function setAdmins(...userIds: string[]): Promise<void> {
  // Tolerates `public.instance_admins` not existing yet (T025 lands it): before then this probe
  // finds no relation and the delete/insert loop is skipped as a harmless no-op instead of
  // aborting the `beforeAll` that calls it -- which would otherwise skip every case in that
  // describe block. A case that genuinely needs admin state then fails on its own assertion,
  // which is the honest red. Probing the relation directly (rather than catching 42P01 from the
  // query) means a trigger that itself raises 42P01 against some other not-yet-landed relation
  // is never mistaken for "this table doesn't exist" and swallowed. Remove this tolerance once
  // T025 lands the table -- `to_regclass` will simply stop returning null.
  const { rows: probe } = await pg.query<{ to_regclass: string | null }>(
    "select to_regclass('public.instance_admins')",
  )
  if (probe[0]?.to_regclass === null) return
  await pg.query('delete from public.instance_admins')
  for (const id of userIds) {
    await pg.query('insert into public.instance_admins (user_id) values ($1)', [id])
  }
}

/** A fresh, non-persisting client signed in with a raw email/password (not a `TestUser`) --
 *  what a login minted by `create_login` actually gets handed. Throws on failure; use
 *  `trySignIn` where a refusal is the point of the assertion. */
async function signedInClient(email: string, password: string): Promise<SupabaseClient> {
  const client = createClient(API_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`signedInClient(${email}) failed: ${error.message}`)
  return client
}

/** Attempts a sign-in without throwing, for the cases where refusal is the assertion. */
function trySignIn(email: string, password: string) {
  const client = createClient(API_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return client.auth.signInWithPassword({ email, password })
}

beforeAll(async () => {
  await assertStackReachable()
  pg = new Client({ connectionString: DB_URL })
  await pg.connect()
}, 60_000)

afterAll(async () => {
  // try/finally so a throwing delete (e.g. a genuinely unexpected error, not the tolerated
  // "table doesn't exist yet" case) still lets `pg.end()` run -- otherwise the connection
  // leaks for the rest of the run instead of just failing this one hook.
  try {
    if (createdUserIds.size > 0) {
      await pg.query('delete from auth.users where id = any($1::uuid[])', [
        Array.from(createdUserIds),
      ])
    }
  } finally {
    await pg?.end()
  }
})

// Fixture hygiene for the fork-only `members` table (data-model.md §1); not touched by
// tests/setup.ts, which only knows about Dexie tables.
beforeEach(async () => {
  // Tolerates `public.members` not existing yet (T020 lands it): before then this probe finds
  // no relation and the delete is skipped as a harmless no-op instead of throwing, which would
  // otherwise abort the `beforeEach` and skip every remaining case in the file. Probing the
  // relation directly (rather than catching 42P01 from the delete) means a trigger that itself
  // raises 42P01 against some other not-yet-landed relation is never mistaken for "this table
  // doesn't exist" and swallowed, leaving stale `members` rows a later case would read as
  // fixture state. Remove this tolerance once T020 lands the table -- `to_regclass` will simply
  // stop returning null.
  const { rows: probe } = await pg.query<{ to_regclass: string | null }>(
    "select to_regclass('public.members')",
  )
  if (probe[0]?.to_regclass === null) return
  await pg.query('delete from public.members')
})

describe('(a) users_seed_first_admin -- the first-account trigger (FR-037)', () => {
  it('grants exactly one admin from an empty instance_admins, and a second insert adds no more', async () => {
    // Isolated from every other case in this file on purpose: this is the one place
    // `adminClient` must not be used, because it asserts the trigger's own behaviour
    // against a genuinely empty table, not a table this test seeded by hand.
    await pg.query('delete from public.instance_admins')

    const first = await createTestUser('a-first')
    track(first.user.id)
    const { rows: afterFirst } = await pg.query<{ user_id: string }>(
      'select user_id from public.instance_admins',
    )
    expect(afterFirst).toHaveLength(1)
    expect(afterFirst[0].user_id).toBe(first.user.id)

    const second = await createTestUser('a-second')
    track(second.user.id)
    const { rows: afterSecond } = await pg.query<{ user_id: string }>(
      'select user_id from public.instance_admins',
    )
    expect(afterSecond).toHaveLength(1)
    expect(afterSecond[0].user_id).toBe(first.user.id)
  })
})

describe('(b) all five admin routines refuse a non-admin caller (FR-038, SC-018)', () => {
  let admin: TestUser
  let nonAdmin: TestUser
  let nonAdminSb: SupabaseClient

  beforeAll(async () => {
    ;[admin, nonAdmin] = await createTestUsers(2, 'b')
    track(admin.user.id)
    track(nonAdmin.user.id)
    await setAdmins(admin.user.id)
    nonAdminSb = await asUser(nonAdmin)
  })

  it('create_login raises DA001 and creates no auth.users row', async () => {
    const email = uniqueLoginEmail('b-create')
    const password = throwawayPassword()
    const { data, error } = await nonAdminSb.rpc('create_login', {
      email,
      password,
    })
    expect(error?.code).toBe('DA001')
    expect(data).toBeNull()
    // No in-case positive control for this query shape (a refused create_login never inserts
    // anything to find); the identical `select 1 from auth.users where email = $1` shape is
    // exercised as a genuine positive read in block (d)'s duplicate-email case below.
    const { rows } = await pg.query('select 1 from auth.users where email = $1', [email])
    expect(rows).toHaveLength(0)
  })

  it('set_login_password raises DA001 and changes nothing', async () => {
    const { data, error } = await nonAdminSb.rpc('set_login_password', {
      user_id: admin.user.id,
      password: throwawayPassword(),
    })
    expect(error?.code).toBe('DA001')
    expect(data).toBeNull()
    const { error: stillErr } = await trySignIn(admin.email, admin.password)
    expect(stillErr).toBeNull()
  })

  it('delete_login raises DA001 and leaves the target untouched', async () => {
    const { data, error } = await nonAdminSb.rpc('delete_login', { user_id: admin.user.id })
    expect(error?.code).toBe('DA001')
    expect(data).toBeNull()
    const { rows } = await pg.query('select 1 from public.instance_admins where user_id = $1', [
      admin.user.id,
    ])
    expect(rows).toHaveLength(1)
  })

  it('set_login_admin raises DA001 and grants nothing', async () => {
    const { data, error } = await nonAdminSb.rpc('set_login_admin', {
      user_id: nonAdmin.user.id,
      admin: true,
    })
    expect(error?.code).toBe('DA001')
    expect(data).toBeNull()
    const { rows } = await pg.query('select 1 from public.instance_admins where user_id = $1', [
      nonAdmin.user.id,
    ])
    expect(rows).toHaveLength(0)
  })

  it('list_logins raises DA001 rather than an empty list', async () => {
    const { data, error } = await nonAdminSb.rpc('list_logins')
    expect(error?.code).toBe('DA001')
    expect(data).toBeNull()
  })
})

describe('(c) create_login mints a login that can actually sign in -- the R-15 canary', () => {
  it('supabase.auth.signInWithPassword succeeds with the minted credential', async () => {
    const [admin] = await createTestUsers(1, 'c-admin')
    track(admin.user.id)
    await setAdmins(admin.user.id)
    const adminSb = await asUser(admin)

    const email = uniqueLoginEmail('c-login')
    const password = throwawayPassword()
    const { data, error } = await adminSb.rpc('create_login', { email, password })
    expect(error).toBeNull()
    const row = data?.[0]
    expect(row?.email).toBe(email)
    expect(row?.is_admin).toBe(false)
    track(row?.user_id)

    const { data: signInData, error: signInError } = await trySignIn(email, password)
    expect(signInError).toBeNull()
    expect(signInData.user?.id).toBe(row?.user_id)
  })
})

describe('(d) input validation and normalisation (FR-042)', () => {
  let admin: TestUser
  let adminSb: SupabaseClient

  beforeAll(async () => {
    ;[admin] = await createTestUsers(1, 'd-admin')
    track(admin.user.id)
    await setAdmins(admin.user.id)
    adminSb = await asUser(admin)
  })

  it('a duplicate email raises DA012 and leaves the existing row untouched', async () => {
    const email = uniqueLoginEmail('d-dup')
    const firstPassword = throwawayPassword()
    const { data: first, error: firstErr } = await adminSb.rpc('create_login', {
      email,
      password: firstPassword,
    })
    expect(firstErr).toBeNull()
    const uid = first?.[0]?.user_id
    track(uid)

    const secondPassword = throwawayPassword()
    const { data: second, error: secondErr } = await adminSb.rpc('create_login', {
      email,
      password: secondPassword,
    })
    expect(secondErr?.code).toBe('DA012')
    expect(second).toBeNull()

    const { rows } = await pg.query('select id from auth.users where email = $1', [
      email.toLowerCase(),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(uid)
  })

  it('a malformed identifier raises DA010 and creates no row', async () => {
    const { data, error } = await adminSb.rpc('create_login', {
      email: 'not-an-email',
      password: throwawayPassword(),
    })
    expect(error?.code).toBe('DA010')
    expect(data).toBeNull()
  })

  it('a password shorter than 8 characters raises DA011 and creates no row', async () => {
    const email = uniqueLoginEmail('d-short')
    const { data, error } = await adminSb.rpc('create_login', {
      email,
      password: shortThrowawayPassword(),
    })
    expect(error?.code).toBe('DA011')
    expect(data).toBeNull()
    const { rows } = await pg.query('select 1 from auth.users where email = $1', [email])
    expect(rows).toHaveLength(0)
  })

  it('a mixed-case, space-padded identifier is stored lower-cased and trimmed', async () => {
    const raw = `  D-Norm-${Date.now()}-${process.pid}@Example.TEST  `
    const normalized = raw.trim().toLowerCase()
    const password = throwawayPassword()
    const { data, error } = await adminSb.rpc('create_login', { email: raw, password })
    expect(error).toBeNull()
    const row = data?.[0]
    track(row?.user_id)
    expect(row?.email).toBe(normalized)

    const { rows } = await pg.query('select email from auth.users where id = $1', [row?.user_id])
    expect(rows).toHaveLength(1)
    expect(rows[0].email).toBe(normalized)
  })
})

describe('(e) set_login_password replaces a login\'s credential', () => {
  it('the old password fails afterwards and the new one succeeds', async () => {
    const [admin] = await createTestUsers(1, 'e-admin')
    track(admin.user.id)
    await setAdmins(admin.user.id)
    const adminSb = await asUser(admin)

    const email = uniqueLoginEmail('e-login')
    const oldPassword = throwawayPassword()
    const { data, error } = await adminSb.rpc('create_login', { email, password: oldPassword })
    expect(error).toBeNull()
    const uid = data?.[0]?.user_id
    track(uid)

    const newPassword = throwawayPassword()
    const { error: setErr } = await adminSb.rpc('set_login_password', {
      user_id: uid,
      password: newPassword,
    })
    expect(setErr).toBeNull()

    const { error: oldSignInErr } = await trySignIn(email, oldPassword)
    // Not just "some error": a rate limit, transport error or unconfirmed-email state would
    // also make `error` non-null, and this file performs ~20 sign-ins against one local GoTrue
    // so the rate-limit path is not hypothetical. `status === 400` is what this GoTrue version
    // populates reliably; the tighter assertion to adopt once observed against the running
    // stack is `error.code === 'invalid_credentials'`.
    expect(oldSignInErr?.status).toBe(400)

    const { error: newSignInErr } = await trySignIn(email, newPassword)
    expect(newSignInErr).toBeNull()
  })
})

describe('(f) delete_login bans -- it does not delete (R-18, FR-045)', () => {
  it(
    'sign-in is refused afterwards; the auth.users row, the rows it created and their ' +
      'creator id stay; its instance_admins row is gone; its memberships and assignees are cleared',
    async () => {
      const [admin, owner] = await createTestUsers(2, 'f-main')
      track(admin.user.id)
      track(owner.user.id)
      await setAdmins(admin.user.id)
      const adminSb = await asUser(admin)
      const ownerSb = await asUser(owner)

      // Owner's team workspace -- the membership/assignee half of removal is exercised here.
      const wsId = randomUUID()
      const { error: wsErr } = await ownerSb
        .from('workspaces')
        .insert({ id: wsId, user_id: owner.user.id, name: 'f-ws', kind: 'team' })
      expect(wsErr).toBeNull()

      // The target: minted by the admin, then itself granted admin, then added as a member.
      const email = uniqueLoginEmail('f-target')
      const password = throwawayPassword()
      const { data: created, error: createErr } = await adminSb.rpc('create_login', {
        email,
        password,
      })
      expect(createErr).toBeNull()
      const targetId = created?.[0]?.user_id
      track(targetId)

      const { error: grantErr } = await adminSb.rpc('set_login_admin', {
        user_id: targetId,
        admin: true,
      })
      expect(grantErr).toBeNull()

      // Positive control on the grant itself -- an RPC that returns success without writing the
      // row would otherwise make the later "its instance_admins row is gone" read trivially true
      // for the wrong reason. Same shape as block (b)'s `select 1 from public.instance_admins`.
      const { rows: grantedRows } = await pg.query(
        'select 1 from public.instance_admins where user_id = $1',
        [targetId],
      )
      expect(grantedRows).toHaveLength(1)

      const { error: addErr } = await ownerSb.rpc('add_member_by_email', { ws: wsId, email })
      expect(addErr).toBeNull()

      // The target signs in and creates its own rows -- the "rows stay, creator id intact" half.
      const targetSb = await signedInClient(email, password)
      const targetWs = randomUUID()
      const { error: targetWsErr } = await targetSb
        .from('workspaces')
        .insert({ id: targetWs, user_id: targetId, name: 'f-target-personal', kind: 'personal' })
      expect(targetWsErr).toBeNull()

      const targetTaskId = randomUUID()
      const { error: targetTaskErr } = await targetSb
        .from('tasks')
        .insert({ id: targetTaskId, user_id: targetId, workspace_id: targetWs, title: 'f-target-task' })
      expect(targetTaskErr).toBeNull()

      // The target also creates a row inside the *team* workspace it is a member of --
      // SC-016's team-workspace half: "the number of its rows in team workspaces that
      // disappeared is 0", distinct from the personal-workspace row above.
      const targetTeamTaskId = randomUUID()
      const { error: targetTeamTaskErr } = await targetSb
        .from('tasks')
        .insert({ id: targetTeamTaskId, user_id: targetId, workspace_id: wsId, title: 'f-target-team-task' })
      expect(targetTeamTaskErr).toBeNull()

      // The owner assigns a task in the team workspace to the target -- the assignee-clear half.
      const assignedTaskId = randomUUID()
      const { error: assignErr } = await ownerSb.from('tasks').insert({
        id: assignedTaskId,
        user_id: owner.user.id,
        workspace_id: wsId,
        title: 'f-assigned-task',
        assignee: targetId,
      })
      expect(assignErr).toBeNull()

      // Read-back proving the assignment actually landed before removal -- otherwise the
      // later "cleared to null" read would be trivially true if the insert's `assignee` were
      // silently ignored.
      const { rows: preAssignedRows } = await pg.query<{ assignee: string | null }>(
        'select assignee from public.tasks where id = $1',
        [assignedTaskId],
      )
      expect(preAssignedRows).toHaveLength(1)
      expect(preAssignedRows[0].assignee).toBe(targetId)

      // --- the removal itself ---
      const { error: deleteErr } = await adminSb.rpc('delete_login', { user_id: targetId })
      expect(deleteErr).toBeNull()

      // Sign-in refused afterwards. `status === 400` is the specific failure this GoTrue version
      // populates reliably; a bare non-null would also accept a rate-limit or transport error --
      // not hypothetical, since this file performs ~20 sign-ins against one local GoTrue. The
      // tighter assertion to adopt once observed against the running stack is
      // `error.code === 'invalid_credentials'`.
      const { error: postSignInErr } = await trySignIn(email, password)
      expect(postSignInErr?.status).toBe(400)

      // auth.users row still exists, and is actually banned -- not merely present, which the
      // row would be even if delete_login forgot to set the ban.
      const { rows: userRows } = await pg.query<{ banned_until: string | null }>(
        'select banned_until from auth.users where id = $1',
        [targetId],
      )
      expect(userRows).toHaveLength(1)
      expect(userRows[0].banned_until).not.toBeNull()

      // The rows it created are still there, with the creator id intact.
      const { rows: wsRows } = await pg.query<{ user_id: string }>(
        'select user_id from public.workspaces where id = $1',
        [targetWs],
      )
      expect(wsRows).toHaveLength(1)
      expect(wsRows[0].user_id).toBe(targetId)

      const { rows: taskRows } = await pg.query<{ user_id: string }>(
        'select user_id from public.tasks where id = $1',
        [targetTaskId],
      )
      expect(taskRows).toHaveLength(1)
      expect(taskRows[0].user_id).toBe(targetId)

      const { rows: teamTaskRows } = await pg.query<{ user_id: string }>(
        'select user_id from public.tasks where id = $1',
        [targetTeamTaskId],
      )
      expect(teamTaskRows).toHaveLength(1)
      expect(teamTaskRows[0].user_id).toBe(targetId)

      // Its instance_admins row is gone.
      const { rows: adminRows } = await pg.query(
        'select 1 from public.instance_admins where user_id = $1',
        [targetId],
      )
      expect(adminRows).toHaveLength(0)

      // Its members row is soft-deleted.
      const { rows: memberRows } = await pg.query<{ deleted: boolean }>(
        'select deleted from public.members where workspace_id = $1 and member_id = $2',
        [wsId, targetId],
      )
      expect(memberRows).toHaveLength(1)
      expect(memberRows[0].deleted).toBe(true)

      // members_zz_clear_assignee cleared the assignment.
      const { rows: assignedRows } = await pg.query<{ assignee: string | null }>(
        'select assignee from public.tasks where id = $1',
        [assignedTaskId],
      )
      expect(assignedRows).toHaveLength(1)
      expect(assignedRows[0].assignee).toBeNull()
    },
  )

  it("refuses the caller's own login with DA013, changing nothing", async () => {
    const [admin] = await createTestUsers(1, 'f-self')
    track(admin.user.id)
    await setAdmins(admin.user.id)
    const adminSb = await asUser(admin)

    const { error } = await adminSb.rpc('delete_login', { user_id: admin.user.id })
    expect(error?.code).toBe('DA013')

    const { error: signInErr } = await trySignIn(admin.email, admin.password)
    expect(signInErr).toBeNull()
    const { rows } = await pg.query('select 1 from public.instance_admins where user_id = $1', [
      admin.user.id,
    ])
    expect(rows).toHaveLength(1)
  })

  it('refuses a login that owns a live team workspace with DA014, changing nothing', async () => {
    const [admin] = await createTestUsers(1, 'f-da014-admin')
    track(admin.user.id)
    await setAdmins(admin.user.id)
    const adminSb = await asUser(admin)

    const email = uniqueLoginEmail('f-da014-target')
    const password = throwawayPassword()
    const { data: created, error: createErr } = await adminSb.rpc('create_login', {
      email,
      password,
    })
    expect(createErr).toBeNull()
    const targetId = created?.[0]?.user_id
    track(targetId)

    const targetSb = await signedInClient(email, password)
    const wsId = randomUUID()
    const { error: wsErr } = await targetSb
      .from('workspaces')
      .insert({ id: wsId, user_id: targetId, name: 'f-da014-ws', kind: 'team' })
    expect(wsErr).toBeNull()

    const { error: deleteErr } = await adminSb.rpc('delete_login', { user_id: targetId })
    expect(deleteErr?.code).toBe('DA014')

    const { error: signInErr } = await trySignIn(email, password)
    expect(signInErr).toBeNull()
    const { rows } = await pg.query<{ deleted: boolean }>(
      'select deleted from public.workspaces where id = $1',
      [wsId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].deleted).toBe(false)

    // "Changing nothing" also covers the writes delete_login performs beyond the ban --
    // it never touched instance_admins for a target that was never granted admin.
    const { rows: adminRows } = await pg.query(
      'select 1 from public.instance_admins where user_id = $1',
      [targetId],
    )
    expect(adminRows).toHaveLength(0)
  })
})

describe('(g) set_login_admin refuses to clear the last admin (DA015)', () => {
  it('refuses when the target is the only admin, changing nothing', async () => {
    const [solo] = await createTestUsers(1, 'g-solo')
    track(solo.user.id)
    await setAdmins(solo.user.id)
    const soloSb = await asUser(solo)

    const { error } = await soloSb.rpc('set_login_admin', { user_id: solo.user.id, admin: false })
    expect(error?.code).toBe('DA015')

    const { rows } = await pg.query('select 1 from public.instance_admins where user_id = $1', [
      solo.user.id,
    ])
    expect(rows).toHaveLength(1)
  })

  it('succeeds when another admin remains', async () => {
    const [a, b] = await createTestUsers(2, 'g-pair')
    track(a.user.id)
    track(b.user.id)
    await setAdmins(a.user.id, b.user.id)
    const aSb = await asUser(a)

    // Positive control on the fixture: proves the insert loop in `setAdmins` actually ran and
    // a was admin before the revoke, so the later length-0 read on a is not trivially true.
    const { rows: preRows } = await pg.query(
      'select 1 from public.instance_admins where user_id = $1',
      [a.user.id],
    )
    expect(preRows).toHaveLength(1)

    const { error } = await aSb.rpc('set_login_admin', { user_id: a.user.id, admin: false })
    expect(error).toBeNull()

    const { rows } = await pg.query('select 1 from public.instance_admins where user_id = $1', [
      a.user.id,
    ])
    expect(rows).toHaveLength(0)

    // The other admin must survive (DA015 invariant) -- otherwise a revoke that clears both
    // rows would pass this test unnoticed.
    const { rows: bRows } = await pg.query(
      'select 1 from public.instance_admins where user_id = $1',
      [b.user.id],
    )
    expect(bRows).toHaveLength(1)
  })
})

describe('(h) list_logins returns every login for an admin, banned rows included', () => {
  it('lists both an active and a banned login', async () => {
    const [admin] = await createTestUsers(1, 'h-admin')
    track(admin.user.id)
    await setAdmins(admin.user.id)
    const adminSb = await asUser(admin)

    const activeEmail = uniqueLoginEmail('h-active')
    const { data: activeRow, error: activeErr } = await adminSb.rpc('create_login', {
      email: activeEmail,
      password: throwawayPassword(),
    })
    expect(activeErr).toBeNull()
    const activeId = activeRow?.[0]?.user_id
    track(activeId)

    const bannedEmail = uniqueLoginEmail('h-banned')
    const { data: bannedRow, error: bannedErr } = await adminSb.rpc('create_login', {
      email: bannedEmail,
      password: throwawayPassword(),
    })
    expect(bannedErr).toBeNull()
    const bannedId = bannedRow?.[0]?.user_id
    track(bannedId)

    const { error: banErr } = await adminSb.rpc('delete_login', { user_id: bannedId })
    expect(banErr).toBeNull()

    const { data: list, error: listErr } = await adminSb.rpc('list_logins')
    expect(listErr).toBeNull()
    const ids = (list ?? []).map((row: { user_id: string }) => row.user_id)
    expect(ids).toContain(activeId)
    expect(ids).toContain(bannedId)
  })
})

describe('(i) two admins racing create_login for the same email (SC-021)', () => {
  it('ends with exactly one auth.users row and exactly one DA012', async () => {
    const [adminA, adminB] = await createTestUsers(2, 'i-admin')
    track(adminA.user.id)
    track(adminB.user.id)
    await setAdmins(adminA.user.id, adminB.user.id)
    const sbA = await asUser(adminA)
    const sbB = await asUser(adminB)

    const email = uniqueLoginEmail('i-race')
    const [resA, resB] = await Promise.all([
      sbA.rpc('create_login', { email, password: throwawayPassword() }),
      sbB.rpc('create_login', { email, password: throwawayPassword() }),
    ])

    const results = [resA, resB]
    const successes = results.filter((r) => !r.error)
    const failures = results.filter((r) => r.error)
    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.error?.code).toBe('DA012')

    const winnerId = successes[0]?.data?.[0]?.user_id
    track(winnerId)

    const { rows } = await pg.query<{ id: string }>('select id from auth.users where email = $1', [
      email,
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(winnerId)
  })
})

describe('(j) is_admin() called directly -- discharges T008\'s deferred verify half', () => {
  it('returns true for adminClient(a) and false for an ordinary asUser(b)', async () => {
    const [a, b] = await createTestUsers(2, 'j-pair')
    track(a.user.id)
    track(b.user.id)
    // `createTestUsers` inserts both accounts before either is flagged, so if
    // `instance_admins` were empty at that moment `users_seed_first_admin` could grant
    // admin to whichever of a/b the trigger saw first -- possibly b, which would fail
    // `bIsAdmin` below for the wrong reason. Clearing first makes only `adminClient(a)`'s
    // explicit grant meaningful, regardless of table state left by an earlier test or a
    // fresh `db reset`.
    await setAdmins()
    const aSb = await adminClient(a)
    const bSb = await asUser(b)

    const { data: aIsAdmin, error: aErr } = await aSb.rpc('is_admin')
    expect(aErr).toBeNull()
    expect(aIsAdmin).toBe(true)

    const { data: bIsAdmin, error: bErr } = await bSb.rpc('is_admin')
    expect(bErr).toBeNull()
    expect(bIsAdmin).toBe(false)
  })
})
