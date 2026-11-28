import { getAndroidProxyOrigin, getAndroidProxyToken } from '../api/origin.js'
import * as db from './db.js'
import type { Session } from './types.js'

const SAFE_SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/
const BACKUP_DEBOUNCE_MS = 2000

export type NativeBackupSummary = {
  sessions: string[]
  totalBytes: number
}

export type NativeStorageFolderStat = {
  name: string
  bytes: number
  files: number
}

export type NativeStorageXray = {
  totalDataBytes: number
  folders: NativeStorageFolderStat[]
  idbFolders: NativeStorageFolderStat[]
}

export type RawIdbExportResult = {
  mode: 'android' | 'picker'
  fileName: string
  bytes: number
}

const getBackupConfig = (): { origin: string; token: string } | null => {
  const origin = getAndroidProxyOrigin()
  const token = getAndroidProxyToken()
  return origin && token ? { origin, token } : null
}

export const isNativeBackupAvailable = (): boolean => getBackupConfig() !== null

const requestBackup = async (path: string, init: RequestInit = {}): Promise<Response | null> => {
  const config = getBackupConfig()
  if (!config) {
    return null
  }
  const headers = new Headers(init.headers)
  headers.set('X-Proxy-Token', config.token)
  return fetch(`${config.origin}${path}`, { ...init, headers })
}

export const listNativeBackup = async (): Promise<NativeBackupSummary | null> => {
  if (!isNativeBackupAvailable()) {
    return null
  }
  try {
    const response = await requestBackup('/__deepchat_backup/list', { method: 'GET' })
    if (!response?.ok) {
      return null
    }
    const data = (await response.json()) as Partial<NativeBackupSummary>
    const sessions = Array.isArray(data.sessions)
      ? data.sessions.filter((id): id is string => typeof id === 'string' && SAFE_SESSION_ID_RE.test(id))
      : []
    const totalBytes =
      typeof data.totalBytes === 'number' && Number.isFinite(data.totalBytes)
        ? Math.max(0, data.totalBytes)
        : 0
    return { sessions, totalBytes }
  } catch {
    return null
  }
}

export const loadNativeBackupSession = async (id: string): Promise<Session | null> => {
  if (!isNativeBackupAvailable() || !SAFE_SESSION_ID_RE.test(id)) {
    return null
  }
  try {
    const response = await requestBackup(
      `/__deepchat_backup/session?id=${encodeURIComponent(id)}`,
      { method: 'GET' }
    )
    if (!response?.ok) {
      return null
    }
    const data = (await response.json()) as Partial<Session>
    if (
      !data ||
      typeof data.id !== 'string' ||
      data.id !== id ||
      !Array.isArray(data.messages) ||
      typeof data.createdAt !== 'number' ||
      typeof data.updatedAt !== 'number'
    ) {
      return null
    }
    return data as Session
  } catch {
    return null
  }
}

const uploadBackupSession = async (session: Session): Promise<void> => {
  if (!SAFE_SESSION_ID_RE.test(session.id)) {
    return
  }
  const response = await requestBackup(
    `/__deepchat_backup/session?id=${encodeURIComponent(session.id)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(session),
    }
  )
  if (response && !response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
}

const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()
const pendingSessions = new Map<string, Session>()
const sessionQueues = new Map<string, Promise<void>>()
let backupEpoch = 0
let syncPromise: Promise<number> | null = null
let syncRescanRequested = false
let syncShouldSkip: (id: string) => boolean = () => false

const enqueueSessionOp = (id: string, task: () => Promise<void>): Promise<void> => {
  const prev = sessionQueues.get(id) ?? Promise.resolve()
  const next = prev
    .catch(() => {})
    .then(task)
    .finally(() => {
      if (sessionQueues.get(id) === next) {
        sessionQueues.delete(id)
      }
    })
  sessionQueues.set(id, next)
  return next
}

const flushSingleBackup = (id: string) => {
  const timer = pendingTimers.get(id)
  if (timer !== undefined) {
    clearTimeout(timer)
    pendingTimers.delete(id)
  }
  const session = pendingSessions.get(id)
  if (!session) {
    return
  }
  pendingSessions.delete(id)
  const epoch = backupEpoch
  void enqueueSessionOp(id, async () => {
    if (epoch !== backupEpoch) {
      return
    }
    await uploadBackupSession(session).catch(() => {})
  })
}

/** 安排将单个会话同步镜像到 Android 原生私有目录（防抖合并连续更新，避免阻塞界面）。 */
export const scheduleNativeSessionBackup = (session: Session) => {
  if (!isNativeBackupAvailable() || !SAFE_SESSION_ID_RE.test(session.id)) {
    return
  }
  pendingSessions.set(session.id, session)
  const existingTimer = pendingTimers.get(session.id)
  if (existingTimer !== undefined) {
    clearTimeout(existingTimer)
    pendingTimers.delete(session.id)
  }
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    flushSingleBackup(session.id)
    return
  }
  const timer = setTimeout(() => {
    pendingTimers.delete(session.id)
    const runFlush = () => flushSingleBackup(session.id)
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(runFlush, { timeout: 3000 })
    } else {
      runFlush()
    }
  }, BACKUP_DEBOUNCE_MS)
  pendingTimers.set(session.id, timer)
}

/** 切后台或离开前立即把所有待写入的镜像会话落盘。 */
export const flushNativeSessionBackups = () => {
  if (!isNativeBackupAvailable()) {
    return
  }
  for (const id of [...pendingSessions.keys()]) {
    flushSingleBackup(id)
  }
}

/** 删除单个会话对应的原生镜像文件。 */
export const removeNativeSessionBackup = async (id: string): Promise<void> => {
  if (!isNativeBackupAvailable() || !SAFE_SESSION_ID_RE.test(id)) {
    return
  }
  const timer = pendingTimers.get(id)
  if (timer !== undefined) {
    clearTimeout(timer)
    pendingTimers.delete(id)
  }
  pendingSessions.delete(id)
  const epoch = backupEpoch
  await enqueueSessionOp(id, async () => {
    if (epoch !== backupEpoch) {
      return
    }
    await requestBackup(`/__deepchat_backup/session?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }).catch(() => {})
  })
}

