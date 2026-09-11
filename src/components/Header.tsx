import { useCallback, useEffect, useRef, useState } from 'react'
import { createWorkspace } from '../db/api'
import type { ID, Label, Workspace } from '../db/types'
import { useT, type T } from '../i18n'
import { TABS, type Tab } from '../state/ui'
import { LabelFilter } from './LabelFilter'
import { SyncBadge } from './SyncBadge'
import './Header.css'

interface Props {
  workspaces: Workspace[]
  currentId: ID | null
  onSelectWorkspace: (id: ID) => void
  tab: Tab
  onSelectTab: (tab: Tab) => void
  labels: Label[]
  activeLabels: ID[]
  onToggleLabel: (id: ID) => void
  onOpenSettings: () => void
  /** Where the open view puts controls of its own: the board's range modes. */
  toolsSlot: (el: HTMLDivElement | null) => void
}

export function Header({ toolsSlot, ...props }: Props) {
  const t = useT()
  const current = props.workspaces.find((w) => w.id === props.currentId) ?? null

  return (
    <header className="header">
      <WorkspaceMenu
        workspaces={props.workspaces}
        current={current}
        onSelect={props.onSelectWorkspace}
        t={t}
      />

      {/* Nothing to switch between until there is a workspace, and nothing for
          the strip to be either: empty, it is a grey square in an empty header. */}
      {current && (
        <nav className="header__tabs">
          {TABS.map((tab) => (
            <button
              key={tab}
              className={`header__tab${tab === props.tab ? ' header__tab--on' : ''}`}
              onClick={() => props.onSelectTab(tab)}
            >
              {t(`tab.${tab}`)}
            </button>
          ))}
        </nav>
      )}

      <div className="header__tools" ref={toolsSlot} />

      <div className="header__right">
        {props.tab !== 'notes' && (
          <LabelFilter
            labels={props.labels}
            active={props.activeLabels}
            onToggle={props.onToggleLabel}
          />
        )}
        <SyncBadge />
        {/* The gear opens the settings window — a panel over the page, drawn by
            the app itself, not a menu hanging off the header. */}
        <button className="btn btn--quiet header__gear" onClick={props.onOpenSettings}>
          ⚙
        </button>
      </div>
    </header>
  )
}

// ------------------------------------------------------------- workspaces

function WorkspaceMenu({
  workspaces,
  current,
  onSelect,
  t,
}: {
  workspaces: Workspace[]
  current: Workspace | null
  onSelect: (id: ID) => void
  t: T
}) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  const ref = useOutsideClick<HTMLDivElement>(close)

  async function add() {
    const name = prompt(t('header.workspaceName'))
    if (name === null) return
    setOpen(false)
    onSelect(await createWorkspace(name))
  }

  return (
    <div className="menu" ref={ref}>
      <button className="header__ws" onClick={() => setOpen((v) => !v)}>
        <span className="header__ws-name">{current?.name ?? '—'}</span>
        <span className="header__caret">▾</span>
      </button>

      {open && (
        <div className="menu__pop">
          {workspaces.map((w) => (
            <button
              key={w.id}
              className={`menu__item${w.id === current?.id ? ' menu__item--on' : ''}`}
              onClick={() => {
                onSelect(w.id)
                setOpen(false)
              }}
            >
              {w.name}
            </button>
          ))}
          <div className="menu__sep" />
          <button className="menu__item" onClick={add}>
            {t('header.newWorkspace')}
          </button>
        </div>
      )}
    </div>
  )
}

function useOutsideClick<T extends HTMLElement>(onOutside: () => void) {
  const ref = useRef<T>(null)

  // The callback arrives as a fresh arrow function on every render: keep it in a
  // ref, otherwise the listener would resubscribe all the time.
  const cb = useRef(onOutside)
  useEffect(() => {
    cb.current = onOutside
  })

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) cb.current()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return ref
}
