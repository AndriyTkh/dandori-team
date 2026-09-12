# Tests

One command runs everything:

```sh
npm test
```

(equivalently `npx vitest --run` for a single pass instead of watch mode). Nothing else is
required to get the same result as CI, from a fresh clone — see `vitest.config.ts`'s `globalSetup`,
which brings up the backend stand-in itself.

## Two tiers

- **`tests/stack/`** — needs Docker. These tests drive the real `supabase` CLI local stack (real
  Postgres, real RLS policies, real triggers) at `http://127.0.0.1:54321` /
  `postgresql://postgres:postgres@127.0.0.1:54322/postgres`. `globalSetup` starts the stack if it
  isn't already running and applies `supabase/schema.sql` plus the `migration-002`…`-006` files, in
  order. File parallelism is disabled for this tier: tests share one Postgres instance and must not
  race each other's schema apply or account provisioning.
- **`tests/local/`** — no Docker needed. These tests exercise the Dexie local cache under
  `fake-indexeddb` (via `tests/setup.ts`) and run in parallel like any other vitest suite.

Shared helpers for both tiers live under `tests/harness/`.

## The no-source-modification rule

This feature (P0 validation spine) produces evidence for **existing, unmodified** behaviour. No
file under `src/` or `supabase/` may be changed by anything here (spec FR-002); `supabase/migrations/`
in particular must never be created — the CLI's convention, not upstream's (plan.md F-4). If a
behaviour turns out impossible to exercise without a source change, that is a FINDING for the owner,
never a workaround edit.
