package storage

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"

	"llm_tracer/internal/proxy"
	"llm_tracer/internal/rawlog"

	_ "modernc.org/sqlite"
)

type Store struct {
	db     *sql.DB
	mu     sync.Mutex
	rawlog *rawlog.Writer
}

type SessionSummary struct {
	SessionID             string `json:"session_id"`
	Harness               string `json:"harness"`
	HarnessVersion        string `json:"-"`
	WorkDir               string `json:"work_dir"`
	Upstream              string `json:"upstream"`
	Model                 string `json:"model"`
	ClientIP              string `json:"client_ip"`
	APIKeyHash            string `json:"api_key_hash"`
	StepCount             int    `json:"step_count"`
	RequestCount          int    `json:"request_count"`
	LLMCallCount          int    `json:"llm_call_count"`
	TrajectoryCount       int    `json:"trajectory_count"`
	StartedAt             string `json:"started_at"`
	UpdatedAt             string `json:"updated_at"`
	TotalPromptTokens     int    `json:"total_prompt_tokens"`
	TotalCompletionTokens int    `json:"total_completion_tokens"`
	TotalCachedTokens     int    `json:"total_cached_tokens"`
}

type RequestRecord struct {
	ID               int64
	SessionID        string
	Seq              int
	Upstream         string
	Method           string
	Path             string
	Query            string
	Protocol         string
	Model            string
	ClientIP         string
	APIKeyHash       string
	IsStream         bool
	StatusCode       int
	StartedAt        string
	CompletedAt      string
	DurationMs       int64
	RequestHeaders   string
	ResponseHeaders  string
	RequestBody      []byte
	ResponseBody     []byte
	ParsedJSON       string
	PromptTokens     int
	CompletionTokens int
	CachedTokens     int
	RawLogFile       string
	RawLogOffset     int64
	RawLogLength     int64
}

type TraceFilter struct {
	Query    string
	Harness  string
	Upstream string
	Limit    int
	Offset   int
}

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)
	s := &Store{db: db}
	if err := s.initSchema(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) SetRawLog(rl *rawlog.Writer) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rawlog = rl
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) initSchema() error {
	stmts := []string{
		`PRAGMA journal_mode=WAL;`,
		`PRAGMA foreign_keys=ON;`,
		`CREATE TABLE IF NOT EXISTS sessions (
			session_id TEXT PRIMARY KEY,
			harness TEXT NOT NULL,
			harness_version TEXT NOT NULL DEFAULT '',
			work_dir TEXT NOT NULL DEFAULT '',
			upstream TEXT NOT NULL DEFAULT '',
			model TEXT NOT NULL DEFAULT '',
			client_ip TEXT NOT NULL DEFAULT '',
			api_key_hash TEXT NOT NULL DEFAULT '',
			started_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			request_count INTEGER NOT NULL DEFAULT 0,
			step_count INTEGER NOT NULL DEFAULT 0,
			trajectory_count INTEGER NOT NULL DEFAULT 1,
			total_prompt_tokens INTEGER NOT NULL DEFAULT 0,
			total_completion_tokens INTEGER NOT NULL DEFAULT 0,
			total_cached_tokens INTEGER NOT NULL DEFAULT 0
		);`,
		`CREATE TABLE IF NOT EXISTS requests (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			seq INTEGER NOT NULL,
			upstream TEXT NOT NULL,
			method TEXT NOT NULL,
			path TEXT NOT NULL,
			query TEXT NOT NULL DEFAULT '',
			protocol TEXT NOT NULL DEFAULT '',
			model TEXT NOT NULL DEFAULT '',
			client_ip TEXT NOT NULL DEFAULT '',
			api_key_hash TEXT NOT NULL DEFAULT '',
			is_stream INTEGER NOT NULL DEFAULT 0,
			status_code INTEGER NOT NULL DEFAULT 0,
			started_at TEXT NOT NULL,
			completed_at TEXT NOT NULL,
			duration_ms INTEGER NOT NULL DEFAULT 0,
			request_headers TEXT NOT NULL DEFAULT '{}',
			response_headers TEXT NOT NULL DEFAULT '{}',
			request_body BLOB,
			response_body BLOB,
			parsed_json TEXT NOT NULL DEFAULT '{}',
			prompt_tokens INTEGER NOT NULL DEFAULT 0,
			completion_tokens INTEGER NOT NULL DEFAULT 0,
			cached_tokens INTEGER NOT NULL DEFAULT 0,
			rawlog_file TEXT NOT NULL DEFAULT '',
			rawlog_offset INTEGER NOT NULL DEFAULT 0,
			rawlog_length INTEGER NOT NULL DEFAULT 0,
			FOREIGN KEY(session_id) REFERENCES sessions(session_id)
		);`,
		`CREATE INDEX IF NOT EXISTS idx_requests_session_seq ON requests(session_id, seq);`,
		`CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);`,
	}
	for _, stmt := range stmts {
		if _, err := s.db.Exec(stmt); err != nil {
			return fmt.Errorf("init schema: %w", err)
		}
	}
	_, _ = s.db.Exec(`ALTER TABLE sessions ADD COLUMN trajectory_count INTEGER NOT NULL DEFAULT 1;`)
	_, _ = s.db.Exec(`ALTER TABLE sessions ADD COLUMN client_ip TEXT NOT NULL DEFAULT '';`)
	_, _ = s.db.Exec(`ALTER TABLE sessions ADD COLUMN api_key_hash TEXT NOT NULL DEFAULT '';`)
	_, _ = s.db.Exec(`ALTER TABLE requests ADD COLUMN client_ip TEXT NOT NULL DEFAULT '';`)
	_, _ = s.db.Exec(`ALTER TABLE requests ADD COLUMN api_key_hash TEXT NOT NULL DEFAULT '';`)
	_, _ = s.db.Exec(`ALTER TABLE requests ADD COLUMN rawlog_file TEXT NOT NULL DEFAULT '';`)
	_, _ = s.db.Exec(`ALTER TABLE requests ADD COLUMN rawlog_offset INTEGER NOT NULL DEFAULT 0;`)
	_, _ = s.db.Exec(`ALTER TABLE requests ADD COLUMN rawlog_length INTEGER NOT NULL DEFAULT 0;`)
	return nil
}

