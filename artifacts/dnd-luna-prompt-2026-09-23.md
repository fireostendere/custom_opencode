# GPT-6 Luna DnD prompt: one-pass live checks

Two identically seeded, disposable local ODM campaigns were run through the
installed OpenCode DnD profile and real `odm_narrator` MCP. The fixture server
used temporary SQLite and was stopped afterward. Neither run touched a user
campaign. Rules RAG was not needed for this chest-inspection action.

| Prompt | Wall time | Assistant steps | MCP calls | Tool errors | Input incl. cache | Reasoning | Output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Before connect/read clarification | 76.1 s | 8 | 8 | 0 | 102,621 | 2,007 | 1,260 |
| After connect/read clarification | 69.9 s | 6 | 6 | 0 | 80,490 | 1,798 | 1,115 |

The second run called `mcp_discover`, `connect`, `read`, `catalog(request_roll)`,
`invoke(request_roll)` and `narrate`. It avoided a second discovery and a
duplicate snapshot. ODM confirmed Perception **10 vs DC 12**, a failed check.
The published text was:

> Торину не удалось определить, есть ли на сундуке ловушка: осмотр не дал надёжного ответа. Замок остаётся заперт; дождь дробит по ставням рядом с дверью.

The game project's read-only `dnd_srd` Qdrant collection answered on loopback
with 5,303 points. This checks availability, not retrieval quality. These are
single runs with different cache state and dice; the observed wall-time change
is not a latency percentile or a controlled speedup estimate.
