/**
 * agy-diff-guard — 复刻 Google Antigravity 的 UnifiedDiff 编辑回显认知收益。
 *
 * 观察依据（来自发布产物中的 proto 定义）：AGY 在
 * third_party/jetski/diff_action_pb/diff_action.proto 中定义了
 * exa.diff_action_pb.UnifiedDiff，每次文件编辑后都把带物理行号的 diff 回传给模型。
 * 普通 API 调用只回一句「已修改」，模型丢失行号位移感知，于是同一文件第 2~3 次
 * 编辑常常锚点失配、陷入 20+ 次盲改（对应 anti-gemini-contract 的 D7 病理）。
 *
 * 本插件挂在 `tools/post-execute`（工具结果的 waterfall，签名与
 * @deepseek-ai/dsh-repeat-tool-reminder 一致）：
 *     ctx.on('tools/post-execute', async (exec, result, next) => decision)
 * 其中 decision 形如 { ...result, additionalContexts?: Message[] }。
 *
 * 两种模式（config.mode）：
 *   - observe（默认）：只计算 diff 摘要并写 logger，绝不触碰工具结果。零风险，
 *     用于验证钩子是否真的触发、参数名是否如预期。
 *   - inject：把 diff 作为 additionalContexts 注入模型上下文。
 *     ⚠️ 注入用的 Message 形状未经运行时实测（依赖宿主的 createMessage 补 id/
 *     时间戳），因此在观察模式确认行为正常前不应启用。
 *
 * 安全性：apply() 只做参数校验与一次性注册；全部逻辑在 listener 内 try/catch，
 * 任何异常都原样返回 downstream —— 绝不让本插件把一个成功的工具调用变成失败。
 */

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'agy-diff-guard'

import { randomUUID } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

/** 本插件接受的配置键，其余视为拼写错误。 */
const ALLOWED_KEYS = new Set(['mode', 'watchTools', 'maxDiffLines', 'circuitBreakerEdits', 'physicalLines'])

const DEFAULT_KEYS = {
  mode: 'observe',
  watchTools: ['edit', 'write'],
  maxDiffLines: 40,
  circuitBreakerEdits: 5,
  physicalLines: true,
}

/** 快照读取上限：超过就放弃物理行号，退回块级行数（避免把大文件读进内存）。 */
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
/** 每个 agent 最多缓存多少份快照；多余的按插入顺序淘汰。 */
const MAX_SNAPSHOTS = 16

/** 常见工具入参里可能的路径字段名，按优先级探测。 */
const PATH_KEYS = ['path', 'file_path', 'filePath', 'TargetFile', 'target', 'target_file']
/** 常见工具入参里可能的「替换前 / 替换后」字段名。 */
const OLD_KEYS = ['old_string', 'oldString', 'old_str', 'oldText', 'find']
const NEW_KEYS = ['new_string', 'newString', 'new_str', 'newText', 'replace']
/** 整文件写入时可能的内容字段名。 */
const CONTENT_KEYS = ['content', 'CodeContent', 'text', 'data']

/**
 * 对「同文件连续编辑」计数**透明**的工具：既不加一也不清零。
 *
 * persona 第 V 节强制模型在每次 edit 后用 `read` 复核、用 `todo_write` 记账，所以
 * 这些调用是编辑循环的一部分而非进展。若把它们当成重置信号，真实的单文件死磕
 * （edit → read → edit → read …）会被洗白，D7 熔断永远不会触发。
 * 反之 `pwsh`（跑测试）、`subagent`、`job_*` 等代表实质推进，才允许重置计数。
 */
const TRANSPARENT_TOOLS = new Set(['read', 'read_image', 'grep', 'glob', 'todo_write', 'ask_user_question'])

/**
 * Like {@link pick}, but accepts an EMPTY string.
 *
 * `new_string: ""` is a legitimate edit: it deletes the matched text. The strict
 * `pick` requires length > 0, so it reported "field missing" and the guard silently
 * skipped both the diff and the streak count (Astra review 2026-10-29). Paths still
 * use the strict variant, where an empty value is genuinely invalid.
 */
