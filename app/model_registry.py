#!/usr/bin/env python3
"""Model capabilities, provider-locked role routing and reasoning-effort mapping."""
from __future__ import annotations

from dataclasses import dataclass
import os
from typing import Any

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
    """Translate canonical effort into provider-specific settings.

    Canonical ``max`` means the strongest effort actually supported by the selected
    model/provider. Unsupported providers are left untouched instead of receiving
    guessed request parameters.
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
    numeric: list[float] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        for key in ("input", "output"):
            value = row.get(key)
            if isinstance(value, (int, float)):
                numeric.append(float(value))
    if numeric and all(value == 0 for value in numeric):
        return "free"
    low = ref.casefold()
    if any(token in low for token in ("flash", "mini", "nano", "free")):
        return "cheap"
    if any(token in low for token in ("max", "pro", "opus")):
        return "premium"
    return "standard"


def _quality_hints(ref: str) -> dict[str, Any]:
    low = ref.casefold()
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
        self.catalog: list[dict[str, Any]] = []
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
        orchestrated = os.environ.get("OPENCODE_ORCHESTRATED_MODEL", "bailian-cli/qwen3.8-orchestrated").strip() or "bailian-cli/qwen3.8-orchestrated"
        ok, error = validate_provider_ref(orchestrated, ALIBABA_PROVIDER)
        if not ok:
            raise ValueError(f"OPENCODE_ORCHESTRATED_MODEL: {error}")

        direct = {
            "id": "direct",
            "label": "Selected model",
            "route": "selected",
            "agentBuild": "build",
            "agentPlan": "plan",
            "orchestrated": False,
            "contextPolicy": {"mode": "model-aware", "targetRatio": .72},
            "sandbox": "repo-write",
            "autoReview": False,
        }
        fast = {
            "id": "fast",
            "label": "Fast",
            "route": "cloud",
            "cloudModel": roles["reader"],
            "builderModel": roles["reader"],
            "agentBuild": "build",
            "agentPlan": "plan",
            "orchestrated": False,
            "effortPolicy": {"builder": {"default": "low", "maximum": "medium"}},
            "contextPolicy": {"mode": "model-aware", "targetRatio": .70},
            "sandbox": "repo-write",
            "autoReview": False,
            "requires": {"tools": True, "fastPath": True},
        }
        build = {
            "id": "build",
            "label": "Build",
            "route": "cloud",
            "cloudModel": roles["builder"],
            "builderModel": roles["builder"],
            "readerModel": roles["reader"],
            "plannerModel": roles["planner"],
            "agentBuild": "build",
            "agentPlan": "plan",
            "orchestrated": False,
            "readerPolicy": "smart",
            "planningPolicy": "on-escalation",
            "reviewPolicy": "self",
            "effortPolicy": {
                "reader": {"default": "low", "maximum": "medium"},
                "builder": {"default": "medium", "afterFailure": "high", "maximum": "max"},
                "planner": {"default": "high", "critical": "max"},
            },
            "contextPolicy": {"mode": "model-aware", "targetRatio": .72},
            "sandbox": "repo-write",
            "autoReview": "smart",
            "requires": {"tools": True, "coding": .75},
        }
        architect = {
            "id": "architect",
            "label": "Architect",
            "route": "cloud",
            "cloudModel": orchestrated,
            "plannerModel": roles["planner"],
            "builderModel": roles["builder"],
            "readerModel": roles["reader"],
            "agentBuild": "build",
            "agentPlan": "plan",
            "orchestrated": True,
            "planningPolicy": "required",
            "readerPolicy": "smart",
            "reviewPolicy": "planner-checkpoint",
            "effortPolicy": {
                "planner": {"default": "high", "critical": "max"},
                "reader": {"default": "low", "maximum": "medium"},
                "builder": {"default": "medium", "afterFailure": "high", "maximum": "max"},
            },
            "contextPolicy": {"mode": "model-aware", "targetRatio": .72, "minGrowthBeforeRecompact": 32000},
            "sandbox": "repo-write",
            "autoReview": "smart",
            "requires": {"tools": True, "coding": .80, "planning": .85},
        }
        critical = {
            "id": "critical",
            "label": "Critical",
            "route": "cloud",
            "cloudModel": orchestrated,
            "plannerModel": roles["planner"],
            "builderModel": roles["builder"],
            "readerModel": roles["reader"],
            "reviewerModel": roles["reviewer"],
            "agentBuild": "build",
            "agentPlan": "plan",
            "orchestrated": True,
            "planningPolicy": "required",
            "readerPolicy": "smart",
            "reviewPolicy": "required",
            "effortPolicy": {
                "planner": {"default": "max"},
                "reader": {"default": "low", "maximum": "medium"},
                "builder": {"default": "high", "maximum": "max"},
                "reviewer": {"default": "max"},
            },
            "contextPolicy": {"mode": "model-aware", "targetRatio": .72, "minGrowthBeforeRecompact": 32000},
            "sandbox": "repo-write",
            "autoReview": True,
            "requires": {"tools": True, "coding": .80, "planning": .85, "review": .80},
        }
        research = {
            "id": "research",
            "label": "Research",
            "route": "cloud",
            "cloudModel": orchestrated,
            "plannerModel": roles["planner"],
            "readerModel": roles["reader"],
            "reviewerModel": roles["reviewer"],
            "builderModel": None,
            "agentBuild": "plan",
            "agentPlan": "plan",
            "orchestrated": True,
            "planningPolicy": "required",
            "readerPolicy": "parallel",
            "reviewPolicy": "adversarial",
            "effortPolicy": {
                "planner": {"default": "high", "critical": "max"},
                "reader": {"default": "low"},
                "reviewer": {"default": "high", "critical": "max"},
            },
            "contextPolicy": {"mode": "model-aware", "targetRatio": .72},
            "sandbox": "safe",
            "autoReview": False,
        }
        long_horizon = {
            "id": "long-horizon",
            "label": "Long Horizon",
            "route": "cloud",
            "cloudModel": orchestrated,
            "plannerModel": roles["planner"],
            "builderModel": roles["long_horizon"],
            "readerModel": roles["reader"],
            "reviewerModel": roles["reviewer"],
            "agentBuild": "build",
            "agentPlan": "plan",
            "orchestrated": True,
            "planningPolicy": "required",
            "readerPolicy": "smart",
            "reviewPolicy": "final",
            "effortPolicy": {
                "planner": {"default": "high", "critical": "max"},
                "builder": {"default": "medium", "hard": "high", "maximum": "max"},
                "reader": {"default": "low"},
                "reviewer": {"default": "high", "critical": "max"},
            },
            "contextPolicy": {"mode": "model-aware", "targetRatio": .72},
            "sandbox": "repo-write",
            "autoReview": "smart",
        }
        return {
            "direct": direct,
            "fast": fast,
            "build": build,
            "architect": architect,
            "critical": critical,
            "research": research,
            "long-horizon": long_horizon,
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
            "version": 3,
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

    def as_dict(self) -> dict[str, Any]:
        provider, _, _ = _split_ref(self.selected_model or "")
        return {
            "mode": self.mode,
            "profile": self.profile,
            "selectedModel": self.selected_model,
            "provider": provider or None,
            "reason": self.reason,
        }


class ResourceScheduler:
    """Deterministic profile router.

    There is no host-load, game-process or alternate-device model switching here.
    Direct sessions preserve the user's explicit model; managed profiles are pinned
    to their configured provider/model role entry.
    """

    def decide(self, profile: dict[str, Any], *, selected_model: str | None = None) -> ResourceDecision:
        profile_id = str(profile.get("id") or "direct")
        route = str(profile.get("route") or "selected")
        if route == "selected":
            return ResourceDecision("direct", profile_id, selected_model, "explicit selected model is preserved")
        if route != "cloud":
            raise ValueError(f"unsupported routing mode: {route}")
        target = str(
            profile.get("cloudModel")
            or profile.get("builderModel")
            or profile.get("plannerModel")
            or profile.get("readerModel")
            or profile.get("reviewerModel")
            or ""
        ) or None
        if not target:
            raise ValueError(f"profile {profile_id} has no routed model")
        ok, error = validate_provider_ref(target)
        if not ok:
            raise ValueError(error)
        return ResourceDecision("provider-pinned", profile_id, target, "profile role is provider-pinned")

    def snapshot(self, profiles: dict[str, dict[str, Any]]) -> dict[str, Any]:
        return {
            "mode": "provider-pinned",
            "decisions": {
                key: self.decide(value).as_dict()
                for key, value in profiles.items()
                if value.get("route") == "cloud"
            },
        }
