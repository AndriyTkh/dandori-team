import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { renderMarkdown } from '../lib/markdown'
import { useAutosave } from '../lib/useAutosave'
import { useEscape } from '../lib/useEscape'
import { Confirm } from './Confirm'
import {
  createLabel,
  createNote,
  deleteLabel,
  deleteTask,
  setTaskGcal,
  updateLabel,
  updateTask,
} from '../db/api'
import { useNotes, useTask } from '../db/hooks'
import { reconcile } from '../gcal/sync'
import { GcalEventDialog } from './Gcal'
import { useT, type T } from '../i18n'
import {
  gcalConfigOf,
  LABEL_COLORS,
  type CustomField,
  type ID,
  type Label,
  type LabelColor,
  type Note,
  type Task,
  type Workspace,
} from '../db/types'
import './TaskDialog.css'

/** Same debounce as the shared autosave hook: one write per pause in typing. */
const SAVE_DELAY = 500

interface Props {
  taskId: ID
  workspaceId: ID
  /** The workspace the task belongs to — it carries the calendar defaults. */
  workspace: Workspace | null
  labels: Label[]
  /** Switches to the notes tab and opens the attached note. */
  onOpenNote: (id: ID) => void
  onClose: () => void
}

/** The whole task card: title, description, dates, labels, custom fields. */
export function TaskDialog({
  taskId,
  workspaceId,
  workspace,
  labels,
  onOpenNote,
  onClose,
}: Props) {
  const task = useTask(taskId)
  const [preview, setPreview] = useState(false)
  const [eventOpen, setEventOpen] = useState(false)

  // Escape belongs to the topmost window. With the event's settings open it is
  // theirs, and the card stays where it is.
  useEscape(
    useCallback(() => {
      if (!eventOpen) onClose()
    }, [eventOpen, onClose]),
  )

  // The task may have been deleted on another device while this dialog was open.
  // `undefined` means the database has not answered yet, `null` means it is really gone.
  useEffect(() => {
    if (task === null) onClose()
  }, [task, onClose])

  if (!task) return null

  return (
    <div className="dialog__scrim" onMouseDown={onClose}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <Body
          key={task.id}
          task={task}
          workspaceId={workspaceId}
          workspace={workspace}
          labels={labels}
          preview={preview}
          onSetPreview={setPreview}
          eventOpen={eventOpen}
          onSetEventOpen={setEventOpen}
          onOpenNote={onOpenNote}
          onClose={onClose}
        />
      </div>
    </div>
  )
}

