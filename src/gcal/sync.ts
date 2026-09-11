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
import { db, setMeta } from '../db/local'
import { currentSession, requestPush } from '../sync/sync'
import { currentZone, deleteEvent, GcalError, putEvent } from './api'
import { getToken, isConnected } from './client'
import { gcalConfigOf, type GcalConfig, type ID, type Task, type Workspace } from '../db/types'

/** How often the whole set is looked over, when nothing else prompts it. */
const TICK_MS = 60_000
/** After a refusal that is not the owner's fault, wait before trying again. */
const BACKOFF_MS = 5 * 60_000

const KEY_PREFIX = 'gcal:'
const sentKey = (taskId: ID) => `${KEY_PREFIX}${taskId}`

/*
 * The parts of the signature are joined on a NUL rather than a space: a title
 * can hold anything, and two fields running together must not be able to look
 * like one. Written as an escape — a raw NUL in the source turns the file
 * binary, and git stops diffing it while grep stops searching it, silently.
 */
const SEP = '\u0000'

/** What this device last put in the calendar for one task. */
interface Sent {
  /**
   * The calendar it went into. The task carries that as well, and the task's is
   * the record that travels between devices; this copy is what the pass falls
   * back on when the task's has been lost — see `placed`.
   */
  cal: string
  /** Everything about the event that could change, flattened into one string. */
  sig: string
}

/** This device's memory of its own traffic, read once for the whole pass. */
async function sentNotes(): Promise<Map<ID, Sent>> {
  const notes = new Map<ID, Sent>()
  for (const row of await db.meta.toArray()) {
    if (!row.key.startsWith(KEY_PREFIX)) continue
    try {
      notes.set(row.key.slice(KEY_PREFIX.length), JSON.parse(row.value) as Sent)
    } catch {
      // Unreadable: this pass simply does not know about that one, and the
      // task's own record still does.
    }
  }
  return notes
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

/*
 * Records which calendar the task's event stands in, `null` for none.
 *
 * Bookkeeping, not an edit: `updated_at` stays exactly where the owner's last
 * edit left it, so this row can never win a conflict against an edit made on
 * another device while it waited in the queue. And it asks to be sent at once
 * instead of waiting for the next cycle — until it lands it is the only record
 * that the event exists at all, and a sign-out here would take it away with the
 * cache.
 */
async function placed(taskId: ID, calendar: string | null): Promise<void> {
  // Read and written as one step, or an edit saved in between is put back.
  const changed = await db.transaction('rw', db.tasks, async () => {
    const row = await db.tasks.get(taskId)
    if (!row || row.gcal_placed === calendar) return false
    await db.tasks.put({ ...row, gcal_placed: calendar, _dirty: 1 })
    return true
  })
  if (changed) requestPush()
}

/*
 * The pass outlives a sign-out otherwise. Google answers slowly enough that a
 * pass started before it went on creating events after it — events whose
 * placement then had no row left to be written to — and wrote its notes, the
 * titles in them, into the database the next account opens. Checked before
 * every call to Google and every local write, like the sync's own exchange.
 */
class SignedOut extends Error {}

function still(mine: number): void {
  if (mine !== currentSession()) throw new SignedOut()
}

async function reconcileTask(
  task: Task,
  cfg: GcalConfig | null,
  sent: Sent | null,
  mine: number,
): Promise<void> {
  /*
   * Where the event stands, whoever put it there. Carrying no stamp of its own,
   * the record is refused by the server when another device has edited the task
   * in the meantime, and the pull that follows brings back that device's row —
   * which has never heard of the event. The local note is what the pass falls
   * back on then, and writing the record again from it is how that heals.
   */
  const standing = task.gcal_placed ?? sent?.cal ?? null

  if (!cfg) {
    still(mine)
    if (standing) await deleteEvent(standing, task.id)
    still(mine)
    if (sent) await db.meta.delete(sentKey(task.id))
    still(mine)
    if (standing) await placed(task.id, null)
    return
  }

  const sig = signature(task, cfg)
  // The task's own record, not the fallback: while that one is missing there is
  // a placement to write, however little else has changed.
  if (task.gcal_placed === cfg.calendar_id && sent?.sig === sig) return

  // Moved to another calendar. Google keeps events per calendar, so the old copy
  // has to go before the new one is written, or both would stand there.
  still(mine)
  if (standing && standing !== cfg.calendar_id) await deleteEvent(standing, task.id)

  still(mine)
  await putEvent(task, cfg, standing === cfg.calendar_id)
  still(mine)
  await setMeta(sentKey(task.id), JSON.stringify({ cal: cfg.calendar_id, sig }))
  still(mine)
  await placed(task.id, cfg.calendar_id)
}

/*
 * Whether a refusal is about the account rather than about the one task.
 * Google answers a spent quota with 429 — and also with a 403 that looks exactly
 * like the 403 for a calendar the owner may only read. The reason it names is
 * the only thing that tells those two apart.
 */
const SPENT = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded'])

function spent(err: GcalError): boolean {
  return err.status === 429 || (err.reason !== null && SPENT.has(err.reason))
}

let running = false
let until = 0

/** One pass over every task that has an event or wants one. */
export async function reconcile(): Promise<void> {
  if (running || Date.now() < until) return
  if (!isConnected()) return
  if ((await getToken()) === null) return

  running = true
  const mine = currentSession()
  try {
    const spaces = new Map((await db.workspaces.toArray()).map((w) => [w.id, w]))
    const notes = await sentNotes()

    for (const task of await db.tasks.toArray()) {
      const cfg = configFor(task, spaces.get(task.workspace_id))
      const sent = notes.get(task.id) ?? null
      // Nothing wanted and nothing standing: the overwhelming majority of rows.
      if (!cfg && task.gcal_placed === null && !sent) continue
      try {
        await reconcileTask(task, cfg, sent, mine)
      } catch (err) {
        if (err instanceof SignedOut) return
        if (err instanceof GcalError && spent(err)) {
          // Out of quota: every other task would collect the same answer, so the
          // pass stops rather than spend the rest of itself on it.
          until = Date.now() + BACKOFF_MS
          console.error('[gcal] backing off', err.message)
          return
        }
        // One task refused — a calendar gone read-only, say. That is this task's
        // own trouble: dropping the whole pass over it would leave every task
        // after it unwritten, and the order never changes, so for good.
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
