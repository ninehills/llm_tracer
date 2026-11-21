package proxy

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"llm_tracer/internal/config"
)

type CapturedExchange struct {
	Upstream        string
	Method          string
	Path            string
	Query           string
	ClientIP        string
	APIKeyHash      string
	RequestHeaders  http.Header
	ResponseHeaders http.Header
	RequestBody     []byte
	ResponseBody    []byte
	StatusCode      int
	StartedAt       time.Time
	CompletedAt     time.Time
	DurationMs      int64
}

type CaptureHandler func(ex *CapturedExchange)

type Handler struct {
	cfg       *config.Config
	transport *http.Transport
	onCapture CaptureHandler
}

var hopByHopHeaders = map[string]struct{}{
	"connection":          {},
	"keep-alive":          {},
	"proxy-authenticate":  {},
	"proxy-authorization": {},
	"te":                  {},
	"trailer":             {},
	"trailers":            {},
	"transfer-encoding":   {},
	"upgrade":             {},
}

func NewHandler(cfg *config.Config, onCapture CaptureHandler) *Handler {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.DisableCompression = true
	return &Handler{
		cfg:       cfg,
		transport: tr,
		onCapture: onCapture,
	}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	trimmed := strings.TrimPrefix(r.URL.Path, "/proxy/")
	if trimmed == r.URL.Path || trimmed == "" {
		http.Error(w, "missing upstream", http.StatusNotFound)
		return
	}
	slashIdx := strings.IndexByte(trimmed, '/')
	var upstreamName, restPath string
	if slashIdx < 0 {
		upstreamName = trimmed
		restPath = "/"
	} else {
		upstreamName = trimmed[:slashIdx]
		restPath = trimmed[slashIdx:]
	}

	upstream, ok := h.cfg.Upstreams[upstreamName]
	if !ok {
		http.Error(w, "unknown upstream", http.StatusNotFound)
		return
	}

	reqBody, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "failed to read request body", http.StatusBadRequest)
		return
	}
	_ = r.Body.Close()

	targetURL := buildTargetURL(upstream.ParsedURL, restPath, r.URL.RawQuery)
	outReq, err := http.NewRequestWithContext(r.Context(), r.Method, targetURL.String(), bytes.NewReader(reqBody))
	if err != nil {
		http.Error(w, "failed to create upstream request", http.StatusBadGateway)
		return
	}
	copyHeaders(outReq.Header, r.Header)
	outReq.Host = targetURL.Host
	outReq.ContentLength = int64(len(reqBody))

	startedAt := time.Now().UTC()
	resp, err := h.transport.RoundTrip(outReq)
	if err != nil {
		http.Error(w, "upstream error: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	copyHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)

	flusher, canFlush := w.(http.Flusher)
	var respBuf bytes.Buffer
	buf := make([]byte, 32*1024)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			_, _ = respBuf.Write(chunk)
			_, writeErr := w.Write(chunk)
			if canFlush {
				flusher.Flush()
			}
			if writeErr != nil {
				break
			}
		}
		if readErr != nil {
			break
		}
	}
	completedAt := time.Now().UTC()

	if h.onCapture != nil {
		ex := &CapturedExchange{
			Upstream:        upstreamName,
			Method:          r.Method,
			Path:            restPath,
			Query:           r.URL.RawQuery,
			ClientIP:        ExtractClientIP(r),
			APIKeyHash:      ExtractAPIKeyHash(r.Header),
			RequestHeaders:  r.Header.Clone(),
			ResponseHeaders: resp.Header.Clone(),
			RequestBody:     reqBody,
			ResponseBody:    respBuf.Bytes(),
			StatusCode:      resp.StatusCode,
			StartedAt:       startedAt,
			CompletedAt:     completedAt,
			DurationMs:      completedAt.Sub(startedAt).Milliseconds(),
		}
		h.onCapture(ex)
	}
}

func ExtractClientIP(r *http.Request) string {
	if r == nil {
		return ""
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		if first := strings.TrimSpace(parts[0]); first != "" {
			return first
		}
	}
	if xri := strings.TrimSpace(r.Header.Get("X-Real-IP")); xri != "" {
		return xri
	}
	if host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr)); err == nil && host != "" {
		return host
	}
	return strings.TrimSpace(r.RemoteAddr)
}

func ExtractAPIKeyHash(headers http.Header) string {
	if headers == nil {
		return ""
	}
	raw := strings.TrimSpace(headers.Get("Authorization"))
	if raw != "" {
		if len(raw) >= 7 && strings.EqualFold(raw[:7], "bearer ") {
			raw = strings.TrimSpace(raw[7:])
		}
	}
	if raw == "" {
		raw = strings.TrimSpace(headers.Get("X-Api-Key"))
	}
	if raw == "" {
		raw = strings.TrimSpace(headers.Get("Api-Key"))
	}
	if raw == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

func buildTargetURL(base *url.URL, restPath string, rawQuery string) *url.URL {
	u := *base
	basePath := strings.TrimRight(base.Path, "/")
	if !strings.HasPrefix(restPath, "/") {
		restPath = "/" + restPath
	}
	u.Path = basePath + restPath
	u.RawPath = ""
	if base.RawQuery != "" && rawQuery != "" {
		u.RawQuery = base.RawQuery + "&" + rawQuery
	} else if rawQuery != "" {
		u.RawQuery = rawQuery
	} else {
		u.RawQuery = base.RawQuery
	}
	return &u
}

func copyHeaders(dst, src http.Header) {
	connTokens := map[string]struct{}{}
	for _, v := range src.Values("Connection") {
		for _, tok := range strings.Split(v, ",") {
			tok = strings.ToLower(strings.TrimSpace(tok))
			if tok != "" {
				connTokens[tok] = struct{}{}
			}
		}
	}
	for k, vals := range src {
		lk := strings.ToLower(k)
		if _, skip := hopByHopHeaders[lk]; skip {
			continue
		}
		if _, skip := connTokens[lk]; skip {
			continue
		}
		for _, v := range vals {
			dst.Add(k, v)
		}
	}
}

func DecompressIfGzip(headers http.Header, body []byte) []byte {
	if len(body) == 0 {
		return body
	}
	isGzip := len(body) >= 2 && body[0] == 0x1f && body[1] == 0x8b
	if !isGzip && headers != nil {
		enc := strings.ToLower(strings.TrimSpace(headers.Get("Content-Encoding")))
		isGzip = strings.Contains(enc, "gzip")
	}
	if !isGzip {
		return body
	}
	gr, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		return body
	}
	defer gr.Close()
	out, err := io.ReadAll(gr)
	if err != nil {
		return body
	}
	return out
}