function Body({
  task,
  workspaceId,
  workspace,
  labels,
  preview,
  onSetPreview,
  eventOpen,
  onSetEventOpen,
  onOpenNote,
  onClose,
}: {
  task: NonNullable<ReturnType<typeof useTask>>
  workspaceId: ID
  workspace: Workspace | null
  labels: Label[]
  preview: boolean
  onSetPreview: (v: boolean) => void
  eventOpen: boolean
  onSetEventOpen: (v: boolean) => void
  onOpenNote: (id: ID) => void
  onClose: () => void
}) {
  const id = task.id
  const t = useT()
  const patch = useCallback(
    (p: Parameters<typeof updateTask>[1]) => void updateTask(id, p),
    [id],
  )

  // Title and description are saved on a delay: writing on every keystroke lost
  // characters — the field value comes back from the database asynchronously and
  // would roll back what had already been typed.
  const [title, setTitle] = useAutosave(task.title, (v) => patch({ title: v }))
  const [description, setDescription] = useAutosave(task.description, (v) =>
    patch({ description: v }),
  )

  const [asking, setAsking] = useState(false)

  const html = useMemo(() => (preview ? renderMarkdown(description) : ''), [preview, description])

  /*
   * A `type=date` input fires onChange on every typed character. While someone is
   * still typing the year the browser hands over an intermediate «0202-03-01», and
   * that date would travel into the database and the timeline. Only write dates
   * that look plausible.
   */
  function patchDate(key: 'start_date' | 'due_date', raw: string) {
    if (raw === '') return patch({ [key]: null })
    const year = Number(raw.slice(0, 4))
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || year < 1970 || year > 2999) return
    patch({ [key]: raw })
  }

  async function remove() {
    setAsking(false)
    await deleteTask(task.id)
    onClose()
  }

  return (
    <>
      <div className="dialog__head">
        <label className="dialog__done">
          <input
            type="checkbox"
            checked={task.done}
            onChange={(e) => patch({ done: e.target.checked })}
          />
          <span>{t('common.done')}</span>
        </label>
        <button className="btn btn--quiet dialog__close" onClick={onClose}>
          ✕
        </button>
      </div>

      <input
        className="dialog__title"
        value={title}
        placeholder={t('task.title')}
        onChange={(e) => setTitle(e.target.value)}
      />

      <div className="dialog__dates">
        <Field label={t('task.start')}>
          <input
            className="field"
            type="date"
            min="1970-01-01"
            max="2999-12-31"
            value={task.start_date ?? ''}
            onChange={(e) => patchDate('start_date', e.target.value)}
          />
        </Field>
        <Field label={t('task.due')}>
          <input
            className="field"
            type="date"
            min="1970-01-01"
            max="2999-12-31"
            value={task.due_date ?? ''}
            onChange={(e) => patchDate('due_date', e.target.value)}
          />
        </Field>
        <Field label={t('task.remind')}>
          <select
            className="field"
            value={task.remind_days_before ?? ''}
            onChange={(e) =>
              patch({ remind_days_before: e.target.value === '' ? null : Number(e.target.value) })
            }
            disabled={!task.due_date}
          >
            <option value="">{t('task.remindNever')}</option>
            {[1, 2, 3, 7, 14, 30].map((n) => (
              <option key={n} value={n}>
                {t.n('task.remindBefore', n)}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {/*
        Separate from the select above. "Не напоминать" only drops the advance
        warning; a task due today or already overdue still shows up in the banner,
        because that is the whole point of a deadline tracker. This is the opt-out
        for the few tasks that should stay quiet regardless.
      */}
      <label className="dialog__mute">
        <input
          type="checkbox"
          checked={task.muted}
          onChange={(e) => patch({ muted: e.target.checked })}
        />
        <span>{t('task.mute')}</span>
      </label>

      <GcalRow
        task={task}
        workspace={workspace}
        open={eventOpen}
        onSetOpen={onSetEventOpen}
        t={t}
      />

      <NoteLink task={task} workspaceId={workspaceId} onOpenNote={onOpenNote} t={t} />

      <LabelPicker
        workspaceId={workspaceId}
        labels={labels}
        selected={task.label_ids}
        onChange={(label_ids) => patch({ label_ids })}
        t={t}
      />

      <Field
        label={t('task.description')}
        aside={
          <button className="dialog__link" onClick={() => onSetPreview(!preview)}>
            {preview ? t('md.edit') : t('md.preview')}
          </button>
        }
      >
        {preview ? (
          <div className="md dialog__markdown" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <textarea
            className="field dialog__textarea"
            value={description}
            placeholder="Markdown"
            onChange={(e) => setDescription(e.target.value)}
          />
        )}
      </Field>

      <CustomFields
        fields={task.custom_fields}
        onChange={(custom_fields) => patch({ custom_fields })}
        t={t}
      />

      <div className="dialog__foot">
        <button className="btn btn--quiet btn--danger" onClick={() => setAsking(true)}>
          {t('task.delete')}
        </button>
      </div>

      {asking && (
        <Confirm
          question={t('task.confirmDelete', { name: task.title })}
          action={t('common.delete')}
          onCancel={() => setAsking(false)}
          onConfirm={() => void remove()}
        />
      )}
    </>
  )
}

function Field({
  label,
  aside,
  children,
}: {
  label: string
  aside?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="dialog__field">
      <div className="dialog__field-head">
        <span className="dialog__field-label">{label}</span>
        {aside}
      </div>
      {children}
    </div>
  )
}

// ------------------------------------------------------------ google calendar

/**
 * The one way a task reaches the calendar. Ticking the box writes nothing — it
 * opens the event's settings, because an event made by a stray click is a
 * notification nobody asked for. Unticking takes the event away.
 *
 * An event is put on the deadline, so a task without one cannot have it. The
 * line says that in place of a switch that would quietly do nothing.
 */
function GcalRow({
  task,
  workspace,
  open,
  onSetOpen,
  t,
}: {
  task: Task
  workspace: Workspace | null
  open: boolean
  onSetOpen: (v: boolean) => void
  t: T
}) {
  // An event is made on the deadline's date, so a task without one has nothing
  // to offer here. Nothing is drawn rather than explained: the row appears the
  // moment a deadline does.
  if (!task.due_date) return null

  /*
   * Ticked when this task has an event, whatever put it there. A workspace that
   * syncs whole covers its tasks without writing anything on them, so reading
   * the task's own settings alone showed an unticked box beside an event that
   * existed — and unticking it offered to make a second one.
   */
  const byWorkspace = task.gcal === null && workspace?.gcal_sync === true && workspace.gcal !== null
  const own = gcalConfigOf(task.gcal)
  const on = own !== null || byWorkspace

  function toggle(next: boolean) {
    if (next) return onSetOpen(true)
    /*
     * Off is a decision, not a draft, so the event goes now rather than on the
     * next tick. Inside a workspace that syncs whole it has to be said out
     * loud: clearing the task's own terms would only drop it back under the
     * workspace's.
     */
    void setTaskGcal(task.id, byWorkspace ? { off: true } : null).then(reconcile)
  }

  return (
    <>
      <div className="dialog__gcal">
        <label className="dialog__gcal-label">
          <input type="checkbox" checked={on} onChange={(e) => toggle(e.target.checked)} />
          <span>{t('gcal.sync')}</span>
        </label>
        {on && (
          <button className="dialog__link" onClick={() => onSetOpen(true)}>
            {t('gcal.edit')}
          </button>
        )}
      </div>

      {open && (
        <GcalEventDialog
          taskId={task.id}
          current={own}
          workspace={workspace}
          onClose={() => onSetOpen(false)}
          t={t}
        />
      )}
    </>
  )
}

// ----------------------------------------------------------------------- note

/**
 * A note attached to the task. One-way: the task points at the note, the note
 * knows nothing about the task. Deleting the note clears the link rather than
 * leaving a dead one behind.
 */
function NoteLink({
  task,
  workspaceId,
  onOpenNote,
  t,
}: {
  task: { id: ID; title: string; note_id: ID | null }
  workspaceId: ID
  onOpenNote: (id: ID) => void
  t: T
}) {
  const notes = useNotes(workspaceId)
  const [picking, setPicking] = useState(false)

  // Folders hold no text, so only files can be attached.
  const files = (notes ?? []).filter((n: Note) => n.kind === 'file')
  const linked = task.note_id ? (files.find((n) => n.id === task.note_id) ?? null) : null

  async function create() {
    const id = await createNote(workspaceId, 'file', null, task.title)
    await updateTask(task.id, { note_id: id })
    setPicking(false)
  }

  return (
    <div className="dialog__field">
      <div className="dialog__field-head">
        <span className="dialog__field-label">{t('task.note')}</span>
        {linked && (
          <button
            className="dialog__link"
            onClick={() => void updateTask(task.id, { note_id: null })}
          >
            {t('task.noteUnlink')}
          </button>
        )}
      </div>

      {linked ? (
        <button className="notelink" onClick={() => onOpenNote(linked.id)}>
          <span className="notelink__icon">📄</span>
          <span className="notelink__name">{linked.name.trim() || t('common.untitled')}</span>
          <span className="dialog__link">{t('task.noteOpen')}</span>
        </button>
      ) : picking ? (
        <div className="notelink__pick">
          <select
            className="field"
            defaultValue=""
            autoFocus
            onChange={(e) => {
              if (!e.target.value) return
              void updateTask(task.id, { note_id: e.target.value })
              setPicking(false)
            }}
          >
            <option value="">{t('task.notePick')}</option>
            {files.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name.trim() || t('common.untitled')}
              </option>
            ))}
          </select>
          <button className="btn" onClick={() => void create()}>
            {t('task.noteCreate')}
          </button>
          <button className="btn btn--quiet" onClick={() => setPicking(false)}>
            {t('common.cancel')}
          </button>
        </div>
      ) : (
        <button className="btn btn--quiet notelink__add" onClick={() => setPicking(true)}>
          {t('task.noteAttach')}
        </button>
      )}
    </div>
  )
}

