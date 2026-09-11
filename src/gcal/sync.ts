/*
 * Keeping the calendar in step with the tasks.
 *
 * Nothing here hooks the places a task is written. The same reconciliation runs
 * over everything on a tick: work out what each task's event should be, compare
 * it with what was last sent, and send the difference. A card dragged to another
 * day, a title edited on the phone, a task ticked off — all of them are the same
 * question asked again, and none of them needs its own call site.
 *
 * What was last sent lives in the local `meta` table, not on the task: it is
 * this device's memory of its own traffic. Syncing it would only teach the phone
 * to skip work the laptop had already done, and that work is one idempotent
 * write it can well afford to repeat.
 */
import { db, getMeta, setMeta } from '../db/local'
import { currentZone, deleteEvent, GcalError, putEvent } from './api'
import { getToken, isConnected } from './client'
import { gcalConfigOf, type GcalConfig, type ID, type Task, type Workspace } from '../db/types'

/** How often the whole set is looked over, when nothing else prompts it. */
const TICK_MS = 60_000
/** After a refusal that is not the owner's fault, wait before trying again. */
const BACKOFF_MS = 5 * 60_000

const sentKey = (taskId: ID) => `gcal:${taskId}`

/*
 * The parts of the signature are joined on a NUL rather than a space: a title
 * can hold anything, and two fields running together must not be able to look
 * like one. Written as an escape — a raw NUL in the source turns the file
 * binary, and git stops diffing it while grep stops searching it, silently.
 */
const SEP = '\u0000'

/** What this device last put in the calendar for one task. */
interface Sent {
  /** The calendar it went into — it has to be known to take it out again. */
  cal: string
  /** Everything about the event that could change, flattened into one string. */
  sig: string
}

function signature(task: Task, cfg: GcalConfig): string {
  const reminders = cfg.reminders.map((r) => `${r.method}:${r.minutes}`).join(',')
  return [
    task.title,
    task.description,
    task.due_date,
    cfg.time,
    cfg.color_id ?? '',
    reminders,
    // The event is written in the zone of whichever device wrote it. Leave it
    // out of the signature and it freezes at that device's while every other
    // field goes on being brought up to date.
    currentZone(),
  ].join(SEP)
}

/*
 * How a task's event should be made, or `null` if it should not exist.
 *
 * A task's own settings always win. Failing that, the workspace's switch stands
 * for every dated task in it — a standing arrangement rather than a one-off
 * stamp on each row: a task made tomorrow joins without being told, changing
 * the defaults changes them all, and turning the switch off takes the events
 * away again. A task the owner configured himself is never overwritten by it.
 */
function configFor(task: Task, workspace: Workspace | undefined): GcalConfig | null {
  if (task.deleted || task.done || task.due_date === null) return null
  if (task.gcal) return gcalConfigOf(task.gcal)
  if (workspace?.gcal_sync && workspace.gcal) return workspace.gcal
  return null
}

/** Records which calendar the task's event stands in, `null` for none. */
async function placed(taskId: ID, calendar: string | null): Promise<void> {
  const row = await db.tasks.get(taskId)
  if (!row || row.gcal_placed === calendar) return
  await db.tasks.put({ ...row, gcal_placed: calendar, updated_at: nowStamp(), _dirty: 1 })
}

const nowStamp = () => new Date().toISOString()

async function reconcileTask(task: Task, cfg: GcalConfig | null): Promise<void> {
  const raw = await getMeta(sentKey(task.id))
  const sent = raw ? (JSON.parse(raw) as Sent) : null
  // Where the event stands, whoever put it there. The local note is only this
  // device's shortcut for skipping work it has already done.
  const standing = task.gcal_placed

  if (!cfg) {
    if (standing) await deleteEvent(standing, task.id)
    if (sent) await db.meta.delete(sentKey(task.id))
    if (standing) await placed(task.id, null)
    return
  }

  const sig = signature(task, cfg)
  if (standing === cfg.calendar_id && sent?.sig === sig) return

  // Moved to another calendar. Google keeps events per calendar, so the old copy
  // has to go before the new one is written, or both would stand there.
  if (standing && standing !== cfg.calendar_id) await deleteEvent(standing, task.id)

  await putEvent(task, cfg)
  await setMeta(sentKey(task.id), JSON.stringify({ cal: cfg.calendar_id, sig }))
  await placed(task.id, cfg.calendar_id)
}

let running = false
let until = 0

/** One pass over every task that has an event or wants one. */
export async function reconcile(): Promise<void> {
  if (running || Date.now() < until) return
  if (!isConnected()) return
  if ((await getToken()) === null) return

  running = true
  try {
    const spaces = new Map((await db.workspaces.toArray()).map((w) => [w.id, w]))

    for (const task of await db.tasks.toArray()) {
      const cfg = configFor(task, spaces.get(task.workspace_id))
      // Nothing wanted and nothing standing: the overwhelming majority of rows.
      if (!cfg && task.gcal_placed === null) continue
      try {
        await reconcileTask(task, cfg)
      } catch (err) {
        if (err instanceof GcalError && (err.status === 403 || err.status === 429)) {
          // Out of quota, or refused outright: stop the pass rather than spend
          // the rest of it collecting the same answer.
          until = Date.now() + BACKOFF_MS
          console.error('[gcal] backing off', err.message)
          return
        }
        console.error('[gcal] task failed', task.id, err)
      }
    }
  } finally {
    running = false
  }
}

export interface GcalHandle {
  stop: () => void
}

/** Runs the reconciliation for as long as the app is open. */
export function startGcal(): GcalHandle {
  let stopped = false
  const tick = () => {
    if (!stopped) void reconcile()
  }
  const onVisible = () => {
    if (document.visibilityState === 'visible') tick()
  }

  window.addEventListener('online', tick)
  document.addEventListener('visibilitychange', onVisible)
  const timer = setInterval(tick, TICK_MS)
  tick()

  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
      window.removeEventListener('online', tick)
      document.removeEventListener('visibilitychange', onVisible)
    },
  }
}
