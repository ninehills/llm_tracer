package harness

import (
	"net/http"
	"regexp"
	"strings"

	"llm_tracer/internal/proxy"
)

var reOpenCodeVer = regexp.MustCompile(`(?i)opencode/([0-9]+\.[0-9]+[^\s);]*)`)

type OpenCodeExtractor struct{}

func (e *OpenCodeExtractor) Name() string { return "opencode" }

func (e *OpenCodeExtractor) Match(userAgent string, headers http.Header) bool {
	ua := strings.ToLower(userAgent)
	if strings.Contains(ua, "opencode") {
		return true
	}
	return headers.Get("X-Opencode-Session") != ""
}

func (e *OpenCodeExtractor) ExtractVersion(userAgent string, _ http.Header) string {
	if m := reOpenCodeVer.FindStringSubmatch(userAgent); len(m) > 1 {
		return m[1]
	}
	return "unknown"
}

func (e *OpenCodeExtractor) ExtractSessionID(headers http.Header, body []byte, _ *proxy.ParsedExchange) string {
	if v := firstHeader(headers, "X-Opencode-Session", "X-Session-Id", "Session_id"); v != "" {
		return v
	}
	return extractBodyField(body, "prompt_cache_key")
}

func (e *OpenCodeExtractor) ExtractWorkDir(headers http.Header, body []byte, parsed *proxy.ParsedExchange) string {
	return extractCommonWorkDir(headers, body, parsed)
}

func (e *OpenCodeExtractor) ExtractMetadata(_ http.Header, _ []byte, _ *proxy.ParsedExchange) map[string]any {
	return nil
}
