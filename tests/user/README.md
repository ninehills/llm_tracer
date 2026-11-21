# 用户测试指南（User Testing Guide）

本指南用于端到端人工验证 `llm_tracer` 的完整功能，覆盖 **Dashboard UI** 及 **Pi、DuMate、Codex、OpenCode、Claude Code** 五类真实 Agent Harness 流量转发。各 Harness 的协议细节与 Header 特征参见 [`docs/harness/`](../../docs/harness/)。

> **测试设计原则**：每个 Harness 采用 **单次多能力提示词 + 追加提问（多轮会话）** 的方式，在同一个 Session 内同时验证文件读取、子智能体（Bash `echo OK`）、多轮上下文记忆、Session 聚合与 KV Cache 命中率。测试前可在临时工作目录执行 `echo "TOKEN_TEST_101" > probe.txt`。

---

## 前置准备

1. 编译并启动 `llm_tracer`：
   ```bash
   make build
   cp config.toml.example config.toml
   # 按需编辑 config.toml 中的 [upstreams.<name>] URL
   ./llm_tracer -config config.toml
   ```
2. 确认服务已就绪（默认监听 `http://127.0.0.1:13425`）：
   ```bash
   curl -s http://127.0.0.1:13425/api/auth/status
   ```

---

## 场景一：Dashboard UI 功能测试

在浏览器打开 `http://127.0.0.1:13425`：

1. **主题与语言切换**：验证右上角 Light/Dark 主题与 ZH/EN 语言切换正常且刷新后持久化。
2. **Trace 列表与筛选**：
   - 按 `Harness`（`pi` / `dumate` / `claude-code` / `codex` / `opencode` / `generic`）、`Upstream`、`Model`、`API Key Hash` 及关键字筛选。
   - 检查列表展示：Harness 徽章、Model、Client IP、API Key SHA-256 前缀、`work_dir`、LLM 调用次数（`llm_call_count`）、Token 统计及 KV Cache 命中率。
3. **ATIF-v1.8 详情、头部 Hover 提示与多轨迹分段**：
   - 将鼠标悬停在详情页顶部所有徽章（Harness、Schema、Upstream、Model、Key Hash、Client IP、Work Dir）上，验证中英文悬停说明及 Upstream 完整 URL 展示正常。
   - 查看包含前缀变更或子智能体的 Session，验证顶部 Trajectory 分段切换器（`continued_trajectory_ref`）与 `subagent_trajectories`。
   - 展开/折叠 `system` / `user` / `agent` 步骤、Reasoning 块、`tool_calls` 与 `observation` 及 `is_copied_context` 标记。
4. **Raw HTTP & SSE 检视器**：
   - 切换至 **HTTP Inspector**，确认 `Authorization` / `x-api-key` 等鉴权头已脱敏为 `[REDACTED]`，SSE 流支持 **Merged** 与 **Chunks** 切换（覆盖 Chat Completions、Responses API 与 Anthropic Messages）。
5. **批量导出 JSONL**：勾选多个 Trace 导出 `.jsonl`，验证每行均为合法 ATIF-v1.8 JSON。
6. **鉴权与非本机安全警告**：
   - 设置 `dashboard_key = "your-secret"` 重启，验证登录拦截与登出流程。
   - 设置 `listen = "0.0.0.0:13425"` 且 `dashboard_key = ""`，验证页面顶部展示非本机无鉴权警告横幅。

---

## 场景二：Pi Agent（OpenAI / Anthropic，多轮交互）

详见 [`docs/harness/pi.md`](../../docs/harness/pi.md)。

1. 创建临时配置 `/tmp/pi-tracer-test/models.json`，将 `baseUrl` 指向 `http://127.0.0.1:13425/proxy/local/v1`（`api` 可选 `openai-completions` / `openai-responses` / `anthropic-messages`）。
2. 启动交互式会话（或通过 `--continue` 续接）完成两轮测试：
   ```bash
   PI_CODING_AGENT_DIR=/tmp/pi-tracer-test \
     pi --provider proxy-local --model your-model-id
   ```
   - **Turn 1**：`请读取当前目录的 probe.txt 获取里面的 token，再用 Bash 执行 echo OK，最后把 token 和输出一起返回给我。`
   - **Turn 2（追加提问）**：`刚才读到的 token 和 Bash 命令输出分别是什么？请简短回答。`
