/** Identifier — a uuid v4, generated on the client. */
export type ID = string

/** A date with no time of day, in `YYYY-MM-DD` format. */
export type ISODate = string

/** Internal timestamp, never shown in the UI. */
export type Timestamp = string

/** Label colors. The names are the user's, the code never sees them. */
export const LABEL_COLORS = [
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
  'slate',
] as const

export type LabelColor = (typeof LABEL_COLORS)[number]

/** Fields shared by every synced row. */
export interface Synced {
  id: ID
  created_at: Timestamp
  updated_at: Timestamp
  /** Soft delete: a hard delete on the phone would never reach a laptop that is offline. */
  deleted: boolean
}

/** How a task's event is made in Google Calendar. */
export interface GcalConfig {
  /**
   * When the event starts, `HH:MM`. The one clock in the whole app: it belongs
   * to the event, never to the task, and no view reads it. A reminder has to
   * name a moment, and a date on its own does not.
   */
  time: string
  /** Which of the owner's calendars the event goes in. `primary` is the default one. */
  calendar_id: string
  /** Google's own palette, `1`–`11`; `null` leaves the calendar's colour. */
  color_id: string | null
  reminders: GcalReminder[]
}

/**
 * A task deliberately kept out of a workspace that syncs whole. Without it the
 * switch is all or nothing: clearing a task's own settings only drops it back
 * under the workspace's, and there is no way to say "this one, no".
 */
export interface GcalOff {
  off: true
}

export type GcalSetting = GcalConfig | GcalOff

/** The terms a task is synced on, or `null` if it has none of its own. */
export function gcalConfigOf(setting: GcalSetting | null | undefined): GcalConfig | null {
  return setting && !('off' in setting) ? setting : null
}

export interface GcalReminder {
  method: 'popup' | 'email'
  /** How long before the event it fires. */
  minutes: number
}

export interface Workspace extends Synced {
  name: string
  position: number
  /** Put every dated task of this workspace into the calendar, all alike. */
  gcal_sync: boolean
  /** The defaults that whole-workspace sync hands out. */
  gcal: GcalConfig | null
}

export interface Label extends Synced {
  workspace_id: ID
  name: string
  color: LabelColor
  position: number
}

/** Free-form card field: the user picks both the name and the value. */
export interface CustomField {
  /**
   * Stable key. Rows are edited in place, so identifying them by array index
   * would hand a deleted row's editing state to whoever shifts up into its slot.
   * Older rows predate this field, so it is filled in on first edit.
   */
  id?: string
  name: string
  value: string
}

export interface Task extends Synced {
  workspace_id: ID
  title: string
  description: string
  start_date: ISODate | null
  due_date: ISODate | null
  done: boolean
  /** How many days before the deadline to remind. `null` means no reminder. */
  remind_days_before: number | null
  /**
   * Keep the task out of the reminder banner entirely, even when it is due today
   * or already overdue. Separate from `remind_days_before`, which only controls
   * the advance warning and says nothing about the deadline itself.
   */
  muted: boolean
  /** A note attached to the task, if any. */
  note_id: ID | null
  /** Order within its own day column. */
  position: number
  label_ids: ID[]
  custom_fields: CustomField[]
  /**
   * The terms this task is synced on: its own, `{ off: true }` to stay out of a
   * workspace that syncs whole, or `null` to follow whatever the workspace says.
   *
   * The event's own id is not stored — it is the task's id with the dashes taken
   * out, so it is always at hand, and Google takes an id on insert: two devices
   * reaching for the calendar at once land on one event instead of two.
   */
  gcal: GcalSetting | null
  /**
   * The calendar an event was actually put in, or `null` if there is none.
   *
   * This is the only durable record that an event exists. Without it a device
   * that never created the event — a second one, or the same one after signing
   * out cleared its local notes — has no way to know there is anything to take
   * away, and turning the sync off would strand the events in the calendar for
   * good.
   */
  gcal_placed: string | null
}

export type NoteKind = 'folder' | 'file'

export interface Note extends Synced {
  workspace_id: ID
  parent_id: ID | null
  kind: NoteKind
  name: string
  /** Empty for folders. */
  content: string
  position: number
}

/** Tables that take part in sync. */
/*
 * Sync order, and it matters: a row is pushed after everything it points at.
 * Tasks come last because a task can carry a note, and the server rejects the
 * whole batch with a foreign key error when that note has not landed yet.
 */
export const SYNCED_TABLES = ['workspaces', 'labels', 'notes', 'tasks'] as const
export type SyncedTable = (typeof SYNCED_TABLES)[number]
