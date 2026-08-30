#!/usr/bin/env python3
"""Final control-plane completion layer for Runtime V3.

Keeps small cross-cutting policies out of the core runtime modules: semantic
permission previews, shared pre-execution read cache, wasted-retry accounting,
branch-state handoff, and compact remote approve/cancel APIs.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shlex
from typing import Any
from urllib.parse import parse_qs

from repo_services import git_snapshot
from runtime_store import now_ms

_INSTALLED=False
_ORIGINAL_DECISION=None
_ORIGINAL_USAGE_STAGE=None
_ORIGINAL_BRANCH_MERGE=None


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve(strict=False).relative_to(root.resolve(strict=False))
        return True
    except (ValueError, OSError, RuntimeError):
        return False


def _resource_strings(request: dict[str, Any]) -> list[str]:
    raw=request.get("resources",request.get("resource",request.get("patterns")))
    if isinstance(raw,str): return [raw]
    if isinstance(raw,list):
        out=[]
        for item in raw:
            if isinstance(item,str): out.append(item)
            elif isinstance(item,dict):
                for key in ("path","command","resource","pattern","value"):
                    value=item.get(key)
                    if isinstance(value,str) and value: out.append(value); break
        return out
    if isinstance(raw,dict):
        for key in ("path","command","resource","pattern","value"):
            value=raw.get(key)
            if isinstance(value,str) and value: return [value]
    return []


def _compact_path(path: str, workspace: str) -> str:
    try:
        root=Path(workspace).resolve(strict=False); target=Path(path).expanduser()
        target=target.resolve(strict=False) if target.is_absolute() else (root/target).resolve(strict=False)
        if _inside(target,root):
            rel=target.relative_to(root).as_posix()
            return rel or "."
    except Exception: pass
    return str(path)[:100]


def _common_location(paths: list[str], workspace: str) -> str:
    if not paths: return "проекте"
    root=Path(workspace).resolve(strict=False)
    compact=[_compact_path(item,workspace) for item in paths]
    parents=[]
    for original,item in zip(paths,compact):
        p=Path(item); is_dir=original.endswith(("/","\\"))
        try:
            raw=Path(original).expanduser(); target=raw.resolve(strict=False) if raw.is_absolute() else (root/raw).resolve(strict=False)
            is_dir=is_dir or (_inside(target,root) and target.is_dir())
        except (OSError,RuntimeError,ValueError): pass
        parents.append(p if is_dir else p.parent)
    try: common=os.path.commonpath([str(p) for p in parents])
    except ValueError: common=""
    return "проекте" if common in {"","."} else f"{common.rstrip('/')}/"


def _count_delete_targets(argv: list[str], workspace: str) -> tuple[int,list[str]]:
    root=Path(workspace).resolve(strict=False); targets=[]; count=0
    for arg in argv[1:]:
        if not arg or arg.startswith("-"): continue
        candidate=Path(arg).expanduser(); candidate=candidate.resolve(strict=False) if candidate.is_absolute() else (root/candidate).resolve(strict=False)
        if not _inside(candidate,root): continue
        targets.append(arg)
        if candidate.is_dir():
            local=0
            try:
                for base,dirs,files in os.walk(candidate,followlinks=False):
                    dirs[:]=[d for d in dirs if _inside(Path(base)/d,root)]
                    local+=len(files)
                    if local>=10000: break
            except OSError: local=1
            count+=max(1,local)
        else: count+=1
    return count,targets


def permission_preview(request: dict[str, Any], workspace: str) -> str:
    action=str(request.get("action") or request.get("permission") or request.get("type") or "").strip().lower()
    resources=_resource_strings(request)
    metadata=request.get("metadata") if isinstance(request.get("metadata"),dict) else {}
    if action in {"edit","write","patch","apply_patch"}:
        n=max(1,len(resources)); noun="файл" if n==1 else "файла" if 2<=n<=4 else "файлов"
        return f"Изменить {n} {noun} в {_common_location(resources,workspace)}"
    if action in {"read","glob","grep","list","lsp"}:
        if resources:
            n=len(resources); noun="ресурс" if n==1 else "ресурса" if 2<=n<=4 else "ресурсов"
            return f"Прочитать {n} {noun} в {_common_location(resources,workspace)}"
        return "Прочитать данные проекта"
    if action in {"shell","bash"}:
        command=str(metadata.get("command") or metadata.get("cmd") or (resources[0] if resources else "")).strip()
        try: argv=shlex.split(command,posix=True)
        except ValueError: argv=[]
        if argv and Path(argv[0]).name=="rm":
            count,targets=_count_delete_targets(argv,workspace)
            if targets:
                noun="объект" if count==1 else "объекта" if 2<=count<=4 else "объектов"
                return f"Удалить {count} {noun} в {_common_location(targets,workspace)}"
        if argv and Path(argv[0]).name=="git" and len(argv)>1:
            return f"Git: {argv[1]}"+(f" · {' '.join(argv[2:])[:90]}" if len(argv)>2 else "")
        return "Выполнить команду: "+(" ".join(command.split())[:130] if command else "неизвестная команда")
    if action in {"webfetch","fetch","http"}: return "Получить данные из сети"
    if action=="external_directory": return "Дать доступ за пределы проекта"
    if action in {"subagent","task"}: return "Запустить дополнительного агента"
    if action=="kb_knowledge_ingest": return "Добавить новые данные в базу знаний"
    return f"Разрешить действие: {action or 'unknown'}"


def _wrap_permission_decision(control: Any) -> None:
    global _ORIGINAL_DECISION
    if _ORIGINAL_DECISION is not None: return
    _ORIGINAL_DECISION=control.decision_for
    def decision_for(request: dict[str,Any], directory: str) -> dict[str,Any]:
        value=_ORIGINAL_DECISION(request,directory); value["preview"]=permission_preview(request,directory); return value
    control.decision_for=decision_for


def _wrap_usage_stage(runtime: Any) -> None:
    global _ORIGINAL_USAGE_STAGE
    if _ORIGINAL_USAGE_STAGE is not None: return
    _ORIGINAL_USAGE_STAGE=runtime._usage_stage
    def usage_stage(task: dict[str,Any]) -> str:
        metadata=task.get("metadata") if isinstance(task.get("metadata"),dict) else {}; kind=str(task.get("kind") or "")
        if kind in {"verification-fix","retry","recovery"} or metadata.get("repairOf") or int(task.get("dispatch_attempts") or 0)>1: return "wasted_retries"
        return _ORIGINAL_USAGE_STAGE(task)
    runtime._usage_stage=usage_stage


def _wrap_branch_merge(runtime: Any, v3mod: Any) -> None:
    global _ORIGINAL_BRANCH_MERGE
    if _ORIGINAL_BRANCH_MERGE is not None: return
    _ORIGINAL_BRANCH_MERGE=v3mod.BranchStateService.merge
    def merge(self,features,source_session,target_session,*,include_state=True):
        result=_ORIGINAL_BRANCH_MERGE(self,features,source_session,target_session,include_state=include_state)
        if not include_state: return result
        source=runtime.STORE.list_tasks(session_id=source_session,limit=200); target=runtime.STORE.list_tasks(session_id=target_session,limit=200); target_task=target[0] if target else None; state=[]
        for task in source[:40]:
            checkpoints=runtime.STORE.checkpoints(task["id"],limit=8); meaningful=next((cp for cp in checkpoints if cp.get("stage") not in {"created","queued","dispatched"}),checkpoints[0] if checkpoints else None); metadata=task.get("metadata") if isinstance(task.get("metadata"),dict) else {}
            state.append({"taskID":task["id"],"kind":task.get("kind"),"state":task.get("state"),"checkpoint":meaningful,"handoff":metadata.get("handoff"),"route":task.get("route")})
        if target_task and state:
            payload={"sourceSessionID":source_session,"type":"branch-state","tasks":state[:20]}; runtime.STORE.mailbox_send(project_dir=target_task["project_dir"],from_task=None,to_task=target_task["id"],message_type="handoff",payload=payload); runtime.STORE.checkpoint(target_task["id"],"branch-state-merged",summary=f"Merged agent state from {source_session}",data={"sourceTasks":[item["taskID"] for item in state[:20]]})
        result["mergedAgentState"]=len(state); result["targetTaskID"]=target_task.get("id") if target_task else None; return result
    v3mod.BranchStateService.merge=merge
    instance=getattr(v3mod,"_INSTANCE",None)
    if instance is not None: instance.branches.merge=merge.__get__(instance.branches,v3mod.BranchStateService)


def install(runtime: Any, v3mod: Any, control: Any, features: Any) -> None:
    global _INSTALLED
    if _INSTALLED: return
    _wrap_permission_decision(control); _wrap_usage_stage(runtime); _wrap_branch_merge(runtime,v3mod); runtime.STORE.event(kind="runtime.completion_installed",data={"features":["semantic-permission-preview","shared-tool-cache","wasted-retry-accounting","branch-state-handoff","remote-actions"]}); _INSTALLED=True


def _cacheable(tool: str, inp: Any) -> bool:
    if tool in {"read","glob","grep","list","lsp"}: return True
    if tool in {"shell","bash"} and isinstance(inp,dict):
        command=str(inp.get("command") or "").strip().lower(); allowed=("git status","git diff","git log","git show","git rev-parse","git ls-files","tree","ls","pwd")
        return any(command==prefix or command.startswith(prefix+" ") for prefix in allowed) and not any(token in command for token in (";","&&","||",">","<","`","$("))
    return tool.endswith(("_knowledge_search","_knowledge_get","_knowledge_sources","_knowledge_status"))


def _tool_cache_key(tool: str, inp: Any, cwd: str) -> str:
    snap=git_snapshot(cwd) if cwd and Path(cwd).is_dir() else {"head":None,"statusHash":None}; raw=json.dumps([tool,inp,snap.get("head"),snap.get("statusHash")],ensure_ascii=False,sort_keys=True,default=str); return hashlib.sha256(raw.encode()).hexdigest()


def _internal_auth(handler: Any) -> bool:
    expected=os.environ.get("OPENCODE_RUNTIME_PLUGIN_TOKEN") or os.environ.get("OPENCODE_SERVER_PASSWORD") or ""; supplied=handler.headers.get("X-OpenCode-Runtime",""); return bool(expected and supplied and hashlib.sha256(expected.encode()).digest()==hashlib.sha256(supplied.encode()).digest())


def _json_body(handler: Any, limit: int=2_000_000) -> dict[str,Any]:
    if hasattr(handler,"_feature_body"): return handler._feature_body(limit)
    length=int(handler.headers.get("Content-Length","0"))
    if length<0 or length>limit: raise ValueError("request too large")
    value=json.loads(handler.rfile.read(length).decode()) if length else {}
    if not isinstance(value,dict): raise ValueError("JSON object required")
    return value


def handle_get(handler: Any, parsed: Any, runtime: Any, control: Any, features: Any) -> bool:
    if parsed.path!="/client-remote-status.json": return False
    if not handler.authenticated(): handler.unauthorized(); return True
    try:
        params=parse_qs(parsed.query); sid=str((params.get("sessionID") or [""])[0]); tasks=runtime.STORE.list_tasks(session_id=sid,limit=100) if sid else runtime.STORE.list_tasks(limit=100); permissions=[]
        if sid:
            directory=features._session_directory(sid)
            for request in features._permission_requests(directory):
                if str(request.get("sessionID") or "")!=sid: continue
                pid=str(request.get("requestID") or request.get("id") or "")
                if not pid: continue
                decision=control.decision_for(request,directory); permissions.append({"permissionID":pid,"sessionID":sid,"risk":decision.get("risk"),"preview":decision.get("preview"),"actions":["once","reject"]})
        handler.json_response({"ok":True,"tasks":[runtime._public(task) for task in tasks],"permissions":permissions,"actions":{"endpoint":"/client-remote-action.json","task":["cancel","pause","resume"],"permission":["once","reject"]}})
    except Exception as exc: handler._feature_error(exc)
    return True


def handle_post(handler: Any, parsed: Any, runtime: Any, control: Any, features: Any) -> bool:
    if parsed.path not in {"/internal/runtime/tool-cache","/client-remote-action.json"}: return False
    if parsed.path=="/internal/runtime/tool-cache":
        if not _internal_auth(handler): handler.json_response({"ok":False,"error":"forbidden"},status=403); return True
    elif not handler.authenticated(): handler.unauthorized(); return True
    try:
        payload=_json_body(handler)
        if parsed.path=="/internal/runtime/tool-cache":
            op=str(payload.get("op") or "get"); tool=str(payload.get("tool") or ""); inp=payload.get("input"); cwd=str(payload.get("cwd") or "")
            if not _cacheable(tool,inp) or not cwd: result={"ok":True,"cacheable":False,"hit":False}
            else:
                key=_tool_cache_key(tool,inp,cwd); namespace="tool-input-v3"
                if op=="get":
                    cached=runtime.STORE.cache_get(namespace,key); result={"ok":True,"cacheable":True,"hit":cached is not None,"result":cached}
                elif op=="put":
                    value=payload.get("result"); encoded=json.dumps(value,ensure_ascii=False,default=str)
                    if len(encoded.encode())<=512000: runtime.STORE.cache_set(namespace,key,value,ttl_seconds=float(os.environ.get("OPENCODE_TOOL_CACHE_TTL","30")))
                    result={"ok":True,"cacheable":True,"stored":len(encoded.encode())<=512000}
                else: raise ValueError("invalid cache operation")
        else:
            kind=str(payload.get("kind") or "task"); action=str(payload.get("action") or "")
            if kind=="task":
                if action not in {"cancel","pause","resume"}: raise ValueError("invalid task action")
                result=runtime.task_control(features,{"taskID":str(payload.get("taskID") or ""),"action":action})
            elif kind=="permission":
                if action not in {"once","reject"}: raise ValueError("invalid permission action")
                sid=str(payload.get("sessionID") or ""); pid=str(payload.get("permissionID") or ""); directory=features._session_directory(sid); pending=None
                for request in features._permission_requests(directory):
                    if str(request.get("sessionID") or "")==sid and str(request.get("requestID") or request.get("id") or "")==pid: pending=request; break
                if pending is None: raise KeyError(pid)
                features._permission_reply(pending,action); runtime.STORE.event(kind="remote.permission_reply",session_id=sid,project_dir=directory,data={"permissionID":pid,"reply":action,"at":now_ms()}); result={"ok":True,"permissionID":pid,"reply":action}
            else: raise ValueError("invalid remote action kind")
        handler.json_response(result)
    except Exception as exc: handler._feature_error(exc)
    return True
