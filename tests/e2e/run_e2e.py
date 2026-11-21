import datetime
import gzip
import http.cookiejar
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))

from helpers import (
    BINARY_PATH,
    CLAUDE_BIN,
    PI_BIN,
    PORT_CFG_TEST,
    PORT_MOCK_ANTHROPIC,
    PORT_MOCK_OPENAI,
    PORT_MODE1,
    PORT_MODE2,
    PORT_MODE3,
    TMP_BASE,
    assert_eq,
    assert_true,
    http_request,
    sha256_hex,
    validate_atif_v18,
    wait_port,
)
from mock_servers import (
    MockRecorder,
    ThreadedHTTPServer,
    make_anthropic_handler,
    make_openai_handler,
)


def test_config_validation(tmp_dir):
    print("[1/9] Testing TOML config validation...")
    bad_api_key_cfg = os.path.join(tmp_dir, "bad_api_key.toml")
    with open(bad_api_key_cfg, "w", encoding="utf-8") as f:
        f.write(
            f'listen = "127.0.0.1:{PORT_CFG_TEST}"\n'
            f'sqlite_path = "{os.path.join(tmp_dir, "bad1.db")}"\n'
            f'raw_log_dir = "{os.path.join(tmp_dir, "bad1_raw")}"\n'
            'dashboard_key = ""\n'
            '[upstreams.openai]\n'
            f'url = "http://127.0.0.1:{PORT_MOCK_OPENAI}"\n'
            'api_key = "sk-disallowed"\n'
        )
    res = subprocess.run(
        [BINARY_PATH, "-config", bad_api_key_cfg],
        capture_output=True,
        text=True,
        timeout=5,
    )
    assert_true(res.returncode != 0, "disallowed api_key config should fail")
    assert_true("api_key" in (res.stderr + res.stdout), f"expected api_key in error output: {res.stderr}")

    bad_unknown_cfg = os.path.join(tmp_dir, "bad_unknown.toml")
    with open(bad_unknown_cfg, "w", encoding="utf-8") as f:
        f.write(
            f'listen = "127.0.0.1:{PORT_CFG_TEST}"\n'
            'unknown_top_field = true\n'
        )
    res2 = subprocess.run(
        [BINARY_PATH, "-config", bad_unknown_cfg],
        capture_output=True,
        text=True,
        timeout=5,
    )
    assert_true(res2.returncode != 0, "unknown top-level key config should fail")
    print("  PASS: TOML config validation passed (valid config accepted, api_key and unknown keys rejected).")


def test_auth_modes(tmp_dir, procs):
    print("[2/9] Testing auth lifecycle & non-localhost warning (all 3 modes)...")
    cfg2 = os.path.join(tmp_dir, "mode2.toml")
    with open(cfg2, "w", encoding="utf-8") as f:
        f.write(
            f'listen = "127.0.0.1:{PORT_MODE2}"\n'
            f'sqlite_path = "{os.path.join(tmp_dir, "mode2.db")}"\n'
            f'raw_log_dir = "{os.path.join(tmp_dir, "mode2_raw")}"\n'
            'dashboard_key = ""\n'
        )
    p2 = subprocess.Popen([BINARY_PATH, "-config", cfg2], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    procs.append(p2)
    wait_port("127.0.0.1", PORT_MODE2)

    st, _, body = http_request(f"http://127.0.0.1:{PORT_MODE2}/api/auth/status")
    assert_eq(st, 200, "mode2 auth status code")
    data = json.loads(body)
    assert_eq(data["auth_required"], False, "mode2 auth_required")
    assert_eq(data["is_localhost"], True, "mode2 is_localhost")
    assert_eq(data["insecure_no_auth_warning"], False, "mode2 insecure_no_auth_warning")
    st, _, _ = http_request(f"http://127.0.0.1:{PORT_MODE2}/api/traces")
    assert_eq(st, 200, "mode2 /api/traces without auth")

    cfg3 = os.path.join(tmp_dir, "mode3.toml")
    with open(cfg3, "w", encoding="utf-8") as f:
        f.write(
            f'listen = "0.0.0.0:{PORT_MODE3}"\n'
            f'sqlite_path = "{os.path.join(tmp_dir, "mode3.db")}"\n'
            f'raw_log_dir = "{os.path.join(tmp_dir, "mode3_raw")}"\n'
            'dashboard_key = ""\n'
        )
    p3 = subprocess.Popen([BINARY_PATH, "-config", cfg3], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    procs.append(p3)
    wait_port("127.0.0.1", PORT_MODE3)

    st, _, body = http_request(f"http://127.0.0.1:{PORT_MODE3}/api/auth/status")
    assert_eq(st, 200, "mode3 auth status code")
    data = json.loads(body)
    assert_eq(data["auth_required"], False, "mode3 auth_required")
    assert_eq(data["is_localhost"], False, "mode3 is_localhost")
    assert_eq(data["insecure_no_auth_warning"], True, "mode3 insecure_no_auth_warning")
    st, _, _ = http_request(f"http://127.0.0.1:{PORT_MODE3}/api/traces")
    assert_eq(st, 200, "mode3 /api/traces without auth")

    base1 = f"http://127.0.0.1:{PORT_MODE1}"
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj))

    st, _, body = http_request(f"{base1}/api/auth/status", opener=opener)
    assert_eq(st, 200, "mode1 auth status")
    data = json.loads(body)
    assert_eq(data["auth_required"], True, "mode1 auth_required")
    assert_eq(data["authenticated"], False, "mode1 authenticated before login")
    assert_eq(data["is_localhost"], True, "mode1 is_localhost")
    assert_eq(data["insecure_no_auth_warning"], False, "mode1 insecure_no_auth_warning")

    st, _, _ = http_request(f"{base1}/api/traces", opener=opener)
    assert_eq(st, 401, "mode1 /api/traces unauthenticated")

    st, _, _ = http_request(
        f"{base1}/api/auth/login",
        method="POST",
        headers={"Content-Type": "application/json"},
        body=json.dumps({"key": "wrong-key"}).encode("utf-8"),
        opener=opener,
    )
    assert_eq(st, 401, "mode1 wrong login")

    st, hdrs, _ = http_request(
        f"{base1}/api/auth/login",
        method="POST",
        headers={"Content-Type": "application/json"},
        body=json.dumps({"key": "secret123"}).encode("utf-8"),
        opener=opener,
    )
    assert_eq(st, 200, "mode1 valid login")
    assert_true(any(k.lower() == "set-cookie" for k in hdrs.keys()), "mode1 login sets cookie")

    st, _, body = http_request(f"{base1}/api/auth/status", opener=opener)
    assert_eq(json.loads(body)["authenticated"], True, "mode1 authenticated after login")

    st, _, _ = http_request(f"{base1}/api/traces", opener=opener)
    assert_eq(st, 200, "mode1 /api/traces authenticated")

    st, _, _ = http_request(f"{base1}/api/auth/logout", method="POST", opener=opener)
    assert_eq(st, 200, "mode1 logout")

    st, _, _ = http_request(f"{base1}/api/traces", opener=opener)
    assert_eq(st, 401, "mode1 /api/traces after logout")

    st, _, _ = http_request(
        f"{base1}/api/auth/login",
        method="POST",
        headers={"Content-Type": "application/json"},
        body=json.dumps({"key": "secret123"}).encode("utf-8"),
        opener=opener,
    )
    assert_eq(st, 200, "mode1 re-login")
    print("  PASS: All 3 auth modes and login/401/cookie/logout lifecycle verified.")
    return opener


