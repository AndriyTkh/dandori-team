// Per-file throwaway user provisioning (plan.md D-3, D-6).
//
// RLS tests (US3) never touch the app's singleton (`src/auth/supabase.ts`) —
// it is a persisting, module-level client built for one signed-in account,
// exactly the single-account assumption this feature is pinning ahead of P1
// (`src/auth/supabase.ts:1-17`). Building clients directly here, with
// `persistSession: false`, lets a test hold two independent sessions (A, B)
// at once and observe RLS where it actually lives — at the API layer.
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'
import { Client } from 'pg'
import { ANON_KEY, API_URL, DB_URL, SERVICE_ROLE_KEY } from './stack'

let uniqueSeq = 0

/** Unique per call, and namespaced by caller, so files provisioning in parallel never collide. */
function uniqueEmail(label: string): string {
  uniqueSeq += 1
  return `${label}-${Date.now()}-${process.pid}-${uniqueSeq}@example.test`
}

export interface TestUser {
  user: User
  email: string
  password: string
}

const admin = (): SupabaseClient =>
  createClient(API_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

/**
 * Creates one confirmed throwaway user via the Auth admin API. `label`
 * becomes part of the email so a failure is traceable to the scenario that
 * provisioned it.
 */
export async function createTestUser(label = 'user'): Promise<TestUser> {
  const email = uniqueEmail(label)
  const password = crypto.randomUUID()
  const { data, error } = await admin().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (error || !data.user) {
    throw new Error(`createTestUser(${label}) failed: ${error?.message ?? 'no user returned'}`)
  }
  return { user: data.user, email, password }
}

/**
 * Builds an independent `supabase-js` client signed in as `testUser`, with
 * `persistSession: false` so nothing leaks into `localStorage`/jsdom between
 * clients or files (plan.md D-3).
 */
export async function clientFor(testUser: TestUser): Promise<SupabaseClient> {
  const client = createClient(API_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error } = await client.auth.signInWithPassword({
    email: testUser.email,
    password: testUser.password,
  })
  if (error) {
    throw new Error(`clientFor(${testUser.email}) sign-in failed: ${error.message}`)
  }
  return client
}

/** Deletes a throwaway user via the admin API. Best-effort teardown, never required for isolation. */
export async function deleteTestUser(testUser: TestUser): Promise<void> {
  await admin().auth.admin.deleteUser(testUser.user.id)
}

/**
 * Provisions `n` independent throwaway users in one call, labelled
 * `${label}-0`, `${label}-1`, ... so a failure is still traceable to the
 * scenario that provisioned it. Generalizes the two-call pattern
 * `rls-two-accounts.test.ts` uses today (plan.md D-13): a third account is
 * needed for "knows the id, is not a member" (US3 acceptance 4) and for
 * "same person in several team workspaces" (edge case 9).
 */
export async function createTestUsers(n: number, label = 'user'): Promise<TestUser[]> {
  return Promise.all(Array.from({ length: n }, (_, i) => createTestUser(`${label}-${i}`)))
}

const memoizedClients = new WeakMap<TestUser, Promise<SupabaseClient>>()

/**
 * Memoized `clientFor`: the same `testUser` always resolves to the same
 * client instance, so a file that switches between several accounts (A, B,
 * C) does not re-authenticate on every assertion (plan.md D-13). Keyed by
 * the `TestUser` object itself — call `createTestUser(s)` once per account
 * and reuse the returned value, the same convention every existing stack
 * test already follows.
 */
export function asUser(testUser: TestUser): Promise<SupabaseClient> {
  let cached = memoizedClients.get(testUser)
  if (!cached) {
    cached = clientFor(testUser)
    memoizedClients.set(testUser, cached)
  }
  return cached
}

/**
 * TEST-ONLY. Never shipped, never imported by `src/` — there is no
 * client-callable grant-admin routine anywhere in this project (plan.md D-13,
 * Complexity Tracking row 4), and a reviewer treats an import of this
 * function outside `tests/` as a finding.
 *
 * The harness provisions users through `auth.admin.createUser` (`createTestUser`
 * above), so `public.instance_admins`' own `users_seed_first_admin` trigger
 * (contracts/policies.sql fork block D) grants admin to whichever account a
 * given file happens to create first — nondeterministic inside a suite, and
 * on a database that already has rows, granted to nobody at all. Rather than
 * lean on that trigger, `adminClient` makes a test user admin directly: it
 * inserts `(user_id)` into `public.instance_admins` over the harness's own
 * direct `pg` connection (`DB_URL`, the same connection style as
 * `applySchema` in `./schema`) — never through PostgREST, never through an
 * RPC, since no such client-callable path exists (FR-039). The insert is
 * `on conflict do nothing` against the table's primary key so calling this
 * more than once for the same user within a suite is harmless, and the `pg`
 * connection is opened and closed around the single insert so a suite does
 * not leak connections.
 *
 * The trigger itself is asserted separately, on its own, against an empty
 * `instance_admins` table, by T018 — this helper does not exercise it and is
 * not a substitute for that assertion.
 *
 * Returns the same memoized client `asUser(testUser)` would hand back, now
 * admin-flagged at the database, not a second independent sign-in.
 */
export async function adminClient(testUser: TestUser): Promise<SupabaseClient> {
  const pg = new Client({ connectionString: DB_URL })
  await pg.connect()
  try {
    await pg.query(
      'insert into public.instance_admins (user_id) values ($1) on conflict (user_id) do nothing',
      [testUser.user.id],
    )
  } finally {
    await pg.end()
  }
  return asUser(testUser)
}
