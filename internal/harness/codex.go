package harness

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"

	"llm_tracer/internal/proxy"
)

var reCodexVersion = regexp.MustCompile(`(?i)codex[^/\s]*/([0-9]+\.[0-9]+[^\s);]*)`)

type CodexExtractor struct{}

func (e *CodexExtractor) Name() string { return "codex" }

func (e *CodexExtractor) Match(userAgent string, _ http.Header) bool {
	ua := strings.ToLower(userAgent)
	return strings.Contains(ua, "codex")
}

func (e *CodexExtractor) ExtractVersion(userAgent string, _ http.Header) string {
	if m := reCodexVersion.FindStringSubmatch(userAgent); len(m) > 1 {
		return m[1]
	}
	return "unknown"
}

func (e *CodexExtractor) ExtractSessionID(headers http.Header, body []byte, _ *proxy.ParsedExchange) string {
	if v := firstHeader(headers, "Session-Id", "Session_id", "Thread-Id", "X-Session-Id", "Conversation_id", "X-Conversation-Id"); v != "" {
		return v
	}
	return extractBodyField(body, "prompt_cache_key")
}

func (e *CodexExtractor) ExtractWorkDir(headers http.Header, body []byte, parsed *proxy.ParsedExchange) string {
	return extractCommonWorkDir(headers, body, parsed)
}

func (e *CodexExtractor) ExtractMetadata(headers http.Header, _ []byte, _ *proxy.ParsedExchange) map[string]any {
	subagentHdr := firstHeader(headers, "X-Openai-Subagent")
	parentThreadID := firstHeader(headers, "X-Codex-Parent-Thread-Id")
	threadID := firstHeader(headers, "Thread-Id")
	var turnMeta struct {
		ThreadID       string `json:"thread_id"`
		ParentThreadID string `json:"parent_thread_id"`
		ThreadSource   string `json:"thread_source"`
		SubagentKind   string `json:"subagent_kind"`
		AgentName      string `json:"agent_name"`
	}
	if raw := firstHeader(headers, "X-Codex-Turn-Metadata"); raw != "" {
		_ = json.Unmarshal([]byte(raw), &turnMeta)
	}
	if parentThreadID == "" {
		parentThreadID = strings.TrimSpace(turnMeta.ParentThreadID)
	}
	if threadID == "" {
		threadID = strings.TrimSpace(turnMeta.ThreadID)
	}
	isSub := subagentHdr != "" || parentThreadID != "" || strings.EqualFold(turnMeta.ThreadSource, "subagent")
	if !isSub {
		return nil
	}
	meta := map[string]any{
		"source":      "subAgent",
		"is_subagent": true,
	}
	if threadID != "" {
		meta["subagent_id"] = threadID
	}
	if parentThreadID != "" {
		meta["parent_thread_id"] = parentThreadID
	}
	if kind := strings.TrimSpace(turnMeta.SubagentKind); kind != "" {
		meta["subagent_kind"] = kind
	} else if subagentHdr != "" {
		meta["subagent_kind"] = subagentHdr
	}
	if name := strings.TrimSpace(turnMeta.AgentName); name != "" {
		meta["agent_name"] = name
	}
	return meta
}
