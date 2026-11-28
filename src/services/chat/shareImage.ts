import { getAndroidProxyOrigin, getAndroidProxyToken } from '../api/origin.js'
import type { AssistantMessage, UserMessage } from './types.js'
import { buildReplyView, getAreaTitle } from './view.js'

export type ShareTurn = {
  id: string
  user?: UserMessage
  assistant?: AssistantMessage
}

/** 提取助手消息中适合转发的正文内容 */
export const extractAssistantShareText = (message: AssistantMessage): string => {
  const parts: string[] = []
  for (const block of message.blocks) {
    if (block.type === 'text' && !block.isTemplate && block.text.trim()) {
      parts.push(block.text.trim())
    } else if (block.type === 'image' && block.status === 'done') {
      parts.push(block.prompt ? `[图片：${block.prompt}]` : '[图片]')
    }
  }
  return parts.join('\n\n').trim()
}

export const extractUserShareText = (message: UserMessage): string => {
  const parts: string[] = []
  if (message.content.trim()) {
    parts.push(message.content.trim())
  }
  if (message.files.length > 0) {
    parts.push(message.files.map((f) => `[附件：${f.name}]`).join(' '))
  }
  return parts.join('\n').trim()
}

export const formatShareText = (title: string, turns: ShareTurn[]): string => {
  const sections: string[] = []
  if (title.trim()) {
    sections.push(`# ${title.trim()}`)
  }
  for (const turn of turns) {
    const userText = turn.user ? extractUserShareText(turn.user) : ''
    const assistantText = turn.assistant ? extractAssistantShareText(turn.assistant) : ''
    if (userText) {
      sections.push(`**我**：\n${userText}`)
    }
    if (assistantText) {
      sections.push(`**AI**：\n${assistantText}`)
    }
  }
  return sections.join('\n\n---\n\n')
}

type InlineRun = {
  text: string
  bold: boolean
  code?: boolean
}

type RenderLine =
  | { kind: 'blank'; height: number }
  | { kind: 'heading'; text: string }
  | { kind: 'code'; text: string; isFirst: boolean; isLast: boolean }
  | { kind: 'rich'; runs: InlineRun[]; indent: number }

/** 按字体缓存字符宽度，消除逐字调用 ctx.measureText 导致的 O(N²) 卡顿 */
const createTextMeasurer = (ctx: CanvasRenderingContext2D) => {
  const fontCaches = new Map<string, { cjkWidth: number; map: Map<string, number> }>()

  const getCache = (font: string) => {
    let entry = fontCaches.get(font)
    if (!entry) {
      ctx.font = font
      entry = {
        cjkWidth: ctx.measureText('中').width,
        map: new Map<string, number>(),
      }
      fontCaches.set(font, entry)
    }
    return entry
  }

  const charWidth = (ch: string, font: string): number => {
    const cache = getCache(font)
    const code = ch.charCodeAt(0)
    if (
      ch.length === 1 &&
      ((code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0x3000 && code <= 0x303f) ||
        (code >= 0xff00 && code <= 0xffef))
    ) {
      return cache.cjkWidth
    }
    const cached = cache.map.get(ch)
    if (cached !== undefined) {
      return cached
    }
    ctx.font = font
    const w = ctx.measureText(ch).width
    cache.map.set(ch, w)
    return w
  }

  const measureString = (text: string, font: string): number => {
    let sum = 0
    for (const ch of text) {
      sum += charWidth(ch, font)
    }
    return sum
  }

  const wrapPlain = (text: string, font: string, maxWidth: number): string[] => {
    if (!text) {
      return ['']
    }
    const lines: string[] = []
    let current = ''
    let width = 0
    for (const ch of text) {
      const w = charWidth(ch, font)
      if (width + w > maxWidth && current.length > 0) {
        lines.push(current)
        current = ch
        width = w
      } else {
        current += ch
        width += w
      }
    }
    if (current) {
      lines.push(current)
    }
    return lines
  }

  const wrapRichRuns = (
    runs: InlineRun[],
    normalFont: string,
    boldFont: string,
    codeFont: string,
    maxWidth: number
  ): InlineRun[][] => {
    const lines: InlineRun[][] = []
    let currentLine: InlineRun[] = []
    let lineWidth = 0

    const pushRunChar = (ch: string, bold: boolean, code: boolean) => {
      const last = currentLine[currentLine.length - 1]
      if (last && last.bold === bold && Boolean(last.code) === code) {
        last.text += ch
      } else {
        currentLine.push({ text: ch, bold, ...(code ? { code: true } : {}) })
      }
    }

    for (const run of runs) {
      const isCode = Boolean(run.code)
      const font = isCode ? codeFont : run.bold ? boldFont : normalFont
      for (const ch of run.text) {
        const w = charWidth(ch, font)
        if (lineWidth + w > maxWidth && currentLine.length > 0) {
          lines.push(currentLine)
          currentLine = []
          lineWidth = 0
        }
        pushRunChar(ch, run.bold, isCode)
        lineWidth += w
      }
    }
    if (currentLine.length > 0) {
      lines.push(currentLine)
    }
    return lines.length > 0 ? lines : [[{ text: '', bold: false }]]
  }

  return { measureString, wrapPlain, wrapRichRuns }
}

