import { translate, type TranslationMessage } from '../../i18n/index.js'
import { fetchWithDevProxy, getApiOrigin } from './origin.js'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents } from './sse.js'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
  MessageUsage,
  StopReason,
  WebSearchResult,
} from './types.js'
import { executeCustomWebSearch, type CustomWebSearchConfig } from './webSearch.js'

const MAX_ANTHROPIC_SEARCH_ROUNDS = 4

const ANTHROPIC_WEB_SEARCH_TOOL = {
  name: 'web_search',
  description:
    'Search the web for up-to-date facts, news, or documentation. Returns titles, URLs, and snippets.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Concise search query keywords',
      },
    },
    required: ['query'],
  },
}

const extractAnthropicQuery = (input: Record<string, unknown>, rawJson: string): string => {
  for (const key of ['query', 'q', 'keywords', 'keyword', 'search_query']) {
    if (typeof input[key] === 'string' && input[key].trim()) {
      return input[key].trim()
    }
  }
  if (rawJson.trim()) {
    try {
      const parsed: unknown = JSON.parse(rawJson)
      if (typeof parsed === 'object' && parsed !== null) {
        const obj = parsed as Record<string, unknown>
        for (const key of ['query', 'q', 'keywords', 'keyword', 'search_query']) {
          if (typeof obj[key] === 'string' && obj[key].trim()) {
            return obj[key].trim()
          }
        }
      }
    } catch {
      // 忽略无效 JSON，回退原始文本
    }
    return rawJson.trim()
  }
  return ''
}

/** Anthropic 兼容接口的前缀 */
const anthropicBaseUrl = () => `${getApiOrigin()}/anthropic/v1`
/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status)
}

export const request = async (url: string, init: RequestInit): Promise<Response> => {
  let response: Response
  try {
    response = await fetchWithDevProxy(url, init)
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw await readErrorResponse(response)
  }
  return response
}

const anthropicHeaders = (apiKey: string, beta: boolean): Record<string, string> => ({
  // DeepSeek 兼容接口的鉴权方式，也可使用 Authorization: Bearer。
  'x-api-key': apiKey,
  // Files API 和通过 file_id 引用图片时必传；纯文本聊天无需携带。
  ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
})

/** 用 GET /models 校验 API Key（不产生费用） */
export const verifyApiKey = async (apiKey: string, signal?: AbortSignal): Promise<void> => {
  await request(`${getApiOrigin()}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
}

/**
 * POST /anthropic/v1/files 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  const response = await request(`${anthropicBaseUrl()}/files`, {
    method: 'POST',
    headers: anthropicHeaders(apiKey, true),
    body: form,
    signal,
  })
  return (await response.json()) as FileObject
}

/** DELETE /anthropic/v1/files/{file_id} */
export const deleteFile = async (apiKey: string, fileId: string): Promise<void> => {
  await request(`${anthropicBaseUrl()}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: anthropicHeaders(apiKey, true),
  })
}

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
  )

/**
 * POST /anthropic/v1/messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 * 若传入 customWebSearch，则在原生 Anthropic 协议下自动注册 web_search 工具并支持多轮 tool_use 自主搜索。
 */
