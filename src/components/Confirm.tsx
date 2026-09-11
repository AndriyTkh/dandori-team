import { useEscape } from '../lib/useEscape'
import { useT } from '../i18n'
import './Confirm.css'

interface Props {
  /** The whole question, already filled in with whatever is about to go. */
  question: string
  /** The word on the button that does it. */
  action: string
  onConfirm: () => void
  onCancel: () => void
}

/**
 * The app's own «точно?», in place of the browser's `confirm()`.
 *
 * One window for all four places that ask — the task, a label, a note and the
 * workspace. A step inside the settings window would have served exactly one of
 * them: the notes tree and the task card have nowhere to put one.
 *
 * Escape is taken in the capture phase. This opens on top of windows that close
 * on Escape themselves, and a single key must not dismiss the question and the
 * window that asked it in one go.
 */
export function Confirm({ question, action, onConfirm, onCancel }: Props) {
  const t = useT()
  useEscape(onCancel, true)

  return (
    <div className="ask__scrim" onMouseDown={onCancel}>
      <div className="ask" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ask__question">{question}</div>
        {/*
          The focus starts on the safe answer. A window that takes something away
          on a stray Enter is worse than one that takes a Tab to agree with.
        */}
        <div className="ask__foot">
          <button className="btn" onClick={onCancel} autoFocus>
            {t('common.cancel')}
          </button>
          <button className="btn btn--danger" onClick={onConfirm}>
            {action}
          </button>
        </div>
      </div>
    </div>
  )
}
