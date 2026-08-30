#!/usr/bin/env python3
"""Model capabilities, role routing, effort mapping and resource-aware decisions."""
from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import time
from typing import Any
from urllib.parse import urlsplit
import urllib.request

ALIBABA_PROVIDER = "bailian-cli"
CANONICAL_EFFORTS = ("auto", "minimal", "low", "medium", "high", "max")
ROLE_DEFAULTS = {
    "planner": "bailian-cli/qwen3.8-max",
    "builder": "bailian-cli/qwen3.7-plus",
    "reader": "bailian-cli/qwen3.8-flash",
    "reviewer": "bailian-cli/deepseek-v4-pro-0813",
    "long_horizon": "bailian-cli/glm-5.2",
}
ROLE_ENV = {
    "planner": "OPENCODE_PLANNER_MODEL",
    "builder": "OPENCODE_BUILDER_MODEL",
    "reader": "OPENCODE_READER_MODEL",
    "reviewer": "OPENCODE_REVIEW_MODEL",
    "long_horizon": "OPENCODE_LONG_HORIZON_MODEL",
}
ALIBABA_LOCKED_PREFIXES = (
    "qwen",
    "deepseek",
    "glm-",
    "wan",
    "happyhorse",
)


def _bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() not in {"0", "false", "no", "off", ""}


def _float(value: str | None, default: float) -> float:
    try:
        return float(value) if value is not None else default
    except ValueError:
        return default


def _split_ref(ref: str) -> tuple[str, str, str | None]:
    provider, sep, remainder = str(ref or "").partition("/")
    if not sep:
        return "", remainder, None
    model, hash_sep, variant = remainder.partition("#")
    return provider, model, variant if hash_sep else None


def model_ref(model: dict[str, Any]) -> str:
    provider = str(model.get("providerID") or model.get("provider") or "")
    ident = str(model.get("id") or model.get("modelID") or "")
    return f"{provider}/{ident}" if provider and ident else ident


def provider_lock_for_ref(ref: str) -> str | None:
    provider, model, _ = _split_ref(ref)
    low = model.casefold()
    if any(low.startswith(prefix) for prefix in ALIBABA_LOCKED_PREFIXES):
        return ALIBABA_PROVIDER
    if provider in {"openai", "openai-api"}:
        return provider
    return None


def validate_provider_ref(ref: str, expected: str | None = None) -> tuple[bool, str | None]:
    provider, model, _ = _split_ref(ref)
    if not provider or not model:
        return False, "model ref must be provider/model"
    locked = expected or provider_lock_for_ref(ref)
    if locked and provider != locked:
        return False, f"{model} is provider-locked to {locked}, got {provider}"
    return True, None


def _role_ref(role: str) -> str:
    default = ROLE_DEFAULTS[role]
    value = os.environ.get(ROLE_ENV[role], default).strip() or default
    ok, error = validate_provider_ref(value, ALIBABA_PROVIDER)
    if not ok:
        raise ValueError(f"{ROLE_ENV[role]}: {error}")
    return value


def role_models() -> dict[str, str]:
    return {role: _role_ref(role) for role in ROLE_DEFAULTS}


def normalize_effort(value: Any, default: str = "auto") -> str:
    text = str(value or default).strip().lower()
    return text if text in CANONICAL_EFFORTS else default


