import { useEffect, useState } from 'react'
import { supabase } from './supabase'
import { claimCache, wipeLocal } from '../db/local'
import { forgetSession } from '../sync/sync'

/*
 * Whether the app is signed in.
 *
 * We deliberately do not wait for `supabase.auth.getSession()` to settle.
 * Offline it can hang indefinitely: the client keeps retrying the refresh_token
 * request and holds an internal lock while doing so, and every other auth call
 * queues behind it. Gating the UI on that promise meant a blank page with no
 * network — which defeats the whole point of an offline-first planner.
 *
 * So we race it against a short timeout and fall back to the session Supabase
 * has already persisted in localStorage. The app never needs the network to
 * render: all reads and writes go to the local database.
 */

const AUTH_TIMEOUT_MS = 1500

export interface SessionState {
  signedIn: boolean
  loading: boolean
}

/** Whose session Supabase persisted earlier, whether or not it can be refreshed now. */
function storedUserId(): string | null {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith('sb-') || !key.endsWith('-auth-token')) continue
      const raw = localStorage.getItem(key)
      const id = raw ? JSON.parse(raw)?.user?.id : null
      if (typeof id === 'string') return id
    }
  } catch {
    // Private mode or storage denied: treat it as signed out.
  }
  return null
}

/*
 * Signed in only once the cache is settled as this account's. Supabase reports
 * a sign-in before `signIn` below gets to claim the cache, and the app opened on
 * whatever the database held in between — the previous account's workspaces,
 * drawn on the next account's screen, and read by the calendar's first pass.
 */
async function settledFor(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false
  await claimCache(userId)
  return true
}

export function useSession(): SessionState {
  const [signedIn, setSignedIn] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true

    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), AUTH_TIMEOUT_MS),
    )

    void Promise.race([supabase.auth.getSession(), timeout]).then(async (result) => {
      const id = result === 'timeout' ? storedUserId() : result.data.session?.user.id
      const on = await settledFor(id)
      if (!alive) return
      setSignedIn(on)
      setLoading(false)
    })

    // The session can still change later: token expiry, sign-out, sign-in in another tab.
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!alive) return
      // Refresh failures offline arrive as a null session; the stored one is still good.
      if (!session && event === 'TOKEN_REFRESHED') return
      // Not awaited inside the callback: supabase-js holds its auth lock while
      // it runs, and this only touches the local database.
      void settledFor(session?.user.id).then((on) => {
        if (!alive) return
        setSignedIn(on)
        setLoading(false)
      })
    })

    return () => {
      alive = false
      sub.subscription.unsubscribe()
    }
  }, [])

  return { signedIn, loading }
}

export async function signIn(email: string, password: string): Promise<void> {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw error
  // Before a single row is shown or sent: the cache may belong to the account
  // that was signed out of this device without ever being asked — a sign-out on
  // the other device ends this session too, and this one only learns of it when
  // its token runs out.
  if (data.user) await claimCache(data.user.id)
}

/**
 * The local cache is wiped: no data should be left behind on someone else's device.
 * Whatever is still queued is sent by the settings window before it calls this,
 * and the owner is asked first if it could not go.
 */
export async function signOut(): Promise<void> {
  // First of all, so that an answer already on the wire cannot write itself
  // into the database the next account will open.
  forgetSession()
  await supabase.auth.signOut()
  await wipeLocal()
}
