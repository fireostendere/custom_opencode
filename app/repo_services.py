#!/usr/bin/env python3
"""Repository index, context cache, artifacts and verification helpers."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from typing import Any, Iterable
from uuid import uuid4

from runtime_store import RuntimeStore, now_ms

TEXT_EXTENSIONS={".py",".js",".mjs",".cjs",".ts",".tsx",".jsx",".java",".kt",".kts",".go",".rs",".c",".h",".cc",".cpp",".hpp",".cs",".rb",".php",".swift",".sh",".bash",".md",".toml",".yaml",".yml",".json",".xml",".html",".css",".scss",".sql"}
DEPENDENCY_FILES={"package.json","package-lock.json","pnpm-lock.yaml","yarn.lock","pyproject.toml","requirements.txt","poetry.lock","Cargo.toml","Cargo.lock","go.mod","go.sum","pom.xml","build.gradle","build.gradle.kts","Gemfile","composer.json","Dockerfile","docker-compose.yml","docker-compose.yaml","AGENTS.md"}
SYMBOL_PATTERNS=[
    re.compile(r"^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(",re.M),re.compile(r"^\s*class\s+([A-Za-z_][\w]*)\b",re.M),
    re.compile(r"^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(",re.M),
    re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?[^\n]*=>",re.M),
    re.compile(r"^\s*(?:pub\s+)?fn\s+([A-Za-z_][\w]*)\s*\(",re.M),
    re.compile(r"^\s*(?:public\s+|private\s+|protected\s+)?(?:class|interface|enum|struct)\s+([A-Za-z_][\w]*)\b",re.M),
]


def _run(root:Path,args:list[str],timeout:float=12.,input_text:str|None=None)->subprocess.CompletedProcess[str]:
    return subprocess.run(args,cwd=str(root),input=input_text,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=timeout,check=False)


def safe_repo_file(root:Path,relative:str)->Path|None:
    """Return a regular file physically contained by root; reject symlink escapes."""
    try:
        candidate=root/relative
        if candidate.is_symlink(): return None
        resolved=candidate.resolve(strict=True)
        resolved.relative_to(root)
        return resolved if resolved.is_file() else None
    except (OSError,ValueError,RuntimeError):
        return None


def git_snapshot(project_dir:str)->dict[str,Any]:
    root=Path(project_dir).resolve(strict=False); probe=_run(root,["git","rev-parse","--is-inside-work-tree"],timeout=3.)
    if probe.returncode!=0: return {"git":False,"head":None,"status":[],"changed":[]}
    head=_run(root,["git","rev-parse","HEAD"],timeout=4.); status=_run(root,["git","status","--porcelain=v1","-z"],timeout=6.); rows=[]
    if status.returncode==0: rows=[item for item in status.stdout.split("\0") if item][:1000]
    changed=[]
    for row in rows:
        path=row[3:] if len(row)>3 else row
        if " -> " in path: path=path.split(" -> ",1)[1]
        changed.append(path)
    return {"git":True,"head":head.stdout.strip() if head.returncode==0 else None,"status":rows,"changed":sorted(dict.fromkeys(changed)),"statusHash":hashlib.sha256("\n".join(rows).encode()).hexdigest()[:16],"capturedAt":now_ms()}


def semantic_diff(project_dir:str,baseline:dict[str,Any]|None=None)->dict[str,Any]:
    current=git_snapshot(project_dir); baseline=baseline or {}; root=Path(project_dir).resolve(strict=False); files=list(current.get("changed") or []); base_head=baseline.get("head"); current_head=current.get("head")
    if current.get("git") and base_head and current_head and base_head!=current_head:
        proc=_run(root,["git","diff","--name-status",f"{base_head}..{current_head}"],timeout=8.)
        if proc.returncode==0:
            for line in proc.stdout.splitlines():
                bits=line.split("\t")
                if len(bits)>=2: files.append(bits[-1])
    stats={"files":0,"insertions":0,"deletions":0}
    if current.get("git"):
        proc=_run(root,["git","diff","--numstat"],timeout=8.)
        if proc.returncode==0:
            for line in proc.stdout.splitlines():
                bits=line.split("\t")
                if len(bits)>=3:
                    stats["files"]+=1
                    if bits[0].isdigit(): stats["insertions"]+=int(bits[0])
                    if bits[1].isdigit(): stats["deletions"]+=int(bits[1])
    files=sorted(dict.fromkeys(files))[:500]; stats["files"]=max(stats["files"],len(files))
    return {"baseline":baseline,"current":current,"changedFiles":files,"stats":stats}


class RepoIndexer:
    def __init__(self,store:RuntimeStore): self.store=store
    def _key(self,project_dir:str)->str: return hashlib.sha256(project_dir.encode()).hexdigest()
    def refresh(self,project_dir:str,*,force:bool=False)->dict[str,Any]:
        root=Path(project_dir).resolve(strict=True); snapshot=git_snapshot(project_dir); fingerprint=f"{snapshot.get('head')}:{snapshot.get('statusHash')}"; key=self._key(project_dir); cached=self.store.cache_get("repo-index",key)
        if not force and isinstance(cached,dict) and cached.get("fingerprint")==fingerprint: cached["cacheHit"]=True; return cached
        files=[]
        if snapshot.get("git"):
            proc=_run(root,["git","ls-files","-z"],timeout=12.)
            if proc.returncode==0: files=[item for item in proc.stdout.split("\0") if item][:6000]
        if not files:
            for path in root.rglob("*"):
                if not path.is_file() or any(part.startswith(".") for part in path.relative_to(root).parts): continue
                try: files.append(str(path.relative_to(root)))
                except ValueError: continue
                if len(files)>=3000: break
        files=[relative for relative in files if safe_repo_file(root,relative) is not None]
        symbols=[]; deps=[]; extension_counts={}; indexed_bytes=0
        for relative in files:
            path=safe_repo_file(root,relative)
            if path is None: continue
            ext=path.suffix.lower(); extension_counts[ext or "<none>"]=extension_counts.get(ext or "<none>",0)+1
            if path.name in DEPENDENCY_FILES:
                try:
                    text=path.read_text(encoding="utf-8",errors="ignore")[:120000]; deps.append({"path":relative,"sha":hashlib.sha256(text.encode()).hexdigest()[:16],"preview":text[:1500]})
                except OSError: pass
            if ext not in TEXT_EXTENSIONS or len(symbols)>=20000: continue
            try:
                if path.stat().st_size>1500000: continue
                text=path.read_text(encoding="utf-8",errors="ignore")
            except OSError: continue
            indexed_bytes+=len(text.encode("utf-8",errors="ignore"))
            if indexed_bytes>60000000: break
            seen=set()
            for pattern in SYMBOL_PATTERNS:
                for match in pattern.finditer(text):
                    name=match.group(1)
                    if name in seen: continue
                    seen.add(name); symbols.append({"name":name,"path":relative,"line":text.count("\n",0,match.start())+1})
                    if len(symbols)>=20000: break
                if len(symbols)>=20000: break
        index={"projectDir":str(root),"fingerprint":fingerprint,"snapshot":snapshot,"files":len(files),"symbols":symbols,"dependencies":deps,"extensions":dict(sorted(extension_counts.items(),key=lambda item:(-item[1],item[0]))[:30]),"indexedBytes":indexed_bytes,"generatedAt":now_ms(),"cacheHit":False}
        self.store.cache_set("repo-index",key,index,ttl_seconds=3600); return index
    def search(self,project_dir:str,query:str,limit:int=40)->dict[str,Any]:
        index=self.refresh(project_dir); needle=query.strip().casefold()
        if not needle: return {"query":query,"hits":[],"index":{k:index.get(k) for k in ("files","generatedAt","fingerprint")}}
        terms=[term for term in re.split(r"\s+",needle) if term]; hits=[]
        for symbol in index.get("symbols") or []:
            hay=f"{symbol.get('name','')} {symbol.get('path','')}".casefold(); score=sum(4 if symbol.get("name","").casefold()==term else 2 if term in str(symbol.get("name","")).casefold() else 1 if term in hay else 0 for term in terms)
            if score: hits.append((score,{"type":"symbol",**symbol}))
        for dep in index.get("dependencies") or []:
            hay=f"{dep.get('path','')} {dep.get('preview','')}".casefold(); score=sum(1 for term in terms if term in hay)
            if score: hits.append((score,{"type":"dependency","path":dep.get("path"),"preview":dep.get("preview","")[:500]}))
        hits.sort(key=lambda item:(-item[0],str(item[1].get("path")),str(item[1].get("name",""))))
        return {"query":query,"hits":[item for _,item in hits[:max(1,min(200,int(limit)))]],"index":{k:index.get(k) for k in ("files","generatedAt","fingerprint")}}


class ArtifactStore:
    INLINE_LIMIT=24000
    def __init__(self,store:RuntimeStore): self.store=store
    def put(self,*,task_id:str|None,project_dir:str|None,kind:str,title:str,content:str|bytes,summary:str="",mime:str="text/plain")->dict[str,Any]:
        self.store.initialize(); data=content.encode("utf-8",errors="replace") if isinstance(content,str) else bytes(content); artifact_id=f"a_{uuid4().hex}"; digest=hashlib.sha256(data).hexdigest(); inline_text=None; file_path=None
        if len(data)<=self.INLINE_LIMIT and mime.startswith("text/"): inline_text=data.decode("utf-8",errors="replace")
        else:
            directory=self.store.paths.artifacts/(task_id or "shared"); directory.mkdir(parents=True,exist_ok=True,mode=0o700); path=directory/artifact_id; path.write_bytes(data); os.chmod(path,0o600); file_path=str(path)
        with self.store.transaction() as db: db.execute("INSERT INTO artifacts(id,task_id,project_dir,kind,title,summary,mime,inline_text,file_path,size_bytes,sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",(artifact_id,task_id,project_dir,kind[:80],title[:500],summary[:4000],mime[:160],inline_text,file_path,len(data),digest,now_ms()))
        return {"id":artifact_id,"taskID":task_id,"kind":kind[:80],"title":title[:500],"summary":summary[:4000],"mime":mime,"size":len(data),"sha256":digest,"inline":inline_text is not None}
    def get(self,artifact_id:str,*,offset:int=0,limit:int=64000,query:str|None=None)->dict[str,Any]|None:
        self.store.initialize()
        with self.store.connect() as db: row=db.execute("SELECT * FROM artifacts WHERE id=?",(artifact_id,)).fetchone()
        if not row: return None
        if row["inline_text"] is not None: text=str(row["inline_text"])
        elif row["file_path"]:
            try: text=Path(str(row["file_path"])).read_text(encoding="utf-8",errors="replace")
            except OSError: text=""
        else: text=""
        offset=max(0,int(offset)); limit=max(1,min(500000,int(limit)))
        if query:
            q=query.casefold(); lines=text.splitlines(); matched=[]
            for index,line in enumerate(lines):
                if q in line.casefold():
                    matched.append({"line":index+1,"context":"\n".join(lines[max(0,index-2):min(len(lines),index+3)])})
                    if len(matched)>=50: break
            content:Any=matched
        else: content=text[offset:offset+limit]
        return {"id":row["id"],"taskID":row["task_id"],"kind":row["kind"],"title":row["title"],"summary":row["summary"],"mime":row["mime"],"size":row["size_bytes"],"sha256":row["sha256"],"offset":offset,"content":content}
    def list(self,task_id:str,limit:int=100)->list[dict[str,Any]]:
        self.store.initialize()
        with self.store.connect() as db: rows=db.execute("SELECT id,kind,title,summary,mime,size_bytes,sha256,created_at FROM artifacts WHERE task_id=? ORDER BY created_at DESC LIMIT ?",(task_id,max(1,min(500,int(limit))))).fetchall()
        return [{"id":r["id"],"kind":r["kind"],"title":r["title"],"summary":r["summary"],"mime":r["mime"],"size":r["size_bytes"],"sha256":r["sha256"],"createdAt":r["created_at"]} for r in rows]


class ContextService:
    def __init__(self,store:RuntimeStore,indexer:RepoIndexer): self.store=store; self.indexer=indexer
    @staticmethod
    def dedupe(parts:Iterable[str])->list[str]:
        seen=set(); out=[]
        for part in parts:
            compact="\n".join(line.rstrip() for line in str(part).strip().splitlines()).strip()
            if not compact: continue
            digest=hashlib.sha256(compact.encode()).hexdigest()
            if digest in seen: continue
            seen.add(digest); out.append(compact)
        return out
    def envelope(self,*,project_dir:str,task:dict[str,Any]|None,project_instructions:str="",budget_chars:int=24000)->dict[str,Any]:
        budget_chars=max(2000,min(120000,int(budget_chars))); parts=[]
        if project_instructions.strip(): parts.append("Project instructions:\n"+project_instructions.strip())
        memory=self.store.memory_list(project_dir,limit=20)
        if memory: parts.append("Project memory:\n"+"\n".join(f"- [{item['category']}] {item['key']}: {item['value']}" for item in memory))
        decisions=self.store.decision_list(project_dir,limit=12)
        if decisions: parts.append("Active decision log:\n"+"\n".join(f"- {item['title']}: {item['decision']}"+(f" ({item['rationale']})" if item['rationale'] else "") for item in decisions))
        baseline=task.get("baseline") if task else None; diff=semantic_diff(project_dir,baseline if isinstance(baseline,dict) else None); changed=diff.get("changedFiles") or []
        if changed:
            stats=diff.get("stats") or {}; parts.append(f"Semantic diff since task baseline: {len(changed)} changed files, +{stats.get('insertions',0)}/-{stats.get('deletions',0)}.\n"+"\n".join(f"- {path}" for path in changed[:120]))
        try:
            index=self.indexer.refresh(project_dir); deps=[str(item.get("path")) for item in index.get("dependencies") or []]
            if deps: parts.append("Repository dependency/entry files cached by server:\n"+"\n".join(f"- {item}" for item in deps[:40]))
        except Exception: pass
        if task:
            inbox=self.store.mailbox_receive(task["id"],consume=False,limit=30)
            if inbox: parts.append("Structured agent mailbox:\n"+"\n".join(f"- {item['type']}: {json.dumps(item['payload'],ensure_ascii=False)[:1200]}" for item in inbox))
            handoff=task.get("metadata",{}).get("handoff") if isinstance(task.get("metadata"),dict) else None
            if isinstance(handoff,dict): parts.append("Typed handoff:\n"+json.dumps(handoff,ensure_ascii=False,indent=2)[:8000])
        output=[]; used=0; omitted=0
        for part in self.dedupe(parts):
            if used+len(part)+2<=budget_chars: output.append(part); used+=len(part)+2
            else:
                remaining=budget_chars-used
                if remaining>800: output.append(part[:remaining-80]+"\n[…server context truncated…]"); used=budget_chars
                omitted+=1; break
        text="\n\n".join(output); return {"text":text,"budgetChars":budget_chars,"usedChars":len(text),"omittedSections":omitted,"semanticDiff":diff}


NETWORK_RE=re.compile(r"(?i)(temporary failure in name resolution|could not resolve|connection (?:reset|refused)|network is unreachable|timed? out|tls handshake)")
ENV_RE=re.compile(r"(?i)(command not found|no module named|module not found|cannot find module|permission denied|no such file or directory|toolchain.*not installed)")
FLAKY_RE=re.compile(r"(?i)(flaky|race condition|timing-dependent|retrying|intermittent)")

def classify_failure(output:str,returncode:int)->str:
    if returncode==0: return "pass"
    if NETWORK_RE.search(output): return "network"
    if ENV_RE.search(output): return "environment"
    if FLAKY_RE.search(output): return "flaky"
    return "code"


class VerificationPipeline:
    def __init__(self,artifacts:ArtifactStore): self.artifacts=artifacts
    def discover(self,project_dir:str)->list[dict[str,Any]]:
        root=Path(project_dir).resolve(strict=True); commands=[]; package=safe_repo_file(root,"package.json")
        if package is not None:
            try:
                data=json.loads(package.read_text(encoding="utf-8")); scripts=data.get("scripts") if isinstance(data.get("scripts"),dict) else {}
            except (OSError,json.JSONDecodeError): scripts={}
            runner="pnpm" if (root/"pnpm-lock.yaml").exists() else "yarn" if (root/"yarn.lock").exists() else "npm"
            for script in ("lint","typecheck","check","test"):
                if script in scripts: commands.append({"name":script,"argv":[runner,"run",script] if runner!="yarn" else ["yarn",script]})
        if safe_repo_file(root,"pyproject.toml") is not None or safe_repo_file(root,"pytest.ini") is not None: commands.append({"name":"pytest","argv":[sys.executable,"-m","pytest","-q"]})
        if safe_repo_file(root,"Cargo.toml") is not None: commands.append({"name":"cargo-check","argv":["cargo","check"]})
        if safe_repo_file(root,"go.mod") is not None: commands.append({"name":"go-test","argv":["go","test","./..."]})
        return commands[:4]
    def run(self,*,task:dict[str,Any],timeout_seconds:int|None=None)->dict[str,Any]:
        if os.environ.get("OPENCODE_VERIFY_PIPELINE","auto").strip().lower() in {"0","off","false","no"}: return {"enabled":False,"results":[],"ok":True,"reason":"verification disabled"}
        if os.environ.get("OPENCODE_VERIFY_TRUST_REPO","0").strip().lower() not in {"1","true","yes","on"}: return {"enabled":False,"results":[],"ok":True,"reason":"repository verification requires explicit trust (OPENCODE_VERIFY_TRUST_REPO=1)"}
        timeout_seconds=timeout_seconds or int(os.environ.get("OPENCODE_VERIFY_TIMEOUT","120")); results=[]
        for command in self.discover(task["project_dir"]):
            started=time.monotonic()
            try:
                proc=_run(Path(task["project_dir"]),command["argv"],timeout=float(timeout_seconds)); output=((proc.stdout or "")+("\n" if proc.stdout and proc.stderr else "")+(proc.stderr or "")).strip(); classification=classify_failure(output,proc.returncode); elapsed=int((time.monotonic()-started)*1000)
            except subprocess.TimeoutExpired as exc:
                output=f"verification timeout after {timeout_seconds}s: {exc}"; classification="environment"; elapsed=int((time.monotonic()-started)*1000); proc=None
            artifact=self.artifacts.put(task_id=task["id"],project_dir=task["project_dir"],kind="verification-log",title=f"Verification: {command['name']}",content=output,summary=f"{classification}: {command['name']}")
            results.append({"name":command["name"],"argv":command["argv"],"returncode":proc.returncode if proc else None,"classification":classification,"elapsedMs":elapsed,"artifactID":artifact["id"],"failureSummary":"\n".join(output.splitlines()[-30:])[-6000:] if classification!="pass" else ""})
        return {"enabled":True,"results":results,"ok":all(item["classification"]=="pass" for item in results),"actionableFailures":[item for item in results if item["classification"]=="code"],"environmentFailures":[item for item in results if item["classification"] in {"network","environment","flaky"}]}


def review_decision(project_dir:str,baseline:dict[str,Any]|None=None)->dict[str,Any]:
    diff=semantic_diff(project_dir,baseline); stats=diff.get("stats") or {}; files=diff.get("changedFiles") or []; total=int(stats.get("insertions",0))+int(stats.get("deletions",0)); sensitive=any(re.search(r"(?i)(auth|security|permission|payment|migration|schema|crypto|secret|\.github/workflows)",path) for path in files); needed=sensitive or len(files)>3 or total>80
    return {"needed":needed,"reason":"sensitive/high-impact diff" if sensitive else "diff size threshold" if needed else "trivial bounded diff","diff":diff}


class SecretBroker:
    """In-process scoped secret lookup. Values are never serialized by snapshot()."""
    def __init__(self): self.allowed_prefixes=tuple(item for item in os.environ.get("OPENCODE_SECRET_PREFIXES","TOKEN_PLAN_;OPENAI_;GITHUB_;MCP_").split(";") if item)
    def resolve(self,name:str,*,scope:str)->str:
        if not any(name.startswith(prefix) for prefix in self.allowed_prefixes): raise PermissionError("secret name outside broker allowlist")
        value=os.environ.get(name)
        if not value: raise KeyError(name)
        return value
    def snapshot(self)->dict[str,Any]:
        names=sorted(name for name in os.environ if any(name.startswith(prefix) for prefix in self.allowed_prefixes) and os.environ.get(name)); return {"availableRefs":names,"plaintextExposed":False,"scoped":True}
