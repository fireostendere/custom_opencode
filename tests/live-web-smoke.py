#!/usr/bin/env python3
"""Live smoke for the running custom OpenCode web client.

Default mode exercises the real running server (no LLM tokens spent):
  - desktop flow: auth, static assets, read-only API endpoints, SSE stream, logout;
  - mobile flow: same via mobile User-Agent + "remember" cookie (30 days);
  - tailscale path: the address the phone actually uses;
  - loopback bypass check;
  - 30s polling stability of the authenticated session.

--failover mode starts a throwaway server instance on a private port with a
controlled OPENCODE_SERVICE_FILE and proves the client self-heals after the
backend restarts on a new port, without a manual service restart.
"""
from __future__ import annotations

import argparse
import http.client
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import quote, urlencode, urlsplit

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"

DESKTOP_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/128 Safari/537.36")
MOBILE_UA = ("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/128 Mobile Safari/537.36")

RESULTS: list[tuple[bool, str]] = []


def check(ok: bool, label: str, detail: str = "") -> bool:
    RESULTS.append((ok, label))
    line = f"{'PASS' if ok else 'FAIL'}  {label}"
    if detail and not ok:
        line += f"  [{detail}]"
    print(line, flush=True)
    return ok


def read_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out[key.strip()] = value.strip()
    return out


ENV = read_env(ROOT / ".env")
USERNAME = ENV.get("OPENCODE_SERVER_USERNAME", "")
PASSWORD = ENV.get("OPENCODE_SERVER_PASSWORD", "")


class Client:
    def __init__(self, base_url: str, user_agent: str = DESKTOP_UA):
        parsed = urlsplit(base_url)
        self.host = parsed.hostname or "127.0.0.1"
        self.port = parsed.port or 80
        self.user_agent = user_agent
        self.cookie: str | None = None

    def request(self, method: str, path: str, body: dict | str | None = None,
                timeout: float = 20.0, accept: str = "application/json"):
        headers = {"User-Agent": self.user_agent, "Accept": accept}
        if self.cookie:
            headers["Cookie"] = self.cookie
        payload = None
        if body is not None:
            payload = body if isinstance(body, str) else json.dumps(body)
            headers["Content-Type"] = "application/json"
        started = time.monotonic()
        connection = http.client.HTTPConnection(self.host, self.port, timeout=timeout)
        try:
            connection.request(method, path, body=payload, headers=headers)
            response = connection.getresponse()
            raw = response.read()
            elapsed = time.monotonic() - started
            set_cookie = response.getheader("Set-Cookie")
            if set_cookie:
                self.cookie = set_cookie.split(";", 1)[0]
                if "Max-Age=0" in set_cookie or "opencode_session=;" in set_cookie:
                    self.cookie = None
            return response.status, dict(response.getheaders()), raw, elapsed
        finally:
            connection.close()

    def get_json(self, path: str, timeout: float = 20.0):
        status, headers, raw, elapsed = self.request("GET", path, timeout=timeout)
        try:
            value = json.loads(raw.decode("utf-8")) if raw else None
        except (UnicodeDecodeError, json.JSONDecodeError):
            value = None
        return status, value, elapsed


