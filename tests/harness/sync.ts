// Drives the app's real sync engine deterministically (plan.md D-5).
//
// `startSync()` fires one push+pull cycle immediately (`src/sync/sync.ts:496`)
// then keeps going on a 60s interval and three DOM listeners — none of that
// is exported as an awaitable promise for its first cycle (plan.md F-1).
// `onSyncState` is the only seam that reaches the pull path without a source
// change: subscribe, call `startSync()`, and resolve once the state machine
// settles back to `idle`/`offline`/`error`. A Dexie-poll backstop guards
// against a state transition this harness didn't anticipate.
import { onSyncState, startSync, flushQueue as sourceFlushQueue, type SyncHandle, type SyncState } from '../../src/sync/sync'

const DEFAULT_TIMEOUT_MS = 10_000
const POLL_INTERVAL_MS = 50

/**
 * Starts sync and resolves once the first cycle settles (state becomes
 * `idle`, `offline` or `error` after having left the initial state at least
 * once), or once `predicate` is satisfied by a Dexie poll — whichever comes
 * first. Always stops the handle in a `finally`, so the 60s interval and the
 * DOM listeners never leak into the next test file.
 */
export async function driveSyncCycle(options?: {
  timeoutMs?: number
  /** Optional backstop: polled on an interval until it returns true, or timeout. */
  predicate?: () => Promise<boolean>
}): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const handle: SyncHandle = startSync()

  try {
    await waitForSettleOrPredicate(timeoutMs, options?.predicate)
  } finally {
    handle.stop()
  }
}

function waitForSettleOrPredicate(
  timeoutMs: number,
  predicate?: () => Promise<boolean>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let leftInitial = false
    let unsubscribe: () => void = () => {}
    let pollTimer: ReturnType<typeof setInterval> | undefined
    const timeoutTimer = setTimeout(() => {
      finish(new Error(`driveSyncCycle: timed out after ${timeoutMs}ms waiting for sync to settle`))
    }, timeoutMs)

    function finish(err?: Error) {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      if (pollTimer) clearInterval(pollTimer)
      unsubscribe()
      if (err) reject(err)
      else resolve()
    }

    const onState = (state: SyncState) => {
      if (state === 'syncing') {
        leftInitial = true
        return
      }
      // idle / offline / error: only a settle *after* having actually cycled
      // counts — `onSyncState` calls back immediately with the state at
      // subscription time, which is stale from a previous test file.
      if (leftInitial) finish()
    }
    unsubscribe = onSyncState(onState)

    if (predicate) {
      pollTimer = setInterval(() => {
        void predicate().then((ok) => {
          if (ok) finish()
        })
      }, POLL_INTERVAL_MS)
    }
  })
}

/** Thin wrapper over the exported `flushQueue()`, for push-only cases (plan.md D-5). */
export async function flushQueue(): Promise<number> {
  return sourceFlushQueue()
}
