import { useEffect, useState } from 'react'
import {
  addMemberByEmail,
  createLogin,
  deleteLogin,
  deleteWorkspace,
  exportAll,
  isAdmin,
  listLogins,
  memberEmails,
  refreshIsAdmin,
  removeMember,
  renameWorkspace,
  setLoginAdmin,
  setLoginPassword,
  updateWorkspace,
} from '../db/api'
import { useCurrentUserId, useMembers } from '../db/hooks'
import { today } from '../db/dates'
import { flushQueue } from '../sync/sync'
import { holdGcal } from '../gcal/sync'
import { signOut } from '../auth/useSession'
import { useAutosave } from '../lib/useAutosave'
import { useEscape } from '../lib/useEscape'
import { Confirm } from './Confirm'
import { GcalSection } from './Gcal'
import { LANG_TITLES, useT, type T } from '../i18n'
import type { TextKey } from '../i18n/dict'
import { LANGS, setLang, THEMES, useLang, type Theme } from '../state/ui'
import type { ID, Member, Workspace } from '../db/types'
import './Settings.css'

const THEME_TITLES = {
  system: 'settings.themeSystem',
  light: 'settings.themeLight',
  dark: 'settings.themeDark',
} as const

const SECTIONS = ['theme', 'language', 'workspace', 'members', 'gcal', 'account', 'logins'] as const
type Section = (typeof SECTIONS)[number]

const SECTION_TITLES = {
  theme: 'settings.theme',
  language: 'settings.language',
  workspace: 'settings.workspace',
  members: 'members.section',
  gcal: 'gcal.section',
  account: 'settings.account',
  logins: 'logins.section',
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

  // Instance admin is orthogonal to any workspace (D-16/D-17): the cached
  // flag is read once at mount so the Logins tab does not flash in before the
  // first check resolves. This is convenience only — every routine behind it
  // re-checks on the server regardless (D-17), and `LoginsSection` below
  // refreshes it again from the server as soon as it mounts.
  const [admin, setAdmin] = useState(false)
  useEffect(() => {
    void isAdmin().then(setAdmin)
  }, [])

  // With no workspace there is nothing to rename or delete, so the section is
  // gone rather than standing there with dead controls in it. `members` only
  // exists for a team workspace (FR-024 affordance 2); `logins` only for an
  // admin (FR-024 affordance 7) — both guards are convenience, the backend
  // enforces regardless.
  const sections = SECTIONS.filter((s) => {
    if (s === 'workspace') return !!workspace
    if (s === 'members') return workspace?.kind === 'team'
    if (s === 'logins') return admin
    return true
  })
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
          {section === 'members' && workspace && (
            <MembersSection key={workspace.id} workspace={workspace} t={t} />
          )}
          {section === 'gcal' && <GcalSection workspace={workspace} t={t} />}
          {section === 'account' && <AccountSection t={t} />}
          {section === 'logins' && <LoginsSection t={t} onAdminChange={setAdmin} />}
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

  // Owner guard (R-11, reused by T043's kind switch): a personal workspace
  // has no owner row at all (D-6) — the viewer is the only person who can
  // see it, so the guard is trivially true. A team workspace's owner row
  // only exists once `useMembers` has resolved; while it (or `uid`) is
  // still loading, `.some` finds nothing and the guard stays false — the
  // safe direction, since hiding an owner-only control never flashes it.
  const uid = useCurrentUserId()
  const members = useMembers(workspace.kind === 'team' ? workspace.id : null)
  const isOwner =
    workspace.kind === 'personal' ||
    (members ?? []).some((m) => m.level === 'owner' && m.member_id === uid)

  const [asking, setAsking] = useState(false)
  const [switchingTo, setSwitchingTo] = useState<Workspace['kind'] | null>(null)

  async function remove() {
    setAsking(false)
    await deleteWorkspace(workspace.id)
    onClose()
  }

  async function switchKind() {
    if (!switchingTo) return
    const kind = switchingTo
    setSwitchingTo(null)
    // Only `kind` is written — the membership purge/seed is the server-side
    // trigger's job (D-6′), not this component's (T043 done-when).
    await updateWorkspace(workspace.id, { kind })
  }

  return (
    <div className="swin__rows">
      {isOwner && (
        <label className="swin__field">
          <span className="swin__label">{t('settings.rename')}</span>
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      )}

      {isOwner && (
        <div className="swin__field">
          <span className="swin__label">{t('workspace.kindSwitch')}</span>
          <label className="swin__opt">
            <input
              type="radio"
              name="kind"
              checked={workspace.kind === 'personal'}
              onChange={() => setSwitchingTo('personal')}
            />
            {t('workspace.kindPersonal')}
          </label>
          <label className="swin__opt">
            <input
              type="radio"
              name="kind"
              checked={workspace.kind === 'team'}
              onChange={() => setSwitchingTo('team')}
            />
            {t('workspace.kindTeam')}
          </label>
        </div>
      )}

      {isOwner && (
        <button className="btn btn--danger" onClick={() => setAsking(true)}>
          {t('settings.remove')}
        </button>
      )}

      {asking && (
        <Confirm
          question={t('settings.confirmRemove', { name: workspace.name })}
          action={t('common.delete')}
          onCancel={() => setAsking(false)}
          onConfirm={() => void remove()}
        />
      )}

      {switchingTo && switchingTo !== workspace.kind && (
        <Confirm
          question={t(
            switchingTo === 'personal' ? 'workspace.confirmToPersonal' : 'workspace.confirmToTeam',
          )}
          action={t(switchingTo === 'personal' ? 'workspace.kindPersonal' : 'workspace.kindTeam')}
          onCancel={() => setSwitchingTo(null)}
          onConfirm={() => void switchKind()}
        />
      )}
    </div>
  )
}

