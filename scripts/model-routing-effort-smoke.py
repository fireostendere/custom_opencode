#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))

from model_registry import (  # noqa: E402
    ALIBABA_PROVIDER,
    CANONICAL_EFFORTS,
    CapabilityRegistry,
    ResourceScheduler,
    effort_plan,
    role_models,
    sol_role_models,
    validate_provider_ref,
)

EXPECTED_ROLES = {
    "planner": "bailian-cli/qwen3.8-max",
    "builder": "bailian-cli/qwen3.7-plus",
    "reader": "bailian-cli/qwen3.8-flash",
    "reviewer": "bailian-cli/deepseek-v4-pro-0813",
    "long_horizon": "bailian-cli/glm-5.2",
}
EXPECTED_PROFILES = {
    "direct",
    "fast",
    "build",
    "architect",
    "critical",
    "review",
    "research",
    "long-horizon",
    "sol-orchestrated",
    "sol-review",
}

for name in (
    "OPENCODE_PLANNER_MODEL",
    "OPENCODE_BUILDER_MODEL",
    "OPENCODE_READER_MODEL",
    "OPENCODE_REVIEW_MODEL",
    "OPENCODE_LONG_HORIZON_MODEL",
    "OPENCODE_ORCHESTRATED_MODEL",
    "OPENCODE_SOL_ORCHESTRATED_MODEL",
    "OPENCODE_SOL_BUILDER_MODEL",
    "OPENCODE_SOL_READER_MODEL",
    "OPENCODE_SOL_REVIEW_MODEL",
):
    os.environ.pop(name, None)

assert tuple(CANONICAL_EFFORTS) == ("auto", "minimal", "low", "medium", "high", "max")
assert role_models() == EXPECTED_ROLES
for ref in EXPECTED_ROLES.values():
    ok, error = validate_provider_ref(ref, ALIBABA_PROVIDER)
    assert ok, error

for bad in (
    "openrouter/qwen3.8-max",
    "openrouter/deepseek-v4-pro-0813",
    "deepseek/deepseek-v4-pro-0813",
    "zhipu/glm-5.2",
):
    ok, _ = validate_provider_ref(bad)
    assert not ok, bad

assert effort_plan("bailian-cli/qwen3.8-max", "low")["settings"] == {"effort": "low"}
assert effort_plan("bailian-cli/qwen3.8-max", "medium")["settings"] == {"effort": "medium"}
assert effort_plan("bailian-cli/qwen3.8-max", "high")["settings"] == {"effort": "xhigh"}
assert effort_plan("bailian-cli/qwen3.8-max", "max")["settings"] == {"effort": "xhigh"}
assert effort_plan("bailian-cli/qwen3.8-flash", "low")["effectiveEffort"] == "low"
assert effort_plan("bailian-cli/qwen3.7-plus", "medium")["settings"]["thinking"]["budgetTokens"] == 16384
assert effort_plan("bailian-cli/qwen3.7-plus", "high")["settings"]["thinking"]["budgetTokens"] == 65536
assert effort_plan("bailian-cli/qwen3.7-plus", "max")["settings"]["thinking"]["budgetTokens"] == 262144
assert effort_plan("bailian-cli/deepseek-v4-pro-0813", "high")["settings"] == {"effort": "high"}
assert effort_plan("bailian-cli/deepseek-v4-pro-0813", "max")["settings"] == {"effort": "max"}
assert effort_plan("bailian-cli/glm-5.2", "max")["settings"] == {"effort": "max"}

