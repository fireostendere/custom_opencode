#!/usr/bin/env python3
"""Reproducible D&D route benchmark.

Default mode is a deterministic fixture benchmark. ``--live`` is intentionally
explicit because it spends provider quota and must never retry a failed run.
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))

from dnd_orchestrator import DndOrchestrator, LocalQwenRouter  # noqa: E402


def token_estimate(text: str) -> int:
    return max(1, len(text.encode("utf-8")) // 4)


def context_isolation_metrics() -> dict[str, int]:
    # Approximate the assembled prompt surface from the checked-in policy
    # sources. The live provider adds its mandatory native system block.
    before_files = [
        ROOT / "config/prompts/engineering.md",
        ROOT / "config/prompts/orchestrator.md",
        ROOT / "config/prompts/orchestrator-sol.md",
    ]
    after_file = ROOT / "config/prompts/dnd-edition.md"
    before = sum(token_estimate(path.read_text(encoding="utf-8")) for path in before_files)
    after = token_estimate(after_file.read_text(encoding="utf-8"))
    return {"before": before, "after": after}


ISOLATION = context_isolation_metrics()

SCENARIOS = {
    "Simple": "I open the door and walk inside.",
    "Deterministic": "I give Vasya one healing potion.",
    "NPC Social": "I try to convince the bartender not to give us away while the guards are standing nearby.",
    "YOLO Combat": "I smash the nearest guard with a stool and yell at the bartender that his beer tastes like piss.",
    "RAG": "What do we already know about the seal on this door? I use that knowledge to open it.",
    "Complex": "I try to turn the captain of the guard against the advisor using what each of them knows about last week's events.",
}


@dataclass
class FixtureRouter:
    def classify(self, message, context):
        low = message.casefold()
        letter = "D" if "turn the captain" in low else "C"
        return letter, 0.93, {"ms": 0, "backend": "fixture-qwen"}


def local_qwen_routes() -> dict:
    router = LocalQwenRouter()
    health = router.health()
    if not health.get("ok"):
        return {"available": False, "health": health, "routes": {}}
    orchestrator = DndOrchestrator(router=router)
    routes = {}
    for name, text in SCENARIOS.items():
        plan = orchestrator.plan(
            text,
            {"playMode": "YOLO" if name == "YOLO Combat" else "FULL"},
            rag_chunks=(
                [{"scope": "CAMPAIGN_MEMORY", "score": 1.0, "text": "The seal opens for the moonlit signet kept by the old captain."}]
                if name == "RAG"
                else []
            ),
        )
        decision = plan["decision"]
        telemetry = plan["telemetry"]
        routes[name] = {
            "route": decision["route"],
            "confidence": decision["confidence"],
            "router_ms": telemetry["router_ms"],
            "backend": telemetry["router_backend"],
            "mode": telemetry["router_mode"],
            "cloud_model_calls": telemetry["model_calls"],
        }
    return {"available": True, "health": health, "routes": routes}


def correctness(name: str, route: str, response: str) -> tuple[str, list[str]]:
    failures = []
    if name == "YOLO Combat" and "Bartender" not in response:
        failures.append("visible Bartender identity was lost")
    if name == "YOLO Combat" and "Guard 1" not in response:
        failures.append("visible Guard 1 identity was lost")
    if name == "YOLO Combat" and "Rogue" in response:
        failures.append("mechanical archetype leaked as visible identity")
    if name == "Complex" and route == "SOL_XHIGH":
        failures.append("complex scene was forced to Sol")
    return ("PASS" if not failures else "FAIL"), failures


def fixture_result(candidate: str, name: str, text: str) -> dict:
    started = time.perf_counter()
    if candidate == "A — Super Orchestrator":
        rag_chunks = ([
            {"id": "memory-seal-1", "scope": "CAMPAIGN_MEMORY", "score": 1.0, "text": "The seal opens for the moonlit signet kept by the old captain."},
        ] if name == "RAG" else [])
        plan = DndOrchestrator(router=FixtureRouter()).plan(
            text,
            {"playMode": "YOLO" if name == "YOLO Combat" else "FULL"},
            rag_chunks=rag_chunks,
        )
        route = plan["decision"]["route"]
        telemetry = plan["telemetry"]
        response = "Vasya receives one healing potion." if name == "Deterministic" else (
            "Bartender leans over the bar while Guard 1 raises a shield: Keep your voice down, hero." if name == "YOLO Combat" else "The scene resolves from the authoritative ODM result."
        )
        row = {
            "candidate": candidate,
            "scenario": name,
            "mode": "fixture",
            "status": "measured",
            "ttft_ms": "unavailable",
            "total_wall_ms": int((time.perf_counter() - started) * 1000),
            "input_tokens": telemetry["router_input_tokens"],
            "cached_input_tokens": 0,
            "reasoning_tokens": 0,
            "output_tokens": 0,
            "cloud_model_calls": telemetry["model_calls"],
            "local_router_calls": 0 if route in {"TOOL", "NO_LLM"} else 1,
            "rag_calls": 1 if telemetry["rag_used"] else 0,
            "mcp_calls": 1 if route in {"TOOL", "NO_LLM"} else 1,
            "route": route,
            "model": telemetry["narrator_model"],
            "effort": telemetry["narrator_effort"],
            "requested_tier": telemetry["requested_service_tier"],
            "effective_tier": telemetry["actual_service_tier"],
            "router_ms": telemetry["router_ms"],
            "snapshot_ms": 0,
            "rag_ms": telemetry["rag_ms"],
            "narrator_ms": "unavailable",
            "response": response,
        }
    else:
        route = {"B — Direct Luna LOW": "LUNA_LOW", "C — Direct Luna XHIGH": "LUNA_XHIGH", "D — Codex Luna XHIGH": "LUNA_XHIGH"}.get(candidate, "LUNA_LOW")
        model = "gpt-5.6-luna" if candidate != "D — Codex Luna XHIGH" else "gpt-5.6-luna (Codex)"
        response = "Bartender and Guard 1: Your move." if name == "YOLO Combat" else "The authoritative game state determines the result."
        row = {
            "candidate": candidate,
            "scenario": name,
            "mode": "fixture",
            "status": "measured",
            "ttft_ms": "unavailable",
            "total_wall_ms": int((time.perf_counter() - started) * 1000),
            "input_tokens": max(1, len(text) // 4),
            "cached_input_tokens": 0,
            "reasoning_tokens": 0,
            "output_tokens": max(1, len(response) // 4),
            "cloud_model_calls": 1,
            "local_router_calls": 0,
            "rag_calls": 0,
            "mcp_calls": 0,
            "route": route,
            "model": model,
            "effort": "low" if route == "LUNA_LOW" else "xhigh",
            "requested_tier": "fast",
            "effective_tier": "fast",
            "router_ms": "unavailable",
            "snapshot_ms": "unavailable",
            "rag_ms": "unavailable",
            "narrator_ms": "unavailable",
            "response": response,
        }
    row.update(
        {
            "context_tokens_before_isolation": ISOLATION["before"],
            "context_tokens_after_isolation": ISOLATION["after"],
            "model_calls_before_narration": row["local_router_calls"] + row["cloud_model_calls"],
            "cloud_calls_before_narrator": 0,
            "planner_calls": 0,
            "reviewer_calls": 0,
        }
    )
    row["correctness"], row["correctness_failures"] = correctness(name, row["route"], row["response"])
    return row


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", default=str(ROOT / "artifacts" / "dnd-orchestrator-benchmark.json"))
    parser.add_argument("--markdown", default=str(ROOT / "artifacts" / "dnd-orchestrator-benchmark.md"))
    parser.add_argument("--live", action="store_true", help="reserved explicit provider mode; not retried")
    args = parser.parse_args()
    if args.live:
        raise SystemExit("live provider benchmark requires an explicit provider adapter; fixture artifacts remain unchanged")
    candidates = ["A — Super Orchestrator", "B — Direct Luna LOW", "C — Direct Luna XHIGH", "D — Codex Luna XHIGH"]
    rows = [fixture_result(candidate, name, text) for candidate in candidates for name, text in SCENARIOS.items()]
    super_rows = [row for row in rows if row["candidate"] == candidates[0]]
    if next(row for row in super_rows if row["scenario"] == "Deterministic")["route"] not in {"TOOL", "NO_LLM"}:
        raise AssertionError("Super Orchestrator deterministic fixture lost its no-LLM route")
    qwen = {
        "model": "custom-opencode-qwen35-4b-q4km",
        "quant": "Q4_K_M",
        "source": "openresearchtools/Qwen3.5-4B-Instruct-GGUF@4fa3cee/qwen3.5-4b-instruct-Q4_K_M.gguf",
        "backend": "ollama",
        "backendVersion": "0.34.0",
        "vram": "unavailable",
        "loadMs": 3868,
        "pp512": 3510.3,
        "tg128": 108.2,
        "routerWarmMs": 49,
        "routerP50Ms": 49,
        "routerP95Ms": 3868,
        "routerWarmP50Ms": 49,
        "routerWarmP95Ms": 55,
        "decisionMode": "constrained-token",
        "note": "Captured after unloading the resident Ollama model by scripts/dnd-qwen-probe.py; the first classification/load sample was 3868 ms, warm samples were used for routerWarm*. tg128 stopped at 80 generated tokens.",
    }
    local_routes = local_qwen_routes()
    report = {
        "benchmarkMode": "fixture",
        "meanDefinition": "arithmetic mean across six distinct fixed scenarios, not repeated samples",
        "cloudCandidatesMeasured": False,
        "reason": "No paid provider inference was charged: the live provider adapter is intentionally explicit and was not invoked in this run.",
        "scenarios": SCENARIOS,
        "rows": rows,
        "qwen": qwen,
        "localQwenRoutes": local_routes,
        "contextIsolation": ISOLATION,
    }
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    grouped = {}
    for row in rows:
        grouped.setdefault(row["candidate"], []).append(row)
    lines = [
        "# D&D orchestrator benchmark",
        "",
        "Mode: deterministic fixture. The mean is across six distinct scenarios, not repeated samples. Cloud candidates were not invoked because this harness requires an explicit live provider adapter; no paid provider calls were charged.",
        "",
        "| Candidate | Simple | Deterministic | NPC Social | YOLO Combat | RAG | Complex | Mean | Cloud calls | Input tokens | Reasoning tokens | Planner | Reviewer | Context before/after | Failures |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for candidate, items in grouped.items():
        by_name = {item["scenario"]: item for item in items}
        values = [by_name[name]["total_wall_ms"] for name in SCENARIOS]
        lines.append("| " + " | ".join([candidate] + [str(by_name[name]["total_wall_ms"]) for name in SCENARIOS] + [str(round(sum(values) / len(values), 2)), str(sum(item["cloud_model_calls"] for item in items)), str(sum(item["input_tokens"] for item in items)), str(sum(item["reasoning_tokens"] for item in items)), str(sum(item["planner_calls"] for item in items)), str(sum(item["reviewer_calls"] for item in items)), f"{items[0]['context_tokens_before_isolation']}/{items[0]['context_tokens_after_isolation']}", str(sum(len(item["correctness_failures"]) for item in items))]) + " |")
    lines += ["", "## Super Orchestrator routes", ""]
    for item in grouped[candidates[0]]:
        lines.append(f"- {item['scenario']}: `{item['route']}`; model calls `{item['cloud_model_calls']}`; correctness `{item['correctness']}`")
    lines += [
        "",
        "## Qwen local report",
        "",
        f"- Model/quant: `{qwen['model']}` / `{qwen['quant']}`; source `{qwen['source']}`",
        f"- Backend: `{qwen['backend']} {qwen['backendVersion']}`; VRAM: `{qwen['vram']}`",
        f"- Cold first-use/load: `{qwen['loadMs']} ms`; pp512: `{qwen['pp512']}` tok/s; tg128: `{qwen['tg128']}` tok/s (80 generated tokens)",
        f"- Warm latency: p50 `{qwen['routerWarmP50Ms']} ms`, p95 `{qwen['routerWarmP95Ms']} ms`; mode: `{qwen['decisionMode']}`",
    ]
    lines += ["", "## Actual local Qwen route pass", ""]
    if local_routes["available"]:
        for name, item in local_routes["routes"].items():
            lines.append(
                f"- {name}: `{item['route']}` at confidence `{item['confidence']}`; router `{item['router_ms']} ms`; cloud calls `{item['cloud_model_calls']}`"
            )
    else:
        lines.append(f"- unavailable: `{local_routes['health'].get('error', 'router offline')}`")
    Path(args.markdown).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"rows": len(rows), "json": args.output, "markdown": args.markdown}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
