import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import { createNote, deleteNote, moveNote, updateNote } from '../db/api'
import { useNotes } from '../db/hooks'
import { Confirm } from '../components/Confirm'
import { useT, type T } from '../i18n'
import { emptyOf } from '../lib/empty'
import { renderMarkdown } from '../lib/markdown'
import { useAutosave } from '../lib/useAutosave'
import { useEscape } from '../lib/useEscape'
import type { ID, Note, NoteKind } from '../db/types'
import './Notes.css'

export interface NotesProps {
  workspaceId: ID
  /** A note to open, requested from elsewhere — a task links to it. */
  openNoteId?: ID | null
  /** Called once the request has been honoured, so the caller can clear it. */
  onOpened?: () => void
}

/*
 * Where the menu is asked to appear. The width it will actually take is decided
 * by the stylesheet — 180px, and 220 on a phone — so the request is only a
 * starting point and the menu pulls itself back on screen once it knows its own
 * size. A constant here guessed 168 and let the phone's menu hang off the edge.
 */
const MENU_GAP = 4

/** The tree itself as a drop target: the empty space under the last row is the root. */
const TREE_ROOT = 'notes-root'

/** Below this a release is a click and not a drag, the same as a card on the board. */
const CLICK_SLOP = 5

/*
 * Auto-scroll while a row is carried near the edge of the tree. The library's own
 * acceleration throws a list of 24px rows past the eye far faster than a hand can
 * aim at one — the board settled on the same number for the same reason.
 */
const AUTO_SCROLL = { acceleration: 3 }

interface Row {
  note: Note
  depth: number
  /** The parent the tree draws it under, which is the root for a row whose own is gone. */
  parentId: ID | null
}

/** Where the drag would put the row: inside `parentId`, in front of `beforeId`. */
interface Drop {
  parentId: ID | null
  beforeId: ID | null
}

interface Menu {
  id: ID
  /** The anchor the menu is hung on, and which of its edges is pinned to it. */
  x: number
  y: number
  edge: 'left' | 'right'
}

