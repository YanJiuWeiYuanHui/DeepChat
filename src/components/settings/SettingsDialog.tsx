import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  IconDarkOutline16,
  IconDataOutline16,
  IconDownloadOutline16,
  IconEditOutline16,
  IconFollowsystemOutline16,
  IconLightOutline16,
  IconSettingsOutline16,
  IconThinkOutline16,
  IconUploadOutline14,
} from '../base/icons.js'
import {
  BackupError,
  clearHistory,
  exportHistory,
  importHistory,
  mergeHistory,
} from '../../services/chat/backup.js'
import { useIsMobile } from '../../app/viewport.js'
import { isNativeBackupAvailable } from '../../services/chat/nativeBackup.js'
import {
  exportRawIndexedDB,
  inspectAndRepairStorage,
  mergePendingStaging,
  useChatStore,
} from '../../services/chat/store.js'
import { regionCodes, getRegionName, provinces } from '../../services/location.js'
import {
  isChineseBrowser,
  setAutoCheckUpdate,
  setAvatarDataUrl,
  setAvatarEnabled,
  setAvatarShape,
  setAvatarSize,
  setCollapseThinking,
  setAutoCollapseThinking,
  setDailyTokenLimit,
  setLocale,
  setLocation,
  setThemePreference,
  setTokenLimitEnabled,
  setTtsVoice,
  setVoiceAutoSend,
  useSettings,
  type ThemePreference,
} from '../../services/settings.js'
import {
  resetDailyTokenUsage,
  syncDailyTokenDate,
  useDailyTokenUsage,
} from '../../services/tokenUsage.js'
import {
  checkForUpdates,
  getCurrentAppVersion,
  openUpdateModal,
  useUpdater,
} from '../../services/updater.js'
import {
  translate,
  useTranslate,
  type TranslationKey,
  type TranslationMessage,
} from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { saveDownloadedBlob } from '../../utils/download.js'
import { useApiKeyEditor } from './ApiKeyField.js'
import { AvatarCropModal } from './AvatarCropModal.js'
import { MemorySettings } from './MemorySettings.js'
import { ModelSettings } from './ModelSettings.js'
import { closeSettings, useSettingsDialog, type SettingsSection } from './settingsDialogState.js'
import styles from './Settings.module.css'

/**
 * 设置弹窗：分「通用设置」（主题、语言、朗读音色、位置）与「数据管理」（API Key、导入、导出、删除）。
 * 桌面端为居中弹窗、左侧导航；移动端为底部弹层、导航横排在内容上方
 */
export const SettingsDialog = () => {
  const open = useSettingsDialog((state) => state.open)
  return open ? <SettingsContent /> : null
}

const sections: { value: SettingsSection; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'general',
    label: 'settingDialogAsideGeneralOptionLabel',
    icon: <IconSettingsOutline16 />,
  },
  {
    value: 'model',
    label: 'settingDialogAsideModelOptionLabel',
    icon: <IconThinkOutline16 />,
  },
  {
    value: 'memory',
    label: 'settingDialogAsideMemoryOptionLabel',
    icon: <IconEditOutline16 />,
  },
  { value: 'data', label: 'settingDialogAsideDataOptionLabel', icon: <IconDataOutline16 /> },
]