def test_transparent_forwarding(base1, oai_rec, ant_rec):
    print("[3/9] Testing byte-for-byte transparent forwarding across all 3 protocols...")

    raw_oai_ns = (
        b'{\n  "model":  "gpt-4o-mini",\n  "stream": false,\n'
        b'  "tools": [{"type": "function", "function": {"name": "read", "description": "Read file", "parameters": {"type": "object"}}}],\n'
        b'  "messages": [ {"role": "user", "content": "WANT_REASONING USE_TOOL_READ Exact byte check unicode: \\u4f60\\u597d"} ]\n}'
    )
    st, _, resp_bytes = http_request(
        f"{base1}/proxy/openai/v1/chat/completions?e2e=1&mode=ns",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer sk-e2e-openai-exact",
            "User-Agent": "byte-checker/1.0.0",
            "X-Session-Id": "sess-bytes-oai-ns",
        },
        body=raw_oai_ns,
    )
    assert_eq(st, 200, "oai chat non-stream proxy status")
    rec = oai_rec.last()
    assert_eq(rec["request_body"], raw_oai_ns, "oai chat non-stream request bytes unmodified")
    assert_eq(rec["headers"].get("Authorization"), "Bearer sk-e2e-openai-exact", "oai chat auth header preserved")
    assert_eq(rec["query"], "e2e=1&mode=ns", "oai chat query string preserved")
    assert_eq(resp_bytes, rec["response_body"], "oai chat non-stream response bytes unmodified")

    raw_oai_s = (
        b'{"model":"gpt-4o-mini","stream":true,'
        b'"tools":[{"type":"function","function":{"name":"read","description":"Read file","parameters":{"type":"object"}}}],'
        b'"messages":[{"role":"user","content":"WANT_REASONING USE_TOOL_READ Stream exact byte check"}]}'
    )
    st, _, resp_bytes = http_request(
        f"{base1}/proxy/openai/v1/chat/completions?stream_check=1",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer sk-e2e-openai-stream",
            "User-Agent": "byte-checker/1.0.0",
            "X-Session-Id": "sess-bytes-oai-stream",
        },
        body=raw_oai_s,
    )
    assert_eq(st, 200, "oai chat stream proxy status")
    rec = oai_rec.last()
    assert_eq(rec["request_body"], raw_oai_s, "oai chat stream request bytes unmodified")
    assert_eq(resp_bytes, rec["response_body"], "oai chat stream response SSE bytes unmodified")

    raw_resp_ns = json.dumps({
        "model": "gpt-5.2-codex",
        "stream": False,
        "instructions": "You are a precise Responses API assistant.",
        "reasoning": {"effort": "high"},
        "tools": [
            {
                "type": "function",
                "name": "shell",
                "description": "Run a shell command",
                "parameters": {"type": "object", "properties": {"command": {"type": "string"}}},
            }
        ],
        "input": [
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "USE_RESP_TOOL Run pwd"}]}
        ],
    }, separators=(", ", ": ")).encode("utf-8")
    st, _, resp_bytes = http_request(
        f"{base1}/proxy/openai/v1/responses?resp_mode=ns",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer sk-e2e-responses-ns",
            "User-Agent": "byte-checker/1.0.0",
            "X-Session-Id": "sess-bytes-resp-ns",
        },
        body=raw_resp_ns,
    )
    assert_eq(st, 200, "oai responses non-stream proxy status")
    rec = oai_rec.last()
    assert_eq(rec["request_body"], raw_resp_ns, "oai responses non-stream request bytes unmodified")
    assert_eq(rec["query"], "resp_mode=ns", "oai responses query string preserved")
    assert_eq(resp_bytes, rec["response_body"], "oai responses non-stream response bytes unmodified")

    raw_resp_s = json.dumps({
        "model": "gpt-5.2-codex",
        "stream": True,
        "instructions": "You are a streaming Responses API assistant.",
        "reasoning": {"effort": "medium"},
        "tools": [
            {
                "type": "function",
                "name": "shell",
                "description": "Run a shell command",
                "parameters": {"type": "object", "properties": {"command": {"type": "string"}}},
            }
        ],
        "input": [
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "USE_RESP_TOOL Stream responses check"}]}
        ],
    }).encode("utf-8")
    st, _, resp_bytes = http_request(
        f"{base1}/proxy/openai/v1/responses?resp_mode=stream",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer sk-e2e-responses-stream",
            "User-Agent": "byte-checker/1.0.0",
            "X-Session-Id": "sess-bytes-resp-stream",
        },
        body=raw_resp_s,
    )
    assert_eq(st, 200, "oai responses stream proxy status")
    rec = oai_rec.last()
    assert_eq(rec["request_body"], raw_resp_s, "oai responses stream request bytes unmodified")
    assert_eq(resp_bytes, rec["response_body"], "oai responses stream SSE response bytes unmodified")

    raw_ant_ns = (
        b'{\n  "model": "claude-sonnet-4-5",\n  "max_tokens": 256,\n  "stream": false,\n'
        b'  "tools": [{"name": "read", "description": "Read file", "input_schema": {"type": "object"}}],\n'
        b'  "messages": [{"role": "user", "content": "USE_TOOL_READ Anthropic exact byte check"}]\n}'
    )
    st, _, resp_bytes = http_request(
        f"{base1}/proxy/anthropic/v1/messages?ant=ns",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "x-api-key": "sk-e2e-anthropic-exact",
            "anthropic-version": "2023-06-01",
            "User-Agent": "byte-checker/1.0.0",
            "X-Session-Id": "sess-bytes-ant-ns",
        },
        body=raw_ant_ns,
    )
    assert_eq(st, 200, "anthropic non-stream proxy status")
    rec = ant_rec.last()
    assert_eq(rec["request_body"], raw_ant_ns, "anthropic non-stream request bytes unmodified")
    ant_key = next((v for k, v in rec["headers"].items() if k.lower() == "x-api-key"), None)
    assert_eq(ant_key, "sk-e2e-anthropic-exact", "anthropic x-api-key header preserved")
    assert_eq(rec["query"], "ant=ns", "anthropic query string preserved")
    assert_eq(resp_bytes, rec["response_body"], "anthropic non-stream response bytes unmodified")

    raw_ant_s = (
        b'{"model":"claude-sonnet-4-5","max_tokens":256,"stream":true,'
        b'"tools":[{"name":"read","description":"Read file","input_schema":{"type":"object"}}],'
        b'"messages":[{"role":"user","content":"USE_TOOL_READ Anthropic stream exact byte check"}]}'
    )
    st, _, resp_bytes = http_request(
        f"{base1}/proxy/anthropic/v1/messages?ant=stream",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "x-api-key": "sk-e2e-anthropic-stream",
            "anthropic-version": "2023-06-01",
            "User-Agent": "byte-checker/1.0.0",
            "X-Session-Id": "sess-bytes-ant-stream",
        },
        body=raw_ant_s,
    )
    assert_eq(st, 200, "anthropic stream proxy status")
    rec = ant_rec.last()
    assert_eq(rec["request_body"], raw_ant_s, "anthropic stream request bytes unmodified")
    assert_eq(resp_bytes, rec["response_body"], "anthropic stream response SSE bytes unmodified")
    print("  PASS: Byte-for-byte forwarding verified for Chat Completions, Responses API, and Anthropic Messages (stream & non-stream).")