export function Notes({ workspaceId, openNoteId, onOpened }: NotesProps) {
  // Undefined while the database is still answering; that is not the same as «нет заметок»
  // and an outside request must not be resolved against it.
  const loaded = useNotes(workspaceId)
  const notes = loaded ?? emptyOf<Note>()

  const [selectedId, setSelectedId] = useState<ID | null>(null)
  // Folder expansion is screen state, not data: it is never written to the database.
  const [expanded, setExpanded] = useState<ReadonlySet<ID>>(() => new Set())
  const [renamingId, setRenamingId] = useState<ID | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [asking, setAsking] = useState<Note | null>(null)
  // Phone: the tree and the editor do not fit side by side, so show one at a time.
  const [detail, setDetail] = useState(false)
  // The row to scroll to once the folders above it are open and it is in the DOM.
  const [scrollTo, setScrollTo] = useState<ID | null>(null)
  const rowsRef = useRef<HTMLDivElement>(null)
  const t = useT()

  const selected = notes.find((n) => n.id === selectedId) ?? null
  const openFile = selected?.kind === 'file' ? selected : null

  const rows = useMemo(() => visibleRows(notes, expanded), [notes, expanded])
  const byId = useMemo(() => new Map(notes.map((n) => [n.id, n])), [notes])
  // A note whose parent is gone is drawn at the root, so the drag has to read it there too.
  const parentOf = (note: Note) =>
    note.parent_id && byId.has(note.parent_id) ? note.parent_id : null

  /*
   * Opening a note on request from another view.
   *
   * The request is answered during render, the way the rest of the app derives state
   * from a changed prop. Nothing is decided until `useNotes` has answered: until then
   * a note that is missing is indistinguishable from one deleted on another device.
   * Once the list is in, the caller is told either way — a request for a note that is
   * gone would otherwise hang forever.
   */
  const request = openNoteId ?? null
  const [answered, setAnswered] = useState<ID | null>(null)

  if (request !== answered) {
    if (request === null) {
      setAnswered(null)
    } else if (loaded !== undefined) {
      setAnswered(request)
      const note = loaded.find((n) => n.id === request)
      if (note) {
        setSelectedId(note.id)
        setExpanded((prev) => expandTo(prev, loaded, note))
        setScrollTo(note.id)
        if (note.kind === 'file') setDetail(true)
      }
    }
  }

  // Ref to the current callback, so that the notification below does not depend on its identity.
  const openedRef = useRef(onOpened)
  useEffect(() => {
    openedRef.current = onOpened
  })

  // The caller is told after the commit: it answers with a state change of its own.
  useEffect(() => {
    if (answered !== null) openedRef.current?.()
  }, [answered])

  useLayoutEffect(() => {
    if (!scrollTo) return
    const row = rowsRef.current?.querySelector<HTMLElement>(`[data-id="${scrollTo}"]`)
    // On the phone the tree is hidden while the editor is open and the row has no
    // geometry yet: hold the request until the user comes back to the tree.
    if (row && row.offsetParent === null) return
    setScrollTo(null)
    row?.scrollIntoView({ block: 'nearest' })
  }, [scrollTo, detail, rows])

  /*
   * Dragging a row.
   *
   * The tree is the only place a note lives, so it is the only place a note is
   * carried to. A row is dropped on a folder to go inside it, or between two rows
   * to stand there, and the line drawn while the finger is still down is the very
   * slot the release will use — both come out of `dropFor`.
   */
  const [dragId, setDragId] = useState<ID | null>(null)
  const [drop, setDrop] = useState<Drop | null>(null)
  /*
   * Where the pointer is. dnd-kit hands it to the collision detection and to
   * nothing else, and the half of the row it stands in is the whole question here,
   * so it is kept as the collisions go by.
   */
  const pointer = useRef<{ x: number; y: number } | null>(null)

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: CLICK_SLOP } }),
    // Without the delay a finger could not scroll the tree at all: any touch would drag a row.
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  )

  const collide = useCallback<CollisionDetection>((args) => {
    pointer.current = args.pointerCoordinates
    const hits = pointerWithin(args)
    // The tree's own target is what is left when the pointer is under the last row.
    const row = hits.find((c) => c.id !== TREE_ROOT)
    return row ? [row] : hits
  }, [])

  /**
   * A slot, once it has been checked: nothing comes back when the tree would
   * refuse the move, or when the row already stands exactly there.
   */
  function place(dragged: Note, parentId: ID | null, beforeId: ID | null): Drop | null {
    if (beforeId === dragged.id) return null

    // Nothing goes inside itself or inside anything it holds: that would cut the
    // whole subtree out of the tree. The walk stops on a repeat, as the rest do.
    const seen = new Set<ID>()
    let up = parentId
    while (up && !seen.has(up)) {
      if (up === dragged.id) return null
      seen.add(up)
      up = byId.get(up)?.parent_id ?? null
    }

    const level = notes.filter((n) => parentOf(n) === parentId).sort(treeOrder)
    const rest = level.filter((n) => n.id !== dragged.id)
    const found = beforeId ? rest.findIndex((n) => n.id === beforeId) : -1
    let at = found >= 0 ? found : rest.length

    /*
     * The tree draws folders above files whatever their positions say, so a slot
     * among the files is not one a folder could be kept in. The drop is pulled to
     * the nearest slot the tree would hold it in — and since the line is drawn from
     * the same answer, it moves there too rather than promising a place that the
     * next render would take back.
     */
    const firstFile = rest.findIndex((n) => n.kind === 'file')
    const split = firstFile < 0 ? rest.length : firstFile
    at = dragged.kind === 'folder' ? Math.min(at, split) : Math.max(at, split)
    const before = rest[at]?.id ?? null

    // Back where it already stands: nothing to draw, and nothing to write either.
    if (parentId === parentOf(dragged)) {
      const here = level.findIndex((n) => n.id === dragged.id)
      if (before === (level[here + 1]?.id ?? null)) return null
    }
    return { parentId, beforeId: before }
  }

  /** What a release over `overId` would do — the line on the screen and the write alike. */
  function dropFor(overId: string | null): Drop | null {
    const dragged = dragId ? byId.get(dragId) : undefined
    if (!dragged || overId === null || overId === dragId) return null
    if (overId === TREE_ROOT) return place(dragged, null, null)

    const i = rows.findIndex((r) => r.note.id === overId)
    const row = rows[i]
    const y = pointer.current?.y
    // Measured from the page rather than from what dnd-kit read when the drag
    // began: the tree scrolls under the finger while a row is being carried.
    const box = rowsRef.current?.querySelector(`[data-id="${overId}"]`)?.getBoundingClientRect()
    if (!row || y === undefined || !box) return null

    /*
     * A folder keeps its middle half for itself — that is the drop that puts a row
     * inside it — and leaves a quarter at each end for the slots beside it. A file
     * holds nothing, so it is simply split down the middle.
     */
    const share = (y - box.top) / box.height
    if (row.note.kind === 'folder') {
      if (share < 0.25) return place(dragged, row.parentId, row.note.id)
      if (share <= 0.75) return place(dragged, row.note.id, null)
    } else if (share < 0.5) {
      return place(dragged, row.parentId, row.note.id)
    }

    // The lower edge: the slot that follows the row, which for an open folder is
    // the first place inside it rather than the one after the whole subtree.
    const next = rows[i + 1]
    if (!next) return place(dragged, row.parentId, null)
    if (next.depth > row.depth) return place(dragged, row.note.id, next.note.id)
    if (next.depth === row.depth) return place(dragged, row.parentId, next.note.id)
    return place(dragged, row.parentId, null)
  }

  function onDragMove({ over }: DragMoveEvent) {
    const next = dropFor(over ? String(over.id) : null)
    setDrop((prev) => (sameDrop(prev, next) ? prev : next))
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    const target = dropFor(over ? String(over.id) : null)
    setDragId(null)
    setDrop(null)
    if (!target) return

    // A folder that took the row is opened. It may well have been closed — the
    // drop target says plainly where the row is going, and then it would go there
    // and be seen no more.
    const into = target.parentId
    if (into) setExpanded((prev) => new Set(prev).add(into))
    void moveNote(String(active.id), target.parentId, target.beforeId)
  }

  function toggle(id: ID) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  function select(note: Note) {
    setSelectedId(note.id)
    if (note.kind === 'folder') toggle(note.id)
    else setDetail(true)
  }

  async function create(kind: NoteKind) {
    const parentId = selected?.kind === 'folder' ? selected.id : null
    const id = await createNote(workspaceId, kind, parentId, '')
    if (parentId) setExpanded((prev) => new Set(prev).add(parentId))
    setSelectedId(id)
    // Put a freshly created item straight into rename mode: the default name suits almost nobody.
    setRenamingId(id)
  }

  function rename(id: ID, name: string) {
    setRenamingId(null)
    const trimmed = name.trim()
    if (trimmed) void updateNote(id, { name: trimmed })
  }

  const askKey = asking?.kind === 'folder' ? 'notes.confirmDeleteFolder' : 'notes.confirmDeleteFile'

  const menuNote = menu ? (notes.find((n) => n.id === menu.id) ?? null) : null

  /*
   * The line stands above the row that will follow the dropped one. Where there is
   * no such row on the screen — nothing follows it, or the folder it would go into
   * is closed and holds it out of sight — the folder itself is lit instead, and the
   * foot of the tree stands for the end of the root. A line drawn nowhere is the
   * one thing a drag may not do.
   */
  const follower = drop?.beforeId ?? null
  const onScreen = follower !== null && rows.some((r) => r.note.id === follower)
  const lineId = onScreen ? follower : null
  const intoId = drop && !onScreen ? drop.parentId : null
  const atFoot = drop !== null && !onScreen && drop.parentId === null

  return (
    <div className={`notes${detail && openFile ? ' notes--detail' : ''}`}>
      <DndContext
        sensors={sensors}
        collisionDetection={collide}
        autoScroll={AUTO_SCROLL}
        onDragStart={(e: DragStartEvent) => setDragId(String(e.active.id))}
        onDragMove={onDragMove}
        onDragCancel={() => {
          setDragId(null)
          setDrop(null)
        }}
        onDragEnd={onDragEnd}
      >
        <aside className="notes__tree">
          <div className="notes__head">
            <button
              className="notes__head-btn"
              title={t('notes.newFile')}
              aria-label={t('notes.newFile')}
              onClick={() => void create('file')}
            >
              ＋📄
            </button>
            <button
              className="notes__head-btn"
              title={t('notes.newFolder')}
              aria-label={t('notes.newFolder')}
              onClick={() => void create('folder')}
            >
              ＋📁
            </button>
          </div>

          <TreeRows nodeRef={rowsRef}>
            {rows.map(({ note, depth }, i) => (
              <TreeRow
                key={note.id}
                note={note}
                depth={depth}
                selected={note.id === selectedId}
                open={expanded.has(note.id)}
                renaming={note.id === renamingId}
                mark={
                  note.id === lineId
                    ? 'before'
                    : note.id === intoId
                      ? 'into'
                      : atFoot && i === rows.length - 1
                        ? 'after'
                        : undefined
                }
                onSelect={() => select(note)}
                onMenu={setMenu}
                onRename={(name) => rename(note.id, name)}
                onCancelRename={() => setRenamingId(null)}
                t={t}
              />
            ))}
          </TreeRows>
        </aside>
      </DndContext>

      <section className="notes__editor">
        {openFile && (
          <NoteEditor key={openFile.id} note={openFile} onBack={() => setDetail(false)} t={t} />
        )}
      </section>

      {menuNote && menu && (
        <RowMenu
          x={menu.x}
          y={menu.y}
          edge={menu.edge}
          onClose={() => setMenu(null)}
          onRename={() => setRenamingId(menuNote.id)}
          onRemove={() => setAsking(menuNote)}
          t={t}
        />
      )}

      {asking && (
        <Confirm
          question={t(askKey, { name: asking.name })}
          action={t('common.delete')}
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            setAsking(null)
            // deleteNote takes down the subtree itself, no need to duplicate the walk here.
            void deleteNote(asking.id)
          }}
        />
      )}
    </div>
  )
}