// --------------------------------------------------------------------- members

/**
 * The register from `contracts/rpc.md` for `add_member_by_email`. `DA404`
 * (no account on this origin) has the dedicated string D-11 names,
 * `members.noAccountHere`. `DA001` (not the owner) should be unreachable —
 * the affordance is hidden for a non-owner — so it falls back to the bare
 * code, same discipline as `LOGIN_ERR` below for its own unmapped codes.
 */
const MEMBER_ERR: Partial<Record<string, TextKey>> = {
  DA404: 'members.noAccountHere',
}

function memberErrorText(err: unknown, t: T): string {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code: unknown }).code)
      : undefined
  const key = code ? MEMBER_ERR[code] : undefined
  if (key) return t(key)
  return code ?? String(err)
}

/**
 * The member list (FR-024 affordance 2) plus add-by-email (affordance 3) and
 * remove (affordance 4), both owner only. `useMembers` is the Dexie-backed,
 * always-synced list; emails are online-only (`memberEmails`, D-9) and not
 * cached by this component, so a member shows by its raw id until the lookup
 * returns, the same fallback `AssigneeField` in `TaskDialog.tsx` uses.
 *
 * The owner's own row is a server-side effect of `seed_workspace_owner` and
 * reaches this device only on the *next* pull (D-6) — right after creating a
 * team workspace the list is legitimately empty, not broken. Until that row
 * arrives (or while `uid` is still resolving) `isOwner` is false, so add/
 * remove stay hidden rather than flash on — the same guard `WorkspaceSection`
 * uses for R-11 and the kind switch.
 */
