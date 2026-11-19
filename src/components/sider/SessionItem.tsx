import clsx from 'clsx'
import { memo, useRef, useState, type PointerEvent } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconCheckOutline16,
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

/** 长按多久进入批量选择 */
const LONG_PRESS_MS = 500
/** 指针移动超过这个距离就视为滑动，不当作点击（避免滑动列表时误选中） */
const DRAG_PX = 8

export const SessionItem = memo(function SessionItem({
  session,
  active,
  onDelete,
  selectMode = false,
  selected = false,
  onToggleSelect,
  onEnterSelect,
}: {
  session: SessionSummary
  active: boolean
  onDelete: () => void
  /** 批量选择模式下点击切换选中，不再打开会话 */
  selectMode?: boolean
  selected?: boolean
  onToggleSelect?: () => void
  /** 长按会话进入批量选择 */
  onEnterSelect?: () => void
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const displayTitle = session.title || t('untitledChat')
  const pressTimer = useRef<number | undefined>(undefined)
  const longPressed = useRef(false)
  const downAt = useRef<{ x: number; y: number } | null>(null)
  const dragged = useRef(false)

  const cancelPress = () => {
    if (pressTimer.current !== undefined) {
      window.clearTimeout(pressTimer.current)
      pressTimer.current = undefined
    }
  }

  const startPress = () => {
    if (selectMode || !onEnterSelect) {
      return
    }
    longPressed.current = false
    cancelPress()
    pressTimer.current = window.setTimeout(() => {
      longPressed.current = true
      onEnterSelect()
    }, LONG_PRESS_MS)
  }

  const trackDown = (event: PointerEvent<HTMLDivElement>) => {
    downAt.current = { x: event.clientX, y: event.clientY }
    dragged.current = false
  }

  const trackMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = downAt.current
    if (!start) {
      return
    }
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    if (dx * dx + dy * dy > DRAG_PX * DRAG_PX) {
      dragged.current = true
      cancelPress()
    }
  }

  const trackUp = () => {
    downAt.current = null
    cancelPress()
  }

  /** 按下后手指离开条目（划过），一律不算点击 */
  const trackLeave = () => {
    if (downAt.current) {
      dragged.current = true
    }
    trackUp()
  }

  /** 滑动和长按都不算点击 */
  const clickAllowed = () => {
    if (dragged.current) {
      dragged.current = false
      return false
    }
    return true
  }

  if (editing) {
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

  if (selectMode) {
    return (
      <div
        className={clsx(styles.item, selected && styles.selected)}
        data-session-id={session.id}
        onPointerDown={trackDown}
        onPointerMove={trackMove}
        onPointerUp={trackUp}
        onPointerLeave={trackLeave}
        onPointerCancel={trackUp}
        onClick={(event) => {
          // 复选框上的点击由拖动选择处理，避免一次点击切换两次
          if ((event.target as Element).closest('[data-check]')) {
            return
          }
          if (clickAllowed()) {
            onToggleSelect?.()
          }
        }}
      >
        <span className={styles.checkArea} data-check="true" aria-hidden>
          <span className={clsx(styles.checkbox, selected && styles.checkboxOn)}>
            {selected ? <IconCheckOutline16 /> : null}
          </span>
        </span>
        <div className={styles.title}>{displayTitle}</div>
        {session.pinnedAt ? (
          <span className={styles.pinBadge} aria-hidden>
            <IconPinOutline16 />
          </span>
        ) : null}
      </div>
    )
  }

  return (
    <div
      className={clsx(styles.item, active && styles.active, menuOpen && styles.menuOpen)}
      onPointerDown={(event) => {
        trackDown(event)
        startPress()
      }}
      onPointerMove={trackMove}
      onPointerUp={trackUp}
      onPointerLeave={trackLeave}
      onPointerCancel={trackUp}
      onContextMenu={(event) => event.preventDefault()}
      onClick={() => {
        if (!clickAllowed()) {
          return
        }
        if (longPressed.current) {
          longPressed.current = false
          return
        }
        selectSession(session.id)
        closeMobileSider()
      }}
    >
      <div className={styles.title}>{displayTitle}</div>
      {session.pinnedAt ? (
        <span className={styles.pinBadge} aria-hidden>
          <IconPinOutline16 />
        </span>
      ) : null}
      <div className={styles.action} onClick={(event) => event.stopPropagation()}>
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
              onSelect: onDelete,
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
    </div>
  )
})
