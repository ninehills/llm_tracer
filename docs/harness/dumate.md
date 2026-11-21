# DuMate Harness 协议与轨迹分析

本文档基于真实代理流量抓取与 `llm_tracer` 后端实现（`internal/harness/dumate.go`、`internal/atif/atif.go`），对 **DuMate**（百度千帆桌面智能体应用 `DuMate.app`）的 HTTP 请求特征、主/子智能体（Subagent）协作机制，以及真实会话中的前缀变更与 KV Cache 命中行为进行系统性分析。

---

## 1. Harness 识别与元数据提取

`llm_tracer` 在 `internal/harness/dumate.go` 中通过 `DumateExtractor` 识别并解析 DuMate 流量。

### 1.1 匹配规则与版本号提取

- **真实 `User-Agent` 格式**：
  ```text
  Go-http-client/1.1 ai-sdk/provider-utils/3.0.20 runtime/bun/1.3.14 DumateApp/1.0.93.526
  ```
- **识别条件（满足其一即命中 `harness="dumate"`）**：
  1. `User-Agent` 包含 `dumate`（大小写不敏感）。
  2. 请求头中存在 `X-Dumate-Session-Id` 或 `X-Dumate-Request-Id`。
- **版本号提取正则**：
  ```go
  (?i)dumate(?:app)?[\s/_-]+v?([0-9]+\.[0-9]+[^\s);]*)
  ```
  可兼容 `DumateApp/1.0.93.526`、`Dumate/x.y.z`、`Dumate-x.y.z` 等格式，从上述真实 UA 中提取版本号 `1.0.93.526`。

### 1.2 专有 HTTP 请求头

| HTTP Header | `llm_tracer` 映射字段 | 说明与真实示例 |
| :--- | :--- | :--- |
| `X-Dumate-Session-Id` | `session_id` | 会话唯一标识（如 `ses_gffe5e02f2d004ffevA4byvJw4HMgIo`）。主智能体与子智能体共享同一个 Session ID。若缺失则回退至 `X-Session-Id` / `Session_id` / body `prompt_cache_key` / `metadata.session_id`。 |
| `X-Dumate-Request-Extra-Param` | 解析为多个扩展字段 | 逗号分隔的 `key=value` 列表（value 经 URL unescape），详见下表。 |
| `X-Dumate-Request-Id` | `request_id` | 单次 LLM 请求的 UUID（如 `6ab880f2-a968-4d21-a059-25d9d3d65f15`）。 |
| `X-Dumate-Account-Id` | `account_id` | DuMate 账号 ID。 |
| `X-Appbuilder-Dumate-Account-Id` | `appbuilder_account_id` | AppBuilder 侧关联账号 ID。 |
| `X-Dumate-Device-Id` | `device_id` | 客户端设备指纹（如 `1\|darwin.<hash>`）。 |
| `X-Dumate-Prd-Source` | `prd_source` | 产品来源标识（如 `enterprise`）。 |

### 1.3 `X-Dumate-Request-Extra-Param` 字段解析

真实示例：
```text
sandbox=true, sandboxType=light, source=user, fixedModel=personal%3Aopencode-go-deepseek-v4-1-flash-0a8cc626
```
（会话首请求还会附带 `firstRequest=true`。）

| 参数键 | 映射字段 | 类型与含义 |
| :--- | :--- | :--- |
| `source` | `source`、`is_subagent` | 请求发起角色：`user`（主智能体及主会话辅助调用）或 `subAgent`（子智能体）。当 `strings.EqualFold(v, "subagent")` 为真时设置 `is_subagent = true`。 |
| `sandbox` | `sandbox` | 布尔值（`true` / `false`），是否启用沙箱。 |
| `sandboxType` / `sandbox_type` | `sandbox_type` | 沙箱类型（如 `light`）。 |
| `fixedModel` / `fixed_model` | `fixed_model` | URL 解码后的固定模型配置标识（如 `personal:opencode-go-deepseek-v4-1-flash-0a8cc626`）。 |
| 其他键值 | 原样保留 | 如 `firstRequest`。 |

### 1.4 工作目录（`work_dir`）提取

DuMate 不会在 HTTP 请求头中直接传递工作目录，而是在 System/Environment 上下文消息的 `<runtime_env>` 块中以中文键值对形式声明：

