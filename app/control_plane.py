#!/usr/bin/env python3
"""Deterministic permission risk classifier for the custom OpenCode web layer.

The classifier never asks an LLM whether its own action is safe. It classifies
actual pending OpenCode permission payloads and only marks bounded low-risk
operations as eligible for automatic handling. R3/R4 remain interactive.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
from typing import Any

POLICY_VERSION = 2
POLICY_PRESETS = {"safe", "workspace", "autonomous"}
DEFAULT_POLICY = "workspace"
RISK_ORDER = {"R0": 0, "R1": 1, "R2": 2, "R3": 3, "R4": 4}

READ_ACTIONS = {
    "read", "glob", "grep", "list", "lsp",
    "kb_knowledge_search", "kb_knowledge_get", "kb_knowledge_sources", "kb_knowledge_status",
}
KB_READ_ACTIONS = {
    "kb_knowledge_search", "kb_knowledge_get", "kb_knowledge_sources", "kb_knowledge_status",
}
WRITE_ACTIONS = {"edit", "write", "patch"}
SHELL_ACTIONS = {"shell", "bash"}

SENSITIVE_PATH_RE = re.compile(
    r"(?:^|[/\\\s])(?:\.env(?:\.|$)|\.ssh(?:[/\\]|$)|\.gnupg(?:[/\\]|$)|"
    r"id_(?:rsa|ed25519)(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$))",
    re.IGNORECASE,
)
SHELL_META_RE = re.compile(r"[;&|><`\n]|\$\(")
SECRET_ASSIGNMENT_RE = re.compile(
    r"(?i)\b(token|api[_-]?key|password|secret|authorization)\s*=\s*([^\s,;]+)"
)

SAFE_SIMPLE_COMMANDS = {
    "ls", "pwd", "cat", "head", "tail", "wc", "stat", "tree",
    "rg", "grep", "du", "df", "uname", "whoami", "which", "realpath", "readlink",
}
SAFE_GIT_SUBCOMMANDS = {
    "status", "diff", "log", "show", "rev-parse", "ls-files", "grep", "remote",
}
def policy_preset(value: str | None = None) -> str:
    raw = (value or os.environ.get("OPENCODE_PERMISSION_POLICY") or DEFAULT_POLICY).strip().lower()
    return raw if raw in POLICY_PRESETS else DEFAULT_POLICY


def risk_at_most(risk: str, maximum: str = "R2") -> bool:
    return RISK_ORDER.get(str(risk), 99) <= RISK_ORDER.get(maximum, 2)


def _resource_strings(request: dict[str, Any]) -> list[str]:
    raw: Any = request.get("resources")
    if raw is None:
        raw = request.get("resource")
    if raw is None:
        raw = request.get("patterns")
    if raw is None:
        raw = request.get("always")
    if isinstance(raw, str):
        return [raw]
    if isinstance(raw, list):
        values: list[str] = []
        for item in raw:
            if isinstance(item, str):
                values.append(item)
            elif isinstance(item, dict):
                for key in ("path", "command", "resource", "pattern", "value"):
                    value = item.get(key)
                    if isinstance(value, str) and value:
                        values.append(value)
                        break
        return values
    if isinstance(raw, dict):
        for key in ("path", "command", "resource", "pattern", "value"):
            value = raw.get(key)
            if isinstance(value, str) and value:
                return [value]
    return []


def _looks_sensitive(value: str) -> bool:
    return bool(SENSITIVE_PATH_RE.search(value.replace("\\", "/")))


def _path_within_workspace(value: str, workspace: str | None) -> bool:
    if not workspace:
        return False
    try:
        root = Path(workspace).expanduser().resolve(strict=False)
        candidate = Path(value).expanduser()
        resolved = candidate.resolve(strict=False) if candidate.is_absolute() else (root / candidate).resolve(strict=False)
    except (OSError, RuntimeError, TypeError, ValueError):
        return False
    return resolved == root or root in resolved.parents


def _shell_command(request: dict[str, Any]) -> str:
    metadata = request.get("metadata")
    if isinstance(metadata, dict):
        for key in ("command", "cmd"):
            value = metadata.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    for value in _resource_strings(request):
        if value.strip():
            return value.strip()
    return ""


def _unsafe_path_argument(argv: list[str], workspace: str | None) -> str | None:
    for arg in argv[1:]:
        if not arg or arg == "-" or arg.startswith("-"):
            continue
        if _looks_sensitive(arg):
            return arg
        if not _path_within_workspace(arg, workspace):
            return arg
    return None


def _shell_risk(command: str, preset: str, workspace: str | None) -> tuple[str, bool, str]:
    if not command:
        return "R3", False, "shell command is missing from the permission payload"
    if len(command) > 4096:
        return "R3", False, "shell command is too large for automatic approval"
    if _looks_sensitive(command):
        return "R4", False, "shell command references a sensitive path"
    if SHELL_META_RE.search(command):
        return "R3", False, "compound shell syntax requires confirmation"
    try:
        argv = shlex.split(command, posix=True)
    except ValueError:
        return "R3", False, "shell command could not be parsed safely"
    if not argv:
        return "R3", False, "empty shell command"
    if "/" in argv[0] or "\\" in argv[0]:
        return "R3", False, "path-qualified executable requires confirmation"

    executable = Path(argv[0]).name
    unsafe_path = _unsafe_path_argument(argv, workspace)
    if unsafe_path:
        return (
            "R4" if _looks_sensitive(unsafe_path) else "R3",
            False,
            "command references a path outside the workspace or a sensitive path",
        )

    if executable == "rg" and any(arg == "--pre" or arg.startswith("--pre=") for arg in argv[1:]):
        return "R3", False, "ripgrep preprocessor can execute another command"
    if executable == "tree" and any(arg == "-o" or arg.startswith("--output") for arg in argv[1:]):
        return "R3", False, "tree output option can mutate the filesystem"

    if executable in SAFE_SIMPLE_COMMANDS:
        return "R0", True, f"read-only command: {executable}"

    if executable == "git" and len(argv) >= 2 and argv[1] in SAFE_GIT_SUBCOMMANDS:
        if argv[1] == "remote" and argv[2:] not in ([], ["-v"], ["--verbose"]):
            return "R3", False, "git remote mutation requires confirmation"
        if any(arg == "-o" or arg.startswith("--output") for arg in argv[2:]):
            return "R3", False, "git output option can mutate the filesystem"
        if any(arg in {"--ext-diff", "--textconv"} or arg.startswith("--open-files-in-pager") for arg in argv[2:]):
            return "R3", False, "git option can execute an external helper"
        return "R0", True, f"read-only git {argv[1]}"

    if executable in {"python", "python3", "node", "npm", "pnpm", "bun", "git"} and len(argv) == 2 and argv[1] in {"--version", "-V"}:
        return "R0", True, "version probe"

    return "R3", False, "command can mutate state or produce external side effects"


def classify_permission(
    request: dict[str, Any],
    *,
    workspace: str | None = None,
    preset: str | None = None,
) -> dict[str, Any]:
    selected = policy_preset(preset)
    action = str(request.get("action") or request.get("permission") or request.get("type") or "").strip().lower()
    resources = _resource_strings(request)
    decision: dict[str, Any] = {
        "policyVersion": POLICY_VERSION,
        "preset": selected,
        "action": action or "unknown",
        "effect": "ask",
        "auto": False,
        "reply": None,
        "risk": "R3",
        "reason": "unknown or ambiguous action requires confirmation",
        "source": "global",
    }

    if action in READ_ACTIONS:
        if action not in KB_READ_ACTIONS:
            if action == "read" and not resources:
                decision.update(risk="R3", reason="read target is missing from the permission payload")
                return decision
            if resources and any(_looks_sensitive(value) for value in resources):
                decision.update(risk="R4", reason="sensitive filesystem read requires confirmation")
                return decision
            if resources and any(not _path_within_workspace(value, workspace) for value in resources):
                decision.update(risk="R3", reason="filesystem read target escapes the workspace")
                return decision
        decision.update(effect="allow", auto=True, reply="once", risk="R0", reason="read-only operation")
        return decision

    if action in WRITE_ACTIONS:
        if not resources:
            decision.update(risk="R3", reason="file mutation target is missing from the permission payload")
            return decision
        if any(_looks_sensitive(value) for value in resources):
            decision.update(risk="R4", reason="sensitive file mutation requires confirmation")
            return decision
        inside = all(_path_within_workspace(value, workspace) for value in resources)
        if not inside:
            decision.update(risk="R3", reason="file mutation target escapes the workspace")
            return decision
        if selected in {"workspace", "autonomous"}:
            decision.update(effect="allow", auto=True, reply="once", risk="R2", reason="workspace-local file mutation")
        else:
            decision.update(risk="R2", reason="workspace-local mutation remains interactive in safe policy")
        return decision

    if action in SHELL_ACTIONS:
        risk, allow, reason = _shell_risk(_shell_command(request), selected, workspace)
        decision.update(risk=risk, reason=reason)
        if allow:
            decision.update(effect="allow", auto=True, reply="once")
        return decision

    if action in {"webfetch", "fetch", "http"}:
        if selected == "autonomous":
            decision.update(effect="allow", auto=True, reply="once", risk="R1", reason="read-only network fetch allowed by autonomous policy")
        else:
            decision.update(risk="R1", reason="network access remains interactive outside autonomous policy")
        return decision

    if action in {"external_directory", "subagent", "task", "kb_knowledge_ingest"}:
        decision.update(risk="R3", reason=f"{action} crosses a workspace or execution boundary")
        return decision

    return decision


def _state_dir() -> Path:
    configured = os.environ.get("CUSTOM_OPENCODE_FEATURE_STATE")
    if configured:
        return Path(configured).expanduser().parent
    root = Path(os.environ.get("XDG_STATE_HOME") or (Path.home() / ".local/state"))
    return root / "custom-opencode"


def _redact(value: str) -> str:
    compact = " ".join(value.split())
    compact = SECRET_ASSIGNMENT_RE.sub(lambda match: f"{match.group(1)}=<redacted>", compact)
    return compact[:180]


def audit_decision(
    decision: dict[str, Any],
    *,
    request: dict[str, Any],
    session_id: str | None = None,
    permission_id: str | None = None,
    outcome: str = "evaluated",
) -> None:
    if os.environ.get("OPENCODE_PERMISSION_AUDIT", "1").strip().lower() in {"0", "false", "no"}:
        return
    resources = _resource_strings(request)
    event = {
        "time": datetime.now(timezone.utc).isoformat(),
        "policyVersion": POLICY_VERSION,
        "preset": decision.get("preset"),
        "action": decision.get("action"),
        "effect": decision.get("effect"),
        "auto": bool(decision.get("auto")),
        "risk": decision.get("risk"),
        "reason": decision.get("reason"),
        "source": decision.get("source"),
        "outcome": outcome,
        "session": session_id,
        "permission": permission_id,
        "resourceCount": len(resources),
        "resource": _redact(resources[0]) if resources else None,
        "fingerprint": hashlib.sha256("\n".join(resources).encode("utf-8", errors="replace")).hexdigest()[:16] if resources else None,
    }
    try:
        directory = _state_dir()
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = directory / "permission-audit.jsonl"
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
    except OSError:
        pass


def snapshot() -> dict[str, Any]:
    preset = policy_preset()
    return {
        "controlPlaneVersion": 2,
        "permissionPolicy": {
            "version": POLICY_VERSION,
            "preset": preset,
            "presets": sorted(POLICY_PRESETS),
            "audit": os.environ.get("OPENCODE_PERMISSION_AUDIT", "1").strip().lower() not in {"0", "false", "no"},
            "automatic": {
                "R0ReadOnly": True,
                "R1WorkspaceChecks": preset in {"workspace", "autonomous"},
                "R2WorkspaceWrites": preset in {"workspace", "autonomous"},
                "networkRead": preset == "autonomous",
            },
            "alwaysInteractive": [
                "R3 boundary/destructive/ambiguous actions",
                "R4 sensitive files or credentials",
                "compound shell commands",
                "external directories and subagent escalation",
                "RAG ingestion",
            ],
            "projectRules": "first match; deny/ask override global policy; allow may auto-approve only R0-R2",
        },
    }
