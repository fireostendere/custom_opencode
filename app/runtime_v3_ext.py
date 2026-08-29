#!/usr/bin/env python3
"""Maintenance and operational APIs for Runtime V3."""
from __future__ import annotations

import os
import threading
import time
from typing import Any
from urllib.parse import parse_qs

from runtime_store import now_ms

_LOCK=threading.Lock(); _STARTED=False; _NOTIFIED:dict[str,str]={}; _INDEXED:dict[str,float]={}
_NOTIFY={"waiting_permission","needs_attention","failed","completed"}
_ACTIVE={"queued","blocked","paused","submitted","running","waiting_permission","verifying","recovering","needs_attention"}


def install(runtime:Any,v3mod:Any,features:Any)->None:
    global _STARTED
    v3=v3mod.instance(runtime,features)
    original=runtime.SCHEDULER.snapshot
    if not getattr(runtime.SCHEDULER,"_v3_snapshot_wrapped",False):
        def snapshot(profiles):
            value=original(profiles); gpu=value.get("gpu") if isinstance(value.get("gpu"),dict) else {}
            value["pressureHigh"]=bool(value.get("pressureHigh") or gpu.get("pressureHigh")); return value
        runtime.SCHEDULER.snapshot=snapshot; runtime.SCHEDULER._v3_snapshot_wrapped=True
    with _LOCK:
        if _STARTED: return
        threading.Thread(target=_worker,args=(runtime,v3,features),name="custom-opencode-v3-maintenance",daemon=True).start(); _STARTED=True


def _has_replay(v3:Any,task_id:str)->bool:
    try: return any(item.get("kind")=="run-replay" for item in v3.replay.artifacts.list(task_id,100))
    except Exception: return False


def _worker(runtime:Any,v3:Any,features:Any)->None:
    while True:
        try:
            tasks=runtime.STORE.list_tasks(limit=500); now=time.monotonic(); projects=set()
            for task in tasks:
                project=str(task.get("project_dir") or ""); state=str(task.get("state") or "")
                if project and state in _ACTIVE: projects.add(project)
                if state in _NOTIFY and _NOTIFIED.get(str(task["id"]))!=state:
                    _NOTIFIED[str(task["id"])]=state
                    event={"type":"task.state","taskID":task["id"],"sessionID":task.get("session_id"),"projectDir":project,"state":state,"kind":task.get("kind"),"profile":task.get("profile"),"error":task.get("last_error"),"at":now_ms()}
                    v3.notifier.send(event); runtime.STORE.event(kind="notification.sent",task_id=task["id"],session_id=task.get("session_id"),project_dir=project,data={"state":state})
                if state in {"completed","failed"} and not _has_replay(v3,str(task["id"])):
                    try: v3.replay.capture(features,task)
                    except Exception as exc: runtime.STORE.event(kind="replay.capture_error",task_id=task["id"],session_id=task.get("session_id"),project_dir=project,data={"error":f"{type(exc).__name__}: {exc}"[:500]})
            for project in sorted(projects)[:40]:
                if now-_INDEXED.get(project,0.)<30.: continue
                _INDEXED[project]=now
                try: v3.indexer.refresh(project)
                except Exception as exc: runtime.STORE.event(kind="repo.index_error",project_dir=project,data={"error":f"{type(exc).__name__}: {exc}"[:500]})
        except Exception as exc:
            try: runtime.STORE.event(kind="runtime.v3_maintenance_error",data={"error":f"{type(exc).__name__}: {exc}"[:1000]})
            except Exception: pass
        time.sleep(3.)


def _directory(features:Any,payload:dict[str,Any])->str:
    sid=str(payload.get("sessionID") or "")
    return features._session_directory(sid) if sid else features._canonical_directory(str(payload.get("directory") or ""))


