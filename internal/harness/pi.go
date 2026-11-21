package harness

import (
	"net/http"
	"regexp"
	"strings"

	"llm_tracer/internal/proxy"
)

var rePiVersion = regexp.MustCompile(`(?i)\bpi(?:-(?:coding-)?agent)?/([0-9]+\.[0-9]+[^\s);]*)`)

type PiExtractor struct{}

func (e *PiExtractor) Name() string { return "pi" }

func (e *PiExtractor) Match(userAgent string, headers http.Header) bool {
	ua := strings.ToLower(strings.TrimSpace(userAgent))
	if ua == "pi" || strings.HasPrefix(ua, "pi/") || strings.Contains(ua, " pi/") ||
		strings.Contains(ua, "pi-agent") || strings.Contains(ua, "pi-coding-agent") {
		return true
	}
	if strings.EqualFold(strings.TrimSpace(headers.Get("X-Opencode-Client")), "pi") {
		return true
	}
	if strings.EqualFold(strings.TrimSpace(headers.Get("X-OpenRouter-Title")), "pi") {
		return true
	}
	if strings.Contains(strings.ToLower(headers.Get("HTTP-Referer")), "pi.dev") ||
		strings.Contains(strings.ToLower(headers.Get("Referer")), "pi.dev") {
		return true
	}
	return false
}

func (e *PiExtractor) ExtractVersion(userAgent string, _ http.Header) string {
	if m := rePiVersion.FindStringSubmatch(userAgent); len(m) > 1 {
		return m[1]
	}
	return "unknown"
}

func (e *PiExtractor) ExtractSessionID(headers http.Header, body []byte, _ *proxy.ParsedExchange) string {
	if v := firstHeader(headers, "X-Session-Id", "Session_id", "X-Opencode-Session", "X-Session-Affinity"); v != "" {
		return v
	}
	if v := extractBodyField(body, "prompt_cache_key"); v != "" {
		return v
	}
	if v := extractNestedBodyField(body, "metadata", "session_id"); v != "" {
		return v
	}
	return extractNestedBodyField(body, "metadata", "sessionId")
}

func (e *PiExtractor) ExtractWorkDir(headers http.Header, body []byte, parsed *proxy.ParsedExchange) string {
	return extractCommonWorkDir(headers, body, parsed)
}

func (e *PiExtractor) ExtractMetadata(_ http.Header, _ []byte, _ *proxy.ParsedExchange) map[string]any {
	return nil
}