def test_real_pi_agent(tmp_dir, base1):
    print("[4/9] Testing real `pi` agent through proxy (OpenAI & Anthropic)...")
    if not PI_BIN or not os.path.isfile(PI_BIN) or not os.access(PI_BIN, os.X_OK):
        print("  SKIP: `pi` CLI not found in PATH or ~/.local/bin/pi.")
        return None, None

    pi_agent_dir = os.path.join(tmp_dir, "pi_agent_dir")
    os.makedirs(pi_agent_dir, exist_ok=True)

    models_cfg = {
        "providers": {
            "e2e-openai": {
                "baseUrl": f"{base1}/proxy/openai/v1",
                "api": "openai-completions",
                "apiKey": "sk-pi-openai-secret",
                "models": [
                    {
                        "id": "mock-gpt",
                        "name": "Mock GPT",
                        "reasoning": False,
                        "input": ["text"],
                        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                        "contextWindow": 128000,
                        "maxTokens": 4096,
                    }
                ],
            },
            "e2e-anthropic": {
                "baseUrl": f"{base1}/proxy/anthropic",
                "api": "anthropic-messages",
                "apiKey": "sk-pi-anthropic-secret",
                "models": [
                    {
                        "id": "mock-claude",
                        "name": "Mock Claude",
                        "reasoning": True,
                        "input": ["text"],
                        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                        "contextWindow": 200000,
                        "maxTokens": 4096,
                    }
                ],
            },
        }
    }
    with open(os.path.join(pi_agent_dir, "models.json"), "w", encoding="utf-8") as f:
        json.dump(models_cfg, f)

    wd_oai = os.path.join(tmp_dir, "workdir_pi_openai")
    os.makedirs(wd_oai, exist_ok=True)
    hello_oai = os.path.join(wd_oai, "hello.txt")
    with open(hello_oai, "w", encoding="utf-8") as f:
        f.write("Hello from OpenAI pi e2e test!\n")

    env = os.environ.copy()
    env["PI_CODING_AGENT_DIR"] = pi_agent_dir
    env["PI_OFFLINE"] = "1"

    res_oai = subprocess.run(
        [
            PI_BIN,
            "-p",
            "--no-session",
            "--provider", "e2e-openai",
            "--model", "mock-gpt",
            f"USE_TOOL_READ READ_PATH:{hello_oai} please read hello.txt",
        ],
        cwd=wd_oai,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert_eq(res_oai.returncode, 0, f"pi openai run failed: stdout={res_oai.stdout!r} stderr={res_oai.stderr!r}")
    assert_true("OpenAI mock final answer after tool" in res_oai.stdout, f"unexpected pi openai stdout: {res_oai.stdout!r}")

    wd_ant = os.path.join(tmp_dir, "workdir_pi_anthropic")
    os.makedirs(wd_ant, exist_ok=True)
    hello_ant = os.path.join(wd_ant, "hello.txt")
    with open(hello_ant, "w", encoding="utf-8") as f:
        f.write("Hello from Anthropic pi e2e test!\n")

    res_ant = subprocess.run(
        [
            PI_BIN,
            "-p",
            "--no-session",
            "--provider", "e2e-anthropic",
            "--model", "mock-claude",
            f"USE_TOOL_READ READ_PATH:{hello_ant} please read hello.txt",
        ],
        cwd=wd_ant,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert_eq(res_ant.returncode, 0, f"pi anthropic run failed: stdout={res_ant.stdout!r} stderr={res_ant.stderr!r}")
    assert_true("Anthropic mock final answer after tool" in res_ant.stdout, f"unexpected pi anthropic stdout: {res_ant.stdout!r}")
    print("  PASS: Real `pi` agent completed multi-turn tool-call runs on OpenAI & Anthropic.")
    return wd_oai, wd_ant


def test_real_claude_code(tmp_dir, base1, opener):
    print("[4b/9] Testing real `claude` CLI through proxy (Anthropic Messages + tool call)...")
    if not CLAUDE_BIN or not os.path.isfile(CLAUDE_BIN) or not os.access(CLAUDE_BIN, os.X_OK):
        print("  SKIP: `claude` CLI not found in PATH or ~/.local/bin/claude.")
        return None

    wd_claude = os.path.join(tmp_dir, "workdir_claude_real")
    os.makedirs(wd_claude, exist_ok=True)
    hello_claude = os.path.join(wd_claude, "hello.txt")
    with open(hello_claude, "w", encoding="utf-8") as f:
        f.write("Hello from real Claude Code e2e test!\n")

    claude_key = "sk-claude-real-e2e-key"
    settings_json = json.dumps({
        "env": {
            "ANTHROPIC_BASE_URL": f"{base1}/proxy/anthropic",
            "ANTHROPIC_API_KEY": claude_key,
            "ANTHROPIC_AUTH_TOKEN": claude_key,
        }
    })
    env = os.environ.copy()
    env["ANTHROPIC_BASE_URL"] = f"{base1}/proxy/anthropic"
    env["ANTHROPIC_API_KEY"] = claude_key
    env["ANTHROPIC_AUTH_TOKEN"] = claude_key

    res = subprocess.run(
        [
            CLAUDE_BIN,
            "-p",
            "--settings", settings_json,
            "--model", "claude-sonnet-4-5",
            "--dangerously-skip-permissions",
            "--no-session-persistence",
            "--",
            f"USE_TOOL_READ READ_PATH:{hello_claude} please read hello.txt",
        ],
        cwd=wd_claude,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert_eq(res.returncode, 0, f"claude real run failed: stdout={res.stdout!r} stderr={res.stderr!r}")
    assert_true(
        "Anthropic mock final answer after tool" in res.stdout or "Anthropic mock stream answer" in res.stdout,
        f"unexpected claude stdout: {res.stdout!r}",
    )

    st, _, body = http_request(f"{base1}/api/traces?harness=claude-code&limit=50", opener=opener)
    assert_eq(st, 200, "GET /api/traces?harness=claude-code")
    claude_traces = json.loads(body)["traces"]
    expected_hash = sha256_hex(claude_key)
    matched = [t for t in claude_traces if t.get("api_key_hash") == expected_hash]
    assert_true(len(matched) >= 1, f"real claude trace not found in {claude_traces}")
    tr_sum = matched[0]
    assert_eq(tr_sum["harness"], "claude-code", "real claude harness")
    assert_true(len(tr_sum["session_id"]) > 8 and tr_sum["session_id"] != "id", f"real claude session_id: {tr_sum['session_id']!r}")
    assert_true(os.path.basename(wd_claude) in tr_sum["work_dir"], f"real claude work_dir: {tr_sum['work_dir']!r}")

    sid_enc = urllib.parse.quote(tr_sum["session_id"], safe="")
    st, _, tb = http_request(f"{base1}/api/traces/{sid_enc}/trajectories", opener=opener)
    assert_eq(st, 200, "GET real claude trajectories")
    t_data = json.loads(tb)
    assert_true(t_data["llm_call_count"] >= 2, f"real claude expected >=2 llm calls, got {t_data['llm_call_count']}")
    ver = ""
    for idx, traj in enumerate(t_data["trajectories"]):
        validate_atif_v18(traj, context=f"real-claude[{idx}]")
        assert_eq(traj["agent"]["name"], "claude-code", "real claude agent.name")
        ver = traj["agent"]["version"]
        assert_true(ver not in ("", "unknown"), f"real claude agent.version: {ver!r}")

    print(f"  PASS: Real `claude` CLI ({ver}) completed end-to-end tool call (sid={tr_sum['session_id']}, calls={t_data['llm_call_count']}).")
    return wd_claude


def test_all_harnesses(base1, opener, db_path, wd_oai, wd_ant):
    print("[5/9] Testing all 6 harnesses (pi, dumate+subagents, claude-code, codex, opencode, generic)...")

    if wd_oai is None:
        st, _, _ = http_request(
            f"{base1}/proxy/openai/v1/chat/completions",
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer sk-pi-synthetic",
                "User-Agent": "pi-coding-agent/1.5.0",
                "X-Session-Id": "sess-pi-synthetic",
                "X-Work-Dir": "/tmp/pi-wd",
            },
            body=json.dumps({
                "model": "gpt-4o-mini",
                "messages": [{"role": "user", "content": "Hello Pi"}],
            }).encode("utf-8"),
        )
        assert_eq(st, 200, "pi synthetic proxy request")

    dumate_key = "sk-dumate-secret-key"
    dumate_tools = [
        {"type": "function", "function": {"name": "task", "description": "Spawn subagent", "parameters": {"type": "object"}}}
    ]
    st, _, _ = http_request(
        f"{base1}/proxy/openai/v1/chat/completions",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {dumate_key}",
            "User-Agent": "DumateApp/1.0.93.526 (macOS; arm64)",
            "X-Dumate-Session-Id": "sess-dumate-e2e",
            "X-Dumate-Request-Extra-Param": "source=user,sandbox=true,sandboxType=docker",
            "X-Work-Dir": "/tmp/dumate-wd",
        },
        body=json.dumps({
            "model": "gpt-4o",
            "tools": dumate_tools,
            "messages": [
                {"role": "system", "content": "You are DuMate."},
                {"role": "user", "content": "USE_TOOL_TASK Delegate subtask"},
            ],
        }).encode("utf-8"),
    )
    assert_eq(st, 200, "dumate main turn 1")

    st, _, _ = http_request(
        f"{base1}/proxy/openai/v1/chat/completions",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {dumate_key}",
            "User-Agent": "DumateApp/1.0.93.526 (macOS; arm64)",
            "X-Dumate-Session-Id": "sess-dumate-e2e",
            "X-Dumate-Request-Extra-Param": "source=subAgent,sandbox=true",
        },
        body=json.dumps({
            "model": "gpt-4o-mini",
            "messages": [
                {"role": "system", "content": "You are DuMate subagent."},
                {"role": "user", "content": "Inspect subagent target"},
            ],
        }).encode("utf-8"),
    )
    assert_eq(st, 200, "dumate subagent turn 1")

    st, _, _ = http_request(
        f"{base1}/proxy/openai/v1/chat/completions",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {dumate_key}",
            "User-Agent": "DumateApp/1.0.93.526 (macOS; arm64)",
            "X-Dumate-Session-Id": "sess-dumate-e2e",
            "X-Dumate-Request-Extra-Param": "source=user,sandbox=true,sandboxType=docker",
        },
        body=json.dumps({
            "model": "gpt-4o",
            "tools": dumate_tools,
            "messages": [
                {"role": "system", "content": "You are DuMate."},
                {"role": "user", "content": "USE_TOOL_TASK Delegate subtask"},
                {
                    "role": "assistant",
                    "content": "Calling tool now.",
                    "tool_calls": [
                        {
                            "id": "call_oai_ns_task_1",
                            "type": "function",
                            "function": {"name": "task", "arguments": json.dumps({"prompt": "run subagent"})},
                        }
                    ],
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_oai_ns_task_1",
                    "content": "task_id: dumate-sub-task-42\nSubagent completed successfully.",
                },
            ],
        }).encode("utf-8"),
    )
    assert_eq(st, 200, "dumate main turn 2")

    claude_key = "sk-claude-test-key"
    st, _, _ = http_request(
        f"{base1}/proxy/anthropic/v1/messages",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "x-api-key": claude_key,
            "User-Agent": "claude-cli/1.2.3 (darwin; arm64)",
            "X-Claude-Session-Id": "sess-claude-e2e",
        },
        body=json.dumps({
            "model": "claude-sonnet-4-5",
            "max_tokens": 128,
            "system": "You are Claude Code. Working directory: /tmp/claude-wd",
            "messages": [{"role": "user", "content": "Hello Claude"}],
        }).encode("utf-8"),
    )
    assert_eq(st, 200, "claude-code proxy request")

    codex_key = "sk-codex-test-key"
    st, _, _ = http_request(
        f"{base1}/proxy/openai/v1/responses",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {codex_key}",
            "User-Agent": "codex_cli_rs/0.9.1 (Mac OS 15.0; arm64)",
            "Session_id": "sess-codex-e2e",
            "X-Work-Dir": "/tmp/codex-wd",
        },
        body=json.dumps({
            "model": "gpt-5.2-codex",
            "instructions": "You are Codex.",
            "input": [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Hello Codex"}]}],
        }).encode("utf-8"),
    )
    assert_eq(st, 200, "codex proxy request")

    opencode_key = "sk-opencode-test-key"
    st, _, _ = http_request(
        f"{base1}/proxy/openai/v1/chat/completions",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {opencode_key}",
            "User-Agent": "opencode/2.1.0",
            "X-Opencode-Session": "sess-opencode-e2e",
        },
        body=json.dumps({
            "model": "gpt-4o-mini",
            "messages": [
                {"role": "system", "content": "cwd: /tmp/opencode-wd"},
                {"role": "user", "content": "Hello OpenCode"},
            ],
        }).encode("utf-8"),
    )
    assert_eq(st, 200, "opencode proxy request")

    generic_key = "sk-generic-test-key"
    st, _, _ = http_request(
        f"{base1}/proxy/openai/v1/chat/completions",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {generic_key}",
            "User-Agent": "my-custom-agent/3.4.5",
        },
        body=json.dumps({
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "Hello Generic Fallback"}],
        }).encode("utf-8"),
    )
    assert_eq(st, 200, "generic proxy request")

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    req_hdr_rows = cur.execute("SELECT request_headers FROM requests").fetchall()
    for (hdr_json,) in req_hdr_rows:
        assert_true("sk-e2e-" not in hdr_json, f"secret key leaked in sqlite request_headers: {hdr_json}")
        assert_true("sk-pi-" not in hdr_json, f"pi secret key leaked in sqlite request_headers: {hdr_json}")
        assert_true("sk-dumate-" not in hdr_json, f"dumate key leaked in sqlite request_headers: {hdr_json}")
        assert_true("sk-claude-" not in hdr_json, f"claude key leaked in sqlite request_headers: {hdr_json}")
        assert_true("sk-codex-" not in hdr_json, f"codex key leaked in sqlite request_headers: {hdr_json}")
        assert_true("sk-opencode-" not in hdr_json, f"opencode key leaked in sqlite request_headers: {hdr_json}")
        assert_true("sk-generic-" not in hdr_json, f"generic key leaked in sqlite request_headers: {hdr_json}")
    conn.close()

    st, _, body = http_request(f"{base1}/api/traces?limit=200", opener=opener)
    assert_eq(st, 200, "GET /api/traces")
    listing = json.loads(body)
    traces = listing["traces"]
    by_id = {t["session_id"]: t for t in traces}

    for sid, expected_harness, expected_wd, expected_key in [
        ("sess-dumate-e2e", "dumate", "/tmp/dumate-wd", dumate_key),
        ("sess-claude-e2e", "claude-code", "/tmp/claude-wd", claude_key),
        ("sess-codex-e2e", "codex", "/tmp/codex-wd", codex_key),
        ("sess-opencode-e2e", "opencode", "/tmp/opencode-wd", opencode_key),
    ]:
        assert_true(sid in by_id, f"{sid} recorded")
        item = by_id[sid]
        assert_eq(item["harness"], expected_harness, f"{sid} harness")
        assert_eq(item["work_dir"], expected_wd, f"{sid} work_dir")
        assert_eq(item["api_key_hash"], sha256_hex(expected_key), f"{sid} api_key_hash")
        assert_eq(len(item["api_key_hash"]), 64, f"{sid} api_key_hash length")
        assert_eq(item["client_ip"], "127.0.0.1", f"{sid} client_ip")

    generic_sessions = [t for t in traces if t["harness"] == "generic" and t["api_key_hash"] == sha256_hex(generic_key)]
    assert_true(len(generic_sessions) >= 1, "generic session recorded with api_key_hash")
    assert_eq(generic_sessions[0]["client_ip"], "127.0.0.1", "generic client_ip")

    pi_traces = [t for t in traces if t["harness"] == "pi"]
    assert_true(len(pi_traces) >= 1, "pi traces recorded")
    if wd_oai is not None and wd_ant is not None:
        pi_upstreams = {t["upstream"] for t in pi_traces}
        assert_true("openai" in pi_upstreams and "anthropic" in pi_upstreams, f"pi upstreams: {pi_upstreams}")
        pi_workdirs = {t["work_dir"] for t in pi_traces}
        assert_true(
            any(wd_oai in wd for wd in pi_workdirs) and any(wd_ant in wd for wd in pi_workdirs),
            f"pi work_dirs not extracted: {pi_workdirs}",
        )

    st, _, dumate_body = http_request(f"{base1}/api/traces/sess-dumate-e2e", opener=opener)
    assert_eq(st, 200, "GET dumate trace")
    dumate_traj = json.loads(dumate_body)
    validate_atif_v18(dumate_traj, context="dumate")
    assert_eq(dumate_traj["agent"]["name"], "dumate", "dumate agent.name")
    assert_eq(dumate_traj["agent"]["version"], "1.0.93.526", "dumate agent.version")
    subs = dumate_traj.get("subagent_trajectories") or []
    assert_eq(len(subs), 1, "dumate subagent_trajectories count")
    assert_eq(subs[0]["session_id"], "dumate-sub-task-42", "dumate subagent task_id linked session_id")
    assert_eq(subs[0]["trajectory_id"], "dumate-sub-task-42", "dumate subagent task_id linked trajectory_id")
    linked_refs = []
    for step in dumate_traj["steps"]:
        obs = step.get("observation")
        if obs:
            for r in obs.get("results", []):
                for ref in r.get("subagent_trajectory_ref", []):
                    linked_refs.append(ref)
    assert_true(
        any(ref.get("trajectory_id") == "dumate-sub-task-42" for ref in linked_refs),
        f"dumate observation missing subagent_trajectory_ref for task_id: {linked_refs}",
    )

    for sid, expected_ver in [
        ("sess-claude-e2e", "1.2.3"),
        ("sess-codex-e2e", "0.9.1"),
        ("sess-opencode-e2e", "2.1.0"),
    ]:
        st, _, tb = http_request(f"{base1}/api/traces/{sid}", opener=opener)
        assert_eq(st, 200, f"GET {sid}")
        tr = json.loads(tb)
        validate_atif_v18(tr, context=sid)
        assert_eq(tr["agent"]["version"], expected_ver, f"{sid} version")

    print("  PASS: All 6 harnesses, dumate subagent/task_id linking, api_key_hash, client_ip, and header redaction verified.")


