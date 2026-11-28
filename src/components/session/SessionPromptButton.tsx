import clsx from 'clsx'
import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { setSessionSystemPrompt } from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { IconSystemPromptOutline20 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './MobileHeader.module.css'

/** 当前会话独立系统提示词入口与编辑弹窗 */
export const SessionPromptButton = ({
  session,
  size = 'xl',
}: {
  session: Session
  size?: 'm' | 'xl'
}) => {
  const t = useTranslate()
  const globalSystemPrompt = useSettings((state) => state.systemPrompt)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const hasCustomPrompt = Boolean(session.systemPrompt?.trim())

  const handleOpen = () => {
    setDraft(session.systemPrompt ?? '')
    setOpen(true)
  }

  const handleSave = () => {
    setSessionSystemPrompt(session.id, draft)
    setOpen(false)
    showToast({
      key: draft.trim() ? 'sessionSystemPromptSavedToast' : 'sessionSystemPromptClearedToast',
    })
  }

  return (
    <>
      <IconButton
        size={size}
        tone="primary"
        className={clsx(hasCustomPrompt && styles.speakerActive)}
        icon={<IconSystemPromptOutline20 />}
        tooltip={t(hasCustomPrompt ? 'sessionSystemPromptActiveTooltip' : 'sessionSystemPromptTooltip')}
        tooltipPlacement="bottom"
        aria-label={t('sessionSystemPromptTitle')}
        aria-pressed={hasCustomPrompt}
        onClick={handleOpen}
      />
      {open ? (
        <Modal
          title={t('sessionSystemPromptTitle')}
          onClose={() => setOpen(false)}
          footer={
            <>
              {hasCustomPrompt || draft.trim() ? (
                <Button
                  variant="outlined"
                  onClick={() => {
                    setDraft('')
                    setSessionSystemPrompt(session.id, '')
                    setOpen(false)
                    showToast({ key: 'sessionSystemPromptClearedToast' })
                  }}
                >
                  {t('sessionSystemPromptUseGlobal')}
                </Button>
              ) : null}
              <Button variant="outlined" onClick={() => setOpen(false)}>
                {t('cancel')}
              </Button>
              <Button onClick={handleSave}>{t('save')}</Button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: 13, color: 'var(--dsw-alias-label-secondary)', lineHeight: '19px' }}>
              {t('sessionSystemPromptDesc')}
            </div>
            <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', lineHeight: '17px' }}>
              {t('sessionSystemPromptCacheHint')}
            </div>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={globalSystemPrompt || t('modelSettingsSystemPromptPlaceholder')}
              rows={6}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid var(--dsw-alias-border-l2)',
                background: 'var(--dsw-specific-input-major, transparent)',
                color: 'var(--dsw-alias-label-primary)',
                font: 'inherit',
                fontSize: 14,
                lineHeight: '20px',
                resize: 'vertical',
                outline: 'none',
              }}
            />
          </div>
        </Modal>
      ) : null}
    </>
  )
}
