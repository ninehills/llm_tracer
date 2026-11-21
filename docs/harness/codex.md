# Codex CLI Harness 特征

Codex（`codex` / `codex exec`，OpenAI 官方 Rust CLI）原生使用 **OpenAI Responses API**（`/v1/responses`，SSE 流式）与上游通信。

## 1. 识别与元数据

- **真实 `User-Agent`**（以 `codex_exec` 为例）：
  ```text
  codex_exec/0.169.0 (Mac OS 26.6.0; arm64) ghostty (codex_exec; 0.169.0)
  ```
- **匹配规则**：`User-Agent` 包含 `codex`（不区分大小写）。
- **版本号提取**：正则 `(?i)codex[^/\s]*/([0-9]+\.[0-9]+[^\s);]*)`（如 `0.169.0`）。
- **工作目录（`work_dir`）**：从上下文环境信息中的 `<cwd>...</cwd>` 或 `X-Codex-Turn-Metadata` 提取。

| Header / Body 字段 | 映射字段 | 说明 |
| :--- | :--- | :--- |
| `Session-Id` / `Thread-Id` / `Session_id` | `session_id` | 主会话 UUID（如 `01a1fd7d-...`），多轮及子智能体共享 `Session-Id` |
| `X-Openai-Subagent` / `X-Codex-Parent-Thread-Id` | `is_subagent` / `subagent_id` | 子智能体请求专属头（如 `collab_spawn`），配合独立 `Thread-Id` 识别并聚合子轨迹 |
| Body `prompt_cache_key` | `session_id`（回退） | 与 `Session-Id` 一致，用于服务端 KV Cache 路由 |
| `Originator` | — | 调用来源（如 `codex_exec`） |
| `X-Codex-Turn-Metadata` | — | JSON 元数据，包含 `session_id`、`thread_id`、`thread_source`（`user`/`subagent`）、`agent_name`、`sandbox_mode`、`reasoning_effort` 等 |
| `X-Codex-Window-Id` / `X-Codex-Beta-Features` | — | 上下文窗口 ID 与实验特性开关 |

## 2. 协议与轨迹特征

- **协议**：`POST /v1/responses`（`wire_api = "responses"`），SSE 流式事件（`response.created`、`response.output_item.added`、`response.output_text.delta`、`response.reasoning_summary_text.delta`、`response.function_call_arguments.delta`、`response.completed` 等）。
- **子智能体（Subagent）**：主会话调用 `spawn_agent` / `wait_agent` 工具后，子智能体复用父 `Session-Id`，同时携带 `X-Openai-Subagent: collab_spawn`、`X-Codex-Parent-Thread-Id`、独立 `Thread-Id` 及 `X-Codex-Turn-Metadata.thread_source = "subagent"`。`llm_tracer` 自动按 `Thread-Id` 聚合为 `subagent_trajectories` 并关联至 `spawn_agent` 观测结果。
- **多轮与 ATIF 聚合**：支持 `codex exec resume --last` 续接同一会话；多轮工具调用保持前缀一致，稳定聚合为 ATIF-v1.8 轨迹，完整解析 `reasoning_content`、`tool_calls`、`observation` 及 `input_tokens_details.cached_tokens`。

## 3. 代理接入

无需修改全局 `~/.codex/config.toml`，可通过 `-c` 参数临时指向代理：

```bash
TRACER_API_KEY="YOUR_API_KEY" codex exec \
  -c 'model_provider="tracer"' \
  -c 'model_providers.tracer.name="tracer"' \
  -c 'model_providers.tracer.base_url="http://127.0.0.1:13425/proxy/local/v1"' \
  -c 'model_providers.tracer.wire_api="responses"' \
  -c 'model_providers.tracer.env_key="TRACER_API_KEY"' \
  -c 'model="your-model-id"' \
  --sandbox read-only \
  "Read hello.txt in the current directory and summarize it."
```
