#!/usr/bin/env python3
"""Web server extensions: provider rate-limit snapshots for the OpenCode web UI."""

from __future__ import annotations

import json
import os
import re
import selectors
import shutil
import signal
import subprocess
import threading
import time
from urllib.parse import urlsplit

import server as base


QWEN_FIVE_HOUR_LIMIT = 12_000
QWEN_SEVEN_DAY_LIMIT = 40_000
GEMINI_TPM_LIMIT = 2_000_000
GEMINI_RPM_LIMIT = 1_000
GEMINI_RPD_LIMIT = 4_000_000
QWEN_SUFFIX_RE = re.compile(r"\s·\sQwen\s+(OK|exhausted→([^·]+))\s*$")
try:
    LIMITS_CACHE_SECONDS = max(10.0, float(base.setting("OPENCODE_LIMITS_CACHE_SECONDS", "60") or "60"))
except ValueError:
    LIMITS_CACHE_SECONDS = 60.0

_codex_cache: dict[str, object] = {"at": 0.0, "value": None}
_codex_last_good: dict[str, object] = {"value": None}
_bailian_cache: dict[str, object] = {"at": 0.0, "value": None}
_codex_binary: dict[str, object] = {"at": 0.0, "key": None, "path": None}
_SETUP_REASONS = {"codex-not-found", "codex-auth-required", "bailian-cli-not-found", "session-expired", "disabled"}
LIMITS_SETUP_RETRY_SECONDS = 1800.0
BINARY_RESOLVE_SECONDS = 600.0
_VERSION_RE = re.compile(r"(\d+)\.(\d+)\.(\d+)")
# Provider CLIs need their own login state, never the web/backend secrets that
# live in this process' environment.
_CHILD_ENV_KEYS = {
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TZ", "TMPDIR",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "CODEX_HOME",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
    "WSL_DISTRO_NAME", "WSL_INTEROP", "GIT_TERMINAL_PROMPT",
}


def _child_env(binary: str | None = None) -> dict[str, str]:
    env = {
        key: value
        for key, value in os.environ.items()
        # GIT_CONFIG_*: keep server.py's git hardening (fsmonitor/hooks off)
        # for any git the CLIs run.
        if key in _CHILD_ENV_KEYS or key.startswith(("LC_", "BAILIAN_", "BL_", "GIT_CONFIG_"))
    }
    if binary:
        # npm-installed CLIs are "#!/usr/bin/env node" scripts: run them with the
        # node that sits next to them (nvm), not an older system node.
        env["PATH"] = os.pathsep.join(filter(None, [os.path.dirname(binary), env.get("PATH", "")]))
    return env


def _neutral_cwd() -> str:
    """Run provider CLIs outside the (agent-writable) repository."""
    home = base.Path.home()
    return str(home) if home.is_dir() else "/"


def _user_binary_candidates(executable: str) -> list[str]:
    home = base.Path.home()
    candidates = [shutil.which(executable)]
    candidates += [
        str(home / f"{directory}/{executable}")
        for directory in (".local/bin", ".npm-global/bin", ".bun/bin", "bin")
    ]
    candidates += [str(path) for path in sorted((home / ".nvm/versions/node").glob(f"*/bin/{executable}"), reverse=True)]
    unique: list[str] = []
    seen: set[str] = set()
    for candidate in candidates:
        if not candidate or not os.path.isfile(candidate) or not os.access(candidate, os.X_OK):
            continue
        real = os.path.realpath(candidate)
        if real not in seen:
            seen.add(real)
            unique.append(candidate)
    return unique


def _resolve_user_binary(setting_name: str, executable: str) -> str | None:
    configured = base.setting(setting_name)
    if configured:
        return configured
    candidates = _user_binary_candidates(executable)
    return candidates[0] if candidates else None


