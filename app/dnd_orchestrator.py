#!/usr/bin/env python3
"""Small, provider-neutral D&D orchestration primitives.

The module owns routing metadata only. ODM remains the authority for state,
rules, mutations, visibility and persistence.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
import hashlib
import json
import os
from pathlib import Path
import re
import threading
import time
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROUTES = ("NO_LLM", "TOOL", "LUNA_LOW", "LUNA_XHIGH", "SOL_XHIGH")
RAG_SCOPES = ("NONE", "RULES", "LORE", "CAMPAIGN_MEMORY")
TOOL_FAMILIES = (
    "NONE",
    "COMBAT",
    "CHECK",
    "INVENTORY",
    "CHARACTER",
    "SOCIAL",
    "WORLD",
    "LOCATION",
    "MEMORY",
)
DELIVERIES = {
    "calm",
    "angry",
    "afraid",
    "whisper",
    "shouting",
    "mocking",
    "sarcastic",
    "manic",
    "overdramatic",
    "dying",
}


def _text(value: Any, limit: int = 12000) -> str:
    return str(value or "").strip()[:limit]


def _mode(value: Any) -> str:
    value = str(value or "FULL").upper()
    return value if value in {"FULL", "YOLO"} else "FULL"


def feature_mode(value: str | None = None) -> str:
    mode = str(value or os.environ.get("DND_ORCHESTRATOR", "auto")).strip().lower()
    return mode if mode in {"auto", "on", "off"} else "auto"


@dataclass(frozen=True)
class DndDecision:
    route: str
    confidence: float
    needs_rag: str = "NO"
    rag_scope: str = "NONE"
    tool_family: str = "NONE"
    needs_narration: str = "YES"
    memory_read: str = "NO"
    memory_write: str = "NO"
    privacy: str = "PUBLIC"
    npc_intent: str = "NONE"
    combat_intent: str = "NONE"
    scene_complexity: str = "NORMAL"
    router_backend: str = "code"
    router_mode: str = "deterministic"
    fallback: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class DndTelemetry:
    play_mode: str = "FULL"
    route: str = "LUNA_LOW"
    router_confidence: float = 0.0
    router_ms: int = 0
    router_backend: str = "unavailable"
    router_mode: str = "fallback"
    router_input_tokens: int = 0
    snapshot_ms: int = 0
    snapshot_bytes: int = 0
    rag_used: bool = False
    rag_scope: str = "NONE"
    rag_ms: int = 0
    rag_chunks: int = 0
    rag_tokens: int = 0
    mcp_calls: int = 0
    mcp_ms: int = 0
    narrator_model: str | None = None
    narrator_effort: str | None = None
    requested_service_tier: str | None = None
    actual_service_tier: str | None = None
    model_calls: int = 0
    input_tokens: int = 0
    cached_input_tokens: int = 0
    reasoning_tokens: int = 0
    output_tokens: int = 0
    ttft_ms: int | None = None
    total_latency_ms: int = 0
    fallback: str | None = None
    cancellations: int = 0

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def _family(message: str) -> str:
    low = message.casefold()
    if re.search(r"\b(attack|hit|damage|combat|fight|strike|smash|parry|initiative)\b", low):
        return "COMBAT"
    if re.search(r"\b(check|roll|save|dc|perception|stealth|persuade|deceive|insight)\b", low):
        return "CHECK"
    if re.search(r"\b(potion|inventory|item|gold|drink|consume|equip|drop)\b", low):
        return "INVENTORY"
    if re.search(r"\b(spell|character|sheet|hp|health|level|class|ability)\b", low):
        return "CHARACTER"
    if re.search(r"\b(bartender|guard|captain|advisor|npc|convince|persuade|threaten|talk)\b", low):
        return "SOCIAL"
    if re.search(r"\b(give|hand)\b", low) and re.search(r"\b(to|one|them|him|her)\b", low):
        return "INVENTORY"
    if re.search(r"\b(memory|remember|last week|already know|campaign fact|seal)\b", low):
        return "MEMORY"
    if re.search(r"\b(door|room|location|open|inside|leave|move|where)\b", low):
        return "LOCATION"
    return "NONE"


def _complexity(message: str) -> str:
    low = message.casefold()
    if re.search(r"\b(conflict|contradiction|hidden|last week|each of them|turn .* against|multiple motives)\b", low):
        return "HARD"
    if len(message) > 180 or len(re.findall(r"\b(and|while|but|using|because)\b", low)) >= 2:
        return "COMPLEX"
    if _family(message) in {"COMBAT", "SOCIAL", "MEMORY"}:
        return "NORMAL"
    return "SIMPLE"


def _typed_fields(message: str, route: str, confidence: float, backend: str, mode: str) -> DndDecision:
    low = message.casefold()
    family = _family(message)
    complexity = _complexity(message)
    rag_scope = "NONE"
    if re.search(r"\b(rule|dc|spell|ac|condition|mechanic|5e)\b", low):
        rag_scope = "RULES"
    elif re.search(r"\b(lore|history|world|place|who was|what is)\b", low):
        rag_scope = "LORE"
    elif re.search(r"\b(remember|already know|last week|campaign|seal)\b", low):
        rag_scope = "CAMPAIGN_MEMORY"
    private = bool(re.search(r"\b(whisper|private|secret|dm only|ask privately)\b", low))
    privacy = "PRIVATE" if private else "ROOM_SCOPED" if "room" in low else "PUBLIC"
    deterministic_tool = (
        family in {"INVENTORY", "CHECK"}
        and bool(re.search(r"\b(give|hand|use|drink|consume|roll|check)\b", low))
        and not bool(re.search(r"\b(describe|narrate|story|scene)\b", low))
    )
    if confidence < 0.55:
        route = "LUNA_XHIGH" if complexity in {"COMPLEX", "HARD"} else "LUNA_LOW"
        fallback = "low-confidence"
    elif confidence < 0.80 and route in {"NO_LLM", "TOOL", "SOL_XHIGH"}:
        route = "LUNA_XHIGH" if complexity in {"COMPLEX", "HARD"} else "LUNA_LOW"
        fallback = "conservative-confidence"
    else:
        fallback = None
    if deterministic_tool and confidence >= 0.80 and route not in {"LUNA_XHIGH", "SOL_XHIGH"}:
        route = "TOOL"
    needs_rag = "YES" if rag_scope != "NONE" else "NO"
    needs_narration = "NO" if route in {"NO_LLM", "TOOL"} and deterministic_tool else "YES"
    return DndDecision(
        route=route,
        confidence=round(max(0.0, min(1.0, confidence)), 4),
        needs_rag=needs_rag,
        rag_scope=rag_scope,
        tool_family=family,
        needs_narration=needs_narration,
        memory_read="YES" if rag_scope == "CAMPAIGN_MEMORY" or "remember" in low else "NO",
        memory_write="YES" if re.search(r"\b(record|remember this|note that)\b", low) else "NO",
        privacy=privacy,
        npc_intent="BATCH" if len(re.findall(r"\b(npc|guards?|bartender|captain|advisor)\b", low)) >= 2 else "NONE",
        combat_intent="BATCH" if family == "COMBAT" and re.search(r"\b(guards?|enemies|mobs|multiple|two|three)\b", low) else "NONE",
        scene_complexity=complexity,
        router_backend=backend,
        router_mode=mode,
        fallback=fallback,
    )


def deterministic_decision(message: str, play_mode: str = "FULL") -> DndDecision | None:
    """Handle only unambiguous no-narration operations before local inference."""
    low = message.casefold()
    if re.fullmatch(r"\s*i\s+(give|hand)\b.*\b(potion|item|gold)\b.*", low):
        return _typed_fields(message, "TOOL", 1.0, "code", "deterministic")
    if re.fullmatch(r"\s*i\s+(roll|make)\b.*\b(check|save)\b.*", low):
        return _typed_fields(message, "TOOL", 1.0, "code", "deterministic")
    return None


def route_model(route: str) -> dict[str, str | None]:
    table = {
        "LUNA_LOW": ("gpt-5.6-luna", "low", "fast"),
        "LUNA_XHIGH": ("gpt-5.6-luna", "xhigh", "fast"),
        "SOL_XHIGH": ("gpt-5.6-sol", "xhigh", "default"),
    }
    model, effort, tier = table.get(route, (None, None, None))
    return {"model": model, "effort": effort, "serviceTier": tier}


class LocalQwenRouter:
    """One resident local endpoint client with bounded in-flight requests."""

    def __init__(self, url: str | None = None, timeout: float | None = None, queue: int | None = None):
        self.url = (url or os.environ.get("DND_QWEN_URL") or "http://127.0.0.1:11434/v1").rstrip("/")
        self.timeout = float(timeout or os.environ.get("DND_QWEN_TIMEOUT_S", "1.8"))
        self._slots = threading.BoundedSemaphore(max(1, int(queue or os.environ.get("DND_QWEN_QUEUE", "2"))))
        self._retry_after = 0.0

    @property
    def health_url(self) -> str:
        return os.environ.get("DND_QWEN_HEALTH_URL", self.url.removesuffix("/v1") + "/")

    @property
    def ollama_native(self) -> bool:
        return os.environ.get("DND_QWEN_BACKEND", "").lower() == "ollama" or ":11434" in self.url

    def health(self) -> dict[str, Any]:
        started = time.perf_counter()
        try:
            with urlopen(Request(self.health_url, headers={"Accept": "application/json"}), timeout=self.timeout) as response:
                raw = response.read(8192) or b"{}"
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                payload = {"backend": "ollama"}
            return {"ok": True, "backend": payload.get("backend", "local"), "ms": int((time.perf_counter() - started) * 1000)}
        except Exception as exc:
            return {"ok": False, "backend": "unavailable", "error": type(exc).__name__, "ms": int((time.perf_counter() - started) * 1000)}

    def classify(self, message: str, context: dict[str, Any] | None = None) -> tuple[str, float, dict[str, Any]]:
        if time.monotonic() < self._retry_after:
            raise TimeoutError("local Qwen router is cooling down after a connection failure")
        if not self._slots.acquire(timeout=self.timeout):
            raise TimeoutError("local Qwen router queue is full")
        started = time.perf_counter()
        try:
            system = "D&D System-1 router. Return exactly one token: A=NO_LLM, B=TOOL, C=LUNA_LOW, D=LUNA_XHIGH, E=SOL_XHIGH. Never narrate."
            compact = json.dumps({"message": _text(message, 4000), "context": context or {}}, ensure_ascii=False, separators=(",", ":"))
            body = {
                "model": os.environ.get("DND_QWEN_MODEL", "custom-opencode-qwen35-4b-q4km"),
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": compact}],
                "temperature": 0,
                "stream": False,
            }
            if self.ollama_native:
                body.update({"think": False, "options": {"temperature": 0, "num_predict": 1}})
                endpoint = self.url.removesuffix("/v1") + "/api/chat"
            else:
                body.update({"max_tokens": 1, "logprobs": True, "top_logprobs": 5})
                endpoint = self.url + "/chat/completions"
            request = Request(
                endpoint,
                data=json.dumps(body).encode(),
                headers={"Content-Type": "application/json", "Accept": "application/json"},
            )
            with urlopen(request, timeout=self.timeout) as response:
                payload = json.loads(response.read(128 * 1024) or b"{}")
            choice = (payload.get("choices") or [{}])[0]
            message = choice.get("message") or payload.get("message") or {}
            token = _text(message.get("content") or choice.get("text"), 8).upper()
            letter = next((item for item in "ABCDE" if item in token), "C")
            confidence = 0.65
            rows = ((choice.get("logprobs") or {}).get("content") or [])
            if rows and isinstance(rows[0], dict):
                candidates = rows[0].get("top_logprobs") or []
                probs = {str(item.get("token", "")).strip().upper(): float(item.get("logprob")) for item in candidates if isinstance(item, dict) and isinstance(item.get("logprob"), (int, float))}
                if probs:
                    weights = {key: pow(2.718281828, value) for key, value in probs.items()}
                    confidence = weights.get(letter, 0.0) / (sum(weights.values()) or 1.0)
            return letter, confidence, {"ms": int((time.perf_counter() - started) * 1000), "backend": "ollama" if self.ollama_native else "local-qwen"}
        except (URLError, OSError):
            self._retry_after = time.monotonic() + 30
            raise
        finally:
            self._slots.release()


class SnapshotAdapter:
    """Prefer the ODM snapshot operation and fall back to the existing read path."""

    def __init__(self, call: Callable[[str, dict[str, Any]], dict[str, Any]]):
        self.call = call

    def read(self, sections: list[str], max_bytes: int = 12000, known_revision: str | None = None) -> dict[str, Any]:
        payload = {"operation": "snapshot", "sections": sections[:6], "maxBytes": max(4096, min(131072, max_bytes))}
        if known_revision:
            payload["knownRevision"] = known_revision
        try:
            return {"path": "snapshot", "value": self.call("odm_narrator", payload)}
        except (HTTPError, URLError, KeyError, NotImplementedError, RuntimeError) as exc:
            fallback = {"operation": "read", "projection": "live", "delta": True, "maxBytes": payload["maxBytes"]}
            if known_revision:
                fallback["knownSections"] = {section: known_revision for section in sections[:6]}
            return {"path": "read-delta", "fallback": type(exc).__name__, "value": self.call("odm_narrator", fallback)}


def selective_rag(chunks: list[dict[str, Any]], scope: str, limit: int = 3, max_chars: int = 6000) -> list[dict[str, Any]]:
    if scope not in RAG_SCOPES or scope == "NONE":
        return []
    wanted = [item for item in chunks if isinstance(item, dict) and (item.get("scope") in {scope, None})]
    wanted.sort(key=lambda item: float(item.get("score", 0)), reverse=True)
    result: list[dict[str, Any]] = []
    used = 0
    for item in wanted[:limit]:
        text = _text(item.get("text"), max_chars)
        if not text or used + len(text) > max_chars:
            continue
        result.append({"id": _text(item.get("id"), 120), "scope": scope, "text": text, "score": item.get("score")})
        used += len(text)
    return result


def turn_dag(decision: DndDecision) -> list[dict[str, Any]]:
    nodes = [{"id": "qwen-route", "dependsOn": []}]
    if decision.route in {"TOOL", "NO_LLM"}:
        nodes.append({"id": "authoritative-tool", "dependsOn": ["qwen-route"], "family": decision.tool_family})
        if decision.needs_narration == "YES":
            nodes.append({"id": "narrator", "dependsOn": ["authoritative-tool"]})
        return nodes
    if decision.needs_rag == "YES":
        nodes.append({"id": "rag-read", "dependsOn": ["qwen-route"], "scope": decision.rag_scope})
    nodes.append({"id": "state-read", "dependsOn": ["qwen-route"]})
    dependencies = ["state-read"] + (["rag-read"] if decision.needs_rag == "YES" else [])
    nodes.extend([
        {"id": "context-build", "dependsOn": dependencies},
        {"id": "narrator", "dependsOn": ["context-build"], **route_model(decision.route)},
    ])
    return nodes


class DndOrchestrator:
    def __init__(self, router: LocalQwenRouter | None = None):
        self.router = router or LocalQwenRouter()
        self.mode = feature_mode()
        self._lock = threading.Lock()
        self._last: dict[str, Any] = {}

    def status(self) -> dict[str, Any]:
        health = self.router.health()
        return {
            "enabled": self.mode != "off",
            "mode": self.mode,
            "healthy": health["ok"],
            "router": {"backend": health.get("backend"), "url": self.router.url, "queue": os.environ.get("DND_QWEN_QUEUE", "2")},
            "model": os.environ.get("DND_QWEN_MODEL", "custom-opencode-qwen35-4b-q4km"),
            "decisionMode": "constrained-token",
            "last": dict(self._last),
        }

    def route(self, message: str, context: dict[str, Any] | None = None) -> tuple[DndDecision, DndTelemetry]:
        message = _text(message)
        if not message:
            raise ValueError("D&D message is required")
        play_mode = _mode((context or {}).get("playMode"))
        started = time.perf_counter()
        direct = deterministic_decision(message, play_mode)
        if direct:
            decision = direct
            telemetry = DndTelemetry(play_mode=play_mode, route=decision.route, router_confidence=decision.confidence, router_backend="code", router_mode="deterministic", router_input_tokens=max(1, len(message) // 4), total_latency_ms=int((time.perf_counter() - started) * 1000), fallback=decision.fallback)
        else:
            if self.mode == "off":
                decision = _typed_fields(message, "LUNA_LOW", 1.0, "disabled", "feature-off")
                telemetry = DndTelemetry(play_mode=play_mode, route=decision.route, router_confidence=decision.confidence, router_backend="disabled", router_mode="feature-off", router_input_tokens=max(1, len(message) // 4), total_latency_ms=int((time.perf_counter() - started) * 1000), fallback="feature-off")
            else:
                try:
                    letter, confidence, info = self.router.classify(message, context)
                    route = {"A": "NO_LLM", "B": "TOOL", "C": "LUNA_LOW", "D": "LUNA_XHIGH", "E": "SOL_XHIGH"}[letter]
                    decision = _typed_fields(message, route, confidence, str(info.get("backend") or "local-qwen"), "constrained-token")
                    telemetry = DndTelemetry(play_mode=play_mode, route=decision.route, router_confidence=decision.confidence, router_ms=int(info.get("ms") or 0), router_backend=decision.router_backend, router_mode=decision.router_mode, router_input_tokens=max(1, len(message) // 4), total_latency_ms=int((time.perf_counter() - started) * 1000), fallback=decision.fallback)
                except Exception as exc:
                    if self.mode == "on":
                        raise RuntimeError(f"DND_ORCHESTRATOR=on requires a healthy local Qwen router: {type(exc).__name__}") from exc
                    decision = _typed_fields(message, "LUNA_LOW", 0.0, "unavailable", "safe-fallback")
                    telemetry = DndTelemetry(play_mode=play_mode, route=decision.route, router_confidence=0.0, router_backend="unavailable", router_mode="safe-fallback", router_input_tokens=max(1, len(message) // 4), total_latency_ms=int((time.perf_counter() - started) * 1000), fallback="router-offline")
        with self._lock:
            self._last = {"decision": decision.as_dict(), "telemetry": telemetry.as_dict()}
        return decision, telemetry

    def plan(self, message: str, context: dict[str, Any] | None = None, rag_chunks: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        decision, telemetry = self.route(message, context)
        chosen = selective_rag(rag_chunks or [], decision.rag_scope)
        telemetry.rag_used = bool(chosen)
        telemetry.rag_scope = decision.rag_scope if chosen else "NONE"
        telemetry.rag_chunks = len(chosen)
        telemetry.rag_tokens = sum(max(1, len(_text(item.get("text"))) // 4) for item in chosen)
        telemetry.narrator_model = route_model(decision.route).get("model")
        telemetry.narrator_effort = route_model(decision.route).get("effort")
        telemetry.requested_service_tier = route_model(decision.route).get("serviceTier")
        telemetry.actual_service_tier = (
            "priority" if telemetry.requested_service_tier == "fast" else telemetry.requested_service_tier
        )
        telemetry.model_calls = 0 if decision.route in {"NO_LLM", "TOOL"} else 1
        return {"decision": decision.as_dict(), "telemetry": telemetry.as_dict(), "dag": turn_dag(decision), "rag": chosen}


class BarkPolicy:
    def __init__(self):
        self.last_by_speaker: dict[str, int] = {}

    def should_bark(self, trigger: str, speaker_id: str, action_index: int, recent_speaker: str | None = None, play_mode: str = "FULL") -> bool:
        trigger = str(trigger or "ordinary_attack").lower()
        if recent_speaker and recent_speaker == speaker_id and trigger not in {"boss_phase_transition", "combat_start"}:
            return False
        if trigger == "boss_phase_transition":
            result = True
        elif trigger in {"combat_start", "critical_hit", "bloodied"}:
            result = True
        elif trigger in {"ally_down", "critical_miss"}:
            result = action_index - self.last_by_speaker.get(speaker_id, -100) >= 1
        else:
            result = action_index - self.last_by_speaker.get(speaker_id, -100) >= (2 if _mode(play_mode) == "YOLO" else 3)
        if result:
            self.last_by_speaker[speaker_id] = action_index
        return result


class VoiceResolver:
    PROFILES = ("calm", "gravel", "bright", "theatrical", "dry", "nervous")

    def __init__(self, path: str | Path | None = None):
        self.path = Path(path).expanduser() if path else None
        self.mapping: dict[str, dict[str, Any]] = {}
        if self.path:
            try:
                loaded = json.loads(self.path.read_text(encoding="utf-8"))
                self.mapping = loaded if isinstance(loaded, dict) else {}
            except (OSError, ValueError):
                self.mapping = {}

    def resolve(self, campaign_id: str, speaker_id: str, archetype: str = "", traits: str = "") -> dict[str, Any]:
        key = f"{_text(campaign_id,80)}:{_text(speaker_id,80)}"
        if key not in self.mapping:
            digest = hashlib.sha256(f"{key}:{archetype}:{traits}".encode()).digest()
            self.mapping[key] = {"voice": self.PROFILES[digest[0] % len(self.PROFILES)], "speakerId": _text(speaker_id, 80), "archetype": _text(archetype, 60)}
            self._save()
        return dict(self.mapping[key])

    def _save(self) -> None:
        if not self.path:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}.{os.getpid()}.tmp")
        temporary.write_text(json.dumps(self.mapping, ensure_ascii=False, sort_keys=True), encoding="utf-8")
        os.replace(temporary, self.path)


def validate_narration(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"segments"} or not isinstance(value["segments"], list):
        raise ValueError("narration must contain only segments")
    segments = []
    for item in value["segments"]:
        if not isinstance(item, dict) or item.get("type") not in {"narration", "speech"}:
            raise ValueError("unsupported narration segment")
        allowed = {"type", "text"} | ({"speakerId", "delivery"} if item["type"] == "speech" else set())
        if set(item) - allowed or not _text(item.get("text"), 8000):
            raise ValueError("invalid narration segment")
        if item["type"] == "speech" and (not _text(item.get("speakerId"), 120) or item.get("delivery") not in DELIVERIES):
            raise ValueError("speech requires stable speakerId and delivery")
        segments.append(dict(item))
    return {"segments": segments}


def flatten_narration(value: dict[str, Any]) -> str:
    validated = validate_narration(value)
    rows = []
    for item in validated["segments"]:
        rows.append(item["text"] if item["type"] == "narration" else f"{item['speakerId']}: {item['text']}")
    return "\n\n".join(rows)


if __name__ == "__main__":
    fixture = DndOrchestrator(router=LocalQwenRouter(url="http://127.0.0.1:9/v1"))
    result = fixture.plan("I give Vasya one healing potion.")
    assert result["decision"]["route"] == "TOOL"
    assert result["telemetry"]["model_calls"] == 0
    assert route_model("SOL_XHIGH")["serviceTier"] == "default"
    assert flatten_narration({"segments": [{"type": "speech", "speakerId": "bartender", "text": "Enough.", "delivery": "angry"}]}) == "bartender: Enough."
    print("dnd_orchestrator self-check passed")
