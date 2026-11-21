# DuMate Harness 特征

DuMate（桌面智能体应用 `DuMate.app`）通过 OpenAI Chat Completions 兼容接口（`/v1/chat/completions`，SSE 流式）与上游通信，在 HTTP Header、子智能体路由及 Prompt 组装上有以下特征。

## 1. 识别与元数据

- **User-Agent**：
  ```text
  Go-http-client/1.1 ai-sdk/provider-utils/3.0.20 runtime/bun/1.3.14 DumateApp/1.0.93.526
  ```
- **匹配规则**：`User-Agent` 包含 `dumate`（不区分大小写），或存在 `X-Dumate-Session-Id` / `X-Dumate-Request-Id`。
- **版本号提取**：正则 `(?i)dumate(?:app)?[\s/_-]+v?([0-9]+\.[0-9]+[^\s);]*)`（如 `1.0.93.526`）。
- **工作目录（`work_dir`）**：不在 Header 中传递，而是位于上下文 `<runtime_env>` 块的中文行 `工作目录: /path/to/workspace`，由 `extractCommonWorkDir` 自动提取。

| Header | 映射字段 | 说明 |
| :--- | :--- | :--- |
| `X-Dumate-Session-Id` | `session_id` | 会话 ID（如 `ses_...`），主/子智能体共享 |
| `X-Dumate-Request-Extra-Param` | 扩展元数据 | 逗号分隔 `k=v`：`source`（`user`/`subAgent`）、`sandbox`、`sandboxType`、`fixedModel`、`firstRequest` |
| `X-Dumate-Request-Id` | `request_id` | 单次 LLM 请求 UUID |
| `X-Dumate-Account-Id` / `X-Appbuilder-Dumate-Account-Id` | `account_id` / `appbuilder_account_id` | 账号标识 |
| `X-Dumate-Device-Id` / `X-Dumate-Prd-Source` | `device_id` / `prd_source` | 设备指纹 / 产品来源 |

## 2. 主 / 子智能体（Subagent）机制

- **同 Session 分流**：主智能体与子智能体携带相同的 `X-Dumate-Session-Id`，通过 `X-Dumate-Request-Extra-Param` 中的 `source=user` 与 `source=subAgent` 区分。
- **ATIF 聚合**：`llm_tracer` 将 `source=subAgent` 聚合到 `subagent_trajectories`（`<session_id>#subagent-<n>`），并解析 `task` 工具返回结果中的 `task_id: ses_...`，在主轨迹对应 `ObservationResult` 上自动挂接 `subagent_trajectory_ref`。
- **`tool_call_id` 重写**：回填历史消息时，DuMate 会将上游返回的 `tool_call_id` 归一化重写为短 ID（`t1`、`t3`、`t5` 等）。`llm_tracer` 自动建立映射以保持 `ToolCall.tool_call_id` 与 `ObservationResult.source_call_id` 对齐。

## 3. Prompt 前缀与 KV Cache 特征

在 ATIF 严格前缀校验下，DuMate 的以下行为会触发 `continued_trajectory_ref` 轨迹分段（均属真实协议前缀变更）：

1. **「行动预告」辅助请求**：每轮用户输入前会先发一次无 `tools`、独立短系统提示词的 `source=user` 预告请求，独立成短分段。
2. **尾部临时 `<system-reminder>` 丢弃或重排**：部分请求末尾注入临时引导 `<system-reminder>`，下一轮回填历史时丢弃或调整位置；由于发生在超长前缀末端，KV Cache 命中率仍可达 **95%–99%**。
3. **跨轮次工具集/历史块裁剪**：新一轮对话若增删工具定义或裁剪早期消息内嵌块，会破坏靠前前缀，导致该轮 KV Cache 命中率明显下降（随后在轮内恢复至 97%+）。

## 4. 代理接入

在 DuMate 自定义模型配置中将 Base URL 设为：

```text
http://127.0.0.1:13425/proxy/<upstream>/v1
```
