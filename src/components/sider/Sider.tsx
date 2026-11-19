import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconPanelLeftOutline16,
  IconSearchOutline16,
  IconSettingsOutline16,
  NewChatIcon,
} from '../base/icons.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import {
  newChat,
  removeSession,
  removeSessions,
  toggleSessionsPin,
  useChatStore,
} from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { openSessionSearch } from './sessionSearchState.js'
import { SessionItem } from './SessionItem.js'
import styles from './Sider.module.css'

/** 展开的侧边栏：名称与收起按钮、开启新对话、全屏搜索入口、按时间分组的会话列表、底部设置；移动端放在抽屉里，收起按钮关闭抽屉 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const groups = useMemo(() => groupSessions(sessions, now, t), [sessions, now, t])
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [bulkPending, setBulkPending] = useState(false)

  const exitSelect = () => {
    setSelectMode(false)
    setSelected(new Set())
  }

  /** 长按某条会话：进入批量选择并先选中它 */
  const enterSelect = (id: string) => {
    setSelectMode(true)
    setSelected(new Set([id]))
  }

  const toggleSelect = (id: string) => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const toggleRef = useRef(toggleSelect)
  toggleRef.current = toggleSelect


  /** 多选模式下按住复选框划过：经过的每条反转一次，同一行不重复触发 */
  useEffect(() => {
    if (!selectMode) {
      return
    }
    let active = false
    const visited = new Set<string>()
    const paint = (x: number, y: number) => {
      const hit = document.elementFromPoint(x, y)
      if (!hit || !hit.closest('[data-check]')) {
        return
      }
      const row = hit.closest('[data-session-id]')
      const id = row?.getAttribute('data-session-id')
      if (!id || visited.has(id)) {
        return
      }
      visited.add(id)
      toggleRef.current(id)
    }
    const onDown = (event: PointerEvent) => {
      const hit = document.elementFromPoint(event.clientX, event.clientY)
      if (!hit || !hit.closest('[data-check]')) {
        return
      }
      active = true
      visited.clear()
      paint(event.clientX, event.clientY)
    }
    const onMove = (event: PointerEvent) => {
      if (active) {
        paint(event.clientX, event.clientY)
      }
    }
    const stop = () => {
      active = false
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', stop, true)
    window.addEventListener('pointercancel', stop, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', stop, true)
      window.removeEventListener('pointercancel', stop, true)
    }
  }, [selectMode])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      <div className={styles.top}>
        <div className={styles.appName}>{t('appName')}</div>
        <IconButton
          size="m"
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('collapseSiderbarButton')}
          tooltipPlacement="bottom"
          onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
        />
      </div>
      <button
        type="button"
        className={styles.newChat}
        onClick={() => {
          newChat()
          closeMobileSider()
        }}
      >
        <span className={styles.newChatIcon}>
          <NewChatIcon />
        </span>
        {t('newChat')}
      </button>
      <button type="button" className={styles.searchTrigger} onClick={openSessionSearch}>
        <IconSearchOutline16 />
        <span>{t('searchSessionsPlaceholder')}</span>
      </button>
      <div className={styles.listWrap}>
        <div className={styles.list}>
          {groups.map((group) => (
            <div key={group.key} className={styles.section}>
              <div className={styles.sectionHeader}>{group.label}</div>
              {group.sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeId}
                  onDelete={() => setDeleting(session)}
                  selectMode={selectMode}
                  selected={selected.has(session.id)}
                  onToggleSelect={() => toggleSelect(session.id)}
                  onEnterSelect={() => enterSelect(session.id)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      <div className={styles.bottom}>
        {selectMode ? (
          <div className={styles.bulkBar}>
            <span className={styles.bulkCount}>{t('selectedCount', { count: selected.size })}</span>
            <div className={styles.bulkActions}>
              <Button
                size="s"
                variant="outlined"
                disabled={selected.size === 0}
                onClick={() => {
                  toggleSessionsPin([...selected])
                  exitSelect()
                }}
              >
                {t('bulkPin')}
              </Button>
              <Button
                size="s"
                variant="dangerOutlined"
                disabled={selected.size === 0}
                onClick={() => setBulkDeleting(true)}
              >
                {t('delete')}
              </Button>
              <Button size="s" variant="outlined" onClick={exitSelect}>
                {t('exitSelectMode')}
              </Button>
            </div>
          </div>
        ) : (
          <button type="button" className={styles.settings} onClick={() => openSettings('general')}>
            <span className={styles.settingsIcon}>
              <IconSettingsOutline16 />
            </span>
            <span className={styles.settingsLabel}>{t('settings')}</span>
          </button>
        )}
      </div>
      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    if (await removeSession(deleting.id)) {
                      setDeleting(null)
                    } else {
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
      {bulkDeleting ? (
        <Modal
          title={t('bulkDeleteTitle', { count: selected.size })}
          onClose={() => {
            if (!bulkPending) {
              setBulkDeleting(false)
            }
          }}
          footer={
            <>
              <Button
                variant="outlined"
                disabled={bulkPending}
                onClick={() => setBulkDeleting(false)}
              >
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={bulkPending}
                onClick={async () => {
                  const ids = [...selected]
                  setBulkPending(true)
                  try {
                    const ok = await removeSessions(ids)
                    setBulkDeleting(false)
                    exitSelect()
                    if (!ok) {
                      showToast({ key: 'bulkDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setBulkPending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('bulkDeleteDescription')}
        </Modal>
      ) : null}
    </div>
  )
}

/** 移动端抽屉：位于主内容层下方，主内容左/右滑时丝滑显露 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  return (
    <div className={clsx(styles.drawer, open && styles.drawerOpen)} aria-hidden={!open}>
      <Sider mobile />
    </div>
  )
}