import { useState } from 'react'
import { deleteWorkspace, exportAll, renameWorkspace } from '../db/api'
import { today } from '../db/dates'
import { flushQueue } from '../sync/sync'
import { signOut } from '../auth/useSession'
import { useAutosave } from '../lib/useAutosave'
import { useEscape } from '../lib/useEscape'
import { Confirm } from './Confirm'
import { GcalSection } from './Gcal'
import { LANG_TITLES, useT, type T } from '../i18n'
import { LANGS, setLang, THEMES, useLang, type Theme } from '../state/ui'
import type { Workspace } from '../db/types'
import './Settings.css'

const THEME_TITLES = {
  system: 'settings.themeSystem',
  light: 'settings.themeLight',
  dark: 'settings.themeDark',
} as const

const SECTIONS = ['theme', 'language', 'workspace', 'gcal', 'account'] as const
type Section = (typeof SECTIONS)[number]

const SECTION_TITLES = {
  theme: 'settings.theme',
  language: 'settings.language',
  workspace: 'settings.workspace',
  gcal: 'gcal.section',
  account: 'settings.account',
} as const

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
  const t = useT()
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
          <span className="swin__title">{t('settings.title')}</span>
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
              {t(SECTION_TITLES[s])}
            </button>
          ))}
        </nav>

        <div className="swin__main">
          {section === 'theme' && <ThemeSection theme={theme} onSetTheme={onSetTheme} t={t} />}
          {section === 'language' && <LanguageSection />}
          {section === 'workspace' && workspace && (
            <WorkspaceSection key={workspace.id} workspace={workspace} onClose={onClose} t={t} />
          )}
          {section === 'gcal' && <GcalSection workspace={workspace} t={t} />}
          {section === 'account' && <AccountSection t={t} />}
        </div>
      </div>
    </div>
  )
}

// --------------------------------------------------------------------- theme

function ThemeSection({
  theme,
  onSetTheme,
  t,
}: {
  theme: Theme
  onSetTheme: (next: Theme) => void
  t: T
}) {
  return (
    <div className="swin__rows">
      {THEMES.map((option) => (
        <label key={option} className="swin__opt">
          <input
            type="radio"
            name="theme"
            checked={option === theme}
            onChange={() => onSetTheme(option)}
          />
          {t(THEME_TITLES[option])}
        </label>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ language

function LanguageSection() {
  const lang = useLang()

  return (
    <div className="swin__rows">
      {LANGS.map((option) => (
        <label key={option} className="swin__opt">
          <input
            type="radio"
            name="lang"
            checked={option === lang}
            onChange={() => setLang(option)}
          />
          {LANG_TITLES[option]}
        </label>
      ))}
    </div>
  )
}

// ----------------------------------------------------------------- workspace

function WorkspaceSection({
  workspace,
  onClose,
  t,
}: {
  workspace: Workspace
  onClose: () => void
  t: T
}) {
  // The same debounce the task card types into: one write per pause. An empty
  // name is refused by the database layer, so the workspace keeps the old one.
  const [name, setName] = useAutosave(workspace.name, (v) =>
    void renameWorkspace(workspace.id, v),
  )

  const [asking, setAsking] = useState(false)

  async function remove() {
    setAsking(false)
    await deleteWorkspace(workspace.id)
    onClose()
  }

  return (
    <div className="swin__rows">
      <label className="swin__field">
        <span className="swin__label">{t('settings.rename')}</span>
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
      </label>

      <button className="btn btn--danger" onClick={() => setAsking(true)}>
        {t('settings.remove')}
      </button>

      {asking && (
        <Confirm
          question={t('settings.confirmRemove', { name: workspace.name })}
          action={t('common.delete')}
          onCancel={() => setAsking(false)}
          onConfirm={() => void remove()}
        />
      )}
    </div>
  )
}

// ------------------------------------------------------------------- account

function AccountSection({ t }: { t: T }) {
  // How many edits the sign-out would take with it, once it is clear they
  // cannot be sent. Zero while there is nothing to ask about.
  const [unsent, setUnsent] = useState(0)

  async function exportJson() {
    const json = await exportAll()
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    // The owner's own day, not the UTC one: between midnight and three in the
    // morning in Kyiv the file would otherwise be named after yesterday.
    a.download = `dandori-${today()}.json`
    a.click()
    // Revoking synchronously cancels the download in some browsers, so defer it.
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  /*
   * Signing out wipes this device, so the queue goes out first. What could not
   * go — no network, or a server refusing it — exists nowhere else, and the
   * owner is the only one who can say it may be lost.
   */
  async function leave() {
    const left = await flushQueue()
    if (left > 0) {
      setUnsent(left)
      return
    }
    await signOut()
  }

  return (
    <div className="swin__rows">
      <button className="btn" onClick={exportJson}>
        {t('settings.export')}
      </button>
      <button className="btn" onClick={() => void leave()}>
        {t('settings.signOut')}
      </button>

      {unsent > 0 && (
        <Confirm
          question={t.n('settings.confirmSignOut', unsent)}
          action={t('settings.signOut')}
          onCancel={() => setUnsent(0)}
          onConfirm={() => void signOut()}
        />
      )}
    </div>
  )
}
