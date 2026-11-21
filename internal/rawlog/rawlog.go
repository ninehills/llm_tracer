package rawlog

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/klauspost/compress/zstd"
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

type Ref struct {
	ID     int64
	File   string
	Offset int64
	Length int64
}

type Writer struct {
	dir     string
	mu      sync.Mutex
	encoder *zstd.Encoder
	decoder *zstd.Decoder
}

func NewWriter(dir string) (*Writer, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create raw log dir: %w", err)
	}
	enc, err := zstd.NewWriter(nil)
	if err != nil {
		return nil, fmt.Errorf("create zstd encoder: %w", err)
	}
	dec, err := zstd.NewReader(nil)
	if err != nil {
		_ = enc.Close()
		return nil, fmt.Errorf("create zstd decoder: %w", err)
	}
	return &Writer{
		dir:     dir,
		encoder: enc,
		decoder: dec,
	}, nil
}

func (w *Writer) Close() error {
	if w == nil {
		return nil
	}
	var err error
	if w.encoder != nil {
		err = w.encoder.Close()
	}
	if w.decoder != nil {
		w.decoder.Close()
	}
	return err
}

func dateFromTimestamp(ts string) string {
	if ts != "" {
		if t, err := time.Parse(time.RFC3339Nano, ts); err == nil {
			return t.UTC().Format("2006-01-02")
		}
		if t, err := time.Parse(time.RFC3339, ts); err == nil {
			return t.UTC().Format("2006-01-02")
		}
	}
	return time.Now().UTC().Format("2006-01-02")
}

func (w *Writer) Append(entry Entry) (string, int64, int64, error) {
	if w == nil {
		return "", 0, 0, nil
	}
	if entry.Timestamp == "" {
		entry.Timestamp = time.Now().UTC().Format(time.RFC3339Nano)
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(entry); err != nil {
		return "", 0, 0, fmt.Errorf("encode raw log entry: %w", err)
	}
	frame := w.encoder.EncodeAll(buf.Bytes(), make([]byte, 0, buf.Len()))

	dateStr := dateFromTimestamp(entry.Timestamp)
	relFile := fmt.Sprintf("requests-%s.jsonl.zst", dateStr)
	filePath := filepath.Join(w.dir, relFile)

	w.mu.Lock()
	defer w.mu.Unlock()

	if err := os.MkdirAll(w.dir, 0o755); err != nil {
		return "", 0, 0, fmt.Errorf("ensure raw log dir: %w", err)
	}
	f, err := os.OpenFile(filePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return "", 0, 0, fmt.Errorf("open raw log file: %w", err)
	}
	fi, statErr := f.Stat()
	if statErr != nil {
		_ = f.Close()
		return "", 0, 0, fmt.Errorf("stat raw log file: %w", statErr)
	}
	offset := fi.Size()
	n, writeErr := f.Write(frame)
	closeErr := f.Close()
	if writeErr != nil {
		return "", 0, 0, fmt.Errorf("write raw log entry: %w", writeErr)
	}
	if closeErr != nil {
		return "", 0, 0, fmt.Errorf("close raw log file: %w", closeErr)
	}
	return relFile, offset, int64(n), nil
}

func (w *Writer) decodeRecord(relFile string, raw []byte) (*Entry, error) {
	payload := raw
	if strings.HasSuffix(relFile, ".zst") {
		var err error
		payload, err = w.decoder.DecodeAll(raw, nil)
		if err != nil {
			return nil, err
		}
	}
	var entry Entry
	if err := json.Unmarshal(payload, &entry); err != nil {
		return nil, err
	}
	return &entry, nil
}

func (w *Writer) ReadAt(relFile string, offset int64, length int64) (*Entry, error) {
	if w == nil {
		return nil, fmt.Errorf("rawlog writer is nil")
	}
	if relFile == "" || offset < 0 || length <= 0 {
		return nil, fmt.Errorf("invalid rawlog reference")
	}
	base := filepath.Base(relFile)
	fullPath := filepath.Join(w.dir, base)

	f, err := os.Open(fullPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	buf := make([]byte, length)
	n, readErr := f.ReadAt(buf, offset)
	if readErr != nil && !(readErr == io.EOF && int64(n) == length) {
		return nil, readErr
	}
	return w.decodeRecord(base, buf[:n])
}

func (w *Writer) ReadBatch(refs []Ref) (map[int64]*Entry, error) {
	out := make(map[int64]*Entry, len(refs))
	if w == nil || len(refs) == 0 {
		return out, nil
	}

	grouped := make(map[string][]Ref)
	for _, ref := range refs {
		if ref.File == "" || ref.Offset < 0 || ref.Length <= 0 {
			continue
		}
		base := filepath.Base(ref.File)
		grouped[base] = append(grouped[base], ref)
	}

	var firstErr error
	for relFile, group := range grouped {
		fullPath := filepath.Join(w.dir, relFile)
		f, err := os.Open(fullPath)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		for _, ref := range group {
			buf := make([]byte, ref.Length)
			n, readErr := f.ReadAt(buf, ref.Offset)
			if readErr != nil && !(readErr == io.EOF && int64(n) == ref.Length) {
				if firstErr == nil {
					firstErr = readErr
				}
				continue
			}
			entry, dErr := w.decodeRecord(relFile, buf[:n])
			if dErr != nil {
				if firstErr == nil {
					firstErr = dErr
				}
				continue
			}
			out[ref.ID] = entry
		}
		_ = f.Close()
	}
	return out, firstErr
}

func DumpToWriter(path string, dst io.Writer) error {
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open raw log file: %w", err)
	}
	defer f.Close()

	if strings.HasSuffix(path, ".zst") {
		zr, err := zstd.NewReader(f)
		if err != nil {
			return fmt.Errorf("open zstd reader: %w", err)
		}
		defer zr.Close()
		if _, err := io.Copy(dst, zr); err != nil {
			return fmt.Errorf("decompress raw log: %w", err)
		}
		return nil
	}

	if _, err := io.Copy(dst, f); err != nil {
		return fmt.Errorf("copy raw log: %w", err)
	}
	return nil
}
