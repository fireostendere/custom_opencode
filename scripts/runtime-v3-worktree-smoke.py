#!/usr/bin/env python3
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"app"))

with tempfile.TemporaryDirectory() as temp:
    tmp=Path(temp); os.environ["CUSTOM_OPENCODE_RUNTIME_DB"]=str(tmp/"runtime.sqlite3")
    from runtime_store import RuntimeStore
    import runtime_v3_ext

    root=tmp/"root"; root.mkdir(); subprocess.run(["git","init","-q",str(root)],check=True)
    subprocess.run(["git","-C",str(root),"config","user.email","smoke@example.invalid"],check=True)
    subprocess.run(["git","-C",str(root),"config","user.name","Worktree Smoke"],check=True)
    (root/"tracked.txt").write_text("base\n",encoding="utf-8")
    subprocess.run(["git","-C",str(root),"add","."],check=True); subprocess.run(["git","-C",str(root),"commit","-qm","base"],check=True)
    head=subprocess.check_output(["git","-C",str(root),"rev-parse","HEAD"],text=True).strip()

    worktree=tmp/"wt1"; subprocess.run(["git","-C",str(root),"worktree","add","--detach",str(worktree),"HEAD"],stdout=subprocess.DEVNULL,check=True)
    (worktree/"tracked.txt").write_text("merged\n",encoding="utf-8"); (worktree/"new.txt").write_text("new\n",encoding="utf-8")
    store=RuntimeStore(tmp/"runtime.sqlite3"); store.initialize()
    task=store.create_task(task_id="wt-task",session_id="s1",project_dir=str(worktree),text="isolated",metadata={"ownershipRoot":str(root),"worktree":str(worktree),"sandbox":"repo-write"},baseline={"head":head})
    runtime=SimpleNamespace(STORE=store)
    merged=runtime_v3_ext._worktree_merge(runtime,task,False)
    assert merged["ok"] and set(merged["changed"])=={"tracked.txt","new.txt"}
    assert (root/"tracked.txt").read_text(encoding="utf-8")=="merged\n"
    assert (root/"new.txt").read_text(encoding="utf-8")=="new\n"

    # A second isolated branch may not overwrite an already dirty target path.
    worktree2=tmp/"wt2"; subprocess.run(["git","-C",str(root),"worktree","add","--detach",str(worktree2),head],stdout=subprocess.DEVNULL,check=True)
    (worktree2/"tracked.txt").write_text("other\n",encoding="utf-8")
    task2=store.create_task(task_id="wt-task-2",session_id="s2",project_dir=str(worktree2),text="isolated 2",metadata={"ownershipRoot":str(root),"worktree":str(worktree2),"sandbox":"repo-write"},baseline={"head":head})
    try: runtime_v3_ext._worktree_merge(runtime,task2,False)
    except RuntimeError as exc: assert "uncommitted changes" in str(exc) or "ownership conflict" in str(exc)
    else: raise AssertionError("worktree merge overwrote dirty target")

print("Runtime V3 worktree smoke passed: tracked/untracked merge + dirty-target fail-closed")
