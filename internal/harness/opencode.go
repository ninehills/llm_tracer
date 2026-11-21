package harness

import (
	"net/http"
	"regexp"
	"strings"

	"llm_tracer/internal/proxy"
)

var reOpenCodeVer = regexp.MustCompile(`(?i)opencode/(?:[a-z0-9._-]+/)?v?([0-9]+\.[0-9]+[^\s);/]*)`)

type OpenCodeExtractor struct{}

func (e *OpenCodeExtractor) Name() string { return "opencode" }

func (e *OpenCodeExtractor) Match(userAgent string, headers http.Header) bool {
	ua := strings.ToLower(userAgent)
	if strings.Contains(ua, "opencode") {
		return true
	}
	return firstHeader(headers, "X-Opencode-Session", "X-Opencode-Session-Id", "X-Opencode-Client") != ""
}

func (e *OpenCodeExtractor) ExtractVersion(userAgent string, _ http.Header) string {
	if m := reOpenCodeVer.FindStringSubmatch(userAgent); len(m) > 1 {
		return m[1]
	}
	return "unknown"
}

func (e *OpenCodeExtractor) ExtractSessionID(headers http.Header, body []byte, _ *proxy.ParsedExchange) string {
	if v := firstHeader(headers, "X-Opencode-Session", "X-Opencode-Session-Id", "X-Session-Id", "Session_id", "X-Session-Affinity"); v != "" {
		return v
	}
	return extractBodyField(body, "prompt_cache_key")
}

func (e *OpenCodeExtractor) ExtractWorkDir(headers http.Header, body []byte, parsed *proxy.ParsedExchange) string {
	return extractCommonWorkDir(headers, body, parsed)
}

func (e *OpenCodeExtractor) ExtractMetadata(headers http.Header, _ []byte, _ *proxy.ParsedExchange) map[string]any {
	parentSID := firstHeader(headers, "X-Opencode-Parent-Session-Id", "X-Parent-Session-Id")
	if parentSID == "" {
		return nil
	}
	meta := map[string]any{
		"source":            "subAgent",
		"is_subagent":       true,
		"parent_session_id": parentSID,
	}
	if subID := firstHeader(headers, "X-Opencode-Session-Id"); subID != "" && subID != parentSID {
		meta["subagent_id"] = subID
	}
	return meta
}
