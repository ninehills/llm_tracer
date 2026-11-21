package atif

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"llm_tracer/internal/harness"
	"llm_tracer/internal/proxy"
	"llm_tracer/internal/storage"
)

const SchemaVersion = "ATIF-v1.8"

var reTaskID = regexp.MustCompile(`(?m)^task_id:\s*(\S+)`)

type Trajectory struct {
	SchemaVersion          string         `json:"schema_version"`
	TrajectoryID           string         `json:"trajectory_id,omitempty"`
	SessionID              string         `json:"session_id,omitempty"`
	ContinuedTrajectoryRef string         `json:"continued_trajectory_ref,omitempty"`
	Agent                  Agent          `json:"agent"`
	Steps                  []Step         `json:"steps"`
	Notes                  string         `json:"notes,omitempty"`
	FinalMetrics           *FinalMetrics  `json:"final_metrics,omitempty"`
	SubagentTrajectories   []*Trajectory  `json:"subagent_trajectories,omitempty"`
	Extra                  map[string]any `json:"extra,omitempty"`
}

type Agent struct {
	Name            string           `json:"name"`
	Version         string           `json:"version"`
	ModelName       string           `json:"model_name,omitempty"`
	ToolDefinitions []map[string]any `json:"tool_definitions,omitempty"`
	Extra           map[string]any   `json:"extra,omitempty"`
}

type Step struct {
	StepID           int            `json:"step_id"`
	Timestamp        string         `json:"timestamp,omitempty"`
	Source           string         `json:"source"`
	Message          string         `json:"message"`
	ModelName        string         `json:"model_name,omitempty"`
	ReasoningContent string         `json:"reasoning_content,omitempty"`
	ToolCalls        []ToolCall     `json:"tool_calls,omitempty"`
	Observation      *Observation   `json:"observation,omitempty"`
	Metrics          *Metrics       `json:"metrics,omitempty"`
	IsCopiedContext  bool           `json:"is_copied_context,omitempty"`
	LLMCallCount     int            `json:"llm_call_count,omitempty"`
	Extra            map[string]any `json:"extra,omitempty"`
}

type ToolCall struct {
	ToolCallID   string         `json:"tool_call_id"`
	FunctionName string         `json:"function_name"`
	Arguments    map[string]any `json:"arguments"`
	Extra        map[string]any `json:"extra,omitempty"`
}

type Observation struct {
	Results []ObservationResult `json:"results"`
}

type SubagentTrajectoryRef struct {
	SessionID      string         `json:"session_id,omitempty"`
	TrajectoryID   string         `json:"trajectory_id,omitempty"`
	TrajectoryPath string         `json:"trajectory_path,omitempty"`
	Extra          map[string]any `json:"extra,omitempty"`
}

type ObservationResult struct {
	SourceCallID          string                  `json:"source_call_id,omitempty"`
	Content               string                  `json:"content,omitempty"`
	SubagentTrajectoryRef []SubagentTrajectoryRef `json:"subagent_trajectory_ref,omitempty"`
	Extra                 map[string]any          `json:"extra,omitempty"`
}

type Metrics struct {
	PromptTokens     int            `json:"prompt_tokens,omitempty"`
	CompletionTokens int            `json:"completion_tokens,omitempty"`
	CachedTokens     int            `json:"cached_tokens,omitempty"`
	Extra            map[string]any `json:"extra,omitempty"`
}

type FinalMetrics struct {
	TotalPromptTokens     int            `json:"total_prompt_tokens"`
	TotalCompletionTokens int            `json:"total_completion_tokens"`
	TotalCachedTokens     int            `json:"total_cached_tokens,omitempty"`
	TotalSteps            int            `json:"total_steps"`
	Extra                 map[string]any `json:"extra,omitempty"`
}

type parsedRecord struct {
	rec    storage.RequestRecord
	parsed proxy.ParsedExchange
	meta   map[string]any
}

func BuildTrajectory(sess *storage.SessionSummary, reqs []storage.RequestRecord) *Trajectory {
	trajs := BuildTrajectories(sess, reqs)
	return trajs[0]
}

