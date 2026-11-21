import http.cookiejar
import http.server
import json
import os
import re
import shutil
import socket
import socketserver
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BINARY_PATH = os.path.join(ROOT_DIR, "llm_tracer")
PI_BIN = shutil.which("pi") or os.path.expanduser("~/.local/bin/pi")

PORT_MODE1 = 18081
PORT_MODE2 = 18082
PORT_MODE3 = 18083
PORT_MOCK_OPENAI = 18088
PORT_MOCK_ANTHROPIC = 18089

TMP_BASE = "/tmp/llm_tracer_e2e_run"


def assert_eq(actual, expected, msg=""):
    if actual != expected:
        raise AssertionError(f"{msg}: expected {expected!r}, got {actual!r}")


def assert_true(cond, msg=""):
    if not cond:
        raise AssertionError(f"assertion failed: {msg}")


def wait_port(host, port, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError(f"port {host}:{port} did not open within {timeout}s")


class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    allow_reuse_address = True
    daemon_threads = True


class MockRecorder:
    def __init__(self):
        self.lock = threading.Lock()
        self.records = []

    def add(self, rec):
        with self.lock:
            self.records.append(rec)

    def last(self):
        with self.lock:
            return self.records[-1] if self.records else None

    def all(self):
        with self.lock:
            return list(self.records)


def make_openai_handler(recorder):
    class OpenAIMockHandler(http.server.BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(length) if length > 0 else b""
            parsed_url = urllib.parse.urlsplit(self.path)
            try:
                body = json.loads(raw_body.decode("utf-8"))
            except Exception:
                body = {}

            is_stream = bool(body.get("stream", False))
            model = body.get("model", "gpt-4o-mini")
            messages = body.get("messages", [])
            tools = body.get("tools", [])

            has_tool_result = any(m.get("role") == "tool" for m in messages)
            user_texts = []
            for m in messages:
                if m.get("role") == "user":
                    c = m.get("content", "")
                    if isinstance(c, str):
                        user_texts.append(c)
                    elif isinstance(c, list):
                        for part in c:
                            if isinstance(part, dict) and part.get("type") == "text":
                                user_texts.append(part.get("text", ""))
            joined_user = "\n".join(user_texts)

            want_tool = ("USE_TOOL_READ" in joined_user) and (not has_tool_result) and len(tools) > 0
            read_tool_name = "read"
            for t in tools:
                fn = t.get("function", {})
                if fn.get("name") == "read":
                    read_tool_name = "read"
                    break

            target_path = "hello.txt"
            m_path = re.search(r"READ_PATH:([^\s]+)", joined_user)
            if m_path:
                target_path = m_path.group(1)

            if is_stream:
                chunks = []
                if want_tool:
                    chunks.append({
                        "id": "chatcmpl-e2e-stream-tool-1",
                        "object": "chat.completion.chunk",
                        "created": 1700000001,
                        "model": model,
                        "choices": [{
                            "index": 0,
                            "delta": {
                                "role": "assistant",
                                "content": "Let me read that file.",
                                "tool_calls": [{
                                    "index": 0,
                                    "id": "call_oai_read_1",
                                    "type": "function",
                                    "function": {
                                        "name": read_tool_name,
                                        "arguments": json.dumps({"path": target_path})
                                    }
                                }]
                            },
                            "finish_reason": None
                        }]
                    })
                    chunks.append({
                        "id": "chatcmpl-e2e-stream-tool-1",
                        "object": "chat.completion.chunk",
                        "created": 1700000001,
                        "model": model,
                        "choices": [{
                            "index": 0,
                            "delta": {},
                            "finish_reason": "tool_calls"
                        }],
                        "usage": {
                            "prompt_tokens": 120,
                            "completion_tokens": 25,
                            "prompt_tokens_details": {"cached_tokens": 40}
                        }
                    })
                else:
                    reply_text = "OpenAI mock final answer after tool." if has_tool_result else "OpenAI mock stream answer."
                    chunks.append({
                        "id": "chatcmpl-e2e-stream-2",
                        "object": "chat.completion.chunk",
                        "created": 1700000002,
                        "model": model,
                        "choices": [{
                            "index": 0,
                            "delta": {"role": "assistant", "content": reply_text[:12]},
                            "finish_reason": None
                        }]
                    })
                    chunks.append({
                        "id": "chatcmpl-e2e-stream-2",
                        "object": "chat.completion.chunk",
                        "created": 1700000002,
                        "model": model,
                        "choices": [{
                            "index": 0,
                            "delta": {"content": reply_text[12:]},
                            "finish_reason": "stop"
                        }],
                        "usage": {
                            "prompt_tokens": 150,
                            "completion_tokens": 30,
                            "prompt_tokens_details": {"cached_tokens": 50}
                        }
                    })

                parts = []
                for c in chunks:
                    parts.append(("data: " + json.dumps(c) + "\n\n").encode("utf-8"))
                parts.append(b"data: [DONE]\n\n")
                full_resp = b"".join(parts)

                recorder.add({
                    "method": "POST",
                    "path": parsed_url.path,
                    "query": parsed_url.query,
                    "headers": dict(self.headers.items()),
                    "request_body": raw_body,
                    "response_body": full_resp,
                })

                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                for p in parts:
                    self.wfile.write(p)
                    self.wfile.flush()
                    time.sleep(0.01)
            else:
                if want_tool:
                    resp_obj = {
                        "id": "chatcmpl-e2e-nonstream-tool",
                        "object": "chat.completion",
                        "created": 1700000003,
                        "model": model,
                        "choices": [{
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": "Calling read tool.",
                                "tool_calls": [{
                                    "id": "call_oai_ns_1",
                                    "type": "function",
                                    "function": {
                                        "name": read_tool_name,
                                        "arguments": json.dumps({"path": target_path})
                                    }
                                }]
                            },
                            "finish_reason": "tool_calls"
                        }],
                        "usage": {
                            "prompt_tokens": 110,
                            "completion_tokens": 22,
                            "prompt_tokens_details": {"cached_tokens": 10}
                        }
                    }
                else:
                    resp_obj = {
                        "id": "chatcmpl-e2e-nonstream-1",
                        "object": "chat.completion",
                        "created": 1700000004,
                        "model": model,
                        "choices": [{
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": "OpenAI non-stream response payload."
                            },
                            "finish_reason": "stop"
                        }],
                        "usage": {
                            "prompt_tokens": 90,
                            "completion_tokens": 15,
                            "prompt_tokens_details": {"cached_tokens": 20}
                        }
                    }

                full_resp = json.dumps(resp_obj, separators=(", ", ": ")).encode("utf-8")
                recorder.add({
                    "method": "POST",
                    "path": parsed_url.path,
                    "query": parsed_url.query,
                    "headers": dict(self.headers.items()),
                    "request_body": raw_body,
                    "response_body": full_resp,
                })
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(full_resp)))
                self.send_header("X-Mock-Upstream", "openai")
                self.end_headers()
                self.wfile.write(full_resp)

    return OpenAIMockHandler


