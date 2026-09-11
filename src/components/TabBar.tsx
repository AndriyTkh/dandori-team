import { useT } from '../i18n'
import { TABS, type Tab } from '../state/ui'
import './TabBar.css'

/** Bottom tab bar. Phone only: on a laptop the tabs live in the header. */
export function TabBar({ tab, onSelect }: { tab: Tab; onSelect: (t: Tab) => void }) {
  const t = useT()

  return (
    <nav className="tabbar">
      {TABS.map((item) => (
        <button
          key={item}
          className={`tabbar__item${item === tab ? ' tabbar__item--on' : ''}`}
          onClick={() => onSelect(item)}
        >
          {t(`tab.${item}`)}
        </button>
      ))}
    </nav>
  )
}