```xml
<runtime_env>
  <!-- DuMate 运行环境：代码与工具实际执行所在处 -->
  操作系统平台: darwin (macOS)
  CPU 架构: arm64
  运行环境类型: 本地环境（POSIX）
  ...
  主目录: /Users/<user>
  工作目录: /Users/<user>/.qianfan/workspace/sessions/<account_id>/2026-11-21/new-chat-5
  工具临时目录: /var/folders/.../T
  工作目录是否为 git 仓库: 否
</runtime_env>
```

`internal/harness/harness.go` 中的 `extractCommonWorkDir` 通过正则 `(?im)工作目录\s*[:：]\s*([^\r\n"'<>`\\]+)` 自动从 `<runtime_env>` 块中提取出准确的 `work_dir`。

---

## 2. 主智能体与子智能体（Subagent）协作机制

以真实测试会话 `ses_gffe5e0348c07affemcG3jGbNOOhp3T`（Prompt：`请使用子智能体调用Bash输出echo OK`，共 5 次流式请求）为例，DuMate 的主/子智能体通信具有以下特征：

### 2.1 `source=user` 与 `source=subAgent` 区分

- 主智能体与子智能体的所有请求均携带**相同的 `X-Dumate-Session-Id`**，因此默认被归入同一 Session。
- 区分依据位于 `X-Dumate-Request-Extra-Param` 中的 `source` 字段：
  - 主智能体请求：`source=user`（`is_subagent=false`）
  - 子智能体请求：`source=subAgent`（`is_subagent=true`）
- 在 `llm_tracer` 的 ATIF-v1.8 轨迹构建中（`internal/atif/atif.go`），`source=subAgent` 的请求不会混入主轨迹的 `steps`，而是独立聚合为 `subagent_trajectories`（ID 为 `<session_id>#subagent-<n>`）并关联到触发它的主轨迹分段上。

### 2.2 `task` 工具调用与 `task_id: ses_...` 关联

典型执行链路如下（对应 `ses_gffe5e0348c07affemcG3jGbNOOhp3T` 的 5 次请求）：

1. **Req 1（`source=user`, `firstRequest=true`）**：辅助「行动预告」请求（无工具调用）。
2. **Req 2（`source=user`）**：主智能体决定委派子智能体，发出 `task` 工具调用。
3. **Req 3（`source=subAgent`）**：子智能体启动，发出 `bash` 工具调用（执行 `echo OK`）。
4. **Req 4（`source=subAgent`）**：子智能体收到 `bash` 输出 `OK` 后生成最终子任务回复。
5. **Req 5（`source=user`）**：主智能体收到 `task` 工具的返回结果，内容中包含子任务会话标识：
   ```text
   task_id: ses_gffe5e03489e34ffeneNEFcbE8P7Z89
   ...
   ```
   `internal/atif/atif.go` 通过 `reTaskID`（`(?m)^task_id:\s*(\S+)`）解析该 `task_id`，并在对应的 `ObservationResult` 上自动挂接 `subagent_trajectory_ref`。

### 2.3 `tool_call_id` 归一化重写（`t1`）

DuMate Harness 在将上游模型返回的 `assistant` 工具调用回填到下一轮请求的 `messages` 历史时，会**重写原始 `tool_call_id`**（例如将模型响应中的长 ID 重写为短递增 ID `t1`、`t3`、`t5` 等）：

- 在子智能体 Req 4 中：回填的 `assistant.tool_calls[0].id` 与 `tool.tool_call_id` 均被重写为 `t1`（对应 `bash`）。
- 在主智能体 Req 5 中：回填的 `assistant.tool_calls[0].id` 与 `tool.tool_call_id` 均被重写为 `t1`（对应 `task`）。

`llm_tracer` 在 `buildSteps` 中会自动建立 `echoID -> origID` 的 `toolIDRemap` 映射，确保 ATIF `ToolCall.tool_call_id` 与 `ObservationResult.source_call_id` 严格对齐。

---

## 3. 真实会话前缀变更与 KV Cache 命中分析

以真实多轮会话 **`ses_gffe5e02f2d004ffevA4byvJw4HMgIo`**（`harness="dumate"`，模型 `opencode-go/deepseek-v4.1-flash`，共 **8 次请求 → 7 条 ATIF 续写轨迹分段**）为例，深入分析 DuMate 的 Prompt 组装行为及其对轨迹分段与 KV Cache 命中率的影响。