def make_anthropic_handler(recorder):
    class AnthropicMockHandler(http.server.BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(length) if length > 0 else b""
            parsed_url = urllib.parse.urlsplit(self.path)
            try:
                body = json.loads(raw_body.decode("utf-8"))
            except Exception:
                body = {}

            is_stream = bool(body.get("stream", False))
            model = body.get("model", "claude-sonnet-4-5")
            messages = body.get("messages", [])
            tools = body.get("tools", [])

            has_tool_result = False
            user_texts = []
            for m in messages:
                c = m.get("content", "")
                if isinstance(c, str):
                    if m.get("role") == "user":
                        user_texts.append(c)
                elif isinstance(c, list):
                    for part in c:
                        if isinstance(part, dict):
                            if part.get("type") == "tool_result":
                                has_tool_result = True
                            if m.get("role") == "user" and part.get("type") == "text":
                                user_texts.append(part.get("text", ""))
            joined_user = "\n".join(user_texts)

            want_tool = ("USE_TOOL_READ" in joined_user) and (not has_tool_result) and len(tools) > 0
            target_path = "hello.txt"
            m_path = re.search(r"READ_PATH:([^\s]+)", joined_user)
            if m_path:
                target_path = m_path.group(1)

            if is_stream:
                events = []
                events.append(("message_start", {
                    "type": "message_start",
                    "message": {
                        "id": "msg_e2e_stream_1",
                        "type": "message",
                        "role": "assistant",
                        "model": model,
                        "content": [],
                        "stop_reason": None,
                        "usage": {
                            "input_tokens": 100,
                            "cache_read_input_tokens": 40,
                            "cache_creation_input_tokens": 10,
                            "output_tokens": 1
                        }
                    }
                }))
                events.append(("content_block_start", {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {"type": "thinking", "thinking": ""}
                }))
                events.append(("content_block_delta", {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "thinking_delta", "thinking": "Analyzing the request carefully."}
                }))
                events.append(("content_block_stop", {
                    "type": "content_block_stop",
                    "index": 0
                }))

                if want_tool:
                    events.append(("content_block_start", {
                        "type": "content_block_start",
                        "index": 1,
                        "content_block": {"type": "text", "text": ""}
                    }))
                    events.append(("content_block_delta", {
                        "type": "content_block_delta",
                        "index": 1,
                        "delta": {"type": "text_delta", "text": "Reading the file now."}
                    }))
                    events.append(("content_block_stop", {
                        "type": "content_block_stop",
                        "index": 1
                    }))
                    events.append(("content_block_start", {
                        "type": "content_block_start",
                        "index": 2,
                        "content_block": {
                            "type": "tool_use",
                            "id": "toolu_ant_read_1",
                            "name": "read",
                            "input": {}
                        }
                    }))
                    events.append(("content_block_delta", {
                        "type": "content_block_delta",
                        "index": 2,
                        "delta": {
                            "type": "input_json_delta",
                            "partial_json": json.dumps({"path": target_path})
                        }
                    }))
                    events.append(("content_block_stop", {
                        "type": "content_block_stop",
                        "index": 2
                    }))
                    stop_reason = "tool_use"
                    out_tokens = 35
                else:
                    reply_text = "Anthropic mock final answer after tool." if has_tool_result else "Anthropic mock stream answer."
                    events.append(("content_block_start", {
                        "type": "content_block_start",
                        "index": 1,
                        "content_block": {"type": "text", "text": ""}
                    }))
                    events.append(("content_block_delta", {
                        "type": "content_block_delta",
                        "index": 1,
                        "delta": {"type": "text_delta", "text": reply_text}
                    }))
                    events.append(("content_block_stop", {
                        "type": "content_block_stop",
                        "index": 1
                    }))
                    stop_reason = "end_turn"
                    out_tokens = 28

                events.append(("message_delta", {
                    "type": "message_delta",
                    "delta": {"stop_reason": stop_reason, "stop_sequence": None},
                    "usage": {"output_tokens": out_tokens}
                }))
                events.append(("message_stop", {"type": "message_stop"}))

                parts = []
                for ev_name, payload in events:
                    chunk = f"event: {ev_name}\ndata: {json.dumps(payload)}\n\n".encode("utf-8")
                    parts.append(chunk)
                full_resp = b"".join(parts)

                recorder.add({
                    "method": "POST",
                    "path": parsed_url.path,
                    "query": parsed_url.query,
                    "headers": dict(self.headers.items()),
                    "request_body": raw_body,
                    "response_body": full_resp,
                })

                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                for p in parts:
                    self.wfile.write(p)
                    self.wfile.flush()
                    time.sleep(0.01)
            else:
                content = [
                    {"type": "thinking", "thinking": "Non-stream thinking block."},
                    {"type": "text", "text": "Anthropic non-stream response."}
                ]
                stop_reason = "end_turn"
                if want_tool:
                    content.append({
                        "type": "tool_use",
                        "id": "toolu_ant_ns_1",
                        "name": "read",
                        "input": {"path": target_path}
                    })
                    stop_reason = "tool_use"

                resp_obj = {
                    "id": "msg_e2e_nonstream_1",
                    "type": "message",
                    "role": "assistant",
                    "model": model,
                    "content": content,
                    "stop_reason": stop_reason,
                    "usage": {
                        "input_tokens": 80,
                        "cache_read_input_tokens": 20,
                        "cache_creation_input_tokens": 5,
                        "output_tokens": 18
                    }
                }
                full_resp = json.dumps(resp_obj, separators=(", ", ": ")).encode("utf-8")
                recorder.add({
                    "method": "POST",
                    "path": parsed_url.path,
                    "query": parsed_url.query,
                    "headers": dict(self.headers.items()),
                    "request_body": raw_body,
                    "response_body": full_resp,
                })
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(full_resp)))
                self.send_header("X-Mock-Upstream", "anthropic")
                self.end_headers()
                self.wfile.write(full_resp)

    return AnthropicMockHandler