func BuildTrajectories(sess *storage.SessionSummary, reqs []storage.RequestRecord) []*Trajectory {
	ordered := make([]storage.RequestRecord, len(reqs))
	copy(ordered, reqs)
	sort.SliceStable(ordered, func(i, j int) bool {
		if ordered[i].StartedAt != ordered[j].StartedAt {
			return ordered[i].StartedAt < ordered[j].StartedAt
		}
		return ordered[i].ID < ordered[j].ID
	})

	sessionMeta := make(map[string]any)
	workDir := sess.WorkDir

	mainRecs := make([]parsedRecord, 0, len(ordered))
	subGroups := make([][]parsedRecord, 0)
	subGroupByID := make(map[string]int)
	var currentSub []parsedRecord
	var prevSubRec *parsedRecord
	sawMainSinceSub := false

	for _, rec := range ordered {
		var parsed proxy.ParsedExchange
		if rec.ParsedJSON != "" {
			_ = json.Unmarshal([]byte(rec.ParsedJSON), &parsed)
		}
		reqHeaders := parseHeadersJSON(rec.RequestHeaders)
		respHeaders := parseHeadersJSON(rec.ResponseHeaders)
		if len(parsed.ToolDefinitions) == 0 && len(rec.RequestBody) > 0 {
			if tools := proxy.ExtractToolsFromRequest(reqHeaders, rec.RequestBody); len(tools) > 0 {
				parsed.ToolDefinitions = tools
			}
		}
		if parsed.RequestedModel == "" && len(rec.RequestBody) > 0 {
			parsed.RequestedModel = proxy.ExtractRequestModel(reqHeaders, rec.RequestBody)
		}
		if (parsed.ResponseModel == "" || parsed.ResponseID == "" || parsed.FinishReason == "" || !parsed.IsStream) && len(rec.ResponseBody) > 0 {
			rm := proxy.ExtractResponseMetadata(respHeaders, rec.ResponseBody)
			if parsed.ResponseModel == "" && rm.ResponseModel != "" {
				parsed.ResponseModel = rm.ResponseModel
			}
			if parsed.ResponseID == "" && rm.ResponseID != "" {
				parsed.ResponseID = rm.ResponseID
			}
			if parsed.FinishReason == "" && rm.FinishReason != "" {
				parsed.FinishReason = rm.FinishReason
			}
			if rm.IsStream {
				parsed.IsStream = true
			}
		}
		if workDir == "" {
			workDir = extractWorkDirFromParsed(&parsed)
		}

		isStream := rec.IsStream || parsed.IsStream
		entry := map[string]any{
			"request_record_id": rec.ID,
			"seq":               rec.Seq,
			"upstream":          rec.Upstream,
			"method":            rec.Method,
			"path":              rec.Path,
			"query":             rec.Query,
			"protocol":          rec.Protocol,
			"model":             firstNonEmpty(parsed.ResponseModel, parsed.Model, rec.Model),
			"is_stream":         isStream,
			"status_code":       rec.StatusCode,
			"started_at":        rec.StartedAt,
			"completed_at":      rec.CompletedAt,
			"duration_ms":       rec.DurationMs,
			"latency_ms":        rec.DurationMs,
			"prompt_tokens":     rec.PromptTokens,
			"completion_tokens": rec.CompletionTokens,
			"cached_tokens":     rec.CachedTokens,
		}
		if parsed.RequestedModel != "" {
			entry["requested_model"] = parsed.RequestedModel
		}
		if parsed.ResponseModel != "" {
			entry["response_model"] = parsed.ResponseModel
		}
		if parsed.ResponseID != "" {
			entry["response_id"] = parsed.ResponseID
		}
		if parsed.FinishReason != "" {
			entry["finish_reason"] = parsed.FinishReason
		}
		if v := firstNonEmpty(rec.ClientIP, parsed.ClientIP); v != "" {
			entry["client_ip"] = v
		}
		if v := firstNonEmpty(rec.APIKeyHash, parsed.APIKeyHash); v != "" {
			entry["api_key_hash"] = v
		}
		for k, v := range parsed.Metadata {
			entry[k] = v
		}
		mergeSessionMetadata(sessionMeta, parsed.Metadata)

		pr := parsedRecord{rec: rec, parsed: parsed, meta: entry}
		if isSubagentMetadata(parsed.Metadata) {
			if subKey, _ := parsed.Metadata["subagent_id"].(string); strings.TrimSpace(subKey) != "" {
				subKey = strings.TrimSpace(subKey)
				if idx, ok := subGroupByID[subKey]; ok {
					subGroups[idx] = append(subGroups[idx], pr)
				} else {
					subGroupByID[subKey] = len(subGroups)
					subGroups = append(subGroups, []parsedRecord{pr})
				}
			} else {
				if len(currentSub) > 0 && (sawMainSinceSub || (prevSubRec != nil && shouldStartNewSegment(*prevSubRec, pr))) {
					subGroups = append(subGroups, currentSub)
					currentSub = nil
					prevSubRec = nil
				}
				currentSub = append(currentSub, pr)
				last := pr
				prevSubRec = &last
				sawMainSinceSub = false
			}
		} else {
			mainRecs = append(mainRecs, pr)
			if len(currentSub) > 0 {
				sawMainSinceSub = true
			}
		}
	}
	if len(currentSub) > 0 {
		subGroups = append(subGroups, currentSub)
	}

	version := sess.HarnessVersion
	if version == "" {
		version = "unknown"
	}

	allSubagent := len(mainRecs) == 0 && len(subGroups) > 0
	if allSubagent {
		flat := make([]parsedRecord, 0, len(ordered))
		for _, g := range subGroups {
			flat = append(flat, g...)
		}
		mainRecs = flat
		subGroups = nil
	}

	mainSegments := splitIntoSegments(mainRecs)
	if len(mainSegments) == 0 {
		mainSegments = [][]parsedRecord{{}}
	}

	var prevSegMsgs []proxy.ParsedMessage
	priorToolCalls := make(map[string]string)

	trajectories := make([]*Trajectory, 0, len(mainSegments))
	totalSegs := len(mainSegments)

	for segIdx, segRecs := range mainSegments {
		isCont := segIdx > 0
		steps := buildSteps(segRecs, isCont, prevSegMsgs, priorToolCalls)

		prevSegMsgs = collectSegmentMessages(segRecs)
		for _, pr := range segRecs {
			for _, tc := range pr.parsed.ToolCalls {
				if tc.ID != "" {
					priorToolCalls[toolCallSignature(tc.Name, tc.Arguments)] = tc.ID
				}
			}
		}

		trajID := sess.SessionID
		fileRef := "trajectory.json"
		if segIdx > 0 {
			trajID = fmt.Sprintf("%s.cont-%d", sess.SessionID, segIdx)
			fileRef = fmt.Sprintf("trajectory.cont-%d.json", segIdx)
		}
		continuedRef := ""
		if segIdx < totalSegs-1 {
			continuedRef = fmt.Sprintf("trajectory.cont-%d.json", segIdx+1)
		}

		segReqMeta := make([]map[string]any, 0, len(segRecs))
		segMeta := make(map[string]any)
		segModel := sess.Model
		segResponseModel := ""
		segClientIP := sess.ClientIP
		segAPIKeyHash := sess.APIKeyHash
		segStarted, segEnded, segDurationMs := computeRecordTimeBounds(segRecs, sess.StartedAt, sess.UpdatedAt)
		for _, pr := range segRecs {
			segReqMeta = append(segReqMeta, pr.meta)
			mergeSessionMetadata(segMeta, pr.parsed.Metadata)
			if v := firstNonEmpty(pr.rec.ClientIP, pr.parsed.ClientIP); v != "" {
				segClientIP = v
			}
			if v := firstNonEmpty(pr.rec.APIKeyHash, pr.parsed.APIKeyHash); v != "" {
				segAPIKeyHash = v
			}
			if pr.parsed.ResponseModel != "" {
				segResponseModel = pr.parsed.ResponseModel
			}
			if pr.parsed.Model != "" {
				segModel = pr.parsed.Model
			} else if pr.rec.Model != "" {
				segModel = pr.rec.Model
			}
		}
		if len(segMeta) == 0 {
			for k, v := range sessionMeta {
				segMeta[k] = v
			}
		}
		if segResponseModel != "" {
			if _, exists := segMeta["response_model"]; !exists {
				segMeta["response_model"] = segResponseModel
			}
		}
		if segClientIP != "" {
			segMeta["client_ip"] = segClientIP
		}
		if segAPIKeyHash != "" {
			segMeta["api_key_hash"] = segAPIKeyHash
		}

		extra := map[string]any{
			"upstream":        sess.Upstream,
			"request_count":   len(segRecs),
			"llm_call_count":  len(segRecs),
			"started_at":      segStarted,
			"ended_at":        segEnded,
			"updated_at":      segEnded,
			"duration_ms":     segDurationMs,
			"requests":        segReqMeta,
			"segment_index":   segIdx,
			"segment_count":   totalSegs,
			"trajectory_file": fileRef,
		}
		if workDir != "" {
			extra["work_dir"] = workDir
		}
		for k, v := range segMeta {
			if _, exists := extra[k]; !exists {
				extra[k] = v
			}
		}
		if allSubagent {
			extra["is_subagent"] = true
			if _, ok := extra["source"]; !ok {
				extra["source"] = "subAgent"
			}
		}

		agent := Agent{
			Name:            sess.Harness,
			Version:         version,
			ModelName:       segModel,
			ToolDefinitions: latestToolDefinitions(segRecs),
		}
		if len(segMeta) > 0 {
			agent.Extra = segMeta
		}

		stepPrompt, stepCompletion, stepCached := sumStepMetrics(steps)
		fm := &FinalMetrics{
			TotalPromptTokens:     stepPrompt,
			TotalCompletionTokens: stepCompletion,
			TotalCachedTokens:     stepCached,
			TotalSteps:            len(steps),
			Extra: map[string]any{
				"llm_call_count": len(segRecs),
			},
		}

		trajectories = append(trajectories, &Trajectory{
			SchemaVersion:          SchemaVersion,
			TrajectoryID:           trajID,
			SessionID:              sess.SessionID,
			ContinuedTrajectoryRef: continuedRef,
			Agent:                  agent,
			Steps:                  steps,
			FinalMetrics:           fm,
			Extra:                  extra,
		})
	}

	if len(subGroups) > 0 {
		subagentTrajs := make([]*Trajectory, 0, len(subGroups))
		for idx, group := range subGroups {
			subSteps := buildSteps(group, false, nil, nil)
			sp, sc, scache := sumStepMetrics(subSteps)
			subModel := sess.Model
			subClientIP := sess.ClientIP
			subAPIKeyHash := sess.APIKeyHash
			subStarted, subEnded, subDurationMs := computeRecordTimeBounds(group, sess.StartedAt, sess.UpdatedAt)
			subExtra := map[string]any{
				"parent_session_id": sess.SessionID,
				"source":            "subAgent",
				"is_subagent":       true,
				"request_count":     len(group),
				"llm_call_count":    len(group),
				"started_at":        subStarted,
				"ended_at":          subEnded,
				"duration_ms":       subDurationMs,
			}
			subID := fmt.Sprintf("%s#subagent-%d", sess.SessionID, idx+1)
			for _, pr := range group {
				if v := firstNonEmpty(pr.rec.ClientIP, pr.parsed.ClientIP); v != "" {
					subClientIP = v
				}
				if v := firstNonEmpty(pr.rec.APIKeyHash, pr.parsed.APIKeyHash); v != "" {
					subAPIKeyHash = v
				}
				if pr.parsed.ResponseModel != "" {
					subExtra["response_model"] = pr.parsed.ResponseModel
				}
				if pr.parsed.Model != "" {
					subModel = pr.parsed.Model
				} else if pr.rec.Model != "" {
					subModel = pr.rec.Model
				}
				if pr.parsed.Metadata != nil {
					if sid, _ := pr.parsed.Metadata["subagent_id"].(string); strings.TrimSpace(sid) != "" {
						subID = strings.TrimSpace(sid)
						subExtra["subagent_id"] = subID
					}
					if kind, _ := pr.parsed.Metadata["subagent_kind"].(string); strings.TrimSpace(kind) != "" {
						subExtra["subagent_kind"] = strings.TrimSpace(kind)
					}
					if name, _ := pr.parsed.Metadata["agent_name"].(string); strings.TrimSpace(name) != "" {
						subExtra["agent_name"] = strings.TrimSpace(name)
					}
				}
				mergeSessionMetadata(subExtra, pr.parsed.Metadata)
			}
			subAgentExtra := map[string]any{}
			if subClientIP != "" {
				subExtra["client_ip"] = subClientIP
				subAgentExtra["client_ip"] = subClientIP
			}
			if subAPIKeyHash != "" {
				subExtra["api_key_hash"] = subAPIKeyHash
				subAgentExtra["api_key_hash"] = subAPIKeyHash
			}
			subAgent := Agent{
				Name:            sess.Harness,
				Version:         version,
				ModelName:       subModel,
				ToolDefinitions: latestToolDefinitions(group),
			}
			if len(subAgentExtra) > 0 {
				subAgent.Extra = subAgentExtra
			}
			subagentTrajs = append(subagentTrajs, &Trajectory{
				SchemaVersion: SchemaVersion,
				TrajectoryID:  subID,
				SessionID:     subID,
				Agent:         subAgent,
				Steps:         subSteps,
				FinalMetrics: &FinalMetrics{
					TotalPromptTokens:     sp,
					TotalCompletionTokens: sc,
					TotalCachedTokens:     scache,
					TotalSteps:            len(subSteps),
					Extra: map[string]any{
						"llm_call_count": len(group),
					},
				},
				Extra: subExtra,
			})
		}
		attachSubagentsToSegments(trajectories, subagentTrajs)
	}

	return trajectories
}

