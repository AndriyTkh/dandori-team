// Structural risk guards for 002-team-workspaces (T009), red-first.
//
// Each `it` below pins one risk from specs/002-team-workspaces/plan.md's
// "Risks, seams and candidate FINDINGS" section against the deployed
// schema, independent of any application code. There is no single card
// that turns this file green: it goes red-to-green progressively as
// T020-T026 each land their slice of contracts/policies.sql and
// contracts/rpc.md, and is fully green only at **T026**. Verified against
// tasks.md's own task bodies (specs/002-team-workspaces/tasks.md T020-T026):
//   - Before T020: everything below is RED — `public.members` does not
//     exist and none of the fifteen R-2 functions exist.
//   - T020 (fork block A — `members` table + RLS enabled, no policy yet):
//     R-1 stays RED. RLS-enabled-with-no-policy makes a plain select
//     return zero rows with `error === null`, which would make the old
//     recursion-only assertion pass for the wrong reason (no policy was
//     ever exercised) — the added `members_access` policy-existence check
//     is what keeps this case red through T020-T022.
//   - T021 (fork block B — `is_member`, `is_owner`): R-2 at 2/15.
//   - T022 (fork block C — `seed_workspace_owner`,
//     `on_workspace_kind_change`, `assignee_must_be_member`,
//     `clear_assignee_on_removal`): R-2 at 6/15.
//   - T023 (policy block, incl. `members_access`): **R-1 goes GREEN** —
//     the policy exists and the select still does not recurse.
//   - T024 (the two D-9 RPCs — `add_member_by_email`,
//     `workspace_member_emails`): R-2 at 8/15; R-3 clears its first **two**
//     cases (those two RPCs' `revoke ... from public, anon` lands).
//   - T025 (fork block D — `instance_admins`, `is_admin`,
//     `seed_first_admin`, `users_seed_first_admin` trigger): **R-16 goes
//     GREEN**; R-2 at 10/15; R-3 clears its **third** case (`is_admin`).
//   - T026 (fork block E — the five provisioning routines): **R-2 and the
//     remaining five R-3 cases go GREEN** — the file is fully green.
//   - R-17 is independent of all of the above and is expected to already
//     pass — the local stack already installs pgcrypto in `extensions`
//     (schema.sql's own comment says so); placed first so a genuinely
//     missing extension fails as one clear line before anything
//     member/admin-shaped is even attempted.
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clientFor, createTestUser, deleteTestUser, type TestUser } from '../harness/accounts'
import { ANON_KEY, API_URL, DB_URL, assertStackReachable } from '../harness/stack'

/** Every function this feature adds (plan.md R-2), across fork blocks B-E. */
const DEFINER_FUNCTIONS = [
  'is_member',
  'is_owner',
  'seed_workspace_owner',
  'on_workspace_kind_change',
  'assignee_must_be_member',
  'clear_assignee_on_removal',
  'add_member_by_email',
  'workspace_member_emails',
  'is_admin',
  'seed_first_admin',
  'create_login',
  'set_login_password',
  'delete_login',
  'set_login_admin',
  'list_logins',
] as const

/** The eight RPCs contracts/rpc.md revokes from public/anon (plan.md R-3). */
const ANON_REFUSED_RPCS: Array<{ name: string; args: Record<string, unknown> }> = [
  { name: 'add_member_by_email', args: { ws: randomUUID(), email: 'nobody@example.test' } },
  { name: 'workspace_member_emails', args: { ws: randomUUID() } },
  { name: 'is_admin', args: {} },
  { name: 'create_login', args: { email: 'nobody@example.test', password: 'password123' } },
  { name: 'set_login_password', args: { user_id: randomUUID(), password: 'password123' } },
  { name: 'delete_login', args: { user_id: randomUUID() } },
  { name: 'set_login_admin', args: { user_id: randomUUID(), admin: true } },
  { name: 'list_logins', args: {} },
]

let pg: Client
let member: TestUser

beforeAll(async () => {
  await assertStackReachable()
  pg = new Client({ connectionString: DB_URL })
  await pg.connect()
  member = await createTestUser('guard')
}, 60_000)

afterAll(async () => {
  await deleteTestUser(member).catch(() => {})
  await pg?.end()
})

