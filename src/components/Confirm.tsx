import { useState } from 'react'
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

/**
 * The same window, asking for a word instead of an answer: the name of a new
 * workspace, which the browser's own `prompt()` used to ask for — the one
 * browser window left in the app, standing at the one moment an empty database
 * has nothing else on screen.
 *
 * The field is focused, Enter makes the workspace and Escape drops it. An empty
 * name is allowed through: it becomes «Без названия» and is fixed in the
 * settings, and a gate in front of an empty database would be worse.
 */
export function AskName({
  label,
  action,
  onSubmit,
  onCancel,
}: {
  label: string
  /** The word on the button that makes it. */
  action: string
  onSubmit: (name: string) => void
  onCancel: () => void
}) {
  const t = useT()
  const [name, setName] = useState('')
  useEscape(onCancel, true)

  return (
    <div className="ask__scrim" onMouseDown={onCancel}>
      <form
        className="ask"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit(name)
        }}
      >
        <label className="ask__field">
          <span className="ask__question">{label}</span>
          <input
            className="field"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <div className="ask__foot">
          <button type="button" className="btn" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn--primary">
            {action}
          </button>
        </div>
      </form>
    </div>
  )
}