def effort_plan(ref: str, requested: str = "auto") -> dict[str, Any]:
    """Translate canonical effort into Alibaba Anthropic-compatible model settings.

    `max` is semantic: the highest supported setting for that model. Unknown models
    remain unsupported rather than receiving guessed provider parameters.
    """
    requested = normalize_effort(requested)
    provider, model, _ = _split_ref(ref)
    low = model.casefold()
    result: dict[str, Any] = {
        "requestedEffort": requested,
        "effectiveEffort": None,
        "effortSupported": False,
        "effortMapping": "unsupported",
        "settings": {},
    }
    if requested == "auto":
        result.update(effortSupported=True, effortMapping="provider-default")
        return result
    if provider != ALIBABA_PROVIDER:
        # Official OpenAI and other providers keep their native/catalog variants.
        result["effortMapping"] = "provider-native"
        return result

    if low.startswith(("qwen3.8-max", "qwen3.8-flash")):
        mapping = {
            "minimal": "low",
            "low": "low",
            "medium": "medium",
            "high": "xhigh",
            "max": "xhigh",
        }
        effective = mapping[requested]
        result.update(
            effectiveEffort=effective,
            effortSupported=True,
            effortMapping=f"alibaba-anthropic:effort:{requested}->{effective}",
            settings={"effort": effective},
        )
        return result

    if low.startswith(("qwen3.7-plus", "qwen3.7-max")):
        # Alibaba documents a 262,144 maximum thinking budget for qwen3.7-plus.
        # The intermediate budgets are a local policy and are intentionally explicit.
        budgets = {
            "minimal": 4096,
            "low": 4096,
            "medium": 16384,
            "high": 65536,
            "max": 262144,
        }
        budget = budgets[requested]
        result.update(
            effectiveEffort=requested if requested != "minimal" else "low",
            effortSupported=True,
            effortMapping=f"alibaba-anthropic:thinking_budget:{budget}",
            settings={"thinking": {"type": "enabled", "budgetTokens": budget}},
        )
        return result

    if low.startswith("deepseek-v4-pro") or low.startswith("deepseek-v4-flash") or low.startswith("glm-5"):
        # Alibaba: DeepSeek V4 / GLM expose high|max. lower levels collapse to high.
        effective = "max" if requested == "max" else "high"
        result.update(
            effectiveEffort=effective,
            effortSupported=True,
            effortMapping=f"alibaba-anthropic:effort:{requested}->{effective}",
            settings={"effort": effective},
        )
        return result

    result["effortMapping"] = "alibaba-model-unsupported"
    return result


def _cost_class(model: dict[str, Any], ref: str) -> str:
    costs = model.get("cost")
    rows = costs if isinstance(costs, list) else [costs] if isinstance(costs, dict) else []
    numeric = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        for key in ("input", "output"):
            value = row.get(key)
            if isinstance(value, (int, float)):
                numeric.append(float(value))
    if numeric and all(value == 0 for value in numeric):
        return "free"
    low = ref.lower()
    if any(token in low for token in ("flash", "mini", "nano", "free")):
        return "cheap"
    if any(token in low for token in ("max", "pro", "opus")):
        return "premium"
    return "standard"


def _quality_hints(ref: str) -> dict[str, Any]:
    low = ref.lower()
    flash = "flash" in low
    qwen_max = "qwen3.8-max" in low or "qwen3.8-orchestrated" in low
    codeish = any(token in low for token in ("qwen", "deepseek", "codex", "gpt", "glm"))
    return {
        "fastPath": flash,
        "coding": .92 if qwen_max else .84 if codeish else .65,
        "review": .94 if qwen_max else .84 if "deepseek-v4" in low else .78 if codeish else .62,
        "planning": .95 if qwen_max else .76 if flash else .74 if codeish else .62,
    }


