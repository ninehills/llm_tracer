import hashlib
import os
import shutil
import socket
import time
import urllib.error
import urllib.request


ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
BINARY_PATH = os.path.join(ROOT_DIR, "llm_tracer")
PI_BIN = shutil.which("pi") or os.path.expanduser("~/.local/bin/pi")
CLAUDE_BIN = shutil.which("claude") or os.path.expanduser("~/.local/bin/claude")

PORT_MODE1 = 18081
PORT_MODE2 = 18082
PORT_MODE3 = 18083
PORT_CFG_TEST = 18085
PORT_MOCK_OPENAI = 18088
PORT_MOCK_ANTHROPIC = 18089

TMP_BASE = "/tmp/llm_tracer_e2e_run"


def assert_eq(actual, expected, msg=""):
    if actual != expected:
        raise AssertionError(f"{msg}: expected {expected!r}, got {actual!r}")


def assert_true(cond, msg=""):
    if not cond:
        raise AssertionError(f"assertion failed: {msg}")


def sha256_hex(val):
    return hashlib.sha256(val.encode("utf-8")).hexdigest()


def wait_port(host, port, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError(f"port {host}:{port} did not open within {timeout}s")


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
            if "cached_tokens" in m:
                ca = m["cached_tokens"]
                assert_true(isinstance(ca, int) and ca > 0, f"{context}: cached_tokens should be >0 when present (omitempty 0), got {ca!r}")
            else:
                ca = 0
            assert_true(isinstance(pt, int) and pt >= 0, f"{context}: prompt_tokens")
            assert_true(isinstance(ct, int) and ct >= 0, f"{context}: completion_tokens")
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
        if sum_cached == 0:
            assert_true("total_cached_tokens" not in fm, f"{context}: total_cached_tokens should be omitted when 0")
        else:
            assert_eq(fm.get("total_cached_tokens"), sum_cached, f"{context}: final_metrics.total_cached_tokens")

    extra = traj.get("extra")
    if extra is not None:
        assert_true(isinstance(extra.get("started_at"), str) and len(extra["started_at"]) > 0, f"{context}: extra.started_at")
        assert_true(isinstance(extra.get("ended_at"), str) and len(extra["ended_at"]) > 0, f"{context}: extra.ended_at")
        assert_true(isinstance(extra.get("llm_call_count"), int) and extra["llm_call_count"] >= 0, f"{context}: extra.llm_call_count")

    for sub_idx, sub in enumerate(traj.get("subagent_trajectories") or []):
        validate_atif_v18(sub, context=f"{context}.subagent[{sub_idx}]")