def http_request(url, method="GET", headers=None, body=None, opener=None):
    req = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    fn = opener.open if opener is not None else urllib.request.urlopen
    try:
        with fn(req, timeout=15) as resp:
            return resp.status, dict(resp.headers.items()), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers.items()), e.read()


def validate_atif_v18(traj, context=""):
    root_allowed = {
        "schema_version",
        "session_id",
        "trajectory_id",
        "agent",
        "steps",
        "notes",
        "final_metrics",
        "continued_trajectory_ref",
        "subagent_trajectories",
        "extra",
    }
    agent_allowed = {"name", "version", "model_name", "tool_definitions", "extra"}
    step_allowed = {
        "step_id",
        "timestamp",
        "source",
        "message",
        "model_name",
        "reasoning_effort",
        "reasoning_content",
        "tool_calls",
        "observation",
        "metrics",
        "llm_call_count",
        "is_copied_context",
        "extra",
    }
    agent_only_fields = {
        "model_name",
        "reasoning_effort",
        "reasoning_content",
        "tool_calls",
        "metrics",
    }
    tool_call_allowed = {"tool_call_id", "function_name", "arguments", "extra"}
    obs_allowed = {"results"}
    obs_res_allowed = {"source_call_id", "content", "subagent_trajectory_ref", "extra"}
    metrics_allowed = {
        "prompt_tokens",
        "completion_tokens",
        "cached_tokens",
        "cost_usd",
        "prompt_token_ids",
        "completion_token_ids",
        "logprobs",
        "extra",
    }
    final_metrics_allowed = {
        "total_prompt_tokens",
        "total_completion_tokens",
        "total_cached_tokens",
        "total_cost_usd",
        "total_steps",
        "extra",
    }

    assert_true(isinstance(traj, dict), f"{context}: trajectory must be object")
    extra_root = set(traj.keys()) - root_allowed
    assert_eq(extra_root, set(), f"{context}: undeclared root fields")
    assert_eq(traj.get("schema_version"), "ATIF-v1.8", f"{context}: schema_version")
    assert_true(isinstance(traj.get("session_id"), str) and len(traj["session_id"]) > 0, f"{context}: session_id")

    agent = traj.get("agent")
    assert_true(isinstance(agent, dict), f"{context}: agent must be object")
    assert_eq(set(agent.keys()) - agent_allowed, set(), f"{context}: undeclared agent fields")
    assert_true(isinstance(agent.get("name"), str) and len(agent["name"]) > 0, f"{context}: agent.name")
    assert_true(isinstance(agent.get("version"), str) and len(agent["version"]) > 0, f"{context}: agent.version")

    steps = traj.get("steps")
    assert_true(isinstance(steps, list) and len(steps) > 0, f"{context}: steps must be non-empty list")

    sum_prompt = 0
    sum_completion = 0
    sum_cached = 0

    for idx, step in enumerate(steps, start=1):
        assert_true(isinstance(step, dict), f"{context}: step {idx} must be object")
        assert_eq(set(step.keys()) - step_allowed, set(), f"{context}: step {idx} undeclared fields")
        assert_eq(step.get("step_id"), idx, f"{context}: step {idx} sequential step_id")
        src = step.get("source")
        assert_true(src in {"system", "user", "agent"}, f"{context}: step {idx} invalid source {src!r}")
        assert_true("message" in step and isinstance(step["message"], (str, list)), f"{context}: step {idx} message")

        if src != "agent":
            forbidden = set(step.keys()) & agent_only_fields
            assert_eq(forbidden, set(), f"{context}: step {idx} non-agent step has agent-only fields")

        if "tool_calls" in step:
            tcs = step["tool_calls"]
            assert_true(isinstance(tcs, list), f"{context}: step {idx} tool_calls list")
            for tc in tcs:
                assert_true(isinstance(tc, dict), f"{context}: tool_call object")
                assert_eq(set(tc.keys()) - tool_call_allowed, set(), f"{context}: tool_call undeclared fields")
                assert_true(isinstance(tc.get("tool_call_id"), str) and len(tc["tool_call_id"]) > 0, f"{context}: tool_call_id")
                assert_true(isinstance(tc.get("function_name"), str) and len(tc["function_name"]) > 0, f"{context}: function_name")
                assert_true(isinstance(tc.get("arguments"), dict), f"{context}: tool_call arguments dict")

        if "observation" in step:
            obs = step["observation"]
            assert_true(isinstance(obs, dict), f"{context}: observation object")
            assert_eq(set(obs.keys()) - obs_allowed, set(), f"{context}: observation undeclared fields")
            results = obs.get("results")
            assert_true(isinstance(results, list), f"{context}: observation.results list")
            for r in results:
                assert_true(isinstance(r, dict), f"{context}: observation result object")
                assert_eq(set(r.keys()) - obs_res_allowed, set(), f"{context}: observation result undeclared fields")

        if "metrics" in step:
            m = step["metrics"]
            assert_true(isinstance(m, dict), f"{context}: metrics object")
            assert_eq(set(m.keys()) - metrics_allowed, set(), f"{context}: metrics undeclared fields")
            pt = m.get("prompt_tokens", 0)
            ct = m.get("completion_tokens", 0)
            ca = m.get("cached_tokens", 0)
            assert_true(isinstance(pt, int) and pt >= 0, f"{context}: prompt_tokens")
            assert_true(isinstance(ct, int) and ct >= 0, f"{context}: completion_tokens")
            assert_true(isinstance(ca, int) and ca >= 0, f"{context}: cached_tokens")
            assert_true(ca <= pt or pt == 0, f"{context}: cached_tokens ({ca}) must be <= prompt_tokens ({pt})")
            sum_prompt += pt
            sum_completion += ct
            sum_cached += ca

    fm = traj.get("final_metrics")
    if fm is not None:
        assert_true(isinstance(fm, dict), f"{context}: final_metrics object")
        assert_eq(set(fm.keys()) - final_metrics_allowed, set(), f"{context}: final_metrics undeclared fields")
        assert_eq(fm.get("total_steps"), len(steps), f"{context}: final_metrics.total_steps")
        assert_eq(fm.get("total_prompt_tokens"), sum_prompt, f"{context}: final_metrics.total_prompt_tokens")
        assert_eq(fm.get("total_completion_tokens"), sum_completion, f"{context}: final_metrics.total_completion_tokens")
        assert_eq(fm.get("total_cached_tokens"), sum_cached, f"{context}: final_metrics.total_cached_tokens")