function MembersSection({ workspace, t }: { workspace: Workspace; t: T }) {
  const members = useMembers(workspace.id)
  const uid = useCurrentUserId()
  const isOwner = (members ?? []).some((m) => m.level === 'owner' && m.member_id === uid)

  const [emails, setEmails] = useState<Record<string, string>>({})
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<Member | null>(null)

  useEffect(() => {
    let cancelled = false
    memberEmails(workspace.id)
      .then((rows) => {
        if (cancelled) return
        setEmails(Object.fromEntries(rows.map((r) => [r.member_id, r.email])))
      })
      .catch(() => {
        // Offline or the call failed: the id fallback below still lets the
        // section render, so nothing further is done for this.
      })
    return () => {
      cancelled = true
    }
  }, [workspace.id])

  async function add() {
    setBusy(true)
    setError(null)
    try {
      // The email a submitted row round-trips to Dexie already-synced
      // (`addMemberByEmail`), so the new row appears without a pull.
      await addMemberByEmail(workspace.id, email)
      setEmail('')
    } catch (err) {
      setError(memberErrorText(err, t))
    } finally {
      setBusy(false)
    }
  }

  async function remove(memberId: ID) {
    setRemoving(null)
    await removeMember(workspace.id, memberId)
  }

  return (
    <div className="swin__rows">
      {error && <div className="swin__err">{error}</div>}

      {(members ?? []).map((m) => (
        <div key={m.id} className="swin__member">
          <span className="swin__memberEmail">{emails[m.member_id] ?? m.member_id}</span>
          <span className="swin__memberLevel">
            {t(m.level === 'owner' ? 'members.owner' : 'members.member')}
          </span>
          {/* The owner's own row carries no remove control — in P1 the owner
              cannot be removed and cannot leave (FR-010). */}
          {isOwner && m.level !== 'owner' && (
            <button className="btn btn--danger" onClick={() => setRemoving(m)}>
              {t('members.remove')}
            </button>
          )}
        </div>
      ))}

      {isOwner && (
        <form
          className="swin__memberAdd"
          onSubmit={(e) => {
            e.preventDefault()
            void add()
          }}
        >
          <input
            className="field"
            type="email"
            required
            placeholder={t('members.emailPlaceholder')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {t('members.add')}
          </button>
        </form>
      )}

      {removing && (
        <Confirm
          question={t('members.confirmRemove', {
            name: emails[removing.member_id] ?? removing.member_id,
          })}
          action={t('common.delete')}
          onCancel={() => setRemoving(null)}
          onConfirm={() => void remove(removing.member_id)}
        />
      )}
    </div>
  )
}

// ------------------------------------------------------------------- account

function AccountSection({ t }: { t: T }) {
  // Set once it is clear that some edits cannot be sent before the sign-out.
  const [asking, setAsking] = useState(false)

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
    // The calendar first: an event it is making has to be recorded before the
    // queue that carries the record goes out.
    const release = await holdGcal()
    const left = await flushQueue()
    if (left > 0) {
      release()
      setAsking(true)
      return
    }
    await signOut()
  }

  async function leaveAnyway() {
    await holdGcal()
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

      {asking && (
        <Confirm
          question={t('settings.confirmSignOut')}
          action={t('settings.signOut')}
          onCancel={() => setAsking(false)}
          onConfirm={() => void leaveAnyway()}
        />
      )}
    </div>
  )
}

// -------------------------------------------------------------------- logins

type LoginRow = Awaited<ReturnType<typeof listLogins>>[number]

/**
 * The register from `contracts/rpc.md`. All eight codes now have a dedicated
 * `logins.err*` string in `src/i18n/dict.ts` (A-016 closed the two that T041
 * left out): `DA001` (not an admin — should not be reachable once the tab is
 * gated by the admin flag, but the flag is a cache, not the control, D-17)
 * and `DA404` (no such login — a race with another admin's own tab).
 */
const LOGIN_ERR: Partial<Record<string, TextKey>> = {
  DA001: 'logins.errNotAdmin',
  DA010: 'logins.errBadEmail',
  DA011: 'logins.errShortPassword',
  DA012: 'logins.errDuplicate',
  DA013: 'logins.errSelf',
  DA014: 'logins.errOwnsTeamWorkspace',
  DA015: 'logins.errLastAdmin',
  DA404: 'logins.errNotFound',
}

function loginErrorText(err: unknown, t: T): string {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code: unknown }).code)
      : undefined
  const key = code ? LOGIN_ERR[code] : undefined
  if (key) return t(key)
  return code ?? String(err)
}

/**
 * The Logins section (FR-024 affordance 7, US7), admin only — filtered out of
 * `SECTIONS` entirely by the cached flag (D-17), which is convenience, not
 * the control: every routine below re-checks `is_admin()` on the server
 * regardless (D-16). Every call is a thin `db-api` delegation through
 * `src/sync/sync.ts` to an RPC (FR-026) — none of it is queued or written to
 * Dexie, because a queued account creation would be a password sitting on
 * the device (FR-044).
 *
 * Both password inputs are `type="password"`. The value lives in this
 * component's own state for the duration of the call and nowhere else — never
 * in Dexie, never in `console.*`, never in a URL. A newly created login's
 * password is shown back once, from the value this form just held (not from
 * anything the server returns — only a hash exists there), so the admin can
 * hand it over out of band; dismissing that banner drops it from state and it
 * is not reconstructible afterwards (FR-044).
 */
