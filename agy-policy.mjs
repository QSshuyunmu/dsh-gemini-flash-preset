/**
 * agy-policy — 把 persona 里"劝导性"的规则搬到执行层的硬门禁。
 *
 * 为什么需要它：`gemini-3.8-flash` 在长工具链里思考会整段归零（实测 4 轮里 2 轮为 0），
 * 而 persona 的所有规则都活在推理通道里 —— 归零时等于不存在。`tools.guard()` 不需要
 * 模型思考：它只看"模型调了什么工具、传了什么参数"，同步拒绝并给出理由。
 *
 * 源码依据（`dsh-tools`）：
 * ```js
 * register a monotonic guard after the extensible `tools/pre-execute` waterfall.
 * Any matching guard may deny by returning a reason, while no guard can force-allow
 * a call another guard denied.
 * @param guard - synchronous check; a returned string denies the execution.
 * ```
 *
 * 设计约束（这三条踩过坑，必须守）：
 *   1. guard 是**单调**的 —— 写错会硬卡死工作，所以每条策略都能单独关，且有总开关；
 *   2. 拒绝**必须给出可行替代**，否则模型会在被拒点循环；
 *   3. guard **同步执行** —— 只做正则与字符串比较，绝不 I/O。
 *
 * ⚠️ 这不是安全边界。所有策略都是对工具参数的**正则匹配**，能挡住"顺手偷懒"，
 * 挡不住刻意规避（换写法、拆命令、编码后执行）。不要把它当沙箱用，也不要指望它
 * 隔离不可信输入 —— 它存在的目的是让合规行为比作弊更便宜，不是拦截恶意调用。
 */

export const name = 'agy-policy'

/** 必须在 apply 之前拿到 tools 服务，否则 guard 注册会抛错、整个 preset 挂不上。 */
export const inject = ['tools']

const ALLOWED_KEYS = new Set([
  'enabled',
  'denyShellListing',
  'denyProtectedWrites',
  'denyAssertRemoval',
  'denyForcePush',
  'protectedPaths',
])

/** 纯列表/搜索类命令：只认"命令段开头"，避免把 `git ls-files` 之类误判。 */
const LISTING_HEAD = /^\s*(Get-ChildItem|gci|dir|ls|find|findstr|Select-String|rg|grep)\b/i
// Split on statement separators only. A single | must NOT split, otherwise the
// pipeline check below can never see the pipe it is supposed to exempt.
const PROTECTED_DEFAULT = ['.git/', '.dsh/sessions/', '.agent-presets/', 'cordis.patch.yml']
const ASSERT_LINE = /^\s*assert\b/

/**
 * 把一条命令行切成"语句"，**并且在切分时就看引号**。
 *
 * 早先是先 `split(/;|&&|\|\|/)` 再分词 —— 那一步已经把引号边界毁了：
 * `git -C "E:/repo;name" push --force` 会被从引号内部切开，`Write-Output "help; git push …"`
 * 会切出一个以 git 开头的假语句。现在分段与引号处理在同一遍完成。
 */
function splitStatements(command) {
  const out = []
  let cur = ''
  let quote = null
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    // PowerShell's backtick escapes the next character outside single quotes.
    // A backtick-newline is a continuation, not a statement boundary.
    if (ch === '`' && quote !== "'" && i + 1 < command.length) {
      const next = command[i + 1]
      if (next === '\n' || next === '\r') {
        i += 1
        if (next === '\r' && command[i + 1] === '\n') i += 1
      } else {
        cur += ch + next
        i += 1
      }
      continue
    }
    // PowerShell represents a literal single quote inside single quotes as ''.
    if (quote === "'" && ch === "'" && command[i + 1] === "'") {
      cur += "''"
      i += 1
      continue
    }
    if (quote !== null) {
      cur += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === ';' || ch === '\n' || ch === '\r') {
      out.push(cur)
      cur = ''
      continue
    }
    if (ch === '|') {
      // A pipe starts a new command, but the LEFT side must remember that it was piped:
      // `Get-ChildItem ... | Select-Object` is a legitimate metadata query that glob cannot
      // express, and the listing rule exempts piped segments. Keep a marker so the
      // exemption survives segmentation.
      out.push(`${cur} |`)
      cur = ''
      if (command[i + 1] === '|') i += 1
      continue
    }
    if (ch === '&') {
      // `&&` 与单个 `&`（管道到后台）都算语句边界
      out.push(cur)
      cur = ''
      if (command[i + 1] === '&') i += 1
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out.filter((s) => s.trim().length > 0)
}

/** git 全局选项里"后面跟一个值"的那些：解析时必须连同值一起跳过。 */
const GIT_OPTS_WITH_VALUE = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path',
])
/** 出现在 push 之后即视为强推/破坏性推送。 */
const PUSH_FORCE_FLAGS = new Set([
  '--force', '-f', '--force-with-lease', '--force-if-includes', '--mirror',
])

