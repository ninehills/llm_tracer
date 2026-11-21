package harness

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"

	"llm_tracer/internal/proxy"
)

var (
	reClaudeVersion = regexp.MustCompile(`(?i)claude[-_](?:cli|code)/([0-9]+\.[0-9]+[^\s);]*)`)
	reClaudeSession = regexp.MustCompile(`session_([A-Za-z0-9_-]+)`)
)

type ClaudeCodeExtractor struct{}

func (e *ClaudeCodeExtractor) Name() string { return "claude-code" }

func (e *ClaudeCodeExtractor) Match(userAgent string, _ http.Header) bool {
	ua := strings.ToLower(userAgent)
	return strings.Contains(ua, "claude-cli") || strings.Contains(ua, "claude-code") || strings.Contains(ua, "claude_code")
}

func (e *ClaudeCodeExtractor) ExtractVersion(userAgent string, _ http.Header) string {
	if m := reClaudeVersion.FindStringSubmatch(userAgent); len(m) > 1 {
		return m[1]
	}
	return "unknown"
}

func (e *ClaudeCodeExtractor) ExtractSessionID(headers http.Header, body []byte, _ *proxy.ParsedExchange) string {
	if v := firstHeader(headers, "X-Claude-Code-Session-Id", "X-Session-Id", "X-Claude-Session-Id", "Anthropic-Session-Id"); v != "" {
		return v
	}
	var payload struct {
		Metadata struct {
			UserID string `json:"user_id"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal(body, &payload); err == nil && payload.Metadata.UserID != "" {
		uid := strings.TrimSpace(payload.Metadata.UserID)
		if strings.HasPrefix(uid, "{") {
			var metaUser struct {
				SessionID string `json:"session_id"`
			}
			if err := json.Unmarshal([]byte(uid), &metaUser); err == nil && strings.TrimSpace(metaUser.SessionID) != "" {
				return strings.TrimSpace(metaUser.SessionID)
			}
		}
		if m := reClaudeSession.FindStringSubmatch(uid); len(m) > 1 {
			return m[1]
		}
		return uid
	}
	return ""
}

func (e *ClaudeCodeExtractor) ExtractWorkDir(headers http.Header, body []byte, parsed *proxy.ParsedExchange) string {
	return extractCommonWorkDir(headers, body, parsed)
}

func (e *ClaudeCodeExtractor) ExtractMetadata(headers http.Header, _ []byte, parsed *proxy.ParsedExchange) map[string]any {
	agentID := firstHeader(headers, "X-Claude-Code-Agent-Id")
	isSub := agentID != "" || (parsed != nil && strings.Contains(parsed.SystemPrompt, "cc_is_subagent=true"))
	if !isSub {
		return nil
	}
	meta := map[string]any{
		"source":      "subAgent",
		"is_subagent": true,
	}
	if agentID != "" {
		meta["subagent_id"] = agentID
	}
	return meta
}
