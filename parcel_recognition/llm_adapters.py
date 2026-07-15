"""Pluggable LLM transports that all receive the same image, prompt, and schema."""

from __future__ import annotations

import importlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


@dataclass(frozen=True)
class LlmRequest:
    image_path: Path
    prompt: str
    schema: dict[str, Any]
    model: str | None = None
    max_turns: int = 10


@dataclass(frozen=True)
class LlmResult:
    payload: dict[str, Any]
    usage: dict[str, Any]


LlmAdapter = Callable[[LlmRequest], LlmResult]
_ADAPTERS: dict[str, LlmAdapter] = {}


def register_adapter(name: str, *aliases: str) -> Callable[[LlmAdapter], LlmAdapter]:
    """Register an adapter under a stable engine name and optional aliases."""
    def decorator(adapter: LlmAdapter) -> LlmAdapter:
        for key in (name, *aliases):
            if key in _ADAPTERS and _ADAPTERS[key] is not adapter:
                raise ValueError(f"LLM adapter already registered: {key}")
            _ADAPTERS[key] = adapter
        return adapter
    return decorator


def available_adapters() -> list[str]:
    return sorted(_ADAPTERS)


def _parse_codex_tokens(output: str) -> str:
    match = re.search(r"tokens used\s*\n?\s*([\d,]+)", output, re.IGNORECASE)
    return match.group(1) if match else "unknown"


@register_adapter("claude-cli", "claude")
def claude_cli(request: LlmRequest) -> LlmResult:
    """Run any Claude model exposed by the logged-in local Claude CLI."""
    binary = shutil.which("claude")
    if not binary:
        raise RuntimeError("claude CLI not found; install/login or choose another --engine")
    model = request.model or "sonnet"
    full_prompt = f"First use the Read tool to view this image: {request.image_path.resolve()}\n\n{request.prompt}"
    command = [
        binary, "-p", full_prompt,
        "--output-format", "json",
        "--json-schema", json.dumps(request.schema),
        "--allowedTools", "Read",
        "--permission-mode", "dontAsk",
        "--max-turns", str(request.max_turns),
        "--model", model,
        "--no-session-persistence",
    ]
    env = dict(os.environ)
    for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_KEY", "CLAUDE_API_KEY"):
        env.pop(key, None)
    started = time.monotonic()
    process = subprocess.run(command, capture_output=True, text=True, timeout=600, env=env)
    if process.returncode:
        detail = (process.stderr or process.stdout)[-800:]
        raise RuntimeError(f"claude CLI exited {process.returncode}: {detail}")
    wrapper = json.loads(process.stdout.strip().splitlines()[-1])
    if wrapper.get("is_error"):
        raise RuntimeError(f"claude CLI error: {wrapper.get('result')}")
    payload = wrapper.get("structured_output")
    if not isinstance(payload, dict):
        raise RuntimeError("claude CLI returned no structured_output")
    raw_usage = wrapper.get("usage") or {}
    model_usage = wrapper.get("modelUsage") or {}
    return LlmResult(payload=payload, usage={
        "engine": "claude-cli",
        "model": next(iter(model_usage), model),
        "elapsed_seconds": round(time.monotonic() - started, 2),
        "input_tokens": raw_usage.get("input_tokens"),
        "cache_read_input_tokens": raw_usage.get("cache_read_input_tokens"),
        "output_tokens": raw_usage.get("output_tokens"),
        "turns": wrapper.get("num_turns"),
        "nominal_cost_usd": wrapper.get("total_cost_usd", 0),
        "billing": "Claude subscription; nominal API-equivalent cost shown",
    })


@register_adapter("codex-cli", "codex")
def codex_cli(request: LlmRequest) -> LlmResult:
    """Run any vision-capable model exposed by the logged-in local Codex CLI."""
    binary = shutil.which("codex")
    if not binary:
        raise RuntimeError("codex CLI not found; install/login or choose another --engine")
    with tempfile.TemporaryDirectory(prefix="parcel-recognition-") as temp_dir:
        schema_path = Path(temp_dir) / "schema.json"
        result_path = Path(temp_dir) / "result.json"
        schema_path.write_text(json.dumps(request.schema), encoding="utf-8")
        command = [
            binary, "exec", "-i", str(request.image_path.resolve()),
            "--output-schema", str(schema_path),
            "-o", str(result_path),
            "--ephemeral", "--skip-git-repo-check",
            "-s", "read-only",
            "-c", 'model_reasoning_effort="medium"',
            "--color", "never",
        ]
        if request.model:
            command.extend(["-m", request.model])
        command.append(f"The attached image is the satellite image to analyse.\n\n{request.prompt}")
        env = dict(os.environ)
        for key in ("OPENAI_API_KEY", "OPENAI_KEY", "OAI_API_KEY"):
            env.pop(key, None)
        started = time.monotonic()
        process = subprocess.run(
            command, capture_output=True, text=True, timeout=600,
            env=env, stdin=subprocess.DEVNULL,
        )
        if process.returncode:
            detail = (process.stderr or process.stdout)[-800:]
            raise RuntimeError(f"codex CLI exited {process.returncode}: {detail}")
        try:
            payload = json.loads(result_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"codex CLI result is not valid JSON: {exc}") from exc
        combined = f"{process.stdout}\n{process.stderr}"
        model_match = re.search(r"^model:\s*(\S+)", combined, re.MULTILINE)
        return LlmResult(payload=payload, usage={
            "engine": "codex-cli",
            "model": model_match.group(1) if model_match else (request.model or "codex-config-default"),
            "elapsed_seconds": round(time.monotonic() - started, 2),
            "tokens": _parse_codex_tokens(combined),
            "nominal_cost_usd": None,
            "billing": "ChatGPT subscription",
        })


def load_adapter(spec: str) -> LlmAdapter:
    """Load `package.module:function`; the function must accept one LlmRequest."""
    if ":" not in spec:
        raise ValueError("custom adapter must use package.module:function syntax")
    module_name, function_name = spec.rsplit(":", 1)
    module = importlib.import_module(module_name)
    adapter = getattr(module, function_name, None)
    if not callable(adapter):
        raise ValueError(f"custom adapter is not callable: {spec}")
    return adapter


def run_llm(request: LlmRequest, engine: str, custom_adapter: str | None = None) -> LlmResult:
    """Execute a built-in or imported adapter and normalize its result metadata."""
    adapter = load_adapter(custom_adapter) if custom_adapter else _ADAPTERS.get(engine)
    if not adapter:
        names = ", ".join(available_adapters())
        raise ValueError(f"unknown LLM engine '{engine}'; built-ins: {names}; or pass --llm-adapter")
    result = adapter(request)
    if isinstance(result, tuple) and len(result) == 2:
        result = LlmResult(payload=result[0], usage=result[1])
    elif isinstance(result, dict):
        result = LlmResult(payload=result, usage={})
    if not isinstance(result, LlmResult) or not isinstance(result.payload, dict):
        raise TypeError("LLM adapter must return LlmResult, (payload, usage), or a payload dict")
    usage = dict(result.usage)
    usage.setdefault("engine", custom_adapter or engine)
    usage.setdefault("model", request.model or "adapter-default")
    usage.setdefault("elapsed_seconds", 0)
    usage.setdefault("nominal_cost_usd", None)
    usage.setdefault("billing", "adapter did not report billing")
    return LlmResult(payload=result.payload, usage=usage)

