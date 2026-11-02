/**
 * session-recall — 给 DSH 补回 AGY 的「无损召回」能力。
 *
 * 问题：compaction 只把旧事件从**上下文**里藏起来，会话日志本身一条没删。
 * 实测（session-63ecc7ec）：可检索正文 470,615 字符，而压缩后下一步请求只有
 * 40,563 provider tokens —— 约 80% 的正文在压缩后不可见，且消失的正是带行号的
 * 原始工具结果。
 *
 * AGY 用 SQLite FTS5 + BM25 把这份记忆找回来；DSH 没有召回层，所以模型只能
 * 依赖有损摘要。本插件用 DSH 已有的两个事实补上这一层：
 *   1. `session.snapshotEvents()` 返回**完整**且持久的日志；
 *   2. `session.surface.nodes` 能判定某条记录现在还看得见、还是已被压缩遮蔽。
 * 于是可以做通用 grep 做不到的事：**优先召回"模型已经忘掉"的那部分**。
 *
 * 设计取舍：
 *   - 纯内存线性扫描（实测 95 条 / 470k 字符 ≈ 0.2~1.4 ms），不建索引、不做 I/O；
 *   - 片段取命中位置 ±window 字符并**对齐行边界**，保住 `123: ...` 这种行号前缀；
 *   - 单结果总长受 maxChars 约束（默认 4200，硬上限 6000），避开 6144 的 pruner 阈值
 *     与上下文膨胀；
 *   - 泛词查询（如 "the"）会吃满预算返回垃圾，因此设最低分闸门并明确回报"请更具体"。
 */

import { readSessionEvents } from './compaction-epoch.mjs'

/** Cordis 插件名。 */
export const name = 'session-recall'

/**
 * 必须在 apply 之前就拿到 `tools` 服务。
 *
 * 没有这行声明时，`ctx.tools` 在 apply 阶段可能仍是 undefined，
 * `ctx.tools.register(...)` 会抛 TypeError → 插件挂载失败 → **整个 preset 行失败
 * → 预设从选择器里消失**。2026-10-29 实际踩过：重启后预设不见了就是这个原因。
 *
 * 对照：`dev-tool-search` = `['tools']`，`skill-search` = `['agents','tools','skills']`；
 * 只用 `ctx.on` / `ctx.get` 的插件（`instruction-hint`、`agy-diff-guard`）不必声明。
 */
export const inject = ['tools']

const ALLOWED_KEYS = new Set(['maxChars', 'maxSnippets', 'windowChars', 'minScore'])
const HARD_MAX_CHARS = 6000
const SNIPPET_CAP = 1800
// Unicode-aware: `\W` does NOT match CJK (it is the ASCII word class), so an earlier
// `[^\W_]` split turned a pure-Chinese query into zero tokens. `\p{L}` fixes that.
const TOKEN_RE = /[\p{L}\p{N}_-]+/gu

/** 不进语料的 source.kind：宿主样板与压缩摘要（后者是派生文本，模型本来就带着）。 */
const EXCLUDED_SOURCES = new Set(['runtime-context', 'compact-checkpoint'])

/**
 * 极小的停用词表。文档频率不够用：`the` 在这类会话里只出现在少量记录中，
 * 频率筛不掉它，但它同样没有区分度。只收高频虚词，不收任何有语义的词。
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'from', 'by',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these',
  'those', 'as', 'not', 'no', 'but', 'if', 'then', 'than', 'so', 'do', 'does', 'did', 'have',
  'has', 'had', 'can', 'could', 'should', 'would', 'will', 'you', 'your', 'i', 'we', 'they',
  '的', '了', '是', '在', '和', '有', '我', '你', '它', '这个', '那个', '一个',
])

/** callId 集合：避免召回工具把自己的历史输出再召回一遍。 */
const ownCallIds = new Set()

/** 把一条消息的 content 块压成纯文本。 */
function textOf(blocks) {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  const out = []
  for (const b of blocks) {
    if (b !== null && typeof b === 'object' && typeof b.text === 'string') out.push(b.text)
  }
  return out.join('\n')
}

/**
 * 从原始事件流里抽出所有可检索记录。
 *
 * 导出以便离线测试：输入就是 JSONL 里的一行行事件，不需要真实 Session。
 * @param events - `{ type, seq, data }` 事件数组。
 * @param skipCallIds - 需要排除的 tool callId 集合（本工具自己的输出）。
 * @returns `{ seq, kind, text }[]`
 */
