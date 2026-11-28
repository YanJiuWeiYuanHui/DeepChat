import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { registerAndroidBackHandler } from '../../app/androidBack.js'
import { useTranslate } from '../../i18n/index.js'
import {
  formatShareText,
  renderTurnsToImageBlob,
  saveShareImageBlob,
  shareImageBlob,
  type ShareTurn,
} from '../../services/chat/shareImage.js'
import { IconCloseOutline16, IconCopyOutline16, IconShareOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { showToast } from '../base/toastState.js'
import { exitShareSelect, setAllShareTurns } from './shareSelectState.js'
import styles from './ShareBar.module.css'

export const ShareCircleCheck = ({ checked }: { checked: boolean }) => (
  <span className={clsx(styles.circleCheck, checked && styles.circleCheckChecked)} aria-hidden>
    {checked ? (
      <svg viewBox="0 0 12 12" width="12" height="12" fill="none">
        <path
          d="M2.5 6.2L4.9 8.6L9.5 3.6"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ) : null}
  </span>
)

export const ShareTopBar = ({
  allTurnIds,
  selectedTurnIds,
}: {
  allTurnIds: string[]
  selectedTurnIds: string[]
}) => {
  const t = useTranslate()
  const allSelected = allTurnIds.length > 0 && selectedTurnIds.length === allTurnIds.length

  useEffect(() => {
    return registerAndroidBackHandler(115, () => {
      exitShareSelect()
      return true
    })
  }, [])

  return (
    <div className={styles.topBar}>
      <button
        type="button"
        className={styles.selectAllBtn}
        onClick={() => setAllShareTurns(allSelected ? [] : allTurnIds)}
      >
        <ShareCircleCheck checked={allSelected} />
        <span>{t('siderSelectAll')}</span>
      </button>
      <span className={styles.topCount}>
        {t('shareSelectedTurns', { count: selectedTurnIds.length })}
      </span>
      <IconButton
        size="xs"
        icon={<IconCloseOutline16 />}
        aria-label={t('cancel')}
        onClick={exitShareSelect}
      />
    </div>
  )
}

export const ShareBottomBar = ({
  title,
  selectedTurns,
}: {
  title: string
  selectedTurns: ShareTurn[]
}) => {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{
    blob: Blob
    mimeType: string
    url: string
    fileName: string
  } | null>(null)

  useEffect(() => {
    return () => {
      if (preview?.url) {
        URL.revokeObjectURL(preview.url)
      }
    }
  }, [preview])

  const closePreview = () => {
    setPreview(null)
  }

  useEffect(() => {
    if (!preview) {
      return
    }
    return registerAndroidBackHandler(125, () => {
      setPreview(null)
      return true
    })
  }, [preview])

  const buildImage = async () => {
    const dark = document.documentElement.hasAttribute('data-ds-dark-theme')
    const safeTitle = (title.trim() || 'deepchat')
      .replace(/[\\/:*?"<>|]/g, '_')
      .slice(0, 32)
    const { blob, mimeType, ext } = await renderTurnsToImageBlob({
      turns: selectedTurns,
      dark,
      appName: t('appName'),
      footerText: t('contentCaveat'),
      searchLabel: (count) =>
        t(count === 1 ? 'messageSearchSummary' : 'messageSearchSummaries', { count }),
    })
    const fileName = `${safeTitle}-${new Date().toISOString().slice(0, 10)}.${ext}`
    return { blob, mimeType, fileName }
  }

  const handleGeneratePreview = async () => {
    if (busy || selectedTurns.length === 0) {
      return
    }
    setBusy(true)
    try {
      const { blob, mimeType, fileName } = await buildImage()
      const url = URL.createObjectURL(blob)
      setPreview({ blob, mimeType, url, fileName })
    } catch {
      showToast({ key: 'shareImageFailed' })
    } finally {
      setBusy(false)
    }
  }

  const handleDirectShare = async () => {
    if (busy || selectedTurns.length === 0) {
      return
    }
    setBusy(true)
    try {
      const { blob, mimeType, fileName } = await buildImage()
      const mode = await shareImageBlob(blob, fileName, mimeType)
      if (mode === 'unsupported') {
        const url = URL.createObjectURL(blob)
        setPreview({ blob, mimeType, url, fileName })
      } else {
        exitShareSelect()
      }
    } catch {
      showToast({ key: 'shareImageFailed' })
    } finally {
      setBusy(false)
    }
  }

  const handleCopyText = async () => {
    if (selectedTurns.length === 0) {
      return
    }
    const text = formatShareText(title, selectedTurns)
    try {
      await navigator.clipboard.writeText(text)
      showToast({ key: 'shareCopiedText' })
      exitShareSelect()
    } catch {
      showToast({ key: 'shareImageFailed' })
    }
  }

  return (
    <>
      <div className={styles.bottomBar}>
        <div className={styles.bottomHeader}>
          <span className={styles.bottomTitle}>
            {t('shareSelectedTurns', { count: selectedTurns.length })}
          </span>
          <IconButton
            size="xs"
            icon={<IconCloseOutline16 />}
            aria-label={t('cancel')}
            onClick={exitShareSelect}
          />
        </div>
        <div className={styles.actionRow}>
          <button
            type="button"
            className={styles.actionItem}
            disabled={busy || selectedTurns.length === 0}
            onClick={() => void handleGeneratePreview()}
          >
            <span className={clsx(styles.actionCircle, styles.actionBlue)}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                <rect x="3" y="4" width="18" height="16" rx="3" stroke="currentColor" strokeWidth="1.8" />
                <circle cx="8.5" cy="9.5" r="1.5" fill="currentColor" />
                <path
                  d="M4.5 17.5L10 12L14 16L16.5 13.5L20 17.5"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span>{t('shareGenerateImage')}</span>
          </button>
          <button
            type="button"
            className={styles.actionItem}
            disabled={busy || selectedTurns.length === 0}
            onClick={() => void handleDirectShare()}
          >
            <span className={clsx(styles.actionCircle, styles.actionGreen)}>
              <IconShareOutline16 />
            </span>
            <span>{t('shareSystemMore')}</span>
          </button>
          <button
            type="button"
            className={styles.actionItem}
            disabled={busy || selectedTurns.length === 0}
            onClick={() => void handleCopyText()}
          >
            <span className={clsx(styles.actionCircle, styles.actionGray)}>
              <IconCopyOutline16 />
            </span>
            <span>{t('shareCopyText')}</span>
          </button>
        </div>
      </div>

      {preview
        ? createPortal(
            <div
              className={styles.sheetBackdrop}
              onClick={(event) => {
                if (event.target === event.currentTarget) {
                  closePreview()
                }
              }}
            >
              <div className={styles.sheetPanel}>
                <div className={styles.sheetHandleRow} onClick={closePreview}>
                  <div className={styles.sheetHandle} />
                </div>
                <div className={styles.sheetScroll}>
                  <div className={styles.sheetCard}>
                    <img src={preview.url} alt={preview.fileName} className={styles.previewImg} />
                  </div>
                </div>
                <div className={styles.sheetFooter}>
                  <button
                    type="button"
                    className={styles.sheetShareBtn}
                    onClick={async () => {
                      try {
                        const mode = await shareImageBlob(
                          preview.blob,
                          preview.fileName,
                          preview.mimeType
                        )
                        if (mode === 'unsupported') {
                          showToast({ key: 'shareSystemUnsupported' })
                        } else {
                          closePreview()
                          exitShareSelect()
                        }
                      } catch {
                        showToast({ key: 'shareImageFailed' })
                      }
                    }}
                  >
                    <IconShareOutline16 />
                    <span>{t('shareSystemMore')}</span>
                  </button>
                  <button
                    type="button"
                    className={styles.sheetSaveBtn}
                    onClick={async () => {
                      try {
                        await saveShareImageBlob(preview.blob, preview.fileName, preview.mimeType)
                        showToast({ key: 'imageSavedToast' })
                        closePreview()
                        exitShareSelect()
                      } catch {
                        showToast({ key: 'imageSaveFailedToast' })
                      }
                    }}
                  >
                    <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
                      <path
                        d="M10 3.5V13M10 13L6.25 9.25M10 13L13.75 9.25M4 16H16"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span>{t('imageViewerDownload')}</span>
                  </button>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}
