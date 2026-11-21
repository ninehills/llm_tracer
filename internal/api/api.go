package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"path"
	"strconv"
	"strings"

	"llm_tracer/internal/atif"
	"llm_tracer/internal/config"
	"llm_tracer/internal/proxy"
	"llm_tracer/internal/storage"
)

const sessionCookieName = "llm_tracer_session"

type Server struct {
	cfg       *config.Config
	store     *storage.Store
	webDistFS fs.FS
}

func NewServer(cfg *config.Config, store *storage.Store, webDistFS fs.FS) *Server {
	return &Server{
		cfg:       cfg,
		store:     store,
		webDistFS: webDistFS,
	}
}

func (s *Server) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/auth/status", s.handleAuthStatus)
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)

	mux.Handle("GET /api/traces", s.requireAuth(http.HandlerFunc(s.handleListTraces)))
	mux.Handle("POST /api/traces/export", s.requireAuth(http.HandlerFunc(s.handleExportTraces)))
	mux.Handle("GET /api/traces/{session_id}/trajectories", s.requireAuth(http.HandlerFunc(s.handleGetTraceTrajectories)))
	mux.Handle("GET /api/traces/{session_id}", s.requireAuth(http.HandlerFunc(s.handleGetTrace)))
	mux.Handle("GET /api/requests/{id}", s.requireAuth(http.HandlerFunc(s.handleGetRequest)))

	mux.HandleFunc("GET /dashboard", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/dashboard/", http.StatusMovedPermanently)
	})
	mux.HandleFunc("GET /dashboard/", s.handleDashboard)
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/dashboard/", http.StatusFound)
	})
}

func (s *Server) authToken() string {
	mac := hmac.New(sha256.New, []byte(s.cfg.DashboardKey))
	mac.Write([]byte("llm_tracer_dashboard_auth_v1"))
	return hex.EncodeToString(mac.Sum(nil))
}

func (s *Server) isAuthenticated(r *http.Request) bool {
	if s.cfg.DashboardKey == "" {
		return true
	}
	if c, err := r.Cookie(sessionCookieName); err == nil {
		if subtle.ConstantTimeCompare([]byte(c.Value), []byte(s.authToken())) == 1 {
			return true
		}
	}
	if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
		key := strings.TrimPrefix(auth, "Bearer ")
		if subtle.ConstantTimeCompare([]byte(key), []byte(s.cfg.DashboardKey)) == 1 {
			return true
		}
	}
	if key := r.Header.Get("X-Dashboard-Key"); key != "" {
		if subtle.ConstantTimeCompare([]byte(key), []byte(s.cfg.DashboardKey)) == 1 {
			return true
		}
	}
	return false
}

