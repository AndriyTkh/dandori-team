import { useLiveQuery } from 'dexie-react-hooks'
import { listLabels, listNotes, listTasks, listWorkspaces } from './api'
import { db } from './local'
import type { ID, Label, Note, Task, Workspace } from './types'

/*
 * Reactive reads from the local database.
 * Any write — ours or one that arrived from the server — re-renders the UI on its own.
 *
 * The single-row hooks have three states: `undefined` means the database has not
 * answered yet, `null` means the row is missing or was deleted, an object means
 * the row is there. The first two must not be merged: loading would then be
 * indistinguishable from a delete on another device, and an open dialog would
 * never learn that it should close.
 *
 * What each of them reads is the `list…` of `api.ts`, so that the rule about
 * what a view shows — never a deleted row, and in this order — is written once.
 */

export function useWorkspaces(): Workspace[] | undefined {
  return useLiveQuery(() => listWorkspaces(), [])
}

export function useLabels(workspaceId: ID | null): Label[] | undefined {
  return useLiveQuery(() => (workspaceId ? listLabels(workspaceId) : []), [workspaceId])
}

export function useTasks(workspaceId: ID | null): Task[] | undefined {
  return useLiveQuery(() => (workspaceId ? listTasks(workspaceId) : []), [workspaceId])
}

export function useTask(id: ID | null): Task | null | undefined {
  return useLiveQuery(async () => {
    if (!id) return null
    const row = await db.tasks.get(id)
    return row && !row.deleted ? row : null
  }, [id])
}

export function useNotes(workspaceId: ID | null): Note[] | undefined {
  return useLiveQuery(() => (workspaceId ? listNotes(workspaceId) : []), [workspaceId])
}

