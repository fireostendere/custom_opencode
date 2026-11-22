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
    (worktree/"nested").mkdir(); (worktree/"nested"/"child.txt").write_text("nested\n",encoding="utf-8")
    store=RuntimeStore(tmp/"runtime.sqlite3"); store.initialize()
    task=store.create_task(task_id="wt-task",session_id="s1",project_dir=str(worktree),text="isolated",metadata={"ownershipRoot":str(root),"worktree":str(worktree),"sandbox":"repo-write"},baseline={"head":head})
    runtime=SimpleNamespace(STORE=store)
    merged=runtime_v3_ext._worktree_merge(runtime,task,False)
    assert merged["ok"] and set(merged["changed"])=={"tracked.txt","new.txt","nested/child.txt"}
    assert (root/"tracked.txt").read_text(encoding="utf-8")=="merged\n"
    assert (root/"new.txt").read_text(encoding="utf-8")=="new\n"
    assert (root/"nested"/"child.txt").read_text(encoding="utf-8")=="nested\n"

    # A second isolated branch may not overwrite an already dirty target path.
    worktree2=tmp/"wt2"; subprocess.run(["git","-C",str(root),"worktree","add","--detach",str(worktree2),head],stdout=subprocess.DEVNULL,check=True)
    (worktree2/"tracked.txt").write_text("other\n",encoding="utf-8")
    task2=store.create_task(task_id="wt-task-2",session_id="s2",project_dir=str(worktree2),text="isolated 2",metadata={"ownershipRoot":str(root),"worktree":str(worktree2),"sandbox":"repo-write"},baseline={"head":head})
    try: runtime_v3_ext._worktree_merge(runtime,task2,False)
    except RuntimeError as exc: assert "uncommitted changes" in str(exc) or "ownership conflict" in str(exc)
    else: raise AssertionError("worktree merge overwrote dirty target")

    worktree3=tmp/"wt3"; subprocess.run(["git","-C",str(root),"worktree","add","--detach",str(worktree3),head],stdout=subprocess.DEVNULL,check=True)
    (worktree3/"linked.txt").symlink_to("tracked.txt")
    task3=store.create_task(task_id="wt-task-3",session_id="s3",project_dir=str(worktree3),text="isolated 3",metadata={"ownershipRoot":str(root),"worktree":str(worktree3),"sandbox":"repo-write"},baseline={"head":head})
    try: runtime_v3_ext._worktree_merge(runtime,task3,False)
    except RuntimeError as exc: assert "symlink" in str(exc)
    else: raise AssertionError("worktree merge followed an untracked symlink")

    # A session opened in a subdirectory: git apply from there would silently
    # drop hunks outside it, so the merge must target the repository toplevel.
    (root/"pkg").mkdir(); (root/"pkg"/"inner.txt").write_text("base\n",encoding="utf-8"); (root/"top.txt").write_text("base\n",encoding="utf-8")
    subprocess.run(["git","-C",str(root),"add","-A"],check=True); subprocess.run(["git","-C",str(root),"commit","-qm","layout"],check=True)
    head2=subprocess.check_output(["git","-C",str(root),"rev-parse","HEAD"],text=True).strip()
    worktree4=tmp/"wt4"; subprocess.run(["git","-C",str(root),"worktree","add","--detach",str(worktree4),head2],stdout=subprocess.DEVNULL,check=True)
    (worktree4/"top.txt").write_text("changed\n",encoding="utf-8"); (worktree4/"pkg"/"inner.txt").write_text("changed\n",encoding="utf-8"); (worktree4/"pkg"/"new.txt").write_text("new\n",encoding="utf-8")
    task4=store.create_task(task_id="wt-task-4",session_id="s4",project_dir=str(worktree4),text="isolated 4",metadata={"ownershipRoot":str(root/"pkg"),"worktree":str(worktree4),"sandbox":"repo-write"},baseline={"head":head2})
    merged=runtime_v3_ext._worktree_merge(runtime,task4,False)
    assert merged["target"]==str(root.resolve()) and set(merged["changed"])=={"top.txt","pkg/inner.txt","pkg/new.txt"}, merged
    assert (root/"top.txt").read_text(encoding="utf-8")=="changed\n" and (root/"pkg"/"new.txt").read_text(encoding="utf-8")=="new\n"
    assert not (root/"pkg"/"pkg").exists()

    # A worktree of another repository never merges into this root.
    other=tmp/"other"; other.mkdir(); subprocess.run(["git","init","-q",str(other)],check=True)
    subprocess.run(["git","-C",str(other),"-c","user.email=smoke@example.invalid","-c","user.name=Smoke","commit","-q","--allow-empty","-m","base"],check=True)
    worktree5=tmp/"wt5"; subprocess.run(["git","-C",str(other),"worktree","add","--detach",str(worktree5),"HEAD"],stdout=subprocess.DEVNULL,check=True)
    (worktree5/"foreign.txt").write_text("x\n",encoding="utf-8")
    task5=store.create_task(task_id="wt-task-5",session_id="s5",project_dir=str(worktree5),text="isolated 5",metadata={"ownershipRoot":str(root),"worktree":str(worktree5),"sandbox":"repo-write"},baseline={"head":"HEAD"})
    try: runtime_v3_ext._worktree_merge(runtime,task5,False)
    except RuntimeError as exc: assert "does not belong" in str(exc), exc
    else: raise AssertionError("worktree merge accepted a foreign repository")

print("Runtime V3 worktree smoke passed: tracked/untracked merge + subdirectory root + dirty-target/symlink/foreign-repo fail-closed")