// --------------------------------------------------------------------- labels

type LabelMode = 'pick' | 'new' | 'manage'

function LabelPicker({
  workspaceId,
  labels,
  selected,
  onChange,
  t,
}: {
  workspaceId: ID
  labels: Label[]
  selected: ID[]
  onChange: (ids: ID[]) => void
  t: T
}) {
  const [mode, setMode] = useState<LabelMode>('pick')
  const [name, setName] = useState('')
  const [color, setColor] = useState<LabelColor>('blue')

  async function add() {
    if (!name.trim()) return
    const id = await createLabel(workspaceId, name, color)
    onChange([...selected, id])
    setName('')
    setMode('pick')
  }

  function toggle(id: ID) {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
  }

  const [asking, setAsking] = useState<Label | null>(null)

  return (
    <div className="dialog__field">
      <div className="dialog__field-head">
        <span className="dialog__field-label">{t('label.plural')}</span>
        <span className="dialog__links">
          {labels.length > 0 && (
            <button
              className="dialog__link"
              onClick={() => setMode(mode === 'manage' ? 'pick' : 'manage')}
            >
              {mode === 'manage' ? t('common.done') : t('label.manage')}
            </button>
          )}
          <button
            className="dialog__link"
            onClick={() => setMode(mode === 'new' ? 'pick' : 'new')}
          >
            {mode === 'new' ? t('common.cancel') : t('label.new')}
          </button>
        </span>
      </div>

      {mode === 'manage' ? (
        <div className="labels__manage">
          {labels.map((label) => (
            <LabelRow key={label.id} label={label} onRemove={() => setAsking(label)} t={t} />
          ))}
        </div>
      ) : (
        <div className="labels">
          {labels.map((label) => (
            <button
              key={label.id}
              className={`labels__pill${selected.includes(label.id) ? ' labels__pill--on' : ''}`}
              style={{ '--pill': `var(--label-${label.color})` } as React.CSSProperties}
              onClick={() => toggle(label.id)}
            >
              {label.name}
            </button>
          ))}
        </div>
      )}

      {mode === 'new' && (
        <div className="labels__new">
          <ColorPicker value={color} onChange={setColor} />
          <input
            className="field"
            value={name}
            placeholder={t('label.name')}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void add()}
          />
          <button className="btn btn--primary" onClick={() => void add()}>
            {t('common.add')}
          </button>
        </div>
      )}

      {asking && (
        <Confirm
          question={t('label.confirmDelete', { name: asking.name })}
          action={t('common.delete')}
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            const id = asking.id
            setAsking(null)
            void deleteLabel(id)
          }}
        />
      )}
    </div>
  )
}