def mcp_snapshot(runtime:Any,v3mod:Any,features:Any,directory:str)->dict[str,Any]:
    v3=v3mod.instance(runtime,features); status=resources=tool_ids=None
    try: status=features._data(features._backend_request_json("GET",features._workspace_target("/api/mcp",directory),timeout=10.))
    except Exception as exc: status={"error":f"{type(exc).__name__}: {exc}"}
    try: resources=features._data(features._backend_request_json("GET",features._workspace_target("/api/mcp/resource",directory),timeout=10.))
    except Exception: pass
    for endpoint in ("/api/experimental/tool/ids","/experimental/tool/ids"):
        try: tool_ids=features._data(features._backend_request_json("GET",features._workspace_target(endpoint,directory),timeout=8.)); break
        except Exception: pass
    return {"ok":True,"status":status,"resources":resources,"toolIDs":tool_ids,"codeMode":True,"lazyLoading":True,"centralPolicy":True,"rateLimitPerMinute":int(os.environ.get("OPENCODE_MCP_RATE_LIMIT","120")),"secretBroker":v3.secrets.snapshot(),"credentialsExposed":False}


def handle_get(handler:Any,parsed:Any,runtime:Any,v3mod:Any,features:Any)->bool:
    if parsed.path not in {"/client-mcp-gateway-v3.json","/client-runtime-telemetry.json"}: return False
    if not handler.authenticated(): return True
    params=parse_qs(parsed.query)
    try:
        sid=str((params.get("sessionID") or [""])[0]); directory=features._session_directory(sid) if sid else features._canonical_directory(str((params.get("directory") or [""])[0]))
        if parsed.path=="/client-mcp-gateway-v3.json": handler.json_response(mcp_snapshot(runtime,v3mod,features,directory))
        else:
            cap=runtime.capability_snapshot(features,directory); models=[]
            for item in cap.get("models") or []:
                row={k:item.get(k) for k in ("ref","name","vision","tools","context","costClass","fastPath","coding","review","planning")}; row["telemetry"]=runtime.STORE.model_stats(str(item.get("ref") or "")); models.append(row)
            handler.json_response({"ok":True,"resources":runtime.resource_snapshot(),"usage":runtime.STORE.usage_summary(),"models":models,"mcp":mcp_snapshot(runtime,v3mod,features,directory)})
    except Exception as exc: handler._feature_error(exc)
    return True


def handle_post(handler:Any,parsed:Any,runtime:Any,v3mod:Any,features:Any)->bool:
    if parsed.path not in {"/client-task-sandbox.json","/client-mailbox.json","/client-decision.json","/client-project-memory-v3.json"}: return False
    if not handler.authenticated(): return True
    try:
        payload=handler._feature_body(); v3=v3mod.instance(runtime,features)
        if parsed.path=="/client-task-sandbox.json":
            task_id=str(payload.get("taskID") or ""); task=runtime.STORE.get_task(task_id)
            if not task: raise KeyError(task_id)
            sandbox=v3.sandbox.normalize(str(payload.get("sandbox") or ""))
            if sandbox=="full-machine" and os.environ.get("OPENCODE_ALLOW_FULL_MACHINE","0").lower() not in {"1","true","yes"}: raise PermissionError("full-machine sandbox is disabled")
            task=runtime.STORE.update_task(task_id,metadata_patch={"sandbox":sandbox}); runtime.STORE.event(kind="sandbox.changed",task_id=task_id,session_id=task.get("session_id"),project_dir=task.get("project_dir"),data={"sandbox":sandbox}); result={"ok":True,"task":runtime._public(task)}
        elif parsed.path=="/client-mailbox.json":
            project=_directory(features,payload); body=payload.get("payload") if isinstance(payload.get("payload"),dict) else {"text":str(payload.get("text") or "")}; result={"ok":True,"message":runtime.STORE.mailbox_send(project_dir=project,from_task=str(payload.get("fromTask") or "") or None,to_task=str(payload.get("toTask") or "") or None,message_type=str(payload.get("type") or "finding")[:80],payload=body)}
        elif parsed.path=="/client-decision.json":
            project=_directory(features,payload); result={"ok":True,"decision":runtime.STORE.decision_add(project,str(payload.get("title") or "Decision"),str(payload.get("decision") or ""),str(payload.get("rationale") or ""))}
        else:
            project=_directory(features,payload); key=str(payload.get("key") or "")[:240]
            if not key: raise ValueError("memory key required")
            runtime.STORE.memory_set(project,key,str(payload.get("value") or ""),str(payload.get("category") or "note")); result={"ok":True,"memory":runtime.STORE.memory_list(project,limit=200)}
        handler.json_response(result)
    except Exception as exc: handler._feature_error(exc)
    return True
