import { useCallback, useEffect, useRef, useState } from 'react'
import { createWorkspace } from '../db/api'
import type { ID, Label, Workspace, WorkspaceKind } from '../db/types'
import { useT, type T } from '../i18n'
import { useEscape } from '../lib/useEscape'
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

  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<WorkspaceKind>('personal')

  function add() {
    setOpen(false)
    setName('')
    setKind('personal')
    setNaming(true)
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

      {naming && (
        <WorkspaceNameForm
          t={t}
          name={name}
          kind={kind}
          onNameChange={setName}
          onKindChange={setKind}
          onCancel={() => setNaming(false)}
          onSubmit={() => {
            setNaming(false)
            void createWorkspace(name, kind).then(onSelect)
          }}
        />
      )}
    </div>
  )
}

/**
 * `Confirm`'s `AskName`, plus the one thing this call site needs that no other
 * one does: a personal/team choice (D-11 affordance 1). `AskName` stays generic
 * for the three other places that only ask for a name — this owns its own copy
 * of the same markup and classes rather than reaching into `Confirm.tsx`, which
 * is outside this file's scope.
 */
function WorkspaceNameForm({
  t,
  name,
  kind,
  onNameChange,
  onKindChange,
  onCancel,
  onSubmit,
}: {
  t: T
  name: string
  kind: WorkspaceKind
  onNameChange: (name: string) => void
  onKindChange: (kind: WorkspaceKind) => void
  onCancel: () => void
  onSubmit: () => void
}) {
  useEscape(onCancel, true)

  return (
    <div className="ask__scrim" onMouseDown={onCancel}>
      <form
        className="ask"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit()
        }}
      >
        <label className="ask__field">
          <span className="ask__question">{t('header.workspaceName')}</span>
          <input
            className="field"
            value={name}
            autoFocus
            onChange={(e) => onNameChange(e.target.value)}
          />
        </label>

        {/* The one new element (T042): personal stays the default (US1
            acceptance 2) until this is touched. Same segmented shape as the
            view tabs above, not a new pattern. */}
        <div className="header__kind">
          {(['personal', 'team'] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={`header__kind-opt${k === kind ? ' header__kind-opt--on' : ''}`}
              onClick={() => onKindChange(k)}
            >
              {t(k === 'personal' ? 'workspace.kindPersonal' : 'workspace.kindTeam')}
            </button>
          ))}
        </div>

        <div className="ask__foot">
          <button type="button" className="btn" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn--primary">
            {t('common.create')}
          </button>
        </div>
      </form>
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
