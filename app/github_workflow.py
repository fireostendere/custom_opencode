#!/usr/bin/env python3
"""Optional GitHub workflow adapter backed by an already-authenticated `gh` CLI.

No GitHub token is read or stored by custom_opencode. The adapter is fail-closed:
when gh is missing or unauthenticated, the rest of the runtime remains usable.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
from typing import Any
from urllib.parse import urlparse


def _run(args: list[str], *, cwd: str, timeout: float = 15.0) -> str:
    gh = shutil.which("gh")
    if not gh:
        raise RuntimeError("GitHub CLI (gh) is not installed")
    result = subprocess.run(
        [gh, *args],
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        check=False,
    )
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "gh command failed").strip()
        if "auth" in message.lower() or "login" in message.lower():
            raise RuntimeError("GitHub CLI is not authenticated")
        raise RuntimeError(message[:1200])
    return result.stdout


def _repo_from_origin(directory: str) -> str:
    result = subprocess.run(
        ["git", "-C", directory, "remote", "get-url", "origin"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=5.0,
        check=False,
    )
    if result.returncode != 0:
        raise ValueError("project has no git origin")
    raw = result.stdout.strip()
    match = re.search(r"github\.com[:/]([^/\s]+/[^/\s]+?)(?:\.git)?$", raw)
    if not match:
        raise ValueError("origin is not a GitHub repository")
    return match.group(1).removesuffix(".git")


def _number_and_repo(value: str, default_repo: str) -> tuple[int, str]:
    raw = str(value or "").strip()
    if not raw:
        raise ValueError("GitHub issue/PR reference is required")
    if raw.isdigit():
        return int(raw), default_repo
    parsed = urlparse(raw)
    if parsed.netloc.lower() == "github.com":
        parts = [part for part in parsed.path.split("/") if part]
        if len(parts) >= 4 and parts[2] in {"issues", "pull"} and parts[3].isdigit():
            return int(parts[3]), f"{parts[0]}/{parts[1]}"
    match = re.fullmatch(r"([^/\s]+/[^#\s]+)#(\d+)", raw)
    if match:
        return int(match.group(2)), match.group(1).removesuffix(".git")
    raise ValueError("use issue/PR number, owner/repo#number, or GitHub URL")


def status(directory: str) -> dict[str, Any]:
    repo = None
    try:
        repo = _repo_from_origin(directory)
    except Exception:
        pass
    gh = shutil.which("gh")
    authenticated = False
    if gh:
        try:
            result = subprocess.run(
                [gh, "auth", "status", "--hostname", "github.com"],
                cwd=directory,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=6.0,
                check=False,
            )
            authenticated = result.returncode == 0
        except Exception:
            authenticated = False
    return {"available": bool(gh and authenticated and repo), "ghInstalled": bool(gh), "authenticated": authenticated, "repository": repo}


def issue_task(features: Any, runtime: Any, payload: dict[str, Any]) -> dict[str, Any]:
    session_id = str(payload.get("sessionID") or "")
    if not session_id:
        raise ValueError("sessionID is required")
    directory = features._session_directory(session_id)
    default_repo = _repo_from_origin(directory)
    number, repo = _number_and_repo(str(payload.get("reference") or payload.get("issue") or ""), default_repo)
    raw = _run(["issue", "view", str(number), "--repo", repo, "--json", "number,title,body,url,state,labels"], cwd=directory)
    issue = json.loads(raw)
    title = str(issue.get("title") or f"Issue #{number}")
    body = str(issue.get("body") or "")[:30_000]
    labels = [str((item or {}).get("name") or "") for item in issue.get("labels") or [] if isinstance(item, dict)]
    text = (
        f"Implement GitHub issue {repo}#{number}: {title}\n"
        f"URL: {issue.get('url') or ''}\n"
        f"Labels: {', '.join(label for label in labels if label) or 'none'}\n\n"
        f"Issue body:\n{body}\n\n"
        "Work in the isolated task worktree. Inspect the repository, implement the smallest correct change, "
        "run the relevant verification, and leave the task ready for independent review/merge."
    )
    created = runtime.create_task_request(features, {
        "sessionID": session_id,
        "text": text,
        "title": f"Issue #{number}: {title}"[:200],
        "profile": str(payload.get("profile") or "build"),
        "priority": int(payload.get("priority") or 20),
        "kind": "github-issue",
        "isolate": True,
        "mode": "build",
    })
    task = created.get("task") if isinstance(created, dict) else None
    if isinstance(task, dict) and task.get("id"):
        runtime.STORE.update_task(str(task["id"]), metadata_patch={"github": {"type": "issue", "repository": repo, "number": number, "url": issue.get("url"), "state": issue.get("state")}})
        runtime.STORE.event(kind="github.issue.task_created", task_id=str(task["id"]), session_id=str(task.get("sessionID") or task.get("session_id") or session_id), project_dir=str(task.get("projectDir") or task.get("project_dir") or directory), data={"repository": repo, "number": number, "url": issue.get("url")})
    return {"ok": True, "github": {"repository": repo, "number": number, "url": issue.get("url"), "title": title}, **created}


def _review_comment_text(comment: dict[str, Any], repo: str, number: int) -> str:
    path = str(comment.get("path") or "")
    line = comment.get("line") or comment.get("original_line")
    body = str(comment.get("body") or "")[:12_000]
    author = str(((comment.get("user") or {}).get("login")) or "reviewer")
    location = f"{path}:{line}" if path and line else path or "PR discussion"
    return (
        f"Address GitHub PR review comment on {repo}#{number}.\n"
        f"Reviewer: {author}\nLocation: {location}\n"
        f"Comment URL: {comment.get('html_url') or ''}\n\n{body}\n\n"
        "Inspect the current branch/worktree and make the smallest correct change that resolves this review comment. "
        "Verify the affected behavior and report exactly what changed."
    )


def sync_pr_review(features: Any, runtime: Any, payload: dict[str, Any]) -> dict[str, Any]:
    session_id = str(payload.get("sessionID") or "")
    if not session_id:
        raise ValueError("sessionID is required")
    directory = features._session_directory(session_id)
    default_repo = _repo_from_origin(directory)
    number, repo = _number_and_repo(str(payload.get("reference") or payload.get("pr") or ""), default_repo)
    raw = _run(["api", f"repos/{repo}/pulls/{number}/comments", "--paginate"], cwd=directory, timeout=20.0)
    comments = json.loads(raw)
    if not isinstance(comments, list):
        comments = []
    cache_key = hashlib.sha256(f"{repo}#{number}".encode()).hexdigest()
    seen_raw = runtime.STORE.cache_get("github-review-comments", cache_key)
    seen = set(str(value) for value in (seen_raw if isinstance(seen_raw, list) else []))
    children = []
    for comment in comments:
        if not isinstance(comment, dict):
            continue
        comment_id = str(comment.get("id") or "")
        if not comment_id or comment_id in seen:
            continue
        # Superseded comments are kept by GitHub; skip rows explicitly marked outdated when available.
        if comment.get("subject_type") == "file" and not str(comment.get("body") or "").strip():
            continue
        created = runtime.create_task_request(features, {
            "sessionID": session_id,
            "text": _review_comment_text(comment, repo, number),
            "title": f"PR #{number} review: {comment.get('path') or comment_id}"[:200],
            "profile": str(payload.get("profile") or "build"),
            "priority": int(payload.get("priority") or 25),
            "kind": "github-review",
            "isolate": False,
            "mode": "build",
        })
        task = created.get("task") if isinstance(created, dict) else None
        if isinstance(task, dict) and task.get("id"):
            runtime.STORE.update_task(str(task["id"]), metadata_patch={"github": {"type": "pr-review", "repository": repo, "number": number, "commentID": comment_id, "url": comment.get("html_url")}})
            children.append(runtime._public(runtime.STORE.get_task(str(task["id"])) or task))
            seen.add(comment_id)
    runtime.STORE.cache_set("github-review-comments", cache_key, sorted(seen), ttl_seconds=180 * 24 * 3600)
    runtime.STORE.event(kind="github.review.synced", session_id=session_id, project_dir=directory, data={"repository": repo, "number": number, "created": len(children), "seen": len(seen)})
    return {"ok": True, "github": {"repository": repo, "number": number}, "created": len(children), "tasks": children}


def handle_get(handler: Any, parsed: Any, runtime: Any, features: Any) -> bool:
    if parsed.path != "/client-github-workflow.json":
        return False
    if not handler.authenticated():
        handler.unauthorized()
        return True
    try:
        from urllib.parse import parse_qs
        params = parse_qs(parsed.query)
        session_id = str((params.get("sessionID") or [""])[0])
        if not session_id:
            raise ValueError("sessionID is required")
        directory = features._session_directory(session_id)
        handler.json_response({"ok": True, "github": status(directory)})
    except Exception as exc:
        handler.json_response({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, status=400 if isinstance(exc, ValueError) else 500)
    return True


def handle_post(handler: Any, parsed: Any, runtime: Any, features: Any) -> bool:
    if parsed.path != "/client-github-workflow.json":
        return False
    if not handler.authenticated():
        handler.unauthorized()
        return True
    try:
        payload = handler._feature_body() if hasattr(handler, "_feature_body") else {}
        action = str(payload.get("action") or "")
        if action == "issue-task":
            handler.json_response(issue_task(features, runtime, payload))
        elif action == "sync-pr-review":
            handler.json_response(sync_pr_review(features, runtime, payload))
        else:
            raise ValueError("unknown GitHub workflow action")
    except Exception as exc:
        handler.json_response({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, status=400 if isinstance(exc, (ValueError, PermissionError)) else 500)
    return True
