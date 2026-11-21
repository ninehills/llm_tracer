# Claude Code Harness 特征

Claude Code（`claude` CLI）使用 **Anthropic Messages API**（`POST /v1/messages?beta=true`，SSE 流式）与上游通信。

## 1. 识别与元数据

- **真实 `User-Agent`**（v2.1.330 CLI）：
  ```text
  claude-cli/2.1.330 (external, sdk-cli)
  ```
- **匹配规则**：`User-Agent` 包含 `claude-cli`、`claude-code` 或 `claude_code`（不区分大小写）。
- **版本号提取**：正则 `(?i)claude[-_](?:cli|code)/([0-9]+\.[0-9]+[^\s);]*)`（如 `2.1.330`）。
- **Session ID 提取**：
  1. 优先读取 Header：`X-Claude-Code-Session-Id` / `X-Session-Id` / `X-Claude-Session-Id` / `Anthropic-Session-Id`。
  2. 其次解析请求体 `metadata.user_id`：支持新版 JSON 字符串（`{"device_id":"...","account_uuid":"","session_id":"<uuid>"}`）以及旧版字符串（`user_<hash>_account_<id>_session_<sid>`）。
- **工作目录（`work_dir`）**：从环境信息中的 `Primary working directory: <path>` 或 `Working directory: <path>` 自动提取。

| Header / Body 字段 | 映射字段 | 说明 |
| :--- | :--- | :--- |
| `X-Claude-Code-Session-Id` | `session_id` | 会话 UUID，多轮及子智能体调用共享同一会话 ID |
| `X-Claude-Code-Agent-Id` | `subagent_id` / `is_subagent` | 子智能体请求专属标识（存在时标记 `source=subAgent`） |
| `x-api-key` / `Authorization` | `api_key_hash`（SHA-256） | Anthropic 鉴权密钥，落盘前自动脱敏为 `[REDACTED]` |
| `Anthropic-Version` / `Anthropic-Beta` | — | API 版本（`2023-06-01`）与 Beta 能力开关 |
| `X-App` / `X-Stainless-*` | — | 客户端类型（`cli`）与 JS SDK 运行时信息 |
| `metadata.user_id` | `session_id`（回退） | JSON 或拼接字符串形式的会话标识 |

## 2. 协议与子智能体特征

- **协议**：`POST /v1/messages?beta=true`，SSE 事件流包含 `message_start`、`content_block_start`（`text` / `thinking` / `tool_use`）、`content_block_delta`、`message_delta`、`message_stop`。
- **子智能体（Subagent）**：主会话调用 `Agent` 工具后，子智能体复用同一 `X-Claude-Code-Session-Id` 并携带 `X-Claude-Code-Agent-Id`（且 System Prompt 含 `cc_is_subagent=true;`）。`llm_tracer` 自动将其聚合为 `subagent_trajectories` 并通过 `subagent_trajectory_ref` 关联到父轨迹 `Agent` 工具的观测结果。
- **多轮与缓存**：`claude -p -c` / 交互式多轮对话保持同一 `session_id` 与前缀一致，完整记录 `cache_read_input_tokens` 与 `cache_creation_input_tokens`。

## 3. 代理接入

通过 `--settings` 或环境变量将 `ANTHROPIC_BASE_URL` 指向 `llm_tracer`（Base URL **不带** `/v1`，若 `~/.claude/settings.json` 已配置 `env.ANTHROPIC_BASE_URL`，需使用 `--settings` 覆盖）：

```bash
claude -p \
  --settings '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:13425/proxy/local","ANTHROPIC_API_KEY":"YOUR_API_KEY","ANTHROPIC_AUTH_TOKEN":"YOUR_API_KEY"}}' \
  --model "your-model-id" \
  --dangerously-skip-permissions -- \
  "先读取当前目录的 probe.txt 获取 token，再用 Agent 工具启动子智能体用 Bash 执行 echo OK，最后一起返回结果。"

claude -p -c \
  --settings '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:13425/proxy/local","ANTHROPIC_API_KEY":"YOUR_API_KEY","ANTHROPIC_AUTH_TOKEN":"YOUR_API_KEY"}}' \
  --model "your-model-id" \
  --dangerously-skip-permissions -- \
  "追加提问：刚才读到的 token 和子智能体输出分别是什么？"
```
