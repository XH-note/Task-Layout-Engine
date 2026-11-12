# OpenAI 兼容接口的结构化输出可靠性

> 关联 issue：XH-note/Task-Layout-Engine #5「OpenAI 兼容接口的结构化输出可靠性」
> 调研时间：2026-11-12 · 调研范围：Chat Completions 语义（Responses API 仅在必要处对比）
> 结论用途：任务排版器 v1（本地 Web，默认 DeepSeek，可改 base_url/api_key/model）的接口层设计依据

**关于来源可获取性**：`platform.openai.com`、`developers.openai.com`、`cookbook.openai.com` 在本环境被 Cloudflare/403 拦截，`github.com` / `raw.githubusercontent.com` / `api.github.com` 解析到非公网 IP 不可达。因此 OpenAI 侧结论**以 Azure OpenAI 官方文档（同一推理栈的官方镜像）与 OpenAI 官方博客为准**；GitHub 侧的 one-api / new-api / vLLM PR 只能读到标题，凡此类条目均已标注为「间接证据」。逐条标注了 `一手` / `间接` / `UNVERIFIED`。

---

## 一、结论摘要

1. **「保证符合 schema」只有一条路：约束解码（constrained decoding）。** OpenAI 的 Structured Outputs 本质是把 JSON Schema 编译成语法，在采样时逐 token 屏蔽非法分支，所以输出**必定符合 schema**，而不是「提示词祈祷 + 事后校验」。官方措辞是模型「reliably adhere to developer-supplied JSON Schemas」[S1]。`json_object`（JSON mode）只保证**是合法 JSON**，不保证字段与类型 [S2]。
2. **约束是有代价的：schema 只能用一个很窄的子集。** 所有字段必须 `required`，对象必须 `additionalProperties: false`，不支持 `minLength/maxLength/pattern/format`、`minimum/maximum/multipleOf`、`minItems/maxItems/uniqueItems`、`minProperties/maxProperties` 等约束关键字；OpenAI 侧还限制最多 100 个 object properties、5 层嵌套 [S2]。**这直接决定了任务树的 schema 怎么写**（见第六节）。
3. **任务树这种递归结构是被支持的**：`$defs` + `$ref`（含 `"$ref": "#"` 自引用）可用 [S2]，所以「任务节点含子任务节点数组」的自递归模型不必摊平成固定层数。但递归 + 深度上限 5 层叠加，实际可用深度约 5 层（含根）。
4. **DeepSeek 没有 `response_format.json_schema`。** 只接受 `text` / `json_object`；JSON Output 必须自己在 system/user 里把 schema 和「只输出 JSON」讲清楚 [S3]。更关键的坑：**如果模型输出无法被解析为 JSON，API 会把非 JSON 内容替换成空格（U+0020）**，于是 `content` 看起来是空的，而 `finish_reason` 依然是 `stop` [S3]；`finish_reason=length` 时 `content` 可能是被截断的半个 JSON [S3]。这两点必须在客户端单独识别，否则会误判成「模型返回空」。
5. **DeepSeek 的强约束替代品是 `tools` + `strict: true`（Beta）**：需把 `base_url` 换成 `https://api.deepseek.com/beta`，逐个 function 加 `"strict": true`，服务端会校验你给的 JSON Schema，不合规直接报错 [S4]。它支持的子集和 OpenAI **不完全一样**：`string` 支持 `pattern`/`format`（但不支持 `minLength/maxLength`），`number` 支持 `minimum/maximum/multipleOf`，`array` **不支持** `minItems/maxItems`（前者 OpenAI 也不支持，后者 OpenAI 也不支持，但 `minimum/maximum` OpenAI 不支持而 DeepSeek 支持）[S2][S4]。注意文档写作 `$def`（非 `$defs`）[S4]。
6. **思考模式与「强制调用工具」互斥**：DeepSeek 在 thinking 模式下不支持 `tool_choice: "required"` 和具名 tool choice，会返回 HTTP 400 [S4]；而 `deepseek-flash` / `deepseek-v4-pro` 默认开启 thinking [S5]。所以「用 tool_choice 强推一个 `emit_task_tree` 工具」这条硬约束路线在默认配置下会直接失败，必须显式关闭思考或只在非思考模式下用。
7. **中转层（one-api / new-api / LiteLLM）会改变能力面**。LiteLLM 提供了明确的能力探测契约（`get_supported_openai_params` / `supports_response_schema`）与「非原生支持时客户端校验」的开关（`enable_json_schema_validation=True`）[S6]；而 one-api / new-api 这类转发网关历史上出现过 `response_format` 结构化参数不兼容、需要专门 PR 才能透传的情况 [S7][S8]（间接证据）。**结论：不能假设「OpenAI 兼容」= 「支持 json_schema」，必须做运行时能力探测 + 失败降级。**
8. **推荐落地组合（v1）**：`json_object + schema 写进 prompt + 客户端校验 + json-repair(schema 引导) 修复 + 至多 1 次带错误信息的重试`，能力探测到原生 `json_schema` 时自动升级；两阶段（自由文本大纲 → JSON）**只作为最后兜底**，因为成本翻倍且第二段仍可能失败。DeepSeek 的前缀缓存命中价比未命中便宜约 50 倍 [S5]，所以「失败后用同一段长 system prompt 重试」的实际成本远低于直觉。

