import type {
  TokenUsage,
  TraceReasoning,
  TraceReasoningLevel,
  TraceRecord,
  TraceSpan,
  TraceSpanAttribute,
  TraceSpanCategory,
} from '@evilmartians/agent-prism-types';
import type {
  AtifContentPart,
  AtifMetrics,
  AtifStep,
  AtifTrajectory,
} from '../types';

export interface SubagentRefInfo {
  trajectory_id?: string;
  trajectory_path?: string;
  session_id?: string;
}

export interface AtifSpanMetadata extends Record<string, unknown> {
  stepId?: number;
  source?: string;
  modelName?: string;
  requestedModel?: string;
  responseModel?: string;
  responseId?: string;
  finishReason?: string;
  statusCode?: number;
  latencyMs?: number;
  isStream?: boolean;
  upstream?: string;
  httpMethod?: string;
  httpPath?: string;
  requestRecordId?: number;
  requestId?: string;
  stepSourceMeta?: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  toolCallId?: string;
  rawToolCallId?: string;
  functionName?: string;
  subagentRefs?: SubagentRefInfo[];
  isCopiedContext?: boolean;
  toolDefinitions?: Array<Record<string, unknown>>;
  sessionId?: string;
  trajectoryId?: string;
  continuedTrajectoryRef?: string;
  harness?: string;
  agentName?: string;
  agentVersion?: string;
  workDir?: string;
  apiKeyHash?: string;
  clientIp?: string;
  schemaVersion?: string;
  llmCallCount?: number;
  subagentCount?: number;
  startTime?: string;
  endTime?: string;
  extraFields?: Record<string, unknown>;
  kind: 'root' | 'step' | 'tool_call' | 'observation';
}

export interface AdaptedAtifTrace {
  record: TraceRecord;
  spans: TraceSpan<AtifSpanMetadata>[];
  workDir: string;
  upstream: string;
  harness: string;
  apiKeyHash: string;
  clientIp: string;
  llmCallCount: number;
  subagentCount: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCachedTokens: number;
  totalCostUsd?: number;
}

export function getTrajectoryLlmCallCount(atif: AtifTrajectory): number {
  const extraVal = atif.extra?.llm_call_count;
  if (extraVal !== undefined && extraVal !== null && extraVal !== '') {
    const parsed = Number(extraVal);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  const fmVal = atif.final_metrics?.extra?.llm_call_count;
  if (fmVal !== undefined && fmVal !== null && fmVal !== '') {
    const parsed = Number(fmVal);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  const steps = Array.isArray(atif.steps) ? atif.steps : [];
  return steps.filter((s) => s.source === 'agent' && s.is_copied_context !== true).length;
}

export function getTrajectoryTreeLlmCallCount(atif: AtifTrajectory): number {
  let total = getTrajectoryLlmCallCount(atif);
  const subTrajs = Array.isArray(atif.subagent_trajectories) ? atif.subagent_trajectories : [];
  for (const sub of subTrajs) {
    total += getTrajectoryTreeLlmCallCount(sub);
  }
  return total;
}

export function renderAtifMessage(content: string | AtifContentPart[] | undefined): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content, null, 2);
  return content
    .map((part) => {
      if (part && typeof part === 'object' && 'type' in part) {
        if (part.type === 'text' && 'text' in part && typeof part.text === 'string') {
          return part.text;
        }
        if (part.type === 'image' && 'source' in part) {
          const src = part.source as { media_type?: string; path?: string };
          return `[image: ${src?.media_type ?? 'unknown'} ${src?.path ?? ''}]`.trim();
        }
        if (part.type === 'audio' && 'source' in part) {
          const src = part.source as { media_type?: string; path?: string };
          return `[audio: ${src?.media_type ?? 'unknown'} ${src?.path ?? ''}]`.trim();
        }
      }
      return JSON.stringify(part);
    })
    .join('\n');
}

function parseDate(ts: string | undefined, fallbackMs: number): Date {
  if (!ts) return new Date(fallbackMs);
  const parsed = Date.parse(ts);
  if (Number.isNaN(parsed)) return new Date(fallbackMs);
  return new Date(parsed);
}

function buildAttributes(entries: Array<[string, string | number | boolean | undefined]>): TraceSpanAttribute[] {
  const attrs: TraceSpanAttribute[] = [];
  const seen = new Set<string>();
  for (const [key, val] of entries) {
    if (val === undefined || val === '' || seen.has(key)) continue;
    seen.add(key);
    if (typeof val === 'string') {
      attrs.push({ key, value: { stringValue: val } });
    } else if (typeof val === 'boolean') {
      attrs.push({ key, value: { boolValue: val } });
    } else if (typeof val === 'number') {
      if (Number.isInteger(val)) {
        attrs.push({ key, value: { intValue: val } });
      } else {
        attrs.push({ key, value: { doubleValue: val } });
      }
    }
  }
  return attrs;
}

function flattenExtraEntries(
  prefix: string,
  obj: Record<string, unknown> | undefined
): Array<[string, string | number | boolean | undefined]> {
  if (!obj) return [];
  const out: Array<[string, string | number | boolean | undefined]> = [];
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined || val === null || val === '') continue;
    const attrKey = prefix ? `${prefix}.${key}` : key;
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      out.push([attrKey, val]);
    } else {
      out.push([attrKey, JSON.stringify(val)]);
    }
  }
  return out;
}

