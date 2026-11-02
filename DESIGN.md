# agy-gemini — Gemini Flash 调优 · 纪律优先

> **English summary.** These are the design notes behind the preset: how each mechanism
> was derived, what was measured, and — at length — what turned out to be wrong. It is a
> working record, not a specification. Several conclusions below are explicitly superseded,
> and where they are, the correction sits beside them. The authoritative statement of what
> the preset currently does is `agent.cordis.yml`; the reader-facing summary is `README.md`.

> ⚠️ **本目录不是 DSH 的加载位置，只是设计稿归档。**
> `@deepseek-ai/dsh-agent-preset-registry` 官方说明明确写着「注册表不扫描目录，也不接受
> preset 路径」，所以把文件放进 `.agent-presets/` 不会出现在预设选择器里
> （`minimal-compact` / `heyan` 就是这么失效的）。

> ⚠️ **历史记录：本文部分结论已被当日晚些的实测推翻。** 保留它是因为推断过程本身有价值，
> 但**不要直接引用其中的数字**。已知过期项：
>
> - 「撞上游 429 的水位约 275k」→ **已证伪**。四针探针实测 **959,863 token 完整可用**。
> - 「压后约 45k、`thresholdRatio 0.15`、`retainTokens 12000`」→ 现为 **`0.30` / `30000`**，压后约 106k。
> - 「CI-2 强制复述机制有效」→ **无效**；两个档位的思考里关键词都是 0 命中。
> - 「`session_recall` 尚未实现」→ **已实现并验证**（10/10 全对，四个探针全靠召回救回）。
> - 「CPA 的 `-high` 通道没有 reasoning」→ **错**；带工具的长会话里有 4,116 字符推理。
>
> **当前有效结论以 `README.md` 为准。**
>
> **生效配置在两处：**
> 1. `<USERPROFILE>\.dsh\profiles\<profile>\cordis.patch.yml` 末尾
>    `# >>> agy-gemini preset (managed block) >>>` 区块 —— 真正被加载的
>    `@deepseek-ai/dsh-agent-preset` 行，22 个插件行内联其中；
> 2. `<USERPROFILE>\.dsh\profiles\<profile>\agy-gemini\*.mjs` —— 8 个本地模块
>    （其中 7 个由预设挂载，`compaction-epoch.mjs` 被其余模块 import），
>    补丁中的 `./agy-gemini/*.mjs` 相对于补丁文件解析到这里。
>
> **改配置请改 profile 补丁，不要改本目录的 `agent.cordis.yml`**（仅作阅读基准；若漂移以补丁为准）。

机制取自对 **Google Antigravity CLI 1.4.9** 的行为观察与解耦。本仓库不含该产品的
任何代码或提示词原文；下文记录的是观察到的行为模式，并以本仓库自己的措辞重新实现。

## 如何启用 / How to enable

1. **完整重启 DSH**（退出客户端再启动，不是只按 F5）—— profile 补丁在宿主组合启动时生效；
2. 新建会话时在「Agent 预设」选择器里选 **Gemini Flash 调优 · 纪律优先**；
3. 模型建议搭配 `aistudio-local / gemini-4-argon(high)`（满血思维链）或
   `antigravity / gemini-3.8-flash-high`（高吞吐）。

## 它和默认预设差在哪 / How it differs from the default

| 维度 | 默认 | agy-gemini |
| :--- | :--- | :--- |
| 系统提示词 | 内置通用 | AGY 风格的身份宏（措辞已重写，不复制原文）+ `CRITICAL INSTRUCTION 1&2` 思考块锚定 + `<PLAN>` 双工件协议 + 七条防偷懒硬门禁（`complete: true`，无任何追加注入） |
| 首请求工具目录 | 全量 | 仅 8 个原子工具（对齐 AGY 拓扑），之后再收敛到 resident 集 |
| resident 集 | 全量常驻 | `read/edit/write/grep/glob/pwsh/todo_write/ask_user_question` + `dev_tool_search/skill_search/skill_load`；`subagent`/`web`/`goal`/`jobs` 需 `dev_tool_search` 解锁 |
| 上下文压缩 | `thresholdRatio: 0.5`（1M 窗口 → 500k 才压），`retainRatio` 默认约 0.4 | `thresholdRatio: 0.30` + `retainTokens: 30000`（1M 窗口 → **约 300k 触发、压后保留约 106k**） |
| 工具结果剪裁 | 8192 / 4096 / 1024 | **6144 / 3584 / 1024**（更贴近 AGY「大输出不进下一轮」） |