function LoginsSection({ t, onAdminChange }: { t: T; onAdminChange: (admin: boolean) => void }) {
  const [logins, setLogins] = useState<LoginRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [minted, setMinted] = useState<{ email: string; password: string } | null>(null)
  const [pwFor, setPwFor] = useState<string | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [removing, setRemoving] = useState<LoginRow | null>(null)
  const [revoking, setRevoking] = useState<LoginRow | null>(null)

  function load() {
    listLogins()
      .then(setLogins)
      .catch((err: unknown) => setError(loginErrorText(err, t)))
  }

  useEffect(() => {
    // The cached flag decided whether this tab was even offered; refreshing
    // it the moment the section actually opens (D-17) corrects a device whose
    // cache lied, rather than waiting for the next sync cycle.
    refreshIsAdmin()
      .then(onAdminChange)
      .catch(() => {})
    load()
    // Mount-only: `onAdminChange` is `setAdmin`, stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function create() {
    setBusy(true)
    setError(null)
    try {
      const row = await createLogin(email, password)
      setMinted({ email: row.email, password })
      setEmail('')
      setPassword('')
      load()
    } catch (err) {
      setError(loginErrorText(err, t))
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  async function applyPassword(userId: string) {
    setBusy(true)
    setError(null)
    try {
      await setLoginPassword(userId, newPassword)
      setNewPassword('')
      setPwFor(null)
    } catch (err) {
      setError(loginErrorText(err, t))
      setNewPassword('')
    } finally {
      setBusy(false)
    }
  }

  async function remove(userId: string) {
    setRemoving(null)
    setError(null)
    try {
      await deleteLogin(userId)
      load()
    } catch (err) {
      setError(loginErrorText(err, t))
    }
  }

  async function grantAdmin(row: LoginRow) {
    setError(null)
    try {
      await setLoginAdmin(row.user_id, true)
      load()
    } catch (err) {
      setError(loginErrorText(err, t))
    }
  }

  async function revokeAdmin(userId: string) {
    setRevoking(null)
    setError(null)
    try {
      await setLoginAdmin(userId, false)
      load()
    } catch (err) {
      setError(loginErrorText(err, t))
    }
  }

  return (
    <div className="swin__rows">
      {error && <div className="swin__err">{error}</div>}

      {minted && (
        <div className="swin__minted">
          <div className="swin__mintedRow">{minted.email}</div>
          <div className="swin__mintedRow">{minted.password}</div>
          <button className="btn btn--quiet" onClick={() => setMinted(null)}>
            {t('common.done')}
          </button>
        </div>
      )}

      {(logins ?? []).map((row) => (
        <div key={row.user_id} className="swin__login">
          <span className="swin__loginEmail">{row.email}</span>
          {row.is_admin && <span className="swin__loginBadge">{t('logins.admin')}</span>}

          {pwFor === row.user_id ? (
            <form
              className="swin__loginPw"
              onSubmit={(e) => {
                e.preventDefault()
                void applyPassword(row.user_id)
              }}
            >
              <input
                className="field"
                type="password"
                required
                minLength={8}
                autoFocus
                placeholder={t('logins.passwordPlaceholder')}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
              <button type="submit" className="btn btn--primary" disabled={busy}>
                {t('logins.setPassword')}
              </button>
            </form>
          ) : (
            <button
              className="btn btn--quiet"
              onClick={() => {
                setNewPassword('')
                setPwFor(row.user_id)
              }}
            >
              {t('logins.setPassword')}
            </button>
          )}

          <button
            className="btn btn--quiet"
            onClick={() => (row.is_admin ? setRevoking(row) : void grantAdmin(row))}
          >
            {t(row.is_admin ? 'logins.revokeAdmin' : 'logins.grantAdmin')}
          </button>

          <button className="btn btn--danger" onClick={() => setRemoving(row)}>
            {t('logins.remove')}
          </button>
        </div>
      ))}

      <form
        className="swin__loginCreate"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <input
          className="field"
          type="email"
          required
          placeholder={t('logins.emailPlaceholder')}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className="field"
          type="password"
          required
          minLength={8}
          placeholder={t('logins.passwordPlaceholder')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" className="btn btn--primary" disabled={busy}>
          {t('logins.create')}
        </button>
      </form>

      {removing && (
        <Confirm
          question={t('logins.confirmRemove', { name: removing.email })}
          action={t('common.delete')}
          onCancel={() => setRemoving(null)}
          onConfirm={() => void remove(removing.user_id)}
        />
      )}

      {revoking && (
        <Confirm
          question={t('logins.confirmRevokeAdmin', { name: revoking.email })}
          action={t('logins.revokeAdmin')}
          onCancel={() => setRevoking(null)}
          onConfirm={() => void revokeAdmin(revoking.user_id)}
        />
      )}
    </div>
  )
}
