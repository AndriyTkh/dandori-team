import type { ISODate } from './types'

/*
 * The whole app works with dates that carry no time of day.
 * A date is a `YYYY-MM-DD` string in the user's local time.
 * A Date object is only an intermediate representation, and it is always read
 * and written through its local components, never the UTC ones.
 *
 * Arithmetic only. Turning a date into words is a matter of language and lives
 * in `src/i18n/dates.ts`.
 */

function toISODate(d: Date): ISODate {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function fromISODate(s: ISODate): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function today(): ISODate {
  return toISODate(new Date())
}

export function addDays(s: ISODate, n: number): ISODate {
  const d = fromISODate(s)
  d.setDate(d.getDate() + n)
  return toISODate(d)
}

export function addMonths(s: ISODate, n: number): ISODate {
  const d = fromISODate(s)
  const day = d.getDate()
  d.setDate(1)
  d.setMonth(d.getMonth() + n)
  // Keeps January 31 from turning into March 3.
  d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())))
  return toISODate(d)
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

/** Difference in days: `b - a`. Negative when `b` is earlier than `a`. */
export function diffDays(a: ISODate, b: ISODate): number {
  const ms = fromISODate(b).getTime() - fromISODate(a).getTime()
  return Math.round(ms / 86_400_000)
}

/** List of dates from `from` to `to`, inclusive. */
export function dateRange(from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = []
  for (let d = from; diffDays(d, to) >= 0; d = addDays(d, 1)) out.push(d)
  return out
}

/** Monday of the week the date falls in. */
export function startOfWeek(s: ISODate): ISODate {
  const d = fromISODate(s)
  const shift = (d.getDay() + 6) % 7
  return addDays(s, -shift)
}

export function startOfMonth(s: ISODate): ISODate {
  return `${s.slice(0, 7)}-01`
}

function endOfMonth(s: ISODate): ISODate {
  const d = fromISODate(s)
  return toISODate(new Date(d.getFullYear(), d.getMonth() + 1, 0))
}

/**
 * Month grid: whole weeks starting on Monday, always full rows.
 * Days from the neighbouring months are part of the grid — tell them apart
 * with `isSameMonth`.
 */
export function monthGrid(anchor: ISODate): ISODate[] {
  const first = startOfWeek(startOfMonth(anchor))
  const last = endOfMonth(anchor)
  const cells = Math.ceil((diffDays(first, last) + 1) / 7) * 7
  return Array.from({ length: cells }, (_, i) => addDays(first, i))
}

export function isSameMonth(a: ISODate, b: ISODate): boolean {
  return a.slice(0, 7) === b.slice(0, 7)
}

export function isWeekend(s: ISODate): boolean {
  const day = fromISODate(s).getDay()
  return day === 0 || day === 6
}