/** 解析行内 **加粗** 与 `行内代码`，保留真实排版层次 */
const parseInlineRuns = (raw: string): InlineRun[] => {
  const cleaned = raw.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
  const runs: InlineRun[] = []
  const tokenRe = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`)/g
  let lastIndex = 0
  for (const match of cleaned.matchAll(tokenRe)) {
    const idx = match.index ?? 0
    if (idx > lastIndex) {
      runs.push({ text: cleaned.slice(lastIndex, idx), bold: false })
    }
    const token = match[0]
    if (token.startsWith('`')) {
      runs.push({ text: token.slice(1, -1), bold: false, code: true })
    } else {
      runs.push({ text: token.slice(2, -2), bold: true })
    }
    lastIndex = idx + token.length
  }
  if (lastIndex < cleaned.length) {
    runs.push({ text: cleaned.slice(lastIndex), bold: false })
  }
  return runs.length > 0 ? runs : [{ text: cleaned, bold: false }]
}

const drawRoundedRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) => {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

/** 绘制顶部 DeepChat 品牌标志（风格对齐 DeepSeek 官方长图顶部蓝色标志） */
const drawBrandHeader = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  appName: string,
  brandColor: string,
  baseFont: string
) => {
  ctx.save()
  ctx.fillStyle = brandColor
  // 简洁圆润蓝鲸 / 气泡矢量标志
  drawRoundedRect(ctx, x, y + 2, 34, 34, 11)
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.arc(x + 12.5, y + 19, 3, 0, Math.PI * 2)
  ctx.arc(x + 21.5, y + 19, 3, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 2.4
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.arc(x + 17, y + 20.5, 7, 0.2 * Math.PI, 0.8 * Math.PI)
  ctx.stroke()

  ctx.fillStyle = brandColor
  ctx.font = `700 32px ${baseFont}`
  ctx.textBaseline = 'top'
  ctx.fillText(appName, x + 44, y + 1)
  ctx.restore()
}

/**
 * 仿 DeepSeek 官方长图排版：纯本地 Canvas 2D 高速渲染（O(N) 字符宽缓存 + 高清 JPEG 极速编码）
 */
export const renderTurnsToImageBlob = async ({
  turns,
  dark,
  appName,
  footerText,
  searchLabel,
}: {
  turns: ShareTurn[]
  dark: boolean
  appName: string
  footerText: string
  searchLabel: (count: number) => string
}): Promise<{ blob: Blob; mimeType: string; ext: string }> => {
  const width = 750
  const padX = 44
  const contentWidth = width - padX * 2
  const maxBubbleWidth = Math.round(contentWidth * 0.82)
  const MAX_CANVAS_HEIGHT = 12000

  const measureCanvas = document.createElement('canvas')
  const mctx = measureCanvas.getContext('2d')
  if (!mctx) {
    throw new Error('Canvas 2D unavailable')
  }
  const measurer = createTextMeasurer(mctx)

  const colors = dark
    ? {
        cardBg: '#181b23',
        divider: '#2a2f3d',
        title: '#f2f4f8',
        text: '#e4e8f0',
        muted: '#8d96aa',
        userBg: '#253352',
        userText: '#eef3ff',
        codeBg: '#12151d',
        codeText: '#cdd7f0',
        pillBg: '#212531',
        pillBorder: '#2f3545',
        brand: '#6c8cff',
      }
    : {
        cardBg: '#ffffff',
        divider: '#eceff4',
        title: '#181c26',
        text: '#222733',
        muted: '#8b92a1',
        userBg: '#eff3fc',
        userText: '#1a2233',
        codeBg: '#f5f7fb',
        codeText: '#2c3447',
        pillBg: '#ffffff',
        pillBorder: '#e8ebf2',
        brand: '#4d6bfe',
      }

  const baseFont = 'system-ui, -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif'
  const monoFont = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
  const normalFont = `400 26px ${baseFont}`
  const boldFont = `600 26px ${baseFont}`
  const headingFont = `600 28px ${baseFont}`
  const codeFont = `400 22px ${monoFont}`
  const metaFont = `400 22px ${baseFont}`

  type PreparedTurn = {
    userLines: string[]
    userBubbleWidth: number
    thinkingText: string
    assistantLines: RenderLine[]
    searchText: string
  }

  const prepared: PreparedTurn[] = []
  const now = Date.now()

  for (const turn of turns) {
    const userText = turn.user ? extractUserShareText(turn.user) : ''
    let userLines: string[] = []
    let userBubbleWidth = 0
    if (userText) {
      for (const para of userText.split(/\r?\n/)) {
        userLines.push(...measurer.wrapPlain(para, normalFont, maxBubbleWidth - 40))
      }
      const maxLineW = userLines.reduce(
        (max, line) => Math.max(max, measurer.measureString(line, normalFont)),
        0
      )
      userBubbleWidth = Math.min(maxBubbleWidth, Math.ceil(maxLineW) + 44)
    }

    let thinkingText = ''
    let searchText = ''
    const assistantLines: RenderLine[] = []
    if (turn.assistant) {
      const view = buildReplyView(turn.assistant, false)
      const hasThinking = view.steps.some((step) => step.type === 'thinking')
      if (hasThinking) {
        thinkingText = getAreaTitle(view, false, now, true)
      }
      if (view.searchResults.length > 0) {
        searchText = searchLabel(view.searchResults.length)
      }

      const md = extractAssistantShareText(turn.assistant)
      if (md) {
        let inCode = false
        let codeBlockStartIndex = -1
        for (const rawLine of md.split(/\r?\n/)) {
          const trimmed = rawLine.trim()
          if (trimmed.startsWith('```')) {
            if (inCode && codeBlockStartIndex >= 0 && assistantLines.length > codeBlockStartIndex) {
              const lastCode = assistantLines[assistantLines.length - 1]
              if (lastCode.kind === 'code') {
                lastCode.isLast = true
              }
            }
            inCode = !inCode
            codeBlockStartIndex = inCode ? assistantLines.length : -1
            continue
          }
          if (inCode) {
            const wrapped = measurer.wrapPlain(rawLine || ' ', codeFont, contentWidth - 28)
            for (const line of wrapped) {
              assistantLines.push({
                kind: 'code',
                text: line,
                isFirst: assistantLines.length === codeBlockStartIndex,
                isLast: false,
              })
            }
            continue
          }
          if (!trimmed) {
            const prev = assistantLines[assistantLines.length - 1]
            if (prev && prev.kind !== 'blank') {
              assistantLines.push({ kind: 'blank', height: 14 })
            }
            continue
          }
          const headingMatch = /^#{1,4}\s+(.+)$/.exec(trimmed)
          if (headingMatch) {
            if (assistantLines.length > 0 && assistantLines[assistantLines.length - 1].kind !== 'blank') {
              assistantLines.push({ kind: 'blank', height: 16 })
            }
            const cleanHeading = headingMatch[1].replace(/\*\*(.+?)\*\*/g, '$1')
            for (const line of measurer.wrapPlain(cleanHeading, headingFont, contentWidth)) {
              assistantLines.push({ kind: 'heading', text: line })
            }
            continue
          }
          const isBullet = /^[-*•]\s+/.test(trimmed)
          const normalized = isBullet ? `• ${trimmed.replace(/^[-*•]\s+/, '')}` : trimmed
          const indent = isBullet ? 6 : 0
          const runs = parseInlineRuns(normalized)
          for (const wrappedRuns of measurer.wrapRichRuns(
            runs,
            normalFont,
            boldFont,
            codeFont,
            contentWidth - indent
          )) {
            assistantLines.push({ kind: 'rich', runs: wrappedRuns, indent })
          }
        }
        if (inCode && assistantLines.length > 0) {
          const last = assistantLines[assistantLines.length - 1]
          if (last.kind === 'code') {
            last.isLast = true
          }
        }
      }
    }

    if (userLines.length > 0 || assistantLines.length > 0) {
      prepared.push({ userLines, userBubbleWidth, thinkingText, assistantLines, searchText })
    }
  }

  // 2. 计算精准高度
  let cursorY = 48 + 44 + 28 // top pad + brand header + gap
  for (const item of prepared) {
    if (item.userLines.length > 0) {
      cursorY += item.userLines.length * 38 + 30 + 28
    }
    if (item.thinkingText) {
      cursorY += 36
    }
    for (const line of item.assistantLines) {
      if (line.kind === 'blank') {
        cursorY += line.height
      } else if (line.kind === 'heading') {
        cursorY += 44
      } else if (line.kind === 'code') {
        cursorY += 34 + (line.isFirst ? 10 : 0) + (line.isLast ? 10 : 0)
      } else {
        cursorY += 42
      }
    }
    if (item.searchText) {
      cursorY += 62
    }
    cursorY += 30
  }
  cursorY += 108 // footer

  const truncated = cursorY > MAX_CANVAS_HEIGHT
  const totalHeight = Math.min(MAX_CANVAS_HEIGHT, Math.max(420, cursorY))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = totalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('Canvas 2D unavailable')
  }

  // 纯净白/暗色卡片底（与 DeepSeek 官方长图一致，无多余灰边）
  ctx.fillStyle = colors.cardBg
  ctx.fillRect(0, 0, width, totalHeight)

  // 顶部 DeepChat 品牌 Logo
  drawBrandHeader(ctx, padX, 46, appName, colors.brand, baseFont)

  let y = 120
  const contentLimitY = totalHeight - 116
  ctx.textBaseline = 'top'

  outer: for (const item of prepared) {
    if (item.userLines.length > 0) {
      const bubbleH = item.userLines.length * 38 + 30
      if (y + bubbleH > contentLimitY) {
        break
      }
      const bubbleX = width - padX - item.userBubbleWidth
      drawRoundedRect(ctx, bubbleX, y, item.userBubbleWidth, bubbleH, 18)
      ctx.fillStyle = colors.userBg
      ctx.fill()
      ctx.fillStyle = colors.userText
      ctx.font = normalFont
      let ly = y + 16
      for (const line of item.userLines) {
        ctx.fillText(line, bubbleX + 22, ly)
        ly += 38
      }
      y += bubbleH + 28
    }

    if (item.thinkingText) {
      if (y + 36 > contentLimitY) {
        break
      }
      ctx.fillStyle = colors.muted
      ctx.font = metaFont
      ctx.fillText(`${item.thinkingText}  ›`, padX, y)
      y += 38
    }

    for (const line of item.assistantLines) {
      const step =
        line.kind === 'blank'
          ? line.height
          : line.kind === 'heading'
            ? 44
            : line.kind === 'code'
              ? 34 + (line.isFirst ? 10 : 0) + (line.isLast ? 10 : 0)
              : 42
      if (y + step > contentLimitY) {
        break outer
      }
      if (line.kind === 'blank') {
        y += line.height
        continue
      }
      if (line.kind === 'heading') {
        ctx.fillStyle = colors.title
        ctx.font = headingFont
        ctx.fillText(line.text, padX, y + 4)
        y += 44
        continue
      }
      if (line.kind === 'code') {
        const topExtra = line.isFirst ? 10 : 0
        const bottomExtra = line.isLast ? 10 : 0
        ctx.fillStyle = colors.codeBg
        ctx.fillRect(padX, y, contentWidth, 34 + topExtra + bottomExtra)
        ctx.fillStyle = colors.codeText
        ctx.font = codeFont
        ctx.fillText(line.text, padX + 16, y + topExtra + 6)
        y += 34 + topExtra + bottomExtra
        continue
      }
      // rich inline line（支持行内真实加粗与行内代码）
      let rx = padX + line.indent
      for (const run of line.runs) {
        if (!run.text) {
          continue
        }
        const font = run.code ? codeFont : run.bold ? boldFont : normalFont
        ctx.font = font
        const runW = measurer.measureString(run.text, font)
        if (run.code) {
          drawRoundedRect(ctx, rx - 3, y + 2, runW + 6, 30, 6)
          ctx.fillStyle = colors.codeBg
          ctx.fill()
          ctx.fillStyle = colors.codeText
          ctx.fillText(run.text, rx, y + 5)
        } else {
          ctx.fillStyle = run.bold ? colors.title : colors.text
          ctx.fillText(run.text, rx, y + 2)
        }
        rx += runW
      }
      y += 42
    }

    if (item.searchText && y + 58 <= contentLimitY) {
      y += 12
      ctx.font = metaFont
      const textW = measurer.measureString(item.searchText, metaFont)
      const pillW = Math.ceil(textW) + 52
      drawRoundedRect(ctx, padX, y, pillW, 40, 20)
      ctx.fillStyle = colors.pillBg
      ctx.fill()
      ctx.strokeStyle = colors.pillBorder
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.fillStyle = colors.brand
      ctx.beginPath()
      ctx.arc(padX + 22, y + 20, 6, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = colors.text
      ctx.fillText(item.searchText, padX + 36, y + 9)
      y += 50
    }

    y += 28
  }

  // 底部极简免责与品牌栏（贴合 DeepSeek 官方样式）
  const footerTop = totalHeight - 98
  ctx.strokeStyle = colors.divider
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(padX, footerTop)
  ctx.lineTo(width - padX, footerTop)
  ctx.stroke()

  ctx.fillStyle = colors.title
  ctx.font = `500 22px ${baseFont}`
  ctx.fillText(appName, padX, footerTop + 22)

  ctx.fillStyle = colors.muted
  ctx.font = `400 20px ${baseFont}`
  ctx.fillText(truncated ? `${footerText} · …` : footerText, padX, footerTop + 54)

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => {
        if (result) {
          resolve(result)
        } else {
          reject(new Error('Failed to encode image'))
        }
      },
      'image/jpeg',
      0.93
    )
  })
  return { blob, mimeType: 'image/jpeg', ext: 'jpg' }
}

