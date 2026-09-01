#!/usr/bin/env python3
from pathlib import Path

path = Path("app/server.py")
text = path.read_text(encoding="utf-8")
old = '''    elif path == "/api/session":
        if isinstance(payload, dict) and isinstance(payload.get("data"), list):
            payload = dict(payload)
            payload["data"] = [
                mark_quick_session(session)
                for session in payload["data"]
                if not (isinstance(session, dict) and session.get("parentID"))
            ]
        elif isinstance(payload, list):
            payload = [
                mark_quick_session(session)
                for session in payload
                if not (isinstance(session, dict) and session.get("parentID"))
            ]
'''
new = '''    elif path == "/api/session":
        if isinstance(payload, dict) and isinstance(payload.get("data"), list):
            payload = dict(payload)
            payload["data"] = [mark_quick_session(session) for session in payload["data"]]
        elif isinstance(payload, list):
            payload = [mark_quick_session(session) for session in payload]
'''
if new not in text:
    if old not in text:
        raise SystemExit("session proxy child filter block not found")
    text = text.replace(old, new, 1)
path.write_text(text, encoding="utf-8")
