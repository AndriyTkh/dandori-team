/*
 * Getting hold of a Google access token, and nothing else.
 *
 * The browser does the whole of this by itself but for one step: Google hands a
 * refresh token — the thing that turns one consent into an account that stays
 * connected — only to a client that can keep a secret, and a page delivered to
 * the browser keeps nothing. So the one step that needs the secret is asked of
 * this site's own worker, which holds it; see `worker/index.ts`.
 *
 * Before that there was no refresh token at all, and the account was renewed by
 * Google's token client — which opens a window even when it has nothing to ask,
 * and a window nobody clicked for is blocked. Every reload ended the connection
 * and cost a click. Nothing here opens a window any more: the consent screen is
 * a page the owner is sent to on his own click, once, and every renewal after
 * it is a plain request.
 */

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
/** Our worker's two doors. Same origin, so nothing here crosses a border. */
const TOKEN_PATH = '/api/gcal/token'
const REVOKE_PATH = '/api/gcal/revoke'
/** Where Google sends him back. Any path returns the app; this one is read on arrival. */
const CALLBACK_PATH = '/gcal/callback'

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
 * How long a refusal is believed before another is tried. Google refuses until
 * the owner allows the account anew, and the reconciler asks once a minute:
 * without the pause a refused account meant a request a second.
 */
const REFUSAL_MS = 5 * 60 * 1000

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined

export type GcalState =
  /** No client id was built in: the integration is not set up at all. */
  | 'unconfigured'
  /** Set up, but the owner has never signed in, or has signed out. */
  | 'signed-out'
  /** An account in hand, whether or not this second's token is. */
  | 'ready'
  /** Signed in once, and Google has stopped honouring it: he has to allow it again. */
  | 'needs-consent'

interface Token {
  value: string
  expires: number
}

let token: Token | null = null
/** When the last request came back without a token. */
let refusedAt = 0
let state: GcalState = CLIENT_ID ? 'signed-out' : 'unconfigured'
const listeners = new Set<(s: GcalState) => void>()

// ----------------------------------------------------------------- what is kept
/*
 * The refresh token is the account, and the only thing kept: while it is here
 * the app can make itself an hour of access whenever it likes, and when it is
 * gone the owner has to say so again. The hour itself lives in the tab alone —
 * a reload spends one request making another, silently, and a second long-lived
 * key at rest buys nothing but a risk.
 */
const REFRESH_KEY = 'dandori.gcalRefresh'
/** The proof, for as long as he is away at the consent screen and no longer. */
const PKCE_KEY = 'dandori.gcalPkce'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Storage blocked: nothing survives the tab, as nothing did before.
  }
}

function refreshToken(): string | null {
  return read(REFRESH_KEY)
}

// ---------------------------------------------------------------------- the state

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
  return refreshToken() !== null
}

// ----------------------------------------------------------------- the consent

/** The verifier is the secret half of the proof; only its hash travels to Google. */
function randomString(): string {
  const bytes = new Uint8Array(48)
  crypto.getRandomValues(bytes)
  return base64url(bytes)
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

function redirectUri(): string {
  return `${location.origin}${CALLBACK_PATH}`
}

/**
 * The owner's click: away to Google's consent screen and back.
 *
 * A page, not a window — a window would have to be opened by script, and the
 * browser blocks those. The app is left behind and loaded again on the way
 * back, which costs nothing: everything it shows is in the local database.
 */
export async function connect(): Promise<boolean> {
  if (!CLIENT_ID) return false
  const verifier = randomString()
  const guard = randomString()
  const challenge = await challengeFor(verifier)
  try {
    sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, guard }))
  } catch {
    // Without somewhere to leave the proof the answer cannot be trusted on the
    // way back, and an untrusted answer is not worth the trip.
    return false
  }

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPE,
    // What the whole worker exists for: without it Google sends an hour of
    // access and nothing to make the next hour with.
    access_type: 'offline',
    // And Google sends the refresh token on the screen where he says yes, that
    // once. Asked again, it answers with access alone — so the account would
    // reconnect and be unable to renew itself.
    prompt: 'consent',
    include_granted_scopes: 'true',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: guard,
  })
  location.assign(`${AUTH}?${params.toString()}`)
  return true
}

/** Google's answer to either door, as it stands. */
interface Answer {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
}