def test_multi_trajectory_and_atif(base1, opener):
    print("[6/9] Testing strict ATIF-v1.8, Responses multi-turn, continuation splits, is_copied_context, llm_call_count & zero-cache omitempty...")

    linear_chat_sid = "sess-linear-chat-zerocache"
    chat_tools = [
        {"type": "function", "function": {"name": "read", "description": "Read file", "parameters": {"type": "object"}}}
    ]
    st, _, _ = http_request(
        f"{base1}/proxy/openai/v1/chat/completions",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer sk-linear-chat",
            "User-Agent": "e2e-agent/1.0.0",
            "X-Session-Id": linear_chat_sid,
        },
        body=json.dumps({
            "model": "gpt-4o-mini",
            "tools": chat_tools,
            "messages": [
                {"role": "system", "content": "Linear chat system prompt."},
                {"role": "user", "content": "ZERO_CACHE USE_TOOL_READ READ_PATH:a.txt"},
            ],
        }).encode("utf-8"),
    )
    assert_eq(st, 200, "linear chat turn 1")

    st, _, _ = http_request(
        f"{base1}/proxy/openai/v1/chat/completions",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer sk-linear-chat",
            "User-Agent": "e2e-agent/1.0.0",
            "X-Session-Id": linear_chat_sid,
        },
        body=json.dumps({
            "model": "gpt-4o-mini",
            "tools": chat_tools,
            "messages": [
                {"role": "system", "content": "Linear chat system prompt."},
                {"role": "user", "content": "ZERO_CACHE USE_TOOL_READ READ_PATH:a.txt"},
                {
                    "role": "assistant",
                    "content": "Calling tool now.",
                    "tool_calls": [
                        {
                            "id": "call_oai_ns_1",
                            "type": "function",
                            "function": {"name": "read", "arguments": json.dumps({"path": "a.txt"})},
                        }
                    ],
                },
                {"role": "tool", "tool_call_id": "call_oai_ns_1", "content": "file content of a.txt"},
            ],
        }).encode("utf-8"),
    )
    assert_eq(st, 200, "linear chat turn 2")

    st, _, body = http_request(f"{base1}/api/traces/{linear_chat_sid}/trajectories", opener=opener)
    assert_eq(st, 200, "GET linear chat trajectories")
    lc_data = json.loads(body)
    assert_eq(lc_data["llm_call_count"], 2, "linear chat session llm_call_count")
    assert_eq(len(lc_data["trajectories"]), 1, "linear chat stays in 1 trajectory")
    lc_traj = lc_data["trajectories"][0]
    validate_atif_v18(lc_traj, context=linear_chat_sid)
    assert_eq(lc_traj["extra"]["llm_call_count"], 2, "linear chat trajectory extra.llm_call_count")
    assert_eq(lc_traj["final_metrics"]["extra"]["llm_call_count"], 2, "linear chat final_metrics.extra.llm_call_count")
    lc_agents = [s for s in lc_traj["steps"] if s["source"] == "agent"]
    assert_eq(len(lc_agents), 2, "linear chat agent step count")
    for s in lc_agents:
        assert_eq(s.get("llm_call_count"), 1, "real agent step llm_call_count == 1")
        assert_true("cached_tokens" not in (s.get("metrics") or {}), "cached_tokens omitted when 0")

    resp_linear_sid = "sess-responses-multiturn"
    resp_tools = [
        {
            "type": "function",
            "name": "shell",
            "description": "Execute shell command",
            "parameters": {"type": "object", "properties": {"command": {"type": "string"}}},
        }
    ]
    st, _, _ = http_request(
        f"{base1}/proxy/openai/v1/responses",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer sk-resp-mt",
            "User-Agent": "codex_cli_rs/0.9.5",
            "Session_id": resp_linear_sid,
        },
        body=json.dumps({
            "model": "gpt-5.2-codex",
            "stream": True,
            "instructions": "Codex system instructions.",
            "tools": resp_tools,
            "input": [
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "USE_RESP_TOOL Check workspace"}]}
            ],
        }).encode("utf-8"),
    )
    assert_eq(st, 200, "responses multi-turn 1")

    st, _, _ = http_request(
        f"{base1}/proxy/openai/v1/responses",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer sk-resp-mt",
            "User-Agent": "codex_cli_rs/0.9.5",
            "Session_id": resp_linear_sid,
        },
        body=json.dumps({
            "model": "gpt-5.2-codex",
            "stream": True,
            "instructions": "Codex system instructions.",
            "tools": resp_tools,
            "input": [
                {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "USE_RESP_TOOL Check workspace"}]},
                {
                    "type": "reasoning",
                    "summary": [{"type": "summary_text", "text": "Thinking through the responses API step carefully."}],
                },
                {
                    "type": "function_call",
                    "call_id": "call_resp_stream_1",
                    "name": "shell",
                    "arguments": json.dumps({"command": "echo responses_ok"}),
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_resp_stream_1",
                    "output": "responses_ok",
                },
            ],
        }).encode("utf-8"),
    )
    assert_eq(st, 200, "responses multi-turn 2")

    st, _, body = http_request(f"{base1}/api/traces/{resp_linear_sid}/trajectories", opener=opener)
    assert_eq(st, 200, "GET responses multi-turn trajectories")
    rm_data = json.loads(body)
    assert_eq(rm_data["llm_call_count"], 2, "responses multi-turn llm_call_count")
    assert_eq(len(rm_data["trajectories"]), 1, "responses linear multi-turn stays in 1 trajectory")
    rm_traj = rm_data["trajectories"][0]
    validate_atif_v18(rm_traj, context=resp_linear_sid)
    rm_agents = [s for s in rm_traj["steps"] if s["source"] == "agent"]
    assert_eq(len(rm_agents), 2, "responses multi-turn agent steps")
    assert_true(bool(rm_agents[0].get("reasoning_content")), "responses step 1 reasoning_content")
    assert_true(len(rm_agents[0].get("tool_calls") or []) == 1, "responses step 1 tool_calls")
    assert_eq(rm_agents[0]["tool_calls"][0]["function_name"], "shell", "responses step 1 tool name")
    assert_true(len((rm_agents[0].get("observation") or {}).get("results") or []) == 1, "responses step 1 observation")
    assert_eq(rm_agents[0]["metrics"]["cached_tokens"], 35, "responses cached_tokens")
    assert_true("Responses stream final answer after tool" in rm_agents[1]["message"], "responses step 2 final message")

    multi_seg_sid = "sess-multi-continuation"
    tools_ab = [
        {"type": "function", "function": {"name": "alpha", "description": "Tool A", "parameters": {"type": "object"}}},
        {"type": "function", "function": {"name": "beta", "description": "Tool B", "parameters": {"type": "object"}}},
    ]
    tools_ba = [
        {"type": "function", "function": {"name": "beta", "description": "Tool B", "parameters": {"type": "object"}}},
        {"type": "function", "function": {"name": "alpha", "description": "Tool A", "parameters": {"type": "object"}}},
    ]

    st, _, _ = http_request(
        f"{base1}/proxy/openai/v1/chat/completions",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer sk-multi-seg",
            "User-Agent": "e2e-agent/1.0.0",
            "X-Session-Id": multi_seg_sid,
        },
        body=json.dumps({
            "model": "gpt-4o-mini",
            "tools": tools_ab,
            "messages": [
                {"role": "system", "content": "Seg system prompt."},
                {"role": "user", "content": "Seg 0 first question"},
            ],
        }).encode("utf-8"),
    )
    assert_eq(st, 200, "multi-seg req 1")

    st, _, _ = http_request(
        f"{base1}/proxy/openai/v1/chat/completions",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer sk-multi-seg",
            "User-Agent": "e2e-agent/1.0.0",
            "X-Session-Id": multi_seg_sid,
        },
        body=json.dumps({
            "model": "gpt-4o-mini",
            "tools": tools_ab,
            "messages": [
                {"role": "system", "content": "Seg system prompt."},
                {"role": "user", "content": "<summary>Compacted history of seg 0</summary>"},
                {"role": "user", "content": "Seg 1 new question after compaction"},
            ],
        }).encode("utf-8"),
    )
    assert_eq(st, 200, "multi-seg req 2 (compaction split)")

    st, _, _ = http_request(
        f"{base1}/proxy/openai/v1/chat/completions",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer sk-multi-seg",
            "User-Agent": "e2e-agent/1.0.0",
            "X-Session-Id": multi_seg_sid,
        },
        body=json.dumps({
            "model": "gpt-4o-mini",
            "tools": tools_ba,
            "messages": [
                {"role": "system", "content": "Seg system prompt."},
                {"role": "user", "content": "<summary>Compacted history of seg 0</summary>"},
                {"role": "user", "content": "Seg 1 new question after compaction"},
                {"role": "assistant", "content": "OpenAI non-stream response payload."},
                {"role": "user", "content": "Seg 2 after tool order change"},
            ],
        }).encode("utf-8"),
    )
    assert_eq(st, 200, "multi-seg req 3 (tools order split)")

    st, _, _ = http_request(
        f"{base1}/proxy/openai/v1/chat/completions",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer sk-multi-seg",
            "User-Agent": "e2e-agent/1.0.0",
            "X-Session-Id": multi_seg_sid,
        },
        body=json.dumps({
            "model": "gpt-4o-mini",
            "tools": tools_ba,
            "messages": [
                {"role": "system", "content": "Completely unrelated fresh system prompt."},
                {"role": "user", "content": "Completely unrelated fresh user prompt."},
            ],
        }).encode("utf-8"),
    )
    assert_eq(st, 200, "multi-seg req 4 (unrelated fresh trajectory)")

    st, _, body = http_request(f"{base1}/api/traces/{multi_seg_sid}/trajectories", opener=opener)
    assert_eq(st, 200, "GET multi-seg trajectories")
    ms_data = json.loads(body)
    assert_eq(ms_data["llm_call_count"], 4, "multi-seg total llm_call_count")
    trajs = ms_data["trajectories"]
    assert_eq(len(trajs), 4, f"expected 4 trajectory segments, got {len(trajs)}")
    for idx, tr in enumerate(trajs):
        validate_atif_v18(tr, context=f"{multi_seg_sid}[{idx}]")

    assert_eq(trajs[0].get("continued_trajectory_ref"), "trajectory.cont-1.json", "seg 0 continued_trajectory_ref")
    assert_eq(trajs[1].get("continued_trajectory_ref"), "trajectory.cont-2.json", "seg 1 continued_trajectory_ref")
    assert_eq(trajs[2].get("continued_trajectory_ref"), "trajectory.cont-3.json", "seg 2 continued_trajectory_ref")
    assert_true("continued_trajectory_ref" not in trajs[3], "last seg has no continued_trajectory_ref")

    seg1_copied = [s for s in trajs[1]["steps"] if s.get("is_copied_context") is True]
    assert_true(len(seg1_copied) >= 2, f"seg 1 should mark carried-over system + compaction summary as copied: {trajs[1]['steps']}")
    seg1_fresh_user = [s for s in trajs[1]["steps"] if s["source"] == "user" and "Seg 1 new question" in s["message"]]
    assert_eq(len(seg1_fresh_user), 1, "seg 1 fresh user step exists")
    assert_true(not seg1_fresh_user[0].get("is_copied_context"), "seg 1 fresh user step must NOT be copied")

    seg2_copied = [s for s in trajs[2]["steps"] if s.get("is_copied_context") is True]
    assert_true(len(seg2_copied) >= 3, f"seg 2 should mark carried-over steps from seg 1 as copied: {trajs[2]['steps']}")

    seg3_copied = [s for s in trajs[3]["steps"] if s.get("is_copied_context") is True]
    assert_eq(len(seg3_copied), 0, f"seg 3 unrelated trajectory must have ZERO is_copied_context steps: {seg3_copied}")

    print("  PASS: Strict ATIF-v1.8, Responses multi-turn, compaction/tools splits, is_copied_context precision, llm_call_count & zero-cache verified.")
    return multi_seg_sid, resp_linear_sid