---

## 二、各家支持对比表

图例：✅ 原生支持 · ⚠️ 部分/有条件 · ❌ 不支持 · 🅱️ Beta

| 提供方 / 入口 | `response_format=json_schema` | `response_format=json_object` | `tools` 严格模式 | 流式 + 结构化 | schema 子集限制要点 |
|---|---|---|---|---|---|
| **OpenAI**（gpt-4o-2024-08-06+、gpt-4.1、gpt-5 系列） | ✅ 约束解码，保证符合 | ✅ 只保证合法 JSON | ✅ `"strict": true`（等价机制） | ⚠️ 可用，但 delta 是 JSON 文本片段，无「部分对象」保证（见第五节） | 全字段 `required`、`additionalProperties:false`、无长度/数值/数组长度/pattern/format 约束、≤100 properties、≤5 层嵌套；`$ref`/`$defs` 可用；根不能是 `anyOf` [S1][S2] |
| **Azure OpenAI** | ✅ 同 OpenAI | ✅ | ✅ | ⚠️ 同上 | 同上（该文档本身即 Azure-specific limits）[S2] |
| **DeepSeek** `deepseek-flash` / `deepseek-v4-pro` | ❌ 无此类型 | ✅（须自行在 prompt 里要 JSON） | 🅱️ `strict:true`，需 `/beta` base_url | ✅/⚠️ 同一接口支持 `stream`；思考模式的 `reasoning_content` 与 `content` 分离 | 非 JSON 输出会被替换为空格；`length` 截断；strict 下全字段 required、`additionalProperties:false`；string 无 `minLength/maxLength`；array 无 `minItems/maxItems`；`$def` [S3][S4] |
| **vLLM**（OpenAI-Compatible Server） | ✅ 经 `client.beta.chat.completions.parse` 可用；更常用的是 `extra_body={"guided_json": <schema>}` | ✅ | ✅ `--enable-auto-tool-choice` + `--tool-call-parser`（工具调用需显式开启）[S9] | ✅ 约束解码逐 token 生效，天然兼容流式 | 由后端（xgrammar / guidance-llguidance）决定；支持 `guided_choice/guided_regex/guided_json/guided_grammar/structural_tag`，`--guided-decoding-backend` 默认 `auto` [S9] |
| **LiteLLM**（网关/SDK） | ✅ 统一封装，覆盖 OpenAI/Azure/xAI/Gemini/Vertex/Bedrock/Anthropic/Groq/Ollama/Databricks | ✅ | ✅ 透传 | ⚠️ 取决于上游 | 非原生模型可 `enable_json_schema_validation=True` 做客户端校验（jsonvalidator）；用 `supports_response_schema()` 判断 [S6] |
| **Ollama**（本地，含 `/v1` 兼容口） | ⚠️ 原生用 `format=<JSON Schema>`；`/v1` + `client.beta.chat.completions.parse` 亦可 | ✅ | ⚠️ 视模型而定 | ⚠️ | 官方 Tips：用 Pydantic/Zod 生成 schema、prompt 里加 "return as JSON"、`temperature=0` [S10] |
| **one-api / new-api**（中转站） | ⚠️ 取决于版本与上游；存在结构化参数不兼容的 issue，one-api 曾以 PR 形式补上 `ResponseFormat` 的 json_schema 支持 [S7][S8]（间接证据） | ⚠️ | ⚠️ | ⚠️ | 网关可能改写/丢弃 `response_format`、`tools`；`tool_choice`、`strict` 尤其容易被吃掉 |

**读表要点**