function LabelRow({ label, onRemove, t }: { label: Label; onRemove: () => void; t: T }) {
  const [name, setName] = useAutosave(label.name, (v) => {
    if (v.trim()) void updateLabel(label.id, { name: v.trim() })
  })

  return (
    <div className="labels__row">
      <ColorPicker
        value={label.color}
        onChange={(color) => void updateLabel(label.id, { color })}
      />
      <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
      <button className="btn btn--quiet labels__del" onClick={onRemove} aria-label={t('label.delete')}>
        ✕
      </button>
    </div>
  )
}

function ColorPicker({
  value,
  onChange,
}: {
  value: LabelColor
  onChange: (c: LabelColor) => void
}) {
  return (
    <div className="labels__colors">
      {LABEL_COLORS.map((c) => (
        <button
          key={c}
          className={`labels__swatch${c === value ? ' labels__swatch--on' : ''}`}
          style={{ background: `var(--label-${c})` }}
          onClick={() => onChange(c)}
          aria-label={c}
        />
      ))}
    </div>
  )
}

// --------------------------------------------------------------- custom fields

/*
 * A custom field has to carry the same visual weight as the description box next
 * to it, otherwise it reads as something bolted onto the card. So the pair lives
 * inside one bordered box: the name on a dim line at the top, the value below in
 * the body. Both are plain inputs — nothing to click into an editing mode, and
 * nothing to save.
 */

