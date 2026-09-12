import { useEffect, useState } from 'react'

/*
 * Whether the page is laid out for a phone — the same 720 px the stylesheets
 * switch at, asked in JavaScript because a few behaviours differ, not just the
 * paint: a month cell leads to its day there and to nothing at all on the desk,
 * where the cell already carries the titles.
 */
const PHONE = '(max-width: 720px)'

export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE).matches)

  useEffect(() => {
    const mq = window.matchMedia(PHONE)
    const answer = () => setPhone(mq.matches)
    answer()
    mq.addEventListener('change', answer)
    return () => mq.removeEventListener('change', answer)
  }, [])

  return phone
}