async function askWorker(path: string, body: Record<string, string>): Promise<Answer | null> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const answer = (await res.json()) as Answer
    if (!res.ok) {
      console.error('[gcal] token exchange refused', answer.error ?? res.status)
      return answer
    }
    return answer
  } catch (err) {
    // Offline, or the worker is not there. Neither is the owner's fault and
    // neither is permanent.
    console.error('[gcal] token exchange failed', err)
    return null
  }
}

/*
 * The way back from the consent screen. Read before anything else asks for a
 * token, and the address is tidied up straight away: a code is good once, and
 * a reload of this page with it still in the bar is a refusal for nothing.
 */
async function landed(): Promise<void> {
  const params = new URLSearchParams(location.search)
  const code = params.get('code')
  const guard = params.get('state')
  let held: { verifier?: string; guard?: string } = {}
  try {
    held = JSON.parse(sessionStorage.getItem(PKCE_KEY) ?? '{}') as typeof held
    sessionStorage.removeItem(PKCE_KEY)
  } catch {
    // Nothing was kept, and the answer below is refused on its own.
  }
  history.replaceState(null, '', '/')

  if (params.get('error') !== null) {
    console.error('[gcal] consent refused', params.get('error'))
    return
  }
  if (!code || !guard || guard !== held.guard || !held.verifier) {
    console.error('[gcal] the answer from the consent screen does not match the question')
    return
  }

  const answer = await askWorker(TOKEN_PATH, {
    code,
    verifier: held.verifier,
    redirect: redirectUri(),
  })
  if (!answer?.refresh_token || !answer.access_token || !answer.expires_in) {
    /*
     * An hour with no way to make the next one is not an account, so it is not
     * kept. Google sends the refresh token on the consent screen and only
     * there, which is why that screen is asked for every time — and if it ever
     * comes back without one, the reason is here rather than in a silence.
     */
    console.error('[gcal] the consent came back without an account')
    setState('signed-out')
    return
  }
  write(REFRESH_KEY, answer.refresh_token)
  token = { value: answer.access_token, expires: Date.now() + answer.expires_in * 1000 }
  refusedAt = 0
  setState('ready')
}

// ------------------------------------------------------------------ the token

/** One request at a time: two writes landing together must not ask twice. */
let pending: Promise<string | null> | null = null

async function renew(refresh: string): Promise<string | null> {
  const answer = await askWorker(TOKEN_PATH, { refresh })
  if (answer?.access_token && answer.expires_in) {
    token = { value: answer.access_token, expires: Date.now() + answer.expires_in * 1000 }
    refusedAt = 0
    setState('ready')
    return answer.access_token
  }
  refusedAt = Date.now()
  /*
   * A refusal Google means — the grant withdrawn, the password changed, the
   * token expired for good. Anything else is this minute's trouble: the account
   * is still an account and the next pass tries again.
   */
  if (answer !== null) {
    write(REFRESH_KEY, null)
    token = null
    setState('needs-consent')
  }
  return null
}

/**
 * A token to call the API with, or `null` when the owner has to be asked.
 * Nothing here is ever seen: no window, no page, no click.
 */
export function getToken(): Promise<string | null> {
  if (!CLIENT_ID) return Promise.resolve(null)
  if (token && token.expires - EXPIRY_MARGIN_MS > Date.now()) return Promise.resolve(token.value)
  const refresh = refreshToken()
  if (refresh === null) return Promise.resolve(null)
  if (Date.now() - refusedAt < REFUSAL_MS) return Promise.resolve(null)
  if (pending) return pending
  pending = renew(refresh).finally(() => {
    pending = null
  })
  return pending
}

/** Throws away the token in hand, so the next call has to fetch a new one. */
export function forgetToken(): void {
  token = null
}

/** Forgets the account on this device and tells Google to drop the grant. */
export async function disconnect(): Promise<void> {
  const held = refreshToken()
  write(REFRESH_KEY, null)
  token = null
  refusedAt = 0
  setState(CLIENT_ID ? 'signed-out' : 'unconfigured')
  if (held === null) return
  await askWorker(REVOKE_PATH, { refresh: held })
}

/*
 * On start-up the device has the account or it has not. An hour of access is not
 * part of that: the first call that wants one asks for it, and nothing is shown.
 */
if (CLIENT_ID) {
  if (location.pathname === CALLBACK_PATH) {
    void landed()
  } else if (refreshToken() !== null) {
    setState('ready')
  }
}