func splitIntoSegments(recs []parsedRecord) [][]parsedRecord {
	if len(recs) == 0 {
		return nil
	}
	segments := make([][]parsedRecord, 0, 1)
	current := make([]parsedRecord, 0, len(recs))
	var prev *parsedRecord
	for _, pr := range recs {
		if prev != nil && shouldStartNewSegment(*prev, pr) {
			segments = append(segments, current)
			current = make([]parsedRecord, 0)
		}
		current = append(current, pr)
		last := pr
		prev = &last
	}
	if len(current) > 0 {
		segments = append(segments, current)
	}
	return segments
}

func shouldStartNewSegment(prev, curr parsedRecord) bool {
	if !toolDefinitionsEqual(prev.parsed.ToolDefinitions, curr.parsed.ToolDefinitions) {
		return true
	}
	if isChainedByPreviousResponseID(prev, curr) {
		prevSys := leadingSystemContent(prev.parsed.RequestMessages)
		currSys := leadingSystemContent(curr.parsed.RequestMessages)
		if prevSys != "" && currSys != "" && prevSys != currSys {
			return true
		}
		return false
	}
	prevMsgs := prev.parsed.RequestMessages
	currMsgs := curr.parsed.RequestMessages
	if len(prevMsgs) == 0 {
		return false
	}
	prefix := commonPrefixLen(prevMsgs, currMsgs)
	if prefix < len(prevMsgs) {
		return true
	}
	prevProducedAgent := prev.rec.Protocol != "" && prev.rec.Protocol != "unknown"
	if prevProducedAgent {
		if len(currMsgs) <= len(prevMsgs) {
			return true
		}
		if currMsgs[len(prevMsgs)].Role != "assistant" {
			return true
		}
	}
	return false
}

