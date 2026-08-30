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
    "research",
    "long-horizon",
}

# Make the smoke deterministic even when a developer has role overrides locally.
for name in (
    "OPENCODE_PLANNER_MODEL",
    "OPENCODE_BUILDER_MODEL",
    "OPENCODE_READER_MODEL",
    "OPENCODE_REVIEW_MODEL",
    "OPENCODE_LONG_HORIZON_MODEL",
    "OPENCODE_ORCHESTRATED_MODEL",
):
    os.environ.pop(name, None)

assert tuple(CANONICAL_EFFORTS) == ("auto", "minimal", "low", "medium", "high", "max")
assert role_models() == EXPECTED_ROLES
for ref in EXPECTED_ROLES.values():
    ok, error = validate_provider_ref(ref, ALIBABA_PROVIDER)
    assert ok, error

# Provider lock: orchestration Qwen/DeepSeek/GLM must not silently escape Bailian.
for bad in (
    "openrouter/qwen3.8-max",
    "openrouter/deepseek-v4-pro-0813",
    "deepseek/deepseek-v4-pro-0813",
    "zhipu/glm-5.2",
):
    ok, _ = validate_provider_ref(bad)
    assert not ok, bad

# Canonical effort -> provider-specific request semantics.
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
assert profiles["build"]["builderModel"] == EXPECTED_ROLES["builder"]
assert profiles["build"]["readerModel"] == EXPECTED_ROLES["reader"]
assert profiles["build"]["plannerModel"] == EXPECTED_ROLES["planner"]
assert profiles["build"]["effortPolicy"]["builder"]["default"] == "medium"
assert profiles["build"]["effortPolicy"]["builder"]["afterFailure"] == "high"
assert profiles["architect"]["plannerModel"] == EXPECTED_ROLES["planner"]
assert profiles["critical"]["reviewerModel"] == EXPECTED_ROLES["reviewer"]
assert profiles["critical"]["effortPolicy"]["planner"]["default"] == "max"
assert profiles["critical"]["effortPolicy"]["reviewer"]["default"] == "max"
assert profiles["long-horizon"]["builderModel"] == EXPECTED_ROLES["long_horizon"]

# Routing is deterministic and provider-pinned. There is no alternate-device path.
scheduler = ResourceScheduler()
build_route = scheduler.decide(profiles["build"])
assert build_route.selected_model == EXPECTED_ROLES["builder"]
assert build_route.mode == "provider-pinned"
manual = scheduler.decide(profiles["direct"], selected_model="openai/example")
assert manual.selected_model == "openai/example"

# Parse the installer template after resolving its deliberate non-JSON placeholder.
template = (ROOT / "config" / "opencode.json.template").read_text(encoding="utf-8")
config = json.loads(template.replace("__RAG_DISABLED__", "true"))
alibaba = config["providers"][ALIBABA_PROVIDER]
models = alibaba["models"]
agents = config["agents"]
assert alibaba["name"] == "Alibaba Cloud"


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
assert agents["role-builder"]["model"] == "bailian-cli/qwen3.7-plus#medium"
assert agents["role-builder-high"]["model"] == "bailian-cli/qwen3.7-plus#high"
assert agents["role-builder-max"]["model"] == "bailian-cli/qwen3.7-plus#max"
assert agents["role-reviewer"]["model"] == "bailian-cli/deepseek-v4-pro-0813#high"
assert agents["role-reviewer-max"]["model"] == "bailian-cli/deepseek-v4-pro-0813#max"
assert agents["role-long-horizon"]["model"] == "bailian-cli/glm-5.2#high"
assert agents["role-long-horizon-max"]["model"] == "bailian-cli/glm-5.2#max"
assert "local-reader" not in agents
assert "qwen3.6-flash" not in agents["fast-reader"]["model"]

prompt = (ROOT / "config" / "prompts" / "orchestrator.md").read_text(encoding="utf-8")
for token in (
    "role-builder",
    "role-builder-high",
    "fast-reader",
    "role-reviewer-max",
    "Plus",
    "maximum effort",
    "provider",
):
    assert token.casefold() in prompt.casefold(), token

# The removed router must not creep back into source/config/docs. Manual provider
# support is intentionally outside this assertion; only automatic routing terms are forbidden.
forbidden = (
    "OPENCODE_LOCAL_CODER_MODEL",
    "OPENCODE_LOCAL_AUTO_START",
    "OPENCODE_LOCAL_PROVIDER",
    "OPENCODE_LOCAL_ROUTER_URL",
    "OPENCODE_LOCAL_ROUTER_START",
    "OPENCODE_LOCAL_ROUTER_LOG",
    "OPENCODE_RESOURCE_SCHEDULER",
    "OPENCODE_GAME_PROCESSES",
    "OPENCODE_CLOUD_CODER_MODEL",
    "OPENCODE_FAST_MODEL",
    '"localModel"',
    'route="auto"',
)
checked_paths = (
    ROOT / ".env.example",
    ROOT / "app" / "model_registry.py",
    ROOT / "config" / "prompts" / "orchestrator.md",
    ROOT / "docs" / "model-routing-effort.md",
)
for path in checked_paths:
    text = path.read_text(encoding="utf-8")
    for token in forbidden:
        assert token not in text, f"legacy routing token {token!r} remains in {path.relative_to(ROOT)}"

print("Model routing/effort smoke passed: Alibaba provider lock + role models + effort variants + no legacy local routing")
