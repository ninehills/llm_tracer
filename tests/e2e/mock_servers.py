import gzip
import http.server
import json
import re
import socketserver
import threading
import time
import urllib.parse


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


def _extract_chat_user_text(messages):
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
    return "\n".join(user_texts)


def _extract_responses_input_info(input_val):
    texts = []
    has_fn_output = False
    if isinstance(input_val, str):
        texts.append(input_val)
    elif isinstance(input_val, list):
        for item in input_val:
            if not isinstance(item, dict):
                continue
            itype = item.get("type", "")
            if itype == "function_call_output":
                has_fn_output = True
            elif itype == "message" or "role" in item:
                role = item.get("role", "")
                content = item.get("content", "")
                if role == "user":
                    if isinstance(content, str):
                        texts.append(content)
                    elif isinstance(content, list):
                        for part in content:
                            if isinstance(part, dict) and part.get("type") in ("input_text", "text", "output_text"):
                                texts.append(part.get("text", ""))
    return "\n".join(texts), has_fn_output


def _handle_openai_responses(handler, recorder, parsed_url, raw_body, body):
    is_stream = bool(body.get("stream", False))
    model = body.get("model", "gpt-5.2-codex")
    input_val = body.get("input", [])
    tools = body.get("tools", [])
    joined_user, has_fn_output = _extract_responses_input_info(input_val)

    want_tool = ("USE_RESP_TOOL" in joined_user) and (not has_fn_output) and len(tools) > 0
    zero_cache = "ZERO_CACHE" in joined_user
    cached_tokens = 0 if zero_cache else 35
    reasoning_tokens = 18

    if is_stream:
        resp_id = "resp_e2e_stream_tool_1" if want_tool else "resp_e2e_stream_final_2"
        events = []
        events.append(("response.created", {
            "type": "response.created",
            "response": {
                "id": resp_id,
                "object": "response",
                "status": "in_progress",
                "model": model,
                "output": [],
            },
        }))
        events.append(("response.in_progress", {
            "type": "response.in_progress",
            "response": {
                "id": resp_id,
                "object": "response",
                "status": "in_progress",
                "model": model,
                "output": [],
            },
        }))

        reasoning_text = "Thinking through the responses API step carefully."
        events.append(("response.output_item.added", {
            "type": "response.output_item.added",
            "output_index": 0,
            "item": {
                "id": "rs_stream_0",
                "type": "reasoning",
                "summary": [],
            },
        }))
        events.append(("response.reasoning_summary_text.delta", {
            "type": "response.reasoning_summary_text.delta",
            "item_id": "rs_stream_0",
            "output_index": 0,
            "summary_index": 0,
            "delta": reasoning_text[:20],
        }))
        events.append(("response.reasoning_summary_text.delta", {
            "type": "response.reasoning_summary_text.delta",
            "item_id": "rs_stream_0",
            "output_index": 0,
            "summary_index": 0,
            "delta": reasoning_text[20:],
        }))
        events.append(("response.reasoning_summary_text.done", {
            "type": "response.reasoning_summary_text.done",
            "item_id": "rs_stream_0",
            "output_index": 0,
            "summary_index": 0,
            "text": reasoning_text,
        }))
        reasoning_item = {
            "id": "rs_stream_0",
            "type": "reasoning",
            "summary": [{"type": "summary_text", "text": reasoning_text}],
        }
        events.append(("response.output_item.done", {
            "type": "response.output_item.done",
            "output_index": 0,
            "item": reasoning_item,
        }))

        output_items = [reasoning_item]
        if want_tool:
            fn_args = json.dumps({"command": "echo responses_ok"})
            events.append(("response.output_item.added", {
                "type": "response.output_item.added",
                "output_index": 1,
                "item": {
                    "id": "fc_stream_1",
                    "type": "function_call",
                    "call_id": "call_resp_stream_1",
                    "name": "shell",
                    "arguments": "",
                    "status": "in_progress",
                },
            }))
            events.append(("response.function_call_arguments.delta", {
                "type": "response.function_call_arguments.delta",
                "item_id": "fc_stream_1",
                "output_index": 1,
                "delta": fn_args[:12],
            }))
            events.append(("response.function_call_arguments.delta", {
                "type": "response.function_call_arguments.delta",
                "item_id": "fc_stream_1",
                "output_index": 1,
                "delta": fn_args[12:],
            }))
            events.append(("response.function_call_arguments.done", {
                "type": "response.function_call_arguments.done",
                "item_id": "fc_stream_1",
                "output_index": 1,
                "arguments": fn_args,
            }))
            fc_item = {
                "id": "fc_stream_1",
                "type": "function_call",
                "call_id": "call_resp_stream_1",
                "name": "shell",
                "arguments": fn_args,
                "status": "completed",
            }
            events.append(("response.output_item.done", {
                "type": "response.output_item.done",
                "output_index": 1,
                "item": fc_item,
            }))
            output_items.append(fc_item)
        else:
            reply_text = "Responses stream final answer after tool." if has_fn_output else "Responses API stream answer."
            events.append(("response.output_item.added", {
                "type": "response.output_item.added",
                "output_index": 1,
                "item": {
                    "id": "msg_stream_1",
                    "type": "message",
                    "role": "assistant",
                    "status": "in_progress",
                    "content": [],
                },
            }))
            events.append(("response.output_text.delta", {
                "type": "response.output_text.delta",
                "item_id": "msg_stream_1",
                "output_index": 1,
                "content_index": 0,
                "delta": reply_text[:15],
            }))
            events.append(("response.output_text.delta", {
                "type": "response.output_text.delta",
                "item_id": "msg_stream_1",
                "output_index": 1,
                "content_index": 0,
                "delta": reply_text[15:],
            }))
            events.append(("response.output_text.done", {
                "type": "response.output_text.done",
                "item_id": "msg_stream_1",
                "output_index": 1,
                "content_index": 0,
                "text": reply_text,
            }))
            msg_item = {
                "id": "msg_stream_1",
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": reply_text}],
            }
            events.append(("response.output_item.done", {
                "type": "response.output_item.done",
                "output_index": 1,
                "item": msg_item,
            }))
            output_items.append(msg_item)

        usage_obj = {
            "input_tokens": 140,
            "output_tokens": 42,
            "total_tokens": 182,
            "input_tokens_details": {"cached_tokens": cached_tokens},
            "output_tokens_details": {"reasoning_tokens": reasoning_tokens},
        }
        events.append(("response.completed", {
            "type": "response.completed",
            "response": {
                "id": resp_id,
                "object": "response",
                "status": "completed",
                "model": model,
                "output": output_items,
                "usage": usage_obj,
            },
        }))

        parts = [f"event: {ev}\ndata: {json.dumps(pl)}\n\n".encode("utf-8") for ev, pl in events]
        full_resp = b"".join(parts)
        recorder.add({
            "method": "POST",
            "path": parsed_url.path,
            "query": parsed_url.query,
            "headers": dict(handler.headers.items()),
            "request_body": raw_body,
            "response_body": full_resp,
        })
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream")
        handler.send_header("Cache-Control", "no-cache")
        handler.end_headers()
        for p in parts:
            handler.wfile.write(p)
            handler.wfile.flush()
            time.sleep(0.005)
        return

    output_items = [
        {
            "id": "rs_ns_0",
            "type": "reasoning",
            "summary": [{"type": "summary_text", "text": "Non-stream responses reasoning summary."}],
        }
    ]
    if want_tool:
        output_items.append({
            "id": "fc_ns_1",
            "type": "function_call",
            "call_id": "call_resp_ns_1",
            "name": "shell",
            "arguments": json.dumps({"command": "pwd"}),
            "status": "completed",
        })
    else:
        reply_text = "Responses non-stream final answer after tool." if has_fn_output else "Responses API non-stream payload."
        output_items.append({
            "id": "msg_ns_1",
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "content": [{"type": "output_text", "text": reply_text}],
        })

    resp_obj = {
        "id": "resp_e2e_ns_1" if not has_fn_output else "resp_e2e_ns_2",
        "object": "response",
        "status": "completed",
        "model": model,
        "output": output_items,
        "usage": {
            "input_tokens": 130,
            "output_tokens": 36,
            "total_tokens": 166,
            "input_tokens_details": {"cached_tokens": cached_tokens},
            "output_tokens_details": {"reasoning_tokens": reasoning_tokens},
        },
    }
    full_resp = json.dumps(resp_obj, separators=(", ", ": ")).encode("utf-8")
    recorder.add({
        "method": "POST",
        "path": parsed_url.path,
        "query": parsed_url.query,
        "headers": dict(handler.headers.items()),
        "request_body": raw_body,
        "response_body": full_resp,
    })
    handler.send_response(200)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(full_resp)))
    handler.send_header("X-Mock-Upstream", "openai-responses")
    handler.end_headers()
    handler.wfile.write(full_resp)


