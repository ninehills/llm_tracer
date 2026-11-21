package harness

import (
	"net/http"
	"regexp"

	"llm_tracer/internal/proxy"
)

var reGenericVer = regexp.MustCompile(`([A-Za-z0-9_-]+)/([0-9]+\.[0-9]+[^\s);]*)`)

type GenericExtractor struct{}

func (e *GenericExtractor) Name() string { return "generic" }

func (e *GenericExtractor) Match(_ string, _ http.Header) bool { return true }

func (e *GenericExtractor) ExtractVersion(userAgent string, _ http.Header) string {
	if m := reGenericVer.FindStringSubmatch(userAgent); len(m) > 2 {
		return m[2]
	}
	return "0.0.0"
}

func (e *GenericExtractor) ExtractSessionID(headers http.Header, body []byte, _ *proxy.ParsedExchange) string {
	if v := firstHeader(headers, "X-Session-Id", "Session_id", "X-Conversation-Id", "X-Trace-Id", "X-Request-Session"); v != "" {
		return v
	}
	if v := extractBodyField(body, "prompt_cache_key"); v != "" {
		return v
	}
	return extractNestedBodyField(body, "metadata", "session_id")
}

func (e *GenericExtractor) ExtractWorkDir(headers http.Header, body []byte, parsed *proxy.ParsedExchange) string {
	return extractCommonWorkDir(headers, body, parsed)
}

func (e *GenericExtractor) ExtractMetadata(_ http.Header, _ []byte, _ *proxy.ParsedExchange) map[string]any {
	return nil
}