const SettingsContent = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  // 按 store 中的分组选中，支持在弹窗已打开时由外部跳转到指定分组
  const section = useSettingsDialog((state) => state.section)
  // 切换分组不丢失正在输入的 API Key 与导入状态
  const apiKeyEditor = useApiKeyEditor()
  const historyMerge = useHistoryImport('merge')
  const historyImport = useHistoryImport('replace')
  const historyDelete = useHistoryDelete()
  const replacingHistory = useChatStore((state) => state.importingHistory)
  const historyBusy =
    historyMerge.busy || historyImport.busy || historyDelete.busy || replacingHistory
  return (
    <>
      <Modal
        title={t('settings')}
        closable={!historyBusy}
        className={styles.dialog}
        mainClassName={styles.dialogMain}
        onClose={() => {
          if (!historyBusy) {
            closeSettings()
          }
        }}
      >
        <div role="tablist" className={styles.navigation}>
          {sections.map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={section === item.value}
              className={clsx(styles.navItem, section === item.value && styles.navItemActive)}
              onClick={() => useSettingsDialog.setState({ section: item.value })}
            >
              {item.icon}
              {t(item.label)}
            </button>
          ))}
        </div>
        <div role="tabpanel" className={styles.content}>
          {section === 'general' ? (
            <>
              <ThemeSetting />
              <LocaleSetting />
              <TtsVoiceSetting />
              <VoiceAutoSendSetting />
              <AvatarSetting />
              <CollapseThinkingSetting />
              <AutoCollapseThinkingSetting />
              <LocationSetting />
              <TokenLimitSetting />
              <UpdateSetting />
            </>
          ) : section === 'model' ? (
            <ModelSettings apiKeyEditor={apiKeyEditor} isMobile={isMobile} />
          ) : section === 'memory' ? (
            <MemorySettings />
          ) : (
            <>
              <ImportHistory mode="merge" historyImport={historyMerge} disabled={historyBusy} />
              <ImportHistory mode="replace" historyImport={historyImport} disabled={historyBusy} />
              <ExportHistory disabled={historyBusy} />
              <StorageHealthSetting disabled={historyBusy} />
              {isNativeBackupAvailable() ? <RawIndexedDbExport disabled={historyBusy} /> : null}
              <SettingCell
                label={t('deleteAllSessions')}
                status={null}
                action={
                  <Button
                    variant="dangerOutlined"
                    size="m"
                    className={styles.cellButton}
                    disabled={historyBusy}
                    onClick={historyDelete.open}
                  >
                    {t('delete')}
                  </Button>
                }
              />
            </>
          )}
        </div>
      </Modal>
      {historyMerge.file ? <ImportConfirm mode="merge" historyImport={historyMerge} /> : null}
      {historyImport.file ? <ImportConfirm mode="replace" historyImport={historyImport} /> : null}
      {historyDelete.opened ? <DeleteAllConfirm historyDelete={historyDelete} /> : null}
    </>
  )
}

