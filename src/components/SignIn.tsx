import { useState, type FormEvent } from 'react'
import { signIn } from '../auth/useSession'
import { LANGS, setLang, useLang } from '../state/ui'
import { LANG_TITLES, useT } from '../i18n'
import type { TextKey } from '../i18n/dict'
import './SignIn.css'

/** Email and password sign-in. There is no sign-up: accounts are created in the Supabase dashboard. */
export function SignIn() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const t = useT()
  const lang = useLang()

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await signIn(email, password)
    } catch (err) {
      setError(t(reasonOf(err)))
      setBusy(false)
    }
  }

  return (
    <div className="signin">
      <form className="signin__form" onSubmit={submit}>
        <div className="signin__title">Dandori</div>

        <input
          className="field"
          type="email"
          placeholder="Email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          className="field"
          type="password"
          placeholder={t('signin.password')}
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        {error && <div className="signin__error">{error}</div>}

        <button className="btn btn--primary signin__submit" type="submit" disabled={busy}>
          {busy ? t('signin.busy') : t('signin.submit')}
        </button>
      </form>

      {/*
        The one screen reached before the settings window exists, and so the one
        place the language has to be switchable from outside it: a visitor who
        does not read Russian would otherwise meet a Russian form and no way
        past it. Each name is written in itself, as in the settings.
      */}
      <div className="signin__langs">
        {LANGS.map((option) => (
          <button
            key={option}
            type="button"
            className={`signin__lang${option === lang ? ' signin__lang--on' : ''}`}
            aria-pressed={option === lang}
            onClick={() => setLang(option)}
          >
            {LANG_TITLES[option]}
          </button>
        ))}
      </div>
    </div>
  )
}

/*
 * Why it did not work, in the app's own words. Supabase answers in English and
 * only in English, and every string here lives in the dictionary in both
 * languages — so what comes back is read, not shown.
 *
 * The two answers that have to stay apart are the wrong password and the missing
 * network: one is retyped, the other is waited out, and «Не удалось войти» for
 * both sends whoever mistyped his password off to look at the router.
 */
function reasonOf(err: unknown): TextKey {
  const status =
    typeof err === 'object' && err !== null && 'status' in err ? Number(err.status) : NaN
  // What the server says on purpose when the pair does not match.
  if (status === 400 || status === 401 || status === 422) return 'signin.wrong'
  // A request that never landed has no status of its own: Supabase gives it a zero.
  // From in here a phone with no signal and a server that is down look the same.
  if (status === 0 || !navigator.onLine) return 'signin.unreachable'
  return 'signin.failed'
}
