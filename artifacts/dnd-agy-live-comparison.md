# D&D Super Orchestrator vs AGY Gemini

Client: `agy 1.2.7`; model: `gemini-3.8-flash`; effort: `high`; exactly one request per scenario; no retries.

| Scenario | Super route | Super cloud calls | AGY status | Wall ms | AGY duration s | Input tokens | Thinking tokens | Output tokens |
|---|---|---:|---|---:|---:|---:|---:|---:|
| Simple | LUNA_LOW | 1 | FAIL | 12201 | 0 | 0 | 0 | 0 |
| Deterministic | TOOL | 0 | FAIL | 12103 | 0 | 0 | 0 | 0 |
| NPC Social | LUNA_LOW | 1 | FAIL | 38285 | 7.612327596 | 0 | 0 | 0 |
| YOLO Combat | LUNA_LOW | 1 | FAIL | 12325 | 0 | 0 | 0 | 0 |
| RAG | LUNA_LOW | 1 | FAIL | 11961 | 0 | 0 | 0 | 0 |
| Complex | LUNA_XHIGH | 1 | FAIL | 40757 | 30.591182477 | 0 | 0 | 0 |

AGY responses are preserved in the JSON artifact. No ODM MCP tools were attached, so this is a narrator/proxy comparison, not an authoritative combat correctness test.
