/*
 * What this app says to Google Calendar: list the owner's calendars, keep one
 * event per task in step with it, and ask which events have gone.
 *
 * The event's id is the task's own uuid with the dashes taken out. Google
 * accepts an id on insert, and hex digits are all legal in the base32hex
 * alphabet it wants, so the id needs no storing to be found again — and two
 * devices reaching for the calendar at the same moment write one event instead
 * of two.
 */
import { forgetToken, getToken } from './client'
import { taskDate } from '../db/types'
import type { GcalConfig, Task } from '../db/types'

const BASE = 'https://www.googleapis.com/calendar/v3'
/** Nothing in the app says how long a task takes, so every event is the same length. */
const EVENT_MINUTES = 30

export interface Calendar {
  id: string
  /** The id Google lists it under — for the main calendar, the account's address. */
  listedAs: string
  summary: string
  primary: boolean
}

export class GcalError extends Error {
  status: number
  /*
   * Google's own word for what went wrong. The status alone does not say it:
   * it answers a calendar the owner may only read and a spent quota with the
   * same 403, and the two want opposite things from the caller.
   */
  reason: string | null

  constructor(status: number, message: string, reason: string | null = null) {
    super(message)
    this.status = status
    this.reason = reason
  }
}

/** The refusal, with the reason read out of the body Google sends with it. */
async function refusal(res: Response, what: string): Promise<GcalError> {
  let reason: string | null = null
  try {
    const body = (await res.json()) as { error?: { errors?: { reason?: string }[] } }
    reason = body.error?.errors?.[0]?.reason ?? null
  } catch {
    // An error with no body of its own, or one that is not JSON at all.
  }
  return new GcalError(res.status, `${what}: ${res.status}${reason ? ` ${reason}` : ''}`, reason)
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
  if (!res.ok) throw await refusal(res, 'calendarList')
  const body = (await res.json()) as {
    items?: { id: string; summary?: string; primary?: boolean }[]
  }
  return (body.items ?? []).map((c) => ({
    // Google lists the main calendar under the account's own address, and also
    // answers to `primary` for it — which is what this app writes by default.
    // Left as two ids it is one calendar offered twice, and choosing the other
    // of them moves the event to where it already stands.
    id: c.primary === true ? 'primary' : c.id,
    listedAs: c.id,
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
  const start = `${taskDate(task)}T${cfg.time}:00`
  const end = plusMinutes(start, EVENT_MINUTES)

  return {
    id: eventIdOf(task.id),
    // A deleted event is kept by Google as `cancelled` under the same id, and an
    // insert over it is refused as a duplicate. Saying outright that the event
    // is confirmed is what brings such a one back; on a new event it is what
    // Google would have assumed anyway.
    status: 'confirmed',
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

/**
 * Creates the event, or rewrites it if it is already there.
 *
 * `standing` is the task's own record of an event already in this calendar. It
 * decides which call goes first and nothing else: every rewrite used to open
 * with an insert that was always refused, so an edited task cost two calls and
 * left a 409 in the console each time. Either way round the other call follows,
 * because the record can be wrong — an event deleted in Google behind the app's
 * back, or one a second device made a moment ago.
 */
export async function putEvent(task: Task, cfg: GcalConfig, standing: boolean): Promise<void> {
  const cal = encodeURIComponent(cfg.calendar_id)
  const id = eventIdOf(task.id)
  const payload = JSON.stringify(body(task, cfg))

  const update = () => call(`/calendars/${cal}/events/${id}`, { method: 'PUT', body: payload })
  const insert = () => call(`/calendars/${cal}/events`, { method: 'POST', body: payload })

  const first = await (standing ? update() : insert())
  if (first.ok) return
  // The two ways the record can be wrong: nothing there to rewrite — gone, or
  // swept away for good — or something there already, which is either a second
  // device's event or the cancelled one Google keeps after a delete.
  const expected = standing ? [404, 410] : [409]
  if (!expected.includes(first.status)) throw await refusal(first, standing ? 'update' : 'insert')

  const second = await (standing ? insert() : update())
  if (!second.ok) throw await refusal(second, standing ? 'insert' : 'update')
}

/**
 * The ids of events deleted in this calendar since `since`, an RFC3339 time.
 *
 * The one thing read back out of Google. `updatedMin` hands back everything
 * touched since that moment, deletions included whatever `showDeleted` says;
 * only the deletions are looked at here, and only their ids. A calendar busy
 * enough to page is walked, up to a limit: this runs once a minute, and a
 * calendar that cannot be read in twenty pages is not one worth blocking the
 * pass for.
 */
export async function deletedSince(calendarId: string, since: string): Promise<string[]> {
  const cal = encodeURIComponent(calendarId)
  const gone: string[] = []
  let page: string | null = null

  for (let walked = 0; walked < 20; walked++) {
    const query =
      `/calendars/${cal}/events?showDeleted=true&maxResults=250` +
      `&updatedMin=${encodeURIComponent(since)}` +
      (page === null ? '' : `&pageToken=${encodeURIComponent(page)}`)
    const res = await call(query)
    if (!res.ok) throw await refusal(res, 'list')
    const body = (await res.json()) as {
      items?: { id?: string; status?: string }[]
      nextPageToken?: string
    }
    for (const item of body.items ?? []) {
      if (item.status === 'cancelled' && item.id) gone.push(item.id)
    }
    page = body.nextPageToken ?? null
    if (page === null) return gone
  }
  // Only the first question about a calendar can reach this far — every one
  // after it covers a minute. Said out loud rather than returned quietly: what
  // is past the limit is a deletion nobody will hear about.
  console.error('[gcal] calendar too busy to read to the end', calendarId)
  return gone
}

/** Takes the event away. Already gone counts as done. */
export async function deleteEvent(calendarId: string, taskId: string): Promise<void> {
  const cal = encodeURIComponent(calendarId)
  const res = await call(`/calendars/${cal}/events/${eventIdOf(taskId)}`, { method: 'DELETE' })
  if (res.ok || res.status === 404 || res.status === 410) return
  throw await refusal(res, 'delete')
}
