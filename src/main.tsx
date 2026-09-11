import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
/*
 * The two shared stylesheets come first, and before the views: a bundler emits
 * CSS in the order it is imported, so importing them after `./App` put the
 * shared `.btn` and `.field` rules last and let them outrank the view rules
 * written to specialise them. Several of those rules were doing nothing at all.
 */
import './styles/tokens.css'
import './styles/base.css'
import { App } from './App'

/*
 * A new build reaches the running app only if someone asks for it. The browser
 * looks for a new worker on navigation, and an app installed on the phone is
 * resumed rather than navigated for days on end — so ask on a timer as well.
 * Once the new worker activates the page reloads itself; work in progress is
 * already in IndexedDB by then, the reload takes nothing with it.
 */
const UPDATE_EVERY_MS = 60 * 60 * 1000

registerSW({
  immediate: true,
  onRegisteredSW(_url, registration) {
    if (!registration) return
    // Offline the check simply fails, which is not news and not something to
    // leave lying in the console as a rejection nobody handled: the next hour asks again.
    setInterval(() => void registration.update().catch(() => {}), UPDATE_EVERY_MS)
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
