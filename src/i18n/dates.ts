import { diffDays, fromISODate, today } from '../db/dates'
import type { ISODate } from '../db/types'
import type { Lang } from '../state/ui'
import { textOf } from './index'

/*
 * Showing a date. The arithmetic stays in `db/dates` — it is the same in every
 * language; only the words change here.
 *
 * Month and weekday names come from `Intl` rather than a second table: Russian
 * needs the genitive for a day-and-month («7 сентября», not «7 сентябрь») and
 * the nominative for a month on its own («Сентябрь 2026»), and `Intl` already
 * knows both.
 */

const LOCALES: Record<Lang, string> = {
  ru: 'ru',
  // en-GB, not en: plain `en` puts the month first — "September 7" where a day
  // column header wants "7 September".
  en: 'en-GB',
}

const FORMATS = {
  weekday: { weekday: 'short' },
  month: { month: 'long' },
  dayMonth: { day: 'numeric', month: 'long' },
} satisfies Record<string, Intl.DateTimeFormatOptions>

type Format = keyof typeof FORMATS

const cache = new Map<string, Intl.DateTimeFormat>()

function fmt(lang: Lang, format: Format): Intl.DateTimeFormat {
  const key = `${lang}.${format}`
  let f = cache.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(LOCALES[lang], FORMATS[format])
    cache.set(key, f)
  }
  return f
}

/** Russian names arrive lowercase from `Intl`; a heading wants them capitalised. */
function capitalized(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function weekdayShort(s: ISODate, lang: Lang): string {
  return capitalized(fmt(lang, 'weekday').format(fromISODate(s)))
}

export function monthName(s: ISODate, lang: Lang): string {
  return capitalized(fmt(lang, 'month').format(fromISODate(s)))
}

/** Day number with the month name — for day column headers. */
export function dayLabel(s: ISODate, lang: Lang): string {
  return fmt(lang, 'dayMonth').format(fromISODate(s))
}

/** Month name with the year — for the month header. */
export function monthLabel(s: ISODate, lang: Lang): string {
  return `${monthName(s, lang)} ${fromISODate(s).getFullYear()}`
}

/** Relative day label for the day column header. */
export function relativeDayLabel(s: ISODate, lang: Lang, now: ISODate = today()): string | null {
  const d = diffDays(now, s)
  if (d === 0) return textOf(lang, 'board.today')
  if (d === 1) return textOf(lang, 'board.tomorrow')
  if (d === -1) return textOf(lang, 'board.yesterday')
  return null
}
