#!/usr/bin/env python3
"""Runtime V3 completion layer for custom OpenCode.

Adds provider-pinned role orchestration support, dynamic native compaction,
AST/embedding repository indexes, shared RAG retrieval, tool/MCP policy hooks,
sandbox enforcement, notifications, and replay/state-branch helpers on top of
server_runtime V2.
"""
from __future__ import annotations

import ast
import asyncio
from collections import defaultdict
from dataclasses import dataclass
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import threading
import time
from typing import Any
from urllib import request as urlrequest
from urllib.error import URLError
from urllib.parse import quote

from repo_services import ArtifactStore, git_snapshot, safe_repo_file
from runtime_store import RuntimeStore, now_ms

WRITE_TOOLS={"edit","write","apply_patch","patch","multiedit"}
READ_TOOLS={"read","grep","glob","list","lsp"}
SHELL_TOOLS={"shell","bash"}
DANGEROUS_SHELL=re.compile(r"(?i)(?:^|[;&|])\s*(?:sudo\b|su\b|rm\s+-[^\n]*r|mkfs\b|dd\s+if=|shutdown\b|reboot\b|git\s+push\b|git\s+reset\s+--hard\b)")
SECRET_NAME=re.compile(r"^[A-Z][A-Z0-9_]{2,127}$")
IMPORT_JS=re.compile(r"(?:(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?|(?:import|require)\s*\()\s*['\"]([^'\"]+)['\"]")
SYMBOL_JS=re.compile(r"^\s*(?:export\s+(?:default\s+)?)?(?:(?:async\s+)?function\*?\s+|class\s+|(?:const|let|var)\s+|interface\s+|type\s+|enum\s+)([A-Za-z_$][\w$]*)",re.M)
WORD_RE=re.compile(r"[A-Za-z_][A-Za-z0-9_]{1,63}")
ENGINEERING_HINT=re.compile(r"(?i)\b(pcb|schematic|datasheet|diptrace|voltage|current|mosfet|pmic|usb|uart|esp32|i2c|spi|rf|power|signal integrity|layout|footprint|component)\b")


def _inside(path:Path,root:Path)->bool:
    try:
        path.resolve(strict=False).relative_to(root.resolve(strict=False)); return True
    except (ValueError,OSError,RuntimeError):
        return False


def _run(cwd:Path,argv:list[str],timeout:float=15.)->subprocess.CompletedProcess[str]:
    return subprocess.run(argv,cwd=str(cwd),stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=timeout,check=False)


def _tokenize(text:str)->list[str]:
    return [m.group(0).casefold() for m in WORD_RE.finditer(text)]


def _hash_embedding(text:str,dims:int=96)->list[float]:
    vec=[0.]*dims
    for token in _tokenize(text):
        value=int.from_bytes(hashlib.blake2b(token.encode(),digest_size=8).digest(),"big")
        idx=value%dims; sign=-1. if (value>>8)&1 else 1.; vec[idx]+=sign*(1.+min(3.,len(token)/12.))
    norm=math.sqrt(sum(v*v for v in vec)) or 1.
    return [round(v/norm,6) for v in vec]


def _cosine(a:list[float],b:list[float])->float:
    return sum(x*y for x,y in zip(a,b)) if a and b and len(a)==len(b) else 0.


def _embedding(texts:list[str])->tuple[str,list[list[float]]]:
    mode=os.environ.get("OPENCODE_REPO_EMBEDDINGS","auto").strip().lower()
    if mode not in {"off","hash","hashed"}:
        try:
            from sentence_transformers import SentenceTransformer  # type: ignore
            model_name=os.environ.get("OPENCODE_REPO_EMBED_MODEL","sentence-transformers/all-MiniLM-L6-v2")
            model=SentenceTransformer(model_name)
            rows=model.encode(texts,normalize_embeddings=True,show_progress_bar=False)
            return model_name,[[round(float(v),6) for v in row] for row in rows]
        except Exception:
            pass
    return "hashed-lexical-v1",[_hash_embedding(text) for text in texts]


def _resolve_relative_import(source:str,target:str,files:set[str])->str|None:
    if not target.startswith("."):
        return None
    base=Path(source).parent/target
    for candidate in (base,base.with_suffix(".py"),base.with_suffix(".js"),base.with_suffix(".ts"),base.with_suffix(".tsx"),base/"index.js",base/"index.ts",base/"__init__.py"):
        normalized=str(candidate.as_posix()).lstrip("./")
        if normalized in files:
            return normalized
    return None