def test_rawlog_append_only(raw_log_dir, db_path):
    print("[7/9] Testing append-only daily RawLog JSONL...")
    today = datetime.datetime.now().strftime("%Y-%m-%d")
    log_path = os.path.join(raw_log_dir, f"requests-{today}.jsonl")
    assert_true(os.path.isfile(log_path), f"raw log file missing: {log_path}")

    conn = sqlite3.connect(db_path)
    req_count = conn.execute("SELECT COUNT(*) FROM requests").fetchone()[0]
    conn.close()

    with open(log_path, "r", encoding="utf-8") as f:
        lines = [ln for ln in f.read().splitlines() if ln.strip()]

    assert_eq(len(lines), req_count, f"rawlog line count ({len(lines)}) must equal total proxied requests ({req_count})")
    for idx, ln in enumerate(lines):
        entry = json.loads(ln)
        assert_true(isinstance(entry.get("timestamp"), str) and len(entry["timestamp"]) > 0, f"rawlog[{idx}] timestamp")
        assert_true(isinstance(entry.get("client_ip"), str) and len(entry["client_ip"]) > 0, f"rawlog[{idx}] client_ip")
        assert_true(isinstance(entry.get("request_headers"), dict), f"rawlog[{idx}] request_headers")
        assert_true(isinstance(entry.get("response_headers"), dict), f"rawlog[{idx}] response_headers")
        if entry.get("method") == "POST":
            assert_true(isinstance(entry.get("api_key_hash"), str) and len(entry["api_key_hash"]) == 64, f"rawlog[{idx}] api_key_hash")
            assert_true(isinstance(entry.get("request_body"), str) and len(entry["request_body"]) > 0, f"rawlog[{idx}] request_body")
            assert_true(isinstance(entry.get("response_body"), str) and len(entry["response_body"]) > 0, f"rawlog[{idx}] response_body")

    print(f"  PASS: Append-only RawLog verified ({len(lines)} lines in requests-{today}.jsonl).")