- 表格里唯一「保证符合 schema」的格子只有 OpenAI/Azure 与 vLLM（真约束解码）。DeepSeek 的 `json_object` 与所有网关的「兼容」都不保证字段级正确。
- 「支持 `response_format`」和「支持 `json_schema`」是两个能力（LiteLLM 特意分成 `get_supported_openai_params` 与 `supports_response_schema` 两个 API）[S6]。实现时不要合并成一个 boolean。
- 网关层的失败模式是**静默降级**：参数被丢弃、上游收到 `json_object` 甚至什么都没有，客户端只看到「模型没按格式输出」。所以「格式失败」必须与「参数不被支持」分开归因。

---

## 三、推荐落地组合（v1）

### 3.1 接口层：一个 provider 适配器 + 三个能力位

不要按「厂商」分支，按**能力**分支。适配器暴露：

```ts
type StructuredMode =
  | "native_json_schema"   // response_format = {type:"json_schema", json_schema:{...,strict:true}}
  | "json_object_prompted" // response_format = {type:"json_object"} + schema 全文写进 system
  | "tools_strict"         // tools + strict:true（DeepSeek /beta 或 vLLM）
  | "text_only";           // 完全裸文本，靠客户端解析
```

能力位来源优先级：**用户显式配置 > 本地已知表（DeepSeek / OpenAI / Ollama 内置默认） > 首次失败后的实测降级**。首次调用成功即把实测结果缓存进 localStorage，避免每次启动都试错（本地单人应用，无需服务端 profile）。

**降级顺序固定为**：`native_json_schema` → `json_object_prompted` → `tools_strict` → `text_only`。不建议把 `tools_strict` 放在 `json_object` 之前，理由：tools 会让模型把整棵树塞进 `arguments` 字符串（多一层 JSON 转义），并且 DeepSeek `/beta` + thinking 模式下 `tool_choice:required` 直接 400 [S4]，路径更脆。

### 3.2 默认（DeepSeek）的具体配方

1. `model` 用 `deepseek-flash`（便宜、快）或 `deepseek-v4-pro`（复杂任务树）。**不要再用 `deepseek-chat` / `deepseek-reasoner`**：这两个名字已于 2026-04-24 公告、2026-07-24 下线，期间分别路由到 `deepseek-v4-flash` 的非思考/思考模式 [S5]。issue 原文里的模型名需要更新。
2. 批量生成任务树时**显式降低/关闭思考**：thinking 默认开启且默认 effort 为 `high`，可选 `none/low/high/max` [S5]，用 `reasoning_effort: "none"`（或 `low`）——思考 token 计入输出计费，且对「按 schema 填字段」帮助有限。
3. `response_format: {type: "json_object"}` + system 里给 schema 全文 + 一句「只输出 JSON，不要 Markdown 代码块，不要解释」。
4. schema 放在 system 的**最前面且内容稳定**（同一份常量），任务文本放 user。DeepSeek 缓存命中输入价约为未命中的 1/50（flash：命中 $0.003–0.006 / 未命中 $0.15–0.3 每 1M tokens）[S5]，稳定前缀让重试几乎免费。
5. `temperature` 用 0（DeepSeek 默认 1；thinking 模式下该参数无效）[S5]。
6. `max_tokens` 给足。任务树很容易撞上输出上限，而 `finish_reason=length` 的 `content` 是**被截断的半个 JSON** [S3]——这属于「可修复」而不是「失败」，见 4.2 的 L1。

### 3.3 「不重复计费」的工程约束

LLM 接口没有幂等键，「精确一次」不可能做到，只能把浪费压到最低：

- **单飞（single-flight）**：同一份输入（hash：model + messages + 关键参数）在途时，UI 上的重复点击合并成一个请求，不排队、不并发。
- **失败分层重试**：只有「可修复」的错误才重试，且**最多 1 次**（4.2）。JSON 语法错误不该重试——先在本地修（0 成本）。
- **流式请求不做盲重试**：已经吐了 token 再断流，用户已看到内容，重试等于双重计费。策略：有部分内容时降级为「使用已收到的部分 + 本地修复」，让用户手动决定是否重新生成。
- **记账**：`stream_options.include_usage: true`（DeepSeek 会在最后一个 chunk 带整体 usage，且没有单独的 usage-only chunk）[S3]，把每次调用的 usage 与预估费用展示在界面上，用户能看见「这次失败花了多少」。
- **重试复用同一段前缀**，命中缓存把成本压到 1/50 [S5]；不要让重试消息里出现时间戳/随机 id 之类破坏前缀的内容。

---

## 四、降级与校验策略

