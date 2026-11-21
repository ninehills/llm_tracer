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
	if v := firstHeader(headers, "X-Session-Id", "X-Claude-Session-Id", "Anthropic-Session-Id"); v != "" {
		return v
	}
	var payload struct {
		Metadata struct {
			UserID string `json:"user_id"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal(body, &payload); err == nil && payload.Metadata.UserID != "" {
		if m := reClaudeSession.FindStringSubmatch(payload.Metadata.UserID); len(m) > 1 {
			return m[1]
		}
		return payload.Metadata.UserID
	}
	return ""
}

func (e *ClaudeCodeExtractor) ExtractWorkDir(headers http.Header, body []byte, parsed *proxy.ParsedExchange) string {
	return extractCommonWorkDir(headers, body, parsed)
}

func (e *ClaudeCodeExtractor) ExtractMetadata(_ http.Header, _ []byte, _ *proxy.ParsedExchange) map[string]any {
	return nil
}