def test_toml_validation(tmp_dir):
    print("[1/7] Testing TOML config validation...")
    bad_api_key_cfg = os.path.join(tmp_dir, "bad_api_key.toml")
    with open(bad_api_key_cfg, "w", encoding="utf-8") as f:
        f.write(
            'listen = "127.0.0.1:18085"\n'
            f'sqlite_path = "{os.path.join(tmp_dir, "bad1.db")}"\n'
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
    assert_true(res.returncode != 0, f"disallowed api_key config should fail, got exit 0")
    assert_true("api_key" in (res.stderr + res.stdout), f"expected api_key in error output: {res.stderr}")

    bad_unknown_cfg = os.path.join(tmp_dir, "bad_unknown.toml")
    with open(bad_unknown_cfg, "w", encoding="utf-8") as f:
        f.write(
            'listen = "127.0.0.1:18085"\n'
            'unknown_top_field = true\n'
        )
    res2 = subprocess.run(
        [BINARY_PATH, "-config", bad_unknown_cfg],
        capture_output=True,
        text=True,
        timeout=5,
    )
    assert_true(res2.returncode != 0, "unknown top-level key config should fail")
    print("  PASS: TOML config validation rejected disallowed keys.")


def test_auth_modes(tmp_dir, procs):
    print("[5/7] Testing Auth modes & non-localhost warning...")
    cfg2 = os.path.join(tmp_dir, "mode2.toml")
    with open(cfg2, "w", encoding="utf-8") as f:
        f.write(
            f'listen = "127.0.0.1:{PORT_MODE2}"\n'
            f'sqlite_path = "{os.path.join(tmp_dir, "mode2.db")}"\n'
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

    st, _, _ = http_request(
        f"{base1}/api/auth/logout",
        method="POST",
        opener=opener,
    )
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
    print("  PASS: All 3 auth modes and login/logout lifecycle verified.")
    return opener


def test_transparent_forwarding(base1, oai_rec, ant_rec):
    print("[2a/7] Testing byte-for-byte transparent forwarding (streaming & non-streaming)...")

    raw_oai_ns = b'{\n  "model":  "gpt-4o-mini",\n  "stream": false,\n  "messages": [ {"role": "user", "content": "Exact byte check unicode: \\u4f60\\u597d"} ]\n}'
    st, hdrs, resp_bytes = http_request(
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
    assert_eq(st, 200, "oai non-stream proxy status")
    rec = oai_rec.last()
    assert_eq(rec["request_body"], raw_oai_ns, "oai non-stream request bytes unmodified")
    assert_eq(rec["headers"].get("Authorization"), "Bearer sk-e2e-openai-exact", "oai auth header preserved")
    assert_eq(rec["query"], "e2e=1&mode=ns", "oai query string preserved")
    assert_eq(resp_bytes, rec["response_body"], "oai non-stream response bytes unmodified")

    raw_oai_s = b'{"model":"gpt-4o-mini","stream":true,"messages":[{"role":"user","content":"Stream exact byte check"}]}'
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
    assert_eq(st, 200, "oai stream proxy status")
    rec = oai_rec.last()
    assert_eq(rec["request_body"], raw_oai_s, "oai stream request bytes unmodified")
    assert_eq(resp_bytes, rec["response_body"], "oai stream response SSE bytes unmodified")

    raw_ant_ns = b'{\n  "model": "claude-sonnet-4-5",\n  "max_tokens": 256,\n  "stream": false,\n  "messages": [{"role": "user", "content": "Anthropic exact byte check"}]\n}'
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

    raw_ant_s = b'{"model":"claude-sonnet-4-5","max_tokens":256,"stream":true,"messages":[{"role":"user","content":"Anthropic stream exact byte check"}]}'
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
    print("  PASS: Byte-for-byte transparent forwarding verified for OpenAI & Anthropic (stream & non-stream).")


def test_real_pi_agent(tmp_dir, base1):
    print("[2b/7] Testing real `pi` agent through proxy (OpenAI & Anthropic)...")
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
                        "maxTokens": 4096
                    }
                ]
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
                        "maxTokens": 4096
                    }
                ]
            }
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