def wait_for_request_id(db_path, session_id, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        conn = sqlite3.connect(db_path)
        row = conn.execute(
            "SELECT id FROM requests WHERE session_id = ? LIMIT 1",
            (session_id,),
        ).fetchone()
        conn.close()
        if row is not None:
            return row[0]
        time.sleep(0.05)
    raise AssertionError(f"timed out waiting for request row for session_id={session_id!r}")


def test_http_raw_inspection_api(base1, opener, db_path):
    print("[8/9] Testing HTTP Raw Inspection API (GET /api/requests/{id}) for Chat SSE, Responses SSE & gzip...")

    gzip_body = gzip.compress(json.dumps({
        "model": "gpt-4o-mini",
        "stream": False,
        "messages": [{"role": "user", "content": "Gzipped request inspection check"}],
    }).encode("utf-8"))
    st, _, _ = http_request(
        f"{base1}/proxy/openai/v1/chat/completions",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Content-Encoding": "gzip",
            "Authorization": "Bearer sk-gzip-check",
            "User-Agent": "gzip-checker/1.0.0",
            "X-Session-Id": "sess-gzip-inspect",
        },
        body=gzip_body,
    )
    assert_eq(st, 200, "gzipped proxy request")

    chat_sse_id = wait_for_request_id(db_path, "sess-bytes-oai-stream")
    resp_sse_id = wait_for_request_id(db_path, "sess-bytes-resp-stream")
    gzip_req_id = wait_for_request_id(db_path, "sess-gzip-inspect")

    st, _, body = http_request(f"{base1}/api/requests/{chat_sse_id}", opener=opener)
    assert_eq(st, 200, "GET /api/requests/{chat_sse_id}")
    chat_raw = json.loads(body)
    assert_eq(chat_raw["is_sse"], True, "chat SSE is_sse")
    assert_true(isinstance(chat_raw.get("sse_events"), list) and len(chat_raw["sse_events"]) >= 2, "chat sse_events")
    assert_true(isinstance(chat_raw.get("merged_response"), dict), "chat merged_response dict")
    assert_true(len(chat_raw.get("api_key_hash", "")) == 64, "chat api_key_hash")
    assert_eq(chat_raw.get("client_ip"), "127.0.0.1", "chat client_ip")

    st, _, body = http_request(f"{base1}/api/requests/{resp_sse_id}", opener=opener)
    assert_eq(st, 200, "GET /api/requests/{resp_sse_id}")
    resp_raw = json.loads(body)
    assert_eq(resp_raw["is_sse"], True, "responses SSE is_sse")
    assert_true(isinstance(resp_raw.get("sse_events"), list) and len(resp_raw["sse_events"]) >= 5, "responses sse_events")
    merged = resp_raw.get("merged_response")
    assert_true(isinstance(merged, dict), f"responses merged_response must be dict, got {merged!r}")
    assert_true(bool(merged.get("id")), f"responses merged_response missing id: {merged}")
    assert_true(bool(merged.get("model")), f"responses merged_response missing model: {merged}")
    assert_true(
        bool(merged.get("output")) or bool(merged.get("tool_calls")) or bool(merged.get("content")),
        f"responses merged_response missing output/content/tool_calls: {merged}",
    )

    st, _, body = http_request(f"{base1}/api/requests/{gzip_req_id}", opener=opener)
    assert_eq(st, 200, "GET /api/requests/{gzip_req_id}")
    gzip_raw = json.loads(body)
    assert_eq(gzip_raw["is_sse"], False, "gzip non-stream is_sse")
    assert_true("Gzipped request inspection check" in gzip_raw["request_body"], "gzip request_body decompressed")
    assert_true("sse_events" not in gzip_raw, "non-stream omits sse_events")
    assert_true("merged_response" not in gzip_raw, "non-stream omits merged_response")
    print("  PASS: HTTP Raw Inspection API verified for Chat SSE, Responses SSE, and gzipped non-stream.")