export const saveShareImageBlob = async (
  blob: Blob,
  fileName: string,
  mimeType = 'image/jpeg'
): Promise<'android' | 'web'> => {
  const androidProxy = getAndroidProxyOrigin()
  if (androidProxy) {
    const token = getAndroidProxyToken()
    const res = await fetch(
      `${androidProxy}/__deepchat_save_file?name=${encodeURIComponent(fileName)}&mime=${encodeURIComponent(mimeType)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': mimeType,
          ...(token ? { 'X-Proxy-Token': token } : {}),
        },
        body: blob,
      }
    )
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    return 'android'
  }
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return 'web'
}

export const shareImageBlob = async (
  blob: Blob,
  fileName: string,
  mimeType = 'image/jpeg'
): Promise<'android' | 'web' | 'unsupported'> => {
  const androidProxy = getAndroidProxyOrigin()
  if (androidProxy) {
    const token = getAndroidProxyToken()
    const res = await fetch(
      `${androidProxy}/__deepchat_share_image?name=${encodeURIComponent(fileName)}&mime=${encodeURIComponent(mimeType)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': mimeType,
          ...(token ? { 'X-Proxy-Token': token } : {}),
        },
        body: blob,
      }
    )
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    return 'android'
  }
  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    const file = new File([blob], fileName, { type: mimeType })
    const canShare =
      typeof navigator.canShare !== 'function' || navigator.canShare({ files: [file] })
    if (canShare) {
      await navigator.share({ files: [file], title: fileName })
      return 'web'
    }
  }
  return 'unsupported'
}