/** 删除确认保留在设置之上；失败可重试，成功只关闭确认弹窗。 */
const DeleteAllConfirm = ({
  historyDelete,
}: {
  historyDelete: ReturnType<typeof useHistoryDelete>
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('deleteAllSessionsModalTitle')}
      className={styles.deleteConfirm}
      onClose={historyDelete.cancel}
      footer={
        <div className={styles.deleteActions} aria-busy={historyDelete.busy}>
          <Button
            variant="outlined"
            autoFocus
            disabled={historyDelete.busy}
            onClick={historyDelete.cancel}
          >
            {t('cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={historyDelete.busy}
            onClick={() => void historyDelete.confirm()}
          >
            {t(historyDelete.busy ? 'historyDeleting' : 'deleteAllSessions')}
          </Button>
        </div>
      }
    >
      {t('deleteAllSessionsModalDescription')}
    </Modal>
  )
}

const TOKEN_PRESETS = [
  { label: '50k', value: 50_000 },
  { label: '100k', value: 100_000 },
  { label: '500k', value: 500_000 },
  { label: '1M', value: 1_000_000 },
]

const TokenLimitSetting = () => {
  const t = useTranslate()
  const tokenLimitEnabled = useSettings((state) => state.tokenLimitEnabled)
  const dailyTokenLimit = useSettings((state) => state.dailyTokenLimit)
  const totalTokens = useDailyTokenUsage((state) => state.totalTokens)
  const inputTokens = useDailyTokenUsage((state) => state.inputTokens)
  const outputTokens = useDailyTokenUsage((state) => state.outputTokens)
  const [limitDraft, setLimitDraft] = useState(String(dailyTokenLimit))

  useEffect(() => {
    syncDailyTokenDate()
  }, [])

  useEffect(() => {
    setLimitDraft(String(dailyTokenLimit))
  }, [dailyTokenLimit])

  const exceeded = tokenLimitEnabled && totalTokens >= dailyTokenLimit
  const commitLimit = () => {
    const n = Number(limitDraft.trim())
    if (Number.isFinite(n) && n >= 1000) {
      setDailyTokenLimit(n)
    } else {
      setLimitDraft(String(dailyTokenLimit))
    }
  }

  return (
    <>
      <SettingCell
        label={t('tokenLimitToggleLabel')}
        description={t('tokenLimitToggleDesc', {
          total: totalTokens.toLocaleString(),
          input: inputTokens.toLocaleString(),
          output: outputTokens.toLocaleString(),
        })}
        status={exceeded ? { key: 'tokenLimitExceededTag', error: true } : null}
        action={
          <div className={styles.fetchRow}>
            {totalTokens > 0 ? (
              <Button
                variant="outlined"
                size="m"
                onClick={() => {
                  resetDailyTokenUsage()
                  showToast({ key: 'tokenLimitResetToast' })
                }}
              >
                {t('tokenLimitResetButton')}
              </Button>
            ) : null}
            <button
              type="button"
              role="switch"
              aria-checked={tokenLimitEnabled}
              aria-label={t('tokenLimitToggleLabel')}
              className={styles.switch}
              onClick={() => setTokenLimitEnabled(!tokenLimitEnabled)}
            >
              <span className={styles.switchThumb} />
            </button>
          </div>
        }
      />
      {tokenLimitEnabled ? (
        <div className={styles.cell}>
          <div className={styles.label}>{t('tokenLimitValueLabel')}</div>
          <div className={styles.description}>{t('tokenLimitValueDesc')}</div>
          <div className={styles.fetchRow}>
            <input
              type="number"
              min={1000}
              step={10000}
              className={clsx(styles.textInput, styles.fetchInput)}
              value={limitDraft}
              onChange={(event) => {
                const raw = event.target.value
                setLimitDraft(raw)
                const n = Number(raw)
                if (Number.isFinite(n) && n >= 1000) {
                  setDailyTokenLimit(n)
                }
              }}
              onBlur={commitLimit}
            />
            <div className={styles.presetRow}>
              {TOKEN_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  className={styles.presetPill}
                  onClick={() => {
                    setDailyTokenLimit(preset.value)
                    setLimitDraft(String(preset.value))
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}

const UpdateSetting = () => {
  const t = useTranslate()
  const autoCheckUpdate = useSettings((state) => state.autoCheckUpdate)
  const checking = useUpdater((state) => state.checking)
  const latest = useUpdater((state) => state.latest)
  const versionInfo = getCurrentAppVersion()

  return (
    <>
      <SettingCell
        label={t('updateSectionLabel')}
        description={t('updateCurrentVersion', {
          version: versionInfo.versionName,
          platform: versionInfo.isAndroid ? 'Android' : 'Web',
        })}
        status={null}
        action={
          <div className={styles.fetchRow}>
            {latest ? (
              <Button variant="outlined" size="m" onClick={openUpdateModal}>
                {t('updateViewAnnouncement')}
              </Button>
            ) : null}
            <Button
              variant="outlined"
              size="m"
              className={styles.cellButton}
              disabled={checking}
              onClick={() => void checkForUpdates({ manual: true })}
            >
              {t(checking ? 'updateCheckingButton' : 'updateCheckButton')}
            </Button>
          </div>
        }
      />
      <SettingCell
        label={t('updateAutoCheckLabel')}
        description={t('updateAutoCheckDesc')}
        status={null}
        action={
          <button
            type="button"
            role="switch"
            aria-checked={autoCheckUpdate}
            aria-label={t('updateAutoCheckLabel')}
            className={styles.switch}
            onClick={() => setAutoCheckUpdate(!autoCheckUpdate)}
          >
            <span className={styles.switchThumb} />
          </button>
        }
      />
    </>
  )
}

const useHistoryDelete = () => {
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const deleting = useRef(false)

  const confirm = async () => {
    if (deleting.current) {
      return
    }
    deleting.current = true
    setBusy(true)
    try {
      await clearHistory()
      setOpened(false)
      showToast({ key: 'historyDeleted' })
    } catch {
      showToast({ key: 'historyDeleteFailed', type: 'error' })
    } finally {
      deleting.current = false
      setBusy(false)
    }
  }

  return {
    opened,
    busy,
    open: () => setOpened(true),
    cancel: () => {
      if (!deleting.current) {
        setOpened(false)
      }
    },
    confirm,
  }
}

const LocationSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const location = useSettings((state) => state.location)
  const province =
    location?.region === 'CN'
      ? provinces.find((item) => item.code === location.province)
      : undefined

  return (
    <SettingCell
      label={t('settingsLocation')}
      status={null}
      className={styles.locationCell}
      action={
        <div className={styles.locationSelectors}>
          {isChineseBrowser() ? (
            <>
              <Select
                ariaLabel={t('settingsLocationProvince')}
                className={styles.provinceSelect}
                value={province?.code ?? ''}
                placeholder={t('settingsLocationProvince')}
                options={provinces.map((item) => ({ value: item.code, label: item.name }))}
                onChange={(value) => {
                  if (value !== province?.code) {
                    setLocation({ region: 'CN', province: value })
                  }
                }}
              />
              <Select
                ariaLabel={t('settingsLocationCity')}
                className={styles.citySelect}
                value={province ? (location?.city ?? '') : ''}
                disabled={!province?.cities.length}
                placeholder={t('settingsLocationCity')}
                options={
                  province?.cities.map((item) => ({ value: item.code, label: item.name })) ?? []
                }
                onChange={(value) => {
                  if (province) {
                    setLocation({ region: 'CN', province: province.code, city: value })
                  }
                }}
              />
            </>
          ) : (
            <Select
              ariaLabel={t('settingsLocationRegion')}
              className={styles.regionSelect}
              value={location?.region ?? ''}
              placeholder={t('settingsLocationRegion')}
              options={regionCodes
                .map((code) => ({ value: code, label: getRegionName(code, locale) }))
                .sort((a, b) => a.label.localeCompare(b.label, locale))}
              onChange={(value) => setLocation({ region: value })}
            />
          )}
        </div>
      }
    />
  )
}

const LocaleSetting = () => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  return (
    <SettingCell
      label={t('settingsLocalePreference')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsLocalePreference')}
          value={locale}
          options={[
            { value: 'zh-CN', label: t('settingsLocaleZhCN'), lang: 'zh-CN' },
            { value: 'en-US', label: t('settingsLocaleEnUS'), lang: 'en' },
          ]}
          onChange={setLocale}
        />
      }
    />
  )
}

/** 朗读音色：stella（海星，女声）/ tide（暗潮，男声） */
const TtsVoiceSetting = () => {
  const t = useTranslate()
  const ttsVoice = useSettings((state) => state.ttsVoice)
  return (
    <SettingCell
      label={t('settingsTtsVoice')}
      status={null}
      action={
        <Select
          ariaLabel={t('settingsTtsVoice')}
          value={ttsVoice}
          options={[
            { value: 'stella', label: t('settingsTtsVoiceStella') },
            { value: 'tide', label: t('settingsTtsVoiceTide') },
          ]}
          onChange={setTtsVoice}
        />
      }
    />
  )
}

const VoiceAutoSendSetting = () => {
  const t = useTranslate()
  const voiceAutoSend = useSettings((state) => state.voiceAutoSend)
  return (
    <SettingCell
      label={t('voiceAutoSendLabel')}
      description={t('voiceAutoSendDesc')}
      status={null}
      action={
        <button
          type="button"
          role="switch"
          aria-checked={voiceAutoSend}
          aria-label={t('voiceAutoSendLabel')}
          className={styles.switch}
          onClick={() => setVoiceAutoSend(!voiceAutoSend)}
        >
          <span className={styles.switchThumb} />
        </button>
      }
    />
  )
}

const AvatarSetting = () => {
  const t = useTranslate()
  const avatarEnabled = useSettings((state) => state.avatarEnabled)
  const avatarDataUrl = useSettings((state) => state.avatarDataUrl)
  const avatarShape = useSettings((state) => state.avatarShape)
  const avatarSize = useSettings((state) => state.avatarSize)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [cropFile, setCropFile] = useState<File | null>(null)

  return (
    <>
      <SettingCell
        label={t('avatarSectionLabel')}
        description={t('avatarSectionDesc')}
        status={null}
        action={
          <button
            type="button"
            role="switch"
            aria-checked={avatarEnabled}
            aria-label={t('avatarSectionLabel')}
            className={styles.switch}
            onClick={() => setAvatarEnabled(!avatarEnabled)}
          >
            <span className={styles.switchThumb} />
          </button>
        }
      />
      {avatarEnabled ? (
        <div className={styles.cell}>
          <div className={styles.avatarConfigPanel}>
            <div className={styles.avatarControlRow}>
              <div className={styles.fetchRow}>
                {avatarDataUrl ? (
                  <img
                    src={avatarDataUrl}
                    alt=""
                    className={clsx(
                      styles.avatarPreview,
                      avatarShape === 'circle' ? styles.avatarCircle : styles.avatarSquare
                    )}
                    style={{ width: avatarSize, height: avatarSize }}
                  />
                ) : null}
                <Button variant="outlined" size="m" onClick={() => fileInputRef.current?.click()}>
                  {t('avatarImportButton')}
                </Button>
                {avatarDataUrl ? (
                  <Button variant="dangerOutlined" size="m" onClick={() => setAvatarDataUrl('')}>
                    {t('avatarClearButton')}
                  </Button>
                ) : null}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null
                  event.target.value = ''
                  if (file) {
                    setCropFile(file)
                  }
                }}
              />
            </div>
            <div className={styles.avatarControlRow}>
              <span className={styles.label}>{t('avatarShapeLabel')}</span>
              <div className={styles.presetRow}>
                <button
                  type="button"
                  className={clsx(
                    styles.presetPill,
                    avatarShape === 'circle' && styles.presetPillActive
                  )}
                  onClick={() => setAvatarShape('circle')}
                >
                  {t('avatarShapeCircle')}
                </button>
                <button
                  type="button"
                  className={clsx(
                    styles.presetPill,
                    avatarShape === 'square' && styles.presetPillActive
                  )}
                  onClick={() => setAvatarShape('square')}
                >
                  {t('avatarShapeSquare')}
                </button>
              </div>
            </div>
            <div className={styles.avatarControlRow}>
              <span className={styles.label}>{t('avatarSizeLabel', { size: avatarSize })}</span>
              <input
                type="range"
                min={24}
                max={64}
                step={2}
                className={styles.avatarSlider}
                value={avatarSize}
                onChange={(event) => setAvatarSize(Number(event.target.value))}
              />
            </div>
          </div>
        </div>
      ) : null}
      {cropFile ? (
        <AvatarCropModal
          file={cropFile}
          shape={avatarShape}
          onClose={() => setCropFile(null)}
          onConfirm={(dataUrl) => {
            setAvatarDataUrl(dataUrl)
            setAvatarEnabled(true)
            setCropFile(null)
          }}
        />
      ) : null}
    </>
  )
}

const CollapseThinkingSetting = () => {
  const t = useTranslate()
  const collapseThinking = useSettings((state) => state.collapseThinking)
  return (
    <SettingCell
      label={t('collapseThinkingLabel')}
      description={t('collapseThinkingDesc')}
      status={null}
      action={
        <button
          type="button"
          role="switch"
          aria-checked={collapseThinking}
          aria-label={t('collapseThinkingLabel')}
          className={styles.switch}
          onClick={() => setCollapseThinking(!collapseThinking)}
        >
          <span className={styles.switchThumb} />
        </button>
      }
    />
  )
}

const AutoCollapseThinkingSetting = () => {
  const t = useTranslate()
  const autoCollapseThinking = useSettings((state) => state.autoCollapseThinking)
  return (
    <SettingCell
      label={t('autoCollapseThinkingLabel')}
      description={t('autoCollapseThinkingDesc')}
      status={null}
      action={
        <button
          type="button"
          role="switch"
          aria-checked={autoCollapseThinking}
          aria-label={t('autoCollapseThinkingLabel')}
          className={styles.switch}
          onClick={() => setAutoCollapseThinking(!autoCollapseThinking)}
        >
          <span className={styles.switchThumb} />
        </button>
      }
    />
  )
}

/** 导入确认框，按 mode 区分「追加合并（安全保留旧存档）」与「覆盖导入（清空旧记录）」 */
const ImportConfirm = ({
  mode,
  historyImport,
}: {
  mode: 'merge' | 'replace'
  historyImport: ReturnType<typeof useHistoryImport>
}) => {
  const t = useTranslate()
  const isMerge = mode === 'merge'
  return (
    <Modal
      title={t(isMerge ? 'historyMergeImportConfirmTitle' : 'historyImportConfirmTitle')}
      className={styles.importConfirm}
      onClose={historyImport.cancel}
      footer={
        <>
          <Button variant="outlined" size="m" autoFocus onClick={historyImport.cancel}>
            {t('cancel')}
          </Button>
          <Button
            variant={isMerge ? 'primary' : 'dangerOutlined'}
            size="m"
            onClick={() => void historyImport.confirm()}
          >
            {t(isMerge ? 'historyMergeImportConfirm' : 'historyImportConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.importConfirmText}>
        {t(isMerge ? 'historyMergeImportConfirmDescription' : 'historyImportConfirmDescription')}
      </div>
    </Modal>
  )
}

const themeOptions: { value: ThemePreference; label: TranslationKey; icon: ReactNode }[] = [
  {
    value: 'light',
    label: 'avatarMenuSettingsDialogThemeSelectLightOption',
    icon: <IconLightOutline16 />,
  },
  {
    value: 'dark',
    label: 'avatarMenuSettingsDialogThemeSelectDarkOption',
    icon: <IconDarkOutline16 />,
  },
  {
    value: 'system',
    label: 'avatarMenuSettingsDialogThemeSelectSystemOption',
    icon: <IconFollowsystemOutline16 />,
  },
]

/**
 * 主题项：标题下方浅色 / 深色 / 跟随系统三个选块。
 * 与下方语言选项连续排列。
 */
const ThemeSetting = () => {
  const t = useTranslate()
  const themePreference = useSettings((state) => state.themePreference)
  const label = t('avatarMenuSettingsDialogThemeItemLabel')
  return (
    <div className={styles.theme}>
      {label}
      <div role="radiogroup" aria-label={label} className={styles.themeOptions}>
        {themeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={themePreference === option.value}
            className={clsx(
              styles.themeOption,
              themePreference === option.value && styles.themeOptionSelected
            )}
            onClick={() => setThemePreference(option.value)}
          >
            {option.icon}
            {t(option.label)}
          </button>
        ))}
      </div>
    </div>
  )
}

/** `reason` 为失败原因的文案 key，展示时按当前语言翻译后填入 `message` 参数。 */
type Status = (TranslationMessage & { error?: boolean; reason?: TranslationKey }) | null

/** 导出失败附带原因：预期的错误用对应文案作原因，其他错误用错误信息。 */
const errorStatus = (key: TranslationKey, error: unknown): Status => ({
  key,
  ...(error instanceof BackupError
    ? { reason: error.key }
    : { params: { message: error instanceof Error ? error.message : String(error) } }),
  error: true,
})

const SettingCell = ({
  label,
  description,
  status,
  action,
  className,
}: {
  label: string
  description?: string
  status: Status
  action: ReactNode
  className?: string
}) => {
  const t = useTranslate()
  return (
    <div className={clsx(styles.cell, styles.row, className)}>
      <div className={styles.text}>
        <div className={styles.label}>{label}</div>
        {status || description ? (
          <div className={clsx(styles.description, status?.error && styles.error)}>
            {status
              ? t(status.key, status.reason ? { message: t(status.reason) } : status.params)
              : description}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  )
}

/** 选文件后先确认方式；确认后才校验文件并执行覆盖或追加合并，实时展示进度并反馈具体错误。 */
const useHistoryImport = (mode: 'merge' | 'replace') => {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)
  const importing = useRef(false)

  const confirm = async () => {
    if (!file || importing.current) {
      return
    }
    importing.current = true
    setFile(null)
    setBusy(true)
    setStatus({ key: 'historyImporting', params: { count: 0 } })
    const onProgress = (parsedCount: number) => {
      if (parsedCount <= 10 || parsedCount % 10 === 0) {
        setStatus({ key: 'historyImporting', params: { count: parsedCount } })
      }
    }
    try {
      let successStatus: Status
      if (mode === 'merge') {
        const result = await mergeHistory(file, onProgress)
        successStatus = {
          key: 'historyMerged',
          params: {
            added: result.added,
            updated: result.updated,
            kept: result.kept,
            total: result.total,
          },
        }
      } else {
        const count = await importHistory(file, onProgress)
        successStatus = {
          key: count === 1 ? 'historyImportedOne' : 'historyImported',
          params: { count },
        }
      }
      setStatus(successStatus)
      showToast(successStatus)
    } catch (error) {
      const failed = errorStatus('historyImportReasonFailed', error)
      setStatus(failed)
      showToast({
        type: 'error',
        key: 'historyImportReasonFailed',
        params: {
          message:
            error instanceof BackupError
              ? translate(error.key)
              : error instanceof Error
                ? error.message
                : String(error),
        },
      })
    } finally {
      importing.current = false
      setBusy(false)
    }
  }

  return { file, busy, status, select: setFile, cancel: () => setFile(null), confirm }
}

/** 历史导入入口：merge 仅追加与更新且绝不删旧档；replace 为全量覆盖替换。 */
const ImportHistory = ({
  mode,
  historyImport,
  disabled,
}: {
  mode: 'merge' | 'replace'
  historyImport: ReturnType<typeof useHistoryImport>
  disabled: boolean
}) => {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement>(null)
  const isMerge = mode === 'merge'

  return (
    <SettingCell
      label={t(isMerge ? 'historyMergeImport' : 'historyImport')}
      description={t(isMerge ? 'historyMergeImportDescription' : 'historyImportDescription')}
      status={historyImport.status}
      action={
        <>
          <Button
            variant="outlined"
            size="m"
            className={clsx(styles.cellButton, styles.uploadButton)}
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            <IconUploadOutline14 />
            {t(
              historyImport.busy
                ? 'historyImportingButton'
                : isMerge
                  ? 'historyMergeImportButton'
                  : 'upload'
            )}
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip,application/x-zip-compressed"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) {
                historyImport.select(file)
              }
            }}
          />
        </>
      }
    />
  )
}

/** 将全部会话及图片导出为 ZIP 文件并下载 */
const ExportHistory = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const empty = useChatStore((state) => state.sessions.length === 0)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const onExport = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const { name, blob } = await exportHistory()
      const dest = await saveDownloadedBlob(blob, name)
      setStatus(
        dest === 'android'
          ? { key: 'historyExportSavedAndroid', params: { name } }
          : { key: 'historyExportSaved', params: { name } }
      )
    } catch (error) {
      setStatus(errorStatus('historyExportFailed', error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingCell
      label={t('exportAllLabel')}
      description={t('historyExportDescription')}
      status={status}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || busy || empty}
          onClick={() => void onExport()}
        >
          <IconDownloadOutline16 />
          {t('exportAllDownload')}
        </Button>
      }
    />
  )
}

