import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, createTestUsers, type TestUser } from '../harness/accounts'
import { assertStackReachable, DB_URL } from '../harness/stack'

/*
 * Owner defect report (2026-09-14): "i can add account when i already been
 * logged in in a workspace; that creates user login without a password. So
 * logging in is impossible from other device."
 *
 * `tests/stack/logins-provisioning.test.ts` block (d) already proves
 * `create_login` raises `DA011` for a too-short password using a *truncated*
 * throwaway string (6 chars) — this file pins the exact literal case the
 * report describes, an outright empty string, which is the shape the
 * Settings.tsx mint form (`LoginsSection`) let through before this fix: the
 * password `<input>` had neither `required` nor `minLength`, so a bare
 * Enter/click submitted `createLogin(email, '')` straight to the server.
 *
 * This test is the server-side half of that fix's evidence: it confirms the
 * one invariant the client-side `required`/`minLength={8}` guard now added
 * to `LoginsSection`'s three password inputs (mint, set-password) is layered
 * on top of, not a replacement for -- an admin who bypasses the browser's
 * own validation (devtools, a non-browser client, autofill quirks) still
 * cannot mint a passwordless login. No `auth.users` row is created either
 * way, so there is nothing for a second device to fail to sign in to.
 */

let pg: Client
const createdUserIds = new Set<string>()

function track(id: string | undefined | null): void {
  if (id) createdUserIds.add(id)
}

beforeAll(async () => {
  await assertStackReachable()
  pg = new Client({ connectionString: DB_URL })
  await pg.connect()
}, 60_000)

afterAll(async () => {
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

describe('create_login refuses a literal empty-string password (owner defect report)', () => {
  it('raises DA011 and creates no auth.users row', async () => {
    const [admin]: TestUser[] = await createTestUsers(1, 'empty-pw-admin')
    track(admin.user.id)
    const adminSb = await adminClient(admin)

    const email = `t-empty-pw-${Date.now()}-${process.pid}@example.test`
    const { data, error } = await adminSb.rpc('create_login', { email, password: '' })

    expect(error?.code).toBe('DA011')
    expect(data).toBeNull()

    const { rows } = await pg.query('select 1 from auth.users where email = $1', [email])
    expect(rows).toHaveLength(0)
  })
})