class SemanticRepoIndexer:
    VERSION=3
    EXTENSIONS={".py",".js",".mjs",".cjs",".ts",".tsx",".jsx",".go",".rs",".java",".kt",".c",".h",".cpp",".hpp",".cs",".rb",".php",".sh"}
    def __init__(self,store:RuntimeStore): self.store=store
    def _key(self,project_dir:str)->str: return hashlib.sha256(project_dir.encode()).hexdigest()
    def _files(self,root:Path)->list[str]:
        proc=_run(root,["git","ls-files","-z"],15.)
        if proc.returncode==0: return [item for item in proc.stdout.split("\0") if item][:12000]
        out=[]
        for path in root.rglob("*"):
            if not path.is_file(): continue
            rel=path.relative_to(root)
            if any(part.startswith(".") or part in {"node_modules","dist","build","vendor"} for part in rel.parts): continue
            out.append(rel.as_posix())
            if len(out)>=6000: break
        return out
    def _python(self,relative:str,text:str)->tuple[list[dict[str,Any]],list[str]]:
        symbols=[]; imports=[]
        try: tree=ast.parse(text)
        except SyntaxError: return symbols,imports
        parents=[]
        class Visitor(ast.NodeVisitor):
            def visit_ClassDef(self,node):
                q=".".join([*parents,node.name]); symbols.append({"name":node.name,"qualified":q,"kind":"class","path":relative,"line":node.lineno,"endLine":getattr(node,"end_lineno",node.lineno)}); parents.append(node.name); self.generic_visit(node); parents.pop()
            def visit_FunctionDef(self,node):
                q=".".join([*parents,node.name]); symbols.append({"name":node.name,"qualified":q,"kind":"function","path":relative,"line":node.lineno,"endLine":getattr(node,"end_lineno",node.lineno)}); parents.append(node.name); self.generic_visit(node); parents.pop()
            visit_AsyncFunctionDef=visit_FunctionDef
            def visit_Import(self,node): imports.extend(alias.name for alias in node.names)
            def visit_ImportFrom(self,node):
                prefix="."*int(node.level or 0)
                if node.module: imports.append(prefix+node.module)
        Visitor().visit(tree); return symbols,imports
    def _generic(self,relative:str,text:str)->tuple[list[dict[str,Any]],list[str]]:
        symbols=[]
        for m in SYMBOL_JS.finditer(text):
            name=m.group(1); prefix=m.group(0).lower()
            kind="class" if "class" in prefix else ("function" if "function" in prefix else ("interface" if "interface" in prefix else ("type" if "type" in prefix else ("enum" if "enum" in prefix else ("variable" if any(k in prefix for k in ("const","let","var")) else "symbol")))))
            symbols.append({"name":name,"qualified":name,"kind":kind,"path":relative,"line":text.count("\n",0,m.start())+1,"endLine":text.count("\n",0,m.end())+1})
        return symbols,[m.group(1) for m in IMPORT_JS.finditer(text)]
    def _git_graph(self,root:Path)->list[dict[str,Any]]:
        proc=_run(root,["git","log","--all","--max-count=250","--pretty=format:%H%x09%P%x09%ct%x09%s"],12.)
        if proc.returncode!=0: return []
        rows=[]
        for line in proc.stdout.splitlines():
            parts=line.split("\t",3)
            if len(parts)>=4: rows.append({"sha":parts[0],"parents":[p for p in parts[1].split() if p],"time":int(parts[2] or 0),"subject":parts[3][:300]})
        return rows
    def refresh(self,project_dir:str,*,force:bool=False)->dict[str,Any]:
        root=Path(project_dir).resolve(strict=True); snap=git_snapshot(str(root)); fingerprint=f"v{self.VERSION}:{snap.get('head')}:{snap.get('statusHash')}"; key=self._key(str(root)); cached=self.store.cache_get("repo-index-v3",key)
        if not force and isinstance(cached,dict) and cached.get("fingerprint")==fingerprint: result=dict(cached); result["cacheHit"]=True; return result
        files=[relative for relative in self._files(root) if safe_repo_file(root,relative) is not None]; file_set=set(files); symbols=[]; dependency_edges=[]; manifests=[]; file_docs=[]; indexed_bytes=0
        for relative in files:
            path=safe_repo_file(root,relative)
            if path is None: continue
            try: size=path.stat().st_size
            except OSError: continue
            if size>2_000_000: continue
            if path.name in {"package.json","pyproject.toml","requirements.txt","Cargo.toml","go.mod","pom.xml","build.gradle","build.gradle.kts","AGENTS.md"}:
                try:
                    raw=path.read_text(encoding="utf-8",errors="ignore")[:180000]; manifests.append({"path":relative,"sha":hashlib.sha256(raw.encode()).hexdigest()[:16],"preview":raw[:2500]})
                except OSError: pass
            if path.suffix.lower() not in self.EXTENSIONS: continue
            try: text=path.read_text(encoding="utf-8",errors="ignore")
            except OSError: continue
            indexed_bytes+=len(text.encode("utf-8",errors="ignore"))
            if indexed_bytes>100_000_000: break
            parsed,imports=self._python(relative,text) if path.suffix.lower()==".py" else self._generic(relative,text); symbols.extend(parsed); file_docs.append((relative," ".join([relative,*[s["qualified"] for s in parsed[:100]],*imports[:80]])))
            for imported in imports:
                resolved=_resolve_relative_import(relative,imported,file_set); dependency_edges.append({"from":relative,"to":resolved or imported,"external":"0" if resolved else "1"})
            if len(symbols)>=40000: break
        embed_inputs=[doc for _,doc in file_docs[:4000]]+[f"{s['qualified']} {s['path']} {s['kind']}" for s in symbols[:8000]]; backend,vectors=_embedding(embed_inputs) if embed_inputs else ("none",[])
        file_vectors=[{"path":path,"text":doc[:1500],"vector":vectors[idx]} for idx,(path,doc) in enumerate(file_docs[:4000])]
        offset=len(file_docs[:4000]); symbol_vectors=[]
        for idx,symbol in enumerate(symbols[:8000]):
            vi=offset+idx
            if vi>=len(vectors): break
            symbol_vectors.append({"name":symbol["name"],"qualified":symbol["qualified"],"path":symbol["path"],"line":symbol["line"],"vector":vectors[vi]})
        index={"version":self.VERSION,"projectDir":str(root),"fingerprint":fingerprint,"snapshot":snap,"files":len(files),"symbols":symbols[:40000],"dependencies":manifests[:100],"dependencyGraph":dependency_edges[:50000],"gitGraph":self._git_graph(root),"embeddingBackend":backend,"fileEmbeddings":file_vectors,"symbolEmbeddings":symbol_vectors,"indexedBytes":indexed_bytes,"generatedAt":now_ms(),"cacheHit":False}
        self.store.cache_set("repo-index-v3",key,index,ttl_seconds=21600); self.store.event(kind="repo.indexed",project_dir=str(root),data={"files":len(files),"symbols":len(symbols),"embeddingBackend":backend}); return index
    def search(self,project_dir:str,query:str,limit:int=40)->dict[str,Any]:
        index=self.refresh(project_dir); q=query.strip(); qvec=_embedding([q])[1][0] if q else []; terms=_tokenize(q); hits=[]
        for row in index.get("symbolEmbeddings") or []:
            hay=f"{row.get('qualified','')} {row.get('path','')}".casefold(); score=_cosine(qvec,row.get("vector") or [])+sum(.25 for term in terms if term in hay)
            if score>.05: hits.append((score,{"type":"symbol",**{k:row.get(k) for k in ("name","qualified","path","line")}}))
        for row in index.get("fileEmbeddings") or []:
            hay=f"{row.get('path','')} {row.get('text','')}".casefold(); score=_cosine(qvec,row.get("vector") or [])+sum(.15 for term in terms if term in hay)
            if score>.08: hits.append((score,{"type":"file","path":row.get("path")}))
        hits.sort(key=lambda item:(-item[0],str(item[1].get("path")),str(item[1].get("qualified",""))))
        return {"query":q,"hits":[{**item,"score":round(score,4)} for score,item in hits[:max(1,min(200,int(limit)))]],"index":{k:index.get(k) for k in ("files","generatedAt","fingerprint","embeddingBackend")}}
    def semantic_diff(self,project_dir:str,baseline:dict[str,Any]|None=None)->dict[str,Any]:
        root=Path(project_dir).resolve(strict=False); baseline=baseline or {}; current=git_snapshot(str(root)); base_head=baseline.get("head"); args=["git","diff","--unified=0"]
        if base_head and current.get("head") and base_head!=current.get("head"): args.append(str(base_head))
        proc=_run(root,args,12.); changed_lines=defaultdict(list); current_file=None
        if proc.returncode==0:
            for line in proc.stdout.splitlines():
                if line.startswith("+++ b/"): current_file=line[6:]
                elif current_file and line.startswith("@@"):
                    m=re.search(r"\+(\d+)(?:,(\d+))?",line)
                    if m:
                        start=int(m.group(1)); length=max(1,int(m.group(2) or 1)); changed_lines[current_file].append((start,start+length-1))
        index=self.refresh(str(root)); impacted=[]
        for symbol in index.get("symbols") or []:
            ranges=changed_lines.get(str(symbol.get("path"))) or []; s=int(symbol.get("line") or 0); e=int(symbol.get("endLine") or s)
            if any(not(end<s or start>e) for start,end in ranges): impacted.append({k:symbol.get(k) for k in ("path","name","qualified","kind","line","endLine")})
        changed_files=sorted(changed_lines); return {"baseline":baseline,"current":current,"changedFiles":changed_files,"changedSymbols":impacted[:500],"changedLineRanges":{k:v[:100] for k,v in changed_lines.items()},"summary":f"{len(changed_files)} files / {len(impacted)} impacted symbols"}


