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

/** Reads the seeded workspace back from Dexie, `undefined` if not (yet) there. */
export async function readSeededWorkspace(workspaceId: ID): Promise<Workspace | undefined> {
  return db.workspaces.get(workspaceId)
}

/** Reads the seeded task back from Dexie, `undefined` if not (yet) there. */
export async function readSeededTask(taskId: ID): Promise<Task | undefined> {
  return db.tasks.get(taskId)
}
