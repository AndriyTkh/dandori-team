// Known local starting state for stories that begin "signed in, with a
// workspace and a task already there" (plan.md D-2, D-3).
//
// Signs the given throwaway account's credentials in on the app's own
// singleton (`src/auth/supabase.ts`) — the same path the sync-cycle harness
// (`tests/harness/sync.ts`) drives — then writes through `src/db/api.ts`,
// the UI's only write path, so the seeded rows go through the same
// gap-allocated positions, default-name fallback and `_dirty` marking real
// UI writes would produce (ARCHITECTURE §4 L407-424).
import { supabase } from '../../src/auth/supabase'
import { createTask, createWorkspace, type NewTask } from '../../src/db/api'
import { db } from '../../src/db/local'
import type { ID, Task, Workspace } from '../../src/db/types'
import type { TestUser } from './accounts'
import { flushQueue } from './sync'

export interface Seeded {
  workspaceId: ID
  taskId: ID
}

/**
 * Signs `testUser` in on the app singleton, then creates one workspace and
 * one task inside it through `src/db/api.ts`. Returns the ids so a test can
 * read them back (from Dexie, or after a sync cycle, from the server).
 */
export async function seedWorkspaceWithTask(
  testUser: TestUser,
  options?: { workspaceName?: string; task?: NewTask },
): Promise<Seeded> {
  const { error } = await supabase.auth.signInWithPassword({
    email: testUser.email,
    password: testUser.password,
  })
  if (error) {
    throw new Error(`seedWorkspaceWithTask: sign-in for ${testUser.email} failed: ${error.message}`)
  }

  const workspaceId = await createWorkspace(options?.workspaceName ?? 'seeded workspace')
  const taskId = await createTask(workspaceId, options?.task ?? { title: 'seeded task' })

  return { workspaceId, taskId }
}

export interface SeededTeamWorkspace {
  workspaceId: ID
  /** `owner.user.id` — the account whose `members` row `workspaces_zz_kind_change` (personal→team branch) seeds server-side. */
  ownerId: ID
  /** One `auth.users` id per entry in `members`, in the order given, once each `add_member_by_email` call succeeds. */
  memberIds: ID[]
}

/**
 * Signs `owner` in on the app singleton, creates one workspace through
 * `createWorkspace` — the same `src/db/api.ts` path `seedWorkspaceWithTask`
 * uses — flushes the queue so that row is actually on the server, flips it to
 * `kind: 'team'`, then adds each of `members` to it through the
 * `add_member_by_email` RPC (`contracts/rpc.md`), never by inserting a
 * `members` row directly.
 *
 * The `kind` write carries a stamp that outranks the row's current
 * `updated_at`, matching `keep_newer()`'s own comparison
 * (`new.updated_at < old.updated_at` ⇒ dropped, silently, no PostgREST error —
 * `supabase/schema.sql:142-153`, pinned by T017/R-19): a bare
 * `{ kind: 'team' }` write leaves `updated_at` untouched, which is safe on its
 * own, but this helper reads the stored value back and sends
 * `max(that, now())` explicitly rather than relying on it, so nothing about
 * `keep_newer`'s exact rule is assumed. The write is then read back and this
 * throws loudly if `kind` did not end up `'team'` — a seed that hands back a
 * quietly-wrong fixture is worse than one that fails here. Each
 * `add_member_by_email` call is checked the same way, its error `code`
 * included, before its id is recorded.
 *
 * Pull ordering: the owner's own `owner` row is `workspaces_zz_kind_change`'s
 * (personal→team branch of `on_workspace_kind_change()`) server-side effect,
 * in the same transaction as the `kind` update below — a
 * caller may query `public.members` for it directly the moment this helper
 * returns. It is **not** pulled into local Dexie by this helper (no
 * `driveSyncCycle` is run here): a caller that needs the row through Dexie or
 * through the UI layer must drive its own sync cycle first.
 *
 * `workspaces.kind`, `public.members` and `add_member_by_email` do not exist
 * until T020–T024 land, so this helper throws at runtime until then — the
 * expected, red-first state for T019 (plan.md D-13 "Harness additions").
 */
