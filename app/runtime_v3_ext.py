#!/usr/bin/env python3
"""Maintenance and operational APIs for Runtime V3."""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import threading
import time
from typing import Any
from urllib.parse import parse_qs

from runtime_store import now_ms

_LOCK=threading.Lock(); _STARTED=False; _NOTIFIED:dict[str,str]={}; _INDEXED:dict[str,float]={}
_NOTIFY={"waiting_permission","needs_attention","failed","completed"}
_ACTIVE={"queued","blocked","paused","submitted","running","waiting_permission","verifying","recovering","needs_attention"}
_WRITE_TOOLS={"edit","write","apply_patch","patch","multiedit"}


def install(runtime:Any,v3mod:Any,features:Any)->None:
    global _STARTED
    v3=v3mod.instance(runtime,features)
    original=runtime.SCHEDULER.snapshot
    if not getattr(runtime.SCHEDULER,"_v3_snapshot_wrapped",False):
        def snapshot(profiles):
            value=original(profiles); gpu=value.get("gpu") if isinstance(value.get("gpu"),dict) else {}
            value["pressureHigh"]=bool(value.get("pressureHigh") or gpu.get("pressureHigh")); return value
        runtime.SCHEDULER.snapshot=snapshot; runtime.SCHEDULER._v3_snapshot_wrapped=True
    # V2 already detects worktree conflicts while polling. Enforce the same
    # ownership root before mutations so parallel worktrees cannot race between polls.
    if not getattr(v3.gateway,"_ownership_root_wrapped",False):
        original_before=v3.gateway.before
        def before(payload):
            result=original_before(payload); tool=str(payload.get("tool") or "")
            if tool not in _WRITE_TOOLS: return result
            task=v3.gateway._task(str(payload.get("sessionID") or "") or None,str(payload.get("cwd") or "") or None)
            if not task: return result
            metadata=task.get("metadata") if isinstance(task.get("metadata"),dict) else {}; owner=str(metadata.get("ownershipRoot") or task.get("project_dir") or ""); project=str(task.get("project_dir") or "")
            if not owner or owner==project: return result
            paths=v3.gateway._paths(tool,payload.get("input") if isinstance(payload.get("input"),(dict,list)) else {})
            runtime.STORE.ownership_replace(project,str(task["id"]),[])
            conflicts=runtime.STORE.ownership_replace(owner,str(task["id"]),paths)
            if conflicts:
                runtime.STORE.event(kind="patch.conflict",task_id=task["id"],session_id=task.get("session_id"),project_dir=owner,data={"conflicts":conflicts,"phase":"pre-write"})
                raise RuntimeError("patch ownership conflict: "+", ".join(f"{c['path']} owned by {c['taskID']}" for c in conflicts[:8]))
            return result
        v3.gateway.before=before; v3.gateway._ownership_root_wrapped=True
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


def _run_git(root:str,args:list[str],input_text:str|None=None,timeout:float=30.)->subprocess.CompletedProcess[str]:
    return subprocess.run(["git","-C",root,*args],input=input_text,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=timeout,check=False)


