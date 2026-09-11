import { useState } from 'react'
import { deleteWorkspace, exportAll, renameWorkspace } from '../db/api'
import { signOut } from '../auth/useSession'
import { useAutosave } from '../lib/useAutosave'
import { useEscape } from '../lib/useEscape'
import { THEMES, type Theme } from '../state/ui'
import type { Workspace } from '../db/types'
import './Settings.css'

const THEME_TITLES: Record<Theme, string> = {
  system: 'Как в системе',
  light: 'Светлая',
  dark: 'Тёмная',
}

const SECTIONS = ['theme', 'workspace', 'account'] as const
type Section = (typeof SECTIONS)[number]

const SECTION_TITLES: Record<Section, string> = {
  theme: 'Тема',
  workspace: 'Воркспейс',
  account: 'Аккаунт',
}

interface Props {
  workspace: Workspace | null
  theme: Theme
  onSetTheme: (t: Theme) => void
  onClose: () => void
}

/**
 * Settings as a window over the page: sections down the side, the chosen one
 * beside them. A menu held five items; a form does not fit in one.
 */
export function Settings({ workspace, theme, onSetTheme, onClose }: Props) {
  useEscape(onClose)

  // With no workspace there is nothing to rename or delete, so the section is
  // gone rather than standing there with dead controls in it.
  const sections = SECTIONS.filter((s) => s !== 'workspace' || workspace)
  const [chosen, setChosen] = useState<Section>('theme')
  const section = sections.includes(chosen) ? chosen : sections[0]

  return (
    <div className="swin__scrim" onMouseDown={onClose}>
      <div className="swin" onMouseDown={(e) => e.stopPropagation()}>
        <div className="swin__head">
          <span className="swin__title">Настройки</span>
          <button className="btn btn--quiet swin__close" onClick={onClose}>
            ✕
          </button>
        </div>

        <nav className="swin__nav">
          {sections.map((s) => (
            <button
              key={s}
              className={`swin__section${s === section ? ' swin__section--on' : ''}`}
              onClick={() => setChosen(s)}
            >
              {SECTION_TITLES[s]}
            </button>
          ))}
        </nav>

        <div className="swin__main">
          {section === 'theme' && <ThemeSection theme={theme} onSetTheme={onSetTheme} />}
          {section === 'workspace' && workspace && (
            <WorkspaceSection key={workspace.id} workspace={workspace} onClose={onClose} />
          )}
          {section === 'account' && <AccountSection />}
        </div>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------- theme

function ThemeSection({ theme, onSetTheme }: { theme: Theme; onSetTheme: (t: Theme) => void }) {
  return (
    <div className="swin__rows">
      {THEMES.map((t) => (
        <label key={t} className="swin__opt">
          <input
            type="radio"
            name="theme"
            checked={t === theme}
            onChange={() => onSetTheme(t)}
          />
          {THEME_TITLES[t]}
        </label>
      ))}
    </div>
  )
}

// ----------------------------------------------------------------- workspace

function WorkspaceSection({
  workspace,
  onClose,
}: {
  workspace: Workspace
  onClose: () => void
}) {
  // The same debounce the task card types into: one write per pause. An empty
  // name is refused by the database layer, so the workspace keeps the old one.
  const [name, setName] = useAutosave(workspace.name, (v) =>
    void renameWorkspace(workspace.id, v),
  )

  async function remove() {
    const ok = confirm(
      `Удалить воркспейс «${workspace.name}»? Вместе с ним удалятся его задачи, метки и заметки.`,
    )
    if (!ok) return
    await deleteWorkspace(workspace.id)
    onClose()
  }

  return (
    <div className="swin__rows">
      <label className="swin__field">
        <span className="swin__label">Переименовать воркспейс</span>
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
      </label>

      <button className="btn btn--danger" onClick={remove}>
        Удалить воркспейс
      </button>
    </div>
  )
}

// ------------------------------------------------------------------- account

function AccountSection() {
  async function exportJson() {
    const json = await exportAll()
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `dandori-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    // Revoking synchronously cancels the download in some browsers, so defer it.
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  return (
    <div className="swin__rows">
      <button className="btn" onClick={exportJson}>
        Экспорт в JSON
      </button>
      <button className="btn" onClick={() => void signOut()}>
        Выйти
      </button>
    </div>
  )
}