### 3.1 会话与轨迹分段总览

| Traj 分段 | `req_id` (seq) | `tools` 数量 | `messages` 数量 | `prompt_tokens` | `cached_tokens` | Cache 命中率 | 角色说明 |
| :---: | :---: | :---: | :---: | ---: | ---: | ---: | :--- |
| #1 | 20 (1) | 0 | 2 | 219 | 0 | 0.0% | Turn 1「行动预告」（辅助请求，`source=user`） |
| #2 | 21 (2) | 30 | 7 | 65,036 | 0 | 0.0% | Turn 1 主智能体（冷缓存） |
| #3 | 22 (3) | 30 | 10 | 65,624 | 62,720 | **95.6%** | Turn 1 主智能体 |
| #4 | 23 (4) | 30 | 12 | 66,215 | 65,536 | **99.0%** | Turn 1 主智能体 |
| #5 | 24 (5) | 0 | 4 | 453 | 0 | 0.0% | Turn 2「行动预告」（辅助请求，`source=user`） |
| #6 | 25 (6), 26 (7) | 29, 29 | 13, 16 | 63,780 / 65,347 | 24,448 / 63,744 | **38.3% / 97.5%** | Turn 2 主智能体（25→26 严格追加，未分段） |
| #7 | 27 (8) | 29 | 18 | 65,994 | 65,152 | **98.7%** | Turn 2 主智能体 |

### 3.2 逐边界原始 `request_body` 差异分析

`llm_tracer` 的 `shouldStartNewSegment` 严格遵循 ATIF 的 append-only 前缀不变式：仅当相邻请求的有序 `tools` 定义完全一致且 `R_{i+1}.messages` 严格以 `R_i.messages` 为前缀时，才归入同一条轨迹。本次会话的 6 次分段**均非误判**，全部由 DuMate 实际修改了原始 HTTP `request_body` 前缀导致：

#### 1. 分段 #2 (`req_id=21`) → 分段 #3 (`req_id=22`)：技能插件 Reminder 重排（Cache 命中 95.6%）

- **差异位置**：`tools`（30 个）与 `messages[0..3]` 字节级完全一致（约 133.6 KB JSON ≈ 62,720 tokens）；`commonPrefixLen` 在索引 4 处中断（`4 < 7`）。
- **原始 `request_body` 变化**：DuMate 将 `humanizer` 技能插件的 `<system-reminder>` 消息从 `skill` 工具调用**之前**重排到了工具结果**之后**：
  - `req_id=21`：
    - `msg[4]`：`role="user"`，`<system-reminder>\n用户显式调用了以下技能插件：\`humanizer\`。\n</system-reminder>`（63 chars）
    - `msg[5]`：`role="assistant"`，`tool_calls=[t1: skill]`
    - `msg[6]`：`role="tool"`，`tool_call_id="t1"`（8,224 chars，技能正文）
  - `req_id=22`：
    - `msg[4]`：`role="assistant"`，`tool_calls=[t1: skill]`（同时新增 `"reasoning_content": ""` 字段）
    - `msg[5]`：`role="tool"`，`tool_call_id="t1"`
    - `msg[6]`：`role="user"`，`<system-reminder>...humanizer...</system-reminder>`
- **KV Cache 表现**：`tools + msg[0..3]`（约 62,720 tokens）完整命中前缀缓存；仅重排后的 `msg[4..6]`（约 2.3K tokens）及新增 `msg[7..9]` 未命中（共 2,904 uncached tokens），因此命中率仍高达 **95.6%**。

#### 2. 分段 #3 (`req_id=22`) → 分段 #4 (`req_id=23`)：尾部临时 `<system-reminder>` 丢弃（Cache 命中 99.0%）

- **差异位置**：`tools`（30 个）与 `messages[0..8]` 字节级完全一致（约 65,536 tokens）；`commonPrefixLen` 在索引 9 处中断（`9 < 10`）。
- **原始 `request_body` 变化**：DuMate 在 `req_id=22` 末尾注入了一条 132 字符的临时引导消息，但在下一轮 `req_id=23` 构造历史时将其**丢弃**：
  - `req_id=22[9]`：`role="user"`，`<system-reminder>\n当前已确定且条件具备的工具操作，直接调用执行。...同轮发起。\n</system-reminder>`（132 chars）
  - `req_id=23[9]`：`role="assistant"`，`tool_calls=[t3: question]`