## 三条可调旋钮 / Three tuning knobs

都在 `agent.cordis.yml`：

1. **`compaction-basic.thresholdRatio` + `retainTokens`**（现 `0.30` / `30000`）
   - ⚠️ **这两个值必须成对调整**，有三个硬约束：
     - 阈值按 `contextWindow` 比例算，Gemini 在 `cordis.patch.yml` 里标为 `1000000`；
     - 保留量默认是比例（`retainRatio` 约 `0.4`），只改 threshold 会让压缩后仍保留约 37 万
       tokens，下一轮立刻再次越线，形成「每轮压缩」抖动；
     - **`retainRatio` 与 `retainTokens` 互斥**，同时给出会直接抛错
       （`compaction-basic.js:192`）；校验还要求 `retainRatio < thresholdRatio`。
   - 想更早收敛 → `0.20 / 20000`；想少丢细节 → `0.40 / 60000`。
   - 为什么不压到 AGY 的 15k~30k：AGY 有 SQLite FTS5 + BM25 无损召回，DSH 只有
     **有损摘要**，阈值过低会让早期函数签名与报错行号在几次压缩后永久丢失。

2. **`tool-bootstrap.bootstrapTools`**（现 8 个原子工具）
   - 只有这 8 个名字缺失时才会**回退到全量目录**（fail-soft）；`exit_plan_mode`、
     `dev_tool_search` 与模型解锁出来的名字属于「存在即保留」，拼错只会被静默丢弃，
     不会触发全目录回退。

3. **`tool-result-pruner`**（`thresholdChars/headChars/tailChars`）
   - 单次工具输出超过 `thresholdChars` 时只保留头 `headChars` + 尾 `tailChars`。

## 增补项实现状态（全部已处理） / Extra items: all handled

权威依据：解析 `app.asar` 中的 `dsh-base/cordis.patch.yml`（全局组合）与
`dsh-web-app/presets/standard.patch.yml`（内置 standard 预设），逐项判定。

### 已加入本预设 / Included here

| 项 | 实现方式 |
| :--- | :--- |
| **workflows** | 用正确的插件名 `@deepseek-ai/dsh-workflow-ptc`（`provider: spawn`）+ `tool-workflow`，并恢复 `isolate: workflowEngine`。**早期预设写的 `dsh-workflow-worker-thread` 在当前 DSH 版本已不存在** —— 这正是 `minimal-compact` 的 workflow 组解析不了的根因。 |
| **plan mode** | ~~`@deepseek-ai/dsh-plan-mode`~~ **已于 2026-10-29 移除**：它在工具层零强制，且 `persona.complete = true` 会抹掉它的 `plan:policy` 章节，两条叠加后 plan mode 完全失效。审批闸门改由 persona 的 `<PLAN>` 协议承担。 |
| **tool-present** | `@deepseek-ai/dsh-tool-present`（交付物卡片） |
| **tool-schedule** | `@deepseek-ai/dsh-tool-schedule`（定时任务） |
| **command-goal** | `@deepseek-ai/dsh-command-goal`（`/goal` 命令） |
| **UnifiedDiff 回显** | 自研 `agy-diff-guard.mjs`，挂 `tools/post-execute`。**默认 `mode: observe`**：只算 diff 写 logger，零风险；确认钩子触发正常后改 `mode: inject` 才注入上下文。 |

### 确认已在 dsh-base 全局挂载，故刻意不重复挂 / Already global in dsh-base, deliberately not re-mounted

| 项 | 证据 |
| :--- | :--- |
| `repeat-tool-reminder` | base 中 `- id: repeat-tool-reminder`，默认在重复 **3/5/8** 次时提醒 —— 恰好为 persona 的「5 次编辑熔断」提供了宿主级兜底 |
| `compaction-image-offload` | base 已挂载；其文档明写「本插件没有配置」 |
| `spill-policy` / `spill-local` | base 中 `- id: spill-local`、`- id: spill-policy` |
| `tool-working-directory` | base 中 `- id: tool-working-directory` |
| `tool-workspace-dependencies` | 未在 base/standard 明文列出，但当前会话已具备该工具，说明由宿主侧提供 |

> 重复挂载同一宿主级处理链插件会造成双重注册，因此宁可缺省也不叠加。

### 仍未启用 / Still disabled