def test_harness_detection(base1):
    print("[3/7] Sending harness detection test requests (Claude Code, Codex, OpenCode, Generic)...")

    st, _, _ = http_request(
        f"{base1}/proxy/anthropic/v1/messages",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "x-api-key": "sk-claude-test",
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

    st, _, _ = http_request(
        f"{base1}/proxy/openai/v1/chat/completions",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer sk-codex-test",
            "User-Agent": "codex-cli/0.9.1",
            "Session_id": "sess-codex-e2e",
            "X-Work-Dir": "/tmp/codex-wd",
        },
        body=json.dumps({
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": "Hello Codex"}],
        }).encode("utf-8"),
    )
    assert_eq(st, 200, "codex proxy request")

    st, _, _ = http_request(
        f"{base1}/proxy/openai/v1/chat/completions",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer sk-opencode-test",
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

    st, _, _ = http_request(
        f"{base1}/proxy/openai/v1/chat/completions",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer sk-generic-test",
            "User-Agent": "my-custom-agent/3.4.5",
        },
        body=json.dumps({
            "model": "gpt-4o-mini",
            "messages": [{"role": "user", "content": "Hello Generic Fallback"}],
        }).encode("utf-8"),
    )
    assert_eq(st, 200, "generic proxy request")
    print("  PASS: Harness test requests completed.")


