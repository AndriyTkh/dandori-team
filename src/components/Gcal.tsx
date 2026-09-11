import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { listCalendars, type Calendar } from '../gcal/api'
import { connect, disconnect, getGcalState, onGcalState, type GcalState } from '../gcal/client'
import { reconcile } from '../gcal/sync'
import { setTaskGcal, setWorkspaceGcal } from '../db/api'
import { useEscape } from '../lib/useEscape'
import type { T } from '../i18n'
import type { TextKey } from '../i18n/dict'
import type { GcalConfig, GcalReminder, ID, Workspace } from '../db/types'
import './Gcal.css'

/*
 * Everything the owner clicks to get a reminder out of Google Calendar: the
 * account row, the four fields of an event, the window the task card opens and
 * the section the settings window carries.
 *
 * One form, two places. The event's settings and the workspace's defaults are
 * the same four fields by decision, and writing them twice would let the two
 * drift apart.
 */

/** What a first tick gets when the workspace has no defaults of its own. */
const FALLBACK: GcalConfig = {
  time: '10:00',
  calendar_id: 'primary',
  color_id: null,
  reminders: [{ method: 'popup', minutes: 1440 }],
}

function defaultsOf(workspace: Workspace | null): GcalConfig {
  return workspace?.gcal ?? FALLBACK
}

/*
 * Google's own event palette. The ids and the colours are theirs; the names are
 * the ones its own interface uses in each language, so that a colour called one
 * thing here is called the same thing there.
 */
const COLORS: { id: string; name: TextKey; hex: string }[] = [
  { id: '1', name: 'gcal.color.1', hex: '#7986cb' },
  { id: '2', name: 'gcal.color.2', hex: '#33b679' },
  { id: '3', name: 'gcal.color.3', hex: '#8e24aa' },
  { id: '4', name: 'gcal.color.4', hex: '#e67c73' },
  { id: '5', name: 'gcal.color.5', hex: '#f6bf26' },
  { id: '6', name: 'gcal.color.6', hex: '#f4511e' },
  { id: '7', name: 'gcal.color.7', hex: '#039be5' },
  { id: '8', name: 'gcal.color.8', hex: '#616161' },
  { id: '9', name: 'gcal.color.9', hex: '#3f51b5' },
  { id: '10', name: 'gcal.color.10', hex: '#0b8043' },
  { id: '11', name: 'gcal.color.11', hex: '#d50000' },
]

/** How long before the event a reminder can fire, in minutes. */
const OFFSETS = [0, 10, 30, 60, 120, 1440, 2880]
/** The same pause every other field in the app takes before it writes. */
const SAVE_DELAY = 500

/** Google takes five; the owner asked for three. */
const MAX_REMINDERS = 3

function offsetLabel(t: T, minutes: number): string {
  if (minutes === 0) return t('gcal.atTime')
  if (minutes < 60) return t.n('gcal.beforeMinutes', minutes)
  if (minutes < 1440) return t.n('gcal.beforeHours', minutes / 60)
  return t.n('task.remindBefore', minutes / 1440)
}

// --------------------------------------------------------------- the account

/** What the section says about the account, one line per state. */
const NOTES = {
  unconfigured: 'gcal.unconfigured',
  'signed-out': 'gcal.signedOut',
  'needs-consent': 'gcal.needsConsent',
  ready: 'gcal.ready',
} as const

/** The account state, watched: connecting in one window redraws the other. */
function useGcalState(): GcalState {
  return useSyncExternalStore(onGcalState, getGcalState)
}

/**
 * Which of the four states the account is in, and the one control that state
 * deserves. `unconfigured` gets no button at all: there is nothing behind it.
 */