function pickText(args, keys) {
  if (args === null || typeof args !== 'object') return undefined
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

function pick(args, keys) {
  if (args === null || typeof args !== 'object') return undefined
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function lineCount(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  return text.split(/\r?\n/).length
}

/**
 * 判断一次工具执行是否失败。
 *
 * 这一步至关重要：如果 edit 因旧字符串不唯一/未找到而失败（或因为没先 read 被拒），
 * 文件根本没变，模型参数里的 old/new 只是它自己的意图。此时若仍按入参拼出
 * 「Δ +N 行」的 diff，等于向模型伪造一个不存在的行号位移，会把它推向更深的盲改。
 * 因此失败必须短路：不产出任何 diff 反馈。
 */
function isFailure(value) {
  if (value === null || typeof value !== 'object') return false
  if (value.isError === true) return true
  if (value.result !== null && typeof value.result === 'object' && value.result.isError === true) return true
  if (value.error !== undefined && value.error !== null) return true
  if (value.feedback !== undefined && value.kind === 'block') return false
  return false
}

/**
 * 由 edit 的旧/新字符串构造一段带行号语义的 diff 摘要。
 * 不含真实文件前缀行号（那需要编辑前快照），但给出精确的块级增删与行数位移。
 */
function buildEditDiff(oldText, newText, maxLines, location) {
  const removed = oldText.split(/\r?\n/)
  const added = newText.split(/\r?\n/)
  const delta = added.length - removed.length
  const header = location && Number.isSafeInteger(location.startLine)
    ? `@@ -${location.startLine},${removed.length} +${location.startLine},${added.length} @@ (Δ ${delta >= 0 ? '+' + delta : delta})`
    : `@@ -${removed.length} lines +${added.length} lines @@ (Δ ${delta >= 0 ? '+' + delta : delta})`
  const out = [header]
  for (const line of removed.slice(0, maxLines)) out.push('-' + line)
  if (removed.length > maxLines) out.push(`- … (${removed.length - maxLines} more removed lines)`)
  for (const line of added.slice(0, maxLines)) out.push('+' + line)
  if (added.length > maxLines) out.push(`+ … (${added.length - maxLines} more added lines)`)
  if (location && typeof location.note === 'string' && location.note.length > 0) out.push(location.note)
  return out.join('\n')
}

/**
 * 读文件正文；**先 stat 再读，且读取有界**。
 *
 * 早先的实现是 `readFile` 之后再检查 ByteLength —— 那对大文件毫无保护，整个文件
 * 已经在内存里了，而且发生在工具执行之前。现在先取 stat.size 判断，再用
 * open + 定长 read，最多只分配 MAX_SNAPSHOT_BYTES 字节。
 */
async function readTextSafe(filePath) {
  let info
  try {
    info = await stat(filePath)
  } catch {
    return undefined
  }
  if (!info.isFile() || info.size > MAX_SNAPSHOT_BYTES) return undefined
  let handle
  try {
    handle = await open(filePath, 'r')
    const buf = Buffer.allocUnsafe(Math.max(1, info.size))
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } catch {
    return undefined
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close()
      } catch {
        /* closing must never throw into the hook */
      }
    }
  }
}

/**
 * 在 `haystack` 里定位 `needle` 的起始行号（1 基）。
 * 只做精确逐行匹配：行首尾空白差异会导致匹配失败，那时宁可退回块级行数，
 * 也不要给出一个错误的物理行号 —— 错误的坐标系比没有坐标系更有害。
 */
function locateStartLine(needle, haystack) {
  if (typeof needle !== 'string' || typeof haystack !== 'string') return undefined
  const strip = (s) => (s.endsWith('\n') ? s.slice(0, -1) : s)
  const needleLines = strip(needle).split(/\r?\n/)
  if (needleLines.length === 0 || needleLines[0].length === 0) return undefined
  const hayLines = haystack.split(/\r?\n/)
  const first = needleLines[0]
  const limit = hayLines.length - needleLines.length
  for (let i = 0; i <= limit; i += 1) {
    if (hayLines[i] !== first) continue
    let ok = true
    for (let k = 1; k < needleLines.length; k += 1) {
      if (hayLines[i + k] !== needleLines[k]) {
        ok = false
        break
      }
    }
    if (ok) return i + 1
  }
  return undefined
}

/** 由整文件写入的内容构造摘要（无旧内容可比，只报告规模）。 */
function buildWriteSummary(content, maxLines) {
  const lines = content.split(/\r?\n/)
  const head = lines.slice(0, Math.min(maxLines, 3))
  const tail = lines.length > 3 ? lines.slice(-2) : []
  const out = [`@ write ${lines.length} lines`]
  for (const line of head) out.push('+' + line)
  if (lines.length > 5) out.push('+ …')
  for (const line of tail) out.push('+' + line)
  return out.join('\n')
}

