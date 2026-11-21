package harness

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"

	"llm_tracer/internal/proxy"
)

type Info struct {
	Harness        string
	HarnessVersion string
	SessionID      string
	WorkDir        string
	Source         string
	IsSubagent     bool
	Metadata       map[string]any
}

type Extractor interface {
	Name() string
	Match(userAgent string, headers http.Header) bool
	ExtractVersion(userAgent string, headers http.Header) string
	ExtractSessionID(headers http.Header, body []byte, parsed *proxy.ParsedExchange) string
	ExtractWorkDir(headers http.Header, body []byte, parsed *proxy.ParsedExchange) string
	ExtractMetadata(headers http.Header, body []byte, parsed *proxy.ParsedExchange) map[string]any
}

type Detector struct {
	extractors []Extractor
	fallback   Extractor
}

func DefaultDetector() *Detector {
	return &Detector{
		extractors: []Extractor{
			&DumateExtractor{},
			&PiExtractor{},
			&ClaudeCodeExtractor{},
			&CodexExtractor{},
			&OpenCodeExtractor{},
		},
		fallback: &GenericExtractor{},
	}
}

func (d *Detector) Register(ext Extractor) {
	d.extractors = append([]Extractor{ext}, d.extractors...)
}

func (d *Detector) Detect(upstream string, headers http.Header, body []byte, parsed *proxy.ParsedExchange) Info {
	ua := headers.Get("User-Agent")
	ext := d.fallback
	for _, candidate := range d.extractors {
		if candidate.Match(ua, headers) {
			ext = candidate
			break
		}
	}
	name := ext.Name()
	ver := ext.ExtractVersion(ua, headers)
	if ver == "" {
		ver = "unknown"
	}
	sessID := strings.TrimSpace(ext.ExtractSessionID(headers, body, parsed))
	if sessID == "" {
		sessID = deriveFallbackSessionID(name, upstream, parsed)
	}
	workDir := strings.TrimSpace(ext.ExtractWorkDir(headers, body, parsed))
	meta := ext.ExtractMetadata(headers, body, parsed)

	info := Info{
		Harness:        name,
		HarnessVersion: ver,
		SessionID:      sessID,
		WorkDir:        workDir,
		Metadata:       meta,
	}
	if meta != nil {
		if src, ok := meta["source"].(string); ok {
			info.Source = src
		}
		if isSub, ok := meta["is_subagent"].(bool); ok {
			info.IsSubagent = isSub
		}
	}
	return info
}

var reWorkDirList = []*regexp.Regexp{
	regexp.MustCompile(`(?im)(?:current\s+)?(?:primary\s+)?working\s+directory\s*[:=]\s*([^\r\n"'<>` + "`" + `\\]+)`),
	regexp.MustCompile(`(?im)\bcwd\s*[:=]\s*([^\r\n"'<>` + "`" + `\\]+)`),
	regexp.MustCompile(`(?im)<cwd>\s*([^<\r\n]+?)\s*</cwd>`),
	regexp.MustCompile(`(?im)workspace(?:\s+(?:root|dir|directory|path))?\s*[:=]\s*([^\r\n"'<>` + "`" + `\\]+)`),
	regexp.MustCompile(`(?im)工作目录\s*[:：]\s*([^\r\n"'<>` + "`" + `\\]+)`),
}

func firstHeader(headers http.Header, names ...string) string {
	for _, name := range names {
		for k, vals := range headers {
			if strings.EqualFold(k, name) {
				for _, v := range vals {
					v = strings.TrimSpace(v)
					if v != "" {
						return v
					}
				}
			}
		}
	}
	return ""
}

func extractBodyField(body []byte, field string) string {
	return extractNestedBodyField(body, field)
}

func extractNestedBodyField(body []byte, path ...string) string {
	if len(body) == 0 || len(path) == 0 {
		return ""
	}
	var curr any
	if err := json.Unmarshal(body, &curr); err != nil {
		return ""
	}
	for _, key := range path {
		m, ok := curr.(map[string]any)
		if !ok {
			return ""
		}
		curr, ok = m[key]
		if !ok {
			return ""
		}
	}
	if s, ok := curr.(string); ok {
		return strings.TrimSpace(s)
	}
	return ""
}

func extractCommonWorkDir(headers http.Header, body []byte, parsed *proxy.ParsedExchange) string {
	if v := firstHeader(headers, "X-Work-Dir", "X-Working-Directory", "X-Cwd"); v != "" {
		return v
	}
	if parsed != nil {
		if parsed.SystemPrompt != "" {
			if wd := MatchWorkDir(parsed.SystemPrompt); wd != "" {
				return wd
			}
		}
		for _, m := range parsed.RequestMessages {
			if m.Content != "" {
				if wd := MatchWorkDir(m.Content); wd != "" {
					return wd
				}
			}
		}
	}
	if len(body) > 0 && len(body) <= 512*1024 {
		if wd := MatchWorkDir(string(body)); wd != "" {
			return wd
		}
	}
	return ""
}

func MatchWorkDir(text string) string {
	for _, re := range reWorkDirList {
		if m := re.FindStringSubmatch(text); len(m) > 1 {
			cand := strings.TrimSpace(m[1])
			cand = strings.TrimRight(cand, ".,;)")
			if strings.HasPrefix(cand, "/") || strings.HasPrefix(cand, "~") || (len(cand) > 2 && cand[1] == ':') {
				return cand
			}
		}
	}
	return ""
}

func deriveFallbackSessionID(harnessName, upstream string, parsed *proxy.ParsedExchange) string {
	if parsed != nil {
		var firstUser string
		for _, m := range parsed.RequestMessages {
			if m.Role == "user" && strings.TrimSpace(m.Content) != "" {
				firstUser = m.Content
				break
			}
		}
		if parsed.SystemPrompt != "" || firstUser != "" {
			h := sha256.New()
			h.Write([]byte(harnessName))
			h.Write([]byte{0})
			h.Write([]byte(upstream))
			h.Write([]byte{0})
			h.Write([]byte(parsed.SystemPrompt))
			h.Write([]byte{0})
			h.Write([]byte(firstUser))
			sum := hex.EncodeToString(h.Sum(nil))
			return "sess-" + sum[:16]
		}
	}
	var b [8]byte
	_, _ = rand.Read(b[:])
	return "sess-" + hex.EncodeToString(b[:])
}