registry = CapabilityRegistry([])
profiles = registry.profiles()
assert set(profiles) == EXPECTED_PROFILES
assert profiles["fast"]["builderModel"] == EXPECTED_ROLES["reader"]
assert profiles["direct"]["agentBuild"] == "build-direct"
assert profiles["direct"]["agentPlan"] == "plan-direct"
assert profiles["build"]["builderModel"] == EXPECTED_ROLES["builder"]
assert profiles["build"]["readerModel"] == EXPECTED_ROLES["reader"]
assert profiles["build"]["plannerModel"] == EXPECTED_ROLES["planner"]
assert profiles["build"]["effortPolicy"]["builder"]["default"] == "medium"
assert profiles["build"]["effortPolicy"]["builder"]["afterFailure"] == "high"
assert profiles["architect"]["plannerModel"] == EXPECTED_ROLES["planner"]
assert profiles["critical"]["reviewerModel"] == EXPECTED_ROLES["reviewer"]
assert profiles["critical"]["effortPolicy"]["planner"]["default"] == "max"
assert profiles["critical"]["effortPolicy"]["reviewer"]["default"] == "max"
assert profiles["review"]["cloudModel"] == EXPECTED_ROLES["reviewer"]
assert profiles["review"]["hidden"] is True
assert profiles["long-horizon"]["builderModel"] == EXPECTED_ROLES["long_horizon"]
assert profiles["sol-orchestrated"]["cloudModel"] == "openai/gpt-5.6-sol-orchestrated"
assert profiles["sol-orchestrated"]["builderModel"] == "openai/gpt-5.6-terra"
assert profiles["sol-orchestrated"]["readerModel"] == "openai/gpt-5.6-luna"
assert profiles["sol-orchestrated"]["reviewerModel"] == "openai/gpt-5.6-luna"
assert profiles["sol-orchestrated"]["orchestrated"] is True
assert profiles["sol-orchestrated"]["effortPolicy"]["reader"]["default"] == "high"
assert profiles["sol-review"]["cloudModel"] == "openai/gpt-5.6-luna"
assert profiles["sol-review"]["hidden"] is True

scheduler = ResourceScheduler()
build_route = scheduler.decide(profiles["build"])
assert build_route.selected_model == EXPECTED_ROLES["builder"]
assert build_route.mode == "provider-pinned"
review_route = scheduler.decide(profiles["review"])
assert review_route.selected_model == EXPECTED_ROLES["reviewer"]
manual = scheduler.decide(profiles["direct"], selected_model="openai/example")
assert manual.selected_model == "openai/example"

template = (ROOT / "config" / "opencode.json.template").read_text(encoding="utf-8")
config = json.loads(template.replace("__RAG_DISABLED__", "true"))
alibaba = config["providers"][ALIBABA_PROVIDER]
models = alibaba["models"]
agents = config["agents"]
assert alibaba["name"] == "Alibaba Cloud"
assert config["providers"]["openai"]["models"]["gpt-5.6-sol-orchestrated"]["modelID"] == "gpt-5.6-sol"
assert sol_role_models() == {
    "builder": "openai/gpt-5.6-terra",
    "reader": "openai/gpt-5.6-luna",
    "reviewer": "openai/gpt-5.6-luna",
}
os.environ["OPENCODE_SOL_REVIEW_MODEL"] = "openai/gpt-5.6-sol-fast"
try:
    sol_role_models()
except ValueError as error:
    assert "disabled" in str(error)
else:
    raise AssertionError("SOL Fast override must be rejected")
finally:
    os.environ.pop("OPENCODE_SOL_REVIEW_MODEL", None)


def variants(model: str) -> dict[str, dict]:
    return {str(row["id"]): row for row in models[model].get("variants", [])}

q38max = variants("qwen3.8-max")
q38flash = variants("qwen3.8-flash")
plus = variants("qwen3.7-plus")
deepseek = variants("deepseek-v4-pro-0813")
glm = variants("glm-5.2")
assert q38max["max"]["settings"]["effort"] == "xhigh"
assert q38max["high"]["settings"]["effort"] == "xhigh"
assert q38flash["low"]["settings"]["effort"] == "low"
assert models["qwen3.8-flash"]["settings"]["effort"] == "low"
assert models["qwen3.7-plus"]["settings"]["thinking"]["budgetTokens"] == 16384
assert plus["medium"]["settings"]["thinking"]["budgetTokens"] == 16384
assert plus["high"]["settings"]["thinking"]["budgetTokens"] == 65536
assert plus["max"]["settings"]["thinking"]["budgetTokens"] == 262144
assert deepseek["high"]["settings"]["effort"] == "high"
assert deepseek["max"]["settings"]["effort"] == "max"
assert glm["max"]["settings"]["effort"] == "max"

assert agents["title"]["model"] == "bailian-cli/qwen3.8-flash#low"
assert agents["fast-reader"]["model"] == "bailian-cli/qwen3.8-flash#low"
for direct_agent, denied_actions in {
    "build-direct": {"subagent", "kb_knowledge_search", "kb_knowledge_get", "kb_knowledge_sources", "kb_knowledge_status", "kb_knowledge_ingest"},
    "plan-direct": {"edit", "shell", "subagent", "kb_knowledge_search", "kb_knowledge_get", "kb_knowledge_sources", "kb_knowledge_status", "kb_knowledge_ingest"},
}.items():
    rules = agents[direct_agent]["permissions"]
    assert all(any(rule.get("action") == action and rule.get("effect") == "deny" for rule in rules) for action in denied_actions)
