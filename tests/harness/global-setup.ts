// TODO(TG-2 T008): replace this placeholder with the real global setup —
// reachability check against the local supabase stack (127.0.0.1:54321),
// `npx supabase start` if it is not up, then the ordered SQL apply
// (schema.sql + migration-002..006) per plan.md D-1/D-7.
//
// This file exists now only so vitest.config.ts's `globalSetup` reference
// resolves during TG-1 (no stack-dependent tests exist yet); it intentionally
// does nothing.
export default async function globalSetup() {}
