export interface AuthStatus {
  auth_required: boolean;
  authenticated: boolean;
  is_localhost: boolean;
  insecure_no_auth_warning: boolean;
}

export interface TraceSummary {
  session_id: string;
  harness: string;
  work_dir: string;
  upstream: string;
  model: string;
  step_count: number;
  request_count: number;
  llm_call_count?: number;
  trajectory_count?: number;
  started_at: string;
  updated_at: string;
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_cached_tokens: number;
  api_key_hash?: string;
  client_ip?: string;
}

export interface TraceListResponse {
  traces: TraceSummary[];
  total: number;
}

export interface TraceListParams {
  q?: string;
  harness?: string;
  upstream?: string;
  limit?: number;
  offset?: number;
}

export interface AtifTextPart {
  type: 'text';
  text: string;
}

export interface AtifImagePart {
  type: 'image';
  source: {
    media_type: string;
    path: string;
  };
}

export interface AtifAudioPart {
  type: 'audio';
  source: {
    media_type: string;
    path: string;
    duration_sec?: number;
  };
}

export type AtifContentPart = AtifTextPart | AtifImagePart | AtifAudioPart | Record<string, unknown>;

export interface AtifAgent {
  name: string;
  version: string;
  model_name?: string;
  tool_definitions?: Array<Record<string, unknown>>;
  extra?: Record<string, unknown>;
}

export interface AtifToolCall {
  tool_call_id: string;
  function_name: string;
  arguments: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface AtifObservationResult {
  source_call_id?: string;
  content?: string | AtifContentPart[];
  subagent_trajectory_ref?: Array<{
    trajectory_id?: string;
    trajectory_path?: string;
    session_id?: string;
    extra?: Record<string, unknown>;
  }>;
  extra?: Record<string, unknown>;
}

export interface AtifObservation {
  results: AtifObservationResult[];
}

export interface AtifMetrics {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  cost_usd?: number;
  prompt_token_ids?: number[];
  completion_token_ids?: number[];
  logprobs?: number[];
  extra?: Record<string, unknown>;
}

export interface AtifStep {
  step_id: number;
  timestamp?: string;
  source: 'system' | 'user' | 'agent' | string;
  message: string | AtifContentPart[];
  model_name?: string;
  reasoning_effort?: string | number;
  reasoning_content?: string;
  tool_calls?: AtifToolCall[];
  observation?: AtifObservation;
  metrics?: AtifMetrics;
  llm_call_count?: number;
  is_copied_context?: boolean;
  extra?: Record<string, unknown>;
}

export interface AtifFinalMetrics {
  total_prompt_tokens?: number;
  total_completion_tokens?: number;
  total_cached_tokens?: number;
  total_cost_usd?: number;
  total_steps?: number;
  extra?: Record<string, unknown>;
}

export interface AtifTrajectory {
  schema_version: string;
  session_id?: string;
  trajectory_id?: string;
  agent: AtifAgent;
  steps: AtifStep[];
  notes?: string;
  final_metrics?: AtifFinalMetrics;
  continued_trajectory_ref?: string;
  subagent_trajectories?: AtifTrajectory[];
  extra?: Record<string, unknown>;
}

export interface TraceTrajectoriesResponse {
  session_id: string;
  llm_call_count?: number;
  trajectories: AtifTrajectory[];
}

export interface RawSseEvent {
  index: number;
  event: string;
  data: string;
}

export interface RawRequestDetail {
  id: number;
  session_id: string;
  upstream: string;
  method: string;
  path: string;
  query: string;
  status_code: number;
  latency_ms: number;
  started_at: string;
  ended_at: string;
  request_headers: Record<string, string[]>;
  request_body: string;
  response_headers: Record<string, string[]>;
  response_body: string;
  is_sse: boolean;
  sse_events?: RawSseEvent[];
  merged_response?: unknown;
  response_model?: string;
  response_id?: string;
  finish_reason?: string;
  api_key_hash?: string;
  client_ip?: string;
}
