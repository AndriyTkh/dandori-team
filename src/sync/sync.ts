import { supabase } from '../auth/supabase'
import { claimCache, db, getMeta, pendingCount, setMeta, type Local } from '../db/local'
import { SYNCED_COLUMNS, SYNCED_TABLES, type SyncedTable } from '../db/types'

/*
 * Sync with Supabase.
 *
 * The local database is always ahead: the UI writes to it and never waits for
 * the network. Changed rows are marked `_dirty` and go to the server at the
 * first opportunity.
 *
 * Conflicts are resolved last-write-wins by `updated_at`, over the whole row,
 * and the server is the judge: it refuses an update carrying an `updated_at`
 * older than the one it already holds. Here that shows up as a row the push
 * does not get back — see `push`. There is a single user with two devices: a
 * real conflict means he edited the same card on the phone and on the laptop
 * while one of them was offline. That is rare enough that a CRDT is not worth it.
 */

/** Pull cursor, one per table. See `pullTable` for why it is not one for all of them. */
const cursorKey = (table: SyncedTable) => `synced_at:${table}`
const EPOCH = '1970-01-01T00:00:00.000Z'
/*
 * How far the cursor is held back from the newest row already taken. A write
 * that was in flight while the query ran gets a stamp from the moment it
 * started, which can be older than rows the query did return, and the next pull
 * would step right over it. Rows arriving twice cost nothing, a row lost costs
 * everything.
 */
const CURSOR_SLACK_MS = 5_000
/*
 * How many rows go in one request, both ways.
 *
 * PostgREST answers with at most a thousand rows and says nothing about the
 * ones it left out, so a query that asks for everything is a query that can
 * lose rows without a word. Soft-deleted rows never leave the tables, so a
 * thousand is a number an ordinary year reaches.
 */
const PAGE_SIZE = 500
const PUSH_DEBOUNCE_MS = 400
const POLL_INTERVAL_MS = 60_000

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error'

type Listener = (state: SyncState) => void

let state: SyncState = 'idle'
const listeners = new Set<Listener>()

/*
 * A push that failed is remembered until one succeeds. The pull runs right
 * after it and used to set `idle` over the top, so a row that never went out —
 * a server refusing writes, a constraint nobody expected — was exactly as quiet
 * as a row that did.
 */
let pushFailed = false

function setState(next: SyncState) {
  if (state === next) return
  state = next
  for (const fn of listeners) fn(state)
}

/** What to show between exchanges: whatever the last push left behind. */
function settle() {
  if (!navigator.onLine) setState('offline')
  else setState(pushFailed ? 'error' : 'idle')
}

export function getSyncState(): SyncState {
  return state
}

export function onSyncState(fn: Listener): () => void {
  listeners.add(fn)
  fn(state)
  return () => listeners.delete(fn)
}

/*
 * Which sign-in the exchange belongs to.
 *
 * Sign-out wipes the local database, but a request already on the wire knows
 * nothing about it: the answer arrived seconds later and wrote its rows and its
 * cursor into the empty database, where the next account to sign in found them.
 * Everything that writes checks the stamp it started with first.
 */
let session = 0

/** Called by sign-out: whatever is still in flight lands nowhere. */
export function forgetSession(): void {
  session += 1
}

/**
 * Timestamps arrive in different formats: local ones are written as `…Z`, while
 * PostgREST returns `…+00:00`. Comparing them as strings would be wrong.
 */
function isNewerOrSame(a: string, b: string): boolean {
  return Date.parse(a) >= Date.parse(b)
}

function isSameMoment(a: string, b: string): boolean {
  return Date.parse(a) === Date.parse(b)
}

/** A row of any of the four tables, seen from here: an id and the stamp that decides. */
type AnyRow = Local<{ id: string; updated_at: string }>

/** The row shaped as the server's table, and nothing else of ours. */
function forServer<T extends object>(table: SyncedTable, row: Local<T>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const column of Object.keys(SYNCED_COLUMNS[table])) {
    out[column] = (row as Record<string, unknown>)[column]
  }
  return out
}

function chunks<T>(rows: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

// -------------------------------------------------------------------- push

let pushTimer: ReturnType<typeof setTimeout> | null = null
let pushInFlight: Promise<void> | null = null
let pushAgain = false

/** Asks for a push. Repeated calls collapse into a single debounced push. */
export function requestPush(): void {
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    pushTimer = null
    void push()
  }, PUSH_DEBOUNCE_MS)
}

