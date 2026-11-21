package main

import (
	"embed"
	"encoding/json"
	"flag"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"time"

	"llm_tracer/internal/api"
	"llm_tracer/internal/atif"
	"llm_tracer/internal/config"
	"llm_tracer/internal/harness"
	"llm_tracer/internal/proxy"
	"llm_tracer/internal/rawlog"
	"llm_tracer/internal/storage"
)

//go:embed all:web/dist
var embeddedWeb embed.FS

func main() {
	configPath := flag.String("config", "config.toml", "path to TOML config file")
	migrateOnly := flag.Bool("migrate", false, "migrate inline sqlite bodies to raw_logs and exit")
	dumpPath := flag.String("dump", "", "dump a raw log (.jsonl.zst or .jsonl) file to plain JSONL")
	outPath := flag.String("out", "", "output file path for -dump (defaults to stdout)")
	flag.Parse()

	if *dumpPath != "" {
		var dst io.Writer = os.Stdout
		var outFile *os.File
		if *outPath != "" {
			f, err := os.OpenFile(*outPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
			if err != nil {
				log.Fatalf("failed to create output file: %v", err)
			}
			outFile = f
			dst = f
		}
		if err := rawlog.DumpToWriter(*dumpPath, dst); err != nil {
			if outFile != nil {
				_ = outFile.Close()
			}
			log.Fatalf("failed to dump raw log: %v", err)
		}
		if outFile != nil {
			if err := outFile.Close(); err != nil {
				log.Fatalf("failed to close output file: %v", err)
			}
		}
		return
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("failed to load config: %v", err)
	}

	store, err := storage.Open(cfg.SQLitePath)
	if err != nil {
		log.Fatalf("failed to open sqlite: %v", err)
	}
	defer store.Close()

	rawWriter, err := rawlog.NewWriter(cfg.RawLogDir)
	if err != nil {
		log.Fatalf("failed to initialize raw log writer: %v", err)
	}
	defer rawWriter.Close()

	store.SetRawLog(rawWriter)

	migrated, err := store.MigrateInlineBodiesToRawLog(rawWriter)
	if err != nil {
		log.Fatalf("failed to migrate inline bodies to raw logs: %v", err)
	}
	if migrated > 0 {
		log.Printf("migrated %d inline request records to raw_logs", migrated)
	}
	if *migrateOnly {
		return
	}

	backfillSessions(store)

	detector := harness.DefaultDetector()

	proxyHandler := proxy.NewHandler(cfg, func(ex *proxy.CapturedExchange) {
		parsed := proxy.ParseExchange(ex.Path, ex.RequestHeaders, ex.RequestBody, ex.ResponseHeaders, ex.ResponseBody)
		parsed.ClientIP = ex.ClientIP
		if parsed.APIKeyHash == "" {
			parsed.APIKeyHash = ex.APIKeyHash
		}
		reqPlain := proxy.DecompressIfGzip(ex.RequestHeaders, ex.RequestBody)
		respPlain := proxy.DecompressIfGzip(ex.ResponseHeaders, ex.ResponseBody)
		det := detector.Detect(ex.Upstream, ex.RequestHeaders, reqPlain, parsed)
		if len(det.Metadata) > 0 {
			if parsed.Metadata == nil {
				parsed.Metadata = map[string]any{}
			}
			for k, v := range det.Metadata {
				parsed.Metadata[k] = v
			}
		}

		parsedBytes, _ := json.Marshal(parsed)
		startedStr := ex.StartedAt.Format(time.RFC3339Nano)
		completedStr := ex.CompletedAt.Format(time.RFC3339Nano)

		relFile, offset, length, rawErr := rawWriter.Append(rawlog.Entry{
			Timestamp:       startedStr,
			SessionID:       det.SessionID,
			Harness:         det.Harness,
			HarnessVersion:  det.HarnessVersion,
			Upstream:        ex.Upstream,
			Method:          ex.Method,
			Path:            ex.Path,
			Query:           ex.Query,
			ClientIP:        ex.ClientIP,
			APIKeyHash:      ex.APIKeyHash,
			RequestHeaders:  ex.RequestHeaders,
			RequestBody:     string(reqPlain),
			StatusCode:      ex.StatusCode,
			ResponseHeaders: ex.ResponseHeaders,
			ResponseBody:    string(respPlain),
			LatencyMs:       ex.DurationMs,
			WorkDir:         det.WorkDir,
			Metadata:        det.Metadata,
		})
		if rawErr != nil {
			log.Printf("raw log append error: %v", rawErr)
		}

		sess := storage.SessionSummary{
			SessionID:      det.SessionID,
			Harness:        det.Harness,
			HarnessVersion: det.HarnessVersion,
			WorkDir:        det.WorkDir,
			Upstream:       ex.Upstream,
			Model:          parsed.Model,
			ClientIP:       ex.ClientIP,
			APIKeyHash:     ex.APIKeyHash,
			StartedAt:      startedStr,
			UpdatedAt:      completedStr,
		}
		rec := storage.RequestRecord{
			SessionID:        det.SessionID,
			Upstream:         ex.Upstream,
			Method:           ex.Method,
			Path:             ex.Path,
			Query:            ex.Query,
			Protocol:         parsed.Protocol,
			Model:            parsed.Model,
			ClientIP:         ex.ClientIP,
			APIKeyHash:       ex.APIKeyHash,
			IsStream:         parsed.IsStream,
			StatusCode:       ex.StatusCode,
			StartedAt:        startedStr,
			CompletedAt:      completedStr,
			DurationMs:       ex.DurationMs,
			RequestHeaders:   storage.SanitizeHeadersJSON(ex.RequestHeaders),
			ResponseHeaders:  storage.SanitizeHeadersJSON(ex.ResponseHeaders),
			RequestBody:      ex.RequestBody,
			ResponseBody:     ex.ResponseBody,
			ParsedJSON:       string(parsedBytes),
			PromptTokens:     parsed.PromptTokens,
			CompletionTokens: parsed.CompletionTokens,
			CachedTokens:     parsed.CachedTokens,
			RawLogFile:       relFile,
			RawLogOffset:     offset,
			RawLogLength:     length,
		}
		if err := store.RecordExchange(sess, rec, 0); err != nil {
			log.Printf("record exchange error: %v", err)
			return
		}
		if fullSess, err := store.GetSession(det.SessionID); err == nil {
			if reqs, err := store.GetSessionRequests(det.SessionID); err == nil {
				trajs := atif.BuildTrajectories(fullSess, reqs)
				totalSteps := 0
				for _, t := range trajs {
					totalSteps += len(t.Steps)
				}
				_ = store.UpdateSessionCounts(det.SessionID, totalSteps, len(trajs))
			}
		}
	})

	webDistFS, err := fs.Sub(embeddedWeb, "web/dist")
	if err != nil {
		log.Fatalf("embedded web/dist error: %v", err)
	}

	mux := http.NewServeMux()
	mux.Handle("/proxy/", proxyHandler)

	apiSrv := api.NewServer(cfg, store, webDistFS)
	apiSrv.RegisterRoutes(mux)

	if cfg.DashboardKey == "" && !cfg.IsLocalhost() {
		log.Printf("WARNING: dashboard_key is empty while listening on non-localhost address %s", cfg.Listen)
	}
	log.Printf("llm_tracer listening on %s", cfg.Listen)
	if err := http.ListenAndServe(cfg.Listen, mux); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

func backfillSessions(store *storage.Store) {
	sessions, _, err := store.ListSessions(storage.TraceFilter{Limit: 500})
	if err != nil {
		return
	}
	for i := range sessions {
		sess := sessions[i]
		reqs, err := store.GetSessionRequests(sess.SessionID)
		if err != nil || len(reqs) == 0 {
			continue
		}
		trajs := atif.BuildTrajectories(&sess, reqs)
		totalSteps := 0
		wd := sess.WorkDir
		for _, t := range trajs {
			totalSteps += len(t.Steps)
			if wd == "" {
				if v, ok := t.Extra["work_dir"].(string); ok && v != "" {
					wd = v
				}
			}
		}
		if wd != sess.WorkDir || totalSteps != sess.StepCount || len(trajs) != sess.TrajectoryCount {
			_ = store.UpdateSessionMetadata(sess.SessionID, wd, totalSteps, len(trajs))
		}
	}
}
