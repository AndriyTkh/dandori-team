/*
 * The one piece of this app that is not the browser.
 *
 * Google hands a long-lived refresh token only to a client that can keep a
 * secret, and a page delivered to the browser cannot keep one: everything in it
 * is readable by whoever opens it. So the browser does the whole dance on its
 * own except the single step that needs the secret — trading the code for
 * tokens, and trading the refresh token for a fresh hour — and asks this worker
 * for that step. The secret lives in Cloudflare's secrets and reaches no one:
 * neither the repository, nor the bundle, nor any answer this file writes.
 *
 * It keeps nothing. The tokens go back to the browser that asked, which is the
 * one device that has any business with them, and this worker is as forgetful
 * between two requests as the static files it otherwise serves.
 */

/** What Cloudflare hands the worker: the built site, and the two halves of the client. */
interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> }
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
}

const TOKEN_PATH = '/api/gcal/token'
const REVOKE_PATH = '/api/gcal/revoke'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
const GOOGLE_REVOKE = 'https://oauth2.googleapis.com/revoke'

interface Ask {
  /** The code the consent screen sent back, with the verifier that proves it is ours. */
  code?: string
  verifier?: string
  redirect?: string
  /** Or the refresh token, to be spent on another hour. */
  refresh?: string
}

function bad(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/*
 * Only this site's own pages may ask. A request from anywhere else would be
 * using our client — and our secret — to sign somebody into their own calendar,
 * which is not what it was issued for.
 */
function ours(request: Request, url: URL): boolean {
  return request.headers.get('origin') === url.origin
}

/** Google answers both of these the same way, so it is passed straight back. */
async function ask(url: string, form: Record<string, string>): Promise<Response> {
  let answer: Response
  try {
    answer = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    })
  } catch {
    // Google unreachable from here. Said as a refusal of its own, because a
    // throw out of this handler is answered with Cloudflare's error page, and
    // the browser reads that as "the account is gone" rather than "later".
    return bad(502, 'google unreachable')
  }
  const body = await answer.text()
  return new Response(body, {
    status: answer.status,
    headers: { 'content-type': answer.headers.get('content-type') ?? 'application/json' },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== TOKEN_PATH && url.pathname !== REVOKE_PATH) {
      // Anything else under /api is nothing: handed on, it would be answered
      // with the app's own page, and a page that says 200 to a request for a
      // door that does not exist is the hardest kind of mistake to see.
      if (url.pathname.startsWith('/api/')) return bad(404, 'no such door')
      return env.ASSETS.fetch(request)
    }
    if (request.method !== 'POST') return bad(405, 'post only')
    if (!ours(request, url)) return bad(403, 'not this site')
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return bad(500, 'no client set up')

    let sent: Ask
    try {
      sent = (await request.json()) as Ask
    } catch {
      return bad(400, 'not json')
    }

    if (url.pathname === REVOKE_PATH) {
      if (!sent.refresh) return bad(400, 'nothing to revoke')
      return ask(GOOGLE_REVOKE, { token: sent.refresh })
    }

    if (sent.refresh) {
      return ask(GOOGLE_TOKEN, {
        grant_type: 'refresh_token',
        refresh_token: sent.refresh,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
      })
    }

    if (sent.code && sent.verifier && sent.redirect) {
      return ask(GOOGLE_TOKEN, {
        grant_type: 'authorization_code',
        code: sent.code,
        code_verifier: sent.verifier,
        redirect_uri: sent.redirect,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
      })
    }

    return bad(400, 'neither a code nor a refresh token')
  },
}
