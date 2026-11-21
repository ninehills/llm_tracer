package rawlog

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type Entry struct {
	Timestamp       string         `json:"timestamp"`
	SessionID       string         `json:"session_id"`
	Harness         string         `json:"harness"`
	HarnessVersion  string         `json:"harness_version"`
	Upstream        string         `json:"upstream"`
	Method          string         `json:"method"`
	Path            string         `json:"path"`
	Query           string         `json:"query"`
	ClientIP        string         `json:"client_ip"`
	APIKeyHash      string         `json:"api_key_hash"`
	RequestHeaders  http.Header    `json:"request_headers"`
	RequestBody     string         `json:"request_body"`
	StatusCode      int            `json:"status_code"`
	ResponseHeaders http.Header    `json:"response_headers"`
	ResponseBody    string         `json:"response_body"`
	LatencyMs       int64          `json:"latency_ms"`
	WorkDir         string         `json:"work_dir"`
	Metadata        map[string]any `json:"metadata,omitempty"`
}

type Writer struct {
	dir string
	mu  sync.Mutex
}

func NewWriter(dir string) (*Writer, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create raw log dir: %w", err)
	}
	return &Writer{dir: dir}, nil
}

func (w *Writer) Append(entry Entry) error {
	if w == nil {
		return nil
	}
	now := time.Now()
	if entry.Timestamp == "" {
		entry.Timestamp = now.UTC().Format(time.RFC3339Nano)
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(entry); err != nil {
		return fmt.Errorf("encode raw log entry: %w", err)
	}

	filePath := filepath.Join(w.dir, fmt.Sprintf("requests-%s.jsonl", now.Format("2006-01-02")))

	w.mu.Lock()
	defer w.mu.Unlock()

	if err := os.MkdirAll(w.dir, 0o755); err != nil {
		return fmt.Errorf("ensure raw log dir: %w", err)
	}
	f, err := os.OpenFile(filePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return fmt.Errorf("open raw log file: %w", err)
	}
	_, writeErr := f.Write(buf.Bytes())
	closeErr := f.Close()
	if writeErr != nil {
		return fmt.Errorf("write raw log entry: %w", writeErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close raw log file: %w", closeErr)
	}
	return nil
}