const formatByteSize = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 展示本地数据库各表条数、持久化权限与 Android 原生备份数量，支持一键自愈修复。 */
const StorageHealthSetting = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const [mergingStaging, setMergingStaging] = useState(false)
  const [stagingCounts, setStagingCounts] = useState({ sessions: 0, files: 0 })
  const [status, setStatus] = useState<Status>(null)
  const [stagingStatus, setStagingStatus] = useState<Status>(null)
  const mountedRef = useRef(true)
  const prevDisabledRef = useRef(disabled)
  const mergingStagingRef = useRef(false)
  mergingStagingRef.current = mergingStaging

  const runCheck = async (notify: boolean) => {
    setBusy(true)
    try {
      const report = await inspectAndRepairStorage()
      if (!mountedRef.current) {
        return
      }
      setStagingCounts({ sessions: report.stagingCount, files: report.filesStagingCount })
      const recovered = report.repairedCount + report.restoredFromNativeCount
      const nativePart = report.nativeBackupAvailable
        ? translate('storageHealthNativePart', {
            count: report.nativeBackupCount,
            size: formatByteSize(report.nativeBackupBytes),
          })
        : ''
      const persistPart =
        report.persisted === null
          ? ''
          : translate(report.persisted ? 'storageHealthPersistOn' : 'storageHealthPersistOff')
      const xrayFolders = report.nativeXray
        ? [...report.nativeXray.folders]
            .sort((a, b) => b.bytes - a.bytes)
            .slice(0, 4)
            .map((item) => `${item.name}=${formatByteSize(item.bytes)}`)
            .join(', ')
        : ''
      const xrayIdb = report.nativeXray?.idbFolders.length
        ? ` | IDB: ${report.nativeXray.idbFolders
            .map((item) => `${item.name}=${formatByteSize(item.bytes)}(${item.files})`)
            .join(', ')}`
        : ''
      const xrayPart =
        report.webUsageBytes !== null || report.idbDatabases.length > 0 || report.nativeXray
          ? translate('storageHealthXrayPart', {
              web:
                report.webUsageBytes !== null
                  ? `Web≈${formatByteSize(report.webUsageBytes)} `
                  : '',
              dbs: report.idbDatabases.length > 0 ? `DB=[${report.idbDatabases.join(',')}] ` : '',
              dirs: report.nativeXray
                ? `Data=${formatByteSize(report.nativeXray.totalDataBytes)}(${xrayFolders})${xrayIdb}`
                : '',
            })
          : ''
      const summaryStatus = {
        key: 'storageHealthSummary' as const,
        params: {
          sessions: report.sessionsCount,
          summaries: report.summariesCount,
          files: report.filesCount,
          filesSize: formatByteSize(report.filesBytes),
          staging: report.stagingCount,
          filesStaging: report.filesStagingCount,
          native: nativePart,
          persist: persistPart,
          xray: xrayPart,
        },
      }
      setStatus(summaryStatus)
      if (recovered > 0) {
        showToast({ key: 'storageHealthRecovered', params: { count: recovered } })
      } else if (notify) {
        showToast(summaryStatus)
      }
    } catch (error) {
      if (mountedRef.current) {
        setStatus(errorStatus('storageHealthCheckFailed', error))
      }
    } finally {
      if (mountedRef.current) {
        setBusy(false)
      }
    }
  }

  const onMergeStaging = async () => {
    setMergingStaging(true)
    setStagingStatus(null)
    try {
      const result = await mergePendingStaging()
      const mergedStatus: Status = {
        key: 'historyMerged',
        params: {
          added: result.added,
          updated: result.updated,
          kept: result.kept,
          total: result.total,
        },
      }
      showToast(mergedStatus)
      if (!mountedRef.current) {
        return
      }
      setStagingStatus(mergedStatus)
      await runCheck(false)
    } catch (error) {
      if (mountedRef.current) {
        setStagingStatus(errorStatus('historyImportReasonFailed', error))
      }
    } finally {
      if (mountedRef.current) {
        setMergingStaging(false)
      }
    }
  }

  useEffect(() => {
    mountedRef.current = true
    if (!prevDisabledRef.current) {
      void runCheck(false)
    }
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    const wasDisabled = prevDisabledRef.current
    prevDisabledRef.current = disabled
    if (wasDisabled && !disabled && !mergingStagingRef.current) {
      void runCheck(false)
    }
  }, [disabled])

  return (
    <>
      <SettingCell
        label={t('storageHealthLabel')}
        description={t('storageHealthDescription')}
        status={status}
        action={
          <Button
            variant="outlined"
            size="m"
            className={styles.cellButton}
            disabled={disabled || busy || mergingStaging}
            onClick={() => void runCheck(true)}
          >
            {t(busy ? 'storageHealthCheckingButton' : 'storageHealthCheckButton')}
          </Button>
        }
      />
      {stagingCounts.sessions > 0 || stagingCounts.files > 0 ? (
        <SettingCell
          label={t('stagingMergeLabel', { count: stagingCounts.sessions })}
          description={t('stagingMergeDescription')}
          status={stagingStatus}
          action={
            <Button
              variant="primary"
              size="m"
              className={styles.cellButton}
              disabled={disabled || busy || mergingStaging}
              onClick={() => void onMergeStaging()}
            >
              {t(mergingStaging ? 'stagingMergingButton' : 'stagingMergeButton')}
            </Button>
          }
        />
      ) : null}
    </>
  )
}

