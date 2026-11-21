package harness

import (
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
	if v := firstHeader(headers, "Session_id", "X-Session-Id", "Conversation_id", "X-Conversation-Id"); v != "" {
		return v
	}
	return extractBodyField(body, "prompt_cache_key")
}

func (e *CodexExtractor) ExtractWorkDir(headers http.Header, body []byte, parsed *proxy.ParsedExchange) string {
	return extractCommonWorkDir(headers, body, parsed)
}

func (e *CodexExtractor) ExtractMetadata(_ http.Header, _ []byte, _ *proxy.ParsedExchange) map[string]any {
	return nil
}
