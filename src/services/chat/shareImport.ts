import type { TranslationKey } from '../../i18n/index.js'
import { createId } from '../../utils/id.js'
import * as db from './db.js'
import type {
  ChatMessage,
  ChatMessageStatus,
  ChatRole,
  Fragment,
  SearchResult,
} from './history/format.js'
import { toLocalTree } from './history/toLocal.js'
import { useChatStore } from './store.js'
import { toSessionSummary, type Session } from './types.js'

/**
 * DeepSeek 分享链接导入：拉取 share/content 接口，把分享会话里的提问、
 * 思考与回答原样转换为本地消息树，写入 IndexedDB 并选为新会话。
 *
 * 官方分享接口与 ZIF 归档格式存在差异，转换时统一归一化：
 * - 根消息的 parent_id 是 0（归档里是 null）；
 * - TOOL_SEARCH.queries 是 [{ query }] 对象数组；
 * - TOOL_OPEN 的 url/title/snippet 位于 result 字段内；
 * - published_at 是秒级时间戳数字。
 *
 * chat.deepseek.com 不返回 CORS 头，浏览器直连会被拦截，
 * 因此优先走同源代理（本地 dev 与线上 Worker 都提供 /api/v0/share/content），
 * 再依次回退直连和公共只读代理；接口本身免登录。
 */

export class ShareImportError extends Error {
  key: TranslationKey
  /** 最后一次渠道失败的简短原因，拼在提示后面便于排查 */
  detail?: string

  constructor(key: TranslationKey, detail?: string) {
    super(key)
    this.key = key
    this.detail = detail
  }
}

const fail = (key: TranslationKey, detail?: string): never => {
  throw new ShareImportError(key, detail)
}

/** 从粘贴文本中提取分享 ID：支持完整链接、带前后缀的链接和纯 ID。 */
export const parseShareLink = (input: string): string | null => {
  const value = input.trim()
  if (!value) {
    return null
  }
  const pathMatch =
    /\/a\/chat\/s\/([0-9A-Za-z_.~-]+)/.exec(value) ?? /\/share\/([0-9A-Za-z_.~-]+)/.exec(value)
  if (pathMatch) {
    return pathMatch[1]
  }
  try {
    const url = new URL(value)
    if (/(^|\.)deepseek\.com$/.test(url.hostname)) {
      return (
        url.searchParams.get('share_id') ?? url.searchParams.get('id') ?? url.searchParams.get('code')
      )
    }
  } catch {
    // 不是 URL，按纯 ID 处理
  }
  return /^[^/?#\s]{4,128}$/.test(value) ? value : null
}

const SHARE_PATH = '/api/v0/share/content'

const contentUrl = (shareId: string) =>
  `https://chat.deepseek.com${SHARE_PATH}?share_id=${encodeURIComponent(shareId)}`

/**
 * 渠道超时：分享内容可能有数 MB，同源代理与直连需要给足时间，公共代理限时短一些。
 */
const TIMEOUTS = { sameOrigin: 120000, direct: 60000, proxy: 15000 }

/** 直连被 CORS 拦截时的公共只读代理兜底；国内网络可能都不可用。 */
const publicProxies = (target: string): string[] => [
  `https://corsproxy.io/?url=${encodeURIComponent(target)}`,
  `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(target)}`,
  `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`,
  `https://r.jina.ai/${target}`,
]

type ShareResponse = {
  data?: {
    biz_code?: unknown
    biz_msg?: unknown
    biz_data?: { title?: unknown; messages?: unknown } | null
  } | null
}

type ShareContent = { title: string | null; messages: unknown[] }

/**
 * 读取一个渠道（同源代理 / 直连 / 公共代理）：
 * - 返回内容：渠道给出了成功结果；
 * - 抛 ShareImportError：渠道给出明确业务结论（分享不存在等），不再换渠道；
 * - 返回 null：渠道自身故障（CORS、限流、上游不可用），继续尝试下一个。
 */
const readShare = async (
  url: string,
  timeoutMs: number,
  failures: string[]
): Promise<ShareContent | null> => {
  let text: string
  let status: number
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    status = response.status
    text = await response.text()
  } catch (error) {
    failures.push(`请求失败 ${url.slice(0, 70)} ${String(error).slice(0, 60)}`)
    return null
  }
  let body: ShareResponse
  try {
    body = JSON.parse(text) as ShareResponse
  } catch {
    failures.push(`非 JSON 响应 ${url.slice(0, 70)} HTTP ${status}`)
    return null
  }
  const data = body?.data
  if (!data || typeof data.biz_code !== 'number') {
    failures.push(`响应结构不符 ${url.slice(0, 70)}`)
    return null
  }
  if (data.biz_code === 0) {
    const biz = data.biz_data ?? {}
    return {
      title: typeof biz.title === 'string' ? biz.title : null,
      messages: Array.isArray(biz.messages) ? biz.messages : [],
    }
  }
  if (data.biz_code > 0) {
    // 分享不存在 / 已失效 / 链接无效：明确结论，直接失败
    throw new ShareImportError('shareNotFound')
  }
  // biz_code < 0：本渠道上游不可用（例如 Worker 无法访问 DeepSeek），换渠道
  failures.push(`上游不可用 HTTP ${status} code=${data.biz_code}`)
  return null
}