| 项 | 原因 |
| :--- | :--- |
| `warmup-replay` | `replay.json` 是为另一套 persona 录制的思维范式，复用会注入冲突上下文。文件已保留，需要时可加回该行。 |
| `agy-diff-guard` 的 `inject` 模式 | 注入用的 `Message` 形状依赖宿主 `createMessage` 补 `id`/时间戳，未实测前不启用；且 `tools/execute` 会把异常转成工具错误结果，盲开会污染工具结果。 |

## 校验状态（已执行） / Verification performed

- YAML 解析通过（含 `!!js` 自定义 tag）；
- `tool-bootstrap` 确认为**第一行**（硬约束）；
- 7 个本地 `.mjs` 引用全部存在；8 个 `.mjs` 通过 `node --check`；
- 22 个 `@deepseek-ai/*` 插件名全部在 `app.asar` 中可解析。

### 机制级 schema 审计 / Per-plugin schema audit, against `Config = z.object({...})`

| 插件 | 真实 schema 要点 | 本预设写法 | 结论 |
| :--- | :--- | :--- | :--- |
| `dsh-persona` | `prefix`(**必填**) / `suffix` / `complete` / `includeRuntimeContext`；**无 `text` 字段** | `prefix` + `complete` + `includeRuntimeContext` | ✅ 已修复（初版误用 `text`，会因 prefix 缺失挂载失败） |
| `dsh-tool-subagent` | `provider`(**必填**) / `toolName` / `modelSelectionSettings` / `agentOptions` / `maxDepth` | `provider: spawn` + `toolName` + `modelSelectionSettings` | ✅ |
| `dsh-tool-web` | `search` / `fetch` / `searchTimeoutMs` / `fetchTimeoutMs` … | `fetch: true` + `searchTimeoutMs` | ✅ |
| `dsh-compaction-basic` | `thresholdRatio` / `headroomTokens` / `retainRatio` / `retainTokens`（后两者互斥） | `thresholdRatio: 0.30` + `retainTokens: 30000` | ✅ |
| `dsh-compaction-tool-result-pruner` | `thresholdChars` / `headChars` / `tailChars` | 6144 / 3584 / 1024 | ✅ |
| `dsh-workflow-ptc` | `provider` / `maxConcurrentAgents` … | `provider: spawn` | ✅ |
| `dsh-plan-mode` | 无严格 schema，实际读取 `config.section` | `section` 多行标量 | ✅ |
| `dsh-tool-schedule` / `dsh-tool-present` / `dsh-tool-workflow` | 全部字段可选 | 未传 config | ✅ |

**副产物结论**：`minimal-compact` 与 `heyan` 之所以在现行 DSH 上不可用，至少有两个独立根因 ——
① persona 用了不存在的 `text` 字段（`prefix` 缺失导致挂载失败）；
② delegation 组引用了已不存在的 `dsh-workflow-worker-thread`。

## AI Studio Gemini 4 Argon（高推理）验收记录 / Review rounds

派 `gemini-4-argon(high)` 子代理做三轮对抗式审查，结论演进：

| 轮次 | 结论 | 指出问题 |
| :--- | :--- | :--- |
| 第 1 轮 | `READY_WITH_FIXES` | P0-1 `exit_plan_mode` 被 bootstrap 过滤 → plan mode 死锁；P0-2 `dev-tool-search` 硬编码描述了本预设没有的 `bash`/`str_replace_editor`；P0-3 压缩后续跑轮丢失 `dev_tool_search` 与已解锁工具；P0-4 diff-guard 未区分工具失败、熔断计数被普通工具清零；另指出 skills 与本预设冲突、缺 `Walkthrough` 工件、`retainRatio` 未配对 |
| 第 2 轮（复审） | `READY_WITH_FIXES` | 4 项 P0 已闭合，但修复引入 2 项新缺陷：P1-1 `keepTools` 会把模型拼错的解锁名当作"phase tool 缺失"而回退全目录；P1-2 `chains.delete` 让 D7 熔断失效且失败也清零 |
| 第 3 轮（终审） | **`READY`** | 两项 P1 已闭合，无新缺陷 |

关键修复：
1. `tool-bootstrap.mjs` 新增 `ALWAYS_RESIDENT_TOOLS = ['exit_plan_mode']`，并在压缩后续跑轮并入发现工具与 `unlockedFor`；
2. `keepTools` 改为 4 参 `(assembled, keep, required, allowFullFallback)`，`missing` 只从 `bootstrapTools` 计算；
3. `agy-diff-guard.mjs` 新增 `isFailure()` 短路与 `TRANSPARENT_TOOLS`（`read/grep/glob/todo_write/ask_user_question` 对计数透明）；
4. `dev-tool-search.mjs` 的工具清单对齐本预设真实挂载；
5. 删除与本预设互斥的 `skills/` 及 `customSkillDirs`；persona 补 `WALKTHROUGH.md`。

