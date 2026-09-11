/*
 * The two calls this app makes to Google Calendar: list the owner's calendars,
 * and keep one event per task in step with it.
 *
 * The event's id is the task's own uuid with the dashes taken out. Google
 * accepts an id on insert, and hex digits are all legal in the base32hex
 * alphabet it wants, so the id needs no storing to be found again — and two
 * devices reaching for the calendar at the same moment write one event instead
 * of two.
 */
import { forgetToken, getToken } from './client'
import type { GcalConfig, Task } from '../db/types'

const BASE = 'https://www.googleapis.com/calendar/v3'
/** Nothing in the app says how long a task takes, so every event is the same length. */
const EVENT_MINUTES = 30

export interface Calendar {
  id: string
  summary: string
  primary: boolean
}

export class GcalError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** The token can die mid-flight; one retry with a fresh one, then it is an error. */
async function call(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  const token = await getToken()
  if (!token) throw new GcalError(401, 'no google token')


  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  })

  if (res.status === 401 && retry) {
    // Asking again without throwing the refused token away would only send the
    // same string a second time, which is how the retry used to pass its own
    // test and fail in the field.
    forgetToken()
    return call(path, init, false)
  }
  return res
}

export async function listCalendars(): Promise<Calendar[]> {
  const res = await call('/users/me/calendarList?minAccessRole=writer&maxResults=100')
  if (!res.ok) throw new GcalError(res.status, `calendarList: ${res.status}`)
  const body = (await res.json()) as {
    items?: { id: string; summary?: string; primary?: boolean }[]
  }
  return (body.items ?? []).map((c) => ({
    id: c.id,
    summary: c.summary ?? c.id,
    primary: c.primary === true,
  }))
}

export function eventIdOf(taskId: string): string {
  return taskId.replaceAll('-', '')
}

/*
 * The event, built from the task. `dateTime` carries no zone of its own, so the
 * zone travels beside it: the owner reads his calendar where he is, and an event
 * pinned to UTC would drift an hour twice a year.
 */
/** The zone the event is written in: the one the device reading it lives in. */
export function currentZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

function body(task: Task, cfg: GcalConfig): Record<string, unknown> {
  const zone = currentZone()
  const start = `${task.due_date}T${cfg.time}:00`
  const end = plusMinutes(start, EVENT_MINUTES)

  return {
    id: eventIdOf(task.id),
    summary: task.title,
    description: task.description || undefined,
    start: { dateTime: start, timeZone: zone },
    end: { dateTime: end, timeZone: zone },
    colorId: cfg.color_id ?? undefined,
    reminders: {
      useDefault: false,
      overrides: cfg.reminders.map((r) => ({ method: r.method, minutes: r.minutes })),
    },
  }
}

function plusMinutes(local: string, minutes: number): string {
  const [date, time] = local.split('T')
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  // Built and read back in UTC on purpose: this is clock arithmetic on a wall
  // time, and letting the local zone in would shift it across a DST boundary.
  const at = new Date(Date.UTC(y, m - 1, d, hh, mm + minutes))
  const p = (n: number) => String(n).padStart(2, '0')
  return `${at.getUTCFullYear()}-${p(at.getUTCMonth() + 1)}-${p(at.getUTCDate())}T${p(at.getUTCHours())}:${p(at.getUTCMinutes())}:00`
}

/** Creates the event, or rewrites it if it is already there. */
export async function putEvent(task: Task, cfg: GcalConfig): Promise<void> {
  const cal = encodeURIComponent(cfg.calendar_id)
  const made = await call(`/calendars/${cal}/events`, {
    method: 'POST',
    body: JSON.stringify(body(task, cfg)),
  })
  if (made.ok) return

  // 409 is the event already existing — which is exactly what a second device,
  // or a second run, is supposed to find.
  if (made.status !== 409) throw new GcalError(made.status, `insert: ${made.status}`)

  const id = eventIdOf(task.id)
  const patched = await call(`/calendars/${cal}/events/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body(task, cfg)),
  })
  if (!patched.ok) throw new GcalError(patched.status, `update: ${patched.status}`)
}

/** Takes the event away. Already gone counts as done. */
export async function deleteEvent(calendarId: string, taskId: string): Promise<void> {
  const cal = encodeURIComponent(calendarId)
  const res = await call(`/calendars/${cal}/events/${eventIdOf(taskId)}`, { method: 'DELETE' })
  if (res.ok || res.status === 404 || res.status === 410) return
  throw new GcalError(res.status, `delete: ${res.status}`)
}
