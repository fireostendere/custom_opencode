# D&D Super Orchestrator vs Gemini Flash

Model: `gemini-3.8-flash`; thinking: `HIGH`; exactly one official Google API request per scenario; no retries.

| Scenario | Super route | Super cloud calls | Gemini status | Gemini wall ms | TTFT ms | Input tokens | Reasoning tokens | Output tokens |
|---|---|---:|---|---:|---:|---:|---:|---:|
| Simple | LUNA_LOW | 1 | PASS | 6889 | unavailable | 100 | 401 | 45 |
| Deterministic | TOOL | 0 | FAIL | 3649 | unavailable | unavailable | unavailable | unavailable |
| NPC Social | LUNA_LOW | 1 | FAIL | 4463 | unavailable | unavailable | unavailable | unavailable |
| YOLO Combat | LUNA_LOW | 1 | PASS | 5383 | unavailable | 139 | 924 | 56 |
| RAG | LUNA_LOW | 1 | FAIL | 17741 | unavailable | unavailable | unavailable | unavailable |
| Complex | LUNA_XHIGH | 1 | FAIL | 9745 | unavailable | unavailable | unavailable | unavailable |

Gemini responses/errors are preserved in the JSON artifact. Gemini direct API had no ODM tools/receipts, so non-empty rows are transport/prose successes, not authoritative D&D correctness passes. Super Orchestrator correctness is from the fixed fixture run; no live Luna narrator calls were available in this environment.
