import { useEffect } from 'react'

/**
 * Close on Escape. One listener instead of a copy in every popup.
 *
 * `capture` is for a popup opened on top of another: taken in the capture phase
 * and stopped there, the key reaches the topmost one alone instead of closing
 * the whole stack at once.
 */
export function useEscape(onEscape: () => void, capture = false): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (capture) e.stopPropagation()
      onEscape()
    }
    document.addEventListener('keydown', onKey, capture)
    return () => document.removeEventListener('keydown', onKey, capture)
  }, [onEscape, capture])
}
