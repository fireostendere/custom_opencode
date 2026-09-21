# D&D orchestrator benchmark

Mode: deterministic fixture. The mean is across six distinct scenarios, not repeated samples. Cloud candidates were not invoked because this harness requires an explicit live provider adapter; no paid provider calls were charged.

| Candidate | Simple | Deterministic | NPC Social | YOLO Combat | RAG | Complex | Mean | Cloud calls | Input tokens | Reasoning tokens | Planner | Reviewer | Context before/after | Failures |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A — Super Orchestrator | 1 | 0 | 0 | 0 | 0 | 0 | 0.17 | 5 | 111 | 0 | 0 | 0 | 4690/389 | 0 |
| B — Direct Luna LOW | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | 6 | 111 | 0 | 0 | 0 | 4690/389 | 0 |
| C — Direct Luna XHIGH | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | 6 | 111 | 0 | 0 | 0 | 4690/389 | 0 |
| D — Codex Luna XHIGH | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 | 6 | 111 | 0 | 0 | 0 | 4690/389 | 0 |

## Super Orchestrator routes

- Simple: `LUNA_LOW`; model calls `1`; correctness `PASS`
- Deterministic: `TOOL`; model calls `0`; correctness `PASS`
- NPC Social: `LUNA_LOW`; model calls `1`; correctness `PASS`
- YOLO Combat: `LUNA_LOW`; model calls `1`; correctness `PASS`
- RAG: `LUNA_LOW`; model calls `1`; correctness `PASS`
- Complex: `LUNA_XHIGH`; model calls `1`; correctness `PASS`

## Qwen local report

- Model/quant: `custom-opencode-qwen35-4b-q4km` / `Q4_K_M`; source `openresearchtools/Qwen3.5-4B-Instruct-GGUF@4fa3cee/qwen3.5-4b-instruct-Q4_K_M.gguf`
- Backend: `ollama 0.34.0`; VRAM: `unavailable`
- Cold first-use/load: `3868 ms`; pp512: `3510.3` tok/s; tg128: `108.2` tok/s (80 generated tokens)
- Warm latency: p50 `49 ms`, p95 `55 ms`; mode: `constrained-token`

## Actual local Qwen route pass

- Simple: `LUNA_LOW` at confidence `0.65`; router `85 ms`; cloud calls `1`
- Deterministic: `TOOL` at confidence `1.0`; router `0 ms`; cloud calls `0`
- NPC Social: `LUNA_LOW` at confidence `0.65`; router `84 ms`; cloud calls `1`
- YOLO Combat: `LUNA_LOW` at confidence `0.65`; router `83 ms`; cloud calls `1`
- RAG: `LUNA_LOW` at confidence `0.65`; router `87 ms`; cloud calls `1`
- Complex: `LUNA_XHIGH` at confidence `0.65`; router `89 ms`; cloud calls `1`
