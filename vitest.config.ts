import { defineConfig } from 'vitest/config'

// Fixed values printed by `npx supabase start` for the local dev stack
// (supabase/config.toml). These are NOT credentials: the local stack only
// ever runs on 127.0.0.1, in Docker, seeded from a committed config; nothing
// here reaches, or is reachable from, a hosted project. Committing them is
// the documented ADR-0002 corollary ("zero credentials in the repo" holds
// because these aren't credentials), not an exception to it.
const env = {
  VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
  VITE_SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
}

// Shared across both tiers: config passed to `projects` entries does not
// inherit root-level `test` options, so environment/setupFiles/env are
// repeated per project rather than declared once at the root.
const shared = {
  environment: 'jsdom',
  setupFiles: ['./tests/setup.ts'],
  env,
} as const

// https://vitest.dev/config/
export default defineConfig({
  test: {
    ...shared,
    include: ['tests/**/*.test.ts'],
    // TG-1 has no test files of its own yet — this and TG-2's later
    // stack-dependent suites are added by subsequent taskgroups; an empty
    // suite must still exit 0 (task T001's verify).
    passWithNoTests: true,
    // Stack-tier tests share one local supabase Postgres instance and must
    // not race each other (schema apply, per-file account provisioning); the
    // local tier has no shared backend and keeps vitest's default
    // parallelism. Scoped via `projects` (not a global fileParallelism:
    // false) so only tests/stack/** loses parallelism.
    projects: [
      {
        test: {
          ...shared,
          name: 'stack',
          globalSetup: ['./tests/harness/global-setup.ts'],
          include: ['tests/stack/**/*.test.ts'],
          fileParallelism: false,
        },
      },
      {
        test: {
          ...shared,
          name: 'local',
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/stack/**'],
        },
      },
    ],
  },
})
