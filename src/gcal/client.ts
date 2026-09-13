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
 *
 * Which is why the renewal names the account it wants. With more than one Google
 * account signed into the browser Google cannot know which is meant, so it asks
 * — in a window, which nobody clicked for, which is blocked: every silent
 * renewal failed and a reload ended the connection. The address is remembered
 * from the first connection; it is not a secret, and it is nothing the browser
 * signed into that account does not already hold.
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
/*
 * How long a silent refusal is believed before one is tried again. Google
 * refuses until the owner allows it anew, and the reconciler asks once per task
 * and once per return to the tab: without the pause a refused account meant a
 * request a second, each of them an attempt at a popup the browser blocks.
 */
const REFUSAL_MS = 5 * 60 * 1000

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
/** When the last silent request came back without a token. */
let refusedAt = 0
let state: GcalState = CLIENT_ID ? 'signed-out' : 'unconfigured'
const listeners = new Set<(s: GcalState) => void>()

/*
 * Whether he has ever connected the account, and the token itself.
 *
 * The token used to be kept in the tab alone, on the grounds that an hour's
 * worth of it is not worth storing. That rested on the silent renewal working,
 * and it does not: Google answers it with a window, and a window nobody clicked
 * for is blocked — so a reload ended the connection outright, every time. Stored
 * it is worth exactly the hour it lives, and it is thrown away the moment it is
 * spent, refused or the account is disconnected.
 */
const CONNECTED_KEY = 'dandori.gcalConnected'
const TOKEN_KEY = 'dandori.gcalToken'

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

/** The address the token is asked for, so a silent renewal has nothing to ask about. */
const ACCOUNT_KEY = 'dandori.gcalAccount'
/*
 * And a copy for as long as the tab lives. With storage blocked the stored one
 * reads back empty however often it is written, and every pass would go asking
 * Google for the address again — once a minute, for ever.
 */
let remembered: string | null = null

function account(): string | null {
  if (remembered !== null) return remembered
  try {
    return localStorage.getItem(ACCOUNT_KEY)
  } catch {
    return null
  }
}

/**
 * The address of the connected account, learned from Google rather than typed:
 * it lists the owner's own calendar under it.
 */
export function rememberAccount(address: string): void {
  if (!address || address === account()) return
  remembered = address
  try {
    localStorage.setItem(ACCOUNT_KEY, address)
  } catch {
    // Storage blocked: the address holds for this tab and is learned again in
    // the next one.
  }
}

/** True once the address is known, so nobody has to go looking for it twice. */
export function accountKnown(): boolean {
  return account() !== null
}

/** The token as it was left, if it has any life left in it. */
function storedToken(): Token | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY)
    if (raw === null) return null
    const held = JSON.parse(raw) as Partial<Token>
    if (typeof held.value !== 'string' || typeof held.expires !== 'number') return null
    // Spent while the tab was shut: no different from never having had one.
    if (held.expires - EXPIRY_MARGIN_MS <= Date.now()) return null
    return { value: held.value, expires: held.expires }
  } catch {
    return null
  }
}

/** Holds the token, here and for the next load of the page. */
function keepToken(next: Token | null): void {
  token = next
  try {
    if (next === null) localStorage.removeItem(TOKEN_KEY)
    else localStorage.setItem(TOKEN_KEY, JSON.stringify(next))
  } catch {
    // Storage blocked: the token holds for this tab, as it always did.
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
  requestAccessToken: (opts?: { prompt?: string; login_hint?: string }) => void
}

interface Gis {
  accounts: {
    oauth2: {
      initTokenClient: (o: {
        client_id: string
        scope: string
        hint?: string
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
/** The address `client` was built with, so a newly learned one rebuilds it. */
let clientHint: string | null = null
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

  const hint = account()

  return new Promise<string | null>((resolve) => {
    waiting = resolve

    // The address goes in twice on purpose: the token client takes it as `hint`
    // when it is built, and a single call overrides it as `login_hint`. The
    // client is built once and outlives the connection that taught the app the
    // address, so neither place alone covers every renewal.
    if (client && clientHint !== hint) client = null
    clientHint = hint
    client ??= gis.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      hint: hint ?? undefined,
      callback: (r) => {
        if (r.access_token && r.expires_in) {
          keepToken({ value: r.access_token, expires: Date.now() + r.expires_in * 1000 })
          refusedAt = 0
          setConnected(true)
          setState('ready')
          answer(r.access_token)
          return
        }
        // A silent request Google would not answer without the owner. Said out
        // loud: this is the one refusal in the app whose reason is Google's and
        // is nowhere else to be read.
        console.error('[gcal] token refused', r.error ?? 'no token and no reason')
        refusedAt = Date.now()
        setState(connected() ? 'needs-consent' : 'signed-out')
        answer(null)
      },
      error_callback: (e) => {
        console.error('[gcal] token request failed', e.type ?? 'no type')
        refusedAt = Date.now()
        setState(connected() ? 'needs-consent' : 'signed-out')
        answer(null)
      },
    })

    // An empty prompt is the silent path: Google answers it without a dialog
    // while the browser's Google session is alive and the scope already granted.
    client.requestAccessToken({
      prompt: interactive ? 'consent' : '',
      login_hint: hint ?? undefined,
    })
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
  // Still inside the pause after a refusal. His own click never waits for it:
  // allowing the account again is the one thing that can change the answer.
  if (!interactive && Date.now() - refusedAt < REFUSAL_MS) return Promise.resolve(null)
  if (pending) return pending
  pending = request(interactive)
  return pending
}

/** Throws away the token in hand, so the next call has to fetch a new one. */
export function forgetToken(): void {
  keepToken(null)
}

/** The owner's click: connect the account, or allow it again after a silent refusal. */
export function connect(): Promise<boolean> {
  return getToken(true).then((t) => t !== null)
}

/** Forgets the account on this device and tells Google to drop the grant. */
export async function disconnect(): Promise<void> {
  const held = token?.value
  keepToken(null)
  refusedAt = 0
  // The token client holds the grant it was built with. Kept across a
  // disconnect, it would hand the next owner the last one's session.
  client = null
  clientHint = null
  remembered = null
  try {
    localStorage.removeItem(ACCOUNT_KEY)
  } catch {
    // Nothing was stored either.
  }
  answer(null)
  setConnected(false)
  setState(CLIENT_ID ? 'signed-out' : 'unconfigured')
  if (!held) return
  const gis = await loadGis().catch(() => null)
  gis?.accounts.oauth2.revoke(held)
}

/*
 * On start-up the device has whatever token was left behind, and it is usually
 * still good: a page is reloaded far more often than once an hour. Failing
 * that, one is asked for straight away and silently — without it a settings
 * window opened in the first seconds would tell a connected owner that he has
 * no account, and offer him a button he does not need. Nothing is shown and
 * nothing pops up; a silent refusal leaves the state where it started.
 */
if (CLIENT_ID && connected()) {
  token = storedToken()
  if (token) {
    setState('ready')
  } else {
    setState('needs-consent')
    void getToken()
  }
}