def wait_port(host: str, port: int, timeout: float = 15.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection((host, port), timeout=1.0):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def auth_flow(base_url: str, ua: str, label: str, remember: bool) -> bool:
    ok = True
    client = Client(base_url, ua)

    status, headers, raw, _ = client.request("GET", "/")
    location = headers.get("Location", "")
    ok &= check(status in (200, 302) and (status == 200 or "/login" in location),
                f"{label}: unauthenticated / → login", f"status={status} location={location}")

    status, _, raw, _ = client.request("GET", "/login.html")
    ok &= check(status == 200 and b"<html" in raw.lower(), f"{label}: /login.html served")

    bad = Client(base_url, ua)
    status, _, raw, _ = bad.request("POST", "/auth/login",
                                    {"username": USERNAME, "password": "wrong-password"})
    ok &= check(status == 401, f"{label}: wrong password rejected", f"status={status}")

    status, headers, raw, _ = client.request(
        "POST", "/auth/login",
        {"username": USERNAME, "password": PASSWORD, "remember": remember})
    cookie = headers.get("Set-Cookie", "")
    ok &= check(status == 204 and "opencode_session=" in cookie,
                f"{label}: login ok", f"status={status}")
    ok &= check("HttpOnly" in cookie and "SameSite=Strict" in cookie,
                f"{label}: cookie flags", cookie[:120])
    if remember:
        ok &= check("Max-Age=2592000" in cookie, f"{label}: remember cookie 30d", cookie[:120])

    status, value, _ = client.get_json("/auth/session")
    ok &= check(status == 200 and isinstance(value, dict) and value.get("ok"),
                f"{label}: /auth/session", f"status={status}")

    status, headers, raw, _ = client.request("GET", "/")
    text = raw.decode("utf-8", errors="replace")
    ok &= check(status == 200 and "app.js" in text, f"{label}: authenticated / is the app shell")
    if "mobile" in label.lower():
        ok &= check("mobile-ui.js" in text and "viewport" in text,
                    f"{label}: mobile assets wired in index.html")

    for asset in ("/app.js", "/api.js", "/styles.css", "/sw.js", "/site.webmanifest"):
        status, _, raw, _ = client.request("GET", asset, accept="*/*")
        ok &= check(status == 200 and len(raw) > 0, f"{label}: asset {asset}", f"status={status}")

    status, value, _ = client.get_json("/api/session?limit=5&order=desc")
    ok &= check(status == 200, f"{label}: /api/session list", f"status={status}")

    status, value, _ = client.get_json("/api/session/active")
    ok &= check(status == 200, f"{label}: /api/session/active", f"status={status}")

    directory = ENV.get("OPENCODE_SCRATCH_DIRECTORY") or "/tmp/opencode-scratch"
    query = urlencode({"location[directory]": directory})
    for endpoint in ("/api/model", "/api/agent", "/api/provider"):
        status, value, _ = client.get_json(f"{endpoint}?{query}")
        ok &= check(status == 200, f"{label}: {endpoint}", f"status={status}")

    status, value, _ = client.get_json("/client-config.json")
    ok &= check(status == 200 and isinstance(value, dict), f"{label}: /client-config.json")

    # SSE event stream: expect 200 + event-stream + at least one byte within 15s.
    started = time.monotonic()
    first_byte = None
    connection = http.client.HTTPConnection(client.host, client.port, timeout=16.0)
    try:
        headers = {"User-Agent": ua, "Accept": "text/event-stream"}
        if client.cookie:
            headers["Cookie"] = client.cookie
        connection.request("GET", "/api/event", headers=headers)
        response = connection.getresponse()
        ctype = response.getheader("Content-Type", "")
        ok &= check(response.status == 200 and ctype.startswith("text/event-stream"),
                    f"{label}: SSE /api/event opens", f"status={response.status} ct={ctype}")
        while time.monotonic() - started < 15.0:
            chunk = response.read(64)
            if chunk:
                first_byte = time.monotonic() - started
                break
        ok &= check(first_byte is not None,
                    f"{label}: SSE delivers events/heartbeats", "no bytes in 15s")
    except OSError as exc:
        check(False, f"{label}: SSE stream", str(exc))
        ok = False
    finally:
        connection.close()

    status, headers, raw, _ = client.request("POST", "/auth/logout")
    ok &= check(status == 204, f"{label}: logout", f"status={status}")
    status, value, _ = client.get_json("/auth/session")
    ok &= check(status == 401, f"{label}: session gone after logout", f"status={status}")
    return ok


def stability(base_url: str, ua: str, seconds: int = 30, interval: float = 2.0) -> bool:
    client = Client(base_url, ua)
    status, _, _, _ = client.request("POST", "/auth/login",
                                     {"username": USERNAME, "password": PASSWORD})
    if status != 204:
        return check(False, "stability: login", f"status={status}")
    latencies: list[float] = []
    deadline = time.monotonic() + seconds
    failures = 0
    while time.monotonic() < deadline:
        try:
            status, value, elapsed = client.get_json("/auth/session", timeout=10.0)
            latencies.append(elapsed)
            if status != 200:
                failures += 1
        except OSError:
            failures += 1
        time.sleep(interval)
    worst = max(latencies) if latencies else -1
    ok = failures == 0
    check(ok, f"stability: {seconds}s poll of /auth/session ({len(latencies)} req, {failures} failed, worst {worst:.2f}s)")
    return ok


def failover_mode() -> int:
    """Prove self-healing after backend restart using a throwaway instance."""
    real_service = json.loads((Path.home() / ".local/state/opencode/service.json").read_text())
    workdir = Path(tempfile.mkdtemp(prefix="web-failover-", dir="/tmp/opencode"))
    service_file = workdir / "service.json"
    service_file.write_text(json.dumps(real_service))
    port = 4099
    env = {
        **os.environ,
        "OPENCODE_SERVICE_FILE": str(service_file),
        "OPENCODE_WEB_HOST": "127.0.0.1",
        "OPENCODE_WEB_PORT": str(port),
        "OPENCODE_WEB_ALLOW_LOCAL": "0",
        "OPENCODE_SERVER_USERNAME": USERNAME,
        "OPENCODE_SERVER_PASSWORD": PASSWORD,
        "OPENCODE_BACKEND_URL": "",
        "OPENCODE_BACKEND_PASSWORD": "",
        "OPENCODE_SCRATCH_DIRECTORY": str(workdir / "scratch"),
        "OPENCODE_PROJECT_ROOTS": str(workdir / "projects"),
        "CUSTOM_OPENCODE_FEATURE_STATE": str(workdir / "features.json"),
        "CUSTOM_OPENCODE_RUNTIME_DB": str(workdir / "runtime.sqlite3"),
        "MCP_RAG_ENABLED": "0",
        "OPENCODE_RESOURCE_SCHEDULER": "off",
    }
    (workdir / "projects").mkdir(exist_ok=True)
    proc = subprocess.Popen([sys.executable, str(APP / "server_workflow.py")],
                            env=env, cwd=str(APP),
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        if not wait_port("127.0.0.1", port, timeout=20.0):
            check(False, "failover: throwaway server started")
            return 1
        check(True, "failover: throwaway server started")

        base = f"http://127.0.0.1:{port}"
        client = Client(base)
        status, _, _, _ = client.request("POST", "/auth/login",
                                         {"username": USERNAME, "password": PASSWORD})
        if not check(status == 204, "failover: login on throwaway instance", f"status={status}"):
            return 1

        status, value, _ = client.get_json("/api/session/active")
        if not check(status == 200, "failover: /api/session/active before restart", f"status={status}"):
            return 1

        # Backend "restarts" on a dead port.
        dead = dict(real_service)
        dead["url"] = "http://127.0.0.1:59999"
        dead["password"] = "dead"
        service_file.write_text(json.dumps(dead))
        time.sleep(6.0)  # let the discovery TTL expire
        started = time.monotonic()
        status, _, _ = client.get_json("/api/session/active", timeout=20.0)
        dead_elapsed = time.monotonic() - started
        check(status == 502, "failover: dead backend reported as 502", f"status={status}")
        check(dead_elapsed < 12.0,
              "failover: dead backend fails fast (no multi-minute connect hang)",
              f"{dead_elapsed:.1f}s")

        # Backend "comes back" on its real port: client must heal without restart.
        service_file.write_text(json.dumps(real_service))
        healed_status = None
        for attempt in range(3):
            status, value, _ = client.get_json("/api/session/active", timeout=15.0)
            healed_status = status
            if status == 200:
                break
            time.sleep(1.0)
        check(healed_status == 200,
              "failover: client self-heals after backend restart (no manual service restart)",
              f"status={healed_status}")
        return 0 if all(ok for ok, _ in RESULTS[-5:]) else 1
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(workdir, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--failover", action="store_true",
                        help="run backend-restart self-healing test on a throwaway instance")
    parser.add_argument("--lan", default=os.environ.get("OPENCODE_LAN_URL", ENV.get("OPENCODE_LAN_URL", "http://127.0.0.1:4098")))
    parser.add_argument("--tailscale", default=os.environ.get("OPENCODE_TAILSCALE_URL", ENV.get("OPENCODE_TAILSCALE_URL", "http://127.0.0.1:4098")))
    parser.add_argument("--loopback", default="http://127.0.0.1:4098")
    args = parser.parse_args()

    if args.failover:
        return failover_mode()

    if not USERNAME or not PASSWORD:
        print("OPENCODE_SERVER_USERNAME/PASSWORD missing in .env", file=sys.stderr)
        return 2

    ok = True
    print("== Desktop (LAN address) ==")
    ok &= auth_flow(args.lan, DESKTOP_UA, "desktop", remember=False)
    print("== Mobile (LAN address, Android UA, remember-me) ==")
    ok &= auth_flow(args.lan, MOBILE_UA, "mobile", remember=True)
    print("== Mobile via tailscale (the phone path) ==")
    ok &= auth_flow(args.tailscale, MOBILE_UA, "mobile-tailscale", remember=True)
    print("== Loopback bypass ==")
    bypass = Client(args.loopback)
    status, value, _ = bypass.get_json("/auth/session")
    ok &= check(status == 200 and isinstance(value, dict) and value.get("localBypass"),
                "loopback: local bypass active (OPENCODE_WEB_ALLOW_LOCAL=1)", f"status={status}")
    print("== Stability ==")
    ok &= stability(args.tailscale, MOBILE_UA, seconds=30)

    failed = [label for passed, label in RESULTS if not passed]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    if failed:
        print("Failed checks:")
        for label in failed:
            print(f"  - {label}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