/** 将 Android WebView 底层 IndexedDB 原始文件导出为 ZIP 到下载目录（不含 Local Storage / API Key）。 */
const RawIndexedDbExport = ({ disabled }: { disabled: boolean }) => {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status>(null)

  const onExportRaw = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const result = await exportRawIndexedDB()
      const savedStatus: Status = {
        key: result.mode === 'picker' ? 'exportRawIdbSavedPicker' : 'exportRawIdbSavedAndroid',
        params: { name: result.fileName, size: formatByteSize(result.bytes) },
      }
      setStatus(savedStatus)
      showToast(savedStatus)
    } catch (error) {
      const failed = errorStatus('exportRawIdbFailed', error)
      setStatus(failed)
      showToast({
        type: 'error',
        key: 'exportRawIdbFailed',
        params: { message: error instanceof Error ? error.message : String(error) },
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingCell
      label={t('exportRawIdbLabel')}
      description={t('exportRawIdbDescription')}
      status={status}
      action={
        <Button
          variant="outlined"
          size="m"
          className={styles.cellButton}
          disabled={disabled || busy}
          onClick={() => void onExportRaw()}
        >
          <IconDownloadOutline16 />
          {t(busy ? 'exportRawIdbExportingButton' : 'exportRawIdbButton')}
        </Button>
      }
    />
  )
}