def test_batch_export_and_filters(base1, opener, multi_seg_sid):
    print("[9/9] Testing trace filters and multi-segment batch JSONL export...")

    st, _, body = http_request(f"{base1}/api/traces?harness=dumate", opener=opener)
    assert_eq(st, 200, "filter harness=dumate")
    f_dumate = json.loads(body)["traces"]
    assert_true(len(f_dumate) >= 1 and all(x["harness"] == "dumate" for x in f_dumate), "harness=dumate filter")

    st, _, body = http_request(f"{base1}/api/traces?upstream=anthropic", opener=opener)
    assert_eq(st, 200, "filter upstream=anthropic")
    f_ant = json.loads(body)["traces"]
    assert_true(len(f_ant) >= 2 and all(x["upstream"] == "anthropic" for x in f_ant), "upstream=anthropic filter")

    st, _, body = http_request(f"{base1}/api/traces?q=codex-wd", opener=opener)
    assert_eq(st, 200, "filter q=codex-wd")
    f_q = json.loads(body)["traces"]
    assert_eq(len(f_q), 1, "q filter count")
    assert_eq(f_q[0]["session_id"], "sess-codex-e2e", "q filter match")

    export_ids = [multi_seg_sid, "sess-claude-e2e", "sess-codex-e2e"]
    st, hdrs, export_body = http_request(
        f"{base1}/api/traces/export",
        method="POST",
        headers={"Content-Type": "application/json"},
        body=json.dumps({"session_ids": export_ids}).encode("utf-8"),
        opener=opener,
    )
    assert_eq(st, 200, "POST /api/traces/export")
    ct = next((v for k, v in hdrs.items() if k.lower() == "content-type"), "")
    assert_true("application/x-ndjson" in ct, f"unexpected export content-type: {ct}")
    lines = [ln for ln in export_body.decode("utf-8").splitlines() if ln.strip()]
    assert_eq(len(lines), 4 + 1 + 1, f"multi-segment export should produce 6 NDJSON lines, got {len(lines)}")
    exported_sids = []
    for idx, ln in enumerate(lines):
        obj = json.loads(ln)
        validate_atif_v18(obj, context=f"export[{idx}]")
        exported_sids.append(obj["session_id"])
    assert_eq(
        exported_sids,
        [multi_seg_sid, multi_seg_sid, multi_seg_sid, multi_seg_sid, "sess-claude-e2e", "sess-codex-e2e"],
        "exported NDJSON session_id sequence",
    )
    print("  PASS: Trace filters and multi-segment batch JSONL export verified.")


