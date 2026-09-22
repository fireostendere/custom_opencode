#!/usr/bin/env python3
"""Focused zero-cloud checks for the D&D Super Orchestrator contract."""
from __future__ import annotations

import sys
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))

from dnd_orchestrator import (  # noqa: E402
    BarkPolicy,
    DndOrchestrator,
    LocalQwenRouter,
    SnapshotAdapter,
    VoiceResolver,
    flatten_narration,
    route_model,
    selective_rag,
)


class FakeRouter:
    def __init__(self, letter="D"):
        self.letter = letter

    def health(self):
        return {"ok": True, "backend": "fixture"}

    def classify(self, message, context):
        return self.letter, 0.92, {"ms": 1, "backend": "fixture"}


class LowConfidenceRouter(FakeRouter):
    def classify(self, message, context):
        return "B", 0.62, {"ms": 1, "backend": "fixture"}


assert DndOrchestrator(router=LocalQwenRouter(url="http://127.0.0.1:9/v1")).plan("I give Vasya one healing potion.")["decision"]["route"] == "TOOL"
social = DndOrchestrator(router=FakeRouter("C")).plan("I try to convince the bartender while two guards watch.")
assert social["decision"]["route"] == "LUNA_LOW"
assert social["decision"]["npc_intent"] == "BATCH"
assert social["telemetry"]["model_calls"] == 1
assert social["telemetry"]["requested_service_tier"] == "fast"
assert social["telemetry"]["actual_service_tier"] == "priority"
assert {node["id"] for node in social["dag"]}.isdisjoint({"planner", "reviewer", "subagent"})
assert sum(node["id"] == "narrator" for node in social["dag"]) == 1
complex_plan = DndOrchestrator(router=FakeRouter("E")).plan("I turn the captain against the advisor using what each knows about last week's events.")
assert complex_plan["decision"]["route"] == "SOL_XHIGH"
assert complex_plan["telemetry"]["requested_service_tier"] == "default"
assert route_model("SOL_XHIGH")["serviceTier"] == "default"
uncertain_tool = DndOrchestrator(router=LowConfidenceRouter()).plan("I hand over the relic to Vasya.")
assert uncertain_tool["decision"]["route"] == "LUNA_LOW"
assert uncertain_tool["decision"]["fallback"] == "conservative-confidence"
assert selective_rag([{"scope": "RULES", "score": 1, "text": "rule"}, {"scope": "LORE", "score": 2, "text": "lore"}], "RULES") == [{"id": "", "scope": "RULES", "text": "rule", "score": 1}]

calls = []
adapter = SnapshotAdapter(lambda tool, payload: calls.append(payload) or ({"revision": "r1"} if payload["operation"] == "snapshot" else {"delta": True}))
assert adapter.read(["party", "recent"])["path"] == "snapshot"
assert calls[0]["sections"] == ["party", "recent"]
offline = LocalQwenRouter()
with patch("dnd_orchestrator.urlopen", side_effect=TimeoutError("offline")) as request:
    for _ in range(3):
        try:
            offline.classify("Hello")
        except TimeoutError:
            pass
    assert request.call_count == 1, "offline router must not cost a timeout for every cloud/tool step"
    offline._retry_after = 0
    try:
        offline.classify("Hello")
    except TimeoutError:
        pass
    assert request.call_count == 2, "router must probe again after cooldown"
fallback_calls = []
def snapshot_then_read(tool, payload):
    fallback_calls.append(payload)
    if len(fallback_calls) == 1:
        raise RuntimeError("snapshot unavailable")
    return {"delta": True}
fallback = SnapshotAdapter(snapshot_then_read).read(["party"], known_revision="r1")
assert fallback["path"] == "read-delta"
assert fallback_calls[1]["operation"] == "read"
assert fallback_calls[1]["knownSections"] == {"party": "r1"}

barks = BarkPolicy()
assert barks.should_bark("boss_phase_transition", "guard-1", 1)
assert not barks.should_bark("ordinary_attack", "guard-1", 2, recent_speaker="guard-1")
assert barks.should_bark("ordinary_attack", "guard-2", 3, play_mode="YOLO")

voice = VoiceResolver()
assert voice.resolve("campaign", "npc_guard_1", "guard") == voice.resolve("campaign", "npc_guard_1", "different")
assert flatten_narration({"segments": [{"type": "speech", "speakerId": "bartender", "text": "Enough.", "delivery": "angry"}]}) == "bartender: Enough."
print("D&D Super Orchestrator regression passed")