const fetchShareContent = async (shareId: string): Promise<ShareContent> => {
  const query = `share_id=${encodeURIComponent(shareId)}`
  const target = contentUrl(shareId)
  const failures: string[] = []
  // 同源代理优先（本地 dev 代理与线上 Worker 都提供该路径），有明确回答即以此为准
  try {
    const same = await readShare(`${SHARE_PATH}?${query}`, TIMEOUTS.sameOrigin, failures)
    if (same) {
      return same
    }
  } catch (error) {
    if (error instanceof ShareImportError) {
      throw error
    }
  }
  // 直连与公共代理兜底；直连通常被 CORS 拦截，公共代理给短超时
  const channels: [string, number][] = [
    [target, TIMEOUTS.direct],
    ...publicProxies(target).map((url): [string, number] => [url, TIMEOUTS.proxy]),
  ]
  for (const [url, timeoutMs] of channels) {
    try {
      const content = await readShare(url, timeoutMs, failures)
      if (content) {
        return content
      }
    } catch (error) {
      if (error instanceof ShareImportError) {
        throw error
      }
    }
  }
  return fail('shareNetworkFailed', failures.slice(-3).join(' | '))
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

const isoFromEpoch = (value: unknown): string | null => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value * 1000).toISOString()
  }
  if (typeof value === 'string' && value) {
    const time = Date.parse(value)
    return Number.isNaN(time) ? null : new Date(time).toISOString()
  }
  return null
}

const normalizeResults = (value: unknown): SearchResult[] => {
  if (!Array.isArray(value)) {
    return []
  }
  return value.flatMap((item) => {
    if (typeof item !== 'object' || item === null) {
      return []
    }
    const result = item as Record<string, unknown>
    if (typeof result.url !== 'string' || result.url === '') {
      return []
    }
    return [
      {
        url: result.url,
        title: text(result.title),
        snippet: text(result.snippet),
        published_at: isoFromEpoch(result.published_at),
        site_name: typeof result.site_name === 'string' ? result.site_name : null,
        ...(typeof result.site_icon === 'string' ? { site_icon: result.site_icon } : {}),
      },
    ]
  })
}

const searchStatus = (value: unknown): 'WIP' | 'FINISHED' | 'FAILED' | undefined =>
  value === 'WIP' || value === 'FINISHED' || value === 'FAILED' ? value : undefined

const openStatus = (value: unknown): 'WIP' | 'FINISHED' | 'FAILED' =>
  value === 'WIP' || value === 'FAILED' ? value : 'FINISHED'

const findStatus = (value: unknown): 'WIP' | 'FINISHED' | 'NO_RESULT' | 'FAILED' =>
  value === 'WIP' || value === 'FINISHED' || value === 'NO_RESULT' || value === 'FAILED'
    ? value
    : 'FINISHED'

/** 官方分享片段 → 归档片段模型，补齐字段差异；未知类型直接丢弃。 */
const normalizeFragment = (item: unknown): Fragment | null => {
  if (typeof item !== 'object' || item === null) {
    return null
  }
  const fragment = item as Record<string, unknown>
  switch (fragment.type) {
    case 'REQUEST':
      return { type: 'REQUEST', content: text(fragment.content) }
    case 'RESPONSE':
      return { type: 'RESPONSE', content: text(fragment.content) }
    case 'TEMPLATE_RESPONSE':
      return { type: 'TEMPLATE_RESPONSE', content: text(fragment.content) }
    case 'THINK':
      return {
        type: 'THINK',
        content: text(fragment.content),
        elapsed_secs: typeof fragment.elapsed_secs === 'number' ? fragment.elapsed_secs : null,
      }
    case 'TOOL_SEARCH': {
      const status = searchStatus(fragment.status)
      return {
        type: 'TOOL_SEARCH',
        queries: Array.isArray(fragment.queries)
          ? fragment.queries.flatMap((query) => {
              if (typeof query === 'string') {
                return query ? [query] : []
              }
              if (typeof query === 'object' && query !== null) {
                const value = text((query as Record<string, unknown>).query)
                return value ? [value] : []
              }
              return []
            })
          : [],
        results: normalizeResults(fragment.results),
        ...(status ? { status } : {}),
      }
    }
    case 'TOOL_OPEN': {
      const result =
        typeof fragment.result === 'object' && fragment.result !== null
          ? (fragment.result as Record<string, unknown>)
          : {}
      const url = typeof result.url === 'string' && result.url ? result.url : null
      const title = typeof result.title === 'string' && result.title ? result.title : null
      return {
        type: 'TOOL_OPEN',
        status: openStatus(fragment.status),
        url,
        title,
        snippet: typeof result.snippet === 'string' ? result.snippet : null,
        site_name: typeof result.site_name === 'string' ? result.site_name : null,
        published_at: isoFromEpoch(result.published_at),
      }
    }
    case 'TOOL_FIND':
      return {
        type: 'TOOL_FIND',
        status: findStatus(fragment.status),
        ...(typeof fragment.pattern === 'string' ? { pattern: fragment.pattern } : {}),
      }
    case 'READ_LINK':
      return {
        type: 'READ_LINK',
        results: Array.isArray(fragment.results)
          ? fragment.results.flatMap((result) => {
              if (typeof result !== 'object' || result === null) {
                return []
              }
              const entry = result as Record<string, unknown>
              const url = typeof entry.url === 'string' ? entry.url : undefined
              return [
                {
                  ...(url ? { url } : {}),
                  title: typeof entry.title === 'string' ? entry.title : null,
                  signature: text(entry.signature),
                },
              ]
            })
          : [],
      }
    default:
      return null
  }
}