export async function seedTeamWorkspace(
  owner: TestUser,
  members: TestUser[],
): Promise<SeededTeamWorkspace> {
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: owner.email,
    password: owner.password,
  })
  if (signInError) {
    throw new Error(`seedTeamWorkspace: sign-in for ${owner.email} failed [${signInError.code}]: ${signInError.message}`)
  }

  const workspaceId = await createWorkspace('seeded team workspace')
  // createWorkspace only writes to Dexie and debounces its push
  // (`src/db/api.ts:37-39`); the direct server writes below need the row to
  // actually be there first.
  const pendingAfterFlush = await flushQueue()
  if (pendingAfterFlush > 0) {
    throw new Error(
      `seedTeamWorkspace: flushQueue() left ${pendingAfterFlush} item(s) pending after ${workspaceId}'s creation — the workspace row is not yet on the server`,
    )
  }

  const { data: current, error: readError } = await supabase
    .from('workspaces')
    .select('updated_at')
    .eq('id', workspaceId)
    .single()
  if (readError || !current) {
    throw new Error(
      `seedTeamWorkspace: reading ${workspaceId} back before the kind write failed [${readError?.code}]: ${readError?.message ?? 'no row returned'}`,
    )
  }
  const parsedCurrent = Date.parse(current.updated_at)
  if (Number.isNaN(parsedCurrent)) {
    throw new Error(
      `seedTeamWorkspace: ${workspaceId}'s updated_at (${current.updated_at}) did not parse as a date`,
    )
  }
  // +1ms: Date.parse truncates Postgres's microsecond updated_at to
  // milliseconds, so on a stack whose server clock leads the client, a bare
  // max() of the two can land strictly below the stored value and
  // keep_newer() cancels the update. The verified read-back below still
  // catches that, but +1 avoids the flake outright.
  const outrankingStamp = new Date(Math.max(parsedCurrent + 1, Date.now())).toISOString()

  const { error: kindError } = await supabase
    .from('workspaces')
    .update({ kind: 'team', updated_at: outrankingStamp })
    .eq('id', workspaceId)
  if (kindError) {
    throw new Error(
      `seedTeamWorkspace: setting kind='team' on ${workspaceId} failed [${kindError.code}]: ${kindError.message}`,
    )
  }

  const { data: verified, error: verifyError } = await supabase
    .from('workspaces')
    .select('kind')
    .eq('id', workspaceId)
    .single()
  if (verifyError || verified?.kind !== 'team') {
    throw new Error(
      `seedTeamWorkspace: ${workspaceId} did not read back as kind='team' (got ${JSON.stringify(verified?.kind)}; [${verifyError?.code}] ${verifyError?.message ?? 'no read error'}) — the write was cancelled or never landed`,
    )
  }

  const memberIds: ID[] = []
  for (const member of members) {
    const { data: added, error: addError } = await supabase.rpc('add_member_by_email', {
      ws: workspaceId,
      email: member.email,
    })
    if (addError) {
      throw new Error(
        `seedTeamWorkspace: add_member_by_email(${member.email}) on ${workspaceId} failed [${addError.code}]: ${addError.message}`,
      )
    }
    // Record the id the server actually resolved, not member.user.id blindly:
    // add_member_by_email returns the existing owner row (edge case 5) if a
    // caller ever passes the owner in `members`, and nothing else proves the
    // two match.
    if (added?.member_id !== member.user.id) {
      throw new Error(
        `seedTeamWorkspace: add_member_by_email(${member.email}) on ${workspaceId} resolved to member_id ${added?.member_id}, not ${member.user.id} as expected`,
      )
    }
    memberIds.push(added.member_id)
  }

  return { workspaceId, ownerId: owner.user.id, memberIds }
}

/** Reads the seeded workspace back from Dexie, `undefined` if not (yet) there. */
export async function readSeededWorkspace(workspaceId: ID): Promise<Workspace | undefined> {
  return db.workspaces.get(workspaceId)
}

/** Reads the seeded task back from Dexie, `undefined` if not (yet) there. */
export async function readSeededTask(taskId: ID): Promise<Task | undefined> {
  return db.tasks.get(taskId)
}