func (s *Store) RecordExchange(sess SessionSummary, rec RequestRecord, stepCount int) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	var existingCount int
	var existingWorkDir, existingModel, existingHarnessVer, existingClientIP, existingAPIKeyHash string
	err = tx.QueryRow(
		`SELECT request_count, work_dir, model, harness_version, client_ip, api_key_hash FROM sessions WHERE session_id = ?`,
		sess.SessionID,
	).Scan(&existingCount, &existingWorkDir, &existingModel, &existingHarnessVer, &existingClientIP, &existingAPIKeyHash)

	if err == sql.ErrNoRows {
		_, err = tx.Exec(
			`INSERT INTO sessions (
				session_id, harness, harness_version, work_dir, upstream, model, client_ip, api_key_hash,
				started_at, updated_at, request_count, step_count,
				total_prompt_tokens, total_completion_tokens, total_cached_tokens
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
			sess.SessionID, sess.Harness, sess.HarnessVersion, sess.WorkDir, sess.Upstream, sess.Model, sess.ClientIP, sess.APIKeyHash,
			sess.StartedAt, sess.UpdatedAt, stepCount,
			rec.PromptTokens, rec.CompletionTokens, rec.CachedTokens,
		)
		if err != nil {
			return err
		}
		rec.Seq = 1
	} else if err != nil {
		return err
	} else {
		workDir := existingWorkDir
		if sess.WorkDir != "" {
			workDir = sess.WorkDir
		}
		model := existingModel
		if sess.Model != "" {
			model = sess.Model
		}
		hVer := existingHarnessVer
		if sess.HarnessVersion != "" {
			hVer = sess.HarnessVersion
		}
		clientIP := existingClientIP
		if sess.ClientIP != "" {
			clientIP = sess.ClientIP
		}
		apiKeyHash := existingAPIKeyHash
		if sess.APIKeyHash != "" {
			apiKeyHash = sess.APIKeyHash
		}
		rec.Seq = existingCount + 1
		_, err = tx.Exec(
			`UPDATE sessions SET
				harness_version = ?,
				work_dir = ?,
				model = ?,
				client_ip = ?,
				api_key_hash = ?,
				updated_at = ?,
				request_count = request_count + 1,
				step_count = CASE WHEN ? > step_count THEN ? ELSE step_count END,
				total_prompt_tokens = total_prompt_tokens + ?,
				total_completion_tokens = total_completion_tokens + ?,
				total_cached_tokens = total_cached_tokens + ?
			WHERE session_id = ?`,
			hVer, workDir, model, clientIP, apiKeyHash, sess.UpdatedAt,
			stepCount, stepCount,
			rec.PromptTokens, rec.CompletionTokens, rec.CachedTokens,
			sess.SessionID,
		)
		if err != nil {
			return err
		}
	}

	isStreamInt := 0
	if rec.IsStream {
		isStreamInt = 1
	}

	reqBody := rec.RequestBody
	respBody := rec.ResponseBody
	parsedJSON := rec.ParsedJSON
	if rec.RawLogFile != "" {
		reqBody = nil
		respBody = nil
		parsedJSON = ""
	}

	_, err = tx.Exec(
		`INSERT INTO requests (
			session_id, seq, upstream, method, path, query, protocol, model, client_ip, api_key_hash,
			is_stream, status_code, started_at, completed_at, duration_ms,
			request_headers, response_headers, request_body, response_body,
			parsed_json, prompt_tokens, completion_tokens, cached_tokens,
			rawlog_file, rawlog_offset, rawlog_length
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		rec.SessionID, rec.Seq, rec.Upstream, rec.Method, rec.Path, rec.Query, rec.Protocol, rec.Model, rec.ClientIP, rec.APIKeyHash,
		isStreamInt, rec.StatusCode, rec.StartedAt, rec.CompletedAt, rec.DurationMs,
		rec.RequestHeaders, rec.ResponseHeaders, reqBody, respBody,
		parsedJSON, rec.PromptTokens, rec.CompletionTokens, rec.CachedTokens,
		rec.RawLogFile, rec.RawLogOffset, rec.RawLogLength,
	)
	if err != nil {
		return err
	}

	err = tx.Commit()
	return err
}

func (s *Store) UpdateSessionCounts(sessionID string, stepCount, trajectoryCount int) error {
	if trajectoryCount < 1 {
		trajectoryCount = 1
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(`UPDATE sessions SET step_count = ?, trajectory_count = ? WHERE session_id = ?`, stepCount, trajectoryCount, sessionID)
	return err
}

func (s *Store) UpdateSessionMetadata(sessionID, workDir string, stepCount, trajectoryCount int) error {
	if trajectoryCount < 1 {
		trajectoryCount = 1
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`UPDATE sessions SET work_dir = CASE WHEN work_dir = '' THEN ? ELSE work_dir END, step_count = ?, trajectory_count = ? WHERE session_id = ?`,
		workDir, stepCount, trajectoryCount, sessionID,
	)
	return err
}

func (s *Store) ListSessions(f TraceFilter) ([]SessionSummary, int, error) {
	var conds []string
	var args []any

	if q := strings.TrimSpace(f.Query); q != "" {
		like := "%" + q + "%"
		conds = append(conds, `(session_id LIKE ? OR work_dir LIKE ? OR model LIKE ? OR harness LIKE ? OR upstream LIKE ? OR client_ip LIKE ? OR api_key_hash LIKE ?)`)
		args = append(args, like, like, like, like, like, like, like)
	}
	if h := strings.TrimSpace(f.Harness); h != "" {
		conds = append(conds, `harness = ?`)
		args = append(args, h)
	}
	if u := strings.TrimSpace(f.Upstream); u != "" {
		conds = append(conds, `upstream = ?`)
		args = append(args, u)
	}

	where := ""
	if len(conds) > 0 {
		where = " WHERE " + strings.Join(conds, " AND ")
	}

	var total int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM sessions"+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	limit := f.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	offset := f.Offset
	if offset < 0 {
		offset = 0
	}

	query := `SELECT session_id, harness, harness_version, work_dir, upstream, model, client_ip, api_key_hash,
		step_count, request_count, trajectory_count, started_at, updated_at,
		total_prompt_tokens, total_completion_tokens, total_cached_tokens
		FROM sessions` + where + ` ORDER BY updated_at DESC LIMIT ? OFFSET ?`
	queryArgs := append(append([]any{}, args...), limit, offset)

	rows, err := s.db.Query(query, queryArgs...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	out := make([]SessionSummary, 0)
	for rows.Next() {
		var item SessionSummary
		if err := rows.Scan(
			&item.SessionID, &item.Harness, &item.HarnessVersion, &item.WorkDir, &item.Upstream, &item.Model, &item.ClientIP, &item.APIKeyHash,
			&item.StepCount, &item.RequestCount, &item.TrajectoryCount, &item.StartedAt, &item.UpdatedAt,
			&item.TotalPromptTokens, &item.TotalCompletionTokens, &item.TotalCachedTokens,
		); err != nil {
			return nil, 0, err
		}
		if item.TrajectoryCount < 1 {
			item.TrajectoryCount = 1
		}
		item.LLMCallCount = item.RequestCount
		out = append(out, item)
	}
	return out, total, rows.Err()
}

func (s *Store) GetSession(sessionID string) (*SessionSummary, error) {
	var item SessionSummary
	err := s.db.QueryRow(
		`SELECT session_id, harness, harness_version, work_dir, upstream, model, client_ip, api_key_hash,
		step_count, request_count, trajectory_count, started_at, updated_at,
		total_prompt_tokens, total_completion_tokens, total_cached_tokens
		FROM sessions WHERE session_id = ?`,
		sessionID,
	).Scan(
		&item.SessionID, &item.Harness, &item.HarnessVersion, &item.WorkDir, &item.Upstream, &item.Model, &item.ClientIP, &item.APIKeyHash,
		&item.StepCount, &item.RequestCount, &item.TrajectoryCount, &item.StartedAt, &item.UpdatedAt,
		&item.TotalPromptTokens, &item.TotalCompletionTokens, &item.TotalCachedTokens,
	)
	if err != nil {
		return nil, err
	}
	if item.TrajectoryCount < 1 {
		item.TrajectoryCount = 1
	}
	item.LLMCallCount = item.RequestCount
	return &item, nil
}

func (s *Store) GetSessionRequests(sessionID string) ([]RequestRecord, error) {
	rows, err := s.db.Query(
		`SELECT id, session_id, seq, upstream, method, path, query, protocol, model, client_ip, api_key_hash,
		is_stream, status_code, started_at, completed_at, duration_ms,
		request_headers, response_headers, request_body, response_body,
		parsed_json, prompt_tokens, completion_tokens, cached_tokens,
		rawlog_file, rawlog_offset, rawlog_length
		FROM requests WHERE session_id = ? ORDER BY started_at ASC, id ASC`,
		sessionID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]RequestRecord, 0)
	refs := make([]rawlog.Ref, 0)
	for rows.Next() {
		var r RequestRecord
		var isStreamInt int
		if err := rows.Scan(
			&r.ID, &r.SessionID, &r.Seq, &r.Upstream, &r.Method, &r.Path, &r.Query, &r.Protocol, &r.Model, &r.ClientIP, &r.APIKeyHash,
			&isStreamInt, &r.StatusCode, &r.StartedAt, &r.CompletedAt, &r.DurationMs,
			&r.RequestHeaders, &r.ResponseHeaders, &r.RequestBody, &r.ResponseBody,
			&r.ParsedJSON, &r.PromptTokens, &r.CompletionTokens, &r.CachedTokens,
			&r.RawLogFile, &r.RawLogOffset, &r.RawLogLength,
		); err != nil {
			return nil, err
		}
		r.IsStream = isStreamInt != 0
		if r.RawLogFile != "" && r.RawLogLength > 0 {
			refs = append(refs, rawlog.Ref{
				ID:     r.ID,
				File:   r.RawLogFile,
				Offset: r.RawLogOffset,
				Length: r.RawLogLength,
			})
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	if len(refs) > 0 && s.rawlog != nil {
		entries, _ := s.rawlog.ReadBatch(refs)
		for i := range out {
			if entry, ok := entries[out[i].ID]; ok && entry != nil {
				hydrateRecordFromRawLog(&out[i], entry)
			}
		}
	}

	return out, nil
}

func (s *Store) GetRequestByID(id int64) (*RequestRecord, error) {
	var r RequestRecord
	var isStreamInt int
	err := s.db.QueryRow(
		`SELECT id, session_id, seq, upstream, method, path, query, protocol, model, client_ip, api_key_hash,
		is_stream, status_code, started_at, completed_at, duration_ms,
		request_headers, response_headers, request_body, response_body,
		parsed_json, prompt_tokens, completion_tokens, cached_tokens,
		rawlog_file, rawlog_offset, rawlog_length
		FROM requests WHERE id = ?`,
		id,
	).Scan(
		&r.ID, &r.SessionID, &r.Seq, &r.Upstream, &r.Method, &r.Path, &r.Query, &r.Protocol, &r.Model, &r.ClientIP, &r.APIKeyHash,
		&isStreamInt, &r.StatusCode, &r.StartedAt, &r.CompletedAt, &r.DurationMs,
		&r.RequestHeaders, &r.ResponseHeaders, &r.RequestBody, &r.ResponseBody,
		&r.ParsedJSON, &r.PromptTokens, &r.CompletionTokens, &r.CachedTokens,
		&r.RawLogFile, &r.RawLogOffset, &r.RawLogLength,
	)
	if err != nil {
		return nil, err
	}
	r.IsStream = isStreamInt != 0
	if r.RawLogFile != "" && r.RawLogLength > 0 && s.rawlog != nil {
		if entry, rErr := s.rawlog.ReadAt(r.RawLogFile, r.RawLogOffset, r.RawLogLength); rErr == nil && entry != nil {
			hydrateRecordFromRawLog(&r, entry)
		}
	}
	return &r, nil
}

func (s *Store) MigrateInlineBodiesToRawLog(rl *rawlog.Writer) (int, error) {
	if rl == nil {
		return 0, fmt.Errorf("rawlog writer is nil")
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	rows, err := s.db.Query(
		`SELECT r.id, r.session_id, r.upstream, r.method, r.path, r.query,
			r.client_ip, r.api_key_hash, r.status_code, r.started_at, r.duration_ms,
			r.request_headers, r.response_headers, r.request_body, r.response_body, r.parsed_json,
			COALESCE(s.harness, ''), COALESCE(s.harness_version, ''), COALESCE(s.work_dir, '')
		FROM requests r
		LEFT JOIN sessions s ON s.session_id = r.session_id
		WHERE r.rawlog_file = '' AND (
			length(COALESCE(r.request_body, '')) > 0 OR
			length(COALESCE(r.response_body, '')) > 0 OR
			(r.parsed_json != '' AND r.parsed_json != '{}')
		)
		ORDER BY r.id ASC`,
	)
	if err != nil {
		return 0, err
	}

	type migrationRow struct {
		id              int64
		sessionID       string
		upstream        string
		method          string
		path            string
		query           string
		clientIP        string
		apiKeyHash      string
		statusCode      int
		startedAt       string
		durationMs      int64
		requestHeaders  string
		responseHeaders string
		requestBody     []byte
		responseBody    []byte
		parsedJSON      string
		harness         string
		harnessVersion  string
		workDir         string
	}

	pending := make([]migrationRow, 0)
	for rows.Next() {
		var mr migrationRow
		if err := rows.Scan(
			&mr.id, &mr.sessionID, &mr.upstream, &mr.method, &mr.path, &mr.query,
			&mr.clientIP, &mr.apiKeyHash, &mr.statusCode, &mr.startedAt, &mr.durationMs,
			&mr.requestHeaders, &mr.responseHeaders, &mr.requestBody, &mr.responseBody, &mr.parsedJSON,
			&mr.harness, &mr.harnessVersion, &mr.workDir,
		); err != nil {
			_ = rows.Close()
			return 0, err
		}
		pending = append(pending, mr)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return 0, err
	}
	_ = rows.Close()

	if len(pending) == 0 {
		return 0, nil
	}

	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	migrated := 0
	for _, mr := range pending {
		reqHdrs := parseHeadersMap(mr.requestHeaders)
		respHdrs := parseHeadersMap(mr.responseHeaders)
		reqPlain := proxy.DecompressIfGzip(reqHdrs, mr.requestBody)
		respPlain := proxy.DecompressIfGzip(respHdrs, mr.responseBody)

		var meta map[string]any
		if mr.parsedJSON != "" && mr.parsedJSON != "{}" {
			var parsed proxy.ParsedExchange
			if uErr := json.Unmarshal([]byte(mr.parsedJSON), &parsed); uErr == nil && len(parsed.Metadata) > 0 {
				meta = parsed.Metadata
			}
		}

		relFile, offset, length, aErr := rl.Append(rawlog.Entry{
			Timestamp:       mr.startedAt,
			SessionID:       mr.sessionID,
			Harness:         mr.harness,
			HarnessVersion:  mr.harnessVersion,
			Upstream:        mr.upstream,
			Method:          mr.method,
			Path:            mr.path,
			Query:           mr.query,
			ClientIP:        mr.clientIP,
			APIKeyHash:      mr.apiKeyHash,
			RequestHeaders:  reqHdrs,
			RequestBody:     string(reqPlain),
			StatusCode:      mr.statusCode,
			ResponseHeaders: respHdrs,
			ResponseBody:    string(respPlain),
			LatencyMs:       mr.durationMs,
			WorkDir:         mr.workDir,
			Metadata:        meta,
		})
		if aErr != nil {
			err = aErr
			return migrated, err
		}

		if _, err = tx.Exec(
			`UPDATE requests SET rawlog_file = ?, rawlog_offset = ?, rawlog_length = ?, request_body = NULL, response_body = NULL, parsed_json = '' WHERE id = ?`,
			relFile, offset, length, mr.id,
		); err != nil {
			return migrated, err
		}
		migrated++
	}

	if err = tx.Commit(); err != nil {
		return 0, err
	}

	_, _ = s.db.Exec(`PRAGMA wal_checkpoint(TRUNCATE);`)
	if _, vErr := s.db.Exec(`VACUUM;`); vErr != nil {
		return migrated, vErr
	}
	_, _ = s.db.Exec(`PRAGMA wal_checkpoint(TRUNCATE);`)

	return migrated, nil
}

func hydrateRecordFromRawLog(rec *RequestRecord, entry *rawlog.Entry) {
	rec.RequestBody = []byte(entry.RequestBody)
	rec.ResponseBody = []byte(entry.ResponseBody)

	if (rec.RequestHeaders == "" || rec.RequestHeaders == "{}") && len(entry.RequestHeaders) > 0 {
		rec.RequestHeaders = SanitizeHeadersJSON(entry.RequestHeaders)
	}
	if (rec.ResponseHeaders == "" || rec.ResponseHeaders == "{}") && len(entry.ResponseHeaders) > 0 {
		rec.ResponseHeaders = SanitizeHeadersJSON(entry.ResponseHeaders)
	}

	if rec.ParsedJSON == "" || rec.ParsedJSON == "{}" {
		reqHdrs := entry.RequestHeaders
		if len(reqHdrs) == 0 {
			reqHdrs = parseHeadersMap(rec.RequestHeaders)
		}
		respHdrs := entry.ResponseHeaders
		if len(respHdrs) == 0 {
			respHdrs = parseHeadersMap(rec.ResponseHeaders)
		}
		parsed := proxy.ParseExchange(rec.Path, reqHdrs, rec.RequestBody, respHdrs, rec.ResponseBody)
		if rec.ClientIP != "" {
			parsed.ClientIP = rec.ClientIP
		} else if entry.ClientIP != "" {
			parsed.ClientIP = entry.ClientIP
		}
		if rec.APIKeyHash != "" {
			parsed.APIKeyHash = rec.APIKeyHash
		} else if entry.APIKeyHash != "" {
			parsed.APIKeyHash = entry.APIKeyHash
		} else if hasRedactedAuth(reqHdrs) {
			parsed.APIKeyHash = ""
		}
		if len(entry.Metadata) > 0 {
			if parsed.Metadata == nil {
				parsed.Metadata = map[string]any{}
			}
			for k, v := range entry.Metadata {
				parsed.Metadata[k] = v
			}
		}
		if b, err := json.Marshal(parsed); err == nil {
			rec.ParsedJSON = string(b)
		}
	}
}

func parseHeadersMap(raw string) http.Header {
	out := http.Header{}
	if strings.TrimSpace(raw) == "" {
		return out
	}
	var multi map[string][]string
	if err := json.Unmarshal([]byte(raw), &multi); err == nil && len(multi) > 0 {
		for k, vals := range multi {
			for _, v := range vals {
				out.Add(k, v)
			}
		}
		return out
	}
	var single map[string]string
	if err := json.Unmarshal([]byte(raw), &single); err == nil {
		for k, v := range single {
			out.Set(k, v)
		}
	}
	return out
}

func hasRedactedAuth(h http.Header) bool {
	for k, vals := range h {
		lk := strings.ToLower(k)
		if lk == "authorization" || lk == "x-api-key" || lk == "api-key" {
			for _, v := range vals {
				if strings.TrimSpace(v) == "[REDACTED]" {
					return true
				}
			}
		}
	}
	return false
}

func SanitizeHeadersJSON(h http.Header) string {
	m := make(map[string]string, len(h))
	for k, vals := range h {
		lk := strings.ToLower(k)
		if lk == "authorization" || lk == "x-api-key" || lk == "api-key" || lk == "proxy-authorization" || lk == "cookie" {
			m[k] = "[REDACTED]"
			continue
		}
		m[k] = strings.Join(vals, ", ")
	}
	b, err := json.Marshal(m)
	if err != nil {
		return "{}"
	}
	return string(b)
}