3. **验证点**：识别 `harness = pi` 及版本号、提取 `work_dir`、两轮请求聚合至同一 Session 的 ATIF 轨迹并记录 `tool_calls` / `observation`。

---

## 场景三：Codex CLI（OpenAI Responses API + 子智能体 + 多轮）

详见 [`docs/harness/codex.md`](../../docs/harness/codex.md)。

1. **Turn 1**（文件读取 + `spawn_agent` 子智能体执行 `echo OK`）：
   ```bash
   TRACER_API_KEY="YOUR_API_KEY" codex exec --skip-git-repo-check \
     -c 'model_provider="tracer"' \
     -c 'model_providers.tracer.name="tracer"' \
     -c 'model_providers.tracer.base_url="http://127.0.0.1:13425/proxy/local/v1"' \
     -c 'model_providers.tracer.wire_api="responses"' \
     -c 'model_providers.tracer.env_key="TRACER_API_KEY"' \
     -c 'model="your-model-id"' \
     --sandbox read-only \
     "请先读取当前目录的 probe.txt 获取里面的 token，再启动一个子智能体（如 spawn_agent）用 Bash 执行 echo OK，最后把读取到的 token 和子智能体输出一起返回给我。"
   ```
2. **Turn 2**（同 Session 追加提问）：
   ```bash
   TRACER_API_KEY="YOUR_API_KEY" codex exec resume --last --skip-git-repo-check \
     -c 'model_provider="tracer"' \
     -c 'model_providers.tracer.name="tracer"' \
     -c 'model_providers.tracer.base_url="http://127.0.0.1:13425/proxy/local/v1"' \
     -c 'model_providers.tracer.wire_api="responses"' \
     -c 'model_providers.tracer.env_key="TRACER_API_KEY"' \
     -c 'model="your-model-id"' \
     "追加提问：刚才读到的 token 是什么？子智能体执行的命令和输出分别是什么？请简短回答。"
   ```
3. **验证点**：识别 `harness = codex` 及版本号（如 `0.169.0`）；两轮与子智能体共享同一 `Session-Id`；子智能体通过 `X-Openai-Subagent` / `Thread-Id` 独立聚合至 `subagent_trajectories` 并关联至 `spawn_agent`；完整解析 `reasoning_content`、`exec_command` 及高比例 `cached_tokens`。

---

## 场景四：OpenCode CLI（OpenAI Chat Completions + 子智能体 + 多轮）

详见 [`docs/harness/opencode.md`](../../docs/harness/opencode.md)。

1. 在临时测试目录创建 `opencode.json`，配置自定义 Provider `settings.baseURL = "http://127.0.0.1:13425/proxy/local/v1"`。
2. **Turn 1**（文件读取 + `subagent` 子智能体执行 `echo OK`）：
   ```bash
   opencode run --standalone --auto -m "tracer/your-model-id" \
     "请先读取当前目录的 probe.txt 获取里面的 token，再使用 subagent 工具启动一个子智能体用 Bash 执行 echo OK，最后把读取到的 token 和子智能体输出一起返回给我。"
   ```
3. **Turn 2**（使用 `-c` 同 Session 追加提问）：
   ```bash
   opencode run --standalone --auto -c -m "tracer/your-model-id" \
     "追加提问：刚才读到的 token 是什么？子智能体执行的命令和输出分别是什么？请简短回答。"
   ```
4. **验证点**：识别 `harness = opencode` 及版本号（如 `2.3.0`）；两轮共享同一 `X-Opencode-Session`；并发子智能体通过 `X-Opencode-Parent-Session-Id` 与 `X-Opencode-Session-Id` 完整聚合至 `subagent_trajectories` 并关联到 `subagent` 工具观测结果。