export function extractRecords(events, skipCallIds) {
  const rows = []
  for (const ev of events ?? []) {
    const t = ev === null || typeof ev !== 'object' ? undefined : ev.type
    const d = (ev === null || typeof ev !== 'object' ? undefined : ev.data) ?? {}
    const seq = ev === null || typeof ev !== 'object' ? undefined : ev.seq
    if (t === 'tool/result') {
      const msg = d.message ?? {}
      const callId = msg.toolCallId ?? d.callId
      if (skipCallIds !== undefined && callId !== undefined && skipCallIds.has(callId)) continue
      const text = textOf(msg.content)
      if (text.length > 0) rows.push({ seq, kind: 'tool', text })
    } else if (t === 'assistant/message') {
      const text = textOf((d.message ?? {}).content)
      if (text.length > 0) rows.push({ seq, kind: 'assistant', text })
    } else if (t === 'user/message') {
      const sourceKind = d.source === null || typeof d.source !== 'object' ? undefined : d.source.kind
      if (sourceKind !== undefined && EXCLUDED_SOURCES.has(sourceKind)) continue
      const text = textOf(d.content)
      if (text.length > 0) rows.push({ seq, kind: 'user', text })
    }
  }
  return rows
}

/** 按行边界把窗口向外扩到语义完整的位置。 */
function snapToLines(text, start, end) {
  const nl = text.lastIndexOf('\n', start)
  if (nl !== -1 && start - nl < 200) start = nl + 1
  const ne = text.indexOf('\n', end)
  if (ne !== -1 && ne - end < 200) end = ne
  return [start, end]
}

/**
 * 在记录里检索并返回按分数排序的片段。
 *
 * @param records - `extractRecords` 的输出。
 * @param options - `{ query, prefer, limit, maxChars, windowChars, minScore, surfaceNodes }`
 * @returns `{ query, hits, totalChars, shadowedFound, reason }`
 */