/** 清空全部原生镜像文件（仅在用户主动导入覆盖或清空全部历史后调用）。 */
export const clearNativeBackup = async (): Promise<void> => {
  backupEpoch += 1
  for (const timer of pendingTimers.values()) {
    clearTimeout(timer)
  }
  pendingTimers.clear()
  pendingSessions.clear()
  if (syncPromise) {
    await syncPromise.catch(() => {})
  }
  await Promise.allSettled([...sessionQueues.values()])
  if (!isNativeBackupAvailable()) {
    return
  }
  await requestBackup('/__deepchat_backup/clear', { method: 'POST' }).catch(() => {})
}

/** 启动或体检时：如果 Android 原生目录里有 IndexedDB 缺失的会话，逐条安全恢复到 IndexedDB。 */
export const restoreMissingFromNativeBackup = async (options?: {
  shouldSkip?: (id: string) => boolean
  shouldAbort?: () => boolean
}): Promise<{
  restored: number
  nativeCount: number
  totalBytes: number
}> => {
  const shouldSkip = options?.shouldSkip ?? (() => false)
  const shouldAbort = options?.shouldAbort ?? (() => false)
  const nativeSummary = await listNativeBackup()
  if (!nativeSummary || nativeSummary.sessions.length === 0 || shouldAbort()) {
    return {
      restored: 0,
      nativeCount: nativeSummary?.sessions.length ?? 0,
      totalBytes: nativeSummary?.totalBytes ?? 0,
    }
  }
  const existingIds = new Set(await db.listSessionIds())
  const missing = nativeSummary.sessions.filter((id) => !existingIds.has(id))
  let restored = 0
  for (const id of missing) {
    if (shouldAbort()) {
      break
    }
    if (shouldSkip(id)) {
      continue
    }
    const session = await loadNativeBackupSession(id)
    if (!session || shouldAbort() || shouldSkip(id)) {
      continue
    }
    try {
      await db.saveSession(session)
      restored += 1
    } catch (error) {
      db.reportStorageError('restore session from native backup')(error)
    }
  }
  return {
    restored,
    nativeCount: nativeSummary.sessions.length,
    totalBytes: nativeSummary.totalBytes,
  }
}