func isChainedByPreviousResponseID(prev, curr parsedRecord) bool {
	if prev.parsed.ResponseID == "" || curr.parsed.Metadata == nil {
		return false
	}
	prevRespID, _ := curr.parsed.Metadata["previous_response_id"].(string)
	return prevRespID != "" && prevRespID == prev.parsed.ResponseID
}

func leadingSystemContent(msgs []proxy.ParsedMessage) string {
	if len(msgs) > 0 && msgs[0].Role == "system" {
		return msgs[0].Content
	}
	return ""
}

func toolDefinitionsEqual(a, b []map[string]any) bool {
	if len(a) != len(b) {
		return false
	}
	if len(a) == 0 {
		return true
	}
	ba, errA := json.Marshal(a)
	bb, errB := json.Marshal(b)
	if errA != nil || errB != nil {
		return false
	}
	return bytes.Equal(ba, bb)
}

func buildSteps(
	recs []parsedRecord,
	isContinuation bool,
	prevSegMsgs []proxy.ParsedMessage,
	priorToolCalls map[string]string,
) []Step {
	steps := make([]Step, 0)
	nextStepID := 1
	lastAgentIdx := -1
	var prevMsgs []proxy.ParsedMessage

	var prevRec *parsedRecord
	for reqIdx, pr := range recs {
		rec := pr.rec
		parsed := pr.parsed

		msgs := parsed.RequestMessages
		var startIdx int
		if prevRec != nil && isChainedByPreviousResponseID(*prevRec, pr) {
			startIdx = 0
			if len(msgs) > 0 && msgs[0].Role == "system" && leadingSystemContent(prevMsgs) == msgs[0].Content {
				startIdx = 1
			}
		} else {
			startIdx = commonPrefixLen(prevMsgs, msgs)
		}
		prevMsgs = msgs
		currCopy := pr
		prevRec = &currCopy

		toolIDRemap := map[string]string{}

		sharesContext := false
		if reqIdx == 0 && isContinuation && len(prevSegMsgs) > 0 {
			sharesContext = sharesPrevContext(msgs, prevSegMsgs)
		}

		for i := startIdx; i < len(msgs); i++ {
			m := msgs[i]
			copied := false
			if reqIdx == 0 && isContinuation && len(prevSegMsgs) > 0 {
				if matchesPrevSegmentMessage(m, prevSegMsgs) {
					copied = true
				} else if sharesContext && looksLikeCompactionSummary(m.Content) {
					copied = true
				}
			}

			switch m.Role {
			case "system":
				if m.Content != "" {
					steps = append(steps, Step{
						StepID:          nextStepID,
						Timestamp:       rec.StartedAt,
						Source:          "system",
						Message:         m.Content,
						IsCopiedContext: copied,
					})
					nextStepID++
				}
			case "assistant":
				if reqIdx > 0 && lastAgentIdx >= 0 {
					if len(m.ToolCalls) > 0 && len(steps[lastAgentIdx].ToolCalls) > 0 {
						for k := 0; k < len(m.ToolCalls) && k < len(steps[lastAgentIdx].ToolCalls); k++ {
							echoID := m.ToolCalls[k].ID
							origID := steps[lastAgentIdx].ToolCalls[k].ToolCallID
							if echoID != "" && origID != "" && echoID != origID {
								toolIDRemap[echoID] = origID
							}
						}
					}
				} else {
					step := Step{
						StepID:           nextStepID,
						Timestamp:        rec.StartedAt,
						Source:           "agent",
						Message:          m.Content,
						ReasoningContent: m.Reasoning,
						IsCopiedContext:  copied,
					}
					for _, tc := range m.ToolCalls {
						callID := tc.ID
						if priorToolCalls != nil {
							if origID, ok := priorToolCalls[toolCallSignature(tc.Name, tc.Arguments)]; ok && origID != "" {
								if callID != "" && callID != origID {
									toolIDRemap[callID] = origID
								}
								callID = origID
							}
						}
						step.ToolCalls = append(step.ToolCalls, ToolCall{
							ToolCallID:   callID,
							FunctionName: tc.Name,
							Arguments:    parseToolArgs(tc.Arguments),
						})
					}
					steps = append(steps, step)
					lastAgentIdx = len(steps) - 1
					nextStepID++
				}
			case "user":
				if len(m.ToolResults) > 0 && lastAgentIdx >= 0 {
					attachObservation(&steps[lastAgentIdx], m.ToolResults, toolIDRemap)
				}
				if strings.TrimSpace(m.Content) != "" || len(m.ToolResults) == 0 {
					if m.Content != "" {
						steps = append(steps, Step{
							StepID:          nextStepID,
							Timestamp:       rec.StartedAt,
							Source:          "user",
							Message:         m.Content,
							IsCopiedContext: copied,
						})
						nextStepID++
					}
				}
			case "tool":
				if len(m.ToolResults) > 0 && lastAgentIdx >= 0 {
					attachObservation(&steps[lastAgentIdx], m.ToolResults, toolIDRemap)
				}
			}
		}

		if rec.Protocol != "" && rec.Protocol != "unknown" {
			isStream := rec.IsStream || parsed.IsStream
			stepExtra := map[string]any{}
			for k, v := range parsed.Metadata {
				stepExtra[k] = v
			}
			stepExtra["request_record_id"] = rec.ID
			stepExtra["request_seq"] = rec.Seq
			stepExtra["protocol"] = rec.Protocol
			stepExtra["status_code"] = rec.StatusCode
			stepExtra["latency_ms"] = rec.DurationMs
			stepExtra["duration_ms"] = rec.DurationMs
			stepExtra["is_stream"] = isStream
			stepExtra["upstream"] = rec.Upstream
			stepExtra["http_method"] = rec.Method
			stepExtra["http_path"] = rec.Path
			if parsed.RequestedModel != "" {
				stepExtra["requested_model"] = parsed.RequestedModel
			}
			if parsed.ResponseModel != "" {
				stepExtra["response_model"] = parsed.ResponseModel
			}
			if parsed.ResponseID != "" {
				stepExtra["response_id"] = parsed.ResponseID
			}
			if parsed.FinishReason != "" {
				stepExtra["finish_reason"] = parsed.FinishReason
			}
			if v := firstNonEmpty(rec.ClientIP, parsed.ClientIP); v != "" {
				stepExtra["client_ip"] = v
			}
			if v := firstNonEmpty(rec.APIKeyHash, parsed.APIKeyHash); v != "" {
				stepExtra["api_key_hash"] = v
			}
			step := Step{
				StepID:           nextStepID,
				Timestamp:        rec.CompletedAt,
				Source:           "agent",
				Message:          parsed.AssistantText,
				ModelName:        firstNonEmpty(parsed.ResponseModel, parsed.Model, parsed.RequestedModel, rec.Model),
				ReasoningContent: parsed.ReasoningContent,
				LLMCallCount:     1,
				Extra:            stepExtra,
			}
			for _, tc := range parsed.ToolCalls {
				step.ToolCalls = append(step.ToolCalls, ToolCall{
					ToolCallID:   tc.ID,
					FunctionName: tc.Name,
					Arguments:    parseToolArgs(tc.Arguments),
				})
			}
			if rec.PromptTokens > 0 || rec.CompletionTokens > 0 || rec.CachedTokens > 0 || parsed.ReasoningTokens > 0 || parsed.CacheCreateTokens > 0 {
				m := &Metrics{
					PromptTokens:     rec.PromptTokens,
					CompletionTokens: rec.CompletionTokens,
					CachedTokens:     rec.CachedTokens,
				}
				mExtra := map[string]any{}
				if parsed.CacheCreateTokens > 0 {
					mExtra["cache_creation_input_tokens"] = parsed.CacheCreateTokens
				}
				if parsed.ReasoningTokens > 0 {
					mExtra["reasoning_tokens"] = parsed.ReasoningTokens
				}
				if len(mExtra) > 0 {
					m.Extra = mExtra
				}
				step.Metrics = m
			}
			steps = append(steps, step)
			lastAgentIdx = len(steps) - 1
			nextStepID++
		}
	}
	return steps
}

