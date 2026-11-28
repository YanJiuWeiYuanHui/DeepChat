import {
  fetchWithDevProxy,
  getApiOrigin,
  joinApiPath,
  parseCustomHeaders,
  stripApiEndpointSuffix,
} from './origin.js'

const NON_CHAT_TYPES = new Set(['embedding', 'embeddings', 'video', 'videos', 'realtime', 'live', 'audio', 'speech', 'tts', 'asr', 'image', 'images'])

const extractEntryId = (item: unknown): { id: string; isNonChat: boolean } | null => {
  if (typeof item === 'string' && item.trim()) {
    return { id: item.trim(), isNonChat: false }
  }
  if (typeof item === 'object' && item !== null) {
    const entry = item as Record<string, unknown>
    const id =
      typeof entry.id === 'string'
        ? entry.id
        : typeof entry.name === 'string'
          ? entry.name.replace(/^models\//, '')
          : ''
    if (id.trim()) {
      const type = typeof entry.type === 'string' ? entry.type.trim().toLowerCase() : ''
      return { id: id.trim(), isNonChat: Boolean(type && NON_CHAT_TYPES.has(type)) }
    }
  }
  return null
}

const parseModelIds = (body: unknown, filterNonChat = false): string[] => {
  if (typeof body !== 'object' || body === null) {
    return []
  }
  const record = body as Record<string, unknown>
  const list = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : []
  const chatIds: string[] = []
  const allIds: string[] = []
  for (const item of list) {
    const extracted = extractEntryId(item)
    if (!extracted) {
      continue
    }
    allIds.push(extracted.id)
    if (!extracted.isNonChat) {
      chatIds.push(extracted.id)
    }
  }
  const preferred = filterNonChat && chatIds.length > 0 ? chatIds : allIds
  return [...new Set(preferred)].sort((a, b) => a.localeCompare(b))
}

/**
 * 从兼容服务的 /models 或 /v1/models 动态拉取可用模型列表。
 * 自动剥离误粘的末端路径并兼容 OpenCode Go / Zen、Ollama 等常见端点。
 */
export const fetchAvailableModels = async (
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal,
  customHeadersRaw = '',
  options: { filterNonChat?: boolean } = {}
): Promise<string[]> => {
  const origin = stripApiEndpointSuffix(baseUrl) || getApiOrigin()
  const rootOrigin = origin.replace(/\/v\d+(?:beta)?(?:\/openai)?$/i, '')
  const openCodeGoFallback = /opencode\.ai\/go(?:\/|$)/i.test(origin)
    ? ['https://opencode.ai/zen/go/v1/models']
    : []
  const candidates = [
    ...new Set([
      joinApiPath(origin, '/models'),
      `${origin}/models`,
      ...openCodeGoFallback,
      `${rootOrigin}/api/tags`,
    ]),
  ]
  const headers: Record<string, string> = {
    ...parseCustomHeaders(customHeadersRaw),
  }
  if (apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`
  }

  let lastError: Error | null = null
  let authError: Error | null = null
  for (const url of candidates) {
    try {
      const response = await fetchWithDevProxy(url, { method: 'GET', headers, signal })
      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText)
        let message = text || `HTTP ${response.status}`
        try {
          const errJson: unknown = JSON.parse(text)
          if (
            typeof errJson === 'object' &&
            errJson !== null &&
            typeof (errJson as { error?: { message?: unknown } }).error?.message === 'string'
          ) {
            message = (errJson as { error: { message: string } }).error.message
          }
        } catch {
          // 保留原文
        }
        const err = new Error(message)
        if ((response.status === 401 || response.status === 403) && !authError) {
          authError = err
        }
        lastError = err
        continue
      }
      const text = await response.text()
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        lastError = new Error('Non-JSON model response')
        continue
      }
      const ids = parseModelIds(json, options.filterNonChat === true)
      if (ids.length > 0) {
        return ids
      }
      lastError = new Error('Empty model list')
    } catch (error) {
      if (signal?.aborted) {
        throw error
      }
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }
  throw authError ?? lastError ?? new Error('Failed to fetch models')
}
