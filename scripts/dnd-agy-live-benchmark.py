#!/usr/bin/env python3
"""Run the fixed D&D prompts through the installed AGY client once each."""
from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import subprocess
import time


ROOT = Path(__file__).resolve().parents[1]
SERVICE_FILE = Path(os.environ.get("OPENCODE_SERVICE_FILE", str(Path.home() / ".config/opencode/service.json")))
MODEL = "gemini-3.8-flash"
SCENARIOS = {
    "Simple": "I open the door and walk inside.",
    "Deterministic": "I give Vasya one healing potion.",
    "NPC Social": "I try to convince the bartender not to give us away while the guards are standing nearby.",
    "YOLO Combat": "I smash the nearest guard with a stool and yell at the bartender that his beer tastes like piss.",
    "RAG": "What do we already know about the seal on this door? I use that knowledge to open it.",
    "Complex": "I try to turn the captain of the guard against the advisor using what each of them knows about last week's events.",
}
CONTEXT = {
    "Simple": "playMode=FULL; no additional state is needed.",
    "Deterministic": "playMode=FULL; ODM must confirm the inventory mutation; no receipt is available in this text-only test.",
    "NPC Social": "playMode=FULL; Bartender wants to survive and hide the party; Guard 1 protects the bartender; Guard 2 is nervous and watches the player.",
    "YOLO Combat": "playMode=YOLO; Bartender uses Rogue mechanics; Guard 1 and Guard 2 use Guard mechanics; visible identities remain Bartender, Guard 1 and Guard 2.",
    "RAG": "playMode=FULL; campaign memory says the seal opens for the moonlit signet kept by the old captain.",
    "Complex": "playMode=FULL; captain knows a patrol discrepancy; advisor knows the captain concealed a witness; these are campaign facts, not newly-authoritative mutations.",
}
POLICY = (
    "D&D narrator. No tools. ODM owns dice, HP, damage, legality, identity, privacy and mutations; never invent them. "
    "Preserve visible identities; Rogue is only mechanics. FULL is grounded; YOLO is bantering but still coherent. "
    "Return only concise final narration, max 80 words."
)


def key_from_service() -> str:
    service = json.loads(SERVICE_FILE.read_text(encoding="utf-8"))
    key = str((service.get("env") or {}).get("GEMINI_API_KEY") or "")
    if not key:
        raise RuntimeError("GEMINI_API_KEY missing from existing AGY/OpenCode service configuration")
    return key


def parse_result(raw: str) -> dict:
    for line in reversed(raw.splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and ("response" in value or "status" in value):
            return value
    return {"status": "ERROR", "error": raw[-2000:]}


def run_one(key: str, name: str, player_input: str) -> dict:
    prompt = f"{POLICY} Context: {CONTEXT[name]} Player: {player_input}"
    env = os.environ.copy()
    env["GEMINI_API_KEY"] = key
    env["GOOGLE_API_KEY"] = ""
    started = time.perf_counter()
    process = None
    try:
        process = subprocess.Popen(
            [
                "agy",
                f"--print={prompt}",
                "--model",
                MODEL,
                "--effort",
                "high",
                "--output-format",
                "json",
                "--disable-slash-commands",
            ],
            cwd="/tmp",
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
        stdout, _ = process.communicate(timeout=45)
        parsed = parse_result(stdout)
        response = str(parsed.get("response") or "").strip()
        return {
            "scenario": name,
            "status": "PASS" if process.returncode == 0 and response else "FAIL",
            "wall_ms": int((time.perf_counter() - started) * 1000),
            "duration_seconds": parsed.get("duration_seconds"),
            "turns": parsed.get("num_turns"),
            "input_tokens": (parsed.get("usage") or {}).get("input_tokens"),
            "cache_read_tokens": (parsed.get("usage") or {}).get("cache_read_tokens"),
            "thinking_tokens": (parsed.get("usage") or {}).get("thinking_tokens"),
            "output_tokens": (parsed.get("usage") or {}).get("output_tokens"),
            "response": response[:16000],
            "error": None if process.returncode == 0 else stdout[-3000:],
        }
    except subprocess.TimeoutExpired:
        if process is not None:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, _ = process.communicate()
        return {
            "scenario": name,
            "status": "FAIL",
            "wall_ms": int((time.perf_counter() - started) * 1000),
            "duration_seconds": None,
            "turns": None,
            "input_tokens": None,
            "cache_read_tokens": None,
            "thinking_tokens": None,
            "output_tokens": None,
            "response": "",
            "error": "AGY_TIMEOUT: " + stdout[-3000:],
        }
    except Exception as error:
        return {
            "scenario": name,
            "status": "FAIL",
            "wall_ms": int((time.perf_counter() - started) * 1000),
            "duration_seconds": None,
            "turns": None,
            "input_tokens": None,
            "cache_read_tokens": None,
            "thinking_tokens": None,
            "output_tokens": None,
            "response": "",
            "error": f"{type(error).__name__}: {str(error)[:500]}",
        }


def main() -> int:
    key = key_from_service()
    rows = []
    for name, text in SCENARIOS.items():
        row = run_one(key, name, text)
        rows.append(row)
        print(json.dumps({"scenario": name, "status": row["status"], "wall_ms": row["wall_ms"]}, ensure_ascii=False), flush=True)
    prior = json.loads((ROOT / "artifacts/dnd-orchestrator-benchmark.json").read_text(encoding="utf-8"))
    routes = (prior.get("localQwenRoutes") or {}).get("routes", {})
    report = {
        "benchmarkMode": "live-agy-one-pass",
        "client": "agy 1.2.7",
        "model": MODEL,
        "effort": "high",
        "retry": False,
        "cloudCalls": len(rows),
        "scenarios": SCENARIOS,
        "rows": rows,
        "superOrchestratorLocalRoutes": routes,
        "correctnessNote": "AGY was deliberately run without D&D MCP tools. Responses are narrative/protocol observations; authoritative mechanics remain unavailable in this text-only proxy test.",
    }
    output = ROOT / "artifacts/dnd-agy-live-comparison.json"
    markdown = ROOT / "artifacts/dnd-agy-live-comparison.md"
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = [
        "# D&D Super Orchestrator vs AGY Gemini",
        "",
        f"Client: `agy 1.2.7`; model: `{MODEL}`; effort: `high`; exactly one request per scenario; no retries.",
        "",
        "| Scenario | Super route | Super cloud calls | AGY status | Wall ms | AGY duration s | Input tokens | Thinking tokens | Output tokens |",
        "|---|---|---:|---|---:|---:|---:|---:|---:|",
    ]
    for row in rows:
        route = routes.get(row["scenario"], {})
        lines.append(
            f"| {row['scenario']} | {route.get('route', 'unavailable')} | {route.get('cloud_model_calls', 'unavailable')} | {row['status']} | {row['wall_ms']} | {row['duration_seconds'] if row['duration_seconds'] is not None else 'unavailable'} | {row['input_tokens'] if row['input_tokens'] is not None else 'unavailable'} | {row['thinking_tokens'] if row['thinking_tokens'] is not None else 'unavailable'} | {row['output_tokens'] if row['output_tokens'] is not None else 'unavailable'} |"
        )
    lines.extend(["", "AGY responses are preserved in the JSON artifact. No ODM MCP tools were attached, so this is a narrator/proxy comparison, not an authoritative combat correctness test."])
    markdown.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"json": str(output), "markdown": str(markdown), "rows": len(rows)}, ensure_ascii=False))
    return 0 if all(row["status"] == "PASS" for row in rows) else 2


if __name__ == "__main__":
    raise SystemExit(main())