describe('team schema guards (T009)', () => {
  // R-17 first: a missing pgcrypto fails as one clear line, before anything
  // member/admin-shaped is even attempted.
  it('R-17: pgcrypto is installed in the extensions schema', async () => {
    const { rows } = await pg.query<{ extname: string }>(
      `select e.extname from pg_extension e
         join pg_namespace n on n.oid = e.extnamespace
        where e.extname = 'pgcrypto' and n.nspname = 'extensions'`,
    )
    expect(rows, 'pgcrypto is not installed in the extensions schema').toHaveLength(1)
  })

  // R-16: the first-admin trigger on auth.users survives schema apply.
  it('R-16: users_seed_first_admin trigger exists on auth.users', async () => {
    const { rows } = await pg.query<{ tgname: string }>(
      `select tgname from pg_trigger
        where tgrelid = 'auth.users'::regclass and not tgisinternal`,
    )
    const names = rows.map((r) => r.tgname)
    expect(names, `auth.users triggers found: ${names.join(', ') || '(none)'}`).toContain(
      'users_seed_first_admin',
    )
  })

  // R-1 canary: the cheapest possible check that members' own policy does
  // not recurse into itself. Precondition first -- between T020 (table +
  // RLS enabled) and T023 (members_access created), a select on members
  // returns zero rows with error === null because RLS-enabled-with-no-
  // policy hides everything; that would make the recursion check below
  // pass without any policy ever having been exercised. Requiring the
  // policy to exist closes that vacuous-green window.
  it('R-1: a plain authenticated select on public.members does not recurse', async () => {
    const { rows: policies } = await pg.query<{ policyname: string }>(
      `select policyname from pg_policies where schemaname = 'public' and tablename = 'members'`,
    )
    const policyNames = policies.map((p) => p.policyname)
    expect(
      policyNames,
      `members_access policy not found on public.members (found: ${policyNames.join(', ') || '(none)'})`,
    ).toContain('members_access')

    const client = await clientFor(member)
    const { error } = await client.from('members').select('*').limit(1)
    if (error) {
      expect(
        error.message,
        'members select must not recurse through its own policy',
      ).not.toContain('infinite recursion detected in policy for relation "members"')
    }
    expect(error, `members select failed: ${error?.message ?? '(no error)'}`).toBeNull()
  })

  // R-2: every definer function added by this feature is security definer
  // with a pinned search_path -- reported as which names are missing, not a
  // bare length mismatch.
  it('R-2: every added function is security definer with a fixed search_path', async () => {
    const { rows } = await pg.query<{
      proname: string
      prosecdef: boolean
      proconfig: string[] | null
    }>(
      `select proname, prosecdef, proconfig
         from pg_proc
        where pronamespace = 'public'::regnamespace
          and proname = any($1::text[])`,
      [DEFINER_FUNCTIONS],
    )
    const byName = new Map(rows.map((r) => [r.proname, r]))
    const missing = DEFINER_FUNCTIONS.filter((name) => !byName.has(name))
    expect(missing, `missing functions: ${missing.join(', ') || '(none)'}`).toEqual([])

    const notDefiner = DEFINER_FUNCTIONS.filter((name) => byName.get(name)?.prosecdef !== true)
    expect(notDefiner, `not security definer: ${notDefiner.join(', ') || '(none)'}`).toEqual([])

    // contracts/policies.sql pins `set search_path = public, pg_temp` on the
    // block B/C/D functions; contracts/rpc.md pins `set search_path =
    // public, auth, pg_temp` on add_member_by_email/workspace_member_emails
    // and `set search_path = public, auth, extensions, pg_temp` on the
    // block E provisioning routines. All three forms start with `public`
    // and end with `pg_temp` -- checked structurally (not against one
    // hard-coded string) so a legitimate future addition to the middle of
    // the path is not a false red, while a degenerate pin (`''`, or one
    // missing `pg_temp`) still is.
    const badSearchPath = DEFINER_FUNCTIONS.filter((name) => {
      const config = byName.get(name)?.proconfig
      const entry = config?.find((c) => c.startsWith('search_path='))
      if (!entry) return true
      const parts = entry
        .slice('search_path='.length)
        .split(',')
        .map((p) => p.trim())
      return parts[0] !== 'public' || parts[parts.length - 1] !== 'pg_temp'
    })
    expect(
      badSearchPath,
      `search_path not pinned to public...pg_temp: ${
        badSearchPath
          .map((name) => `${name} (proconfig: ${JSON.stringify(byName.get(name)?.proconfig ?? null)})`)
          .join(', ') || '(none)'
      }`,
    ).toEqual([])
  })

  // R-3: anon (no session at all) is refused on every one of the eight
  // RPCs -- create_login most of all, an anon-reachable one is an open
  // account factory. The refusal must be the specific privilege refusal
  // (42501), not merely "some error" -- PGRST202 ("function not found",
  // the pre-T024 state) must NOT satisfy this, or the guard is green for
  // the wrong reason and would miss a dropped `revoke ... from public,
  // anon` once the routines exist.
  it.each(ANON_REFUSED_RPCS)('R-3: anon calling $name is refused', async ({ name, args }) => {
    const anon = createClient(API_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { error } = await anon.rpc(name, args)
    expect(
      error,
      `anon call to ${name} succeeded and should not have -- open account factory`,
    ).toBeTruthy()
    expect(
      error?.code,
      `${name}: expected privilege refusal 42501, got ${error?.code ?? '(no code)'}: ${
        error?.message ?? '(no message)'
      }`,
    ).toBe('42501')
    expect(
      error?.message,
      `${name}: expected "permission denied for function ${name}", got: ${
        error?.message ?? '(no message)'
      }`,
    ).toContain(`permission denied for function ${name}`)
  })
})