def _binary_version(path: str) -> tuple[int, ...]:
    try:
        result = subprocess.run(
            [path, "--version"], capture_output=True, text=True, timeout=10.0,
            env=_child_env(path), check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ()
    match = _VERSION_RE.search(result.stdout or "")
    return tuple(int(part) for part in match.groups()) if match else ()


def _resolve_codex_binary() -> str | None:
    """Newest installed Codex CLI unless CODEX_BIN pins one.

    A systemd PATH used to find an ancient /usr/local/bin/codex first, whose
    usage decoder rejects newer ChatGPT plan types, so the web lost its limits.
    """
    configured = base.setting("CODEX_BIN")
    if configured:
        return configured
    candidates = _user_binary_candidates("codex")
    key = tuple(candidates)
    now = time.monotonic()
    if _codex_binary.get("key") == key and now - float(_codex_binary.get("at") or 0.0) < BINARY_RESOLVE_SECONDS:
        return _codex_binary.get("path")  # type: ignore[return-value]
    best = max(candidates, key=lambda path: (_binary_version(path), -candidates.index(path)), default=None)
    _codex_binary.update(at=now, key=key, path=best)
    return best


class _StaleWhileRevalidate:
    """Serve the last snapshot at once and refresh expired ones in the background.

    Provider CLIs take seconds to answer; the limits endpoint must not block a
    page render on them after the first successful read.
    """

    def __init__(self, cache: dict[str, object], loader) -> None:
        self.cache = cache
        self.loader = loader
        self.lock = threading.Lock()
        self.refresh_lock = threading.Lock()
        self.refreshing = False

    def _fresh(self) -> dict[str, object] | None:
        value = self.cache.get("value")
        if not isinstance(value, dict):
            return None
        # A missing CLI or an expired login does not fix itself within a
        # minute: re-check rarely instead of spawning the CLI on every poll.
        ttl = LIMITS_CACHE_SECONDS
        if not value.get("available") and value.get("reason") in _SETUP_REASONS:
            ttl = max(ttl, LIMITS_SETUP_RETRY_SECONDS)
        if time.monotonic() - float(self.cache.get("at") or 0.0) < ttl:
            return value
        return None

    def get(self) -> dict[str, object]:
        with self.lock:
            fresh = self._fresh()
            if fresh is not None:
                return fresh
            stale = self.cache.get("value")
            if isinstance(stale, dict):
                if not self.refreshing:
                    self.refreshing = True
                    threading.Thread(target=self._background, daemon=True).start()
                return stale
        return self.refresh()

    def _background(self) -> None:
        try:
            self.refresh()
        finally:
            with self.lock:
                self.refreshing = False

    def refresh(self) -> dict[str, object]:
        with self.refresh_lock:
            with self.lock:
                fresh = self._fresh()
            if fresh is not None:
                return fresh
            value = self.loader()
            with self.lock:
                self.cache.update(at=time.monotonic(), value=value)
            return value


def _terminate_group(process: subprocess.Popen[str]) -> None:
    """Stop a CLI and its children (the npm launcher spawns a native binary)."""
    for sig, wait in ((signal.SIGTERM, 1.0), (signal.SIGKILL, 1.0)):
        try:
            os.killpg(process.pid, sig)
        except (ProcessLookupError, PermissionError):
            return
        try:
            process.wait(timeout=wait)
            return
        except subprocess.TimeoutExpired:
            continue


def _rpc_write(process: subprocess.Popen[str], payload: dict[str, object]) -> None:
    if process.stdin is None:
        raise RuntimeError("Codex app-server stdin is unavailable")
    process.stdin.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
    process.stdin.flush()


def _rpc_wait(process: subprocess.Popen[str], request_id: int, timeout: float) -> object:
    if process.stdout is None:
        raise RuntimeError("Codex app-server stdout is unavailable")
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    deadline = time.monotonic() + timeout
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Codex app-server response timeout")
            events = selector.select(remaining)
            if not events:
                raise TimeoutError("Codex app-server response timeout")
            line = process.stdout.readline()
            if not line:
                code = process.poll()
                raise RuntimeError(f"Codex app-server exited before response ({code})")
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if payload.get("id") != request_id:
                continue
            if "error" in payload:
                error = payload.get("error") or {}
                message = error.get("message") if isinstance(error, dict) else str(error)
                raise RuntimeError(str(message or "Codex app-server RPC failed"))
            return payload.get("result")
    finally:
        selector.close()


def _normalize_window(value: object) -> dict[str, object] | None:
    if not isinstance(value, dict):
        return None
    used = value.get("usedPercent")
    if not isinstance(used, (int, float)):
        return None
    used_percent = min(100, max(0, int(round(float(used)))))
    duration = value.get("windowDurationMins")
    reset_at = value.get("resetsAt")
    return {
        "usedPercent": used_percent,
        "remainingPercent": 100 - used_percent,
        "windowDurationMins": int(duration) if isinstance(duration, (int, float)) else None,
        "resetsAt": int(reset_at) if isinstance(reset_at, (int, float)) else None,
    }


def _normalize_codex_result(result: object) -> dict[str, object]:
    if not isinstance(result, dict):
        return {"available": False, "reason": "invalid-response"}
    by_id = result.get("rateLimitsByLimitId")
    snapshot = None
    if isinstance(by_id, dict):
        snapshot = by_id.get("codex")
        if not isinstance(snapshot, dict) and by_id:
            snapshot = next((item for item in by_id.values() if isinstance(item, dict)), None)
    if not isinstance(snapshot, dict):
        candidate = result.get("rateLimits")
        snapshot = candidate if isinstance(candidate, dict) else None
    if not isinstance(snapshot, dict):
        return {"available": False, "reason": "no-rate-limit-snapshot"}
    return {
        "available": True,
        "planType": snapshot.get("planType"),
        "limitId": snapshot.get("limitId") or "codex",
        "limitName": snapshot.get("limitName") or "Codex",
        "primary": _normalize_window(snapshot.get("primary")),
        "secondary": _normalize_window(snapshot.get("secondary")),
        "credits": snapshot.get("credits") if isinstance(snapshot.get("credits"), dict) else None,
        "rateLimitReachedType": snapshot.get("rateLimitReachedType"),
        "spendControlReached": snapshot.get("spendControlReached"),
    }


def _read_codex_rate_limits(process: subprocess.Popen[str]) -> dict[str, object]:
    _rpc_write(process, {"method": "account/rateLimits/read", "id": 3, "params": {}})
    return _normalize_codex_result(_rpc_wait(process, 3, 10.0))


def _load_codex_rate_limits() -> dict[str, object]:
    codex = _resolve_codex_binary()
    if not codex:
        return {"available": False, "reason": "codex-not-found"}
    process: subprocess.Popen[str] | None = None
    try:
        process = subprocess.Popen(
            [codex, "app-server"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
            env=_child_env(codex),
            cwd=_neutral_cwd(),
            start_new_session=True,
        )
        _rpc_write(process, {
            "method": "initialize",
            "id": 1,
            "params": {
                "clientInfo": {
                    "name": "custom_opencode_web",
                    "title": "custom_opencode web limits",
                    "version": "1",
                }
            },
        })
        _rpc_wait(process, 1, 5.0)
        _rpc_write(process, {"method": "initialized", "params": {}})
        try:
            value = _read_codex_rate_limits(process)
        except (RuntimeError, TimeoutError):
            value = {"available": False, "reason": "codex-rate-limits-unavailable"}
        if value.get("available") is not True:
            # Refresh ChatGPT auth only after a failed read: forcing a token
            # refresh on every poll races the user's own Codex sessions.
            account: object = None
            try:
                _rpc_write(process, {"method": "account/read", "id": 2, "params": {"refreshToken": True}})
                account = _rpc_wait(process, 2, 10.0)
            except (RuntimeError, TimeoutError):
                account = None
            if isinstance(account, dict) and account.get("requiresOpenaiAuth") is True and not account.get("account"):
                value = {"available": False, "reason": "codex-auth-required"}
            else:
                try:
                    value = _read_codex_rate_limits(process)
                except (RuntimeError, TimeoutError):
                    value = {"available": False, "reason": "codex-rate-limits-unavailable"}
    except (OSError, RuntimeError, TimeoutError):
        value = {"available": False, "reason": "codex-rate-limits-unavailable"}
    finally:
        if process is not None:
            _terminate_group(process)

    if value.get("available") is True:
        value["capturedAt"] = int(time.time())
        value.pop("stale", None)
        value.pop("liveReason", None)
        _codex_last_good["value"] = dict(value)
    else:
        last_good = _codex_last_good.get("value")
        if isinstance(last_good, dict):
            value = {
                **last_good,
                "stale": True,
                "liveReason": value.get("reason"),
            }
    return value


_codex_limits = _StaleWhileRevalidate(_codex_cache, _load_codex_rate_limits)


def query_codex_rate_limits() -> dict[str, object]:
    return _codex_limits.get()


def _bailian_window(ratio: object, reset_time_ms: object, limit: int, minutes: int) -> dict[str, object] | None:
    if not isinstance(ratio, (int, float)):
        return None
    used_ratio = min(1.0, max(0.0, float(ratio)))
    used_percent = round(used_ratio * 100, 1)
    remaining_percent = round((1.0 - used_ratio) * 100, 1)
    reset_seconds = None
    if isinstance(reset_time_ms, (int, float)):
        # Bailian CLI Token Plan reset times are epoch milliseconds.
        reset_seconds = int(float(reset_time_ms) / 1000)
    return {
        "limit": limit,
        "usedCredits": int(round(limit * used_ratio)),
        "remainingCredits": int(round(limit * (1.0 - used_ratio))),
        "usedPercent": used_percent,
        "remainingPercent": remaining_percent,
        "windowDurationMins": minutes,
        "resetsAt": reset_seconds,
    }


def qwen_limits_enabled() -> bool:
    """OPENCODE_LIMITS_QWEN=0 hides Qwen/Token Plan limits (e.g. no subscription)."""
    off = {"0", "off", "false", "no"}
    if str(base.setting("OPENCODE_ALIBABA_ENABLED", "1") or "1").strip().lower() in off:
        return False
    return str(base.setting("OPENCODE_LIMITS_QWEN", "1") or "1").strip().lower() not in off


def _load_bailian_token_plan() -> dict[str, object]:
        if not qwen_limits_enabled():
            return {"available": False, "reason": "disabled"}
        bailian = _resolve_user_binary("BAILIAN_CLI_BIN", "bl")
        if not bailian:
            return {"available": False, "reason": "bailian-cli-not-found"}

        try:
            result = subprocess.run(
                [bailian, "usage", "token-plan", "--output", "json"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                timeout=12.0,
                check=False,
                env=_child_env(bailian),
                cwd=_neutral_cwd(),
            )
            if result.returncode != 0:
                try:
                    payload = json.loads(result.stdout)
                    if isinstance(payload, dict):
                        err = payload.get("error")
                        if isinstance(err, dict):
                            code = err.get("code")
                            msg = str(err.get("message") or "")
                            if code == 3 or "expired" in msg.lower() or "not logged in" in msg.lower():
                                return {
                                    "available": False,
                                    "state": "expired",
                                    "reason": "session-expired",
                                    "hint": err.get("hint") or "bl auth login --console",
                                }
                except Exception:
                    pass
                raise RuntimeError("Bailian Token Plan usage command failed")
            payload = json.loads(result.stdout)
            if not isinstance(payload, dict):
                raise RuntimeError("Invalid Bailian Token Plan usage response")
            five_hour = _bailian_window(
                payload.get("per5HourPercentage"),
                payload.get("per5HourResetTime"),
                QWEN_FIVE_HOUR_LIMIT,
                300,
            )
            seven_day = _bailian_window(
                payload.get("per1WeekPercentage"),
                payload.get("per1WeekResetTime"),
                QWEN_SEVEN_DAY_LIMIT,
                10_080,
            )
            if five_hour is None and seven_day is None:
                raise RuntimeError("Bailian Token Plan usage windows missing")
            value = {
                "available": True,
                "source": "bailian-cli",
                "fiveHour": five_hour or {"limit": QWEN_FIVE_HOUR_LIMIT, "windowDurationMins": 300},
                "sevenDay": seven_day or {"limit": QWEN_SEVEN_DAY_LIMIT, "windowDurationMins": 10_080},
            }
        except (OSError, RuntimeError, subprocess.TimeoutExpired, json.JSONDecodeError):
            value = {"available": False, "reason": "bailian-token-plan-usage-unavailable"}
        return value


_bailian_limits = _StaleWhileRevalidate(_bailian_cache, _load_bailian_token_plan)


def query_bailian_token_plan() -> dict[str, object]:
    return _bailian_limits.get()


def _qwen_probe_status() -> tuple[str, str | None]:
    payload = base.backend_json("GET", "/api/session?limit=100&order=desc")
    if isinstance(payload, dict) and isinstance(payload.get("data"), list):
        sessions = payload["data"]
    elif isinstance(payload, list):
        sessions = payload
    else:
        sessions = []

    for session in sessions:
        if not isinstance(session, dict):
            continue
        title = session.get("title")
        if not isinstance(title, str):
            continue
        match = QWEN_SUFFIX_RE.search(title)
        if not match:
            continue
        if match.group(1) == "OK":
            return "ok", None
        return "exhausted", (match.group(2) or "").strip() or None
    return "unknown", None


def query_qwen_status() -> dict[str, object]:
    if not qwen_limits_enabled():
        return {"available": False, "state": "disabled", "reason": "disabled"}
    usage = query_bailian_token_plan()
    probe_state, probe_reset = _qwen_probe_status()
    if usage.get("available"):
        five_hour = usage.get("fiveHour") if isinstance(usage.get("fiveHour"), dict) else {}
        seven_day = usage.get("sevenDay") if isinstance(usage.get("sevenDay"), dict) else {}
        remaining = [
            window.get("remainingPercent")
            for window in (five_hour, seven_day)
            if isinstance(window.get("remainingPercent"), (int, float))
        ]
        # Live Token Plan usage is authoritative; title probes can be stale on old sessions.
        state = "exhausted" if remaining and min(remaining) <= 0 else ("ok" if remaining else probe_state)
        return {
            **usage,
            "state": state,
            "resetAt": probe_reset if state == "exhausted" else None,
        }

    is_expired = usage.get("state") == "expired" or usage.get("reason") == "session-expired"
    return {
        "available": False if is_expired else (probe_state != "unknown"),
        "source": "bailian-cli" if is_expired else "probe",
        "reason": usage.get("reason"),
        "state": "expired" if is_expired else probe_state,
        "resetAt": probe_reset,
        "hint": usage.get("hint"),
        "fiveHour": {"limit": QWEN_FIVE_HOUR_LIMIT, "windowDurationMins": 300},
        "sevenDay": {"limit": QWEN_SEVEN_DAY_LIMIT, "windowDurationMins": 10_080},
    }


def query_gemini_status() -> dict[str, object]:
    has_key = bool(
        base.setting("GEMINI_API_KEY")
        or base.setting("GOOGLE_API_KEY")
    )
    if not has_key:
        auth_file = base.Path.home() / ".local/share/opencode/auth.json"
        if auth_file.is_file():
            try:
                data = json.loads(auth_file.read_text(encoding="utf-8"))
                if isinstance(data, dict) and "google" in data:
                    has_key = True
            except Exception:
                pass

    if not has_key:
        return {"available": False, "reason": "key-not-found"}

    state_file = base.Path.home() / ".local/state/custom-opencode/rate-limit.json"
    rl_data: dict[str, object] = {}
    if state_file.is_file():
        try:
            loaded = json.loads(state_file.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                rl_data = loaded
        except Exception:
            pass

    is_rate_limited = bool(rl_data.get("active"))
    def nonnegative_int(value: object) -> int:
        try: return max(0,int(value or 0))
        except (TypeError,ValueError,OverflowError): return 0
    seconds = nonnegative_int(rl_data.get("seconds"))
    until = rl_data.get("until")
    now_ts = int(time.time())
    try: resets_at = int(float(until) / 1000) if isinstance(until, (int, float)) else (now_ts + seconds if is_rate_limited else None)
    except (ValueError,OverflowError): resets_at = now_ts + seconds if is_rate_limited else None

    usage = rl_data.get("usage") if isinstance(rl_data.get("usage"), dict) else {}
    limits = rl_data.get("limits") if isinstance(rl_data.get("limits"), dict) else {}
    def positive_limit(name: str, fallback: int) -> int:
        try: value = int(limits.get(name) or fallback)
        except (TypeError, ValueError, OverflowError): value = fallback
        return value if value > 0 else fallback
    tpm_limit=positive_limit("tpm",GEMINI_TPM_LIMIT); rpm_limit=positive_limit("rpm",GEMINI_RPM_LIMIT); rpd_limit=positive_limit("rpd",GEMINI_RPD_LIMIT)
    limited_bucket = str(rl_data.get("limitedBucket") or "tpm")
    used_tokens = tpm_limit if is_rate_limited and limited_bucket == "tpm" else nonnegative_int(usage.get("tokensLastMinute"))
    used_requests = rpm_limit if is_rate_limited and limited_bucket == "rpm" else nonnegative_int(usage.get("requestsLastMinute"))
    daily_requests = rpd_limit if is_rate_limited and limited_bucket == "rpd" else nonnegative_int(usage.get("requestsToday"))

    used_pct_tokens = round(min(100.0, (used_tokens / tpm_limit) * 100.0), 1)
    used_pct_requests = round(min(100.0, (used_requests / rpm_limit) * 100.0), 1)
    used_pct_daily = round(min(100.0, (daily_requests / rpd_limit) * 100.0), 1)

    return {
        "available": True,
        "planType": "Pay-as-you-go (Standard)",
        "state": "exhausted" if is_rate_limited else "ok",
        "rateLimited": is_rate_limited,
        "seconds": seconds if is_rate_limited else 0,
        "resetAt": resets_at,
        "minuteTokens": {
            "limit": tpm_limit,
            "usedCredits": used_tokens,
            "remainingCredits": max(0, tpm_limit - used_tokens),
            "usedPercent": used_pct_tokens,
            "remainingPercent": max(0.0, round(100.0 - used_pct_tokens, 1)),
            "windowDurationMins": 1,
            "resetsAt": resets_at if is_rate_limited else None,
        },
        "minuteRequests": {
            "limit": rpm_limit,
            "usedCredits": used_requests,
            "remainingCredits": max(0, rpm_limit - used_requests),
            "usedPercent": used_pct_requests,
            "remainingPercent": max(0.0, round(100.0 - used_pct_requests, 1)),
            "windowDurationMins": 1,
            "resetsAt": resets_at if is_rate_limited else None,
        },
        "dailyRequests": {
            "limit": rpd_limit,
            "usedCredits": daily_requests,
            "remainingCredits": max(0, rpd_limit - daily_requests),
            "usedPercent": used_pct_daily,
            "remainingPercent": max(0.0, round(100.0 - used_pct_daily, 1)),
            "windowDurationMins": 1440,
            "resetsAt": None,
        },
        "note": "Google AI Studio · Pay-as-you-go (2M TPM / 1K RPM)",
    }


def limits_snapshot() -> dict[str, object]:
    return {
        "generatedAt": int(time.time()),
        "qwen": query_qwen_status(),
        "openai": query_codex_rate_limits(),
        "gemini": query_gemini_status(),
    }


class Handler(base.Handler):
    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path == "/client-limits.json":
            if not self.authenticated():
                self.unauthorized()
                return
            self.json_response(limits_snapshot())
            return
        super().do_GET()


def main() -> None:
    base.SCRATCH_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    server = base.ThreadingHTTPServer((base.WEB_HOST, base.WEB_PORT), Handler)
    print(f"OpenCode web client started on configured port {base.WEB_PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