## 冒烟测试建议（首次启用后） / Smoke tests after first enable

1. **锚定验证**：新会话问一个普通问题，检查回复前的思考块是否出现
   `CRITICAL INSTRUCTION 1/2` 与 `[Routine: ...][Phase: ...]` 字样；
2. **工具收敛验证**：~~确认首轮可用工具不超过 8 个；观察 `subagent` 是否需
   `dev_tool_search` 才能调用~~ → **此条已于 2026-10-29 证伪并移除，见下节**；
3. **上下文压制验证**：连续跑 20+ 轮读大文件任务，检查会话上下文是否在约 45k
   附近触发压缩（状态栏上下文百分比不应逼近 100%）；
4. **诚实报阻验证**：给一个物理不可达的验收标准，确认模型输出 `[HONEST_BLOCKED]`
   而不是删改断言。

## ❗ 本节结论已被推翻 / Superseded (2026-10-29, second review)

**下面这段是当时的错误判断，保留作为记录。真实根因见文末《真因修正》。**

一句话：`assembly.tools` **是存在的**（`dsh-system-prompt` 的 `assemble()` 里
`tools: orderTools(collected, this.toolOrder, knownNames)`），所以 `tool-bootstrap` 的过滤
本来就能工作；34 个工具的真因是 `compaction-epoch.mjs` 迭代了**已被移除**的
`session.events`（DSH 2026-09-09 废弃同步读取，改为 `snapshotEvents()`），
`for…of undefined` 抛错 → `status()` 抛错 → assemble 钩子 catch → 回退全量目录。
子代理之所以是 12 个，是因为 `status()` 对 `delegationDepth>0` 在 `scan()` 之前就短路了。

**已修**：`readSessionEvents()` 兼容读取 + 恢复 `dev-tool-search`（它是解锁信号的持久记录，
不是装饰品）+ 删除多余的 `agy-tool-restrict`。

---

## ⚠️ 已证伪的机制：resident 工具收敛与「按需解锁」是空转 / Falsified: resident narrowing and on-demand unlock were no-ops

**结论：`tool-bootstrap` 的工具收窄从未生效，`dev-tool_search` 是装饰性工具。**

证据来自 DSH 自己的会话存档（`~/.dsh/sessions/--E-agy-test--/*/session.v4.jsonl.zstd`），
其 `request/header` 事件记录了**首次请求实际发出的工具目录**：

```
preset=agy-gemini  model=aistudio-local/gemini-3.8-flash
first-request tool catalog (34): [ask_user_question, create_goal, dev_tool_search, edit,
  exit_plan_mode, get_goal, glob, grep, interrupt_agent, job_kill, job_list, job_output,
  list_agents, load_workspace_dependencies, present, pwsh, read, read_image, schedule_create,
  schedule_delete, schedule_list, schedule_update, send_message, skill_load, skill_search,
  subagent, subagent_fork, todo_write, update_goal, web_fetch, web_search, workflow,
  working_directory, write]
```

**34 个 = 全量目录**，不是设计中的 8 个。原因链：

1. `tool-bootstrap.mjs` 靠 `ctx.on('system-prompt/assemble', …)` 的 `decision.tools` 过滤；
2. DSH 的 `system-prompt/assemble` **只装配提示词变量、不含 tools**
   （见 `dsh-agent/lib/index.js` 的 `installModelSelection`，它只返回 `{...assembled, variables}`）；
3. DSH 这一代**没有装配工具目录的 waterfall**；唯一相关入口是 `tools.restrict({allow, deny})`，
   但它**要求 agent 作用域**（`agent.ctx`），且是静态集合、无法随轮次动态收窄；
4. 过滤分支从未命中，插件静默 no-op（不报错，因为"返回原样"就是它的降级路径）。

`dev-tool-search.mjs` 同理：它的 `execute` 只 `return { text: 'Unlocked for the next request: …' }`，
**从不调用 `ctx.tools.register()`**。所谓"解锁"只是回一句话，工具本来就在目录里。

**已做的处置：**

