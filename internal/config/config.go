package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"

	"github.com/BurntSushi/toml"
)

const DefaultConfigTOML = `listen = "127.0.0.1:8080"
sqlite_path = "./data/llm_tracer.db"
raw_log_dir = "./data/logs"
dashboard_key = ""

[upstreams.openai]
url = "https://api.openai.com"

[upstreams.anthropic]
url = "https://api.anthropic.com"
`

func WriteDefault(path string) error {
	return os.WriteFile(path, []byte(DefaultConfigTOML), 0o644)
}

type UpstreamConfig struct {
	URL       string   `toml:"url"`
	ParsedURL *url.URL `toml:"-"`
}

type Config struct {
	Listen       string                    `toml:"listen"`
	SQLitePath   string                    `toml:"sqlite_path"`
	RawLogDir    string                    `toml:"raw_log_dir"`
	DashboardKey string                    `toml:"dashboard_key"`
	Upstreams    map[string]UpstreamConfig `toml:"upstreams"`
}

func Load(path string) (*Config, error) {
	var cfg Config
	md, err := toml.DecodeFile(path, &cfg)
	if err != nil {
		return nil, fmt.Errorf("decode config: %w", err)
	}
	if undecoded := md.Undecoded(); len(undecoded) > 0 {
		keys := make([]string, 0, len(undecoded))
		for _, k := range undecoded {
			keys = append(keys, k.String())
		}
		return nil, fmt.Errorf("unknown or disallowed config keys: %s", strings.Join(keys, ", "))
	}
	if strings.TrimSpace(cfg.Listen) == "" {
		cfg.Listen = "127.0.0.1:8080"
	}
	if strings.TrimSpace(cfg.SQLitePath) == "" {
		cfg.SQLitePath = "./data/llm_tracer.db"
	}
	if strings.TrimSpace(cfg.RawLogDir) == "" {
		cfg.RawLogDir = "./data/logs"
	}
	if cfg.Upstreams == nil {
		cfg.Upstreams = map[string]UpstreamConfig{}
	}
	for name, u := range cfg.Upstreams {
		raw := strings.TrimSpace(u.URL)
		if raw == "" {
			return nil, fmt.Errorf("upstream %q: url is required", name)
		}
		parsed, err := url.Parse(raw)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return nil, fmt.Errorf("upstream %q: invalid url %q", name, u.URL)
		}
		u.URL = strings.TrimRight(raw, "/")
		u.ParsedURL = parsed
		cfg.Upstreams[name] = u
	}
	return &cfg, nil
}

func (c *Config) IsLocalhost() bool {
	host, _, err := net.SplitHostPort(c.Listen)
	if err != nil {
		host = c.Listen
	}
	host = strings.Trim(strings.ToLower(strings.TrimSpace(host)), "[]")
	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return true
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return true
	}
	return false
}