function GcalAccount({ state, t }: { state: GcalState; t: T }) {
  const [busy, setBusy] = useState(false)

  async function begin() {
    setBusy(true)
    try {
      await connect()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="gacc">
      <span className="gacc__note">{t(NOTES[state])}</span>

      {state === 'signed-out' && (
        <button className="btn btn--primary" disabled={busy} onClick={() => void begin()}>
          {busy ? t('gcal.connecting') : t('gcal.connect')}
        </button>
      )}
      {state === 'needs-consent' && (
        <button className="btn btn--primary" disabled={busy} onClick={() => void begin()}>
          {busy ? t('gcal.connecting') : t('gcal.reconnect')}
        </button>
      )}
      {state === 'ready' && (
        <button className="btn" onClick={() => void disconnect()}>
          {t('gcal.disconnect')}
        </button>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ the form

/**
 * The owner's calendars. `null` while the answer is on its way; an empty list
 * when Google would not give one, and then the picker falls back to the
 * calendar already chosen.
 */
function useCalendars(): Calendar[] | null {
  const [calendars, setCalendars] = useState<Calendar[] | null>(null)

  useEffect(() => {
    let alive = true
    listCalendars().then(
      (list) => alive && setCalendars(list),
      (err: unknown) => {
        console.error('[gcal] calendars', err)
        if (alive) setCalendars([])
      },
    )
    return () => {
      alive = false
    }
  }, [])

  return calendars
}

/** The four things an event is: a time, a calendar, a colour and its reminders. */
function GcalForm({
  value,
  onChange,
  t,
}: {
  value: GcalConfig
  onChange: (next: GcalConfig) => void
  t: T
}) {
  const calendars = useCalendars()
  const list = calendars ?? []
  // A calendar Google did not list — it is still what the event is set to, and
  // drawing the picker without it would quietly move the event somewhere else.
  const missing = !list.some((c) => c.id === value.calendar_id)

  function setReminder(i: number, patch: Partial<GcalReminder>) {
    onChange({
      ...value,
      reminders: value.reminders.map((r, j) => (i === j ? { ...r, ...patch } : r)),
    })
  }

  return (
    <div className="gform">
      <div className="gform__pair">
        <label className="gform__field">
          <span className="gform__label">{t('gcal.time')}</span>
          <input
            className="field"
            type="time"
            value={value.time}
            // An empty field is someone mid-edit, not a wish for no time at all.
            onChange={(e) =>
              e.target.value && onChange({ ...value, time: e.target.value.slice(0, 5) })
            }
          />
        </label>

        <label className="gform__field">
          <span className="gform__label">{t('gcal.calendar')}</span>
          <select
            className="field"
            value={value.calendar_id}
            onChange={(e) => onChange({ ...value, calendar_id: e.target.value })}
          >
            {missing && (
              <option value={value.calendar_id}>
                {value.calendar_id === 'primary' ? t('gcal.calendarPrimary') : value.calendar_id}
              </option>
            )}
            {list.map((c) => (
              <option key={c.id} value={c.id}>
                {/* Google names the main calendar after the account's address.
                    It is the one this app writes to unless it is told otherwise,
                    and it is called the same here wherever it is drawn from. */}
                {c.primary ? t('gcal.calendarPrimary') : c.summary}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="gform__field">
        <span className="gform__label">{t('gcal.color')}</span>
        <div className="gform__colors">
          <button
            className={`gform__swatch gform__swatch--none${
              value.color_id === null ? ' gform__swatch--on' : ''
            }`}
            onClick={() => onChange({ ...value, color_id: null })}
            aria-label={t('gcal.colorDefault')}
            title={t('gcal.colorDefault')}
          />
          {COLORS.map((c) => (
            <button
              key={c.id}
              className={`gform__swatch${value.color_id === c.id ? ' gform__swatch--on' : ''}`}
              style={{ background: c.hex }}
              onClick={() => onChange({ ...value, color_id: c.id })}
              aria-label={t(c.name)}
              title={t(c.name)}
            />
          ))}
        </div>
      </div>

      <div className="gform__field">
        <span className="gform__label">{t('gcal.reminders')}</span>

        {value.reminders.map((r, i) => (
          <div key={i} className="gform__rem">
            <select
              className="field"
              value={r.minutes}
              onChange={(e) => setReminder(i, { minutes: Number(e.target.value) })}
            >
              {/* A value some other client wrote still has to be shown as it is. */}
              {[...new Set([...OFFSETS, r.minutes])]
                .sort((a, b) => a - b)
                .map((m) => (
                  <option key={m} value={m}>
                    {offsetLabel(t, m)}
                  </option>
                ))}
            </select>

            <select
              className="field"
              value={r.method}
              onChange={(e) =>
                setReminder(i, { method: e.target.value as GcalReminder['method'] })
              }
            >
              <option value="popup">{t('gcal.popup')}</option>
              <option value="email">{t('gcal.email')}</option>
            </select>

            <button
              className="btn btn--quiet gform__del"
              onClick={() =>
                onChange({ ...value, reminders: value.reminders.filter((_, j) => j !== i) })
              }
              aria-label={t('gcal.removeReminder')}
            >
              ✕
            </button>
          </div>
        ))}

        {value.reminders.length < MAX_REMINDERS && (
          <button
            className="btn btn--quiet gform__add"
            onClick={() => {
              const fresh: GcalReminder = { method: 'popup', minutes: 30 }
              onChange({ ...value, reminders: [...value.reminders, fresh] })
            }}
          >
            {t('gcal.addReminder')}
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- the window

/**
 * The event's settings, over the task card. Nothing is written until he saves:
 * an event made by a stray click is a notification nobody asked for.
 *
 * With no account there is no form to show, so the connect button stands where
 * it would have been — a tick has to lead somewhere.
 */
export function GcalEventDialog({
  taskId,
  current,
  workspace,
  onClose,
  t,
}: {
  taskId: ID
  current: GcalConfig | null
  workspace: Workspace | null
  onClose: () => void
  t: T
}) {
  const state = useGcalState()
  // A first tick starts from the workspace's own terms, if it has any.
  const [draft, setDraft] = useState<GcalConfig>(current ?? defaultsOf(workspace))
  useEscape(onClose)

  async function save() {
    await setTaskGcal(taskId, draft)
    // The reconciler would get there within the minute; he is looking now.
    void reconcile()
    onClose()
  }

  return (
    <div className="gwin__scrim" onMouseDown={onClose}>
      <div className="gwin" onMouseDown={(e) => e.stopPropagation()}>
        <div className="gwin__head">
          <span className="gwin__title">{t('gcal.event')}</span>
          <button className="btn btn--quiet gwin__close" onClick={onClose}>
            ✕
          </button>
        </div>

        {state === 'ready' ? (
          <>
            <GcalForm value={draft} onChange={setDraft} t={t} />
            <div className="gwin__foot">
              <button className="btn btn--primary" onClick={() => void save()}>
                {t('common.save')}
              </button>
            </div>
          </>
        ) : (
          <GcalAccount state={state} t={t} />
        )}
      </div>
    </div>
  )
}

// --------------------------------------------------------------- the section

/**
 * The settings window's section: the account, then the defaults this workspace
 * hands out. They belong to the workspace and not to the app, so the section
 * says which workspace it is configuring — the window opens over any of them.
 */
export function GcalSection({ workspace, t }: { workspace: Workspace | null; t: T }) {
  const state = useGcalState()

  return (
    <div className="gsec">
      <GcalAccount state={state} t={t} />

      {state === 'ready' && workspace && (
        /*
         * Keyed by the workspace: the defaults are held as a draft, and the
         * remount is what hands the one left behind its last edit before the
         * next one's fields are drawn.
         */
        <GcalDefaults key={workspace.id} workspace={workspace} t={t} />
      )}
    </div>
  )
}

/**
 * The defaults one workspace hands out, and the switch that puts all its tasks
 * on them.
 *
 * The form holds a draft of its own, exactly as the event's window does. Drawn
 * straight from the stored value while the write waits out its pause, every key
 * was taken back before the next one landed: «Время» could not be typed into at
 * all, and two clicks within half a second added one reminder.
 */
function GcalDefaults({ workspace, t }: { workspace: Workspace; t: T }) {
  const stored = defaultsOf(workspace)
  const [draft, setDraft] = useState<GcalConfig>(stored)
  const current = useRef(draft)
  const synced = useRef(stored)
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /*
   * The pause before a write, so that one setting of an hour is one dirty row
   * and one push rather than a handful of each — the same half second every
   * other field in the app takes.
   */
  const flush = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    if (!dirty.current) return
    dirty.current = false
    synced.current = current.current
    void setWorkspaceGcal(workspace.id, { gcal: current.current })
  }, [workspace.id])

  function edit(next: GcalConfig) {
    current.current = next
    setDraft(next)
    dirty.current = true
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(flush, SAVE_DELAY)
  }

  // An edit arriving from the other device is taken only while nothing local is
  // waiting to be written; otherwise it would pull the field out from under him.
  useEffect(() => {
    if (stored === synced.current) return
    synced.current = stored
    if (dirty.current) return
    current.current = stored
    setDraft(stored)
  }, [stored])

  // Leaving the section, or closing the window, within the pause: the edit goes
  // in rather than away with the form.
  useEffect(() => flush, [flush])

  async function syncWhole(on: boolean) {
    // The switch is not a draft: whatever the form is holding goes in with it.
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    dirty.current = false
    synced.current = current.current
    // The defaults go in with the switch: they are the terms every task it
    // touches is put into the calendar on, so they cannot stay unwritten.
    await setWorkspaceGcal(workspace.id, { gcal_sync: on, gcal: current.current })
    // The tick itself is the answer. Counting what it caught would be a third
    // indicator, and one that speaks before the calendar has been told anything.
    void reconcile()
  }

  return (
    <>
      <div className="gsec__for">{t('gcal.defaults', { name: workspace.name })}</div>

      <GcalForm value={draft} onChange={edit} t={t} />

      <label className="gsec__whole">
        <input
          type="checkbox"
          checked={workspace.gcal_sync === true}
          onChange={(e) => void syncWhole(e.target.checked)}
        />
        <span>{t('gcal.workspaceSync')}</span>
      </label>
    </>
  )
}
