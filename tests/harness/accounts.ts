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