const STATUSES = new Set<ChatMessageStatus>([
  'WIP',
  'FINISHED',
  'CONTENT_FILTER',
  'FAILED',
  'INCOMPLETE',
  'CONTEXT_LENGTH_EXCEEDED',
  'TIMEOUT',
])

/** 裸消息 → 归档消息模型（toLocal 的输入）；字段缺失或类型不对时放宽处理。 */
const toRawMessage = (item: unknown, index: number, now: number): ChatMessage | null => {
  if (typeof item !== 'object' || item === null) {
    return null
  }
  const raw = item as Record<string, unknown>
  const id = Number(raw.message_id ?? raw.id)
  if (!Number.isSafeInteger(id)) {
    return null
  }
  // 官方接口用 parent_id=0 表示根消息，归档模型用 null
  const parent = Number(raw.parent_id)
  const role = String(raw.role ?? '').toUpperCase()
  const status = String(raw.status ?? '')
  const time =
    typeof raw.inserted_at === 'number'
      ? raw.inserted_at > 1e12
        ? raw.inserted_at
        : raw.inserted_at * 1000
      : Date.parse(String(raw.inserted_at ?? ''))
  const fragments = Array.isArray(raw.fragments) ? (raw.fragments as unknown[]) : []
  return {
    id,
    parent_id: Number.isSafeInteger(parent) && parent > 0 ? parent : null,
    role: (role === 'USER' ? 'USER' : 'ASSISTANT') as ChatRole,
    status: (STATUSES.has(status as ChatMessageStatus) ? status : 'FINISHED') as ChatMessageStatus,
    thinking_enabled: raw.thinking_enabled === true,
    search_enabled: raw.search_enabled === true,
    accumulated_token_usage: 0,
    inserted_at:
      Number.isFinite(time) && time > 0
        ? new Date(time).toISOString()
        : new Date(now + index).toISOString(),
    fragments: fragments
      .map(normalizeFragment)
      .filter((fragment): fragment is Fragment => fragment !== null),
  }
}

/** 丢掉父消息缺失的孤立消息（分享数据可能是部分树），避免树校验失败。 */
const pruneOrphans = (messages: ChatMessage[]): ChatMessage[] => {
  const valid = new Set(messages.map((message) => message.id))
  let changed = true
  while (changed) {
    changed = false
    for (const message of messages) {
      if (message.parent_id !== null && !valid.has(message.parent_id)) {
        valid.delete(message.id)
        changed = true
      }
    }
  }
  return messages.filter((message) => valid.has(message.id))
}

/**
 * 导入分享会话：抓取 → 转换 → 入库 → 选中；返回新会话。
 * 解析或存储失败时抛 ShareImportError（key 用于文案），本地数据不受影响。
 */
export const importSharedChat = async (input: string): Promise<Session> => {
  const shareId = parseShareLink(input) ?? fail('shareLinkInvalid')
  const content = await fetchShareContent(shareId)
  const now = Date.now()
  const all = content.messages
    .map((item, index) => toRawMessage(item, index, now))
    .filter((message): message is ChatMessage => message !== null)
  if (all.length === 0) {
    return fail('shareImportFailed')
  }
  all.sort((a, b) => a.id - b.id)
  const messages = pruneOrphans(all)
  if (messages.length === 0) {
    return fail('shareImportFailed')
  }
  const tree = toLocalTree(messages)
  if (tree.messages.length === 0) {
    return fail('shareImportFailed')
  }
  const createdAt = tree.messages[0].createdAt
  const updatedAt = tree.messages[tree.messages.length - 1].createdAt
  const session: Session = {
    id: createId(),
    title: content.title?.trim() ?? '',
    createdAt: Number.isFinite(createdAt) ? createdAt : now,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : now,
    messages: tree.messages,
    rootMessageId: tree.rootMessageId,
  }
  await db.saveSession(session)
  useChatStore.setState((state) =>
    state.importingHistory
      ? state
      : {
          sessions: [
            ...state.sessions.filter((item) => item.id !== session.id),
            toSessionSummary(session),
          ].sort((a, b) => b.updatedAt - a.updatedAt),
          sessionCache: { ...state.sessionCache, [session.id]: session },
          activeId: session.id,
        }
  )
  return session
}
