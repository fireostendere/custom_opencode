#!/usr/bin/env python3
"""Zero-token contract checks for the DnD Edition OpenCode surface."""
from __future__ import annotations

import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))

from model_registry import CapabilityRegistry, effort_plan, validate_provider_ref  # noqa: E402


def config() -> dict:
    text = (ROOT / "config" / "opencode.json.template").read_text(encoding="utf-8")
    return json.loads(text.replace("__RAG_DISABLED__", "false").replace("__CUSTOM_OPENCODE_ROOT__", "/tmp/custom"))


cfg = config()
alias = cfg["providers"]["openai"]["models"]["gpt-6-dnd-edition"]
luna = cfg["providers"]["openai"]["models"]["gpt-6-luna-direct"]
assert alias["modelID"] == "gpt-6-luna"
assert luna["modelID"] == "gpt-6-luna"
variants = {item["id"]: item for item in luna["variants"]}
assert "body" not in variants["low"]
assert "body" not in variants["xhigh"]
assert alias["name"] == "GPT-6 · DnD Edition"
assert alias["defaultVariant"] == "auto"
assert {item["id"] for item in alias["variants"]} == {"auto"}

profiles = CapabilityRegistry().profiles()
dnd = profiles["dnd-edition"]
assert dnd["cloudModel"] == "openai/gpt-6-dnd-edition"
assert dnd["narratorModel"] == "openai/gpt-6-luna-direct#low"
assert dnd["complexModel"] == "openai/gpt-6-luna-direct#xhigh"
assert dnd["exceptionalModel"] == "openai/gpt-6-sol-orchestrated#xhigh"
assert dnd["plannerModel"] == "openai/gpt-6-luna-direct#xhigh"
assert dnd["memoryModel"] == "openai/gpt-6-luna-direct#low"
assert dnd["readerModel"] == "openai/gpt-6-luna-direct#low"
assert dnd["contextPolicy"]["targetRatio"] == 0.55
assert dnd["sandbox"] == "restricted"
assert dnd["autoReview"] is False and dnd["planningPolicy"] == "disabled" and dnd["memoryPolicy"] == "disabled"
assert dnd["codingPromptStack"] is False and dnd["ponytail"] is False
assert dnd["repoContext"] is False and dnd["automaticReview"] is False
assert dnd["automaticSubagents"] is False and dnd["genericTools"] is False
assert dnd["dndMinimalContext"] is True
assert dnd["effortPolicy"]["narrator"] == {"default": "auto", "maximum": "auto"}
assert dnd["dndOrchestrator"]["routes"]["LUNA_XHIGH"] == "openai/gpt-6-luna-direct#xhigh"
assert dnd["dndOrchestrator"]["routes"]["LUNA_MAX"] == "openai/gpt-6-luna-direct#max"
assert dnd["dndOrchestrator"]["decisionMode"] == "constrained-token"
assert dnd["dndOrchestrator"]["serviceTiers"]["luna"] == "default"
assert dnd["dndOrchestrator"]["serviceTiers"]["sol"] == "default"
assert effort_plan("openai/gpt-6-sol-direct", "max")["settings"] == {"reasoningEffort": "max"}
assert validate_provider_ref("openrouter/gpt-6-sol", "openai")[0] is False

agents = cfg["agents"]
expected_agents = {
    "dnd-narrator": "openai/gpt-6-dnd-edition#auto",
    "dnd-narrator-high": "openai/gpt-6-luna-direct#xhigh",
    "dnd-narrator-max": "openai/gpt-6-sol-orchestrated#xhigh",
    "dnd-planner": "openai/gpt-6-luna-direct#xhigh",
    "dnd-memory": "openai/gpt-6-luna-direct#low",
    "dnd-reader": "openai/gpt-6-luna-direct#low",
}
for name, model in expected_agents.items():
    assert agents[name]["model"] == model
    assert agents[name]["permissions"][0] == {"action": "*", "resource": "*", "effect": "deny"}
assert agents["dnd-narrator"]["mode"] == "primary"
skill_rules = {(item["resource"], item["effect"]) for item in agents["dnd-narrator"]["permissions"] if item["action"] == "skill"}
assert skill_rules == {("odm-dm-policy", "allow"), ("odm-narrator", "allow"), ("dnd-*", "allow")}
for name in ("dnd-memory", "dnd-reader"):
    allowed = {item["action"] for item in agents[name]["permissions"] if item["effect"] == "allow"}
    assert allowed == {f"dnd_knowledge_{action}" for action in ("search", "get", "sources", "status")}
for name in expected_agents:
    assert all(not item["action"].startswith("kb_knowledge_") for item in agents[name]["permissions"])

print("DnD Edition profile/config contract passed")