- 移除 `dev-tool-search` 插件行（当时为 20 个插件；现行清单为 22 个），不再让模型为一个空操作浪费一轮；
- 重写 persona 工具段落：明确"全量目录已加载、没有需要解锁的工具、
  `skill_search`/`skill_load` 只是技能发现辅助"，**不再对模型陈述假前提**；
- 保留 `tool-bootstrap` 行：它同时注册的 `agent/pre-step` 消息过滤器（剥离
  AGENTS.md 与技能目录注入）走真实事件，那部分仍有效。

**同时修正一个曾经的误判**：test03 里反复出现的 `dev_tool_search` 调用，
证明的是"模型服从 persona 指令"，**不是**"目录被收窄"。前者成立，后者从未成立。

**若要真正实现收窄**：在能拿到 `agent` 的钩子（如 `agent/pre-step`）里调用
`agent.ctx.tools.restrict({ deny: [...] })`，阶段切换时 dispose 再重新 restrict。
可行，但需独立实现与验证，且收益待评估（CI-1 工具优先级已靠 persona 生效）。

---

## 真因修正 / Actual root cause (2026-10-29, after Argon review)

### 事实 / Facts

1. **`assembly.tools` 存在。** `dsh-system-prompt/lib/index.js`：
   ```js
   const assembly = { ...sections, contexts: [...], tools: orderTools(collected, this.toolOrder, knownNames), variables };
   const transformed = await this.ctx.waterfall(scopeTarget(this, scope), 'system-prompt/assemble', assembly, context, () => Promise.resolve(assembly));
   ```
   `tool-bootstrap` 读 `decision.tools` 是对的，过滤链本身没问题。
2. **`session.events` 已被移除。** `dsh-session` 只剩 `snapshotEvents()`，并有
   `.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md`
   的废弃说明；没有 `get events()` getter，访问得到 `undefined`。
3. **顶层会话炸在这里。** `compaction-epoch.mjs` 的 `scan()` 直接
   `for (const event of session.events)` → `TypeError` → `status()` 抛错
   → `tool-bootstrap` 的 `system-prompt/assemble` 钩子 catch →
   `warnOnce('bootstrap filter failed, exposing the full catalog')` → **返回全量目录**。
   → 这正是首轮 34 个工具、且**没有报错可见**的原因。
4. **子代理为什么是 12 个。** `status()` 第 64 行：
   ```js
   if (!includeSubagents && (session.header?.delegationDepth ?? 0) > 0) return { boundary: -1, promoted: true }
   ```
   在 `scan()` 之前短路 → 走 promoted 分支 → keep = 8 原子 + 3 发现工具 + exit_plan_mode = **12**。
   与实测完全吻合。

### 那个被我误读为“装饰品”的 dev_tool_search / The tool I mistook for decoration

它确实不 `ctx.tools.register()` 任何东西 —— 但这不是它的职责。它的真正作用是把
**“我要解锁 X”写成一条持久 `tool/call` 事件**；随后 `tool-bootstrap.unlockedFor(session)`
扫描会话日志、解析 `arguments.toolNames`、把 X 并入 keep 集合。
**返回文案只是给模型看的回执，解锁信号是那条事件本身。**

### 修正内容 / What changed

| 改动 | 文件 |
| :--- | :--- |
| 新增 `readSessionEvents()`：优先 `snapshotEvents()`，退化到数组，异常返回 `[]`，**永不抛** | `compaction-epoch.mjs` |
| `scan()` 改用它 | `compaction-epoch.mjs` |
| `unlockedFor()` 改用它（原先的 `Array.isArray(session.events)` 守卫在字段被移除后会静默返回空集） | `tool-bootstrap.mjs` |
| 恢复 `dev-tool-search` 插件行 | `agent.cordis.yml` |
| 删除 `agy-tool-restrict.mjs`（它在 `assemble` 瀑布里 restrict，但 tools 快照已在入瀑布前算完，100% 空转；且与 persona 冲突） | 已删文件与行 |
| persona 工具段落改回“首轮 resident 小、之后扩展、重型工具经 dev_tool_search 解锁”（现在这句话是真的了） | `agent.cordis.yml` |

### 待验证 / Still to verify

重启后新建会话，取 `request/header`：
- 首轮应为 **8** 个工具（bootstrap 阶段）；
- 第 2 轮起 **12** 个（8 + exit_plan_mode + skill_search + skill_load）；
- 调用 `dev_tool_search({"toolNames":["subagent"]})` 后，再下一轮应出现 `subagent`。
若首轮仍是 34 个，说明还有另一处异常，需再取 `warnOnce` 日志确认。