function CustomFields({
  fields,
  onChange,
  t,
}: {
  fields: CustomField[]
  onChange: (f: CustomField[]) => void
  t: T
}) {
  // Rows written before ids existed get one now, so editing state cannot follow
  // the wrong row after a deletion.
  const missingIds = fields.some((f) => !f.id)
  useEffect(() => {
    if (missingIds) onChange(fields.map((f) => (f.id ? f : { ...f, id: crypto.randomUUID() })))
  }, [missingIds, fields, onChange])

  function add() {
    onChange([...fields, { id: crypto.randomUUID(), name: '', value: '' }])
  }

  return (
    <div className="dialog__field">
      <div className="dialog__field-head">
        <span className="dialog__field-label">{t('task.fields')}</span>
        <button className="dialog__link" onClick={add}>
          {t('common.add')}
        </button>
      </div>

      {fields.map((field, i) => (
        <CustomFieldRow
          key={field.id ?? i}
          field={field}
          autoFocus={field.name === '' && field.value === ''}
          onChange={(next) => onChange(fields.map((f, j) => (i === j ? next : f)))}
          onRemove={() => onChange(fields.filter((_, j) => j !== i))}
          t={t}
        />
      ))}
    </div>
  )
}

function CustomFieldRow({
  field,
  autoFocus,
  onChange,
  onRemove,
  t,
}: {
  field: CustomField
  autoFocus: boolean
  onChange: (f: CustomField) => void
  onRemove: () => void
  t: T
}) {
  const [draft, setDraft] = useState(field)
  const current = useRef(field)
  const synced = useRef(field)
  const dirty = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const changeRef = useRef(onChange)
  useEffect(() => {
    changeRef.current = onChange
  })

  /*
   * The whole row is written at once, not one input at a time.
   * Both inputs live in the same object, so two independent debounced writes
   * would each send a copy built from whatever they captured — and the later
   * one would put the other's field back to its old value.
   */
  const flush = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    if (!dirty.current) return
    dirty.current = false
    synced.current = current.current
    changeRef.current(current.current)
  }, [])

  function edit(part: Partial<CustomField>) {
    const next = { ...current.current, ...part }
    current.current = next
    setDraft(next)
    dirty.current = true
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(flush, SAVE_DELAY)
  }

  // An edit arriving from another device is taken only while nothing local is
  // waiting to be written; otherwise it would yank the text from under the caret.
  useEffect(() => {
    if (field.name === synced.current.name && field.value === synced.current.value) return
    synced.current = field
    if (dirty.current) return
    current.current = field
    setDraft(field)
  }, [field])

  useEffect(() => flush, [flush])

  /*
   * Removing the row unmounts it, and the unmount writes whatever was still
   * waiting in the debounce — through a callback the parent built before the
   * removal, which rebuilds the array with this row back in it. Dropping the
   * pending write first is what makes the removal stick.
   */
  function remove() {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    dirty.current = false
    onRemove()
  }

  return (
    <div className="cfield">
      <div className="cfield__head">
        <input
          className="cfield__name"
          value={draft.name}
          placeholder={t('task.fieldName')}
          autoFocus={autoFocus}
          onChange={(e) => edit({ name: e.target.value })}
        />
        <button className="cfield__del" onClick={remove} aria-label={t('task.fieldDelete')}>
          ✕
        </button>
      </div>

      <input
        className="cfield__value"
        value={draft.value}
        placeholder={t('task.fieldValue')}
        onChange={(e) => edit({ value: e.target.value })}
      />
    </div>
  )
}