func collectSegmentMessages(segRecs []parsedRecord) []proxy.ParsedMessage {
	msgs := make([]proxy.ParsedMessage, 0)
	for _, pr := range segRecs {
		msgs = append(msgs, pr.parsed.RequestMessages...)
		if pr.rec.Protocol != "" && pr.rec.Protocol != "unknown" {
			msgs = append(msgs, proxy.ParsedMessage{
				Role:      "assistant",
				Content:   pr.parsed.AssistantText,
				Reasoning: pr.parsed.ReasoningContent,
				ToolCalls: pr.parsed.ToolCalls,
			})
		}
	}
	return msgs
}

func matchesPrevSegmentMessage(m proxy.ParsedMessage, prevSegMsgs []proxy.ParsedMessage) bool {
	for _, pm := range prevSegMsgs {
		if parsedMessagesMatch(m, pm) {
			return true
		}
		if m.Role == "assistant" && pm.Role == "assistant" && assistantMessagesEquivalent(m, pm) {
			return true
		}
	}
	return false
}

func assistantMessagesEquivalent(a, b proxy.ParsedMessage) bool {
	if a.Content != b.Content || len(a.ToolCalls) != len(b.ToolCalls) {
		return false
	}
	if len(a.ToolCalls) == 0 {
		if a.Content != "" {
			return true
		}
		return a.Reasoning != "" && a.Reasoning == b.Reasoning
	}
	for i := range a.ToolCalls {
		if a.ToolCalls[i].Name != b.ToolCalls[i].Name ||
			canonicalJSONArgs(a.ToolCalls[i].Arguments) != canonicalJSONArgs(b.ToolCalls[i].Arguments) {
			return false
		}
	}
	return true
}