export function searchRecords(records, options) {
  const query = typeof options.query === 'string' ? options.query.trim() : ''
  const prefer = options.prefer === 'any' ? 'any' : 'shadowed'
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 6) : 3
  const maxChars = Number.isSafeInteger(options.maxChars) && options.maxChars > 0
    ? Math.min(options.maxChars, HARD_MAX_CHARS)
    : 4200
  const window = Number.isSafeInteger(options.windowChars) && options.windowChars > 0
    ? Math.min(options.windowChars, 1200)
    : 420
  // Default 1, NOT 3. A genuinely unique token (a 12-hex trace) appears only twice in
  // the corpus and scores 2, so a threshold of 3 rejected the single most distinctive
  // query possible (observed 2026-10-29). Genericness is already handled by the stopword
  // list and the document-frequency filter above; this threshold only needs to drop 0.
  const minScore = Number.isSafeInteger(options.minScore) && options.minScore > 0 ? options.minScore : 1
  const surface = options.surfaceNodes

  const tokens = [...new Set((query.toLowerCase().match(TOKEN_RE) ?? []))].slice(0, 12)
  if (tokens.length === 0) {
    return { query, hits: [], totalChars: 0, maxChars, reason: 'empty-query' }
  }

  // Genericness guard, two layers because either alone leaks:
  //   1. a tiny stopword list catches high-frequency function words ("the") that a
  //      document-frequency filter cannot, since they appear in only a few records;
  //   2. document frequency catches domain-generic words ("file", "error") that a
  //      fixed list cannot know about.
  const corpus = records ?? []
  let useful = tokens.filter((tk) => !STOPWORDS.has(tk))
  if (useful.length === 0) {
    return { query, hits: [], totalChars: 0, maxChars, reason: 'too-generic', bestScore: 0 }
  }
  if (corpus.length >= 8) {
    const limit = Math.max(1, Math.floor(corpus.length * 0.6))
    const byFrequency = useful.filter((tk) => {
      let df = 0
      for (const r of corpus) {
        if (r.text.toLowerCase().includes(tk)) df += 1
        if (df > limit) return false
      }
      return true
    })
    if (byFrequency.length === 0) {
      return { query, hits: [], totalChars: 0, maxChars, reason: 'too-generic', bestScore: 0 }
    }
    useful = byFrequency
  }

  const scored = []
  for (const r of corpus) {
    const low = r.text.toLowerCase()
    let score = 0
    let first = -1
    for (const tk of useful) {
      const c = low.split(tk).length - 1
      if (c > 0) {
        score += c
        const pos = low.indexOf(tk)
        if (first < 0 || (pos >= 0 && pos < first)) first = pos
      }
    }
    if (score === 0) continue
    const shadowed = surface === undefined ? undefined : !surface.has(r.seq)
    // Recall exists to return what the model LOST; a record still on the surface is
    // already in front of it, so rank it behind an equally relevant shadowed one.
    if (shadowed === true) score = Math.round(score * 1.5)
    if (prefer === 'shadowed' && shadowed === false) score = Math.max(1, Math.round(score / 3))
    scored.push({ score, first, record: r, shadowed })
  }

  scored.sort((a, b) => (b.score - a.score) || ((a.record.seq ?? 0) - (b.record.seq ?? 0)))

  if (scored.length === 0) {
    return { query, hits: [], totalChars: 0, maxChars, reason: 'no-match' }
  }
  if (scored[0].score < minScore) {
    return { query, hits: [], totalChars: 0, maxChars, reason: 'too-generic', bestScore: scored[0].score }
  }

  // `prefer: shadowed` is a HARD partition, not a weight. The whole point of recall is
  // returning what the model lost; letting an on-surface hit outrank a shadowed one just
  // shows it something already in front of it. On-surface hits are appended afterwards
  // if budget remains, clearly labelled, so nothing useful is silently dropped.
  const ordered = prefer === 'shadowed'
    ? [...scored.filter((s) => s.shadowed !== false), ...scored.filter((s) => s.shadowed === false)]
    : scored

  const hits = []
  let total = 0
  let shadowedFound = 0
  for (const s of ordered) {
    if (hits.length >= limit || total >= maxChars) break
    const src = s.record.text
    const at = s.first >= 0 ? s.first : 0
    let [start, end] = snapToLines(src, Math.max(0, at - window), Math.min(src.length, at + window))
    let snip = src.slice(start, end)
    if (snip.length > SNIPPET_CAP) snip = snip.slice(0, SNIPPET_CAP)
    const room = maxChars - total
    if (room <= 0) break
    if (snip.length > room) snip = snip.slice(0, room)
    if (snip.length === 0) continue
    total += snip.length
    if (s.shadowed === true) shadowedFound += 1
    hits.push({
      seq: s.record.seq,
      kind: s.record.kind,
      score: s.score,
      shadowed: s.shadowed,
      chars: snip.length,
      snippet: snip,
    })
  }
  return { query, hits, totalChars: total, shadowedFound, maxChars, reason: 'ok' }
}

/** 把检索结果渲染成模型可读的文本（也是本工具的返回值）。 */
export function render(result, totalRecords) {
  // maxChars is a promise about the WHOLE returned text, on EVERY path — including the
  // empty-query / too-generic / no-match notices. Those return early, so the cap has to be
  // applied here rather than only to the hit list.
  const cap = Number.isSafeInteger(result.maxChars) && result.maxChars > 0 ? result.maxChars : HARD_MAX_CHARS
  const capped = (text) => (text.length <= cap ? text : `${text.slice(0, Math.max(0, cap - 1))}…`)

  if (result.reason === 'empty-query') {
    return capped('session_recall needs a non-empty `query` (keywords, an identifier, an error code, a line number…).')
  }
  if (result.reason === 'too-generic') {
    return capped(
      `Your query scored only ${result.bestScore} against ${totalRecords} records — too generic to be useful. ` +
        'Add a distinctive token: a function name, a file name, an error code, or an exact phrase.',
    )
  }
  if (result.reason === 'no-match') {
    return capped(
      `No record matches "${result.query}" among ${totalRecords} searchable records ` +
        '(tool results, assistant text, user messages). Compaction never deletes these, so if this returns nothing ' +
        'the detail was never in this session — do not keep retrying the same query.',
    )
  }
  const lines = [
    `session_recall "${result.query}" — ${result.hits.length} hit(s), ${result.totalChars} chars, ` +
      `${result.shadowedFound} of them already removed from context by compaction.`,
    'Records are ordered by score; `seq` is the durable event sequence (lower = older, may be stale after later edits).',
    '',
  ]
  for (const h of result.hits) {
    const where = h.shadowed === true ? 'shadowed' : h.shadowed === false ? 'on-surface' : 'unknown'
    lines.push(`--- [seq ${h.seq}] [${where}] ${h.kind} · score ${h.score}`)
    lines.push(h.snippet.trimEnd())
    lines.push('')
  }
  const text = lines.join('\n')
  return capped(text)
}

