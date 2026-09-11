import { useMemo, useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { addMonths, fromISODate, isSameMonth, isWeekend, monthGrid } from '../../db/dates'
import { useT, type T } from '../../i18n'
import { monthLabel, weekdayShort } from '../../i18n/dates'
import type { ID, ISODate, Label, Task } from '../../db/types'
import { emptyOf } from '../../lib/empty'
import { columnId } from './model'
import { AddTaskField } from './AddTaskField'
import { TaskCard } from './TaskCard'

interface Props {
  workspaceId: ID
  today: ISODate
  groups: Map<string, Task[]>
  labels: Label[]
  onOpenTask: (id: ID) => void
}

export function MonthView({ workspaceId, today, groups, labels, onOpenTask }: Props) {
  const [anchor, setAnchor] = useState(today)
  const cells = useMemo(() => monthGrid(anchor), [anchor])
  const t = useT()

  return (
    <div className="board__month">
      <div className="board__month-nav">
        <button
          className="btn btn--quiet"
          onClick={() => setAnchor(addMonths(anchor, -1))}
          aria-label={t('board.prevMonth')}
        >
          ‹
        </button>
        <span className="board__month-title">{monthLabel(anchor, t.lang)}</span>
        <button
          className="btn btn--quiet"
          onClick={() => setAnchor(addMonths(anchor, 1))}
          aria-label={t('board.nextMonth')}
        >
          ›
        </button>
        <button className="btn" onClick={() => setAnchor(today)}>
          {t('board.today')}
        </button>
      </div>

      <div className="board__weekdays">
        {cells.slice(0, 7).map((date) => (
          <span key={date} className="board__weekday">
            {weekdayShort(date, t.lang)}
          </span>
        ))}
      </div>

      <div className="board__grid">
        {cells.map((date) => (
          <MonthCell
            key={date}
            workspaceId={workspaceId}
            date={date}
            today={today}
            outside={!isSameMonth(date, anchor)}
            tasks={groups.get(date) ?? emptyOf<Task>()}
            labels={labels}
            onOpenTask={onOpenTask}
            t={t}
          />
        ))}
      </div>
    </div>
  )
}

function MonthCell({
  workspaceId,
  date,
  today,
  outside,
  tasks,
  labels,
  onOpenTask,
  t,
}: {
  workspaceId: ID
  date: ISODate
  today: ISODate
  outside: boolean
  tasks: Task[]
  labels: Label[]
  onOpenTask: (id: ID) => void
  t: T
}) {
  const [adding, setAdding] = useState(false)
  const { setNodeRef, isOver } = useDroppable({ id: columnId(date) })

  const className = [
    'board__cell',
    date === today ? 'board__cell--today' : '',
    isWeekend(date) ? 'board__cell--weekend' : '',
    outside ? 'board__cell--outside' : '',
    isOver ? 'board__cell--over' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={className} ref={setNodeRef}>
      <div className="board__cell-head">
        <span className="board__cell-num">{fromISODate(date).getDate()}</span>
        <button
          className="board__add"
          onClick={() => setAdding(true)}
          aria-label={t('board.newTask')}
        >
          +
        </button>
      </div>

      <div className="board__cell-list">
        <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              labels={labels}
              column={date}
              compact
              onOpen={onOpenTask}
            />
          ))}
        </SortableContext>
        {adding && (
          <AddTaskField workspaceId={workspaceId} date={date} onClose={() => setAdding(false)} />
        )}
      </div>
    </div>
  )
}