class ScopedSecretBroker:
    def __init__(self): self.prefixes=tuple(x for x in os.environ.get("OPENCODE_SECRET_PREFIXES","TOKEN_PLAN_;OPENAI_;GITHUB_;MCP_;QDRANT_;HF_").split(";") if x); self.rules=self._rules(); self._leases={}; self._lock=threading.Lock()
    def _rules(self):
        rules=defaultdict(set)
        for entry in os.environ.get("OPENCODE_SECRET_SCOPES","").split(";"):
            if "=" not in entry: continue
            scope,names=entry.split("=",1)
            for name in names.split(","):
                if name.strip(): rules[scope.strip()].add(name.strip())
        return rules
    def allowed(self,name:str,scope:str)->bool:
        if not SECRET_NAME.match(name) or not any(name.startswith(prefix) for prefix in self.prefixes): return False
        if not self.rules: return True
        return name in (self.rules.get(scope) or set()) or name in (self.rules.get("*") or set())
    def issue(self,name:str,*,scope:str,ttl:int=60)->str:
        if not self.allowed(name,scope): raise PermissionError("secret outside scope")
        value=os.environ.get(name)
        if not value: raise KeyError(name)
        token="sec_"+hashlib.sha256(f"{name}:{scope}:{time.time_ns()}".encode()).hexdigest()[:32]
        with self._lock: self._leases[token]=(value,time.monotonic()+max(1,min(ttl,600)),scope)
        return token
    def redeem(self,token:str,*,scope:str)->str:
        with self._lock: row=self._leases.pop(token,None)
        if not row or row[1]<time.monotonic() or row[2]!=scope: raise PermissionError("invalid/expired secret lease")
        return row[0]
    def snapshot(self)->dict[str,Any]:
        names=sorted(name for name in os.environ if any(name.startswith(prefix) for prefix in self.prefixes) and os.environ.get(name)); return {"availableRefs":names,"plaintextExposed":False,"scoped":True,"configuredScopes":sorted(self.rules)}