export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal,
  customWebSearch?: CustomWebSearchConfig
): AsyncGenerator<MessageStreamEvent> {
  if (!customWebSearch?.endpoint.trim()) {
    const response = await request(`${anthropicBaseUrl()}/messages`, {
      method: 'POST',
      headers: {
        ...anthropicHeaders(apiKey, hasFile(body)),
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    })
    const contentType = response.headers.get('Content-Type') ?? ''
    if (!response.body || !contentType.includes('text/event-stream')) {
      throw await readErrorResponse(response, 'protocol', '')
    }
    for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
      let payload: unknown
      try {
        payload = JSON.parse(data)
      } catch {
        if (eventName !== 'error') {
          continue
        }
      }
      if (isErrorBody(payload)) {
        throw new ApiError('stream', payload.error.message)
      }
      if (eventName === 'error') {
        throw new ApiError('stream', data)
      }
      const event = readMessageEvent(payload)
      if (!event) {
        continue
      }
      yield event
      if (event.type === 'message_stop') {
        return
      }
    }
    // 服务端没有提供错误内容时保持为空，不推测断流原因。
    throw new ApiError('interrupted', '')
  }

  const baseMessages: unknown[] = [...body.messages]
  const baseTools = body.tools ?? []
  const needFileBeta = hasFile(body)
  let started = false
  let nextBlockIndex = 0
  let lastStopReason: StopReason = 'end_turn'
  let lastUsage: MessageUsage | undefined
  let lastTitle: string | undefined

  for (let round = 0; round <= MAX_ANTHROPIC_SEARCH_ROUNDS; round += 1) {
    const enableToolThisRound = round < MAX_ANTHROPIC_SEARCH_ROUNDS
    const roundTools = enableToolThisRound ? [...baseTools, ANTHROPIC_WEB_SEARCH_TOOL] : baseTools
    const roundBody = {
      ...body,
      messages: baseMessages,
      ...(roundTools.length > 0 ? { tools: roundTools } : { tools: undefined }),
      stream: true,
    }
    const response = await request(`${anthropicBaseUrl()}/messages`, {
      method: 'POST',
      headers: {
        ...anthropicHeaders(apiKey, needFileBeta),
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(roundBody),
      signal,
    })
    const contentType = response.headers.get('Content-Type') ?? ''
    if (!response.body || !contentType.includes('text/event-stream')) {
      throw await readErrorResponse(response, 'protocol', '')
    }

    const indexMap = new Map<number, number>()
    const rawAssistantBlocks: Record<string, unknown>[] = []
    const pendingBlocks = new Map<
      number,
      | { kind: 'text'; text: string }
      | { kind: 'thinking'; thinking: string; signature: string }
      | { kind: 'tool_use'; id: string; name: string; input: Record<string, unknown>; partialJson: string }
    >()
    let roundFinished = false
    let roundStopReason: StopReason = 'end_turn'

    for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
      let payload: unknown
      try {
        payload = JSON.parse(data)
      } catch {
        if (eventName !== 'error') {
          continue
        }
      }
      if (isErrorBody(payload)) {
        throw new ApiError('stream', payload.error.message)
      }
      if (eventName === 'error') {
        throw new ApiError('stream', data)
      }
      const event = readMessageEvent(payload)
      if (!event) {
        continue
      }
      if (event.type === 'message_start') {
        if (!started) {
          started = true
          yield event
        }
        if (event.message.usage) {
          lastUsage = event.message.usage
        }
        continue
      }
      if (event.type === 'content_block_start') {
        const block = event.content_block
        if (block.type === 'tool_use') {
          pendingBlocks.set(event.index, {
            kind: 'tool_use',
            id: block.id,
            name: block.name,
            input:
              block.input && typeof block.input === 'object'
                ? (block.input as Record<string, unknown>)
                : {},
            partialJson: '',
          })
          continue
        }
        if (block.type === 'text') {
          pendingBlocks.set(event.index, { kind: 'text', text: block.text })
        } else if (block.type === 'thinking') {
          pendingBlocks.set(event.index, {
            kind: 'thinking',
            thinking: block.thinking,
            signature: block.signature ?? '',
          })
        }
        const outIdx = nextBlockIndex++
        indexMap.set(event.index, outIdx)
        yield { ...event, index: outIdx }
        continue
      }
      if (event.type === 'content_block_delta') {
        const tracked = pendingBlocks.get(event.index)
        if (tracked?.kind === 'tool_use') {
          if (event.delta.type === 'input_json_delta') {
            tracked.partialJson += event.delta.partial_json
          }
          continue
        }
        if (tracked?.kind === 'text' && event.delta.type === 'text_delta') {
          tracked.text += event.delta.text
        } else if (tracked?.kind === 'thinking') {
          if (event.delta.type === 'thinking_delta') {
            tracked.thinking += event.delta.thinking
          } else if (event.delta.type === 'signature_delta') {
            tracked.signature += event.delta.signature
          }
        }
        const outIdx = indexMap.get(event.index)
        if (outIdx !== undefined) {
          yield { ...event, index: outIdx }
        }
        continue
      }
      if (event.type === 'content_block_stop') {
        const tracked = pendingBlocks.get(event.index)
        if (tracked) {
          if (tracked.kind === 'text') {
            rawAssistantBlocks.push({ type: 'text', text: tracked.text })
          } else if (tracked.kind === 'thinking') {
            rawAssistantBlocks.push({
              type: 'thinking',
              thinking: tracked.thinking,
              ...(tracked.signature ? { signature: tracked.signature } : {}),
            })
          } else if (tracked.kind === 'tool_use') {
            let finalInput = tracked.input
            if (tracked.partialJson.trim()) {
              try {
                const parsed: unknown = JSON.parse(tracked.partialJson)
                if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                  finalInput = parsed as Record<string, unknown>
                }
              } catch {
                // 保留原始 input
              }
            }
            rawAssistantBlocks.push({
              type: 'tool_use',
              id: tracked.id,
              name: tracked.name,
              input: finalInput,
            })
          }
        }
        const outIdx = indexMap.get(event.index)
        if (outIdx !== undefined) {
          yield { type: 'content_block_stop', index: outIdx }
        }
        continue
      }
      if (event.type === 'message_delta') {
        roundStopReason = event.delta.stop_reason
        lastStopReason = event.delta.stop_reason
        if (event.delta.title) {
          lastTitle = event.delta.title
        }
        if (event.usage) {
          lastUsage = event.usage
        }
        continue
      }
      if (event.type === 'message_stop') {
        roundFinished = true
        break
      }
    }

    if (!roundFinished) {
      throw new ApiError('interrupted', '')
    }

    const searchCalls = [...pendingBlocks.values()].filter(
      (item): item is { kind: 'tool_use'; id: string; name: string; input: Record<string, unknown>; partialJson: string } =>
        item.kind === 'tool_use' && item.name === 'web_search'
    )
    if (roundStopReason !== 'tool_use' || searchCalls.length === 0 || round >= MAX_ANTHROPIC_SEARCH_ROUNDS) {
      break
    }

    const queries = searchCalls
      .map((call) => extractAnthropicQuery(call.input, call.partialJson))
      .filter((q) => q.length > 0)
    const toolUseId = `custom_search_${Date.now()}_${round}`
    const useBlockIndex = nextBlockIndex++
    yield {
      type: 'content_block_start',
      index: useBlockIndex,
      content_block: {
        type: 'server_tool_use',
        id: toolUseId,
        name: 'deepseek_web_search',
        input: { action: 'search', queries: queries.length > 0 ? queries : ['web search'] },
        caller: { type: 'direct' },
        kind: 'deep_search',
      },
    }
    yield { type: 'content_block_stop', index: useBlockIndex }

    const outcomes = await Promise.all(
      searchCalls.map(async (call) => {
        const query = extractAnthropicQuery(call.input, call.partialJson)
        try {
          const res = await executeCustomWebSearch(query, customWebSearch, signal)
          return { call, results: res.results, output: res.toolOutputText, failed: false }
        } catch (err) {
          signal.throwIfAborted()
          const msg = err instanceof Error ? err.message : String(err)
          return { call, results: [] as WebSearchResult[], output: `Search error: ${msg}`, failed: true }
        }
      })
    )

    const mergedResults: WebSearchResult[] = []
    const seenUrls = new Set<string>()
    for (const outcome of outcomes) {
      for (const item of outcome.results) {
        if (item.url && seenUrls.has(item.url)) {
          continue
        }
        if (item.url) {
          seenUrls.add(item.url)
        }
        mergedResults.push(item)
      }
    }
    const allFailed = outcomes.every((item) => item.failed)
    const resultBlockIndex = nextBlockIndex++
    yield {
      type: 'content_block_start',
      index: resultBlockIndex,
      content_block: {
        type: 'web_search_tool_result',
        tool_use_id: toolUseId,
        kind: 'deep_search',
        content:
          mergedResults.length > 0
            ? mergedResults
            : allFailed
              ? [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }]
              : [],
      },
    }
    yield { type: 'content_block_stop', index: resultBlockIndex }

    baseMessages.push(
      { role: 'assistant', content: rawAssistantBlocks },
      {
        role: 'user',
        content: outcomes.map((outcome) => ({
          type: 'tool_result',
          tool_use_id: outcome.call.id,
          content: outcome.output,
          ...(outcome.failed ? { is_error: true } : {}),
        })),
      }
    )
  }

  yield {
    type: 'message_delta',
    delta: {
      stop_reason: lastStopReason === 'tool_use' ? 'end_turn' : lastStopReason,
      stop_sequence: null,
      ...(lastTitle ? { title: lastTitle } : {}),
    },
    ...(lastUsage ? { usage: lastUsage } : {}),
  }
  yield { type: 'message_stop' }
}
