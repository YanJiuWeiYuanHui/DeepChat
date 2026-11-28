import clsx from 'clsx'
import { memo, useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconEditOutline16,
  IconEllipsisOutline16,
  IconPinOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
import { renameSession, selectSession, togglePinSession } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionItem.module.css'

const LONG_PRESS_MS = 500
const DRAG_THRESHOLD_PX = 8

export const SessionItem = memo(function SessionItem({
  session,
  active,
  selectMode,
  selected,
  onDelete,
  onLongPress,
  onToggleSelect,
  onDragEnter,
}: {
  session: SessionSummary
  active: boolean
  selectMode: boolean
  selected: boolean
  onDelete: (session: SessionSummary) => void
  onLongPress: (sessionId: string) => void
  onToggleSelect: (sessionId: string) => void
  onDragEnter: (sessionId: string, primaryButtonDown: boolean) => void
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const displayTitle = session.title || t('untitledChat')
  const pressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressClickRef = useRef(false)
  const startPointRef = useRef<{ x: number; y: number } | null>(null)

  const cancelPress = () => {
    if (pressTimerRef.current !== null) {
      clearTimeout(pressTimerRef.current)
      pressTimerRef.current = null
    }
    startPointRef.current = null
  }

  useEffect(() => cancelPress, [])

  useEffect(() => {
    if (selectMode) {
      setEditing(false)
      setMenuOpen(false)
    } else {
      suppressClickRef.current = false
    }
  }, [selectMode])

  const startPress = (x: number, y: number) => {
    if (selectMode) {
      return
    }
    cancelPress()
    startPointRef.current = { x, y }
    pressTimerRef.current = setTimeout(() => {
      pressTimerRef.current = null
      suppressClickRef.current = true
      onLongPress(session.id)
    }, LONG_PRESS_MS)
  }

  const movePress = (x: number, y: number) => {
    const start = startPointRef.current
    if (!start || pressTimerRef.current === null) {
      return
    }
    if (Math.hypot(x - start.x, y - start.y) > DRAG_THRESHOLD_PX) {
      cancelPress()
    }
  }

  if (editing && !selectMode) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <input
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <div
      data-session-id={session.id}
      className={clsx(
        styles.item,
        active && !selectMode && styles.active,
        selectMode && styles.selectMode,
        selected && styles.selected,
        menuOpen && styles.menuOpen
      )}
      onPointerDown={(event) => {
        suppressClickRef.current = false
        if (event.button === 0) {
          startPress(event.clientX, event.clientY)
        }
      }}
      onPointerMove={(event) => movePress(event.clientX, event.clientY)}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onMouseEnter={(event) => {
        if (selectMode) {
          onDragEnter(session.id, (event.buttons & 1) !== 0)
        }
      }}
      onContextMenu={(event) => {
        if (selectMode || suppressClickRef.current || pressTimerRef.current !== null) {
          event.preventDefault()
        }
      }}
      onClick={() => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false
          return
        }
        if (selectMode) {
          onToggleSelect(session.id)
          return
        }
        selectSession(session.id)
        closeMobileSider()
      }}
    >
      {selectMode ? (
        <span className={clsx(styles.checkbox, selected && styles.checkboxChecked)} aria-hidden>
          {selected ? (
            <svg viewBox="0 0 12 12" width="12" height="12" fill="none">
              <path
                d="M2.5 6.2L4.9 8.6L9.5 3.6"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : null}
        </span>
      ) : null}
      <div className={styles.title}>{displayTitle}</div>
      {!selectMode && session.pinnedAt ? (
        <span className={styles.pinBadge} aria-hidden>
          <IconPinOutline16 />
        </span>
      ) : null}
      {!selectMode ? (
        <div
          className={styles.action}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Menu
            onOpenChange={setMenuOpen}
            options={[
              {
                key: 'pin',
                label: t(session.pinnedAt ? 'unpinSession' : 'pinSession'),
                icon: <IconPinOutline16 />,
                onSelect: () => {
                  setMenuOpen(false)
                  togglePinSession(session.id)
                },
              },
              {
                key: 'rename',
                label: t('sessionItemMenuRenameOption'),
                icon: <IconEditOutline16 />,
                onSelect: () => {
                  setMenuOpen(false)
                  setEditing(true)
                },
              },
              {
                key: 'delete',
                label: t('delete'),
                icon: <IconTrashOutline16 />,
                danger: true,
                onSelect: () => {
                  setMenuOpen(false)
                  onDelete(session)
                },
              },
            ]}
          >
            {({ open, toggle }) => (
              <IconButton
                icon={<IconEllipsisOutline16 />}
                aria-label={t('more')}
                aria-expanded={open}
                onClick={toggle}
              />
            )}
          </Menu>
        </div>
      ) : null}
    </div>
  )
})