class SandboxManager:
    PROFILES={"safe","repo-write","full-machine","docker","wsl"}
    def __init__(self): self.docker_image=os.environ.get("OPENCODE_SANDBOX_DOCKER_IMAGE","python:3.12-slim")
    def normalize(self,profile:str|None)->str: return str(profile) if str(profile) in self.PROFILES else "repo-write"
    def path_allowed(self,path:str,root:str,profile:str,*,write:bool)->bool:
        profile=self.normalize(profile)
        if profile=="full-machine": return os.environ.get("OPENCODE_ALLOW_FULL_MACHINE","0").lower() in {"1","true","yes"}
        target=Path(path).expanduser(); target=target if target.is_absolute() else Path(root)/target
        return _inside(target,Path(root)) and (profile!="safe" or not write)
    def wrap_shell(self,command:str,cwd:str,profile:str)->dict[str,str]:
        profile=self.normalize(profile); root=str(Path(cwd).resolve(strict=False))
        if profile=="safe" and DANGEROUS_SHELL.search(command): raise PermissionError("dangerous shell command denied in safe sandbox")
        if profile=="full-machine":
            if os.environ.get("OPENCODE_ALLOW_FULL_MACHINE","0").lower() not in {"1","true","yes"}: raise PermissionError("full-machine sandbox requires explicit opt-in")
            return {"command":command,"cwd":root,"shell":"/bin/sh"}
        if profile in {"safe","repo-write"} and shutil.which("bwrap"):
            bind="--ro-bind" if profile=="safe" else "--bind"; network="--unshare-net " if profile=="safe" else ""; wrapped=f"bwrap --die-with-parent --new-session {network}--proc /proc --dev /dev --tmpfs /tmp --ro-bind / / {bind} {shlex.quote(root)} {shlex.quote(root)} --chdir {shlex.quote(root)} /bin/sh -lc {shlex.quote(command)}"; return {"command":wrapped,"cwd":root,"shell":"/bin/sh"}
        if profile=="docker":
            if not shutil.which("docker"): raise RuntimeError("docker sandbox requested but docker is unavailable")
            mount=f"{root}:/workspace"+(":ro" if os.environ.get("OPENCODE_DOCKER_READONLY","0")=="1" else ""); network="--network none " if os.environ.get("OPENCODE_DOCKER_NETWORK","0")!="1" else ""; wrapped=f"docker run --rm {network}-v {shlex.quote(mount)} -w /workspace {shlex.quote(self.docker_image)} /bin/sh -lc {shlex.quote(command)}"; return {"command":wrapped,"cwd":root,"shell":"/bin/sh"}
        if profile=="wsl":
            if os.environ.get("WSL_DISTRO_NAME") or os.path.exists("/proc/sys/fs/binfmt_misc/WSLInterop"):
                return {"command":command,"cwd":root,"shell":"/bin/sh"}
            wsl=shutil.which("wsl.exe") or shutil.which("wsl")
            if not wsl: raise RuntimeError("WSL sandbox requested but wsl is unavailable")
            return {"command":f"{shlex.quote(wsl)} --cd {shlex.quote(root)} -- /bin/sh -lc {shlex.quote(command)}","cwd":root,"shell":"/bin/sh"}
        return {"command":command,"cwd":root,"shell":"/bin/sh"}


class SharedRAGService:
    def __init__(self,store:RuntimeStore): self.store=store
    async def _call_async(self,executable:str,cwd:str,tool:str,args:dict[str,Any])->Any:
        from mcp import ClientSession,StdioServerParameters  # type: ignore
        from mcp.client.stdio import stdio_client  # type: ignore
        params=StdioServerParameters(command=executable,args=[],cwd=cwd)
        async with stdio_client(params) as (read,write):
            async with ClientSession(read,write) as session:
                await session.initialize(); result=await session.call_tool(tool,args); structured=getattr(result,"structuredContent",None)
                if structured is not None: return structured
                joined="\n".join(getattr(item,"text","") for item in (getattr(result,"content",None) or []) if getattr(item,"text",None)).strip()
                try: return json.loads(joined)
                except json.JSONDecodeError: return joined
    def call(self,features:Any,tool:str,args:dict[str,Any],*,ttl:int=90)->Any:
        try: rr=features._rag_runtime() or {}
        except Exception: rr={}
        executable,root=rr.get("executable"),rr.get("root")
        if not rr.get("available") or not executable or not root: return None
        key=hashlib.sha256(json.dumps([tool,args],sort_keys=True,ensure_ascii=False).encode()).hexdigest(); cached=self.store.cache_get("shared-rag",key)
        if cached is not None: return cached
        try: value=asyncio.run(self._call_async(str(executable),str(root),tool,args))
        except Exception as exc: self.store.event(kind="rag.shared_error",data={"tool":tool,"error":f"{type(exc).__name__}: {exc}"[:500]}); return None
        self.store.cache_set("shared-rag",key,value,ttl_seconds=ttl); return value
    def search(self,features:Any,query:str,top_k:int=3)->Any: return self.call(features,"knowledge_search",{"query":query[:4000],"top_k":max(1,min(8,int(top_k)))})