func canonicalJSONArgs(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	var v any
	if err := json.Unmarshal([]byte(trimmed), &v); err != nil {
		return trimmed
	}
	b, err := json.Marshal(v)
	if err != nil {
		return trimmed
	}
	return string(b)
}

func sharesPrevContext(msgs []proxy.ParsedMessage, prevSegMsgs []proxy.ParsedMessage) bool {
	for _, m := range msgs {
		if matchesPrevSegmentMessage(m, prevSegMsgs) {
			return true
		}
	}
	return false
}

func looksLikeCompactionSummary(content string) bool {
	lower := strings.ToLower(strings.TrimSpace(content))
	if lower == "" {
		return false
	}
	markers := []string{
		"<summary>",
		"conversation summary",
		"summary of previous",
		"summary of prior",
		"previous conversation",
		"prior conversation",
		"compacted conversation",
		"compacted history",
		"context summary",
		"conversation so far",
		"summarized history",
		"对话摘要",
		"上下文摘要",
		"历史摘要",
	}
	for _, mk := range markers {
		if strings.Contains(lower, mk) {
			return true
		}
	}
	return false
}

func toolCallSignature(name, args string) string {
	return name + "\x00" + canonicalJSONArgs(args)
}

func commonPrefixLen(prev, curr []proxy.ParsedMessage) int {
	limit := len(prev)
	if len(curr) < limit {
		limit = len(curr)
	}
	i := 0
	for i < limit && parsedMessagesMatch(prev[i], curr[i]) {
		i++
	}
	return i
}