async function push(): Promise<void> {
  // While a push is in flight, further requests collapse into one repeat at the end.
  if (pushInFlight) {
    pushAgain = true
    return pushInFlight
  }

  pushInFlight = (async () => {
    if (!navigator.onLine) {
      setState('offline')
      return
    }

    // getSession on purpose: it reads the stored session locally, while getUser
    // would hit the network before every upsert.
    const { data: auth } = await supabase.auth.getSession()
    const userId = auth.session?.user.id
    if (!userId) return

    const mine = session
    // Nothing leaves the device before it is settled whose rows these are.
    await claimCache(userId)
    if (mine !== session) return

    setState('syncing')
    let failed = false

    /*
     * A table that will not go through must not take the others with it. The
     * tables are ordered so that a row is sent after everything it points at,
     * but if one batch is rejected anyway, giving up on the rest would leave the
     * queue stuck for good: the row that would settle the conflict is often in
     * the very table that never gets its turn.
     */
    for (const table of SYNCED_TABLES) {
      try {
        const dirty: AnyRow[] = await db[table].where('_dirty').equals(1).toArray()
        if (dirty.length === 0) continue

        for (const batch of chunks(dirty, PAGE_SIZE)) {
          const payload = batch.map((row) => ({ ...forServer(table, row), user_id: userId }))
          /*
           * The ids come back on purpose. The server drops an update older than
           * the row it already holds, and a dropped row is simply missing from
           * the answer — the request itself succeeds. Without asking, the queue
           * would be cleared and the device would go on believing it had won.
           */
          const { data, error } = await supabase
            .from(table)
            .upsert(payload, { onConflict: 'id' })
            .select('id')
          if (error) throw error
          if (mine !== session) return

          const landed = new Set((data ?? []).map((row) => (row as { id: string }).id))

          // A row that changed while the push was in flight stays dirty.
          await db.transaction('rw', db[table], async () => {
            for (const sent of batch) {
              if (!landed.has(sent.id)) continue
              const current = await db[table].get(sent.id)
              if (current && current.updated_at === sent.updated_at) {
                await db[table].put({ ...current, _dirty: 0 } as never)
              }
            }
          })

          /*
           * And what the server kept instead. The next pull would bring it down
           * anyway, but only while the cursor still sits behind that row: taking
           * it here ends the conflict where it was lost, and the device stops
           * offering an edit that can never land.
           */
          const refused = batch.filter((row) => !landed.has(row.id)).map((row) => row.id)
          if (refused.length > 0) {
            const { data: kept, error: keptError } = await supabase
              .from(table)
              .select('*')
              .in('id', refused)
            if (keptError) throw keptError
            if (mine !== session) return
            await mergeRows(table, (kept ?? []) as Record<string, unknown>[])
          }
        }
      } catch (err) {
        failed = true
        console.error(`[sync] push failed: ${table}`, err)
      }
    }

    pushFailed = failed
    settle()
  })()

  try {
    await pushInFlight
  } finally {
    pushInFlight = null
  }

  if (pushAgain) {
    pushAgain = false
    await push()
  }
}

/** Sends what is queued and answers with how many edits could not go out. */
export async function flushQueue(): Promise<number> {
  await push()
  return pendingCount()
}

// ---------------------------------------------------------------------- pull

let pullInFlight: Promise<void> | null = null

/**
 * Fetches everything that changed on the server since last time.
 * A fresh device has no cursor, so the first pull drags in everything.
 */
function pull(): Promise<void> {
  // The interval, the return from the background and the network coming back
  // can all fire at once. Without this guard three racing pulls would overwrite
  // each other's cursor.
  pullInFlight ??= runPull().finally(() => {
    pullInFlight = null
  })
  return pullInFlight
}

async function runPull(): Promise<void> {
  if (!navigator.onLine) {
    setState('offline')
    return
  }

  setState('syncing')
  try {
    /*
     * The cursor runs on `synced_at`, the stamp the server puts on a row as it
     * writes it — never on `updated_at`, which belongs to the device that made
     * the edit. An edit made offline keeps the time it was made: edit on the
     * phone at 10:00, come back online at 11:00, and a laptop whose cursor moved
     * to 10:05 long ago would never ask for anything that old again, so the edit
     * would sit on the server invisible to it for good.
     *
     * One cursor per table, taken from the rows that table actually returned.
     * A single shared cursor could be dragged forward by a busy table past rows
     * of a quiet one that were written while the pull was already running.
     */
    for (const table of SYNCED_TABLES) {
      if (!(await pullTable(table))) return
    }
    settle()
  } catch (err) {
    setState(navigator.onLine ? 'error' : 'offline')
    console.error('[sync] pull failed', err)
  }
}