class CapabilityRegistry:
    def __init__(self, catalog: list[dict[str, Any]] | None = None):
        self.catalog = []
        self._models: dict[str, dict[str, Any]] = {}
        self.refresh(catalog or [])

    def refresh(self, catalog: list[dict[str, Any]]) -> None:
        self.catalog = [item for item in catalog if isinstance(item, dict)]
        models: dict[str, dict[str, Any]] = {}
        for item in self.catalog:
            ref = model_ref(item)
            if not ref:
                continue
            caps = item.get("capabilities") if isinstance(item.get("capabilities"), dict) else {}
            inputs = caps.get("input") if isinstance(caps.get("input"), list) else item.get("input") if isinstance(item.get("input"), list) else []
            limit = item.get("limit") if isinstance(item.get("limit"), dict) else {}
            context = limit.get("context") or item.get("contextWindow") or item.get("context") or 0
            try:
                context = int(context or 0)
            except (TypeError, ValueError):
                context = 0
            provider, ident, _ = _split_ref(ref)
            probe = effort_plan(ref, "medium")
            variants = item.get("variants") if isinstance(item.get("variants"), list) else []
            models[ref] = {
                "ref": ref,
                "providerID": provider or str(item.get("providerID") or item.get("provider") or ""),
                "id": ident or str(item.get("id") or item.get("modelID") or ""),
                "name": str(item.get("name") or item.get("id") or ref),
                "vision": "image" in inputs,
                "tools": caps.get("tools") is True or item.get("tool_call") is True,
                "input": inputs,
                "context": context,
                "contextClass": "huge" if context >= 500_000 else "large" if context >= 180_000 else "medium" if context >= 64_000 else "small",
                "costClass": _cost_class(item, ref),
                "providerLock": provider_lock_for_ref(ref),
                "effortSupported": bool(probe.get("effortSupported")),
                "effortMapping": probe.get("effortMapping"),
                "variants": [str(v.get("id")) for v in variants if isinstance(v, dict) and v.get("id")],
                **_quality_hints(ref),
            }
        local = os.environ.get("OPENCODE_LOCAL_CODER_MODEL", "ollama/qwen3.8:27b").strip()
        if local and local not in models:
            provider, _, ident = local.partition("/")
            models[local] = {
                "ref": local,
                "providerID": provider,
                "id": ident,
                "name": ident or local,
                "vision": False,
                "tools": True,
                "input": ["text"],
                "context": 24576,
                "contextClass": "small",
                "costClass": "local",
                "fastPath": False,
                "coding": .80,
                "review": .68,
                "planning": .68,
                "providerLock": None,
                "effortSupported": False,
                "effortMapping": "unsupported",
                "variants": [],
                "available": None,
            }
        self._models = models

    def models(self) -> list[dict[str, Any]]:
        return sorted(self._models.values(), key=lambda item: (item["providerID"], item["name"].casefold()))

    def get(self, ref: str) -> dict[str, Any] | None:
        provider, model, _ = _split_ref(ref)
        return self._models.get(f"{provider}/{model}") or self._models.get(ref)

    def role_models(self) -> dict[str, str]:
        return role_models()

    def effort(self, ref: str, requested: str = "auto") -> dict[str, Any]:
        return effort_plan(ref, requested)

    def profiles(self) -> dict[str, dict[str, Any]]:
        roles = role_models()
        local = os.environ.get("OPENCODE_LOCAL_CODER_MODEL", "ollama/qwen3.8:27b").strip()
        legacy_cloud = os.environ.get("OPENCODE_CLOUD_CODER_MODEL", roles["builder"]).strip() or roles["builder"]
        orchestrated = os.environ.get("OPENCODE_ORCHESTRATED_MODEL", "bailian-cli/qwen3.8-orchestrated").strip()
        for ref in (legacy_cloud, orchestrated):
            ok, error = validate_provider_ref(ref, ALIBABA_PROVIDER)
            if not ok:
                raise ValueError(error)
        direct = {
            "id": "direct", "label": "Selected model", "route": "selected",
            "agentBuild": "build", "agentPlan": "plan", "orchestrated": False,
            "contextPolicy": {"mode": "model-aware", "targetRatio": .72},
            "sandbox": "repo-write", "autoReview": False,
        }
        fast = {
            "id": "fast", "label": "Fast", "route": "cloud",
            "cloudModel": roles["reader"], "builderModel": roles["reader"],
            "agentBuild": "build", "agentPlan": "plan", "orchestrated": False,
            "effortPolicy": {"builder": {"default": "low", "maximum": "medium"}},
            "contextPolicy": {"mode": "model-aware", "targetRatio": .70},
            "sandbox": "repo-write", "autoReview": False,
            "requires": {"tools": True, "fastPath": True},
        }
        build = {
            "id": "build", "label": "Build", "route": "cloud",
            "cloudModel": roles["builder"], "builderModel": roles["builder"],
            "readerModel": roles["reader"], "plannerModel": roles["planner"],
            "agentBuild": "build", "agentPlan": "plan", "orchestrated": False,
            "readerPolicy": "smart", "planningPolicy": "on-escalation", "reviewPolicy": "self",
            "effortPolicy": {
                "reader": {"default": "low", "maximum": "medium"},
                "builder": {"default": "medium", "afterFailure": "high", "maximum": "max"},
                "planner": {"default": "high", "critical": "max"},
            },
            "contextPolicy": {"mode": "model-aware", "targetRatio": .72},
            "sandbox": "repo-write", "autoReview": "smart",
            "requires": {"tools": True, "coding": .75},
        }
        architect = {
            "id": "architect", "label": "Architect", "route": "cloud",
            "cloudModel": orchestrated, "plannerModel": roles["planner"],
            "builderModel": roles["builder"], "readerModel": roles["reader"],
            "workerModel": roles["reader"],
            "agentBuild": "build", "agentPlan": "plan", "orchestrated": True,
            "planningPolicy": "required", "readerPolicy": "smart", "reviewPolicy": "planner-checkpoint",
            "effortPolicy": {
                "planner": {"default": "high", "critical": "max"},
                "reader": {"default": "low", "maximum": "medium"},
                "builder": {"default": "medium", "afterFailure": "high", "maximum": "max"},
            },
            "contextPolicy": {"mode": "model-aware", "targetRatio": .72, "minGrowthBeforeRecompact": 32000},
            "sandbox": "repo-write", "autoReview": "smart",
            "requires": {"tools": True, "coding": .80, "planning": .85},
        }
        critical = {
            "id": "critical", "label": "Critical", "route": "cloud",
            "cloudModel": orchestrated, "plannerModel": roles["planner"],
            "builderModel": roles["builder"], "readerModel": roles["reader"],
            "reviewerModel": roles["reviewer"], "workerModel": roles["reader"],
            "agentBuild": "build", "agentPlan": "plan", "orchestrated": True,
            "planningPolicy": "required", "readerPolicy": "smart", "reviewPolicy": "required",
            "effortPolicy": {
                "planner": {"default": "max"},
                "reader": {"default": "low", "maximum": "medium"},
                "builder": {"default": "high", "maximum": "max"},
                "reviewer": {"default": "max"},
            },
            "contextPolicy": {"mode": "model-aware", "targetRatio": .72, "minGrowthBeforeRecompact": 32000},
            "sandbox": "repo-write", "autoReview": True,
            "requires": {"tools": True, "coding": .80, "planning": .85, "review": .80},
        }
        research = {
            "id": "research", "label": "Research", "route": "cloud",
            "cloudModel": orchestrated, "plannerModel": roles["planner"],
            "readerModel": roles["reader"], "reviewerModel": roles["reviewer"],
            "builderModel": None, "workerModel": roles["reader"],
            "agentBuild": "plan", "agentPlan": "plan", "orchestrated": True,
            "planningPolicy": "required", "readerPolicy": "parallel", "reviewPolicy": "adversarial",
            "effortPolicy": {"planner": {"default": "high", "critical": "max"}, "reader": {"default": "low"}, "reviewer": {"default": "high", "critical": "max"}},
            "contextPolicy": {"mode": "model-aware", "targetRatio": .72},
            "sandbox": "safe", "autoReview": False,
        }
        long_horizon = {
            "id": "long-horizon", "label": "Long Horizon", "route": "cloud",
            "cloudModel": orchestrated, "plannerModel": roles["planner"],
            "builderModel": roles["long_horizon"], "readerModel": roles["reader"],
            "reviewerModel": roles["reviewer"], "workerModel": roles["reader"],
            "agentBuild": "build", "agentPlan": "plan", "orchestrated": True,
            "planningPolicy": "required", "readerPolicy": "smart", "reviewPolicy": "final",
            "effortPolicy": {"planner": {"default": "high", "critical": "max"}, "builder": {"default": "medium", "hard": "high", "maximum": "max"}, "reader": {"default": "low"}, "reviewer": {"default": "high", "critical": "max"}},
            "contextPolicy": {"mode": "model-aware", "targetRatio": .72},
            "sandbox": "repo-write", "autoReview": "smart",
        }
        # Preserve existing profile IDs while pointing them at the new role model defaults.
        coder_legacy = {**build, "id": "qwen3.8-coder", "label": "Qwen Coder · Auto", "route": "auto", "localModel": local, "cloudModel": legacy_cloud}
        orchestrated_legacy = {**architect, "id": "qwen3.8-orchestrated", "label": "Qwen 3.8 · Orchestrated"}
        review_legacy = {
            "id": "qwen3.8-review", "label": "Independent Review", "route": "cloud",
            "cloudModel": roles["reviewer"], "reviewerModel": roles["reviewer"],
            "agentBuild": "plan", "agentPlan": "plan", "orchestrated": False,
            "effortPolicy": {"reviewer": {"default": "high", "critical": "max"}},
            "contextPolicy": {"mode": "model-aware", "targetRatio": .70},
            "sandbox": "safe", "autoReview": False, "requires": {"tools": True, "review": .80},
        }
        fast_legacy = {**fast, "id": "qwen3.8-fast", "label": "Qwen · Fast path"}
        return {
            "direct": direct,
            "fast": fast,
            "build": build,
            "architect": architect,
            "critical": critical,
            "research": research,
            "long-horizon": long_horizon,
            "qwen3.8-coder": coder_legacy,
            "qwen3.8-orchestrated": orchestrated_legacy,
            "qwen3.8-review": review_legacy,
            "qwen3.8-fast": fast_legacy,
        }

    def snapshot(self, stats_getter=None) -> dict[str, Any]:
        rows = []
        for item in self.models():
            row = dict(item)
            if stats_getter:
                try:
                    row["telemetry"] = stats_getter(item["ref"])
                except Exception:
                    row["telemetry"] = {"samples": 0}
            rows.append(row)
        return {
            "version": 2,
            "models": rows,
            "roles": self.role_models(),
            "canonicalEfforts": list(CANONICAL_EFFORTS),
            "profiles": list(self.profiles().values()),
        }