---

## 场景五：Claude Code（Anthropic Messages API + 子智能体 + 多轮）

详见 [`docs/harness/claude-code.md`](../../docs/harness/claude-code.md)。

1. **Turn 1**（文件读取 + `Agent` 子智能体执行 `echo OK`；注意 Base URL 不带 `/v1`）：
   ```bash
   SETTINGS_JSON='{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:13425/proxy/local","ANTHROPIC_API_KEY":"YOUR_API_KEY","ANTHROPIC_AUTH_TOKEN":"YOUR_API_KEY"}}'
   claude -p --settings "$SETTINGS_JSON" --model "your-model-id" --dangerously-skip-permissions -- \
     "请先读取当前目录的 probe.txt 获取里面的 token，再使用 Agent 工具启动一个子智能体用 Bash 执行 echo OK，最后把读取到的 token 和子智能体输出一起返回给我。"
   ```
2. **Turn 2**（使用 `-c` 同 Session 追加提问，或在交互式 `claude` 会话中继续追问）：
   ```bash
   claude -p -c --settings "$SETTINGS_JSON" --model "your-model-id" --dangerously-skip-permissions -- \
     "追加提问：刚才读到的 token 是什么？子智能体执行的命令和输出分别是什么？请简短回答。"
   ```
3. **验证点**：识别 `harness = claude-code` 及版本号（如 `2.1.330`）；从 `X-Claude-Code-Session-Id` / `metadata.user_id` 提取统一 UUID `session_id`；提取 `work_dir`；子智能体通过 `X-Claude-Code-Agent-Id` / `cc_is_subagent=true` 聚合至 `subagent_trajectories` 并关联至 `Agent` 工具；完整解析 `/v1/messages` SSE 的 `tool_use` / `tool_result` 与缓存命中率。

---

## 场景六：DuMate GUI（子智能体 + 多轮交互）

详见 [`docs/harness/dumate.md`](../../docs/harness/dumate.md)。

1. 在 DuMate 自定义模型配置中将 Base URL 设为 `http://127.0.0.1:13425/proxy/local/v1`。
2. 在同一对话中依次发送两轮消息：
   - **Turn 1**：`请先读取当前目录的 probe.txt 获取里面的 token，再使用子智能体调用 Bash 执行 echo OK，最后把 token 和输出一起返回给我。`
   - **Turn 2（追加提问）**：`刚才读到的 token 和子智能体输出分别是什么？请简短回答。`
3. **验证点**：识别 `harness = dumate`、版本号及中文 `工作目录`；`source=subAgent` 独立聚合至 `subagent_trajectories` 并通过 `task_id` 关联到主轨迹 `task` 工具观测结果；多轮追加提问复用同一 `X-Dumate-Session-Id`。

---

## 验收检查清单（Verification Checklist）

- [ ] 透明转发：Chat Completions、Responses API、Anthropic Messages 三种协议的流式（SSE）与非流式转发均正常。
- [ ] 密钥脱敏：SQLite 与 Dashboard 中不出现明文 API Key，仅保留 SHA-256 哈希。
- [ ] Harness 识别：Pi、DuMate、Claude Code、Codex、OpenCode、Generic 均能准确识别并提取版本号、`session_id` 与 `work_dir`。
- [ ] 子智能体与多轮聚合：Claude Code、OpenCode、Codex、DuMate 子智能体均准确聚合至 `subagent_trajectories` 并关联至父工具观测；多轮追加提问共享同一 `session_id`。
- [ ] ATIF-v1.8 合规：单条查看与批量导出的 JSONL 均严格符合 ATIF-v1.8 Schema。
- [ ] 原始日志落盘：`raw_logs/requests-YYYY-MM-DD.jsonl` 按天追加且包含完整请求/响应体。
- [ ] Dashboard UI：Light/Dark、ZH/EN、头部所有字段 Hover 提示、HTTP Inspector（Merged/Chunks）、筛选与导出均工作正常。
