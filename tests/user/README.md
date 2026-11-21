# 用户测试指南（User Testing Guide）

本指南用于指导人工端到端验证 `llm_tracer` 的完整功能，涵盖 **Dashboard UI**、**Pi Agent 真实流量转发** 以及 **DuMate GUI 与子智能体（Subagent）协作** 三个核心场景。

---

## 前置准备

1. 编译并启动 `llm_tracer`：
   ```bash
   make build
   cp config.toml.example config.toml
   # 根据实际需要编辑 config.toml 中的 upstream URL
   ./llm_tracer -config config.toml
   ```
2. 确认服务已监听（默认 `http://127.0.0.1:13425`）：
   ```bash
   curl -s http://127.0.0.1:13425/api/auth/status
   ```

---

## 场景一：Dashboard UI 功能测试

在浏览器打开 `http://127.0.0.1:13425`：

1. **主题与语言切换**：
   - 点击右上角主题按钮，验证浅色（Light）/ 深色（Dark）主题切换正常且刷新后持久化。
   - 点击右上角语言按钮，验证中文（ZH）/ 英文（EN）文案切换完整无遗漏。
2. **Trace 列表与筛选**：
   - 按 `Harness`（如 `pi`、`dumate`、`claude-code`、`codex`、`opencode`、`generic`）、`Upstream`、`Model`、`API Key Hash` 和关键字进行过滤。
   - 验证列表展示：Harness 徽章、Model、Client IP、API Key SHA-256 前缀、工作目录（`work_dir`）、步骤数 / 轨迹分段数、Token 统计（Prompt / Completion / Cached）及 KV Cache 命中率。
3. **Trace 详情与 ATIF-v1.8 多轨迹分段**：
   - 点击包含多轮对话或前缀变更的 Session，检查顶部 Trajectory 分段切换器（`continued_trajectory_ref`）。
   - 验证树形时间线中展开/折叠 `system` / `user` / `agent` 步骤、Reasoning（Thinking）块、`tool_calls` 参数与 `observation` 返回结果，以及 `is_copied_context` 标记。
4. **Raw HTTP & SSE 检视器**：
   - 切换至 **HTTP Inspector**（原始请求/响应面板），检查：
     - Request / Response Headers 中敏感鉴权字段（`Authorization`、`x-api-key` 等）已脱敏为 `***`。
     - SSE 流式响应支持在 **Merged（聚合视图）** 与 **Chunks（原始分块视图）** 之间切换。
5. **批量导出 JSONL**：
   - 勾选多个 Trace，点击导出按钮，验证下载的 `.jsonl` 文件每行均为合法的 ATIF-v1.8 JSON 对象。
6. **鉴权与非本机安全警告**：
   - 在 `config.toml` 中设置 `dashboard_key = "your-secret"` 并重启，验证未登录时跳转到登录页，输入正确密钥后可正常访问。
   - 将 `listen` 设为 `0.0.0.0:13425` 且 `dashboard_key = ""`，验证页面顶部出现非本机无鉴权安全警告横幅。

---

## 场景二：Pi Agent 真实转发测试

通过代理转发 `pi` CLI 的 OpenAI / Anthropic 协议请求：

1. 创建临时 Pi Agent 配置目录并写入 `models.json`：
   ```bash
   mkdir -p /tmp/pi-tracer-test
   cat > /tmp/pi-tracer-test/models.json <<'EOF'
   {
     "providers": {
       "proxy-openai": {
         "baseUrl": "http://127.0.0.1:13425/proxy/openai/v1",
         "api": "openai-completions",
         "apiKey": "YOUR_OPENAI_API_KEY",
         "models": [
           {
             "id": "gpt-4o-mini",
             "name": "GPT-4o Mini",
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
   EOF
   ```
2. 执行带工具调用的多轮任务：
   ```bash
   PI_CODING_AGENT_DIR=/tmp/pi-tracer-test \
     pi -p --no-session --provider proxy-openai --model gpt-4o-mini \
     "请读取当前目录的 go.mod 文件并总结模块名称与 Go 版本"
   ```
3. 验证点：
   - `pi` 正常完成工具调用并输出最终总结（字节级透明转发无破坏）。
   - Dashboard 中自动识别 `harness = pi` 及对应版本号，正确提取当前 `work_dir`。
   - 多轮请求严格按前缀聚合在同一条 ATIF-v1.8 轨迹中，包含完整的 `tool_calls` 与 `observation`。
   - `raw_logs/requests-YYYY-MM-DD.jsonl` 已追加对应的原始请求与响应记录。

---

## 场景三：DuMate GUI 与子智能体（Subagent）测试

1. 在 DuMate 客户端自定义模型配置中，将 Base URL 指向 `llm_tracer` 代理地址（例如 `http://127.0.0.1:13425/proxy/local/v1`）。
2. 在 DuMate 中发起包含子智能体委派的对话，例如：
   > 请使用子智能体调用 Bash 输出 `echo OK`
3. 验证点：
   - Dashboard 中自动识别 `harness = dumate`、版本号（如 `DumateApp/x.y.z`）及从 `<runtime_env>` 提取的中文 `工作目录`。
   - 主智能体（`source=user`）与子智能体（`source=subAgent`）的请求共享同一 `X-Dumate-Session-Id`，但在 ATIF-v1.8 轨迹中自动分离：子智能体独立聚合在 `subagent_trajectories` 中，并在主轨迹 `task` 工具的 `observation` 上关联 `subagent_trajectory_ref`。
   - 若对话中发生「行动预告」辅助请求或 `<system-reminder>` 重排/裁剪，系统自动切分为 `continued_trajectory_ref` 续写分段并准确统计各段 KV Cache 命中率。

---

## 验收检查清单（Verification Checklist）

- [ ] 透明转发：流式（SSE）与非流式请求响应均正常返回，不篡改业务报文。
- [ ] 密钥脱敏：SQLite 与 Dashboard 中不出现明文 API Key，仅保留 SHA-256 哈希。
- [ ] Harness 识别：Pi、DuMate、Claude Code、Codex、OpenCode、Generic 均能准确归类。
- [ ] ATIF-v1.8 合规：单条查看与批量导出的 JSONL 均严格符合 ATIF-v1.8 Schema。
- [ ] 原始日志落盘：`raw_logs/requests-YYYY-MM-DD.jsonl` 按天追加且包含完整请求/响应体。
- [ ] Dashboard UI：Light/Dark、ZH/EN、HTTP Inspector（Merged/Chunks）、筛选与导出均工作正常。