def test_sqlite_atif_and_api(db_path, base1, opener, wd_oai, wd_ant):
    print("[4/7 & 6/7] Verifying SQLite persistence, harness extraction, strict ATIF-v1.8, filters, and JSONL export...")

    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    sess_count = cur.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
    req_count = cur.execute("SELECT COUNT(*) FROM requests").fetchone()[0]
    assert_true(sess_count >= 10, f"expected >=10 sessions in sqlite, got {sess_count}")
    assert_true(req_count >= 12, f"expected >=12 requests in sqlite, got {req_count}")

    req_hdr_rows = cur.execute("SELECT request_headers FROM requests").fetchall()
    for (hdr_json,) in req_hdr_rows:
        assert_true("sk-e2e-" not in hdr_json, f"secret key leaked in sqlite request_headers: {hdr_json}")
        assert_true("sk-pi-" not in hdr_json, f"pi secret key leaked in sqlite request_headers: {hdr_json}")
    conn.close()

    st, _, body = http_request(f"{base1}/api/traces?limit=100", opener=opener)
    assert_eq(st, 200, "GET /api/traces")
    listing = json.loads(body)
    traces = listing["traces"]
    assert_eq(listing["total"], len(traces), "total matches trace count")

    by_id = {t["session_id"]: t for t in traces}

    assert_true("sess-claude-e2e" in by_id, "claude-code session recorded")
    assert_eq(by_id["sess-claude-e2e"]["harness"], "claude-code", "claude-code harness")
    assert_eq(by_id["sess-claude-e2e"]["work_dir"], "/tmp/claude-wd", "claude-code work_dir")

    assert_true("sess-codex-e2e" in by_id, "codex session recorded")
    assert_eq(by_id["sess-codex-e2e"]["harness"], "codex", "codex harness")
    assert_eq(by_id["sess-codex-e2e"]["work_dir"], "/tmp/codex-wd", "codex work_dir")

    assert_true("sess-opencode-e2e" in by_id, "opencode session recorded")
    assert_eq(by_id["sess-opencode-e2e"]["harness"], "opencode", "opencode harness")
    assert_eq(by_id["sess-opencode-e2e"]["work_dir"], "/tmp/opencode-wd", "opencode work_dir")

    generic_fallback = [t for t in traces if t["harness"] == "generic" and t["session_id"].startswith("sess-")]
    assert_true(len(generic_fallback) >= 1, "generic fallback session recorded")

    pi_traces = [t for t in traces if t["harness"] == "pi"]
    assert_true(len(pi_traces) >= 2, f"expected >=2 pi traces (openai + anthropic), got {len(pi_traces)}: {pi_traces}")
    pi_upstreams = {t["upstream"] for t in pi_traces}
    assert_true("openai" in pi_upstreams and "anthropic" in pi_upstreams, f"pi upstreams: {pi_upstreams}")
    pi_workdirs = {t["work_dir"] for t in pi_traces}
    assert_true(
        any(wd_oai in wd for wd in pi_workdirs) and any(wd_ant in wd for wd in pi_workdirs),
        f"pi work_dirs not extracted: got {pi_workdirs}, expected {wd_oai} and {wd_ant}",
    )

    for t in traces:
        sid = t["session_id"]
        st, _, detail_body = http_request(f"{base1}/api/traces/{urllib.parse.quote(sid, safe='')}", opener=opener)
        assert_eq(st, 200, f"GET /api/traces/{sid}")
        traj = json.loads(detail_body)
        validate_atif_v18(traj, context=f"detail:{sid}")

        if t["harness"] == "pi":
            assert_eq(traj["agent"]["name"], "pi", f"pi agent name for {sid}")
            assert_eq(traj["agent"]["version"], "1.5.0", f"pi agent version for {sid}")
            agent_steps = [s for s in traj["steps"] if s["source"] == "agent"]
            assert_true(len(agent_steps) >= 2, f"pi multi-turn trace {sid} should have >=2 agent steps, got {len(agent_steps)}")
            has_tc = any("tool_calls" in s and len(s["tool_calls"]) > 0 for s in agent_steps)
            has_obs = any("observation" in s and len(s["observation"]["results"]) > 0 for s in agent_steps)
            assert_true(has_tc, f"pi trace {sid} missing tool_calls")
            assert_true(has_obs, f"pi trace {sid} missing observation")
            if t["upstream"] == "anthropic":
                has_reasoning = any(bool(s.get("reasoning_content")) for s in agent_steps)
                assert_true(has_reasoning, f"pi anthropic trace {sid} missing reasoning_content")

        if sid == "sess-claude-e2e":
            assert_eq(traj["agent"]["version"], "1.2.3", "claude-code version")
        elif sid == "sess-codex-e2e":
            assert_eq(traj["agent"]["version"], "0.9.1", "codex version")
        elif sid == "sess-opencode-e2e":
            assert_eq(traj["agent"]["version"], "2.1.0", "opencode version")

    st, _, body = http_request(f"{base1}/api/traces?harness=pi", opener=opener)
    assert_eq(st, 200, "filter harness=pi")
    f_pi = json.loads(body)["traces"]
    assert_true(len(f_pi) >= 2 and all(x["harness"] == "pi" for x in f_pi), "harness filter failed")

    st, _, body = http_request(f"{base1}/api/traces?upstream=anthropic", opener=opener)
    assert_eq(st, 200, "filter upstream=anthropic")
    f_ant = json.loads(body)["traces"]
    assert_true(len(f_ant) >= 2 and all(x["upstream"] == "anthropic" for x in f_ant), "upstream filter failed")

    st, _, body = http_request(f"{base1}/api/traces?q=codex-wd", opener=opener)
    assert_eq(st, 200, "filter q=codex-wd")
    f_q = json.loads(body)["traces"]
    assert_eq(len(f_q), 1, "q filter count")
    assert_eq(f_q[0]["session_id"], "sess-codex-e2e", "q filter match")

    export_ids = [pi_traces[0]["session_id"], "sess-claude-e2e", "sess-codex-e2e"]
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
    assert_eq(len(lines), len(export_ids), "export line count")
    exported_sids = []
    for idx, ln in enumerate(lines):
        obj = json.loads(ln)
        validate_atif_v18(obj, context=f"export[{idx}]")
        exported_sids.append(obj["session_id"])
    assert_eq(exported_sids, export_ids, "exported session_ids order/content")
    print("  PASS: SQLite persistence, harness extraction, strict ATIF-v1.8, filters, and JSONL export verified.")