/**
 * Opens every folder on the path to a note. A row inside a collapsed folder is not
 * rendered at all, so without this there would be nothing to select or scroll to.
 * The walk stops on a repeat: a parent chain that loops back on itself would
 * otherwise spin forever.
 */
function expandTo(expanded: ReadonlySet<ID>, notes: Note[], note: Note): ReadonlySet<ID> {
  const byId = new Map(notes.map((n) => [n.id, n]))
  const next = new Set(expanded)
  const seen = new Set<ID>()

  let parent = note.parent_id
  while (parent && !seen.has(parent)) {
    seen.add(parent)
    next.add(parent)
    parent = byId.get(parent)?.parent_id ?? null
  }
  return next
}

/** Two drops are the same drop — a moving finger asks the same question many times over. */
function sameDrop(a: Drop | null, b: Drop | null): boolean {
  if (a === null || b === null) return a === b
  return a.parentId === b.parentId && a.beforeId === b.beforeId
}

/** The order of one level of the tree: folders first, then by position. */
function treeOrder(a: Note, b: Note): number {
  return a.kind === b.kind ? a.position - b.position : a.kind === 'folder' ? -1 : 1
}

/**
 * Flat list of visible rows with their depth.
 * Within a level folders come before files, then by position.
 * A record whose parent is gone is lifted to the root, otherwise it would
 * disappear from the tree entirely.
 */
