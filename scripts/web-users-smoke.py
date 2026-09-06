#!/usr/bin/env python3
"""Test multi-user authentication with real HTTP server."""
from __future__ import annotations
import os
from pathlib import Path
import sys
import tempfile
import time

# Setup env BEFORE importing server modules
ROOT = Path(__file__).resolve().parents[1]
temp_dir = tempfile.mkdtemp(prefix="web-users-smoke-")
temp_path = Path(temp_dir)

os.environ["OPENCODE_SERVER_USERNAME"] = "envuser"
os.environ["OPENCODE_SERVER_PASSWORD"] = "envpass123"
os.environ["OPENCODE_USERS_FILE"] = str(temp_path / "users.json")
os.environ["OPENCODE_WEB_ALLOW_LOCAL"] = "0"
os.environ["OPENCODE_AUTH_ALLOW_BASIC"] = "1"
os.environ["OPENCODE_BACKEND_URL"] = "http://127.0.0.1:9"
os.environ["OPENCODE_BACKEND_PASSWORD"] = "backend-test"
os.environ["OPENCODE_SCRATCH_DIRECTORY"] = str(temp_path / "scratch")
os.environ["OPENCODE_PROJECT_ROOTS"] = str(temp_path / "projects")
os.environ["CUSTOM_OPENCODE_FEATURE_STATE"] = str(temp_path / "features.json")
os.environ["CUSTOM_OPENCODE_RUNTIME_DB"] = str(temp_path / "runtime.sqlite3")
os.environ["MCP_RAG_ENABLED"] = "0"
os.environ["OPENCODE_RESOURCE_SCHEDULER"] = "off"

(temp_path / "projects").mkdir()

# Now import server modules
sys.path.insert(0, str(ROOT / "app"))
import server_workflow
from server_workflow import Handler
from http.server import ThreadingHTTPServer
import threading
import http.client
import json

# Import server_users for direct testing
import server_users

# Create test users
print("Test 1: Create store users")
try:
    server_users.add_user("alice", "alicepass123")
    print("  ✓ Created alice")
except Exception as e:
    print(f"  ✗ Failed to create alice: {e}")
    sys.exit(1)

try:
    server_users.add_user("bob", "bobpass123")
    print("  ✓ Created bob")
except Exception as e:
    print(f"  ✗ Failed to create bob: {e}")
    sys.exit(1)

# Test user_exists
print("\nTest 2: user_exists")
assert server_users.user_exists("envuser"), "envuser should exist"
assert server_users.user_exists("alice"), "alice should exist"
assert server_users.user_exists("bob"), "bob should exist"
assert not server_users.user_exists("nonexistent"), "nonexistent should not exist"
print("  ✓ user_exists works correctly")

# Test authenticate
print("\nTest 3: authenticate")
assert server_users.authenticate("envuser", "envpass123"), "envuser should authenticate"
assert not server_users.authenticate("envuser", "wrongpass"), "envuser should fail with wrong password"
assert server_users.authenticate("alice", "alicepass123"), "alice should authenticate"
assert not server_users.authenticate("alice", "wrongpass"), "alice should fail with wrong password"
assert not server_users.authenticate("nonexistent", "anypass"), "nonexistent should fail"
print("  ✓ authenticate works correctly")

# Test list_users
print("\nTest 4: list_users")
users = server_users.list_users()
print(f"  Users: {[u['username'] for u in users]}")
assert len(users) == 3, f"Expected 3 users, got {len(users)}"
usernames = [u["username"] for u in users]
assert "envuser" in usernames, "envuser should be in list"
assert "alice" in usernames, "alice should be in list"
assert "bob" in usernames, "bob should be in list"
print("  ✓ list_users works correctly")

# Test legacy issue_session_token compatibility
print("\nTest 5: Legacy issue_session_token compatibility")
try:
    token_legacy = server_workflow.rag.plus.ext.base.issue_session_token(300)
    print(f"  ✓ issue_session_token(300) works (legacy)")
    token_new = server_workflow.rag.plus.ext.base.issue_session_token(300, "alice")
    print(f"  ✓ issue_session_token(300, 'alice') works (new)")
