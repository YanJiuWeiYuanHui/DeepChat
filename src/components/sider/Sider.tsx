import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { registerAndroidBackHandler } from '../../app/androidBack.js'
import { useTranslate } from '../../i18n/index.js'
import {
  IconCloseOutline16,
  IconPanelLeftOutline16,
  IconPinOutline16,
  IconSearchOutline16,
  IconSettingsOutline16,
  IconTrashOutline16,
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

const dayStart = (time: number) => new Date(time).setHours(0, 0, 0, 0)
const VISIBLE_BATCH = 120

/** 展开的侧边栏：名称与收起按钮、开启新对话、全屏搜索入口、按时间分组的会话列表（支持分页与长按多选）、底部设置 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const groups = useMemo(() => groupSessions(sessions, now, t), [sessions, now, t])
  const [visibleLimit, setVisibleLimit] = useState(VISIBLE_BATCH)
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string> | null>(null)
  const [batchDeletingIds, setBatchDeletingIds] = useState<string[] | null>(null)
  const dragSelectingRef = useRef(false)
  const listWrapRef = useRef<HTMLDivElement>(null)
  const mobileOpen = useMobileSider((state) => state.open)

  const selectMode = selectedIds !== null
  const selectedCount = selectedIds?.size ?? 0
  const selectedList = useMemo(
    () => (selectedIds ? [...selectedIds] : []),
    [selectedIds]
  )
  const allSelectedPinned = useMemo(() => {
    if (!selectedIds || selectedIds.size === 0) {
      return false
    }
    const matched = sessions.filter((session) => selectedIds.has(session.id))
    return matched.length > 0 && matched.every((session) => Boolean(session.pinnedAt))
  }, [sessions, selectedIds])

  const exitSelectMode = useCallback(() => {
    dragSelectingRef.current = false
    setSelectedIds(null)
  }, [])

  // 移动端抽屉关闭时退出多选，避免隐藏抽屉继续拦截硬件返回键或残留旧勾选状态
  useEffect(() => {
    if (mobile && !mobileOpen && selectMode) {
      exitSelectMode()
    }
  }, [mobile, mobileOpen, selectMode, exitSelectMode])

  // 若当前会话落在分页窗口之外，自动扩充上限保证其直接可见
  useEffect(() => {
    if (!activeId) {
      return
    }
    let idx = 0
    for (const group of groups) {
      for (const session of group.sessions) {
        idx += 1
        if (session.id === activeId) {
          if (idx > visibleLimit) {
            setVisibleLimit(Math.ceil(idx / VISIBLE_BATCH) * VISIBLE_BATCH)
          }
          return
        }
      }
    }
  }, [activeId, groups, visibleLimit])

  // 会话列表收缩时同步移除不存在的勾选
  useEffect(() => {
    if (!selectedIds) {
      return
    }
    const existing = new Set(sessions.map((session) => session.id))
    let changed = false
    const next = new Set<string>()
    for (const id of selectedIds) {
      if (existing.has(id)) {
        next.add(id)
      } else {
        changed = true
      }
    }
    if (changed) {
      setSelectedIds(next.size > 0 ? next : null)
    }
  }, [sessions, selectedIds])

  useEffect(() => {
    if (!selectMode) {
      return
    }
    const stopDrag = () => {
      dragSelectingRef.current = false
    }
    window.addEventListener('pointerup', stopDrag)
    window.addEventListener('pointercancel', stopDrag)
    window.addEventListener('touchend', stopDrag)
    window.addEventListener('touchcancel', stopDrag)
    const unregisterBack =
      !mobile || mobileOpen
        ? registerAndroidBackHandler(60, () => {
            exitSelectMode()
            return true
          })
        : null
    return () => {
      window.removeEventListener('pointerup', stopDrag)
      window.removeEventListener('pointercancel', stopDrag)
      window.removeEventListener('touchend', stopDrag)
      window.removeEventListener('touchcancel', stopDrag)
      unregisterBack?.()
    }
  }, [selectMode, mobile, mobileOpen, exitSelectMode])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow((prev) => (dayStart(prev) === dayStart(time) ? prev : time))
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

  const { visibleGroups, remainingCount } = useMemo(() => {
    if (sessions.length <= visibleLimit) {
      return { visibleGroups: groups, remainingCount: 0 }
    }
    const result: ReturnType<typeof groupSessions> = []
    let remaining = visibleLimit
    for (const group of groups) {
      if (remaining <= 0) {
        break
      }
      if (group.sessions.length <= remaining) {
        result.push(group)
        remaining -= group.sessions.length
      } else {
        result.push({ ...group, sessions: group.sessions.slice(0, remaining) })
        remaining = 0
      }
    }
    const shown = result.reduce((sum, group) => sum + group.sessions.length, 0)
    return {
      visibleGroups: result,
      remainingCount: Math.max(0, sessions.length - shown),
    }
  }, [groups, sessions.length, visibleLimit])

  const handleLongPress = useCallback((sessionId: string) => {
    dragSelectingRef.current = true
    setSelectedIds((prev) => {
      const next = new Set(prev ?? [])
      next.add(sessionId)
      return next
    })
  }, [])

  const handleToggleSelect = useCallback((sessionId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev ?? [])
      if (next.has(sessionId)) {
        next.delete(sessionId)
      } else {
        next.add(sessionId)
      }
      return next
    })
  }, [])

  const handleDragSelect = useCallback((sessionId: string, primaryButtonDown = true) => {
    if (!dragSelectingRef.current) {
      return
    }
    if (!primaryButtonDown) {
      dragSelectingRef.current = false
      return
    }
    setSelectedIds((prev) => {
      if (!prev || prev.has(sessionId)) {
        return prev
      }
      const next = new Set(prev)
      next.add(sessionId)
      return next
    })
  }, [])

  // 仅在长按后的拖拽连选期间阻止默认滚动，松手后允许正常上下滚动列表
  useEffect(() => {
    const wrap = listWrapRef.current
    if (!selectMode || !wrap) {
      return
    }
    const onTouchMove = (event: TouchEvent) => {
      if (!dragSelectingRef.current || event.touches.length === 0) {
        return
      }
      if (event.cancelable) {
        event.preventDefault()
      }
      const touch = event.touches[0]
      const el = document.elementFromPoint(touch.clientX, touch.clientY)
      const row = el?.closest<HTMLElement>('[data-session-id]')
      if (row?.dataset.sessionId) {
        handleDragSelect(row.dataset.sessionId)
      }
    }
    wrap.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => {
      wrap.removeEventListener('touchmove', onTouchMove)
    }
  }, [selectMode, handleDragSelect])

  const allSelected = sessions.length > 0 && selectedCount === sessions.length

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      <div className={styles.top}>
        <div className={styles.appName}>{t('appName')}</div>
        <IconButton
          size="m"
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('collapseSiderbarButton')}
          tooltipPlacement="bottom"
          onClick={() => {
            exitSelectMode()
            if (mobile) {
              closeMobileSider()
            } else {
              setSiderCollapsed(true)
            }
          }}
        />
      </div>
      {selectMode ? (
        <div className={styles.selectBar}>
          <span className={styles.selectTitle}>
            {t('siderSelectedCount', { count: selectedCount })}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button
              type="button"
              className={styles.selectLinkBtn}
              onClick={() =>
                setSelectedIds(
                  allSelected ? new Set() : new Set(sessions.map((session) => session.id))
                )
              }
            >
              {t(allSelected ? 'siderClearSelection' : 'siderSelectAll')}
            </button>
            <IconButton
              size="xs"
              icon={<IconCloseOutline16 />}
              aria-label={t('cancel')}
              onClick={exitSelectMode}
            />
          </div>
        </div>
      ) : (
        <>
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
        </>
      )}
      <div ref={listWrapRef} className={styles.listWrap}>
        <div
          className={styles.list}
          onScroll={(event) => {
            if (remainingCount <= 0) {
              return
            }
            const el = event.currentTarget
            if (el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
              setVisibleLimit((prev) => prev + VISIBLE_BATCH)
            }
          }}
        >
          {visibleGroups.map((group) => (
            <div key={group.key} className={styles.section}>
              <div className={styles.sectionHeader}>{group.label}</div>
              {group.sessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeId}
                  selectMode={selectMode}
                  selected={selectedIds?.has(session.id) ?? false}
                  onDelete={setDeleting}
                  onLongPress={handleLongPress}
                  onToggleSelect={handleToggleSelect}
                  onDragEnter={handleDragSelect}
                />
              ))}
            </div>
          ))}
          {remainingCount > 0 ? (
            <div className={styles.loadMoreWrap}>
              <button
                type="button"
                className={styles.loadMoreBtn}
                onClick={() => setVisibleLimit((prev) => prev + VISIBLE_BATCH)}
              >
                {t('loadMoreSessions', { count: remainingCount })}
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <div className={styles.bottom}>
        {selectMode ? (
          <div className={styles.selectActions}>
            <Button
              variant="outlined"
              className={styles.selectActionBtn}
              disabled={selectedCount === 0}
              onClick={() => {
                toggleSessionsPin(selectedList)
                exitSelectMode()
              }}
            >
              <IconPinOutline16 />
              <span>{t(allSelectedPinned ? 'unpinSession' : 'pinSession')}</span>
            </Button>
            <Button
              variant="danger"
              className={styles.selectActionBtn}
              disabled={selectedCount === 0}
              onClick={() => setBatchDeletingIds(selectedList)}
            >
              <IconTrashOutline16 />
              <span>{t('delete')}</span>
            </Button>
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
      {batchDeletingIds ? (
        <Modal
          title={t('batchDeleteSessionsTitle', { count: batchDeletingIds.length })}
          onClose={() => {
            if (!deletePending) {
              setBatchDeletingIds(null)
            }
          }}
          footer={
            <>
              <Button
                variant="outlined"
                disabled={deletePending}
                onClick={() => setBatchDeletingIds(null)}
              >
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  const targets = batchDeletingIds
                  setDeletePending(true)
                  try {
                    const { failed } = await removeSessions(targets)
                    setBatchDeletingIds(null)
                    if (failed.length === 0) {
                      exitSelectMode()
                    } else {
                      setSelectedIds(new Set(failed))
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
