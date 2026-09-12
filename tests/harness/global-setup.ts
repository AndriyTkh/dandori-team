// Wires T005 (stack reachability) then T006 (ordered schema apply) so one
// `npm test` brings the stack up and applies the schema before any test file
// runs (plan.md D-1, D-7). Runs once for the whole vitest process, ahead of
// both the `stack` and `local` projects.
import { applySchema } from './schema'
import { assertStackReachable } from './stack'

export default async function globalSetup() {
  await assertStackReachable()
  await applySchema()
}
