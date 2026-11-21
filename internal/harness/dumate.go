package harness

import (
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"llm_tracer/internal/proxy"
)

var reDumateVersion = regexp.MustCompile(`(?i)dumate(?:app)?[\s/_-]+v?([0-9]+\.[0-9]+[^\s);]*)`)

type DumateExtractor struct{}

func (e *DumateExtractor) Name() string { return "dumate" }

func (e *DumateExtractor) Match(userAgent string, headers http.Header) bool {
	if strings.Contains(strings.ToLower(userAgent), "dumate") {
		return true
	}
	return firstHeader(headers, "X-Dumate-Session-Id", "X-Dumate-Request-Id") != ""
}

func (e *DumateExtractor) ExtractVersion(userAgent string, _ http.Header) string {
	if m := reDumateVersion.FindStringSubmatch(userAgent); len(m) > 1 {
		return m[1]
	}
	return "unknown"
}

func (e *DumateExtractor) ExtractSessionID(headers http.Header, body []byte, _ *proxy.ParsedExchange) string {
	if v := firstHeader(headers, "X-Dumate-Session-Id", "X-Session-Id", "Session_id"); v != "" {
		return v
	}
	if v := extractBodyField(body, "prompt_cache_key"); v != "" {
		return v
	}
	return extractNestedBodyField(body, "metadata", "session_id")
}

func (e *DumateExtractor) ExtractWorkDir(headers http.Header, body []byte, parsed *proxy.ParsedExchange) string {
	return extractCommonWorkDir(headers, body, parsed)
}

func (e *DumateExtractor) ExtractMetadata(headers http.Header, _ []byte, _ *proxy.ParsedExchange) map[string]any {
	meta := make(map[string]any)

	headerMap := [][2]string{
		{"X-Dumate-Request-Id", "request_id"},
		{"X-Dumate-Account-Id", "account_id"},
		{"X-Appbuilder-Dumate-Account-Id", "appbuilder_account_id"},
		{"X-Dumate-Device-Id", "device_id"},
		{"X-Dumate-Prd-Source", "prd_source"},
	}
	for _, pair := range headerMap {
		if v := firstHeader(headers, pair[0]); v != "" {
			meta[pair[1]] = v
		}
	}

	if raw := firstHeader(headers, "X-Dumate-Request-Extra-Param"); raw != "" {
		parseDumateExtraParams(raw, meta)
	}

	if len(meta) == 0 {
		return nil
	}
	return meta
}

func parseDumateExtraParams(raw string, meta map[string]any) {
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		k, v, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		v = strings.TrimSpace(v)
		if k == "" {
			continue
		}
		if unescaped, err := url.QueryUnescape(v); err == nil {
			v = unescaped
		}
		switch k {
		case "source":
			meta["source"] = v
			meta["is_subagent"] = strings.EqualFold(v, "subagent")
		case "sandbox":
			if strings.EqualFold(v, "true") {
				meta["sandbox"] = true
			} else if strings.EqualFold(v, "false") {
				meta["sandbox"] = false
			} else {
				meta["sandbox"] = v
			}
		case "sandboxType", "sandbox_type":
			meta["sandbox_type"] = v
		case "fixedModel", "fixed_model":
			meta["fixed_model"] = v
		default:
			meta[k] = v
		}
	}
}