func parsedMessagesMatch(a, b proxy.ParsedMessage) bool {
	if a.Role != b.Role || a.Content != b.Content || a.Reasoning != b.Reasoning {
		return false
	}
	if len(a.ToolCalls) != len(b.ToolCalls) || len(a.ToolResults) != len(b.ToolResults) {
		return false
	}
	for i := range a.ToolCalls {
		if a.ToolCalls[i].ID != b.ToolCalls[i].ID ||
			a.ToolCalls[i].Name != b.ToolCalls[i].Name ||
			a.ToolCalls[i].Arguments != b.ToolCalls[i].Arguments {
			return false
		}
	}
	for i := range a.ToolResults {
		if a.ToolResults[i].ToolCallID != b.ToolResults[i].ToolCallID ||
			a.ToolResults[i].Content != b.ToolResults[i].Content {
			return false
		}
	}
	return true
}

func attachSubagentsToSegments(segments []*Trajectory, subagentTrajs []*Trajectory) {
	if len(segments) == 0 || len(subagentTrajs) == 0 {
		return
	}
	usedIDs := map[string]struct{}{}
	for _, seg := range segments {
		usedIDs[seg.TrajectoryID] = struct{}{}
	}
	assigned := make([]bool, len(subagentTrajs))
	findSub := func(content string) *Trajectory {
		for k, sub := range subagentTrajs {
			if assigned[k] {
				continue
			}
			if sub.Extra != nil {
				if sid, _ := sub.Extra["subagent_id"].(string); sid != "" && strings.Contains(content, sid) {
					assigned[k] = true
					return sub
				}
			}
		}
		for k, sub := range subagentTrajs {
			if !assigned[k] {
				assigned[k] = true
				return sub
			}
		}
		return nil
	}
	for _, seg := range segments {
		for i := range seg.Steps {
			step := &seg.Steps[i]
			if step.Source != "agent" || step.Observation == nil {
				continue
			}
			toolNameByID := map[string]string{}
			for _, tc := range step.ToolCalls {
				toolNameByID[tc.ToolCallID] = strings.ToLower(tc.FunctionName)
			}
			for j := range step.Observation.Results {
				res := &step.Observation.Results[j]
				fnName := toolNameByID[res.SourceCallID]
				m := reTaskID.FindStringSubmatch(res.Content)
				isSubagentCall := len(m) > 1 || fnName == "task" || fnName == "subagent" || fnName == "agent" || fnName == "spawn_agent"
				if !isSubagentCall {
					continue
				}
				sub := findSub(res.Content)
				if sub == nil {
					break
				}
				if len(m) > 1 && strings.TrimSpace(m[1]) != "" {
					taskID := strings.TrimSpace(m[1])
					sub.SessionID = taskID
					if _, exists := usedIDs[taskID]; !exists {
						sub.TrajectoryID = taskID
					}
				}
				usedIDs[sub.TrajectoryID] = struct{}{}
				res.SubagentTrajectoryRef = append(res.SubagentTrajectoryRef, SubagentTrajectoryRef{
					SessionID:    sub.SessionID,
					TrajectoryID: sub.TrajectoryID,
				})
				seg.SubagentTrajectories = append(seg.SubagentTrajectories, sub)
			}
		}
	}
	for k, sub := range subagentTrajs {
		if assigned[k] {
			continue
		}
		lastSeg := segments[len(segments)-1]
		usedIDs[sub.TrajectoryID] = struct{}{}
		lastSeg.SubagentTrajectories = append(lastSeg.SubagentTrajectories, sub)
	}
	for _, seg := range segments {
		if len(seg.SubagentTrajectories) == 0 {
			continue
		}
		if seg.Extra == nil {
			seg.Extra = map[string]any{}
		}
		seg.Extra["has_subagent"] = true
		seg.Extra["subagent_count"] = len(seg.SubagentTrajectories)
		if seg.FinalMetrics != nil {
			totalP := seg.FinalMetrics.TotalPromptTokens
			totalC := seg.FinalMetrics.TotalCompletionTokens
			totalCached := seg.FinalMetrics.TotalCachedTokens
			for _, sub := range seg.SubagentTrajectories {
				if sub.FinalMetrics != nil {
					totalP += sub.FinalMetrics.TotalPromptTokens
					totalC += sub.FinalMetrics.TotalCompletionTokens
					totalCached += sub.FinalMetrics.TotalCachedTokens
				}
			}
			if seg.FinalMetrics.Extra == nil {
				seg.FinalMetrics.Extra = map[string]any{}
			}
			seg.FinalMetrics.Extra["total_prompt_tokens_with_subagents"] = totalP
			seg.FinalMetrics.Extra["total_completion_tokens_with_subagents"] = totalC
			seg.FinalMetrics.Extra["total_cached_tokens_with_subagents"] = totalCached
		}
	}
}

func sumStepMetrics(steps []Step) (int, int, int) {
	var p, c, cached int
	for _, s := range steps {
		if s.Metrics != nil {
			p += s.Metrics.PromptTokens
			c += s.Metrics.CompletionTokens
			cached += s.Metrics.CachedTokens
		}
	}
	return p, c, cached
}

