# agy-gemini — a DSH agent preset tuned for Gemini Flash-class models

> A DSH (DeepSeek Harness) agent preset for flash-class Gemini models that have to hold a
> long tool chain. 一套为 Gemini Flash 类模型调优的 DSH（DeepSeek Harness）agent preset。

---

# English

## Why this exists

DSH's `standard` preset is **capability-first**: it hands the model the full tool catalog,
the runtime snapshot, `AGENTS.md`, the skill catalog and every tool's usage guide at once,
then trusts the model to self-regulate. Its persona is 61 characters long, because it is a
generic host default and cannot name any particular model's failure modes.

Flash-tier models do not hold that up across a long tool chain. This preset is
**constitution-first**: a ~12k-character written constitution is the main control surface.

It does not change what the model can do. It changes the **relative cost** of cheating,
slacking or giving up versus complying.

## What it does

**1. Names the pathologies.** "Do not relax the assertion" does not exist in a generic
default, so when the task says "raise the threshold until it passes", nothing competes with
it. Here each failure mode has a name — `assertions are sacred`, `[HONEST_BLOCKED]` — which
gives the model something to retrieve instead of something to infer.

**2. Provides a legitimate failure channel.** With only "success" and "failure" as exits,
and "relax the assertion" turning failure into success, cheating is the rational choice.
`[HONEST_BLOCKED]` does not make a model honest; it removes the payoff by defining a third,
compliant exit.

**3. Keeps anti-self-deception state outside the model.** A model checking itself is the
same weights sitting as both defendant and judge. So the evidence lives outside it: every
edit/write echoes back a real diff with physical line numbers (`agy-diff-guard`), and five
consecutive edits to one file trip a circuit breaker. `read`, `grep` and `glob` do not reset
the counter.

**4. Narrows the tool surface.** Eight atomic tools on the first request, heavy tools
unlocked on demand. The honest version: this mostly saves tokens and lowers choice entropy.
The behavioural correction comes from the constitution, not from the narrowing.

## Install

### 1. Drop in the modules

Eight `.mjs` files go under the profile's `agy-gemini/` directory:

```powershell
$dst = "$env:USERPROFILE\.dsh\profiles\<profile>\agy-gemini"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item *.mjs $dst
```

### 2. Register the preset in the patch

Pasting plugin rows is **not** enough. The preset has to be registered by
`@deepseek-ai/dsh-agent-preset` as an `insert` record, with the plugin list under its
`config.plugins`:

```yaml
- insert:                     # a LIST: the host does data.push(...insert)
    - id: preset-agy-gemini
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: agy-gemini
        # ...
        plugins:
          # all 22 rows from agent.cordis.yml, indented by 10 spaces,
          # with tool-bootstrap first
```

> Writing `insert` as an object parses fine and then throws
> `TypeError: Spread syntax requires ...iterable[Symbol.iterator]` on load. "It parses and
> has 22 plugins" does not prove the host accepts it.

### 3. Generate the block instead of pasting it

`add_preset.py` handles the path rewrite, the indentation, and an idempotency check:

```powershell
python add_preset.py "$env:USERPROFILE\.dsh\profiles\<profile>\cordis.patch.yml"
```

`--dry-run` prints the block instead of writing it. `--remove` deletes only the managed
block. A second run is refused (exit 2), so you cannot end up with two identically named
presets in the selector.

### 4. Restart DSH fully

A page refresh does not reload the profile patch.

### 5. Pick the preset in a new session

Use a model with a working reasoning channel, and `maxTokens >= 32768`. High-tier thinking
has been measured at 73% of the output budget, so a small `maxTokens` shows up as "long
thinking, empty reply".

> `.agent-presets/` is not a DSH load path. What loads is the `- insert:` block in the
> profile patch.

## Tuning

Three knobs, all in `agent.cordis.yml`: the compaction threshold and retained tokens, the
bootstrap tool list, and the tool-result pruner. `DESIGN.md` covers the constraints between
them — the compaction pair has to move together, and `retainRatio` and `retainTokens` are
mutually exclusive.

## What we learned

Three mechanisms that looked sound did not survive measurement:

- **A per-thought recitation anchor does nothing.** Across two model tiers the anchor
  keywords were never repeated in any reasoning block. What actually fires is *naming* a
  failure mode, triggered by the task matching its description.
- **The context ceiling was imaginary.** A 900k-token request came back with 959,863 billed
  tokens and all four probe needles intact. Compaction is still worth doing, for latency and
  cost rather than capacity.
- **Tool narrowing silently no-opped.** A plugin that filtered the catalog threw on every
  turn and fell back to the full list, with no visible error. Only a session archive showed
  it.

`DESIGN.md` keeps the full record, including the hypotheses that turned out wrong.

## Compatibility

Verified against `@deepseek-ai/dsh-*` `0.1.7-alpha.1` / `dsh-compaction-basic` `0.0.1-rc.3`
(2026-10-29). DSH is pre-1.0 and its plugin surface moves: this preset depends on
`tools.guard()`, `session.snapshotEvents()` and the `dsh-compaction-basic` schema, all of
which have changed at least once.

If the preset silently stops narrowing the catalog, that is the known failure mode rather
than a misconfiguration. Look for `bootstrap filter failed, exposing the full catalog` in
the host log.

## What is not in this repository

The A/B harnesses behind the numbers above (guard cases, circuit-breaker cases, line-number
cases, recall run) and the context-ceiling probe are **not** published. Those are reported
results, not a runnable test suite; re-measure on your own host before relying on the tuning
values.