except Exception as e:
    print(f"  ✗ issue_session_token failed: {e}")
    sys.exit(1)

# Start server
print("\nTest 6: HTTP server authentication")
server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
host, port = server.server_address[:2]
print(f"  Server started on {host}:{port}")

def request(method: str, path: str, body=None, headers=None):
    conn = http.client.HTTPConnection(host, port, timeout=5)
    try:
        payload = None
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            headers = headers or {}
            headers["Content-Type"] = "application/json"
        conn.request(method, path, body=payload, headers=headers or {})
        response = conn.getresponse()
        data = response.read()
        return response.status, dict(response.getheaders()), data
    finally:
        conn.close()

try:
    # Test envuser login
    print("\n  Test 6a: envuser login")
    status, headers, _ = request(
        "POST",
        "/auth/login",
        body={"username": "envuser", "password": "envpass123"},
        headers={"Host": "example.com", "X-Forwarded-Proto": "https"}
    )
    assert status == 204, f"Expected 204, got {status}"
    envuser_cookie = headers.get("Set-Cookie", "")
    assert envuser_cookie, "No cookie returned"
    print(f"    ✓ envuser login successful, got cookie")

    # Test /auth/session for envuser
    print("  Test 6b: envuser /auth/session")
    status, _, data = request(
        "GET",
        "/auth/session",
        headers={"Host": "example.com", "Cookie": envuser_cookie, "X-Forwarded-Proto": "https"}
    )
    assert status == 200, f"Expected 200, got {status}"
    session_data = json.loads(data)
    assert session_data.get("user") == "envuser", f"Expected user='envuser', got {session_data.get('user')}"
    print(f"    ✓ envuser session returns username='envuser'")

    # Test alice login
    print("  Test 6c: alice login")
    status, headers, _ = request(
        "POST",
        "/auth/login",
        body={"username": "alice", "password": "alicepass123"},
        headers={"Host": "example.com", "X-Forwarded-Proto": "https"}
    )
    assert status == 204, f"Expected 204, got {status}"
    alice_cookie = headers.get("Set-Cookie", "")
    assert alice_cookie, "No cookie returned"
    print(f"    ✓ alice login successful, got cookie")

    # Test /auth/session for alice
    print("  Test 6d: alice /auth/session")
    status, _, data = request(
        "GET",
        "/auth/session",
        headers={"Host": "example.com", "Cookie": alice_cookie, "X-Forwarded-Proto": "https"}
    )
    assert status == 200, f"Expected 200, got {status}"
    session_data = json.loads(data)
    assert session_data.get("user") == "alice", f"Expected user='alice', got {session_data.get('user')}"
    print(f"    ✓ alice session returns username='alice'")

    # Test wrong password
    print("  Test 6e: wrong password")
    status, _, _ = request(
        "POST",
        "/auth/login",
        body={"username": "alice", "password": "wrongpass"},
        headers={"Host": "example.com", "X-Forwarded-Proto": "https"}
    )
    assert status == 401, f"Expected 401, got {status}"
    print(f"    ✓ wrong password returns 401")

    # Remove alice
    print("\n  Test 6f: remove alice")
    server_users.remove_user("alice")
    print(f"    ✓ alice removed")

    # Test alice cookie rejected after removal
    print("  Test 6g: alice cookie rejected after removal")
    status, _, _ = request(
        "GET",
        "/auth/session",
        headers={"Host": "example.com", "Cookie": alice_cookie, "X-Forwarded-Proto": "https"}
    )
    assert status == 401, f"Expected 401, got {status}"
    print(f"    ✓ alice cookie rejected (401)")

    # Test alice login fails after removal
    print("  Test 6h: alice login fails after removal")
    status, _, _ = request(
        "POST",
        "/auth/login",
        body={"username": "alice", "password": "alicepass123"},
        headers={"Host": "example.com", "X-Forwarded-Proto": "https"}
    )
    assert status == 401, f"Expected 401, got {status}"
    print(f"    ✓ alice login fails (401)")

    # Test envuser cookie still valid
    print("  Test 6i: envuser cookie still valid")
    status, _, data = request(
        "GET",
        "/auth/session",
        headers={"Host": "example.com", "Cookie": envuser_cookie, "X-Forwarded-Proto": "https"}
    )
    assert status == 200, f"Expected 200, got {status}"
    session_data = json.loads(data)
    assert session_data.get("user") == "envuser", f"Expected user='envuser', got {session_data.get('user')}"
    print(f"    ✓ envuser cookie still valid")

    # Test 7: Env-password rotation invalidates env-user v2 tokens
    print("\nTest 7: Env-password rotation")
    base = server_workflow.rag.plus.ext.base
    old_password = base.CLIENT_PASSWORD
    
    # Issue env-user v2 token with current password
    env_token_before = base.issue_session_token(300, "envuser")
    assert env_token_before, "Should issue env-user token"
    
    # Verify token is valid
    username_before = base.valid_session_token(env_token_before)
    assert username_before == "envuser", f"Expected 'envuser', got {username_before}"
    
    # Rotate password
    base.CLIENT_PASSWORD = "newenvpass123"
    
    # Old token should now be invalid
    username_after = base.valid_session_token(env_token_before)
    assert username_after is None, f"Old token should be invalid after rotation, got {username_after}"
    
    # Store-user token (bob) should still be valid
    bob_token = base.issue_session_token(300, "bob")
    bob_username = base.valid_session_token(bob_token)
    assert bob_username == "bob", f"Store-user token should remain valid, got {bob_username}"
    
    # Issue new env-user token with new password
    env_token_after = base.issue_session_token(300, "envuser")
    username_new = base.valid_session_token(env_token_after)
    assert username_new == "envuser", f"New token should be valid, got {username_new}"
    
    # Restore original password
    base.CLIENT_PASSWORD = old_password
    print("  ✓ Env-password rotation invalidates old tokens, store-user tokens unaffected")

    # Test 8: Basic-auth throttle (requires OPENCODE_AUTH_ALLOW_BASIC=1)
    print("\nTest 8: Basic-auth throttle")
    import base64
    
    # Create wrong Basic auth credentials
    wrong_auth = "Basic " + base64.b64encode(b"wronguser:wrongpass").decode("ascii")
    
    # Headers for basic auth requests (use different IP to avoid interference)
    basic_headers = {
        "Host": "example.com",
        "X-Forwarded-Proto": "https",
        "X-Forwarded-For": "198.51.100.99",  # Unique IP for this test
        "Authorization": wrong_auth,
    }
    
    # Send _LOGIN_MAX_FAILURES (8) requests - all should get 401
    for i in range(server_workflow._LOGIN_MAX_FAILURES):
        status, _, _ = request(
            "GET",
            "/auth/session",
            headers=basic_headers,
        )
        assert status == 401, f"Expected 401 on attempt {i+1}, got {status}"
    
    # 9th request is throttled: authenticated() denies before checking
    # credentials, so even CORRECT credentials get 401 (the 429 body is
    # specific to the /auth/login POST path).
    good_auth = "Basic " + base64.b64encode(b"envuser:envpass123").decode("ascii")
    status, _, _ = request(
        "GET",
        "/auth/session",
        headers={**basic_headers, "Authorization": good_auth},
    )
    assert status == 401, f"Expected throttled 401 with good credentials, got {status}"
    assert server_workflow._login_limited("proxy:198.51.100.99"), "identity should be throttled"
    print("  ✓ Basic-auth throttle works (8 failures → throttled denial)")

finally:
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)

print("\n✅ All web-users-smoke tests passed")
