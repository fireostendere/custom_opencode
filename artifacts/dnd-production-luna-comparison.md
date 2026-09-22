# Live D&D production smoke: Super Orchestrator vs direct Luna vs Gemini

Disposable campaign `770a9113-40cd-4804-8f43-bc5c0afda137` was run through the authenticated ODM loopback MCP path and ended after the test. No user campaign or character library was changed.

Authoritative receipt: Дуплодёр initiative `16`; short bow `23` vs Guard 1 AC `16`; hit; `8` piercing damage; Guard 1 `3/11`, bloodied. Visible identities stayed `Дуплодёр`, `Guard 1`, `Guard 2`.

| Candidate | Route | OpenCode process wall | TTFT | Narrator event total | Cloud calls | Planner/reviewer | Correctness |
|---|---|---:|---:|---:|---:|---:|---|
| Super Orchestrator | Qwen → Luna LOW | 17.181 s | 1.335 s | 2.645 s | 1 | 0/0 | PASS |
| Direct Luna LOW | Luna LOW, router off | 15.760 s | 1.389 s | 2.670 s | 1 | 0/0 | PASS |
| Gemini Flash (existing fixture data) | Gemini 3.8 Flash | n/a | n/a | n/a | 1/request | n/a | 2/6 PASS |

Gemini reference timings from the existing official one-pass fixture run: Simple `6.889 s`, YOLO Combat `5.383 s`. That run had no ODM MCP receipt. The separate AGY run was quota-limited and is not used as a quality winner.

Conclusion: on this single production smoke, direct Luna was about `1.42 s` faster end-to-end than Super Orchestrator, while the Qwen routing overhead itself was only `74–79 ms`. Both Luna paths produced a correct narration. The orchestration path preserved the desired zero-planner/zero-reviewer architecture and selected `LUNA_LOW`; its main current overhead is native OpenCode startup, not Qwen.

The production narrator requests intentionally received the authoritative receipt and made zero model-side MCP calls. ODM performed the encounter, roll, damage and story publication through the official control plane.