@dataclass
class ResourceDecision:
    mode: str
    profile: str
    selected_model: str | None
    reason: str
    game_detected: bool
    pressure_high: bool
    local_available: bool | None
    processes: list[str]
    load_ratio: float | None

    def as_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "profile": self.profile,
            "selectedModel": self.selected_model,
            "reason": self.reason,
            "gameDetected": self.game_detected,
            "pressureHigh": self.pressure_high,
            "localAvailable": self.local_available,
            "matchedProcesses": self.processes,
            "loadRatio": self.load_ratio,
        }


class ResourceScheduler:
    def __init__(self):
        self._local_health_at = 0.
        self._local_health = None

    def _processes(self) -> set[str]:
        override = os.environ.get("OPENCODE_PROCESS_SNAPSHOT")
        if override is not None:
            return {item.strip().casefold() for item in override.split(";") if item.strip()}
        names = set()
        proc = Path("/proc")
        if not proc.is_dir():
            return names
        for child in list(proc.iterdir())[:10000]:
            if not child.name.isdigit():
                continue
            try:
                name = (child / "comm").read_text(encoding="utf-8", errors="ignore").strip().casefold()
                if name:
                    names.add(name)
            except OSError:
                continue
        return names

    def pressure(self) -> tuple[bool, float | None]:
        forced = os.environ.get("OPENCODE_RESOURCE_PRESSURE")
        if forced:
            high = forced.strip().lower() in {"1", "high", "true", "yes"}
            return high, 1.0 if high else 0.0
        try:
            ratio = os.getloadavg()[0] / (os.cpu_count() or 1)
            return ratio >= _float(os.environ.get("OPENCODE_RESOURCE_CPU_THRESHOLD"), .85), round(ratio, 3)
        except (AttributeError, OSError):
            return False, None

    def game_state(self) -> tuple[bool, list[str]]:
        configured = [item.strip().casefold() for item in os.environ.get("OPENCODE_GAME_PROCESSES", "").split(";") if item.strip()]
        if not configured:
            return False, []
        running = self._processes()
        matched = sorted({wanted for wanted in configured if any(wanted == proc or wanted in proc for proc in running)})
        return bool(matched), matched

    def local_available(self, force: bool = False) -> bool | None:
        now = time.monotonic()
        if not force and now - self._local_health_at < 8.:
            return self._local_health
        base = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434/v1").strip()
        try:
            parts = urlsplit(base)
            if parts.hostname not in {"localhost", "127.0.0.1", "::1"} and not _bool(os.environ.get("OPENCODE_ALLOW_REMOTE_LOCAL_PROVIDER"), False):
                self._local_health = False
            else:
                with urllib.request.urlopen(base.rstrip("/") + "/models", timeout=.45) as response:
                    self._local_health = 200 <= response.status < 500
        except Exception:
            self._local_health = False
        self._local_health_at = now
        return self._local_health

    def decide(self, profile: dict[str, Any], *, selected_model: str | None = None) -> ResourceDecision:
        mode = os.environ.get("OPENCODE_RESOURCE_SCHEDULER", "auto").strip().lower()
        route = str(profile.get("route") or "selected")
        game, matched = self.game_state()
        pressure, ratio = self.pressure()
        local_ok = None
        if mode in {"off", "observe"} or route == "selected":
            return ResourceDecision(mode, str(profile.get("id") or "direct"), selected_model, "selected model is preserved", game, pressure, None, matched, ratio)
        cloud = str(profile.get("cloudModel") or profile.get("builderModel") or profile.get("plannerModel") or selected_model or "") or None
        local = str(profile.get("localModel") or "") or None
        if cloud:
            ok, error = validate_provider_ref(cloud)
            if not ok:
                raise ValueError(error)
        if route == "cloud":
            return ResourceDecision(mode, str(profile.get("id")), cloud, "profile is cloud-pinned", game, pressure, None, matched, ratio)
        if route == "local":
            local_ok = self.local_available()
            return ResourceDecision(mode, str(profile.get("id")), local if local_ok else cloud, "local profile" if local_ok else "local unavailable; cloud fallback", game, pressure, local_ok, matched, ratio)
        if game:
            return ResourceDecision(mode, str(profile.get("id")), cloud, "game process detected; route to cloud", True, pressure, None, matched, ratio)
        if pressure:
            return ResourceDecision(mode, str(profile.get("id")), cloud, "host pressure high; route to cloud", False, True, None, matched, ratio)
        if local:
            local_ok = self.local_available()
            if local_ok:
                return ResourceDecision(mode, str(profile.get("id")), local, "host idle and local model reachable", False, False, True, matched, ratio)
        return ResourceDecision(mode, str(profile.get("id")), cloud, "local unavailable or not configured; cloud fallback", False, False, local_ok, matched, ratio)

    def snapshot(self, profiles: dict[str, dict[str, Any]]) -> dict[str, Any]:
        game, matched = self.game_state()
        pressure, ratio = self.pressure()
        local = self.local_available()
        return {
            "mode": os.environ.get("OPENCODE_RESOURCE_SCHEDULER", "auto"),
            "gameDetected": game,
            "matchedProcesses": matched,
            "pressureHigh": pressure,
            "loadRatio": ratio,
            "localAvailable": local,
            "decisions": {key: self.decide(value).as_dict() for key, value in profiles.items() if value.get("route") in {"auto", "cloud", "local"}},
        }