function mergeExtraObjects(
  ...objs: Array<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {};
  for (const obj of objs) {
    if (!obj) continue;
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null || v === '') continue;
      if (!(k in merged)) {
        merged[k] = v;
      }
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mapTokenUsage(metrics: AtifMetrics | undefined): TokenUsage | undefined {
  if (!metrics) return undefined;
  const prompt = metrics.prompt_tokens ?? 0;
  const cached = metrics.cached_tokens ?? 0;
  const completion = metrics.completion_tokens ?? 0;
  if (prompt === 0 && cached === 0 && completion === 0) return undefined;

  const usage: TokenUsage = {};
  const uncachedInput = Math.max(0, prompt - cached);
  if (uncachedInput > 0) {
    usage.input = { tokens: uncachedInput };
  }
  if (cached > 0) {
    usage.cache_read = { tokens: cached };
  }
  if (completion > 0) {
    usage.output = {
      tokens: completion,
      ...(metrics.cost_usd !== undefined ? { cost: metrics.cost_usd } : {}),
    };
  }
  const cacheWrite = metrics.extra?.cache_creation_input_tokens;
  if (typeof cacheWrite === 'number' && cacheWrite > 0) {
    usage.cache_write = { tokens: cacheWrite };
  }
  return usage;
}

function mapReasoning(step: AtifStep): TraceReasoning | undefined {
  const content = step.reasoning_content ?? '';
  const extraTokens =
    typeof step.metrics?.extra?.reasoning_tokens === 'number'
      ? step.metrics.extra.reasoning_tokens
      : undefined;
  if (!content && extraTokens === undefined) return undefined;

  let level: TraceReasoningLevel | undefined;
  if (step.reasoning_effort === 'low' || step.reasoning_effort === 'medium' || step.reasoning_effort === 'high') {
    level = step.reasoning_effort;
  }
  return {
    content,
    level,
    tokens: extraTokens,
  };
}

function stepCategory(source: string): TraceSpanCategory {
  if (source === 'agent') return 'llm_call';
  if (source === 'system') return 'event';
  if (source === 'user') return 'event';
  return 'span';
}

function truncateTitle(text: string, max = 56): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return '';
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1)}…`;
}

function extractString(obj: Record<string, unknown> | undefined, keys: string[]): string {
  if (!obj) return '';
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function extractNumber(obj: Record<string, unknown> | undefined, keys: string[]): number | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

function extractBoolean(obj: Record<string, unknown> | undefined, keys: string[]): boolean | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'boolean') return v;
  }
  return undefined;
}

function buildTrajectorySpans(
  atif: AtifTrajectory,
  idPrefix: string,
  baseEpoch: number,
  isSubagent: boolean
): {
  rootSpan: TraceSpan<AtifSpanMetadata>;
  spanCount: number;
  totalPrompt: number;
  totalCompletion: number;
  totalCached: number;
  totalCost: number | undefined;
  apiKeyHash: string;
  clientIp: string;
  llmCallCount: number;
  subagentCount: number;
} {
  const steps = Array.isArray(atif.steps) ? atif.steps : [];
  const stepTimestamps: Date[] = [];

  for (let i = 0; i < steps.length; i++) {
    const prevMs = i > 0 ? stepTimestamps[i - 1].getTime() + 500 : baseEpoch;
    stepTimestamps.push(parseDate(steps[i].timestamp, prevMs));
  }

  let totalPrompt = atif.final_metrics?.total_prompt_tokens ?? 0;
  let totalCompletion = atif.final_metrics?.total_completion_tokens ?? 0;
  let totalCached = atif.final_metrics?.total_cached_tokens ?? 0;
  let totalCost = atif.final_metrics?.total_cost_usd;

  if (totalPrompt === 0 && totalCompletion === 0) {
    for (const s of steps) {
      totalPrompt += s.metrics?.prompt_tokens ?? 0;
      totalCompletion += s.metrics?.completion_tokens ?? 0;
      totalCached += s.metrics?.cached_tokens ?? 0;
      if (s.metrics?.cost_usd !== undefined) {
        totalCost = (totalCost ?? 0) + s.metrics.cost_usd;
      }
    }
  }

  const subTrajs = Array.isArray(atif.subagent_trajectories) ? atif.subagent_trajectories : [];
  const subBySessionId = new Map<string, { traj: AtifTrajectory; idx: number }>();
  for (let idx = 0; idx < subTrajs.length; idx++) {
    const sid = subTrajs[idx].session_id || subTrajs[idx].trajectory_id || `subagent-${idx + 1}`;
    subBySessionId.set(sid, { traj: subTrajs[idx], idx });
  }
  const usedSubIndices = new Set<number>();

  const childSpans: TraceSpan<AtifSpanMetadata>[] = [];
  let totalSpanCount = 1;
  let firstResponseModel = '';
  let firstApiKeyHash = '';
  let firstClientIp = '';

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const startTime = stepTimestamps[i];
    const nextTime = stepTimestamps[i + 1];
    const stepLatencyMs = extractNumber(step.extra, ['latency_ms']);
    const durationFallback =
      step.source === 'agent'
        ? stepLatencyMs !== undefined && stepLatencyMs > 0
          ? stepLatencyMs
          : 1200
        : 100;
    const endTime =
      nextTime && nextTime.getTime() > startTime.getTime()
        ? nextTime
        : new Date(startTime.getTime() + durationFallback);

    const msgText = renderAtifMessage(step.message);
    const toolCalls = step.tool_calls ?? [];
    const obsResults = step.observation?.results ?? [];
    const matchedObsIndices = new Set<number>();
    const toolSpans: TraceSpan<AtifSpanMetadata>[] = [];

    const stepDurationMs = Math.max(100, endTime.getTime() - startTime.getTime());
    const toolSliceMs = toolCalls.length > 0 ? Math.max(50, Math.floor(stepDurationMs / (toolCalls.length + 1))) : 0;

    for (let t = 0; t < toolCalls.length; t++) {
      const tc = toolCalls[t];
      let obsIdx = obsResults.findIndex((r, idx) => !matchedObsIndices.has(idx) && r.source_call_id && r.source_call_id === tc.tool_call_id);
      if (obsIdx < 0 && obsResults.length === toolCalls.length && !matchedObsIndices.has(t)) {
        obsIdx = t;
      }
      const obs = obsIdx >= 0 ? obsResults[obsIdx] : undefined;
      if (obsIdx >= 0) {
        matchedObsIndices.add(obsIdx);
      }

      const tcStart = new Date(startTime.getTime() + Math.min(stepDurationMs - 50, (t + 1) * toolSliceMs * 0.5));
      const tcEnd = new Date(Math.min(endTime.getTime(), tcStart.getTime() + toolSliceMs));
      const obsText = obs ? renderAtifMessage(obs.content) : undefined;
      const isError =
        obsText !== undefined &&
        (/^\s*(error|exception|failed):/i.test(obsText) ||
          (obs?.extra && Boolean(obs.extra.is_error)));

      const nestedSubSpans: TraceSpan<AtifSpanMetadata>[] = [];
      const subagentRefs: SubagentRefInfo[] = [];
      for (const ref of obs?.subagent_trajectory_ref ?? []) {
        subagentRefs.push({
          trajectory_id: ref.trajectory_id,
          trajectory_path: ref.trajectory_path,
          session_id: ref.session_id,
        });
        const refId = ref.session_id || ref.trajectory_id;
        if (!refId) continue;
        const found = subBySessionId.get(refId);
        if (found && !usedSubIndices.has(found.idx)) {
          usedSubIndices.add(found.idx);
          const adaptedSub = buildTrajectorySpans(
            found.traj,
            `${idPrefix}sub-${found.idx + 1}-`,
            tcStart.getTime(),
            true
          );
          nestedSubSpans.push(adaptedSub.rootSpan);
          totalSpanCount += adaptedSub.spanCount;
        }
      }

      const rawToolCallId = extractString(tc.extra, ['raw_tool_call_id']) || undefined;
      const toolExtraFields = mergeExtraObjects(tc.extra, obs?.extra);

      toolSpans.push({
        id: `${idPrefix}step-${step.step_id}-tool-${tc.tool_call_id || t}`,
        title: `tool: ${tc.function_name}`,
        type: 'tool_execution',
        status: isError ? 'error' : 'success',
        startTime: tcStart,
        endTime: tcEnd,
        input: JSON.stringify(tc.arguments ?? {}, null, 2),
        output: obsText,
        children: nestedSubSpans.length > 0 ? nestedSubSpans : undefined,
        attributes: buildAttributes([
          ['tool.call_id', tc.tool_call_id],
          ['tool.raw_call_id', rawToolCallId],
          ['tool.name', tc.function_name],
          ['atif.step_id', step.step_id],
          ...(subagentRefs.length > 0
            ? [['tool.subagent_refs', subagentRefs.map((r) => r.session_id || r.trajectory_id || r.trajectory_path || '').filter(Boolean).join(', ')] as [string, string]]
            : []),
          ...flattenExtraEntries('tool.extra', tc.extra),
          ...flattenExtraEntries('observation.extra', obs?.extra),
        ]),
        raw: [JSON.stringify({ tool_call: tc, observation: obs ?? null }, null, 2)],
        metadata: {
          stepId: step.step_id,
          source: step.source,
          toolCallId: tc.tool_call_id,
          rawToolCallId,
          functionName: tc.function_name,
          subagentRefs: subagentRefs.length > 0 ? subagentRefs : undefined,
          extraFields: toolExtraFields,
          kind: 'tool_call',
        },
      });
      totalSpanCount += 1;
    }

    for (let o = 0; o < obsResults.length; o++) {
      if (matchedObsIndices.has(o)) continue;
      const obs = obsResults[o];
      const obsText = renderAtifMessage(obs.content);
      toolSpans.push({
        id: `${idPrefix}step-${step.step_id}-obs-${obs.source_call_id || o}`,
        title: obs.source_call_id ? `observation (${obs.source_call_id})` : `observation #${o + 1}`,
        type: 'retrieval',
        status: 'success',
        startTime,
        endTime,
        output: obsText,
        attributes: buildAttributes([
          ['observation.source_call_id', obs.source_call_id],
          ['atif.step_id', step.step_id],
          ...flattenExtraEntries('observation.extra', obs.extra),
        ]),
        raw: [JSON.stringify(obs, null, 2)],
        metadata: {
          stepId: step.step_id,
          source: step.source,
          toolCallId: obs.source_call_id,
          extraFields: mergeExtraObjects(obs.extra),
          kind: 'observation',
        },
      });
      totalSpanCount += 1;
    }

    const requestedModel = extractString(step.extra, ['requested_model']) || step.model_name || undefined;
    const responseModel = extractString(step.extra, ['response_model']) || undefined;
    if (responseModel && !firstResponseModel) {
      firstResponseModel = responseModel;
    }
    const responseId = extractString(step.extra, ['response_id']) || undefined;
    const finishReason = extractString(step.extra, ['finish_reason', 'stop_reason']) || undefined;
    const statusCode = extractNumber(step.extra, ['status_code']);
    const isStream = extractBoolean(step.extra, ['is_stream']);
    const stepUpstream = extractString(step.extra, ['upstream']) || undefined;
    const httpMethod = extractString(step.extra, ['http_method']) || undefined;
    const httpPath = extractString(step.extra, ['http_path']) || undefined;
    const requestRecordId = extractNumber(step.extra, ['request_record_id']);
    const requestId = extractString(step.extra, ['request_id']) || undefined;
    const stepSourceMeta = extractString(step.extra, ['source']) || undefined;
    const stepApiKeyHash = extractString(step.extra, ['api_key_hash']) || undefined;
    if (stepApiKeyHash && !firstApiKeyHash) {
      firstApiKeyHash = stepApiKeyHash;
    }
    const stepClientIp = extractString(step.extra, ['client_ip']) || undefined;
    if (stepClientIp && !firstClientIp) {
      firstClientIp = stepClientIp;
    }
    const stepCachedTokens =
      step.source === 'agent' && step.metrics ? (step.metrics.cached_tokens ?? 0) : step.metrics?.cached_tokens;
    const cacheCreationTokens = extractNumber(step.metrics?.extra, ['cache_creation_input_tokens']);
    const reasoningTokens = extractNumber(step.metrics?.extra, ['reasoning_tokens']);
    const stepExtraFields = mergeExtraObjects(step.extra);

    const preview = truncateTitle(msgText, 48);
    let title = `#${step.step_id} ${step.source}`;
    if (step.source === 'agent') {
      const modelLabel = responseModel || step.model_name || atif.agent?.model_name || 'agent';
      title = toolCalls.length > 0
        ? `#${step.step_id} ${modelLabel} (${toolCalls.length} tool${toolCalls.length > 1 ? 's' : ''})`
        : `#${step.step_id} ${modelLabel}`;
    } else if (preview) {
      title = `#${step.step_id} ${step.source}: ${preview}`;
    }

    const span: TraceSpan<AtifSpanMetadata> = {
      id: `${idPrefix}step-${step.step_id}`,
      title,
      type: stepCategory(step.source),
      status: toolSpans.some((ts) => ts.status === 'error') ? 'warning' : 'success',
      startTime,
      endTime,
      input: step.source === 'agent' ? undefined : msgText,
      output: step.source === 'agent' ? msgText : undefined,
      reasoning: mapReasoning(step),
      tokenUsage: mapTokenUsage(step.metrics),
      children: toolSpans.length > 0 ? toolSpans : undefined,
      attributes: buildAttributes([
        ['atif.step_id', step.step_id],
        ['atif.source', step.source],
        ['gen_ai.request.model', requestedModel],
        ['gen_ai.response.model', responseModel],
        ['gen_ai.response.id', responseId],
        ['gen_ai.response.finish_reason', finishReason],
        ['http.method', httpMethod],
        ['http.path', httpPath],
        ['http.status_code', statusCode],
        ['llm.latency_ms', stepLatencyMs],
        ['llm.is_stream', isStream],
        ['tracer.upstream', stepUpstream],
        ['tracer.request_record_id', requestRecordId],
        ['tracer.request_id', requestId],
        ['tracer.source', stepSourceMeta],
        ['tracer.api_key_hash', stepApiKeyHash],
        ['tracer.client_ip', stepClientIp],
        ['atif.llm_call_count', step.llm_call_count],
        ['atif.is_copied_context', step.is_copied_context === true ? true : undefined],
        ['atif.reasoning_effort', step.reasoning_effort !== undefined ? String(step.reasoning_effort) : undefined],
        ['usage.prompt_tokens', step.metrics?.prompt_tokens],
        ['usage.cached_tokens', stepCachedTokens],
        ['usage.cache_creation_input_tokens', cacheCreationTokens],
        ['usage.completion_tokens', step.metrics?.completion_tokens],
        ['usage.reasoning_tokens', reasoningTokens],
        ['usage.cost_usd', step.metrics?.cost_usd],
        ...flattenExtraEntries('extra', step.extra),
        ...flattenExtraEntries('metrics.extra', step.metrics?.extra),
      ]),
      raw: [JSON.stringify(step, null, 2)],
      metadata: {
        stepId: step.step_id,
        source: step.source,
        modelName: step.model_name,
        requestedModel,
        responseModel,
        responseId,
        finishReason,
        statusCode,
        latencyMs: stepLatencyMs,
        isStream,
        upstream: stepUpstream,
        httpMethod,
        httpPath,
        requestRecordId,
        requestId,
        stepSourceMeta,
        apiKeyHash: stepApiKeyHash,
        clientIp: stepClientIp,
        promptTokens: step.metrics?.prompt_tokens,
        completionTokens: step.metrics?.completion_tokens,
        cachedTokens: stepCachedTokens,
        cacheCreationTokens,
        reasoningTokens,
        costUsd: step.metrics?.cost_usd,
        extraFields: stepExtraFields,
        ...(step.is_copied_context === true ? { isCopiedContext: true } : {}),
        kind: 'step',
      },
    };

    childSpans.push(span);
    totalSpanCount += 1;
  }

  for (let idx = 0; idx < subTrajs.length; idx++) {
    if (usedSubIndices.has(idx)) continue;
    const adaptedSub = buildTrajectorySpans(
      subTrajs[idx],
      `${idPrefix}sub-${idx + 1}-`,
      baseEpoch,
      true
    );
    childSpans.push(adaptedSub.rootSpan);
    totalSpanCount += adaptedSub.spanCount;
  }

  const timeBounds = extractTrajectoryTimeBounds(atif);
  const rootStart =
    timeBounds.startMs !== undefined
      ? new Date(timeBounds.startMs)
      : childSpans.length > 0
        ? childSpans[0].startTime
        : new Date(baseEpoch);
  const fallbackRootEnd =
    childSpans.length > 0
      ? childSpans[childSpans.length - 1].endTime
      : new Date(rootStart.getTime() + Math.max(100, timeBounds.durationMs));
  const rawRootEnd =
    timeBounds.endMs !== undefined ? new Date(timeBounds.endMs) : fallbackRootEnd;
  const rootEnd = rawRootEnd.getTime() >= rootStart.getTime() ? rawRootEnd : rootStart;
  const rootStartIso = timeBounds.startTime || rootStart.toISOString();
  const rootEndIso = timeBounds.endTime || rootEnd.toISOString();

  const workDir =
    extractString(atif.extra, ['work_dir', 'workdir', 'cwd']) ||
    extractString(atif.agent?.extra, ['work_dir', 'workdir', 'cwd']);
  const upstream = extractString(atif.extra, ['upstream']);
  const harness = extractString(atif.extra, ['harness']) || atif.agent?.name || 'unknown';
  const sessionId = atif.session_id || atif.trajectory_id || 'trajectory';
  const rootResponseModel =
    extractString(atif.extra, ['response_model']) ||
    extractString(atif.agent?.extra, ['response_model']) ||
    firstResponseModel ||
    undefined;
  const apiKeyHash =
    extractString(atif.extra, ['api_key_hash']) ||
    extractString(atif.agent?.extra, ['api_key_hash']) ||
    firstApiKeyHash;
  const clientIp =
    extractString(atif.extra, ['client_ip']) ||
    extractString(atif.agent?.extra, ['client_ip']) ||
    firstClientIp;
  const rootExtraFields = mergeExtraObjects(atif.extra, atif.agent?.extra);
  const llmCallCount = getTrajectoryLlmCallCount(atif);
  const subagentCount = countSubagentsRecursive(atif);

  const rootSpan: TraceSpan<AtifSpanMetadata> = {
    id: `${idPrefix}trace-${sessionId}`,
    title: isSubagent
      ? `subagent · ${sessionId}`
      : `${atif.agent?.name || 'agent'} · ${sessionId}`,
    type: 'agent_invocation',
    status: childSpans.some((s) => s.status === 'error') ? 'error' : 'success',
    startTime: rootStart,
    endTime: rootEnd,
    tokenUsage:
      totalPrompt > 0 || totalCompletion > 0
        ? {
            ...(totalPrompt - totalCached > 0 ? { input: { tokens: Math.max(0, totalPrompt - totalCached) } } : {}),
            ...(totalCached > 0 ? { cache_read: { tokens: totalCached } } : {}),
            ...(totalCompletion > 0
              ? { output: { tokens: totalCompletion, ...(totalCost !== undefined ? { cost: totalCost } : {}) } }
              : {}),
          }
        : undefined,
    children: childSpans,
    attributes: buildAttributes([
      ['atif.schema_version', atif.schema_version],
      ['atif.session_id', sessionId],
      ['atif.trajectory_id', atif.trajectory_id],
      ['atif.continued_trajectory_ref', atif.continued_trajectory_ref],
      ['agent.name', atif.agent?.name],
      ['agent.version', atif.agent?.version],
      ['gen_ai.request.model', atif.agent?.model_name],
      ['gen_ai.response.model', rootResponseModel],
      ['agent.tool_definitions_count', atif.agent?.tool_definitions?.length],
      ['tracer.harness', harness],
      ['tracer.upstream', upstream],
      ['tracer.work_dir', workDir],
      ['tracer.api_key_hash', apiKeyHash || undefined],
      ['tracer.client_ip', clientIp || undefined],
      ['atif.llm_call_count', llmCallCount],
      ['atif.subagent_count', subagentCount],
      ['usage.total_cached_tokens', totalCached],
      ['tracer.is_subagent', isSubagent ? true : undefined],
      ...flattenExtraEntries('extra', atif.extra),
      ...flattenExtraEntries('agent.extra', atif.agent?.extra),
    ]),
    raw: [JSON.stringify(atif, null, 2)],
    metadata: {
      kind: 'root',
      sessionId,
      trajectoryId: atif.trajectory_id,
      continuedTrajectoryRef: atif.continued_trajectory_ref,
      schemaVersion: atif.schema_version,
      harness,
      agentName: atif.agent?.name,
      agentVersion: atif.agent?.version,
      workDir: workDir || undefined,
      upstream: upstream || undefined,
      apiKeyHash: apiKeyHash || undefined,
      clientIp: clientIp || undefined,
      modelName: atif.agent?.model_name,
      responseModel: rootResponseModel,
      llmCallCount,
      subagentCount,
      startTime: rootStartIso,
      endTime: rootEndIso,
      promptTokens: totalPrompt,
      completionTokens: totalCompletion,
      cachedTokens: totalCached,
      costUsd: totalCost,
      extraFields: rootExtraFields,
      ...(Array.isArray(atif.agent?.tool_definitions) && atif.agent.tool_definitions.length > 0
        ? { toolDefinitions: atif.agent.tool_definitions }
        : {}),
    },
  };

  return {
    rootSpan,
    spanCount: totalSpanCount,
    totalPrompt,
    totalCompletion,
    totalCached,
    totalCost,
    apiKeyHash,
    clientIp,
    llmCallCount,
    subagentCount,
  };
}