def main():
    if os.path.exists(TMP_BASE):
        shutil.rmtree(TMP_BASE)
    os.makedirs(TMP_BASE, exist_ok=True)

    oai_rec = MockRecorder()
    ant_rec = MockRecorder()
    oai_srv = ThreadedHTTPServer(("127.0.0.1", PORT_MOCK_OPENAI), make_openai_handler(oai_rec))
    ant_srv = ThreadedHTTPServer(("127.0.0.1", PORT_MOCK_ANTHROPIC), make_anthropic_handler(ant_rec))
    threading.Thread(target=oai_srv.serve_forever, daemon=True).start()
    threading.Thread(target=ant_srv.serve_forever, daemon=True).start()

    procs = []
    try:
        test_config_validation(TMP_BASE)

        db1 = os.path.join(TMP_BASE, "mode1.db")
        raw1 = os.path.join(TMP_BASE, "mode1_raw")
        cfg1 = os.path.join(TMP_BASE, "mode1.toml")
        with open(cfg1, "w", encoding="utf-8") as f:
            f.write(
                f'listen = "127.0.0.1:{PORT_MODE1}"\n'
                f'sqlite_path = "{db1}"\n'
                f'raw_log_dir = "{raw1}"\n'
                'dashboard_key = "secret123"\n'
                '[upstreams.openai]\n'
                f'url = "http://127.0.0.1:{PORT_MOCK_OPENAI}"\n'
                '[upstreams.anthropic]\n'
                f'url = "http://127.0.0.1:{PORT_MOCK_ANTHROPIC}"\n'
            )
        p1 = subprocess.Popen([BINARY_PATH, "-config", cfg1], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        procs.append(p1)
        wait_port("127.0.0.1", PORT_MODE1)

        base1 = f"http://127.0.0.1:{PORT_MODE1}"
        opener = test_auth_modes(TMP_BASE, procs)
        test_transparent_forwarding(base1, oai_rec, ant_rec)
        wd_oai, wd_ant = test_real_pi_agent(TMP_BASE, base1)
        test_real_claude_code(TMP_BASE, base1, opener)
        test_all_harnesses(base1, opener, db1, wd_oai, wd_ant)
        multi_seg_sid, _ = test_multi_trajectory_and_atif(base1, opener)
        test_rawlog_append_only(raw1, db1)
        test_http_raw_inspection_api(base1, opener, db1)
        test_batch_export_and_filters(base1, opener, multi_seg_sid)
        print("ALL 9 E2E TEST SUITES PASSED!")
    finally:
        for p in procs:
            try:
                p.terminate()
                p.wait(timeout=5)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass
        oai_srv.shutdown()
        ant_srv.shutdown()
        oai_srv.server_close()
        ant_srv.server_close()
        shutil.rmtree(TMP_BASE, ignore_errors=True)


if __name__ == "__main__":
    main()
