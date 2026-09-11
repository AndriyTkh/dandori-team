import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ID } from '../db/types'

/*
 * UI settings. They live in localStorage and deliberately do not sync: which tab
 * is open and which theme is picked is each device's own business.
 */

const KEYS = {
  workspace: 'dandori.workspace',
  tab: 'dandori.tab',
  theme: 'dandori.theme',
  boardMode: 'dandori.boardMode',
  timelineZoom: 'dandori.timelineZoom',
  lang: 'dandori.lang',
} as const

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Private mode or storage blocked — the setting just won't survive a reload.
  }
}

function usePersisted<T extends string>(key: string, fallback: T, allowed: readonly T[]) {
  const [value, setValue] = useState<T>(() => {
    const stored = read(key) as T | null
    return stored && allowed.includes(stored) ? stored : fallback
  })

  const set = useCallback(
    (next: T) => {
      setValue(next)
      write(key, next)
    },
    [key],
  )

  return [value, set] as const
}

// --------------------------------------------------------------------- tabs

export const TABS = ['board', 'timeline', 'notes'] as const
export type Tab = (typeof TABS)[number]

export function useTab() {
  return usePersisted<Tab>(KEYS.tab, 'board', TABS)
}

// ---------------------------------------------------------------- board mode

export const BOARD_MODES = ['days', 'ribbon', 'month'] as const
export type BoardMode = (typeof BOARD_MODES)[number]

export function useBoardMode() {
  return usePersisted<BoardMode>(KEYS.boardMode, 'days', BOARD_MODES)
}

// ------------------------------------------------------------- timeline zoom

export const TIMELINE_ZOOMS = ['all', 'month'] as const
export type TimelineZoom = (typeof TIMELINE_ZOOMS)[number]

export function useTimelineZoom() {
  return usePersisted<TimelineZoom>(KEYS.timelineZoom, 'all', TIMELINE_ZOOMS)
}

// --------------------------------------------------------------------- theme

export const THEMES = ['system', 'light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

export function useTheme() {
  const [theme, setTheme] = usePersisted<Theme>(KEYS.theme, 'system', THEMES)

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
  }, [theme])

  return [theme, setTheme] as const
}

// ------------------------------------------------------------------ language

export const LANGS = ['ru', 'en'] as const
export type Lang = (typeof LANGS)[number]

/*
 * The language is the one setting that is not read through a single component.
 * Every view asks for it, and so does the database layer, where a row takes its
 * default name at the moment it is created. So it is one shared value with
 * subscribers rather than a `usePersisted` per caller: those each hold their own
 * copy, and only the one that was clicked would have changed.
 */
let lang: Lang = (() => {
  const stored = read(KEYS.lang) as Lang | null
  return stored && LANGS.includes(stored) ? stored : 'ru'
})()

const langWatchers = new Set<() => void>()

// What a screen reader and the browser's own spell-checker go by. `index.html`
// ships `ru`; put the stored choice in before the first paint.
document.documentElement.lang = lang

export function getLang(): Lang {
  return lang
}

export function setLang(next: Lang): void {
  if (next === lang) return
  lang = next
  write(KEYS.lang, next)
  document.documentElement.lang = next
  for (const watcher of langWatchers) watcher()
}

function watchLang(fn: () => void): () => void {
  langWatchers.add(fn)
  return () => void langWatchers.delete(fn)
}

export function useLang(): Lang {
  return useSyncExternalStore(watchLang, getLang)
}

// --------------------------------------------------------------- workspaces

export function useCurrentWorkspace(available: ID[] | undefined) {
  const [chosen, setChosen] = useState<ID | null>(() => read(KEYS.workspace))

  // The stored workspace may be gone: deleted here or on another device.
  // Fall back to the first available one during render, to save an extra pass.
  const id = !available ? chosen : chosen && available.includes(chosen) ? chosen : available[0] ?? null

  // Remember the workspace we fell back to, so the next launch opens the same one.
  useEffect(() => {
    if (id) write(KEYS.workspace, id)
  }, [id])

  const select = useCallback((next: ID) => {
    setChosen(next)
    write(KEYS.workspace, next)
  }, [])

  return [id, select] as const
}
