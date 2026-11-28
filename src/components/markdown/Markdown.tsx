import { memo, useMemo } from 'react'
import type { Source } from '../../services/chat/view.js'
import { toMdAst } from '../../services/markdown/parse.js'
import { useScrollToBottom } from '../messages/scrollContext.js'
import { MarkdownAstRenderer } from './MarkdownAstRenderer.js'
import { useThrottleMarkdownRender } from './useThrottleMarkdownRender.js'
import './markdown.css'
import './highlight.css'

const STREAM_SPLIT_THRESHOLD = 1600
const NOOP = () => {}

/**
 * 流式输出长文时把“已闭合的上方段落”和“末尾正在生成的段落”拆开，
 * 上方稳定前缀只解析一次 AST，避免几千字长文每次流式刷新都从头重解析。
 */
const splitStableMarkdownPrefix = (markdown: string): { prefix: string; tail: string } => {
  if (markdown.length < STREAM_SPLIT_THRESHOLD) {
    return { prefix: '', tail: markdown }
  }
  const lines = markdown.split('\n')
  let inFence = false
  let lastSafeLine = -1
  for (let i = 0; i < lines.length - 2; i += 1) {
    const trimmed = lines[i].trim()
    if (/^(?:`{3,}|~{3,})/.test(trimmed)) {
      inFence = !inFence
      continue
    }
    if (!inFence && trimmed === '') {
      lastSafeLine = i
    }
  }
  if (lastSafeLine <= 0) {
    return { prefix: '', tail: markdown }
  }
  const prefix = lines.slice(0, lastSafeLine + 1).join('\n')
  const tail = lines.slice(lastSafeLine + 1).join('\n')
  if (prefix.length < 400 || !tail.trim()) {
    return { prefix: '', tail: markdown }
  }
  return { prefix, tail }
}

const StaticMarkdownBlock = memo(function StaticMarkdownBlock({
  content,
  cacheKey,
  className,
  disableLink,
  sources,
}: {
  content: string
  cacheKey: string
  className?: string
  disableLink: boolean
  sources?: Source[]
}) {
  const ast = useMemo(
    () => (content ? toMdAst(content, { sources, disableLink }) : null),
    [content, sources, disableLink]
  )
  return ast ? (
    <MarkdownAstRenderer
      key={cacheKey}
      className={className}
      ast={ast}
      loading={false}
      onUpdate={NOOP}
    />
  ) : null
})

/**
 * 渲染链路：节流 → 解析 AST → 渲染。
 * 流式长文自动拆分稳定前缀，结束后合并为完整 AST 保证排版一致。
 */
export const Markdown = memo(function Markdown({
  content,
  loading,
  cacheKey,
  className,
  disableLink,
  sources,
}: {
  content: string
  loading: boolean
  cacheKey: string
  className?: string
  disableLink: boolean
  sources?: Source[]
}) {
  const scrollToBottom = useScrollToBottom()
  const throttledMarkdown = useThrottleMarkdownRender(content, loading)
  const split = useMemo(
    () => (loading ? splitStableMarkdownPrefix(throttledMarkdown) : { prefix: '', tail: throttledMarkdown }),
    [loading, throttledMarkdown]
  )
  const tailAst = useMemo(
    () => (split.tail ? toMdAst(split.tail, { sources, disableLink }) : null),
    [split.tail, sources, disableLink]
  )
  if (!split.prefix) {
    return tailAst ? (
      <MarkdownAstRenderer
        key={cacheKey}
        className={className}
        ast={tailAst}
        loading={loading}
        onUpdate={scrollToBottom}
      />
    ) : null
  }
  return (
    <>
      <StaticMarkdownBlock
        content={split.prefix}
        cacheKey={`${cacheKey}-prefix`}
        className={className}
        disableLink={disableLink}
        sources={sources}
      />
      {tailAst ? (
        <MarkdownAstRenderer
          key={`${cacheKey}-tail`}
          className={className}
          ast={tailAst}
          loading={loading}
          onUpdate={scrollToBottom}
        />
      ) : null}
    </>
  )
})