export function apply(ctx, config) {
  const source = config === undefined ? null : config
  if (source !== null && (typeof source !== 'object' || Array.isArray(source))) {
    throw new TypeError(`${name}: config must be an object`)
  }
  const cfg = source ?? {}
  const unknown = Object.keys(cfg).filter((k) => !ALLOWED_KEYS.has(k))
  if (unknown.length > 0) {
    throw new TypeError(`${name}: unknown config key(s) ${unknown.join(', ')} — allowed: ${[...ALLOWED_KEYS].sort().join(', ')}`)
  }

  ctx.tools.register({
    name: 'session_recall',
    // `output` is MANDATORY. `ToolRegistry.register()` throws
    // `tool "<name>" must declare output { schema, render, presentationMeta? }` when it
    // is missing; that rejection fails this row's fiber, `mountPreset` then throws, the
    // whole preset is marked broken and **disappears from the selector**. This actually
    // happened on 2026-10-29. Same shape as dev-tool-search / skill-search.
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_a, v) => [{ type: 'text', text: v.text }],
    },
    description:
      'Search this session\'s durable history — including everything compaction has ALREADY removed from your ' +
      'context. Use it when you need a detail that is no longer visible: an exact line number, a function ' +
      'signature, a command you ran, an error code, a file path, or the user\'s original wording. It searches ' +
      'tool results, assistant text and user messages, and by default prefers records that compaction shadowed. ' +
      'Prefer this over re-reading a large file or guessing from memory.',
    // Proper JSON Schema: `required` is a TOP-LEVEL array of property names.
    // Putting `required: true|false` INSIDE a property is invalid on the wire — AI Studio
    // rejects the whole request with
    //   `schema.properties.<name>: schema.required must be an array of strings`
    // which failed an entire turn on 2026-10-29. `dev-tool-search` avoids this by building
    // the schema through its own `toJsonSchema` helper; here it is spelled out directly.
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'keywords, an identifier, an error code, or an exact phrase' },
        prefer: { type: 'string', enum: ['shadowed', 'any'], description: 'default shadowed: rank context-removed records first' },
        limit: { type: 'number', description: 'max snippets (default 3, max 6)' },
        maxChars: { type: 'number', description: 'total budget in characters (default 4200, max 6000)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(args, exec) {
      try {
        const agent = exec?.agent
        const session = agent?.session
        if (session === undefined || session === null) {
          return { text: 'session_recall: no active session in this scope.' }
        }
        const events = readSessionEvents(session)
        const records = extractRecords(events, ownCallIds)
        let surface
        try {
          const nodes = session.surface?.nodes
          if (nodes !== undefined && nodes !== null) surface = new Set([...nodes])
        } catch {
          surface = undefined
        }
        const result = searchRecords(records, {
          query: typeof args?.query === 'string' ? args.query : '',
          prefer: args?.prefer,
          // config 是默认值，调用参数优先。之前只读 args.limit，导致配置里的
          // maxSnippets 被接受却静默无效 —— 这类"配置项是摆设"的缺陷不该存在。
          limit: args?.limit ?? cfg.maxSnippets,
          // 同样的坑：入口曾经写死 `cfg.maxChars`，于是调用方传 maxChars 被完全忽略，
          // 只有辅助函数 render() 的测试能通过。现在参数优先，且与配置走同一条校验。
          maxChars: Number.isSafeInteger(args?.maxChars) && args.maxChars > 0 ? args.maxChars : cfg.maxChars,
          windowChars: args?.windowChars ?? cfg.windowChars,
          minScore: cfg.minScore,
          surfaceNodes: surface,
        })
        if (exec?.callId !== undefined) ownCallIds.add(exec.callId)
        return { text: render(result, records.length) }
      } catch (error) {
        return { text: `${name}: recall failed (${String((error && error.message) || error)}) — continue without it.` }
      }
    },
  })
}
