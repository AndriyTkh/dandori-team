/*
 * Stable empty arrays.
 *
 * `useLiveQuery` returns undefined until the database answers, and a `[]`
 * literal must not be substituted for it: a new reference on every render
 * invalidates every useMemo that depends on it. One array is handed to
 * everyone, and it is only ever read — freezing it would have to be admitted
 * in the type, and a `readonly` list would then have to be carried through
 * every prop that takes one from the database.
 */

const EMPTY: never[] = []

export function emptyOf<T>(): T[] {
  return EMPTY
}