### 4.1 校验管线（每次返回都走，按成本从低到高）

```
raw content
  │
  ├─ 0. 剥壳：去掉 ```json 围栏、前后散文、BOM；若 content.trim() === "" 且 finish_reason==="stop" → 判定为 DeepSeek 的「非 JSON 被替换成空格」[S3]，直接进 L2 重试（不要当成空树）
  ├─ 1. 硬解析：JSON.parse / json.loads                （0 成本）
  ├─ 2. 语法修复：json_repair.loads(...)               （0 成本，能修缺引号/逗号/括号、截断值、夹杂散文、Python 风格元组）
  ├─ 3. 结构修复：repair_json(s, schema=SCHEMA, schema_repair_mode="standard"|"salvage")
  │        salvage 会丢非法数组项、把 [{...}] 解包成对象、只补能推断的安全默认值；修不成抛 ValueError
  ├─ 4. 严格校验：jsonschema.validate 或 Pydantic/Zod parse（type/enum/required/additionalProperties）
  └─ 5. 语义校验（schema 表达不了的部分）：工时求和是否合理、优先级是否有且仅有一个 P0、
         子任务 id 唯一、叶子节点必须有验收标准、深度是否超 UI 上限
```

第 2/3 步用 `json-repair`（Python 0.64.9；JS 侧等价库 `jsonrepair`）。两个必须注意的点：中文内容要 `ensure_ascii=False`，否则会被转成 `\uXXXX`；schema 引导修复与 `strict=True` 互斥 [S11]。

> 前端是 TypeScript 也没问题：`jsonrepair`（josdejong/jsonrepair）是同一算法的 JS 移植 [S11]。若后端选 Python（本地 Web 常见组合），直接用 `json_repair` 的 schema 引导模式，能力更强。

### 4.2 修复与重试的代价阶梯

| 层级 | 手段 | 额外 token 成本 | 额外延迟 | 适用条件 | 风险 |
|---|---|---|---|---|---|
| L0 | schema 合规（约束解码） | 0 | 0 | 提供方原生支持 `json_schema` | 子集限制会拒掉一部分 schema（启动时报错，属好事：早失败） |
| L1 | 本地 JSON 修复（语法 + schema 引导） | 0 | <10ms | 截断、缺逗号、围栏、夹杂散文 | `salvage` 可能「修」出一个语义错的对象 → 必须接第 5 步语义校验；截断修复要标记 `truncated:true` 让 UI 提示 |
| L2 | 带错误信息重试（1 次） | ≈1× 输入（命中缓存后 ≈1/50 价）+ 1× 输出 | 一次完整生成 | L1 失败、`content` 为空、或语义校验失败 | 同一模型可能再错；必须把校验器的**具体报错路径**（如 `tasks[2].children[0].estimate_hours: expected number, got string`）塞进重试的 user 消息，而不是重发原 prompt |
| L3 | 两阶段：先自由文本大纲 → 再转 JSON | **2×**（两段完整生成，第二段还要吃第一段的输出当输入） | 2 倍以上 | L2 仍失败、或模型明显不擅长一次性产出深层结构 | 第二段仍可能格式失败；总成本失控。**不建议作为常规路径**（见 4.4） |
| L4 | 部分降级 | 0 | 0 | 拿到的树只有部分节点可用 | UI 必须明确标注「部分生成」，允许用户手工补全后继续导出；不要静默截断 |

### 4.3 两阶段到底值不值得做兜底

**结论：值得做，但只作为 L3 手动兜底，且第二段必须换更小的目标。**

理由：
- 一次性产出「目标/背景 + 多层任务树 + 优先级 + 工时 + 验收标准」是长结构化输出，失败点集中在**深层节点的闭合**（截断、漏字段）。先让模型自由文本列大纲能显著降低「结构复杂度」，但代价是 2× 成本与 2× 延迟 [S5 价格]。
- 第二段如果仍然要求完整 schema，等于把问题原样重现。更划算的第二段设计是**分片转换**：大纲按一级任务切片，每片单独转 JSON（每片输出短、几乎不可能截断），最后在本地拼装并做全局语义校验。成本仍在 2× 量级，但成功率显著高于「一整棵树一次成型」。
- 单人本地应用的用户预期是「等 20 秒可以，等 90 秒不行」。所以 L3 应由用户点「还是不行，换成分步生成」触发，而不是自动静默升级。

### 4.4 schema 不合法（服务端拒绝）时的处理

服务端拒绝 schema（DeepSeek strict 的 400、OpenAI 的 invalid schema error）**不是重试能解决的**，属于配置错误：

- 把「schema 校验」提前到**构建期**：用 `zod-to-json-schema` / Pydantic 生成后，再用一份「OpenAI strict 子集检查器」跑一遍（禁止关键字清单 + 全 required + `additionalProperties:false` + 深度 ≤5 + properties ≤100），失败直接在开发期炸掉，不要留到用户点「生成」时。
- 运行期遇到 400 且 message 指向 schema：**降级能力位**（`native_json_schema` → `json_object_prompted`）并重发一次，同时把这次降级记进本地能力缓存，下次直接用低档位。

---

## 五、流式与结构化输出能否共存

**能共存，但「流式」给不了你「部分合法的对象」。**

- 约束解码是**逐 token** 生效的（语法状态机在每个 token 上屏蔽非法分支）[S1][S9]，所以流式下每个 delta 仍然是「某个合法 JSON 的前缀」——但前缀本身不是合法 JSON，`JSON.parse` 必然失败直到闭合。
- 实践上有三种处理，按推荐度排序：

| 方案 | 做法 | 优点 | 缺点 | 建议 |
|---|---|---|---|---|
| A. 不流式 | `stream: false`，一次性拿完整 content，再走 4.1 管线 | 实现最简单，校验与修复逻辑只有一条路径；不存在「半截流断线」的计费浪费 | 用户干等（深层任务树可能 20–60s） | **v1 默认**。用进度指示 + 明确耗时预期替代流式 |
| B. 流式 + 末尾校验 | 累积全部 delta 拼成完整字符串，`finish_reason` 到达后才解析入库 | 有打字机效果，体验好 | 仍需完整累积；中途断流要处理 | 想要「有反馈」时的推荐实现 |
| C. 流式增量解析（边生成边显示树节点） | 用容错解析器逐段解析（`json_repair` 支持 `stream_stable=True` 的流式修复 [S11]） | 最好的观感：树逐层长出 | 需要「乐观渲染 + 失败回滚」逻辑；修复器在流中途可能给出错误的中间形态 | 只在 A/B 都稳定后作为增强 |

- 两条硬规则：**（1）流式内容一律不入库**，只在 `finish_reason` 到达且通过 4.1 管线后提交；（2）**断流不自动重试**（已产生输出 = 已计费），交给用户决定。
- `UNVERIFIED`：OpenAI 官方文档在可访问镜像中未给出「流式 + Structured Outputs」的专项说明（`platform.openai.com` 403）。「delta 为 JSON 文本片段」这一条属于机制推断 + 社区共识，实现时必须以实测为准（发一次 `stream:true` + `json_schema` 看 delta 形态）。DeepSeek 侧同样只有「接口支持 stream」与「JSON 输出」两条独立事实 [S3]，没有二者组合的官方说明。

---

## 六、对任务树 schema 的具体约束（落地清单）

因为默认走 `json_object + prompt`（客户端自己保证），但一旦升级到 `native_json_schema` 就必须过 OpenAI 子集检查 [S2]，schema 必须**从一开始就写成两边都能吃的子集**：

- ✅ 所有字段 `required`；可选语义用 `"type": ["string", "null"]` 表达 [S2]。
- ✅ 所有 object 加 `additionalProperties: false`。
- ✅ 枚举用 `enum`（优先级 P0/P1/P2），**不要**用 `pattern` 正则（OpenAI 不支持 `pattern` [S2]；DeepSeek strict 虽支持但会锁死 schema 到 `/beta` 路径 [S4]）。
- ❌ 不要用 `minItems/maxItems`（OpenAI 与 DeepSeek 都不支持）[S2][S4] → 「至少一个子任务」「最多 3 个验收标准」这类规则放**语义校验**。
- ❌ 不要用 `minimum/maximum`（OpenAI 不支持；DeepSeek 支持）→ 工时范围 0–40 放语义校验。
- ❌ 不要用 `minLength/maxLength`（两边都不支持）[S2][S4] → 标题长度限制放 UI 与语义校验。
- ✅ 递归：`$defs.TaskNode` 自引用 `{"$ref": "#/$defs/TaskNode"}`（DeepSeek 文档写作 `#/$def/...`，实现时对 DeepSeek 分支做一次 key 名适配）[S4]。
- ✅ 嵌套深度 ≤5 层（含根对象），properties 总数 ≤100 [S2] —— 任务树天然容易超，**根级别只放 1 个 `tasks` 数组**，不要给根加一堆元数据字段。
- 推论：schema 只能保证「形状」，**业务不变量必须由本地语义校验兜底**（工时合计、优先级唯一、叶子有验收标准、id 唯一、深度上限）。这是 v1 里比「选哪个 provider」更重要的一条。