/**
 * 引号感知的简单分词。用正则匹配整条命令太脆 —— `git -C <path> push` 会漏，
 * `echo "git push --force"` 会误报。这里只关心"谁是动词、后面跟了什么"。
 */
function tokenize(command) {
  const out = []
  let cur = ''
  let quote = null
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]
    if (ch === '`' && quote !== "'" && i + 1 < command.length) {
      const next = command[++i]
      if (next === '\r' || next === '\n') {
        if (next === '\r' && command[i + 1] === '\n') i += 1
      } else {
        cur += next
      }
      continue
    }
    if (quote === "'" && ch === "'" && command[i + 1] === "'") {
      cur += "'"
      i += 1
      continue
    }
    if (quote !== null) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (cur.length > 0) {
        out.push(cur)
        cur = ''
      }
      continue
    }
    cur += ch
  }
  if (cur.length > 0) out.push(cur)
  return out
}

/** 判断一段命令是否是"git push 且带强制语义"。只看动词是 git 的段。 */
function isForcePush(segment) {
  let tokens = tokenize(segment)
  // PowerShell 的调用运算符 `&` / `.` 出现在命令前，跳过它们再判断动词
  while (tokens.length > 0 && (tokens[0] === '&' || tokens[0] === '.' || tokens[0].toLowerCase() === 'call')) {
    tokens = tokens.slice(1)
  }
  if (tokens.length < 2) return false
  const verb = tokens[0].toLowerCase()
  const base = verb.replace(/\\/g, '/').split('/').pop()
  if (base !== 'git' && base !== 'git.exe') return false
  let i = 1
  // 跳过 git 的全局选项（含带值的）
  while (i < tokens.length) {
    const t = tokens[i]
    if (GIT_OPTS_WITH_VALUE.has(t)) {
      i += 2
      continue
    }
    if (t.startsWith('-')) {
      i += 1
      continue
    }
    break
  }
  if (i >= tokens.length || tokens[i].toLowerCase() !== 'push') return false
  for (const t of tokens.slice(i + 1)) {
    if (PUSH_FORCE_FLAGS.has(t)) return true
    // 带值的旗标写法：--force-with-lease=refs/heads/main:abc123
    const eq = t.indexOf('=')
    if (eq > 0 && PUSH_FORCE_FLAGS.has(t.slice(0, eq))) return true
    // 以 + 开头的 refspec 本身就是强制推送（+HEAD:main）
    if (t.startsWith('+')) return true
  }
  return false
}

/** 常见工具入参里的路径字段名。 */
const PATH_KEYS = ['file_path', 'path', 'filePath', 'target_file', 'target']

function firstString(args, keys) {
  if (args === null || typeof args !== 'object') return undefined
  for (const k of keys) {
    if (typeof args[k] === 'string' && args[k].length > 0) return args[k]
  }
  return undefined
}

function normalizePath(p) {
  return String(p).replace(/\\/g, '/').toLowerCase()
}

function countAssertLines(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let n = 0
  for (const line of text.split(/\r?\n/)) if (ASSERT_LINE.test(line)) n += 1
  return n
}

/**
 * 评估一次工具调用是否需要拒绝。
 *
 * 导出以便离线测试：输入就是一个 `exec` 形状的对象，不需要真实 host。
 * @param exec - `{ name, arguments }`
 * @param cfg - 已解析的配置
 * @returns 拒绝理由字符串，或 undefined 表示放行
 */
