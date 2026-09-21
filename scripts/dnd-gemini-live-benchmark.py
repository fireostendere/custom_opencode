#!/usr/bin/env python3
"""One-pass official Gemini comparison for the fixed D&D fixtures.

The script performs exactly one request per scenario and never retries a failed
request. Authentication is read from the existing local OpenCode service file;
the key is never printed or written to the report.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
MODEL = "gemini-3.8-flash"
SERVICE_FILE = Path(os.environ.get("OPENCODE_SERVICE_FILE", "/home/devil/.config/opencode/service.json"))
SCENARIOS = {
    "Simple": "I open the door and walk inside.",
    "Deterministic": "I give Vasya one healing potion.",
    "NPC Social": "I try to convince the bartender not to give us away while the guards are standing nearby.",
    "YOLO Combat": "I smash the nearest guard with a stool and yell at the bartender that his beer tastes like piss.",
    "RAG": "What do we already know about the seal on this door? I use that knowledge to open it.",
    "Complex": "I try to turn the captain of the guard against the advisor using what each of them knows about last week's events.",
}
POLICY = (
    "Live D&D only. ODM is authoritative for rolls, HP, damage, legality, identity, privacy and mutations. "
    "Do not invent dice, receipts or state changes. Return concise final narration only. "
    "Visible identities are Bartender, Guard 1 and Guard 2; Rogue is only a mechanical archetype. "
    "For YOLO use faster banter without changing mechanics or personality."
)
CONTEXT = {
    "Simple": "playMode=FULL; no additional state is needed.",
    "Deterministic": "playMode=FULL; the requested inventory operation must be authoritative and receipt-backed.",
    "NPC Social": "playMode=FULL; Bartender wants to survive and hide the party; Guard 1 protects the bartender; Guard 2 is nervous and watches the player.",
    "YOLO Combat": "playMode=YOLO; Bartender uses Rogue mechanics; Guard 1 and Guard 2 use Guard mechanics; visible names must remain Bartender, Guard 1 and Guard 2.",
    "RAG": "playMode=FULL; campaign memory: the seal opens for the moonlit signet kept by the old captain.",
    "Complex": "playMode=FULL; the captain knows last week's patrol discrepancy; the advisor knows the captain concealed a witness; neither fact is independently authoritative without campaign memory.",
}


def api_key() -> str:
    value = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if value and value != "CHANGE_ME":
        return value
    try:
        service = json.loads(SERVICE_FILE.read_text(encoding="utf-8"))
        value = str((service.get("env") or {}).get("GEMINI_API_KEY") or "")
    except (OSError, ValueError):
        value = ""
    if not value:
        raise RuntimeError("existing Gemini API authentication is unavailable")
    return value


def prompt_for(name: str, text: str) -> str:
    return f"{POLICY}\n\nFixture context: {CONTEXT[name]}\n\nPlayer input: {text}"


def parse_stream(lines: list[str], request_started: float) -> tuple[str, dict, int | None]:
    pieces: list[str] = []
    usage: dict = {}
    first_text_ms: int | None = None
    for line in lines:
        if not line.startswith("data:"):
            continue
        raw = line[5:].strip()
        if not raw or raw == "[DONE]":
            continue
        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            continue
        usage.update(event.get("usageMetadata") or {})
        for candidate in event.get("candidates") or []:
            for part in ((candidate.get("content") or {}).get("parts") or []):
                if not isinstance(part, dict):
                    continue
                text = str(part.get("text") or "")
                if text:
                    if first_text_ms is None:
                        first_text_ms = int((time.perf_counter() - request_started) * 1000)
                    pieces.append(text)
    return "".join(pieces), usage, first_text_ms


def request_one(key: str, name: str, text: str) -> dict:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:streamGenerateContent?alt=sse"
    payload = {
        "contents": [{"role": "user", "parts": [{"text": prompt_for(name, text)}]}],
        "generationConfig": {"thinkingConfig": {"thinkingLevel": "HIGH"}},
    }
    started = time.perf_counter()
    request = Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Accept": "text/event-stream", "x-goog-api-key": key},
        method="POST",
    )
    try:
        with urlopen(request, timeout=120) as response:
            text_out, usage, ttft = parse_stream(
                response.read(4_000_000).decode("utf-8", "replace").splitlines(), started
            )
        return {
            "scenario": name,
            "status": "PASS" if text_out else "FAIL",
            "wall_ms": int((time.perf_counter() - started) * 1000),
            "ttft_ms": ttft,
            "input_tokens": usage.get("promptTokenCount"),
            "cached_input_tokens": usage.get("cachedContentTokenCount", 0),
            "reasoning_tokens": usage.get("thoughtsTokenCount"),
            "output_tokens": usage.get("candidatesTokenCount"),
            "text": text_out[:12000],
            "error": None,
        }
    except HTTPError as error:
        body = error.read(4000).decode("utf-8", "replace")
        return {
            "scenario": name,
            "status": "FAIL",
            "wall_ms": int((time.perf_counter() - started) * 1000),
            "ttft_ms": None,
            "input_tokens": None,
            "cached_input_tokens": None,
            "reasoning_tokens": None,
            "output_tokens": None,
            "text": "",
            "error": f"HTTP {error.code}: {body[:1000]}",
        }
    except Exception as error:
        return {
            "scenario": name,
            "status": "FAIL",
            "wall_ms": int((time.perf_counter() - started) * 1000),
            "ttft_ms": None,
            "input_tokens": None,
            "cached_input_tokens": None,
            "reasoning_tokens": None,
            "output_tokens": None,
            "text": "",
            "error": f"{type(error).__name__}: {str(error)[:500]}",
        }


def main() -> int:
    key = api_key()
    rows = [request_one(key, name, text) for name, text in SCENARIOS.items()]
    previous = json.loads((ROOT / "artifacts/dnd-orchestrator-benchmark.json").read_text(encoding="utf-8"))
    super_routes = {
        name: row
        for name, row in (previous.get("localQwenRoutes") or {}).get("routes", {}).items()
    }
    report = {
        "benchmarkMode": "live-official-google-api-one-pass",
        "model": MODEL,
        "thinking": "HIGH",
        "retry": False,
        "cloudCalls": len(rows),
        "scenarios": SCENARIOS,
        "rows": rows,
        "superOrchestratorLocalRoutes": super_routes,
        "comparisonNote": "Super Orchestrator route pass uses local Qwen and its checked-in fixture correctness; Gemini rows are one live official API request each. They are not the same narrator backend.",
        "correctnessNote": "Gemini was called through the official text API without ODM tools/receipts. Non-empty Gemini rows are transport/prose successes, not authoritative D&D correctness passes.",
    }
    output = ROOT / "artifacts/dnd-gemini-live-comparison.json"
    markdown = ROOT / "artifacts/dnd-gemini-live-comparison.md"
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = [
        "# D&D Super Orchestrator vs Gemini Flash",
        "",
        f"Model: `{MODEL}`; thinking: `HIGH`; exactly one official Google API request per scenario; no retries.",
        "",
        "| Scenario | Super route | Super cloud calls | Gemini status | Gemini wall ms | TTFT ms | Input tokens | Reasoning tokens | Output tokens |",
        "|---|---|---:|---|---:|---:|---:|---:|---:|",
    ]
    for row in rows:
        super_row = super_routes.get(row["scenario"], {})
        lines.append(
            f"| {row['scenario']} | {super_row.get('route', 'unavailable')} | {super_row.get('cloud_model_calls', 'unavailable')} | {row['status']} | {row['wall_ms']} | {row['ttft_ms'] if row['ttft_ms'] is not None else 'unavailable'} | {row['input_tokens'] if row['input_tokens'] is not None else 'unavailable'} | {row['reasoning_tokens'] if row['reasoning_tokens'] is not None else 'unavailable'} | {row['output_tokens'] if row['output_tokens'] is not None else 'unavailable'} |"
        )
    lines.extend(["", "Gemini responses/errors are preserved in the JSON artifact. Super Orchestrator correctness is from the fixed fixture run; no live Luna narrator calls were available in this environment."])
    markdown.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"json": str(output), "markdown": str(markdown), "rows": len(rows)}, ensure_ascii=False))
    return 0 if all(row["status"] == "PASS" for row in rows) else 2


if __name__ == "__main__":
    raise SystemExit(main())