---

## 七、未决问题 / 后续动作

1. **`UNVERIFIED`**：OpenAI 流式 + `json_schema` 的 delta 形态，需一次真实调用实测（本次受 403 所限）。
2. **`UNVERIFIED`**：DeepSeek `tools+strict` 在 `/beta` 下与 `stream:true` 的组合行为，文档未明说；且 thinking 模式下 `tool_choice` 受限 [S4]，实测时务必先关思考。
3. **间接证据**：one-api PR #1759、new-api issue #1382 仅读到标题（GitHub 不可达），「网关会静默丢弃 `response_format`」尚无正文级证据。若 v1 明确要支持中转站，建议加一个「自检按钮」：发一次极小的 schema 请求，把结果（是否 400 / 是否按格式返回）落进能力缓存——实测比读文档可靠。
4. DeepSeek 模型名迁移（`deepseek-chat` → `deepseek-flash`）需要在 issue 与 README 中同步更新 [S5]。

---

## 八、来源列表

| # | 来源 | 类型 | URL |
|---|---|---|---|
| S1 | OpenAI 官方博客《Introducing Structured Outputs in the API》（2024-08-06） | 一手 | https://openai.com/index/introducing-structured-outputs-in-the-api/ |
| S2 | Azure OpenAI《Structured outputs》（官方文档，更新于 2026-08-24；OpenAI 推理栈的官方镜像，含 supported/unsupported schema 表、100 properties / 5 层嵌套限制、`parallel_tool_calls:false`、refusal 处理） | 一手（镜像） | https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/structured-outputs |
| S3 | DeepSeek《Create Chat Completion》API 参考（`response_format` 仅 text/json_object；非 JSON 输出被替换为空格；`finish_reason` 枚举；`stream_options.include_usage`） | 一手 | https://api-docs.deepseek.com/api/create-chat-completion/ |
| S4 | DeepSeek《Tool Calls》指南（strict 模式 Beta、需 `/beta` base_url、支持的 schema 类型与关键字、thinking 模式下 `tool_choice` 限制） | 一手 | https://api-docs.deepseek.com/guides/tool_calls |
| S5 | DeepSeek《Models & Pricing》+《Change Log》（模型名 `deepseek-flash` / `deepseek-v4-pro`、旧名下线、thinking 默认开启、缓存命中/未命中价格、temperature/max_tokens 默认值） | 一手 | https://api-docs.deepseek.com/quick_start/pricing · https://api-docs.deepseek.com/updates |
| S6 | LiteLLM《Structured Outputs (JSON Mode)》（`json_schema`+`strict` 跨 provider、`supports_response_schema()`、`enable_json_schema_validation`） | 一手（项目文档） | https://docs.litellm.ai/docs/completion/json_mode |
| S7 | one-api PR #1759「feat: ResponseFormat support json_schema」 | 间接（仅标题） | https://github.com/songquanpeng/one-api/pull/1759 |
| S8 | new-api issue #1382「结构化输出structure output模式参数不兼容」 | 间接（仅标题） | https://github.com/QuantumNous/new-api/issues/1382 |
| S9 | vLLM《Structured Outputs》（xgrammar / guidance 后端、`guided_json`/`guided_choice`/`guided_regex`/`guided_grammar`/`structural_tag`、`--guided-decoding-backend` 默认 auto、OpenAI beta parse 用法） | 一手（项目文档） | https://docs.vllm.ai/en/v0.8.5/features/structured_outputs.html |
| S10 | Ollama 博客《Structured Outputs》（2024-12-06；`format` 传 JSON Schema、`/v1` 兼容口、temperature=0 建议） | 一手 | https://ollama.com/blog/structured-outputs |
| S11 | json-repair（PyPI 0.64.9，2026-11-10；`repair_json(schema=...)`、`schema_repair_mode`、`strict`、流式 `stream_stable`、`ensure_ascii=False`；JS 移植 jsonrepair） | 一手（项目文档） | https://pypi.org/project/json-repair/ |
| S12 | vLLM PR #17845「[Feature][V1] Support tool_choice: required when using Xgrammar as the StructuredOutputBackend」 | 间接（仅标题） | https://github.com/vllm-project/vllm/pull/17845 |