/** 后台将尚未备份的 IndexedDB 会话逐条补齐到 Android 原生镜像目录。 */
export const syncMissingToNativeBackup = (
  shouldSkip: (id: string) => boolean = () => false
): Promise<number> => {
  if (!isNativeBackupAvailable()) {
    return Promise.resolve(0)
  }
  syncShouldSkip = shouldSkip
  if (syncPromise) {
    syncRescanRequested = true
    return syncPromise
  }
  const epoch = backupEpoch
  syncRescanRequested = false
  syncPromise = (async () => {
    try {
      let synced = 0
      do {
        syncRescanRequested = false
        const [nativeSummary, localIds] = await Promise.all([
          listNativeBackup(),
          db.listSessionIds(),
        ])
        if (!nativeSummary || epoch !== backupEpoch) {
          return synced
        }
        const backedUp = new Set(nativeSummary.sessions)
        const missing = localIds.filter((id) => !backedUp.has(id) && SAFE_SESSION_ID_RE.test(id))
        for (const id of missing) {
          if (epoch !== backupEpoch) {
            return synced
          }
          if (syncShouldSkip(id)) {
            continue
          }
          const session = await db.loadSession(id).catch(() => undefined)
          if (!session || epoch !== backupEpoch || syncShouldSkip(id)) {
            continue
          }
          let uploaded = false
          await enqueueSessionOp(id, async () => {
            if (epoch !== backupEpoch || syncShouldSkip(id)) {
              return
            }
            try {
              await uploadBackupSession(session)
              uploaded = true
            } catch {
              // 忽略单条上传失败，下次启动会重试补齐
            }
          })
          if (uploaded) {
            synced += 1
          }
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      } while (syncRescanRequested && epoch === backupEpoch)
      return synced
    } finally {
      syncRescanRequested = false
      syncPromise = null
    }
  })()
  return syncPromise
}

/** 将已更新的会话重新覆盖上传到 Android 原生镜像目录（例如合并导入更新了同 ID 会话）。 */
export const refreshNativeSessionBackups = async (
  ids: readonly string[],
  shouldSkip: (id: string) => boolean = () => false
): Promise<number> => {
  if (!isNativeBackupAvailable() || ids.length === 0) {
    return 0
  }
  const epoch = backupEpoch
  let synced = 0
  for (const id of ids) {
    if (epoch !== backupEpoch) {
      break
    }
    if (!SAFE_SESSION_ID_RE.test(id) || shouldSkip(id)) {
      continue
    }
    const session = await db.loadSession(id).catch(() => undefined)
    if (!session || epoch !== backupEpoch || shouldSkip(id)) {
      continue
    }
    let uploaded = false
    await enqueueSessionOp(id, async () => {
      if (epoch !== backupEpoch || shouldSkip(id)) {
        return
      }
      try {
        await uploadBackupSession(session)
        uploaded = true
      } catch {
        // 忽略单条上传失败
      }
    })
    if (uploaded) {
      synced += 1
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return synced
}

/** 透视 Android 应用私有数据目录与 WebView IndexedDB 子目录实际磁盘占用（只读，无需 Root）。 */
export const getNativeStorageXray = async (): Promise<NativeStorageXray | null> => {
  if (!isNativeBackupAvailable()) {
    return null
  }
  try {
    const response = await requestBackup('/__deepchat_backup/xray', { method: 'GET' })
    if (!response?.ok) {
      return null
    }
    const data = (await response.json()) as Partial<NativeStorageXray>
    const parseList = (list: unknown): NativeStorageFolderStat[] =>
      Array.isArray(list)
        ? list.flatMap((item) => {
            if (!item || typeof item !== 'object') {
              return []
            }
            const entry = item as Partial<NativeStorageFolderStat>
            if (typeof entry.name !== 'string' || typeof entry.bytes !== 'number') {
              return []
            }
            return [
              {
                name: entry.name,
                bytes: Math.max(0, entry.bytes),
                files: typeof entry.files === 'number' ? Math.max(0, entry.files) : 0,
              },
            ]
          })
        : []
    return {
      totalDataBytes:
        typeof data.totalDataBytes === 'number' && Number.isFinite(data.totalDataBytes)
          ? Math.max(0, data.totalDataBytes)
          : 0,
      folders: parseList(data.folders),
      idbFolders: parseList(data.idbFolders),
    }
  } catch {
    return null
  }
}

/** 将 Android WebView 的底层 IndexedDB 原始文件打包保存到下载目录（不含 Local Storage / API Key）。 */
export const exportRawIndexedDBSnapshot = async (): Promise<RawIdbExportResult> => {
  if (!isNativeBackupAvailable()) {
    throw new Error('Native backup bridge is unavailable')
  }
  const response = await requestBackup('/__deepchat_backup/export_raw_idb', { method: 'POST' })
  if (!response) {
    throw new Error('Native backup bridge is unavailable')
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || `HTTP ${response.status}`)
  }
  const data = (await response.json()) as Partial<RawIdbExportResult>
  return {
    mode: data.mode === 'picker' ? 'picker' : 'android',
    fileName: typeof data.fileName === 'string' && data.fileName ? data.fileName : 'deepchat_raw_idb.zip',
    bytes: typeof data.bytes === 'number' && Number.isFinite(data.bytes) ? Math.max(0, data.bytes) : 0,
  }
}