/** One table, page by page. `false` means the session ended while it ran. */
async function pullTable(table: SyncedTable): Promise<boolean> {
  const mine = session
  const since = (await getMeta(cursorKey(table))) ?? EPOCH
  /*
   * Pages are taken by `(synced_at, id)`, not by an offset: rows go on arriving
   * while the pages are read, and an offset counts a list that moves under it.
   * Many rows share one `synced_at` — a single statement stamps them all alike —
   * so the id decides inside a group, and the stamp is passed back exactly as
   * the server wrote it, to the microsecond, or `eq` would match nothing.
   */
  let stamp = since
  let lastId: string | null = null

  for (;;) {
    let query = supabase.from(table).select('*')
    query =
      lastId === null
        ? query.gt('synced_at', stamp)
        : query.or(`synced_at.gt."${stamp}",and(synced_at.eq."${stamp}",id.gt.${lastId})`)

    const { data, error } = await query
      .order('synced_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(PAGE_SIZE)
    if (error) throw error
    if (mine !== session) return false

    const rows = (data ?? []) as Record<string, unknown>[]
    if (rows.length === 0) break

    await mergeRows(table, rows)
    if (mine !== session) return false

    const last = rows[rows.length - 1]
    stamp = last.synced_at as string
    lastId = last.id as string
    if (rows.length < PAGE_SIZE) break
  }

  const next = new Date(Date.parse(stamp) - CURSOR_SLACK_MS).toISOString()
  if (Date.parse(next) > Date.parse(since)) await setMeta(cursorKey(table), next)
  return true
}

async function mergeRows(table: SyncedTable, rows: Record<string, unknown>[]): Promise<void> {
  await db.transaction('rw', db[table], async () => {
    for (const remote of rows) {
      // Both belong to the server alone: the owner it checks, and the stamp it
      // puts on a row as it writes it. Locally they are dead weight.
      const { user_id: _user, synced_at: _synced, ...clean } = remote
      const id = clean.id as string
      const local = await db[table].get(id)

      // The local edit is newer than the remote one, so keep it; the next push sends it.
      if (local?._dirty === 1 && isNewerOrSame(local.updated_at, clean.updated_at as string)) {
        continue
      }

      /*
       * The cursor is held a few seconds behind on purpose, so a pull always
       * hands back the newest rows again. Writing one that has not changed
       * would wake every live query watching the table — once a minute, for as
       * long as the app is open, over rows nobody touched. The two stamps are
       * the same moment written two ways: this device writes `…Z` and the
       * server answers `…+00:00`, so comparing the strings called every row
       * this device had sent a change and rewrote it for nothing.
       */
      if (local?._dirty === 0 && isSameMoment(local.updated_at, clean.updated_at as string)) {
        continue
      }

      await db[table].put({ ...clean, _dirty: 0 } as never)
    }
  })
}

// -------------------------------------------------------------------- start

export interface SyncHandle {
  stop: () => void
}

/**
 * Starts the exchange and keeps it running: on an interval, when the network
 * comes back, and when the tab returns from the background.
 * The state lives in the closure rather than in the module: otherwise the
 * cleanup of one call would silence the ticks of the next one, and sync would
 * die after a remount.
 */
export function startSync(): SyncHandle {
  let stopped = false

  const cycle = async () => {
    if (stopped) return
    await push()
    if (stopped) return
    await pull()
  }

  const tick = () => void cycle()

  const onOnline = () => tick()
  const onOffline = () => setState('offline')
  const onVisible = () => {
    if (document.visibilityState === 'visible') tick()
  }

  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  document.addEventListener('visibilitychange', onVisible)
  const timer = setInterval(tick, POLL_INTERVAL_MS)

  tick()

  return {
    stop: () => {
      stopped = true
      clearInterval(timer)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      document.removeEventListener('visibilitychange', onVisible)
    },
  }
}
