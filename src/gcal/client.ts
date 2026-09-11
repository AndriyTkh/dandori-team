/*
 * Getting hold of a Google access token, and nothing else.
 *
 * There is no server in this project and no client secret anywhere, so the
 * browser talks to Google directly through Google Identity Services: the token
 * client hands the page an access token good for an hour and renews it silently
 * for as long as the browser is signed in to Google.
 *
 * Silence is the whole design. A popup that is not the answer to a click is
 * blocked by every browser, so a renewal that needs the owner's attention never
 * opens one — it records that consent is wanted and the settings window offers
 * a button. The only popup ever opened is the one he asked for.
 */

const GIS_SRC = 'https://accounts.google.com/gsi/client'
/*
 * Exactly what the app does and no more: write its own events, and read the list
 * of calendars to choose between. `calendar.readonly` would also hand it every
 * event in every calendar, which it never reads — and the consent screen is the
 * one place the owner actually sees what he is granting.
 */
const SCOPE = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
].join(' ')
/** Ask for a new token a little before the old one dies, so a write never races it. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined

export type GcalState =
  /** No client id was built in: the integration is not set up at all. */
  | 'unconfigured'
  /** Set up, but the owner has never signed in, or has signed out. */
  | 'signed-out'
  /** A token is in hand. */
  | 'ready'
  /** Signed in once, but the silent renewal failed: he has to allow it again. */
  | 'needs-consent'

interface Token {
  value: string
  expires: number
}

let token: Token | null = null
let state: GcalState = CLIENT_ID ? 'signed-out' : 'unconfigured'
const listeners = new Set<(s: GcalState) => void>()

/*
 * Whether he has ever connected the account. The token itself is deliberately
 * not stored: it lives an hour, and a token in localStorage is a token that
 * outlives the tab that earned it.
 */
const CONNECTED_KEY = 'dandori.gcalConnected'

function connected(): boolean {
  try {
    return localStorage.getItem(CONNECTED_KEY) === '1'
  } catch {
    return false
  }
}

function setConnected(on: boolean): void {
  try {
    if (on) localStorage.setItem(CONNECTED_KEY, '1')
    else localStorage.removeItem(CONNECTED_KEY)
  } catch {
    // Storage blocked: the connection just will not survive a reload.
  }
}

function setState(next: GcalState): void {
  if (next === state) return
  state = next
  for (const fn of listeners) fn(state)
}

export function getGcalState(): GcalState {
  return state
}

export function onGcalState(fn: (s: GcalState) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** True once the owner has connected the account on this device. */
export function isConnected(): boolean {
  return state === 'ready' || state === 'needs-consent' || (state === 'signed-out' && connected())
}

// ------------------------------------------------------------------ the script

interface TokenResponse {
  access_token?: string
  expires_in?: number
  error?: string
}

interface TokenClient {
  requestAccessToken: (opts?: { prompt?: string }) => void
}

interface Gis {
  accounts: {
    oauth2: {
      initTokenClient: (o: {
        client_id: string
        scope: string
        callback: (r: TokenResponse) => void
        error_callback?: (e: { type?: string }) => void
      }) => TokenClient
      revoke: (token: string, done?: () => void) => void
    }
  }
}

let loading: Promise<Gis> | null = null

function loadGis(): Promise<Gis> {
  if (loading) return loading
  // A refusal is forgotten, not cached: the script is usually refused because
  // the network was down, and remembering that would make the failure outlive
  // its cause for as long as the tab is open.
  const attempt = new Promise<Gis>((resolve, reject) => {
    const existing = (window as unknown as { google?: Gis }).google
    if (existing?.accounts?.oauth2) return resolve(existing)

    const el = document.createElement('script')
    el.src = GIS_SRC
    el.async = true
    el.onload = () => {
      const g = (window as unknown as { google?: Gis }).google
      if (g?.accounts?.oauth2) resolve(g)
      else reject(new Error('google identity services loaded without oauth2'))
    }
    el.onerror = () => reject(new Error('google identity services failed to load'))
    document.head.append(el)
  })

  loading = attempt
  attempt.catch(() => {
    if (loading === attempt) loading = null
  })
  return attempt
}

let client: TokenClient | null = null
/** One request at a time: two writes landing together must not open two popups. */
let pending: Promise<string | null> | null = null
/*
 * Whoever is waiting on the request in flight.
 *
 * The token client is built once and kept, so its callback outlives the call
 * that created it — a callback closing over that first call's `resolve` would
 * answer the first request over and over and leave every later one hanging for
 * good. It answers whatever is waiting now instead.
 */
let waiting: ((value: string | null) => void) | null = null

function answer(value: string | null): void {
  const fn = waiting
  waiting = null
  pending = null
  fn?.(value)
}

async function request(interactive: boolean): Promise<string | null> {
  if (!CLIENT_ID) return null

  let gis: Gis
  try {
    gis = await loadGis()
  } catch {
    // Offline, or the script blocked. Neither is permanent, and `loadGis` has
    // already forgotten the failure, so the next click tries again.
    pending = null
    return null
  }

  return new Promise<string | null>((resolve) => {
    waiting = resolve

    client ??= gis.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: (r) => {
        if (r.access_token && r.expires_in) {
          token = { value: r.access_token, expires: Date.now() + r.expires_in * 1000 }
          setConnected(true)
          setState('ready')
          answer(r.access_token)
          return
        }
        // A silent request Google would not answer without the owner.
        setState(connected() ? 'needs-consent' : 'signed-out')
        answer(null)
      },
      error_callback: () => {
        setState(connected() ? 'needs-consent' : 'signed-out')
        answer(null)
      },
    })

    // An empty prompt is the silent path: Google answers it without a dialog
    // while the browser's Google session is alive and the scope already granted.
    client.requestAccessToken({ prompt: interactive ? 'consent' : '' })
  })
}

/**
 * A token to call the API with, or `null` when the owner has to be asked.
 * Never opens anything on its own — `interactive` is only ever true on his click.
 */
export function getToken(interactive = false): Promise<string | null> {
  if (!CLIENT_ID) return Promise.resolve(null)
  if (token && token.expires - EXPIRY_MARGIN_MS > Date.now()) return Promise.resolve(token.value)
  if (!interactive && !connected()) return Promise.resolve(null)
  if (pending) return pending
  pending = request(interactive)
  return pending
}

/** Throws away the token in hand, so the next call has to fetch a new one. */
export function forgetToken(): void {
  token = null
}

/** The owner's click: connect the account, or allow it again after a silent refusal. */
export function connect(): Promise<boolean> {
  return getToken(true).then((t) => t !== null)
}

/** Forgets the account on this device and tells Google to drop the grant. */
export async function disconnect(): Promise<void> {
  const held = token?.value
  token = null
  // The token client holds the grant it was built with. Kept across a
  // disconnect, it would hand the next owner the last one's session.
  client = null
  answer(null)
  setConnected(false)
  setState(CLIENT_ID ? 'signed-out' : 'unconfigured')
  if (!held) return
  const gis = await loadGis().catch(() => null)
  gis?.accounts.oauth2.revoke(held)
}

/*
 * On start-up the device knows only whether it was ever connected, which is not
 * the same as having a token. So it asks for one straight away and silently:
 * without that, a settings window opened in the first seconds would tell a
 * connected owner that he has no account, and offer him a button he does not
 * need. Nothing is shown and nothing pops up — a silent refusal simply leaves
 * the state where it started.
 */
if (CLIENT_ID && connected()) {
  setState('needs-consent')
  void getToken()
}