`agy-policy.mjs` is a **behavioural correction layer, not a security boundary.** Its checks
are regular expressions over tool arguments, and an obfuscated command gets past them. Do
not treat it as sandboxing, and do not rely on it to contain untrusted input.

## Provenance

Built by observing the runtime behaviour of a locally installed commercial agentic coding
CLI and re-implementing the mechanisms for a different host. It contains no third-party
code, binaries, assets, or verbatim prompt text; every module and every prompt line here was
written for this project.

The mechanisms it carries — naming a failure mode, providing a sanctioned blocked-report
channel, keeping anti-self-deception state outside the model, narrowing the tool surface —
are general engineering ideas. Copyright protects the expression of a program, not its
ideas, procedures or methods of operation.

## Takedown and contact

If you are a rights holder and believe this repository includes material it should not, open
an issue or use the contact address on the maintainer's profile. Affected content will be
removed or rewritten promptly.

## License

MIT — see [LICENSE](LICENSE).

`Antigravity` and `Gemini` are trademarks of Google LLC, used here only to describe what the
design was informed by. This project is **not affiliated with, endorsed by, or sponsored by
Google.** Provided as-is, without warranty of any kind.

---

# 中文

## 这是什么

DSH 内置的 `standard` 预设是「能力优先」的：一次性把全量工具目录、运行时快照、
`AGENTS.md`、技能目录和每个工具的用法指南都灌给模型，然后相信它自我调节。它的 persona
只有 61 个字符 —— 通用宿主默认值不可能针对某个模型的具体病态。

Flash 档位的模型撑不住长工具链。本预设改成「宪法优先」：一份约 12k 字符的成文宪法是
主要控制面。

**它不改模型能力，改的是「作弊 / 偷懒 / 摆烂」与「合规」之间的相对代价。**

## 四条机制

1. **给病态起名字** —— 通用默认里根本没有「不许改断言」这句话，所以当任务诱导「改大阈值
   让它过」时，没有任何文本与之竞争。这里有名字：`assertions are sacred`、
   `[HONEST_BLOCKED]`。
2. **留一条合法的失败通道** —— 只有成功/失败两个出口时，「改断言」会把失败变成成功，
   作弊就是理性的。`[HONEST_BLOCKED]` 不是让模型变诚实，是**打掉作弊的收益**。
3. **把反自欺状态放到模型外面** —— 模型自查等于同一套权重既当被告又当法官。所以每次
   edit/write 都回显带物理行号的真实 diff（`agy-diff-guard`），同一文件连续 5 次编辑触发
   熔断；`read`/`grep`/`glob` 不重置计数。
4. **收窄工具面** —— 首轮 8 个原子工具，重型工具按需解锁。诚实地说：这部分主要省 token、
   降低选择熵，行为纠正来自宪法本身。

## 安装

完整步骤见上面英文版的 Install 一节，这里只列要点：

1. 把 8 个 `.mjs` 拷到 `%USERPROFILE%\.dsh\profiles\<profile>\agy-gemini\`；
2. 在 profile 补丁里用 `- insert:` 注册。**`insert` 必须是数组** —— 写成对象时 YAML 照样
   能解析，加载时才抛 `Spread syntax` 错误；
3. 直接跑 `python add_preset.py <补丁路径>` 生成，别手贴；`--remove` 可撤销；
4. **完整重启 DSH**，刷新页面不生效；
5. 新建会话，在预设选择器里选「Gemini Flash 调优 · 纪律优先」，`maxTokens ≥ 32768`。

## 三个必须知道的限制

- **测试没随仓库发布。** 文中引用的 A/B 夹具（守卫用例、熔断用例、行号用例、召回用例）
  和上下文探针都不在仓库里。那些是报告结果，不是可跑的测试 —— 调参值请在你自己的宿主上
  复测。
- **`agy-policy.mjs` 不是安全边界。** 它的检查是对工具参数的正则匹配，挡不住刻意规避。
  别当沙箱用，也别用它隔离不可信输入。
- **DSH 处于 pre-1.0。** 本预设依赖 `tools.guard()`、`session.snapshotEvents()` 和
  `dsh-compaction-basic` 的 schema，这些接口都变过。若工具收窄突然失效，先查宿主日志里
  有没有 `bootstrap filter failed, exposing the full catalog`。

## 详细记录

设计推导、被推翻的机制、逐插件 schema 审计、第三方审阅轮次，都在 [`DESIGN.md`](DESIGN.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。`Antigravity`、`Gemini` 是 Google LLC 的商标，此处仅用于
说明设计来源；本项目与 Google 无隶属关系。

---

## Repository layout

| File | Role |
| :--- | :--- |
| `agent.cordis.yml` | design source of the 22-plugin preset |
| `add_preset.py` | registers the preset into a profile patch (`--dry-run`, `--remove`) |
| `tool-bootstrap.mjs` | first-request catalog narrowing + promotion phases |
| `compaction-epoch.mjs` | compaction-boundary-aware promotion tracker (imported, not mounted) |
| `dev-tool-search.mjs` | on-demand unlock tool (records the unlock signal) |
| `skill-search.mjs` | on-demand skill discovery |
| `instruction-hint.mjs` | post-promotion hint that instruction files exist |
| `agy-diff-guard.mjs` | UnifiedDiff echo with physical line numbers + edit circuit breaker |
| `agy-policy.mjs` | `tools.guard()` enforcement: bare listings, protected paths, assertion removal, force push |
| `session-recall.mjs` | lossless recall over the durable session log |
| `preset.yml` | preset manifest |
| `DESIGN.md` | long-form design notes |