def _worktree_merge(runtime:Any,task:dict[str,Any],cleanup:bool=False)->dict[str,Any]:
    metadata=task.get("metadata") if isinstance(task.get("metadata"),dict) else {}; worktree=str(metadata.get("worktree") or ""); owner=str(metadata.get("ownershipRoot") or "")
    if not worktree or not owner: raise ValueError("task is not an isolated managed worktree")
    if not Path(worktree).is_dir() or not Path(owner).is_dir(): raise ValueError("worktree/root missing")
    base=str((task.get("baseline") or {}).get("head") or "HEAD")
    changed_proc=_run_git(worktree,["diff","--name-only","-z",base]); status_proc=_run_git(worktree,["status","--porcelain=v1","-z"])
    if changed_proc.returncode!=0 or status_proc.returncode!=0: raise RuntimeError((changed_proc.stderr or status_proc.stderr).strip() or "worktree status failed")
    tracked=[item for item in changed_proc.stdout.split("\0") if item]; untracked=[]
    rows=[item for item in status_proc.stdout.split("\0") if item]
    for row in rows:
        if row.startswith("?? "): untracked.append(row[3:])
    paths=sorted(dict.fromkeys([*tracked,*untracked]))
    if not paths: return {"ok":True,"taskID":task["id"],"changed":[],"message":"worktree has no changes"}
    for relative in paths:
        dirty=_run_git(owner,["status","--porcelain=v1","--",relative])
        if dirty.returncode!=0: raise RuntimeError(dirty.stderr.strip() or f"cannot inspect {relative}")
        if dirty.stdout.strip(): raise RuntimeError(f"target root already has uncommitted changes in {relative}")
    conflicts=runtime.STORE.ownership_replace(owner,str(task["id"]),paths)
    if conflicts: raise RuntimeError("worktree merge ownership conflict: "+", ".join(f"{c['path']} owned by {c['taskID']}" for c in conflicts[:10]))
    patch=_run_git(worktree,["diff","--binary",base,"--"],timeout=60.)
    if patch.returncode!=0: raise RuntimeError(patch.stderr.strip() or "worktree diff failed")
    if patch.stdout:
        applied=_run_git(owner,["apply","--3way","--whitespace=nowarn","-"],patch.stdout,60.)
        if applied.returncode!=0:
            runtime.STORE.event(kind="worktree.merge_conflict",task_id=task["id"],session_id=task.get("session_id"),project_dir=owner,data={"paths":paths,"error":applied.stderr[-2000:]})
            raise RuntimeError(applied.stderr.strip() or "git apply --3way failed")
        _run_git(owner,["reset","-q","HEAD","--",*tracked],timeout=20.)
    copied=[]
    for relative in untracked:
        source=(Path(worktree)/relative).resolve(strict=True); target=(Path(owner)/relative).resolve(strict=False)
        try: source.relative_to(Path(worktree).resolve()); target.relative_to(Path(owner).resolve())
        except ValueError: raise RuntimeError(f"unsafe untracked path: {relative}")
        if target.exists(): raise RuntimeError(f"target already exists for untracked file: {relative}")
        target.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(source,target); copied.append(relative)
    runtime.STORE.checkpoint(task["id"],"worktree-merged",summary=f"Merged {len(paths)} isolated paths into project root",data={"ownershipRoot":owner,"paths":paths})
    runtime.STORE.event(kind="worktree.merged",task_id=task["id"],session_id=task.get("session_id"),project_dir=owner,data={"paths":paths,"copiedUntracked":copied})
    result={"ok":True,"taskID":task["id"],"target":owner,"changed":paths,"copiedUntracked":copied}
    if cleanup:
        _run_git(worktree,["reset","--hard",base],timeout=20.); _run_git(worktree,["clean","-fd"],timeout=20.); result["cleanup"]=runtime._remove_worktree(runtime.STORE.get_task(task["id"]) or task)
    return result


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
    if not handler.authenticated(): handler.unauthorized(); return True
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
    if parsed.path not in {"/client-task-sandbox.json","/client-worktree-merge.json","/client-mailbox.json","/client-decision.json","/client-project-memory-v3.json"}: return False
    if not handler.authenticated(): handler.unauthorized(); return True
    try:
        payload=handler._feature_body(); v3=v3mod.instance(runtime,features)
        if parsed.path=="/client-task-sandbox.json":
            task_id=str(payload.get("taskID") or ""); task=runtime.STORE.get_task(task_id)
            if not task: raise KeyError(task_id)
            sandbox=v3.sandbox.normalize(str(payload.get("sandbox") or ""))
            if sandbox=="full-machine" and os.environ.get("OPENCODE_ALLOW_FULL_MACHINE","0").lower() not in {"1","true","yes"}: raise PermissionError("full-machine sandbox is disabled")
            task=runtime.STORE.update_task(task_id,metadata_patch={"sandbox":sandbox}); runtime.STORE.event(kind="sandbox.changed",task_id=task_id,session_id=task.get("session_id"),project_dir=task.get("project_dir"),data={"sandbox":sandbox}); result={"ok":True,"task":runtime._public(task)}
        elif parsed.path=="/client-worktree-merge.json":
            task=runtime.STORE.get_task(str(payload.get("taskID") or ""))
            if not task: raise KeyError(payload.get("taskID"))
            result=_worktree_merge(runtime,task,bool(payload.get("cleanup")))
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