export function apply(ctx, config) {
  const source = config === undefined ? {} : config
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new TypeError(`${name}: config must be an object`)
  }
  const unknown = Object.keys(source).filter((key) => !ALLOWED_KEYS.has(key))
  if (unknown.length > 0) {
    throw new TypeError(`${name}: unknown config key(s) ${unknown.join(', ')} — allowed: ${[...ALLOWED_KEYS].sort().join(', ')}`)
  }

  const mode = source.mode ?? DEFAULT_KEYS.mode
  if (mode !== 'observe' && mode !== 'inject') {
    throw new TypeError(`${name}: mode must be "observe" or "inject"; got ${JSON.stringify(mode)}`)
  }
  const watchTools = source.watchTools ?? DEFAULT_KEYS.watchTools
  if (!Array.isArray(watchTools) || watchTools.length === 0 || watchTools.some((t) => typeof t !== 'string' || t.length === 0)) {
    throw new TypeError(`${name}: watchTools must be a non-empty array of non-empty strings`)
  }
  const maxDiffLines = Number.isSafeInteger(source.maxDiffLines) && source.maxDiffLines > 0
    ? source.maxDiffLines
    : DEFAULT_KEYS.maxDiffLines
  const circuitBreakerEdits = Number.isSafeInteger(source.circuitBreakerEdits) && source.circuitBreakerEdits > 1
    ? source.circuitBreakerEdits
    : DEFAULT_KEYS.circuitBreakerEdits

  const watched = new Set(watchTools)
  /** 每个 agent 的「同一文件连续编辑」计数：WeakMap<Agent, { path, count }>。 */
  const chains = new WeakMap()
  /** 每个 agent 的编辑前快照：WeakMap<Agent, Map<path, text>>，用完即弃。 */
  const snapshots = new WeakMap()
  const physicalLines = source.physicalLines !== false

  const storeSnapshot = (exec, filePath, text) => {
    if (!exec || !exec.agent) return
    let map = snapshots.get(exec.agent)
    if (map === undefined) {
      map = new Map()
      snapshots.set(exec.agent, map)
    }
    // 有界缓存：write 与失败编辑没有"取走"这一步，若不封顶会随文件数增长。
    if (map.size >= MAX_SNAPSHOTS && !map.has(filePath)) {
      const oldest = map.keys().next()
      if (!oldest.done) map.delete(oldest.value)
    }
    map.set(filePath, text)
  }

  const takeSnapshot = (exec, filePath) => {
    if (!exec || !exec.agent) return undefined
    const map = snapshots.get(exec.agent)
    if (map === undefined) return undefined
    const text = map.get(filePath)
    map.delete(filePath)
    return text
  }

  /** 无论成功/失败/是否用到，都必须在 post-execute 结束时释放。 */
  const dropSnapshot = (exec, filePath) => {
    if (!exec || !exec.agent || filePath === undefined) return
    const map = snapshots.get(exec.agent)
    if (map !== undefined) map.delete(filePath)
  }

  const log = (level, message) => {
    try {
      const logger = ctx.logger
      if (logger && typeof logger[level] === 'function') logger[level](message)
    } catch {
      // logger 不可用属于正常降级，静默即可
    }
  }

  // ── 编辑前快照：这是"物理行号"的唯一来源 ────────────────────────────────────
  // post-execute 只有 old_string/new_string，无法知道它们落在文件第几行。先在
  // pre-execute 读一次原文件，编辑后就能精确定位，并顺带核验写入是否真的落盘。
  // 形状防御：不管宿主传 (exec, next) 还是别的形状，找出其中的函数当 next 调用，
  // 并且快照失败绝不阻断工具执行。
  ctx.on('tools/pre-execute', async (...args) => {
    const next = args.find((a) => typeof a === 'function')
    const exec = args[0]
    try {
      if (physicalLines && exec && watched.has(exec.name)) {
        const filePath = pick(exec.arguments, PATH_KEYS)
        // 相对路径**不拍快照**：宿主按会话工作目录解析，而这里按 Node 进程目录解析，
        // 两者可能指向不同文件 —— 那会产出一个看似合理但完全错误的行号。
        if (filePath !== undefined && isAbsolute(filePath)) {
          const text = await readTextSafe(filePath)
          if (text !== undefined) storeSnapshot(exec, filePath, text)
        }
      }
    } catch (error) {
      log('warn', `${name}: pre-execute snapshot skipped: ${String((error && error.message) || error)}`)
    }
    if (typeof next === 'function') return next()
    return undefined
  })

  /**
   * 计算物理行号与落盘核验。拿不到快照或定位失败时返回 undefined，
   * 调用方退回块级行数 —— 宁可没有坐标系，也不给错误的坐标系。
   */
  const physicalLocation = async (exec, filePath, oldText, newText) => {
    if (physicalLines !== true) return undefined
    if (!isAbsolute(filePath)) {
      return {
        startLine: undefined,
        note: '! relative path: no physical line number is claimed, because the snapshot would resolve from the host process cwd rather than the session cwd.',
      }
    }
    const before = takeSnapshot(exec, filePath)
    if (before === undefined) return undefined
    const startLine = locateStartLine(oldText, before)
    if (startLine === undefined) {
      return {
        startLine: undefined,
        note: '! old_string was not found in the pre-edit snapshot, so no physical line number is claimed (the tool may match loosely, or the file changed under us).',
      }
    }
    let note
    const after = await readTextSafe(filePath)
    if (after !== undefined && after === before) {
      // Byte-identical to the snapshot: whatever the tool reported, no bytes changed.
      // Comparing against the snapshot is exact and produces no false positives, unlike
      // probing for a line of the new content (which often already exists elsewhere).
      note = '! the file is UNCHANGED after this edit (byte-identical to the pre-edit snapshot) — the write did not land; re-read the file before assuming the change exists.'
    }
    return { startLine, note }
  }

  ctx.on('tools/post-execute', async (exec, _result, next) => {
    const downstream = await next()
    let cleanupPath
    try {
      if (!exec) return downstream
      if (!watched.has(exec.name)) {
        // 透明的核验/记账类工具不清零；其余（pwsh 跑测试、subagent、job_* …）
        // 视为实质推进，重置同文件盲改计数。
        if (exec.agent && !TRANSPARENT_TOOLS.has(exec.name)) chains.delete(exec.agent)
        return downstream
      }
      // 工具失败 = 文件未改变 = 行号未位移：绝不产出 diff（否则是伪造坐标系）。
      // 但失败**照常计数** —— 行号漂移导致 old_string 连续匹配失败，正是最该被熔断
      // 的盲改循环；只在成功时计数会让 D7 在最需要它的场景下永远不触发。
      const failed = isFailure(_result) || isFailure(downstream)
      const args = exec.arguments
      const filePath = pick(args, PATH_KEYS)
      if (filePath === undefined) return downstream
      // 无论后面走哪个分支（成功/失败/write），快照都要在 finally 里释放。
      cleanupPath = filePath

      const oldText = pickText(args, OLD_KEYS)
      const newText = pickText(args, NEW_KEYS)
      const content = pickText(args, CONTENT_KEYS)

      let body
      if (!failed && oldText !== undefined && newText !== undefined) {
        const location = await physicalLocation(exec, filePath, oldText, newText)
        body = buildEditDiff(oldText, newText, maxDiffLines, location)
      } else if (!failed && content !== undefined) {
        body = buildWriteSummary(content, maxDiffLines)
      }

      // 同一文件连续编辑计数（用于 D7 熔断提示）
      let streak = 1
      if (exec.agent) {
        const prev = chains.get(exec.agent)
        streak = prev !== undefined && prev.path === filePath ? prev.count + 1 : 1
        chains.set(exec.agent, { path: filePath, count: streak })
      }

      // A failed call changed no bytes, so it gets no diff — but it still counts, and a
      // long run of failures is the blind-edit loop D7 exists to break.
      if (body === undefined && !(failed && streak > circuitBreakerEdits)) return downstream

      const breaker = streak > circuitBreakerEdits
        ? `\n[D7 CIRCUIT BREAKER] This is edit #${streak} in a row on the same file. Stop grinding: write a minimal reproduction, state your hypothesis, or report [HONEST_BLOCKED].`
        : ''

      const headline = failed
        ? `[AGY Diff Feedback — ${filePath} (edit FAILED: no bytes changed, no diff)]`
        : `[AGY UnifiedDiff Feedback — ${filePath}]`
      const text = body === undefined ? `${headline}${breaker}` : `${headline}\n${body}${breaker}`

      if (mode === 'observe') {
        // 零风险：只落 logger，绝不改动工具结果
        log('info', `${name}: ${exec.name} ${filePath} streak=${streak} failed=${failed} ${(body ?? '').split('\n')[0]}`)
        return downstream
      }

      // inject：作为附加上下文注入。
      // 形状对齐 dsh-repeat-tool-reminder 的参考实现（已从 app.asar 核实）：
      //   createUserMessage({ content:[{type:'text',text}], source:{kind, form:'notice', summary} })
      // 其内部 createMessage = {...input, role:'user', id: randomUUID()}，并 deepFreeze。
      // **id 是必需的**：宿主用它给消息一个稳定身份，缺失会导致下游校验/派生失败。
      // source.kind 同样必需 —— 注释原文："an unlabeled context would render as a
      // user prompt in derived history"。
      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'agy-diff-guard', form: 'notice', summary: `${exec.name} ${filePath} × ${streak}` },
      }
      return { ...downstream, additionalContexts: [message, ...(downstream.additionalContexts ?? [])] }
    } catch (error) {
      // 任何异常都必须原样放行：本插件绝不能让一次成功的工具调用变成失败
      log('warn', `${name}: skipped diff feedback: ${String((error && error.message) || error)}`)
      return downstream
    } finally {
      // 成功编辑已由 physicalLocation 取走；write / 失败编辑 / 提前 return 都不会取，
      // 所以统一在这里收尾，避免快照随文件数累积。
      dropSnapshot(exec, cleanupPath)
    }
  })
}