def strip_strings_c_style(code):
    out = []
    i = 0
    n = len(code)
    while i < n:
        ch = code[i]
        if ch in ('"', "'", "`"):
            q = ch
            out.append(" ")
            i += 1
            while i < n:
                if code[i] == "\\" and q != "`" and i + 1 < n:
                    i += 2
                    continue
                if code[i] == q:
                    i += 1
                    break
                if code[i] == "\n":
                    out.append("\n")
                i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def audit_hygiene():
    print("[7/7] Auditing workspace hygiene (comments, unit tests, unauthorized docs)...")
    issues = []
    skip_dirs = {".git", "node_modules", "dist", "test-evidence", "__pycache__"}

    for dirpath, dirnames, filenames in os.walk(ROOT_DIR):
        rel_dir = os.path.relpath(dirpath, ROOT_DIR)
        dirnames[:] = [
            d for d in dirnames
            if d not in skip_dirs and not (rel_dir == "web" and d == "dist")
        ]
        for fname in filenames:
            fpath = os.path.join(dirpath, fname)
            rel_path = os.path.relpath(fpath, ROOT_DIR)

            if fname.endswith("_test.go") or ".test." in fname or ".spec." in fname:
                issues.append(f"unit test file: {rel_path}")

            if fname.lower().endswith(".md") and fname != "FRONTEND_TEST_REPORT.md":
                issues.append(f"unauthorized doc file: {rel_path}")

            ext = os.path.splitext(fname)[1].lower()
            if ext in {".go", ".ts", ".tsx", ".js", ".mjs", ".css"}:
                with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()
                cleaned = strip_strings_c_style(content)
                for line_no, line in enumerate(cleaned.splitlines(), start=1):
                    if "//" in line:
                        orig_line = content.splitlines()[line_no - 1].strip()
                        if ext == ".go" and orig_line.startswith("//go:embed"):
                            continue
                        issues.append(f"line comment in {rel_path}:{line_no}: {orig_line}")
                    if "/*" in line or "*/" in line:
                        orig_line = content.splitlines()[line_no - 1].strip()
                        issues.append(f"block comment in {rel_path}:{line_no}: {orig_line}")
            elif ext == ".py":
                with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()
                for line_no, line in enumerate(content.splitlines(), start=1):
                    stripped = line.lstrip()
                    if stripped.startswith("#"):
                        issues.append(f"python comment in {rel_path}:{line_no}: {stripped}")

    if issues:
        raise AssertionError("Hygiene audit failed:\n  " + "\n  ".join(issues))
    print("  PASS: Workspace hygiene audit clean (0 unauthorized comments, 0 unit tests, 0 unauthorized docs).")


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
        test_toml_validation(TMP_BASE)

        db1 = os.path.join(TMP_BASE, "mode1.db")
        cfg1 = os.path.join(TMP_BASE, "mode1.toml")
        with open(cfg1, "w", encoding="utf-8") as f:
            f.write(
                f'listen = "127.0.0.1:{PORT_MODE1}"\n'
                f'sqlite_path = "{db1}"\n'
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
        test_harness_detection(base1)
        test_sqlite_atif_and_api(db1, base1, opener, wd_oai, wd_ant)
        audit_hygiene()
        print("ALL E2E TESTS PASSED!")
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