func latestToolDefinitions(recs []parsedRecord) []map[string]any {
	for i := len(recs) - 1; i >= 0; i-- {
		if len(recs[i].parsed.ToolDefinitions) > 0 {
			return recs[i].parsed.ToolDefinitions
		}
	}
	return nil
}

func extractWorkDirFromParsed(parsed *proxy.ParsedExchange) string {
	if parsed == nil {
		return ""
	}
	if parsed.SystemPrompt != "" {
		if wd := harness.MatchWorkDir(parsed.SystemPrompt); wd != "" {
			return wd
		}
	}
	for _, m := range parsed.RequestMessages {
		if m.Content != "" {
			if wd := harness.MatchWorkDir(m.Content); wd != "" {
				return wd
			}
		}
	}
	return ""
}

func isSubagentMetadata(meta map[string]any) bool {
	if meta == nil {
		return false
	}
	if b, ok := meta["is_subagent"].(bool); ok && b {
		return true
	}
	if s, ok := meta["source"].(string); ok && strings.EqualFold(s, "subagent") {
		return true
	}
	return false
}

func mergeSessionMetadata(dst, src map[string]any) {
	if len(src) == 0 {
		return
	}
	keys := []string{
		"account_id",
		"appbuilder_account_id",
		"device_id",
		"prd_source",
		"sandbox",
		"sandbox_type",
		"fixed_model",
		"prompt_cache_key",
	}
	for _, k := range keys {
		if v, ok := src[k]; ok {
			if _, exists := dst[k]; !exists {
				dst[k] = v
			}
		}
	}
}

func attachObservation(step *Step, results []proxy.ParsedToolResult, remap map[string]string) {
	if step.Observation == nil {
		step.Observation = &Observation{
			Results: make([]ObservationResult, 0, len(results)),
		}
	}
	for _, r := range results {
		callID := r.ToolCallID
		var extra map[string]any
		if mapped, ok := remap[callID]; ok && mapped != "" {
			extra = map[string]any{"raw_tool_call_id": callID}
			callID = mapped
		}
		step.Observation.Results = append(step.Observation.Results, ObservationResult{
			SourceCallID: callID,
			Content:      r.Content,
			Extra:        extra,
		})
	}
}

func parseToolArgs(raw string) map[string]any {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return map[string]any{}
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(trimmed), &m); err == nil && m != nil {
		return m
	}
	return map[string]any{"raw": raw}
}

func parseHeadersJSON(raw string) http.Header {
	h := http.Header{}
	if strings.TrimSpace(raw) == "" {
		return h
	}
	var multi map[string][]string
	if err := json.Unmarshal([]byte(raw), &multi); err == nil && len(multi) > 0 {
		for k, vals := range multi {
			for _, v := range vals {
				h.Add(k, v)
			}
		}
		return h
	}
	var single map[string]string
	if err := json.Unmarshal([]byte(raw), &single); err == nil {
		for k, v := range single {
			h.Set(k, v)
		}
	}
	return h
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func parseRecordTime(raw string) (time.Time, bool) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return time.Time{}, false
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t, true
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t, true
	}
	return time.Time{}, false
}

func computeRecordTimeBounds(recs []parsedRecord, fallbackStart, fallbackEnd string) (string, string, int64) {
	var minStartTime time.Time
	var minStartStr string
	hasStart := false

	var maxEndTime time.Time
	var maxEndStr string
	hasEnd := false

	var sumDurationMs int64

	for _, pr := range recs {
		rec := pr.rec
		if rec.DurationMs > 0 {
			sumDurationMs += rec.DurationMs
		}

		st, stOK := parseRecordTime(rec.StartedAt)
		if stOK {
			if !hasStart || st.Before(minStartTime) {
				minStartTime = st
				minStartStr = rec.StartedAt
				hasStart = true
			}
		} else if !hasStart && rec.StartedAt != "" {
			minStartStr = rec.StartedAt
		}

		et, etOK := parseRecordTime(rec.CompletedAt)
		endStr := rec.CompletedAt
		if !etOK && stOK {
			if rec.DurationMs > 0 {
				et = st.Add(time.Duration(rec.DurationMs) * time.Millisecond)
				endStr = et.UTC().Format(time.RFC3339Nano)
				etOK = true
			} else {
				et = st
				endStr = rec.StartedAt
				etOK = true
			}
		}
		if etOK {
			if !hasEnd || et.After(maxEndTime) {
				maxEndTime = et
				maxEndStr = endStr
				hasEnd = true
			}
		} else if !hasEnd && endStr != "" {
			maxEndStr = endStr
		}
	}

	if minStartStr == "" {
		minStartStr = fallbackStart
		if st, ok := parseRecordTime(fallbackStart); ok {
			minStartTime = st
			hasStart = true
		}
	}
	if maxEndStr == "" {
		maxEndStr = firstNonEmpty(fallbackEnd, minStartStr)
		if et, ok := parseRecordTime(maxEndStr); ok {
			maxEndTime = et
			hasEnd = true
		}
	}

	var durationMs int64
	if hasStart && hasEnd && maxEndTime.After(minStartTime) {
		durationMs = maxEndTime.Sub(minStartTime).Milliseconds()
	} else if sumDurationMs > 0 {
		durationMs = sumDurationMs
	}

	return minStartStr, maxEndStr, durationMs
}