function visibleRows(notes: Note[], expanded: ReadonlySet<ID>): Row[] {
  const known = new Set(notes.map((n) => n.id))
  const children = new Map<ID | null, Note[]>()

  for (const note of notes) {
    const parent = note.parent_id && known.has(note.parent_id) ? note.parent_id : null
    const list = children.get(parent)
    if (list) list.push(note)
    else children.set(parent, [note])
  }

  for (const list of children.values()) list.sort(treeOrder)

  const rows: Row[] = []
  const walk = (parent: ID | null, depth: number) => {
    for (const note of children.get(parent) ?? []) {
      rows.push({ note, depth, parentId: parent })
      if (note.kind === 'folder' && expanded.has(note.id)) walk(note.id, depth + 1)
    }
  }
  walk(null, 0)
  return rows
}

// ---------------------------------------------------------------------- row

/**
 * The rows, and the tree's own drop target: a release in the empty space under
 * the last row puts the note at the root. It is a component of its own because a
 * droppable has to stand inside the `DndContext`, and the context is opened in
 * the markup above this box rather than around the whole view.
 */
function TreeRows({
  nodeRef,
  children,
}: {
  nodeRef: RefObject<HTMLDivElement | null>
  children: ReactNode
}) {
  const { setNodeRef } = useDroppable({ id: TREE_ROOT })

  return (
    <div
      className="notes__rows"
      role="tree"
      ref={(node) => {
        nodeRef.current = node
        setNodeRef(node)
      }}
    >
      {children}
    </div>
  )
}

interface TreeRowProps {
  note: Note
  depth: number
  selected: boolean
  open: boolean
  renaming: boolean
  /** What a release here would do, if the drag is over this row at all. */
  mark?: 'before' | 'into' | 'after'
  onSelect: () => void
  onMenu: (menu: Menu) => void
  onRename: (name: string) => void
  onCancelRename: () => void
  t: T
}