class DynamicContextManager:
    def __init__(self,store:RuntimeStore,indexer:SemanticRepoIndexer,rag:SharedRAGService): self.store=store; self.indexer=indexer; self.rag=rag
    def _active_tokens(self,features:Any,sid:str)->tuple[int,list[Any]]:
        try: value=features._data(features._backend_request_json("GET",f"/api/session/{quote(sid,safe='')}/context",timeout=10.))
        except Exception: return 0,[]
        rows=value if isinstance(value,list) else []; return max(1,len(json.dumps(rows,ensure_ascii=False,default=str))//4),rows
    def _budget(self,runtime:Any,task:dict[str,Any]|None)->tuple[int,int,int,str|None,int]:
        profiles=runtime.REGISTRY.profiles(); profile=profiles.get(str(task.get("profile")) if task else "direct",profiles["direct"])
        policy=profile.get("contextPolicy") if isinstance(profile.get("contextPolicy"),dict) else {}
        try: ratio=float(policy.get("targetRatio") or .72)
        except (TypeError,ValueError): ratio=.72
        ratio=max(.50,min(.90,ratio))
        route=task.get("route") if isinstance(task,dict) and isinstance(task.get("route"),dict) else {}
        selected=str(route.get("selectedModel") or "") if route else ""
        candidate=selected or str(profile.get("cloudModel") or profile.get("builderModel") or profile.get("plannerModel") or profile.get("readerModel") or profile.get("reviewerModel") or "")
        model=runtime.REGISTRY.get(candidate) if candidate else None
        limit=int((model or {}).get("context") or 128000)
        reserve=max(16000,min(131072,int(limit*.12)))
        hard=max(16000,limit-reserve)
        budget=max(16000,min(hard,int(limit*ratio)))
        default_growth=max(8000,min(40000,int(limit*.03)))
        min_growth=max(1000,int(policy.get("minGrowthBeforeRecompact") or default_growth))
        return budget,reserve,limit,candidate or None,min_growth
    def maybe_compact(self,features:Any,runtime:Any,sid:str,task:dict[str,Any]|None)->dict[str,Any]:
        active,rows=self._active_tokens(features,sid); budget,reserve,limit,model_ref,min_growth=self._budget(runtime,task); triggered=False
        completed=[r for r in rows if isinstance(r,dict) and r.get("type")=="compaction" and r.get("status")=="completed"]
        pending=[r for r in rows if isinstance(r,dict) and r.get("type")=="compaction" and str(r.get("status") or "").lower() in {"pending","running","in_progress","requested"}]
        key=sid; state=self.store.cache_get("context-compaction-state",key) or {}; completed_count=len(completed); now=now_ms()
        if int(state.get("completedCount") or 0)!=completed_count:
            state={"completedCount":completed_count,"baselineTokens":active,"lastRequestTokens":None,"lastRequestAt":0}
        baseline=int(state.get("baselineTokens") or 0); last_request_tokens=state.get("lastRequestTokens"); last_request_at=int(state.get("lastRequestAt") or 0)
        growth=max(0,active-baseline)
        enough_growth=(last_request_tokens is None and growth>=min_growth) or (isinstance(last_request_tokens,(int,float)) and active-int(last_request_tokens)>=min_growth)
        first_over_budget=last_request_tokens is None and baseline==0
        interval_ok=not last_request_at or now-last_request_at>=180000
        if active>budget and not pending and interval_ok and (first_over_budget or enough_growth):
            for endpoint in (f"/api/session/{quote(sid,safe='')}/compact",f"/api/session/{quote(sid,safe='')}/summarize"):
                try: features._backend_request_json("POST",endpoint,{},timeout=12.); triggered=True; break
                except Exception: continue
            state.update({"completedCount":completed_count,"baselineTokens":baseline or active,"lastRequestTokens":active,"lastRequestAt":now})
            self.store.cache_set("context-compaction-state",key,state,ttl_seconds=21600)
            self.store.event(kind="context.compaction_requested",task_id=task.get("id") if task else None,session_id=sid,project_dir=task.get("project_dir") if task else None,data={"activeTokens":active,"budgetTokens":budget,"reserveTokens":reserve,"contextLimit":limit,"model":model_ref,"minGrowthTokens":min_growth,"growthTokens":growth,"triggered":triggered,"reason":"model-aware-budget"})
        elif state:
            state["completedCount"]=completed_count; self.store.cache_set("context-compaction-state",key,state,ttl_seconds=21600)
        return {"activeTokens":active,"budgetTokens":budget,"reserveTokens":reserve,"contextLimit":limit,"model":model_ref,"minGrowthTokens":min_growth,"growthTokens":growth,"compactionRequested":triggered,"compactionPending":bool(pending),"hasCompaction":bool(completed)}
    def envelope(self,features:Any,runtime:Any,sid:str,project_instructions:str,rag_mode:str="auto")->dict[str,Any]:
        tasks=self.store.list_tasks(session_id=sid,states=["submitted","running","waiting_permission","verifying","recovering","queued"],limit=10); task=tasks[0] if tasks else None; compact=self.maybe_compact(features,runtime,sid,task); directory=features._session_directory(sid); budget_chars=max(8000,min(100000,compact["budgetTokens"]*2)); base=runtime.CONTEXT.envelope(project_dir=directory,task=task,project_instructions=project_instructions,budget_chars=min(48000,budget_chars)); parts=[str(base.get("text") or "")]; query=str(task.get("text") or "") if task else ""
        if query:
            try:
                repo=self.indexer.search(directory,query,limit=20); hits=repo.get("hits") or []
                if hits: parts.append("Semantic repository matches:\n"+"\n".join(f"- {h.get('type')}: {h.get('qualified') or h.get('path')} (score {h.get('score')})" for h in hits[:20]))
                diff=self.indexer.semantic_diff(directory,task.get("baseline") if task else None)
                if diff.get("changedSymbols"): parts.append("Changed symbols since task baseline:\n"+"\n".join(f"- {s.get('qualified')} · {s.get('path')}:{s.get('line')}" for s in diff["changedSymbols"][:80]))
            except Exception as exc: self.store.event(kind="context.repo_error",session_id=sid,project_dir=directory,data={"error":str(exc)[:500]})
            if rag_mode=="on" or (rag_mode=="auto" and bool(ENGINEERING_HINT.search(query))):
                result=self.rag.search(features,query,3)
                if result is not None: parts.append("Shared engineering knowledge retrieval (server-managed RAG):\n"+json.dumps(result,ensure_ascii=False,default=str)[:14000])
        output=[]; seen=set(); used=0
        for part in parts:
            compact_part="\n".join(line.rstrip() for line in part.strip().splitlines()).strip()
            if not compact_part: continue
            digest=hashlib.sha256(compact_part.encode()).hexdigest()
            if digest in seen: continue
            seen.add(digest); remaining=budget_chars-used
            if remaining<=800: break
            if len(compact_part)>remaining: compact_part=compact_part[:remaining-80]+"\n[…server context clipped…]"
            output.append(compact_part); used+=len(compact_part)+2
        return {"text":"\n\n".join(output),"usedChars":used,"budgetChars":budget_chars,"compaction":compact,"semanticDiff":base.get("semanticDiff")}


class ToolGateway:
    def __init__(self,store:RuntimeStore,artifacts:ArtifactStore,sandbox:SandboxManager,secrets:ScopedSecretBroker): self.store=store; self.artifacts=artifacts; self.sandbox=sandbox; self.secrets=secrets
    def _task(self,session_id:str|None,cwd:str|None)->dict[str,Any]|None:
        if session_id:
            rows=self.store.list_tasks(session_id=session_id,states=["submitted","running","waiting_permission","verifying","recovering","queued"],limit=20)
            if rows: return rows[0]
        if cwd:
            rows=self.store.list_tasks(project_dir=str(Path(cwd).resolve(strict=False)),states=["submitted","running","waiting_permission","verifying","recovering","queued"],limit=20)
            if rows: return rows[0]
        return None
    def _paths(self,tool:str,payload:Any)->list[str]:
        out=[]
        def walk(value,key=""):
            if isinstance(value,dict):
                for k,v in value.items(): walk(v,str(k))
            elif isinstance(value,list):
                for item in value: walk(item,key)
            elif isinstance(value,str) and key.casefold() in {"path","filepath","file","directory","cwd","target"}: out.append(value)
        walk(payload)
        if tool=="apply_patch" and isinstance(payload,dict):
            patch=str(payload.get("patchText") or payload.get("patch") or "")
            for line in patch.splitlines():
                m=re.match(r"\*\*\* (?:Add|Update|Delete) File:\s*(.+)",line)
                if m: out.append(m.group(1).strip())
        return out
    def _rate(self,task_id:str,tool:str)->None:
        if "_" not in tool and tool!="execute": return
        namespace=tool.split("_",1)[0] if tool!="execute" else "codemode"; limit=int(os.environ.get("OPENCODE_MCP_RATE_LIMIT","120")); key=f"{task_id}:{namespace}"; row=self.store.cache_get("mcp-rate",key) or {"count":0}; count=int(row.get("count") or 0)+1
        if count>max(5,limit): raise RuntimeError(f"MCP rate limit exceeded for {namespace}")
        self.store.cache_set("mcp-rate",key,{"count":count},ttl_seconds=60)
    def before(self,payload:dict[str,Any])->dict[str,Any]:
        tool=str(payload.get("tool") or ""); inp=payload.get("input") if isinstance(payload.get("input"),(dict,list)) else {}; sid=str(payload.get("sessionID") or "") or None; cwd=str(payload.get("cwd") or "") or None; task=self._task(sid,cwd)
        if not task: return {"allow":True,"reason":"no managed task"}
        task_id=str(task["id"]); metadata=task.get("metadata") if isinstance(task.get("metadata"),dict) else {}; profile=self.sandbox.normalize(str(metadata.get("sandbox") or "repo-write")); root=str(task.get("project_dir") or cwd or ""); self._rate(task_id,tool); signature=hashlib.sha256(json.dumps([tool,inp],sort_keys=True,ensure_ascii=False,default=str).encode()).hexdigest(); loop=self.store.cache_get("tool-loop-v3",task_id) or {"last":"","count":0}; count=int(loop.get("count") or 0)+1 if loop.get("last")==signature else 1; self.store.cache_set("tool-loop-v3",task_id,{"last":signature,"count":count},ttl_seconds=300)
        if count>=int(os.environ.get("OPENCODE_LOOP_LIMIT","3")) and tool not in READ_TOOLS: self.store.event(kind="tool.loop_blocked",task_id=task_id,session_id=task.get("session_id"),project_dir=root,data={"tool":tool,"count":count}); raise RuntimeError("loop detector: repeated tool action blocked; change strategy")
        write=tool in WRITE_TOOLS
        if profile=="safe" and (write or tool in SHELL_TOOLS): raise PermissionError(f"{tool} denied by safe sandbox")
        paths=self._paths(tool,inp)
        for path in paths:
            if not self.sandbox.path_allowed(path,root,profile,write=write): raise PermissionError(f"path outside {profile} sandbox: {path}")
        if write and paths:
            conflicts=self.store.ownership_replace(root,task_id,paths)
            if conflicts: self.store.event(kind="patch.conflict",task_id=task_id,session_id=task.get("session_id"),project_dir=root,data={"conflicts":conflicts}); raise RuntimeError("patch ownership conflict: "+", ".join(f"{c['path']} owned by {c['taskID']}" for c in conflicts[:8]))
        self.store.event(kind="tool.before",task_id=task_id,session_id=task.get("session_id"),project_dir=root,data={"tool":tool,"signature":signature[:16],"sandbox":profile}); return {"allow":True,"taskID":task_id,"sandbox":profile,"root":root}
    def after(self,payload:dict[str,Any])->dict[str,Any]:
        tool=str(payload.get("tool") or ""); sid=str(payload.get("sessionID") or "") or None; cwd=str(payload.get("cwd") or "") or None; task=self._task(sid,cwd); result=payload.get("result"); serialized=json.dumps(result,ensure_ascii=False,default=str) if not isinstance(result,str) else result
        if not task: return {"replace":False}
        task_id=str(task["id"]); root=str(task.get("project_dir") or cwd or ""); digest=hashlib.sha256(serialized.encode()).hexdigest(); cache_key=f"{tool}:{digest}"; duplicate=self.store.cache_get("tool-result-dedupe",cache_key)
        if duplicate: return {"replace":True,"result":{"summary":f"Duplicate {tool} result; reused server artifact {duplicate.get('artifactID')}","artifactID":duplicate.get("artifactID"),"deduplicated":True}}
        threshold=int(os.environ.get("OPENCODE_TOOL_ARTIFACT_THRESHOLD","24000"))
        if len(serialized.encode())>threshold:
            artifact=self.artifacts.put(task_id=task_id,project_dir=root,kind="tool-output",title=f"{tool} output",content=serialized,summary=f"Large {tool} result ({len(serialized)} chars)"); self.store.cache_set("tool-result-dedupe",cache_key,{"artifactID":artifact["id"]},ttl_seconds=1800); preview=serialized[:4000]+("\n[…stored as artifact…]" if len(serialized)>4000 else ""); return {"replace":True,"result":{"summary":artifact["summary"],"artifactID":artifact["id"],"preview":preview,"size":artifact["size"]}}
        self.store.cache_set("tool-result-dedupe",cache_key,{"artifactID":None},ttl_seconds=300); return {"replace":False}
    def shell(self,payload:dict[str,Any])->dict[str,Any]:
        cwd=str(payload.get("cwd") or ""); command=str(payload.get("command") or ""); task=self._task(str(payload.get("sessionID") or "") or None,cwd)
        if not task: return {"command":command,"cwd":cwd,"shell":str(payload.get("shell") or "/bin/sh"),"env":{}}
        metadata=task.get("metadata") if isinstance(task.get("metadata"),dict) else {}; profile=self.sandbox.normalize(str(metadata.get("sandbox") or "repo-write")); wrapped=self.sandbox.wrap_shell(command,cwd or str(task.get("project_dir")),profile); scope=f"task:{task['id']}:shell"; allowed_names=[x.strip() for x in os.environ.get("OPENCODE_SHELL_SECRET_REFS","").split(",") if x.strip()]; env={}
        for name in allowed_names:
            if self.secrets.allowed(name,scope) or self.secrets.allowed(name,"shell"):
                value=os.environ.get(name)
                if value: env[name]=value
        return {**wrapped,"env":env,"stripSecretPrefixes":list(self.secrets.prefixes),"sandbox":profile,"taskID":task["id"]}


class RemoteNotifier:
    def __init__(self,store:RuntimeStore): self.store=store
    def send(self,event:dict[str,Any])->None:
        url=os.environ.get("OPENCODE_NOTIFICATION_WEBHOOK","").strip()
        if not url: return
        allow=os.environ.get("OPENCODE_NOTIFICATION_ALLOW_REMOTE","0").lower() in {"1","true","yes"}
        if not allow and not re.match(r"^https?://(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:/|$)",url): return
        try:
            req=urlrequest.Request(url,data=json.dumps(event,ensure_ascii=False).encode(),headers={"Content-Type":"application/json"},method="POST")
            with urlrequest.urlopen(req,timeout=2.) as response: response.read(1)
        except (OSError,URLError): pass


class ReplayService:
    def __init__(self,store:RuntimeStore,artifacts:ArtifactStore): self.store=store; self.artifacts=artifacts
    def capture(self,features:Any,task:dict[str,Any])->dict[str,Any]|None:
        sid=str(task.get("session_id") or "")
        try: messages=features._data(features._backend_request_json("GET",f"/api/session/{quote(sid,safe='')}/message?limit=200",timeout=15.))
        except Exception: return None
        artifact=self.artifacts.put(task_id=task["id"],project_dir=task.get("project_dir"),kind="run-replay",title="Recorded OpenCode run",content=json.dumps(messages if isinstance(messages,list) else [],ensure_ascii=False,default=str),summary="Recorded messages/tool results for zero-token replay",mime="application/json"); self.store.event(kind="replay.captured",task_id=task["id"],session_id=sid,project_dir=task.get("project_dir"),data={"artifactID":artifact["id"]}); return artifact
    def replay(self,task_id:str)->dict[str,Any]:
        artifacts=self.artifacts.list(task_id,limit=200); replay=next((a for a in artifacts if a.get("kind")=="run-replay"),None); return {"taskID":task_id,"events":self.store.events(task_id=task_id,limit=2000),"checkpoints":self.store.checkpoints(task_id,limit=500),"usage":self.store.usage_summary(task_id),"recording":self.artifacts.get(replay["id"],limit=500000) if replay else None,"modelCalls":0}


class BranchStateService:
    def __init__(self,store:RuntimeStore): self.store=store
    def branch(self,features:Any,session_id:str,title:str="Runtime branch")->dict[str,Any]:
        value=features._data(features._backend_request_json("POST",f"/api/session/{quote(session_id,safe='')}/fork",{},timeout=20.))
        if not isinstance(value,dict) or not value.get("id"): raise RuntimeError("session fork failed")
        source=self.store.list_tasks(session_id=session_id,limit=100); self.store.event(kind="session.branch_created",session_id=session_id,data={"childSessionID":str(value["id"]),"title":title,"sourceTasks":[t["id"] for t in source[:30]]}); return {"sourceSessionID":session_id,"session":value,"sourceTasks":[t["id"] for t in source]}
    def merge(self,features:Any,source_session:str,target_session:str,*,include_state:bool=True)->dict[str,Any]:
        source=self.store.list_tasks(session_id=source_session,limit=200); target=self.store.list_tasks(session_id=target_session,limit=200); copied=[]
        if include_state and source:
            source_project=str(source[0].get("project_dir") or ""); target_project=str(target[0].get("project_dir") or source_project)
            for item in self.store.memory_list(source_project,limit=200): self.store.memory_set(target_project,item["key"],item["value"],item["category"])
            for item in self.store.decision_list(source_project,limit=200): copied.append(self.store.decision_add(target_project,item["title"],item["decision"],item["rationale"])["id"])
        self.store.event(kind="session.branch_merged",session_id=target_session,data={"sourceSessionID":source_session,"copiedDecisions":copied,"sourceTaskIDs":[t["id"] for t in source]}); return {"ok":True,"sourceSessionID":source_session,"targetSessionID":target_session,"copiedDecisions":copied,"sourceTasks":len(source),"targetTasks":len(target)}


@dataclass
class RuntimeV3:
    store:RuntimeStore; indexer:SemanticRepoIndexer; secrets:ScopedSecretBroker; sandbox:SandboxManager; rag:SharedRAGService; context:DynamicContextManager; gateway:ToolGateway; notifier:RemoteNotifier; replay:ReplayService; branches:BranchStateService
_INSTANCE:RuntimeV3|None=None


def install(runtime:Any,features:Any)->RuntimeV3:
    global _INSTANCE
    if _INSTANCE is not None: return _INSTANCE
    indexer=SemanticRepoIndexer(runtime.STORE); secrets=ScopedSecretBroker(); sandbox=SandboxManager(); rag=SharedRAGService(runtime.STORE); context=DynamicContextManager(runtime.STORE,indexer,rag); gateway=ToolGateway(runtime.STORE,runtime.ARTIFACTS,sandbox,secrets)
    _INSTANCE=RuntimeV3(runtime.STORE,indexer,secrets,sandbox,rag,context,gateway,RemoteNotifier(runtime.STORE),ReplayService(runtime.STORE,runtime.ARTIFACTS),BranchStateService(runtime.STORE))
    runtime.STORE.event(kind="runtime.v3_installed",data={"features":["native-compaction","ast-index","embeddings","mcp-code-mode","sandbox-enforcement","shared-rag","replay","provider-pinned-role-router"]})
    return _INSTANCE


def instance(runtime:Any,features:Any)->RuntimeV3: return _INSTANCE or install(runtime,features)
def context_envelope(features:Any,runtime:Any,session_id:str,instructions:str,rag_mode:str="auto")->dict[str,Any]: return instance(runtime,features).context.envelope(features,runtime,session_id,instructions,rag_mode)


def _json_body(handler:Any,limit:int=2_000_000)->dict[str,Any]:
    if hasattr(handler,"_feature_body"): return handler._feature_body(limit)
    length=int(handler.headers.get("Content-Length","0"))
    if length<0 or length>limit: raise ValueError("request too large")
    data=json.loads(handler.rfile.read(length).decode()) if length else {}
    if not isinstance(data,dict): raise ValueError("JSON object required")
    return data


def _internal_auth(handler:Any)->bool:
    expected=os.environ.get("OPENCODE_RUNTIME_PLUGIN_TOKEN") or os.environ.get("OPENCODE_SERVER_PASSWORD") or ""; supplied=handler.headers.get("X-OpenCode-Runtime","")
    return bool(expected and supplied and hashlib.sha256(supplied.encode()).digest()==hashlib.sha256(expected.encode()).digest())


def runtime_snapshot(runtime:Any,features:Any,directory:str|None=None)->dict[str,Any]:
    v3=instance(runtime,features); base=runtime.runtime_snapshot(features,directory); base["version"]=3
    base["services"].update({"nativeDynamicCompaction":True,"astIndex":True,"repoEmbeddings":True,"gitGraph":True,"dependencyGraph":True,"semanticSymbolDiff":True,"mcpCodeMode":True,"mcpPolicyGateway":True,"scopedSecretBroker":True,"sandboxEnforcement":True,"sharedNativeRAG":True,"sessionStateBranching":True,"zeroTokenReplay":True,"providerLockedRoleRouter":True,"remoteNotificationAPI":True})
    base["resources"]=runtime.resource_snapshot(); base["secretBroker"]=v3.secrets.snapshot(); return base


def handle_get(handler:Any,parsed:Any,runtime:Any,features:Any)->bool:
    if parsed.path not in {"/client-runtime-v3.json","/client-repo-index-v3.json","/client-replay.json","/client-runtime-events.json"}: return False
    if not handler.authenticated(): handler.unauthorized(); return True
    from urllib.parse import parse_qs
    params=parse_qs(parsed.query)
    try:
        sid=(params.get("sessionID") or [None])[0]; directory=features._session_directory(str(sid)) if sid else (params.get("directory") or [None])[0]; directory=features._canonical_directory(str(directory)) if directory else None; v3=instance(runtime,features)
        if parsed.path=="/client-runtime-v3.json": handler.json_response(runtime_snapshot(runtime,features,directory))
        elif parsed.path=="/client-repo-index-v3.json":
            if not directory: raise ValueError("directory/sessionID required")
            query=(params.get("query") or [""])[0]; handler.json_response(v3.indexer.search(directory,query,80) if query else v3.indexer.refresh(directory))
        elif parsed.path=="/client-replay.json":
            task_id=str((params.get("taskID") or [""])[0])
            if not task_id: raise ValueError("taskID required")
            handler.json_response(v3.replay.replay(task_id))
        else:
            after=int((params.get("after") or [0])[0]); handler.json_response({"events":runtime.STORE.events(project_dir=directory,after=after,limit=1000)})
    except Exception as exc: handler._feature_error(exc)
    return True


def handle_post(handler:Any,parsed:Any,runtime:Any,features:Any)->bool:
    internal={"/internal/runtime/tool-before","/internal/runtime/tool-after","/internal/runtime/shell","/internal/runtime/context"}; public={"/client-session-branch.json","/client-session-merge.json","/client-replay-capture.json","/client-notify-test.json"}
    if parsed.path not in internal|public: return False
    if parsed.path in internal:
        if not _internal_auth(handler): handler.json_response({"ok":False,"error":"forbidden"},status=403); return True
    elif not handler.authenticated(): handler.unauthorized(); return True
    try:
        payload=_json_body(handler); v3=instance(runtime,features)
        if parsed.path=="/internal/runtime/tool-before": result=v3.gateway.before(payload)
        elif parsed.path=="/internal/runtime/tool-after": result=v3.gateway.after(payload)
        elif parsed.path=="/internal/runtime/shell": result=v3.gateway.shell(payload)
        elif parsed.path=="/internal/runtime/context":
            sid=str(payload.get("sessionID") or ""); directory=features._session_directory(sid); settings=features.project_settings(directory); result=v3.context.envelope(features,runtime,sid,str(settings.get("instructions") or ""),str(settings.get("rag") or "auto"))
        elif parsed.path=="/client-session-branch.json": result=v3.branches.branch(features,str(payload.get("sessionID") or ""),str(payload.get("title") or "Runtime branch"))
        elif parsed.path=="/client-session-merge.json": result=v3.branches.merge(features,str(payload.get("sourceSessionID") or ""),str(payload.get("targetSessionID") or ""),include_state=bool(payload.get("includeState",True)))
        elif parsed.path=="/client-replay-capture.json":
            task=runtime.STORE.get_task(str(payload.get("taskID") or ""))
            if not task: raise KeyError(payload.get("taskID"))
            result={"ok":True,"artifact":v3.replay.capture(features,task)}
        else:
            event={"type":"runtime.test","message":str(payload.get("message") or "Runtime notification test"),"at":now_ms()}; v3.notifier.send(event); result={"ok":True}
        handler.json_response({"ok":True,**result} if isinstance(result,dict) and "ok" not in result else result)
    except Exception as exc: handler._feature_error(exc)
    return True
