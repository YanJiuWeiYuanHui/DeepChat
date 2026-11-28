import { fetchWithDevProxy, parseCustomHeaders } from './origin.js'
import type { WebSearchResult } from './types.js'

export type CustomWebSearchConfig = {
  endpoint: string
  method: 'POST' | 'GET'
  apiKey: string
  queryParam: string
  maxResults: number
  customHeaders: string
}

const MAX_TOOL_OUTPUT_CHARS = 8000

const extractHostName = (url: string): string | null => {
  try {
    return new URL(url).hostname.replace(/^www\./i, '') || null
  } catch {
    return null
  }
}

const pickString = (obj: Record<string, unknown>, keys: readonly string[]): string => {
  for (const key of keys) {
    const val = obj[key]
    if (typeof val === 'string' && val.trim()) {
      return val.trim()
    }
  }
  return ''
}

const findResultArray = (payload: unknown): unknown[] => {
  if (Array.isArray(payload)) {
    return payload
  }
  if (typeof payload !== 'object' || payload === null) {
    return []
  }
  const obj = payload as Record<string, unknown>
  const directKeys = ['results', 'data', 'items', 'organic', 'organic_results', 'pages', 'hits']
  for (const key of directKeys) {
    const candidate = obj[key]
    if (Array.isArray(candidate)) {
      return candidate
    }
  }
  const nestedContainers = ['web', 'data', 'webPages', 'response', 'result']
  for (const containerKey of nestedContainers) {
    const nested = obj[containerKey]
    if (typeof nested === 'object' && nested !== null && !Array.isArray(nested)) {
      const found = findResultArray(nested)
      if (found.length > 0) {
        return found
      }
      const valueArr = (nested as Record<string, unknown>).value
      if (Array.isArray(valueArr)) {
        return valueArr
      }
    }
  }
  return []
}

const normalizeResults = (payload: unknown, limit: number): WebSearchResult[] => {
  const rawItems = findResultArray(payload)
  const results: WebSearchResult[] = []
  const seenUrls = new Set<string>()
  for (const item of rawItems) {
    if (results.length >= limit) {
      break
    }
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const rec = item as Record<string, unknown>
    const url = pickString(rec, ['url', 'link', 'href', 'uri'])
    const title = pickString(rec, ['title', 'name', 'heading']) || url
    const snippet = pickString(rec, [
      'snippet',
      'content',
      'description',
      'summary',
      'text',
      'body',
      'excerpt',
    ])
    if (!url && !snippet) {
      continue
    }
    const safeUrl = url && /^https?:\/\//i.test(url) ? url : ''
    if (safeUrl && seenUrls.has(safeUrl)) {
      continue
    }
    if (safeUrl) {
      seenUrls.add(safeUrl)
    }
    const siteName =
      pickString(rec, ['site_name', 'siteName', 'source', 'domain']) ||
      (safeUrl ? extractHostName(safeUrl) : null)
    const siteIcon = pickString(rec, ['site_icon', 'siteIcon', 'favicon', 'icon']) || null
    const pageAge =
      pickString(rec, ['page_age', 'published_date', 'publishedDate', 'date', 'datePublished']) ||
      null
    results.push({
      type: 'web_search_result',
      title: title || siteName || 'Result',
      url: safeUrl,
      snippet: snippet.slice(0, 600),
      site_icon: siteIcon,
      site_name: siteName,
      encrypted_content: '',
      page_age: pageAge,
    })
  }
  return results
}

const buildSearchRequest = (
  query: string,
  config: CustomWebSearchConfig
): { url: string; init: RequestInit } => {
  const endpoint = config.endpoint.trim()
  const paramName = config.queryParam.trim() || 'query'
  const headers: Record<string, string> = {
    ...parseCustomHeaders(config.customHeaders),
  }
  const hasAuthHeader = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization')
  if (config.apiKey.trim() && !hasAuthHeader) {
    headers.Authorization = `Bearer ${config.apiKey.trim()}`
  }

  if (config.method === 'GET') {
    let url = endpoint
    if (url.includes('{query}')) {
      url = url.replaceAll('{query}', encodeURIComponent(query))
    } else {
      const sep = url.includes('?') ? '&' : '?'
      url = `${url}${sep}${encodeURIComponent(paramName)}=${encodeURIComponent(query)}`
    }
    return {
      url,
      init: {
        method: 'GET',
        headers,
      },
    }
  }

  headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'
  const url = endpoint.includes('{query}')
    ? endpoint.replaceAll('{query}', encodeURIComponent(query))
    : endpoint
  const payload: Record<string, unknown> = {
    [paramName]: query,
    query,
    max_results: config.maxResults,
    count: config.maxResults,
  }
  return {
    url,
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    },
  }
}

export const formatSearchToolOutput = (query: string, results: WebSearchResult[]): string => {
  if (results.length === 0) {
    return `No search results found for "${query}".`
  }
  const blocks: string[] = []
  let total = 0
  results.forEach((item, index) => {
    const lines = [`[${index + 1}] ${item.title}`]
    if (item.url) {
      lines.push(`URL: ${item.url}`)
    }
    if (item.page_age) {
      lines.push(`Date: ${item.page_age}`)
    }
    if (item.snippet) {
      lines.push(`Snippet: ${item.snippet}`)
    }
    const block = lines.join('\n')
    if (total + block.length + 2 > MAX_TOOL_OUTPUT_CHARS && blocks.length > 0) {
      return
    }
    blocks.push(block)
    total += block.length + 2
  })
  return blocks.join('\n\n')
}

/**
 * 调用用户自定义的通用 HTTP 搜索端点，返回标准化搜索结果列表与喂给模型的工具输出文本。
 */
export const executeCustomWebSearch = async (
  query: string,
  config: CustomWebSearchConfig,
  signal?: AbortSignal
): Promise<{ results: WebSearchResult[]; toolOutputText: string }> => {
  const trimmedQuery = query.trim()
  if (!trimmedQuery || !config.endpoint.trim()) {
    return { results: [], toolOutputText: 'Empty search query or endpoint.' }
  }
  const { url, init } = buildSearchRequest(trimmedQuery, config)
  const response = await fetchWithDevProxy(url, { ...init, signal })
  const rawText = await response.text()
  if (!response.ok) {
    throw new Error(rawText.slice(0, 240) || `HTTP ${response.status}`)
  }
  const limit = Math.min(20, Math.max(1, Math.round(config.maxResults || 5)))
  try {
    const parsed: unknown = JSON.parse(rawText)
    const results = normalizeResults(parsed, limit)
    if (results.length > 0) {
      return { results, toolOutputText: formatSearchToolOutput(trimmedQuery, results) }
    }
    // 若端点返回了直接文本字段（如 answer / content / text）
    if (typeof parsed === 'object' && parsed !== null) {
      const directAnswer = pickString(parsed as Record<string, unknown>, [
        'answer',
        'summary',
        'content',
        'text',
        'result',
      ])
      if (directAnswer) {
        return { results: [], toolOutputText: directAnswer.slice(0, MAX_TOOL_OUTPUT_CHARS) }
      }
    }
    return {
      results: [],
      toolOutputText: rawText.trim().slice(0, MAX_TOOL_OUTPUT_CHARS) || 'No results found.',
    }
  } catch {
    return {
      results: [],
      toolOutputText: rawText.trim().slice(0, MAX_TOOL_OUTPUT_CHARS) || 'No results found.',
    }
  }
}