function TreeRow({
  note,
  depth,
  selected,
  open,
  renaming,
  mark,
  onSelect,
  onMenu,
  onRename,
  onCancelRename,
  t,
}: TreeRowProps) {
  // The row is carried and is also stood on: one node, both halves of the gesture.
  const drag = useDraggable({ id: note.id })
  const drop = useDroppable({ id: note.id })
  const pressed = useRef<{ x: number; y: number } | null>(null)

  const className = [
    'notes__row',
    selected ? 'notes__row--on' : '',
    drag.isDragging ? 'notes__row--ghost' : '',
    mark ? `notes__row--${mark}` : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      ref={(node) => {
        drag.setNodeRef(node)
        drop.setNodeRef(node)
      }}
      data-id={note.id}
      className={className}
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      aria-expanded={note.kind === 'folder' ? open : undefined}
      /* The listeners alone, without dnd-kit's attributes: they would turn every
         row of the tree into a button, and there is no keyboard drag here for
         them to describe. */
      {...drag.listeners}
      onPointerDown={(e) => {
        pressed.current = { x: e.clientX, y: e.clientY }
      }}
      onClick={(e) => {
        // A row that was just being carried does not also open its note.
        const from = pressed.current
        pressed.current = null
        if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > CLICK_SLOP) return
        onSelect()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        // A long press is how the drag begins on a phone; the menu does not open under it.
        if (drag.isDragging) return
        onMenu({ id: note.id, x: e.clientX, y: e.clientY, edge: 'left' })
      }}
    >
      <span className="notes__twist">{note.kind === 'folder' ? (open ? '▾' : '▸') : ''}</span>
      <span className="notes__icon">{note.kind === 'folder' ? '📁' : '📄'}</span>

      {renaming ? (
        <RenameInput value={note.name} onCommit={onRename} onCancel={onCancelRename} />
      ) : (
        <span className="notes__name">{note.name.trim() || t('common.untitled')}</span>
      )}

      <button
        className="notes__more"
        title={t('notes.actions')}
        aria-label={t('notes.actions')}
        // The row under it is the drag handle, so the press has to stop here.
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          const box = e.currentTarget.getBoundingClientRect()
          onMenu({ id: note.id, x: box.right, y: box.bottom, edge: 'right' })
        }}
      >
        ⋯
      </button>
    </div>
  )
}

// ------------------------------------------------------------------ renaming

function RenameInput({
  value,
  onCommit,
  onCancel,
}: {
  value: string
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(value)

  return (
    <input
      className="notes__rename"
      value={draft}
      autoFocus
      onFocus={(e) => e.target.select()}
      // The row under the field is the drag handle: a press meant for the text
      // would otherwise carry the row off instead of putting the caret down.
      onMouseDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit(draft)
        if (e.key === 'Escape') onCancel()
      }}
    />
  )
}

// -------------------------------------------------------------- context menu

function RowMenu({
  x,
  y,
  edge,
  onClose,
  onRename,
  onRemove,
  t,
}: {
  x: number
  y: number
  edge: 'left' | 'right'
  onClose: () => void
  onRename: () => void
  onRemove: () => void
  t: T
}) {
  useEscape(onClose)

  /*
   * Hung on its anchor, then pulled back onto the screen. The width comes from
   * the stylesheet and is not the same on a phone as on a laptop, so it is
   * measured after layout instead of being assumed here.
   */
  const box = useRef<HTMLDivElement>(null)
  const [left, setLeft] = useState(x)
  useLayoutEffect(() => {
    const w = box.current?.offsetWidth ?? 0
    const want = edge === 'right' ? x - w : x
    setLeft(Math.max(MENU_GAP, Math.min(want, window.innerWidth - w - MENU_GAP)))
  }, [x, edge])

  return (
    <>
      <div
        className="notes__menu-scrim"
        onMouseDown={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div className="notes__menu" ref={box} style={{ left: `${left}px`, top: `${y}px` }}>
        <button
          className="notes__menu-item"
          onClick={() => {
            onClose()
            onRename()
          }}
        >
          {t('notes.rename')}
        </button>
        <button
          className="notes__menu-item notes__menu-item--danger"
          onClick={() => {
            onClose()
            onRemove()
          }}
        >
          {t('common.delete')}
        </button>
      </div>
    </>
  )
}

// -------------------------------------------------------------------- editor

function NoteEditor({ note, onBack, t }: { note: Note; onBack: () => void; t: T }) {
  const [preview, setPreview] = useState(false)
  const [name, setName] = useAutosave(note.name, (value) => void updateNote(note.id, { name: value }))
  const [content, setContent] = useAutosave(note.content, (value) =>
    void updateNote(note.id, { content: value }),
  )

  const html = useMemo(() => (preview ? renderMarkdown(content) : ''), [preview, content])

  return (
    <>
      <div className="notes__bar">
        <button className="notes__back" onClick={onBack} aria-label={t('notes.back')}>
          ‹
        </button>
        <input
          className="notes__title"
          value={name}
          placeholder={t('notes.name')}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="notes__link" onClick={() => setPreview((v) => !v)}>
          {preview ? t('md.edit') : t('md.preview')}
        </button>
      </div>

      {preview ? (
        <div className="md notes__markdown" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <textarea
          className="notes__textarea"
          value={content}
          placeholder="Markdown"
          onChange={(e) => setContent(e.target.value)}
        />
      )}
    </>
  )
}