export interface TrajectoryMetricsSummary {
  llmCallCount: number;
  treeLlmCallCount: number;
  stepCount: number;
  treeStepCount: number;
  toolDefsCount: number;
  subagentCount: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd?: number;
  durationMs: number;
  startMs?: number;
  endMs?: number;
  startTime?: string;
  endTime?: string;
  modelName: string;
  responseModel: string;
}

export interface SessionMetricsSummary {
  trajectoryCount: number;
  subagentCount: number;
  llmCallCount: number;
  totalSteps: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCachedTokens: number;
  totalCostUsd?: number;
  durationMs: number;
  startMs?: number;
  endMs?: number;
  harness: string;
  agentName: string;
  agentVersion: string;
  upstream: string;
  modelName: string;
  workDir: string;
  clientIp: string;
  apiKeyHash: string;
  schemaVersion: string;
}

function parseTimestampMs(ts: unknown): number | undefined {
  if (typeof ts !== 'string' || !ts.trim()) return undefined;
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function extractTrajectoryDirectTokens(atif: AtifTrajectory): {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd?: number;
} {
  let promptTokens = atif.final_metrics?.total_prompt_tokens ?? 0;
  let completionTokens = atif.final_metrics?.total_completion_tokens ?? 0;
  let cachedTokens = atif.final_metrics?.total_cached_tokens ?? 0;
  let costUsd = atif.final_metrics?.total_cost_usd;

  if (promptTokens === 0 && completionTokens === 0 && cachedTokens === 0) {
    const steps = Array.isArray(atif.steps) ? atif.steps : [];
    for (const s of steps) {
      promptTokens += s.metrics?.prompt_tokens ?? 0;
      completionTokens += s.metrics?.completion_tokens ?? 0;
      cachedTokens += s.metrics?.cached_tokens ?? 0;
      if (s.metrics?.cost_usd !== undefined) {
        costUsd = (costUsd ?? 0) + s.metrics.cost_usd;
      }
    }
  }
  return { promptTokens, completionTokens, cachedTokens, costUsd };
}

function extractTrajectoryTimeBounds(atif: AtifTrajectory): {
  startMs?: number;
  endMs?: number;
  startTime?: string;
  endTime?: string;
  durationMs: number;
} {
  const exactStartRaw = extractString(atif.extra, ['started_at']);
  const exactStartMs = parseTimestampMs(exactStartRaw);
  const exactEndRaw = extractString(atif.extra, ['ended_at', 'updated_at']);
  const exactEndMs = parseTimestampMs(exactEndRaw);
  const exactDurationMs = extractNumber(atif.extra, ['duration_ms']);

  if (exactStartMs !== undefined && exactEndMs !== undefined) {
    const endMs = exactEndMs >= exactStartMs ? exactEndMs : exactStartMs;
    const durationMs =
      endMs > exactStartMs
        ? endMs - exactStartMs
        : exactDurationMs !== undefined && exactDurationMs >= 0
          ? exactDurationMs
          : 0;
    return {
      startMs: exactStartMs,
      endMs,
      startTime: exactStartRaw || new Date(exactStartMs).toISOString(),
      endTime:
        exactEndMs >= exactStartMs
          ? exactEndRaw || new Date(endMs).toISOString()
          : new Date(endMs).toISOString(),
      durationMs,
    };
  }

  let minStart: number | undefined = exactStartMs;
  let maxEnd: number | undefined = exactEndMs;
  let sumLatencyMs = 0;

  const pushStart = (ms: number | undefined) => {
    if (ms === undefined) return;
    if (minStart === undefined || ms < minStart) minStart = ms;
  };
  const pushEnd = (ms: number | undefined) => {
    if (ms === undefined) return;
    if (maxEnd === undefined || ms > maxEnd) maxEnd = ms;
  };

  const requests = Array.isArray(atif.extra?.requests)
    ? (atif.extra.requests as Array<Record<string, unknown>>)
    : [];
  let reqDurationSum = 0;
  for (const r of requests) {
    pushStart(parseTimestampMs(r.started_at));
    pushEnd(parseTimestampMs(r.completed_at ?? r.started_at));
    const d = extractNumber(r, ['duration_ms', 'latency_ms']);
    if (d !== undefined && d > 0) reqDurationSum += d;
  }

  const steps = Array.isArray(atif.steps) ? atif.steps : [];
  for (const s of steps) {
    const ts = parseTimestampMs(s.timestamp);
    pushStart(ts);
    pushEnd(ts);
    const lat = extractNumber(s.extra, ['duration_ms', 'latency_ms']);
    if (lat !== undefined && lat > 0) sumLatencyMs += lat;
  }

  let durationMs = 0;
  if (minStart !== undefined && maxEnd !== undefined && maxEnd > minStart) {
    durationMs = maxEnd - minStart;
  } else if (exactDurationMs !== undefined && exactDurationMs > 0) {
    durationMs = exactDurationMs;
  } else if (reqDurationSum > 0) {
    durationMs = reqDurationSum;
  } else if (sumLatencyMs > 0) {
    durationMs = sumLatencyMs;
  }

  if (minStart !== undefined && (maxEnd === undefined || maxEnd === minStart) && durationMs > 0) {
    maxEnd = minStart + durationMs;
  }

  const startTime =
    minStart !== undefined
      ? exactStartMs === minStart && exactStartRaw
        ? exactStartRaw
        : new Date(minStart).toISOString()
      : undefined;
  const endTime =
    maxEnd !== undefined
      ? exactEndMs === maxEnd && exactEndRaw
        ? exactEndRaw
        : new Date(maxEnd).toISOString()
      : undefined;

  return { startMs: minStart, endMs: maxEnd, startTime, endTime, durationMs };
}

function countSubagentsRecursive(atif: AtifTrajectory): number {
  const subs = Array.isArray(atif.subagent_trajectories) ? atif.subagent_trajectories : [];
  let count = subs.length;
  for (const sub of subs) {
    count += countSubagentsRecursive(sub);
  }
  return count;
}

function countStepsRecursive(atif: AtifTrajectory): number {
  let total = Array.isArray(atif.steps) ? atif.steps.length : 0;
  const subs = Array.isArray(atif.subagent_trajectories) ? atif.subagent_trajectories : [];
  for (const sub of subs) {
    total += countStepsRecursive(sub);
  }
  return total;
}

export function summarizeTrajectory(atif: AtifTrajectory): TrajectoryMetricsSummary {
  const tokens = extractTrajectoryDirectTokens(atif);
  const bounds = extractTrajectoryTimeBounds(atif);
  const steps = Array.isArray(atif.steps) ? atif.steps : [];
  const toolDefsCount = Array.isArray(atif.agent?.tool_definitions)
    ? atif.agent.tool_definitions.length
    : 0;
  const responseModel =
    extractString(atif.extra, ['response_model']) ||
    extractString(atif.agent?.extra, ['response_model']) ||
    steps.map((s) => extractString(s.extra, ['response_model'])).find(Boolean) ||
    '';

  return {
    llmCallCount: getTrajectoryLlmCallCount(atif),
    treeLlmCallCount: getTrajectoryTreeLlmCallCount(atif),
    stepCount: steps.length,
    treeStepCount: countStepsRecursive(atif),
    toolDefsCount,
    subagentCount: countSubagentsRecursive(atif),
    promptTokens: tokens.promptTokens,
    completionTokens: tokens.completionTokens,
    cachedTokens: tokens.cachedTokens,
    costUsd: tokens.costUsd,
    durationMs: bounds.durationMs,
    startMs: bounds.startMs,
    endMs: bounds.endMs,
    startTime: bounds.startTime,
    endTime: bounds.endTime,
    modelName: atif.agent?.model_name || '',
    responseModel,
  };
}

export function summarizeSession(
  trajectories: AtifTrajectory[],
  sessionLlmCallCount?: number
): SessionMetricsSummary {
  let subagentCount = 0;
  let treeLlmCalls = 0;
  let totalSteps = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCachedTokens = 0;
  let totalCostUsd: number | undefined;
  let minStart: number | undefined;
  let maxEnd: number | undefined;
  let fallbackDurationSum = 0;

  let harness = '';
  let agentName = '';
  let agentVersion = '';
  let upstream = '';
  let modelName = '';
  let workDir = '';
  let clientIp = '';
  let apiKeyHash = '';
  let schemaVersion = '';

  const walk = (traj: AtifTrajectory, isRootSegment: boolean) => {
    const tokens = extractTrajectoryDirectTokens(traj);
    const bounds = extractTrajectoryTimeBounds(traj);
    totalPromptTokens += tokens.promptTokens;
    totalCompletionTokens += tokens.completionTokens;
    totalCachedTokens += tokens.cachedTokens;
    if (tokens.costUsd !== undefined) {
      totalCostUsd = (totalCostUsd ?? 0) + tokens.costUsd;
    }
    totalSteps += Array.isArray(traj.steps) ? traj.steps.length : 0;
    treeLlmCalls += getTrajectoryLlmCallCount(traj);

    if (bounds.startMs !== undefined && (minStart === undefined || bounds.startMs < minStart)) {
      minStart = bounds.startMs;
    }
    if (bounds.endMs !== undefined && (maxEnd === undefined || bounds.endMs > maxEnd)) {
      maxEnd = bounds.endMs;
    }
    if (isRootSegment) {
      fallbackDurationSum += bounds.durationMs;
    }

    if (!harness) harness = extractString(traj.extra, ['harness']) || traj.agent?.name || '';
    if (!agentName) agentName = traj.agent?.name || '';
    if (!agentVersion) agentVersion = traj.agent?.version || '';
    if (!upstream) upstream = extractString(traj.extra, ['upstream']);
    if (!modelName) {
      modelName =
        extractString(traj.extra, ['response_model']) ||
        extractString(traj.agent?.extra, ['response_model']) ||
        traj.agent?.model_name ||
        '';
    }
    if (!workDir) {
      workDir =
        extractString(traj.extra, ['work_dir', 'workdir', 'cwd']) ||
        extractString(traj.agent?.extra, ['work_dir', 'workdir', 'cwd']);
    }
    if (!clientIp) {
      clientIp =
        extractString(traj.extra, ['client_ip']) ||
        extractString(traj.agent?.extra, ['client_ip']) ||
        (Array.isArray(traj.steps)
          ? traj.steps.map((s) => extractString(s.extra, ['client_ip'])).find(Boolean) || ''
          : '');
    }
    if (!apiKeyHash) {
      apiKeyHash =
        extractString(traj.extra, ['api_key_hash']) ||
        extractString(traj.agent?.extra, ['api_key_hash']) ||
        (Array.isArray(traj.steps)
          ? traj.steps.map((s) => extractString(s.extra, ['api_key_hash'])).find(Boolean) || ''
          : '');
    }
    if (!schemaVersion && traj.schema_version) {
      schemaVersion = traj.schema_version;
    }

    const subs = Array.isArray(traj.subagent_trajectories) ? traj.subagent_trajectories : [];
    subagentCount += subs.length;
    for (const sub of subs) {
      walk(sub, false);
    }
  };

  for (const traj of trajectories) {
    walk(traj, true);
  }

  const durationMs =
    minStart !== undefined && maxEnd !== undefined && maxEnd > minStart
      ? maxEnd - minStart
      : fallbackDurationSum;

  const llmCallCount =
    typeof sessionLlmCallCount === 'number' && Number.isFinite(sessionLlmCallCount)
      ? sessionLlmCallCount
      : treeLlmCalls;

  return {
    trajectoryCount: trajectories.length,
    subagentCount,
    llmCallCount,
    totalSteps,
    totalPromptTokens,
    totalCompletionTokens,
    totalCachedTokens,
    totalCostUsd,
    durationMs,
    startMs: minStart,
    endMs: maxEnd,
    harness: harness || 'unknown',
    agentName: agentName || harness || 'unknown',
    agentVersion,
    upstream,
    modelName,
    workDir,
    clientIp,
    apiKeyHash,
    schemaVersion: schemaVersion || 'ATIF',
  };
}

export function adaptAtifToAgentPrism(atif: AtifTrajectory): AdaptedAtifTrace {
  const baseEpoch = Date.now();
  const built = buildTrajectorySpans(atif, '', baseEpoch, false);
  const durationMs = Math.max(0, built.rootSpan.endTime.getTime() - built.rootSpan.startTime.getTime());

  const workDir =
    extractString(atif.extra, ['work_dir', 'workdir', 'cwd']) ||
    extractString(atif.agent?.extra, ['work_dir', 'workdir', 'cwd']);
  const upstream = extractString(atif.extra, ['upstream']);
  const harness = extractString(atif.extra, ['harness']) || atif.agent?.name || 'unknown';
  const sessionId = atif.session_id || atif.trajectory_id || 'trajectory';

  const record: TraceRecord = {
    id: sessionId,
    name: `${atif.agent?.name || 'agent'} (${atif.agent?.model_name || 'unknown'})`,
    agentDescription: workDir || `${atif.agent?.name || 'agent'} v${atif.agent?.version || '0'}`,
    durationMs,
    spansCount: built.spanCount,
    startTime: built.rootSpan.startTime.getTime(),
    totalTokens: built.totalPrompt + built.totalCompletion,
    totalCost: built.totalCost,
  };

  return {
    record,
    spans: [built.rootSpan],
    workDir,
    upstream,
    harness,
    apiKeyHash: built.apiKeyHash,
    clientIp: built.clientIp,
    llmCallCount: built.llmCallCount,
    subagentCount: built.subagentCount,
    totalPromptTokens: built.totalPrompt,
    totalCompletionTokens: built.totalCompletion,
    totalCachedTokens: built.totalCached,
    totalCostUsd: built.totalCost,
  };
}