func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.isAuthenticated(r) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	authRequired := s.cfg.DashboardKey != ""
	isLocal := s.cfg.IsLocalhost()
	writeJSON(w, http.StatusOK, map[string]any{
		"auth_required":            authRequired,
		"authenticated":            s.isAuthenticated(r),
		"is_localhost":             isLocal,
		"insecure_no_auth_warning": !authRequired && !isLocal,
	})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if s.cfg.DashboardKey == "" {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return
	}
	var body struct {
		Key string `json:"key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid request body"})
		return
	}
	if subtle.ConstantTimeCompare([]byte(body.Key), []byte(s.cfg.DashboardKey)) != 1 {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid key"})
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    s.authToken(),
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleLogout(w http.ResponseWriter, _ *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleListTraces(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	offset, _ := strconv.Atoi(q.Get("offset"))

	traces, total, err := s.store.ListSessions(storage.TraceFilter{
		Query:    q.Get("q"),
		Harness:  q.Get("harness"),
		Upstream: q.Get("upstream"),
		Limit:    limit,
		Offset:   offset,
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"traces": traces,
		"total":  total,
	})
}

func (s *Server) handleGetTrace(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("session_id")
	if sessionID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing session_id"})
		return
	}
	sess, err := s.store.GetSession(sessionID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "trace not found"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	reqs, err := s.store.GetSessionRequests(sessionID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	trajs := atif.BuildTrajectories(sess, reqs)
	trajID := strings.TrimSpace(r.URL.Query().Get("trajectory_id"))
	if trajID == "" {
		writeJSON(w, http.StatusOK, trajs[0])
		return
	}
	for _, t := range trajs {
		if t.TrajectoryID == trajID {
			writeJSON(w, http.StatusOK, t)
			return
		}
	}
	writeJSON(w, http.StatusNotFound, map[string]any{"error": "trajectory not found"})
}

func (s *Server) handleGetTraceTrajectories(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("session_id")
	if sessionID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "missing session_id"})
		return
	}
	sess, err := s.store.GetSession(sessionID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "trace not found"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	reqs, err := s.store.GetSessionRequests(sessionID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	trajs := atif.BuildTrajectories(sess, reqs)
	writeJSON(w, http.StatusOK, map[string]any{
		"session_id":     sessionID,
		"llm_call_count": len(reqs),
		"trajectories":   trajs,
	})
}

func (s *Server) handleGetRequest(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid request id"})
		return
	}
	rec, err := s.store.GetRequestByID(id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "request not found"})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}

	reqHeaders := parseStoredHeaders(rec.RequestHeaders)
	respHeaders := parseStoredHeaders(rec.ResponseHeaders)

	reqBody := proxy.DecompressIfGzip(http.Header(reqHeaders), rec.RequestBody)
	respBody := proxy.DecompressIfGzip(http.Header(respHeaders), rec.ResponseBody)

	var parsed proxy.ParsedExchange
	if rec.ParsedJSON != "" {
		_ = json.Unmarshal([]byte(rec.ParsedJSON), &parsed)
	}

	isSSE := strings.Contains(strings.ToLower(http.Header(respHeaders).Get("Content-Type")), "text/event-stream") || proxy.LooksLikeSSE(respBody)

	var sseEvents []proxy.SSEEvent
	var mergedResp map[string]any
	if isSSE {
		sseEvents = proxy.ParseSSEEvents(respBody)
		mergedResp = proxy.BuildMergedSSEResponse(respBody, respHeaders)
	}

	requestedModel := parsed.RequestedModel
	if requestedModel == "" && len(reqBody) > 0 {
		requestedModel = proxy.ExtractRequestModel(http.Header(reqHeaders), reqBody)
	}

	responseModel := parsed.ResponseModel
	responseID := parsed.ResponseID
	finishReason := parsed.FinishReason
	if responseModel == "" || responseID == "" || finishReason == "" {
		rm := proxy.ExtractResponseMetadata(http.Header(respHeaders), respBody)
		if responseModel == "" {
			responseModel = rm.ResponseModel
		}
		if responseID == "" {
			responseID = rm.ResponseID
		}
		if finishReason == "" {
			finishReason = rm.FinishReason
		}
	}

	clientIP := rec.ClientIP
	if clientIP == "" {
		clientIP = parsed.ClientIP
	}
	apiKeyHash := rec.APIKeyHash
	if apiKeyHash == "" {
		apiKeyHash = parsed.APIKeyHash
	}

	payload := map[string]any{
		"id":               rec.ID,
		"session_id":       rec.SessionID,
		"upstream":         rec.Upstream,
		"method":           rec.Method,
		"path":             rec.Path,
		"query":            rec.Query,
		"client_ip":        clientIP,
		"api_key_hash":     apiKeyHash,
		"status_code":      rec.StatusCode,
		"latency_ms":       rec.DurationMs,
		"started_at":       rec.StartedAt,
		"ended_at":         rec.CompletedAt,
		"request_headers":  reqHeaders,
		"request_body":     string(reqBody),
		"response_headers": respHeaders,
		"response_body":    string(respBody),
		"is_sse":           isSSE,
		"response_model":   responseModel,
		"response_id":      responseID,
		"finish_reason":    finishReason,
	}
	if requestedModel != "" {
		payload["requested_model"] = requestedModel
	}
	if isSSE {
		payload["sse_events"] = sseEvents
		if mergedResp != nil {
			payload["merged_response"] = mergedResp
		}
	}
	if len(parsed.Metadata) > 0 {
		payload["metadata"] = parsed.Metadata
	}

	writeJSON(w, http.StatusOK, payload)
}

func parseStoredHeaders(raw string) map[string][]string {
	out := map[string][]string{}
	if strings.TrimSpace(raw) == "" {
		return out
	}
	var multi map[string][]string
	if err := json.Unmarshal([]byte(raw), &multi); err == nil && len(multi) > 0 {
		return multi
	}
	var single map[string]string
	if err := json.Unmarshal([]byte(raw), &single); err == nil {
		for k, v := range single {
			out[k] = []string{v}
		}
	}
	return out
}

func (s *Server) handleExportTraces(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SessionIDs []string `json:"session_ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid request body"})
		return
	}
	if len(body.SessionIDs) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "session_ids is required"})
		return
	}

	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Content-Disposition", `attachment; filename="traces.jsonl"`)
	w.WriteHeader(http.StatusOK)

	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	for _, sid := range body.SessionIDs {
		sess, err := s.store.GetSession(sid)
		if err != nil {
			continue
		}
		reqs, err := s.store.GetSessionRequests(sid)
		if err != nil {
			continue
		}
		trajs := atif.BuildTrajectories(sess, reqs)
		for _, traj := range trajs {
			_ = enc.Encode(traj)
		}
	}
}

func (s *Server) handleDashboard(w http.ResponseWriter, r *http.Request) {
	rel := strings.TrimPrefix(r.URL.Path, "/dashboard/")
	rel = strings.TrimPrefix(path.Clean("/"+rel), "/")
	if rel == "" {
		rel = "index.html"
	}

	if f, err := s.webDistFS.Open(rel); err == nil {
		stat, statErr := f.Stat()
		_ = f.Close()
		if statErr == nil && !stat.IsDir() {
			http.StripPrefix("/dashboard/", http.FileServer(http.FS(s.webDistFS))).ServeHTTP(w, r)
			return
		}
	}

	indexBytes, err := fs.ReadFile(s.webDistFS, "index.html")
	if err != nil {
		http.Error(w, "dashboard not built", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(indexBytes)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}
