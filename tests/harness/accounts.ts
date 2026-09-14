// Per-file throwaway user provisioning (plan.md D-3, D-6).
//
// RLS tests (US3) never touch the app's singleton (`src/auth/supabase.ts`) —
// it is a persisting, module-level client built for one signed-in account,
// exactly the single-account assumption this feature is pinning ahead of P1
// (`src/auth/supabase.ts:1-17`). Building clients directly here, with
// `persistSession: false`, lets a test hold two independent sessions (A, B)
// at once and observe RLS where it actually lives — at the API layer.
import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'
import { ANON_KEY, API_URL, SERVICE_ROLE_KEY } from './stack'

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
