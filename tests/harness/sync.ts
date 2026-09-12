// Drives the app's real sync engine deterministically (plan.md D-5).
//
// `startSync()` fires one push+pull cycle immediately (`src/sync/sync.ts:496`)
// then keeps going on a 60s interval and three DOM listeners — none of that
// is exported as an awaitable promise for its first cycle (plan.md F-1).
// `onSyncState` is the only seam that reaches the pull path without a source
// change: subscribe, call `startSync()`, and resolve once the state machine
// settles back to `idle`/`offline`/`error`. A Dexie-poll backstop guards
// against a state transition this harness didn't anticipate.
//
// `push()` (`src/sync/sync.ts`, end of the function body) calls its own
// `settle()` unconditionally, whether or not it had anything dirty to send —
// so a cycle with nothing to push settles once from `push()` alone, before
// `cycle()`'s `await pull()` (`src/sync/sync.ts:462-479`) ever runs. Waiting
// for only the *first* settle stops the handle right there, so a pull-only
// cycle — an empty-cache client with nothing dirty to push — would never
// actually pull. This waits for the *second* settle on the same seam so both
// push and pull complete before the handle stops (mechanism ported from
// `drivePushAndPullCycle` in `tests/stack/offline-round-trip.test.ts`).
import { onSyncState, startSync, flushQueue as sourceFlushQueue, type SyncHandle, type SyncState } from '../../src/sync/sync'

const DEFAULT_TIMEOUT_MS = 10_000
const POLL_INTERVAL_MS = 50
const SETTLES_PER_FULL_CYCLE = 2

/**
 * Starts sync and resolves once the first full cycle settles — state has
 * left its initial value and then rested (`idle`/`offline`/`error`) twice,
 * once for `push()`'s own settle and once for `pull()`'s — or once
 * `predicate` is satisfied by a Dexie poll — whichever comes first. Always
 * stops the handle in a `finally`, so the 60s interval and the DOM listeners
 * never leak into the next test file.
 *
 * A pull-only cycle — push forced offline for its one check — never enters
 * `syncing` on push's side, so only pull's settle ever lands; callers of such
 * a cycle pass `settles: 1`.
 */
export async function driveSyncCycle(options?: {
  timeoutMs?: number
  /** Optional backstop: polled on an interval until it returns true, or timeout. */
  predicate?: () => Promise<boolean>
  /** Number of post-`syncing` settles to wait for. Defaults to a full push+pull cycle. */
  settles?: number
}): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const settles = options?.settles ?? SETTLES_PER_FULL_CYCLE
  const handle: SyncHandle = startSync()

  try {
    await waitForSettleOrPredicate(timeoutMs, settles, options?.predicate)
  } finally {
    handle.stop()
  }
}

function waitForSettleOrPredicate(
  timeoutMs: number,
  settles: number,
  predicate?: () => Promise<boolean>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let leftInitial = false
    let rests = 0
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
      // subscription time, which is stale from a previous test file. Wait for
      // the second such settle so both `push()` and `pull()` have completed.
      if (!leftInitial) return
      rests += 1
      if (rests >= settles) finish()
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