export function evaluate(exec, cfg) {
  if (exec === null || typeof exec !== 'object') return undefined
  if (cfg.enabled !== true) return undefined
  const tool = exec.name
  const args = exec.arguments
  if (typeof tool !== 'string') return undefined

  if (tool === 'pwsh' && cfg.denyShellListing === true) {
    const cmd = args === null || typeof args !== 'object' ? '' : args.command
    if (typeof cmd === 'string' && cmd.length > 0) {
      for (const seg of splitStatements(cmd)) {
        if (!LISTING_HEAD.test(seg)) continue
        // A listing composed into a pipeline (sizes, counts, sorting, formatting) is doing
        // something glob cannot express — denying it would be a false positive that costs
        // the model a round and teaches it to distrust the guard. Only bare listings are
        // redirected.
        if (seg.includes('|')) continue
        return (
          `agy-policy: that is a bare listing/search command, and this session has dedicated tools for it. ` +
          `Use \`glob\` to find files by pattern and \`grep\` to search inside them; both are cheaper and ` +
          `return structured matches. If you need metadata that glob cannot give you (sizes, timestamps), ` +
          `compose the command with a pipeline (e.g. \`Get-ChildItem ... | Select-Object Name,Length\`) ` +
          `and it will be allowed.`
        )
      }
    }
  }

  if (tool === 'pwsh' && cfg.denyForcePush === true) {
    const cmd = args === null || typeof args !== 'object' ? '' : args.command
    if (typeof cmd === 'string' && cmd.length > 0) {
      for (const seg of splitStatements(cmd)) {
        if (!isForcePush(seg)) continue
        return (
          `agy-policy: force-pushing rewrites shared history and is irreversible here. ` +
          `Push normally, or if the history really must be rewritten, report [HONEST_BLOCKED] and ask ` +
          `the USER to confirm in this conversation first.`
        )
      }
    }
  }

  if ((tool === 'write' || tool === 'edit') && cfg.denyProtectedWrites === true) {
    const target = firstString(args, PATH_KEYS)
    if (target !== undefined) {
      const p = normalizePath(target)
      for (const guard of cfg.protectedPaths) {
        if (p.includes(normalizePath(guard))) {
          return (
            `agy-policy: ${target} is host-managed state (${guard}); writing there can corrupt the session ` +
            `store or the preset itself. Make the change through the proper tool or ask the USER to do it.`
          )
        }
      }
    }
  }

  if (tool === 'edit' && cfg.denyAssertRemoval === true) {
    const oldText = args === null || typeof args !== 'object' ? undefined : args.old_string
    const newText = args === null || typeof args !== 'object' ? undefined : args.new_string
    if (typeof oldText === 'string' && typeof newText === 'string') {
      const before = countAssertLines(oldText)
      const after = countAssertLines(newText)
      if (after < before) {
        return (
          `agy-policy: this edit deletes ${before - after} assertion line(s) (${before} -> ${after}). ` +
          `Assertions are the verification; relaxing them to make a run pass is exactly what Integrity Gate 6 ` +
          `forbids. Fix the code, or keep the assertion and report [HONEST_BLOCKED] with the measured numbers.`
        )
      }
    }
  }

  return undefined
}

export function apply(ctx, config) {
  const raw = config === undefined ? null : config
  if (raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
    throw new TypeError(`${name}: config must be an object`)
  }
  const src = raw ?? {}
  const unknown = Object.keys(src).filter((k) => !ALLOWED_KEYS.has(k))
  if (unknown.length > 0) {
    throw new TypeError(`${name}: unknown config key(s) ${unknown.join(', ')} — allowed: ${[...ALLOWED_KEYS].sort().join(', ')}`)
  }
  const protectedPaths = Array.isArray(src.protectedPaths) && src.protectedPaths.length > 0
    ? src.protectedPaths.filter((p) => typeof p === 'string' && p.length > 0)
    : PROTECTED_DEFAULT

  const cfg = Object.freeze({
    enabled: src.enabled !== false,
    denyShellListing: src.denyShellListing !== false,
    denyProtectedWrites: src.denyProtectedWrites !== false,
    denyAssertRemoval: src.denyAssertRemoval !== false,
    denyForcePush: src.denyForcePush !== false,
    protectedPaths: Object.freeze(protectedPaths.slice()),
  })

  if (cfg.enabled !== true) {
    // Kill switch: register nothing at all, so a bad policy can be turned off by editing
    // one line of config instead of pulling the whole preset.
    try {
      ctx.logger?.warn?.(`${name}: disabled by config — no tool guards registered`)
    } catch {
      /* logging must never break mounting */
    }
    return
  }

  ctx.tools.guard((exec) => {
    try {
      return evaluate(exec, cfg)
    } catch {
      // A guard that throws must not block work; failing open is the safe direction here.
      return undefined
    }
  })
}
