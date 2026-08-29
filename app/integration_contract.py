#!/usr/bin/env python3
"""Stable frontend/RAG integration contract for the composed Runtime V3 server."""
from __future__ import annotations

from typing import Any

INTEGRATION_API_VERSION = "custom-opencode.front-rag/v1"
RUNTIME_VERSION = 3
REQUIRED_RAG_TOOLS = (
    "knowledge_get",
    "knowledge_search",
    "knowledge_sources",
    "knowledge_status",
)


def contract() -> dict[str, Any]:
    """Return the stable same-origin contract consumed by the web client.

    The object intentionally contains routes/capabilities, not secrets or local
    filesystem paths. Live status stays on the dedicated runtime/RAG endpoints.
    """
    return {
        "ok": True,
        "apiVersion": INTEGRATION_API_VERSION,
        "runtimeVersion": RUNTIME_VERSION,
        "frontend": {
            "modes": ["build", "plan"],
            "modelProfiles": [
                "direct",
                "qwen3.8-coder",
                "qwen3.8-orchestrated",
                "qwen3.8-review",
                "qwen3.8-fast",
            ],
            "orchestrationLivesInModelProfile": True,
            "queueAuthority": "server",
            "composer": {
                "idle": "send",
                "runningEmpty": "cancel",
                "runningWithPayload": "queue",
            },
            "permissionPreview": "compact-server-summary",
        },
        "routes": {
            "managedSend": {"method": "POST", "path": "/client-send.json"},
            "taskList": {"method": "GET", "path": "/client-tasks.json"},
            "taskCreate": {"method": "POST", "path": "/client-task-create.json"},
            "taskControl": {"method": "POST", "path": "/client-task-control.json"},
            "taskEvents": {"method": "GET", "path": "/client-task-events.json"},
            "runtime": {"method": "GET", "path": "/client-runtime-v3.json"},
            "runtimeEvents": {"method": "GET", "path": "/client-runtime-events.json"},
            "resourceStatus": {"method": "GET", "path": "/client-resource-status.json"},
            "modelCapabilities": {"method": "GET", "path": "/client-model-capabilities.json"},
            "mcpGateway": {"method": "GET", "path": "/client-mcp-gateway.json"},
            "ragStart": {"method": "POST", "path": "/client-rag-start.json"},
        },
        "rag": {
            "optional": True,
            "launcher": "scripts/rag-mcp.sh",
            "rootEnv": "MCP_RAG_ROOT",
            "binEnv": "MCP_RAG_BIN",
            "requiredTools": list(REQUIRED_RAG_TOOLS),
            "preflightIsModelFree": True,
            "startupMustNotCreateCollection": True,
            "startupMustNotResetCollection": True,
        },
        "compatibility": {
            "openCodeTarget": "V2 beta",
            "sameOrigin": True,
            "authenticated": True,
            "nativeOpenCodeApiRemainsAvailable": True,
            "frontendShouldPreferManagedRoutes": True,
        },
    }
