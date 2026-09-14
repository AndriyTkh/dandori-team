import { getLang, useLang, type Lang } from '../state/ui'
import { PLURALS, TEXT, type Forms, type PluralKey, type TextKey } from './dict'

/*
 * Looking a string up. The dictionary holds both languages per key, so all this
 * layer does is pick the column, fill the `{holes}` and, for a counted phrase,
 * ask `Intl.PluralRules` which form the number takes.
 */

export type Vars = Record<string, string | number>

/*
 * Each language named in itself, and so not in the dictionary: someone who
 * cannot read the current one still has to be able to find their own.
 */
export const LANG_TITLES: Record<Lang, string> = {
  ru: 'Русский',
  en: 'English',
}

const HOLE = /\{(\w+)\}/g

function fill(s: string, vars: Vars | undefined): string {
  if (!vars) return s
  return s.replace(HOLE, (whole, key: string) => (key in vars ? String(vars[key]) : whole))
}

// Building a PluralRules is not free and the reminder banner asks once per chip.
const rules = new Map<Lang, Intl.PluralRules>()

function rulesOf(lang: Lang): Intl.PluralRules {
  let r = rules.get(lang)
  if (!r) {
    r = new Intl.PluralRules(lang)
    rules.set(lang, r)
  }
  return r
}

export function textOf(lang: Lang, key: TextKey, vars?: Vars): string {
  return fill(TEXT[key][lang], vars)
}

function countOf(lang: Lang, key: PluralKey, n: number): string {
  // Widened on purpose: the literal type of the entry only lists the forms that
  // language happens to use, and the rule may name any of the six.
  const forms: Forms = PLURALS[key][lang]
  return fill(forms[rulesOf(lang).select(n)] ?? forms.other, { n })
}

/**
 * For code that runs outside a component — a row taking its default name at the
 * moment it is created. The name is then data and stays whatever it was born as.
 */
export function translate(key: TextKey, vars?: Vars): string {
  return textOf(getLang(), key, vars)
}

export interface T {
  (key: TextKey, vars?: Vars): string
  /** A counted phrase. The form comes from `Intl.PluralRules`, never from `n > 1`. */
  n(key: PluralKey, n: number): string
  /** The language itself, for the date helpers that take it. */
  lang: Lang
}

/*
 * There are two languages, so there are two of these and they are built once.
 * Handing back the same object every render is what lets a view pass `t` down
 * to its rows as an ordinary prop without re-rendering all of them.
 */
const bound = new Map<Lang, T>()

function boundTo(lang: Lang): T {
  let t = bound.get(lang)
  if (!t) {
    const fn = ((key: TextKey, vars?: Vars) => textOf(lang, key, vars)) as T
    fn.n = (key, n) => countOf(lang, key, n)
    fn.lang = lang
    bound.set(lang, (t = fn))
  }
  return t
}

/** The dictionary, bound to the language the device is set to. */
export function useT(): T {
  return boundTo(useLang())
}
