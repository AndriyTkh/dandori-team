import type { ID, Label, LabelColor, Task } from '../db/types'

/*
 * A task's labels, in the order they were ticked. That is the order the card
 * draws them in, and so it is what "the first label" means — the calendar takes
 * its event's colour from it. Deleted ones drop out on their own.
 */
export function taskLabels(task: Task, labels: Label[]): Label[] {
  if (task.label_ids.length === 0) return []
  const byId = new Map<ID, Label>(labels.map((l) => [l.id, l]))
  return task.label_ids.map((id) => byId.get(id)).filter((l): l is Label => Boolean(l))
}

export function labelColors(task: Task, labels: Label[]): LabelColor[] {
  return taskLabels(task, labels).map((l) => l.color)
}

/** CSS variable holding the label color. */
export function labelVar(color: LabelColor): string {
  return `var(--label-${color})`
}