- **KV Cache 表现**：该 132 字符消息之前的所有 65,536 / 66,215 tokens 全部命中 KV Cache，命中率达 **99.0%**。

#### 3. 分段 #6 (`req_id=26`) → 分段 #7 (`req_id=27`)：同款尾部 `<system-reminder>` 丢弃（Cache 命中 98.7%）

- **差异位置**：与 #3 → #4 完全一致。`tools`（29 个）与 `messages[0..14]` 字节级完全一致（65,152 / 65,994 tokens 命中）；`commonPrefixLen` 返回 `15 < 16`。
- **原始 `request_body` 变化**：`req_id=26[15]` 末尾带有相同的 132 字符 `<system-reminder>`，在 `req_id=27[15]` 中被丢弃并直接替换为 `role="assistant"`（`tool_calls=[t5: memory_search]`）。
- **对照验证**：`req_id=25 → req_id=26` 之所以**未分段**（共同留在分段 #6），正是因为 `req_id=25` 末尾未注入该临时 `<system-reminder>`，满足严格前缀追加。

#### 4. 穿插的「行动预告」辅助请求（`req_id=20`、`req_id=24`）

- 每次用户发起新一轮对话（Turn 1 / Turn 2）时，DuMate 都会先发送一次独立的「行动预告」请求：
  - `tools` 为空（`tools=0`）
  - 独立的 281 字符系统提示词（`你负责为当前用户请求快速给出一两句具体、自然的行动预告...`）
  - 复用主会话的 `X-Dumate-Session-Id` 且仍标记 `source=user`（并非 `subAgent`）
- 因此在严格前缀校验下，`req_id=20`（分段 #1）与 `req_id=24`（分段 #5）会被自然切分为独立的短分段。

#### 5. 跨轮次工具集缩减与历史消息裁剪（Turn 1 `req_id=23` → Turn 2 `req_id=25`）

- 进入 Turn 2 主智能体请求 `req_id=25` 时，DuMate 同时进行了两处前部变更：
  1. **移除工具定义**：从 30 个工具缩减为 29 个（移除了 `knowledge_base`）。
  2. **裁剪历史消息内嵌块**：将 `msg[3]` 中的 `<system-info>` / `<system-reminder>` 块剥离（内容长度从 588 字符缩减为 23 字符）。
- 由于改动位置靠前（直接影响了 `tools` 定义段与 `msg[3]`），`req_id=25` 的 KV Cache 命中率从上一轮的 99.0% 显著下滑至 **38.3%**（24,448 / 63,780 tokens，仅命中了未被修改的最前部 `tools` 子集）。随后在 Turn 2 内部（`req_id=26`、`req_id=27`），缓存命中率重新恢复至 **97.5% / 98.7%**。

---

## 4. 总结：为何前缀断裂后 KV Cache 命中率仍高达 95%–99%

1. **前缀缓存按最长公共前缀（LCP）匹配**：推理引擎的 KV Cache 复用以 token 序列的最长公共前缀为准。
2. **变更位置决定缓存损失**：
   - 在 **分段 #2→#3（95.6%）**、**#3→#4（99.0%）** 和 **#6→#7（98.7%）** 中，DuMate 的修改（`msg[4..6]` 重排、末尾 132 字符 `<system-reminder>` 丢弃）全部发生在约 62K–65K tokens 超长上下文的**最末端**。庞大的静态前缀（30/29 个工具定义 + 系统提示词 + 运行环境 + 早期对话）保持字节级不变，因此 KV Cache 仍能命中 95%–99%。
   - 相反，当变更发生在**靠前位置**（如 Turn 1 → Turn 2 移除 `knowledge_base` 工具并裁剪 `msg[3]`）时，缓存命中率会立刻跌至 **38.3%**。
3. **ATIF 轨迹分段语义**：ATIF 规范要求单条轨迹满足严格的线性 append-only 前缀关系。DuMate 每次对历史消息重排、丢弃临时提醒或插入无工具的「行动预告」请求，在协议层面均构成真实的前缀分叉，因此切分为 `continued_trajectory_ref` 链式续写分段是符合规范的准确行为。
