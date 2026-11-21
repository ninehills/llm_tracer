# Pi Coding Agent Harness 特征

Pi（`pi` CLI，基于 Node.js / Stainless SDK）支持 OpenAI Chat Completions、OpenAI Responses 及 Anthropic Messages 多种上游协议，通过 `models.json` 配置自定义 Provider。

## 1. 识别与元数据

- **真实 `User-Agent`**：
  ```text
  pi/1.5.0 (darwin; node/v26.13.0; arm64)
  ```
- **匹配规则**（满足其一即命中 `harness="pi"`）：
  - `User-Agent` 为 `pi`、包含 `pi/`、`pi-agent` 或 `pi-coding-agent`（不区分大小写）。
  - 请求头 `X-Opencode-Client: pi`、`X-OpenRouter-Title: pi`，或 `Referer` / `HTTP-Referer` 包含 `pi.dev`。
- **版本号提取**：正则 `(?i)\bpi(?:-(?:coding-)?agent)?/([0-9]+\.[0-9]+[^\s);]*)`（如 `1.5.0`）。
- **Session ID 提取**：
  - 优先读取 Header：`X-Session-Id` / `Session_id` / `X-Opencode-Session` / `X-Session-Affinity`。
  - 其次读取 Body：`prompt_cache_key`、`metadata.session_id`、`metadata.sessionId`。
  - 使用 `--no-session` 或自定义 `openai-completions` Provider 未携带上述字段时，由 `llm_tracer` 基于 `(harness, upstream, system_prompt, first_user_message)` 生成稳定回退 ID（`sess-<16hex>`），同一对话的多轮工具调用自动归入同一 Session。
- **工作目录（`work_dir`）**：从 System Prompt 中的 `Current working directory: <path>` 自动提取。

## 2. 协议与轨迹特征

- **支持协议**：通过 `models.json` 的 `api` 字段切换（如 `openai-completions` → `/v1/chat/completions`、`openai-responses` → `/v1/responses`、`anthropic-messages` → `/v1/messages`），默认开启 SSE 流式响应。
- **工具集**：默认提供 `read`、`bash`、`edit`、`write` 四个核心工具，轮次间工具定义与消息前缀严格追加，单次任务通常聚合为 **1 条完整 ATIF-v1.8 轨迹**（无多余分段）。
- **SDK 请求头**：附带标准 Stainless 元数据头（`X-Stainless-Lang: js`、`X-Stainless-Runtime: node`、`X-Stainless-Arch` 等）。

## 3. 代理接入

创建临时配置目录并写入 `models.json`：

```json
{
  "providers": {
    "proxy-local": {
      "baseUrl": "http://127.0.0.1:13425/proxy/local/v1",
      "api": "openai-completions",
      "apiKey": "YOUR_API_KEY",
      "models": [
        {
          "id": "your-model-id",
          "name": "Your Model",
          "reasoning": false,
          "input": ["text"],
          "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
          "contextWindow": 128000,
          "maxTokens": 4096
        }
      ]
    }
  }
}
```

运行测试：

```bash
PI_CODING_AGENT_DIR=/tmp/pi-tracer-test \
  pi -p --no-session --provider proxy-local --model your-model-id \
  "请读取当前目录的 go.mod 文件并总结模块名称"
```
