#!/usr/bin/env python3
"""Measure the local D&D router without touching cloud providers."""
from __future__ import annotations

import argparse
import json
import os
from statistics import median
import time
from urllib.error import URLError
from urllib.request import Request, urlopen


def request_json(url: str, payload: dict | None = None, timeout: float = 5.0) -> dict:
    request = Request(
        url,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST" if payload is not None else "GET",
    )
    with urlopen(request, timeout=timeout) as response:
        raw = response.read(256 * 1024) or b"{}"
    if payload is None and raw.strip() == b"Ollama is running":
        return {"backend": "ollama"}
    return json.loads(raw)


def classify(url: str, model: str, text: str, timeout: float) -> tuple[int, dict]:
    started = time.perf_counter()
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "Return exactly one uppercase token: A=NO_LLM B=TOOL C=LUNA_LOW D=LUNA_XHIGH E=SOL_XHIGH. Never think."},
            {"role": "user", "content": text},
        ],
        "stream": False,
    }
    if ":11434" in url:
        payload.update({"think": False, "options": {"temperature": 0, "num_predict": 1}})
        endpoint = url.rstrip("/").removesuffix("/v1") + "/api/chat"
    else:
        payload.update({"temperature": 0, "max_tokens": 1, "logprobs": True, "top_logprobs": 5})
        endpoint = url.rstrip("/") + "/chat/completions"
    result = request_json(endpoint, payload, timeout)
    return int((time.perf_counter() - started) * 1000), result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default=os.environ.get("DND_QWEN_URL", "http://127.0.0.1:11434/v1"))
    parser.add_argument("--health", default=os.environ.get("DND_QWEN_HEALTH_URL", "http://127.0.0.1:11434/"))
    parser.add_argument("--model", default=os.environ.get("DND_QWEN_MODEL", "custom-opencode-qwen35-4b-q4km"))
    parser.add_argument("--repetitions", type=int, default=20)
    args = parser.parse_args()
    report = {
        "model": args.model,
        "quant": "Q4_K_M",
        "source": "openresearchtools/Qwen3.5-4B-Instruct-GGUF@4fa3cee/qwen3.5-4b-instruct-Q4_K_M.gguf",
        "backend": "unavailable",
        "backendVersion": "unavailable",
        "vram": "unavailable",
        "loadMs": None,
        "pp512": "unavailable",
        "tg128": "unavailable",
        "decisionMode": "constrained-token",
    }
    try:
        health = request_json(args.health)
        report["backend"] = health.get("backend", "local")
        report["backendVersion"] = health.get("version", "unavailable")
    except Exception as exc:
        report["error"] = type(exc).__name__
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 2
    samples = []
    fixture = "I try to convince the bartender not to give us away while two guards watch."
    for _ in range(max(1, args.repetitions)):
        try:
            elapsed, response = classify(args.url, args.model, fixture, 10.0)
            samples.append(elapsed)
            if not report.get("sampleResponse"):
                choice = (response.get("choices") or [{}])[0]
                message = choice.get("message") or response.get("message") or {}
                report["sampleResponse"] = str(message.get("content") or "")[:8]
        except Exception as exc:
            report["error"] = type(exc).__name__
            break
    if samples:
        report["loadMs"] = samples[0]
        ordered = sorted(samples)
        warm = samples[1:] or samples
        warm_ordered = sorted(warm)
        report["routerWarmMs"] = int(median(warm))
        report["routerP50Ms"] = ordered[len(ordered) // 2]
        report["routerP95Ms"] = ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))]
        report["routerWarmP50Ms"] = warm_ordered[len(warm_ordered) // 2]
        report["routerWarmP95Ms"] = warm_ordered[min(len(warm_ordered) - 1, int(len(warm_ordered) * 0.95))]
    if ":11434" in args.url:
        base = args.url.rstrip("/").removesuffix("/v1")
        try:
            version = request_json(base + "/api/version")
            report["backendVersion"] = version.get("version", report["backendVersion"])
            throughput = request_json(
                base + "/api/generate",
                {
                    "model": args.model,
                    "prompt": "x " * 512,
                    "stream": False,
                    "think": False,
                    "options": {"temperature": 0, "num_predict": 128},
                },
                30.0,
            )
            prompt_tokens = int(throughput.get("prompt_eval_count") or 0)
            prompt_ns = int(throughput.get("prompt_eval_duration") or 0)
            output_tokens = int(throughput.get("eval_count") or 0)
            output_ns = int(throughput.get("eval_duration") or 0)
            if prompt_tokens and prompt_ns:
                report["pp512"] = round(prompt_tokens / (prompt_ns / 1_000_000_000), 1)
                report["pp512Tokens"] = prompt_tokens
            if output_tokens and output_ns:
                report["tg128"] = round(output_tokens / (output_ns / 1_000_000_000), 1)
                report["tg128Tokens"] = output_tokens
        except Exception as exc:
            report["throughputError"] = type(exc).__name__
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if samples else 2


if __name__ == "__main__":
    raise SystemExit(main())
