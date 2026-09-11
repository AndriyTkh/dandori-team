import { useEffect, useState } from 'react'
import { getSyncState, onSyncState, type SyncState } from '../sync/sync'
import { useT } from '../i18n'
import './SyncBadge.css'

/**
 * The only network state indicator. It shows up only when something is wrong or
 * an exchange is in progress: while everything is calm the header stays clean.
 */
export function SyncBadge() {
  const [state, setState] = useState<SyncState>(getSyncState)
  const t = useT()

  useEffect(() => onSyncState(setState), [])

  if (state === 'idle') return null

  const title = t(`sync.${state}`)
  return <span className={`sync sync--${state}`} title={title} aria-label={title} />
}