def make_openai_handler(recorder):
    class OpenAIMockHandler(http.server.BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(length) if length > 0 else b""
            parsed_url = urllib.parse.urlsplit(self.path)
            decoded_body = raw_body
            if (self.headers.get("Content-Encoding", "").lower() == "gzip") or (len(raw_body) >= 2 and raw_body[0] == 0x1F and raw_body[1] == 0x8B):
                try:
                    decoded_body = gzip.decompress(raw_body)
                except Exception:
                    decoded_body = raw_body
            try:
                body = json.loads(decoded_body.decode("utf-8"))
            except Exception:
                body = {}

            if parsed_url.path.endswith("/responses"):
                _handle_openai_responses(self, recorder, parsed_url, raw_body, body)
                return

            is_stream = bool(body.get("stream", False))
            model = body.get("model", "gpt-4o-mini")
            messages = body.get("messages", [])
            tools = body.get("tools", [])

            has_tool_result = any(m.get("role") == "tool" for m in messages)
            joined_user = _extract_chat_user_text(messages)
            zero_cache = "ZERO_CACHE" in joined_user
            want_task_tool = ("USE_TOOL_TASK" in joined_user) and (not has_tool_result) and len(tools) > 0
            want_tool = ("USE_TOOL_READ" in joined_user) and (not has_tool_result) and len(tools) > 0
            want_reasoning = "WANT_REASONING" in joined_user

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

            usage_cached = 0 if zero_cache else 40

            if is_stream:
                chunks = []
                if want_reasoning:
                    chunks.append({
                        "id": "chatcmpl-e2e-stream-reason",
                        "object": "chat.completion.chunk",
                        "created": 1700000000,
                        "model": model,
                        "choices": [{
                            "index": 0,
                            "delta": {
                                "role": "assistant",
                                "reasoning_content": "Step-by-step chat reasoning.",
                            },
                            "finish_reason": None,
                        }],
                    })

                if want_tool or want_task_tool:
                    tc_id = "call_oai_task_1" if want_task_tool else "call_oai_read_1"
                    tc_name = "task" if want_task_tool else read_tool_name
                    tc_args = json.dumps({"prompt": "inspect subagent"}) if want_task_tool else json.dumps({"path": target_path})
                    chunks.append({
                        "id": "chatcmpl-e2e-stream-tool-1",
                        "object": "chat.completion.chunk",
                        "created": 1700000001,
                        "model": model,
                        "choices": [{
                            "index": 0,
                            "delta": {
                                "role": "assistant",
                                "content": "Let me invoke that tool.",
                                "tool_calls": [{
                                    "index": 0,
                                    "id": tc_id,
                                    "type": "function",
                                    "function": {
                                        "name": tc_name,
                                        "arguments": tc_args,
                                    },
                                }],
                            },
                            "finish_reason": None,
                        }],
                    })
                    usage = {
                        "prompt_tokens": 120,
                        "completion_tokens": 25,
                    }
                    if not zero_cache:
                        usage["prompt_tokens_details"] = {"cached_tokens": usage_cached}
                    chunks.append({
                        "id": "chatcmpl-e2e-stream-tool-1",
                        "object": "chat.completion.chunk",
                        "created": 1700000001,
                        "model": model,
                        "choices": [{
                            "index": 0,
                            "delta": {},
                            "finish_reason": "tool_calls",
                        }],
                        "usage": usage,
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
                            "finish_reason": None,
                        }],
                    })
                    usage = {
                        "prompt_tokens": 150,
                        "completion_tokens": 30,
                    }
                    if not zero_cache:
                        usage["prompt_tokens_details"] = {"cached_tokens": 50}
                    chunks.append({
                        "id": "chatcmpl-e2e-stream-2",
                        "object": "chat.completion.chunk",
                        "created": 1700000002,
                        "model": model,
                        "choices": [{
                            "index": 0,
                            "delta": {"content": reply_text[12:]},
                            "finish_reason": "stop",
                        }],
                        "usage": usage,
                    })

                parts = [("data: " + json.dumps(c) + "\n\n").encode("utf-8") for c in chunks]
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
                    time.sleep(0.005)
            else:
                if want_tool or want_task_tool:
                    tc_id = "call_oai_ns_task_1" if want_task_tool else "call_oai_ns_1"
                    tc_name = "task" if want_task_tool else read_tool_name
                    tc_args = json.dumps({"prompt": "run subagent"}) if want_task_tool else json.dumps({"path": target_path})
                    msg_obj = {
                        "role": "assistant",
                        "content": "Calling tool now.",
                        "tool_calls": [{
                            "id": tc_id,
                            "type": "function",
                            "function": {
                                "name": tc_name,
                                "arguments": tc_args,
                            },
                        }],
                    }
                    if want_reasoning:
                        msg_obj["reasoning_content"] = "Non-stream reasoning before tool."
                    usage = {"prompt_tokens": 110, "completion_tokens": 22}
                    if not zero_cache:
                        usage["prompt_tokens_details"] = {"cached_tokens": 10}
                    resp_obj = {
                        "id": "chatcmpl-e2e-nonstream-tool",
                        "object": "chat.completion",
                        "created": 1700000003,
                        "model": model,
                        "choices": [{
                            "index": 0,
                            "message": msg_obj,
                            "finish_reason": "tool_calls",
                        }],
                        "usage": usage,
                    }
                else:
                    reply_text = "OpenAI non-stream final answer after tool." if has_tool_result else "OpenAI non-stream response payload."
                    msg_obj = {
                        "role": "assistant",
                        "content": reply_text,
                    }
                    if want_reasoning:
                        msg_obj["reasoning_content"] = "Non-stream reasoning text."
                    usage = {"prompt_tokens": 90, "completion_tokens": 15}
                    if not zero_cache:
                        usage["prompt_tokens_details"] = {"cached_tokens": 20}
                    resp_obj = {
                        "id": "chatcmpl-e2e-nonstream-1",
                        "object": "chat.completion",
                        "created": 1700000004,
                        "model": model,
                        "choices": [{
                            "index": 0,
                            "message": msg_obj,
                            "finish_reason": "stop",
                        }],
                        "usage": usage,
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

        def do_HEAD(self):
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()

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

            tool_names = {t.get("name", "") for t in tools if isinstance(t, dict)}
            if "Read" in tool_names:
                ant_tool_name = "Read"
                ant_tool_input = {"file_path": target_path}
            else:
                ant_tool_name = "read"
                ant_tool_input = {"path": target_path}

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
                            "output_tokens": 1,
                        },
                    },
                }))
                events.append(("content_block_start", {
                    "type": "content_block_start",
                    "index": 0,
                    "content_block": {"type": "thinking", "thinking": ""},
                }))
                events.append(("content_block_delta", {
                    "type": "content_block_delta",
                    "index": 0,
                    "delta": {"type": "thinking_delta", "thinking": "Analyzing the request carefully."},
                }))
                events.append(("content_block_stop", {
                    "type": "content_block_stop",
                    "index": 0,
                }))

                if want_tool:
                    events.append(("content_block_start", {
                        "type": "content_block_start",
                        "index": 1,
                        "content_block": {"type": "text", "text": ""},
                    }))
                    events.append(("content_block_delta", {
                        "type": "content_block_delta",
                        "index": 1,
                        "delta": {"type": "text_delta", "text": "Reading the file now."},
                    }))
                    events.append(("content_block_stop", {
                        "type": "content_block_stop",
                        "index": 1,
                    }))
                    events.append(("content_block_start", {
                        "type": "content_block_start",
                        "index": 2,
                        "content_block": {
                            "type": "tool_use",
                            "id": "toolu_ant_read_1",
                            "name": ant_tool_name,
                            "input": {},
                        },
                    }))
                    events.append(("content_block_delta", {
                        "type": "content_block_delta",
                        "index": 2,
                        "delta": {
                            "type": "input_json_delta",
                            "partial_json": json.dumps(ant_tool_input),
                        },
                    }))
                    events.append(("content_block_stop", {
                        "type": "content_block_stop",
                        "index": 2,
                    }))
                    stop_reason = "tool_use"
                    out_tokens = 35
                else:
                    reply_text = "Anthropic mock final answer after tool." if has_tool_result else "Anthropic mock stream answer."
                    events.append(("content_block_start", {
                        "type": "content_block_start",
                        "index": 1,
                        "content_block": {"type": "text", "text": ""},
                    }))
                    events.append(("content_block_delta", {
                        "type": "content_block_delta",
                        "index": 1,
                        "delta": {"type": "text_delta", "text": reply_text},
                    }))
                    events.append(("content_block_stop", {
                        "type": "content_block_stop",
                        "index": 1,
                    }))
                    stop_reason = "end_turn"
                    out_tokens = 28

                events.append(("message_delta", {
                    "type": "message_delta",
                    "delta": {"stop_reason": stop_reason, "stop_sequence": None},
                    "usage": {"output_tokens": out_tokens},
                }))
                events.append(("message_stop", {"type": "message_stop"}))

                parts = [f"event: {ev_name}\ndata: {json.dumps(payload)}\n\n".encode("utf-8") for ev_name, payload in events]
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
                    time.sleep(0.005)
            else:
                content = [
                    {"type": "thinking", "thinking": "Non-stream thinking block."},
                    {"type": "text", "text": "Anthropic non-stream response."},
                ]
                stop_reason = "end_turn"
                if want_tool:
                    content.append({
                        "type": "tool_use",
                        "id": "toolu_ant_ns_1",
                        "name": "read",
                        "input": {"path": target_path},
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
                        "output_tokens": 18,
                    },
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
