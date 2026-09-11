import { useEffect, useMemo, useState } from 'react'
import { SignIn } from './components/SignIn'
import { Header } from './components/Header'
import { TabBar } from './components/TabBar'
import { ReminderBanner } from './components/ReminderBanner'
import { TaskDialog } from './components/TaskDialog'
import { Settings } from './components/Settings'
import { Board } from './views/Board'
import { Timeline } from './views/Timeline'
import { Notes } from './views/Notes'
import { useSession } from './auth/useSession'
import { useLabels, useTasks, useWorkspaces } from './db/hooks'
import { startSync } from './sync/sync'
import { startGcal } from './gcal/sync'
import { emptyOf } from './lib/empty'
import { useBoardMode, useCurrentWorkspace, useTab, useTheme, type Theme } from './state/ui'
import type { ID, Label, Task } from './db/types'
import './App.css'

export function App() {
  const { signedIn, loading } = useSession()
  const [theme, setTheme] = useTheme()

  if (loading) return null
  if (!signedIn) return <SignIn />

  return <Shell theme={theme} onSetTheme={setTheme} />
}

function Shell({ theme, onSetTheme }: { theme: Theme; onSetTheme: (t: Theme) => void }) {
  const workspaces = useWorkspaces()
  const ids = useMemo(() => workspaces?.map((w) => w.id), [workspaces])
  const [workspaceId, selectWorkspace] = useCurrentWorkspace(ids)

  const [tab, setTab] = useTab()
  const [boardMode, setBoardMode] = useBoardMode()

  const labelList = useLabels(workspaceId)
  const labels = labelList ?? emptyOf<Label>()
  const allTasks = useTasks(workspaceId) ?? emptyOf<Task>()

  const [activeLabels, setActiveLabels] = useState<ID[]>([])
  const [openTaskId, setOpenTaskId] = useState<ID | null>(null)
  // A note the task card asked to open. Cleared once the notes view honours it.
  const [openNoteId, setOpenNoteId] = useState<ID | null>(null)
  const [remindersHidden, setRemindersHidden] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // The header's place for the open view's own controls, handed to the view.
  const [tools, setTools] = useState<HTMLDivElement | null>(null)

  useSync()

  // Reset the label filter when the workspace changes: the other workspace has its own labels.
  const [filteredFor, setFilteredFor] = useState(workspaceId)
  if (filteredFor !== workspaceId) {
    setFilteredFor(workspaceId)
    setActiveLabels([])
  }

  /*
   * A label deleted — here or on the other device — takes its place in the filter
   * with it. Left behind, it goes on hiding every task while the filter button,
   * which disappears with the last label, is no longer there to clear it: three
   * cards became none and nothing on the screen could bring them back.
   */
  if (labelList && activeLabels.some((id) => !labelList.some((l) => l.id === id))) {
    setActiveLabels((prev) => prev.filter((id) => labelList.some((l) => l.id === id)))
  }

  const tasks = useMemo(() => {
    if (activeLabels.length === 0) return allTasks
    return allTasks.filter((t) => activeLabels.some((id) => t.label_ids.includes(id)))
  }, [allTasks, activeLabels])

  function toggleLabel(id: ID) {
    setActiveLabels((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  if (!workspaces) return null

  const current = workspaces.find((w) => w.id === workspaceId) ?? null

  /*
   * With no workspace there is nothing for a tab or a view to stand on, so only
   * the header is drawn: its menu is where the first workspace gets made. The app
   * makes none by itself — a workspace named for you is a name you did not choose
   * and have to rename or delete before you can start.
   */
  return (
    <div className="app">
      <Header
        workspaces={workspaces}
        currentId={workspaceId}
        onSelectWorkspace={selectWorkspace}
        tab={tab}
        onSelectTab={setTab}
        labels={labels}
        activeLabels={activeLabels}
        onToggleLabel={toggleLabel}
        onOpenSettings={() => setSettingsOpen(true)}
        toolsSlot={setTools}
      />

      {/* Over the whole page, and reachable with no workspace to open it from. */}
      {settingsOpen && (
        <Settings
          workspace={current}
          theme={theme}
          onSetTheme={onSetTheme}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {workspaceId && (
        <>
          {!remindersHidden && (
            <ReminderBanner
              tasks={allTasks}
              onOpenTask={setOpenTaskId}
              onDismiss={() => setRemindersHidden(true)}
            />
          )}

          <main className="app__body">
            {tab === 'board' && (
              <Board
                workspaceId={workspaceId}
                tasks={tasks}
                labels={labels}
                mode={boardMode}
                onSetMode={setBoardMode}
                onOpenTask={setOpenTaskId}
                tools={tools}
              />
            )}
            {tab === 'timeline' && (
              <Timeline tasks={tasks} labels={labels} onOpenTask={setOpenTaskId} />
            )}
            {tab === 'notes' && (
              <Notes
                workspaceId={workspaceId}
                openNoteId={openNoteId}
                onOpened={() => setOpenNoteId(null)}
              />
            )}
          </main>

          <TabBar tab={tab} onSelect={setTab} />

          {openTaskId && (
            <TaskDialog
              taskId={openTaskId}
              workspaceId={workspaceId}
              workspace={current}
              labels={labels}
              onOpenNote={(id) => {
                // Opening a note means leaving the card: the two cannot share the screen.
                setOpenNoteId(id)
                setTab('notes')
                setOpenTaskId(null)
              }}
              onClose={() => setOpenTaskId(null)}
            />
          )}
        </>
      )}
    </div>
  )
}

/**
 * Runs the two exchanges for as long as the app is open: the server's, and the
 * calendar's. Both are the same shape — start it, stop it on the way out.
 */
function useSync() {
  useEffect(() => {
    const sync = startSync()
    const gcal = startGcal()
    return () => {
      sync.stop()
      gcal.stop()
    }
  }, [])
}