assert agents["role-builder"]["model"] == "bailian-cli/qwen3.7-plus#medium"
assert agents["role-builder-high"]["model"] == "bailian-cli/qwen3.7-plus#high"
assert agents["role-builder-max"]["model"] == "bailian-cli/qwen3.7-plus#max"
assert agents["role-reviewer"]["model"] == "bailian-cli/deepseek-v4-pro-0813#high"
assert agents["role-reviewer-max"]["model"] == "bailian-cli/deepseek-v4-pro-0813#max"
assert agents["role-long-horizon"]["model"] == "bailian-cli/glm-5.2#high"
assert agents["role-long-horizon-max"]["model"] == "bailian-cli/glm-5.2#max"
assert agents["sol-fast-reader"]["model"] == "openai/gpt-5.6-luna#xhigh"
assert agents["sol-role-builder"]["model"] == "openai/gpt-5.6-terra#medium"
assert agents["sol-role-builder-high"]["model"] == "openai/gpt-5.6-terra#high"
assert agents["sol-role-builder-max"]["model"] == "openai/gpt-5.6-terra#max"
assert agents["sol-role-reviewer"]["model"] == "openai/gpt-5.6-luna#xhigh"
assert agents["sol-role-reviewer-max"]["model"] == "openai/gpt-5.6-luna#max"
assert "local-reader" not in agents
assert "qwen3.6-flash" not in agents["fast-reader"]["model"]

prompt = (ROOT / "config" / "prompts" / "orchestrator.md").read_text(encoding="utf-8")
for token in ("role-builder", "role-builder-high", "fast-reader", "role-reviewer-max", "Plus", "maximum effort", "provider"):
    assert token.casefold() in prompt.casefold(), token
sol_prompt = (ROOT / "config" / "prompts" / "orchestrator-sol.md").read_text(encoding="utf-8")
for token in ("gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "sol-role-builder", "sol-role-reviewer", "direct/manual"):
    assert token.casefold() in sol_prompt.casefold(), token
for token in ("Planning policy", "conditional, not a ritual", "native", "primary `plan` agent", "short, obvious, bounded", "two or more meaningful stages", "before the first file mutation"):
    assert token.casefold() in prompt.casefold(), token

agents_policy = (ROOT / "config" / "AGENTS.md").read_text(encoding="utf-8")
for token in ("Планирование задач", "OpenCode V2", "plan", "plan_update", "1-7", "До первой shell/edit/write/patch", "не создавай инструменты или подагентов только ради UI"):
    assert token in agents_policy, token

forbidden = (
    "OPENCODE_LOCAL_CODER_MODEL",
    "OPENCODE_LOCAL_AUTO_START",
    "OPENCODE_LOCAL_PROVIDER",
    "OPENCODE_LOCAL_ROUTER_URL",
    "OPENCODE_LOCAL_ROUTER_START",
    "OPENCODE_LOCAL_ROUTER_LOG",
    "OPENCODE_RESOURCE_SCHEDULER",
    "OPENCODE_GAME_PROCESSES",
    "OPENCODE_RESOURCE_PAUSE_COMMAND",
    "OPENCODE_RESOURCE_RESUME_COMMAND",
    "OPENCODE_CLOUD_CODER_MODEL",
    "OPENCODE_FAST_MODEL",
    '"localModel"',
    'route="auto"',
    "AdaptiveResourceScheduler",
)
checked_paths = (
    ROOT / ".env.example",
    ROOT / "app" / "model_registry.py",
    ROOT / "app" / "server_runtime.py",
    ROOT / "app" / "runtime_v3.py",
    ROOT / "config" / "prompts" / "orchestrator.md",
    ROOT / "docs" / "model-routing-effort.md",
    ROOT / "docs" / "models-and-routing.md",
    ROOT / "docs" / "server-runtime-v3.md",
)
for path in checked_paths:
    text = path.read_text(encoding="utf-8")
    for token in forbidden:
        assert token not in text, f"retired routing token {token!r} remains in {path.relative_to(ROOT)}"

print("Model routing/effort smoke passed: provider lock + role models + effort variants + retired router removed")
