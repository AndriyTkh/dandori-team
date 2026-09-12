// Local Supabase stack: reachability + the fixed dev values `npx supabase
// status` prints for this repo's `supabase/config.toml`. These are not
// credentials (ADR-0002 corollary): the stack only ever runs on 127.0.0.1,
// in Docker, seeded from a committed config. Never point these at a hosted
// project.
import { execSync } from 'node:child_process'

export const API_URL = 'http://127.0.0.1:54321'
export const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
export const ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
export const SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'

const HEALTH_URL = `${API_URL}/auth/v1/health`

async function isReachable(): Promise<boolean> {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2_000) })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Confirms the local Supabase stack answers at `API_URL`; if not, tries to
 * bring it up with `npx supabase start` and re-checks. Never skips the stack
 * tier silently (spec FR-014, plan D-7): a stack that still cannot be reached
 * — most commonly because Docker itself is not running — throws, naming both
 * the missing prerequisite and the command to fix it by hand.
 */
export async function assertStackReachable(): Promise<void> {
  if (await isReachable()) return

  try {
    execSync('npx supabase start', { stdio: 'pipe', timeout: 120_000 })
  } catch (err) {
    throw new Error(
      'Local Supabase stack is unreachable and `npx supabase start` failed. ' +
        'Make sure Docker is installed and running, then retry with `npx supabase start`.\n' +
        String((err as Error).message ?? err),
    )
  }

  if (!(await isReachable())) {
    throw new Error(
      `Local Supabase stack still unreachable at ${API_URL} after \`npx supabase start\`. ` +
        'Make sure Docker is installed and running, then retry with `npx supabase start`.',
    )
  }
}
