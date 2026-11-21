# OpenCode Harness 特征

OpenCode（`opencode` CLI / Desktop）基于 Vercel AI SDK，通过 OpenAI Chat Completions 兼容接口（`/v1/chat/completions`，SSE 流式）或 Anthropic 接口与上游通信。

## 1. 识别与元数据

- **真实 `User-Agent`**（v2.3.0 CLI）：
  ```text
  opencode/latest/2.3.0/cli
  ```
- **匹配规则**：`User-Agent` 包含 `opencode`（不区分大小写），或存在 `X-Opencode-Session` / `X-Opencode-Session-Id`。
- **版本号提取**：正则 `(?i)opencode/(?:[a-z0-9._-]+/)?v?([0-9]+\.[0-9]+[^\s);/]*)`，兼容 `opencode/latest/2.3.0/cli` 与 `opencode/2.3.0`（提取 `2.3.0`）。
- **工作目录（`work_dir`）**：从 System Prompt 的环境说明中自动提取。

| Header | 映射字段 | 说明 |
| :--- | :--- | :--- |
| `X-Opencode-Session` / `X-Opencode-Session-Id` | `session_id` | 主会话 ID（如 `ses_...`），子智能体请求中 `X-Opencode-Session-Id` 为子会话 ID |
| `X-Opencode-Parent-Session-Id` / `X-Parent-Session-Id` | `parent_session_id` / `is_subagent` | 子智能体请求专属头，指向父会话 ID，触发 `source=subAgent` 聚合 |
| `X-Opencode-Client` | — | 客户端形态（如 `cli`） |
| `X-Opencode-Project` | — | 项目哈希标识 |
| `X-Session-Affinity` | — | 路由亲和性 ID（通常与主 Session ID 一致） |
| `Traceparent` / `B3` | — | OpenTelemetry / Zipkin 分布式链路追踪头 |

## 2. 协议与轨迹特征

- **标题生成辅助请求**：新会话开始时，OpenCode 会并发/先发一次无工具（`tools=0`）的短请求为会话生成标题（`You name conversations so the user can find them later...`），复用同一 `X-Opencode-Session`。在 ATIF 严格前缀规则下会自然切分为独立的短分段。
- **子智能体（Subagent）**：主会话调用 `subagent` 工具后，子智能体与主会话可能并发交错请求，均携带相同的 `X-Opencode-Session`（父 ID），同时子智能体额外携带 `X-Opencode-Parent-Session-Id` 与独立的 `X-Opencode-Session-Id`。`llm_tracer` 按 `subagent_id` 将交错请求合并为完整子轨迹，并挂载到父轨迹 `subagent` 工具的 `subagent_trajectory_ref`。
- **动态工具集变更**：主对话轮次间若动态增减可用工具，`llm_tracer` 会按 ATIF 规范自动切分为 `continued_trajectory_ref` 续写分段，并对沿用的历史步骤标记 `is_copied_context: true`。
- **多轮与缓存**：支持 `opencode run -c` 续接同一会话，完整透传并记录 `reasoning_content`、`reasoning_tokens` 及 `cached_tokens`。

## 3. 代理接入

在工作目录创建 `opencode.json`：

```json
{
  "model": "tracer/your-model-id",
  "providers": {
    "tracer": {
      "name": "tracer",
      "package": "aisdk:@ai-sdk/openai-compatible",
      "compatibility": { "supportsPromptCacheKey": true },
      "settings": {
        "apiKey": "YOUR_API_KEY",
        "baseURL": "http://127.0.0.1:13425/proxy/local/v1"
      },
      "models": {
        "your-model-id": { "name": "your-model-id" }
      }
    }
  }
}
```

使用 `--standalone` 独立模式运行测试：

```bash
opencode run --standalone --auto --archived -m "tracer/your-model-id" \
  "Read hello.txt in the current directory and summarize it."
```
