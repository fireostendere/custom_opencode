"""Domain-neutral tool broker; no engines are started by search or inspect.

Policies and extra manifests are administrator inputs, never tool-call arguments.
RuntimeStore/ArtifactStore are shared implementations, in a separate database so
the model scheduler cannot mistake a CLI job for a queued inference request.
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
import fnmatch
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import time

from jsonschema import Draft202012Validator, FormatChecker
from opentelemetry import metrics, trace

from repo_services import ArtifactStore, safe_repo_file
from runtime_store import RuntimeStore, TERMINAL_STATES

RISKS = ["read", "build", "external-write", "device-read", "device-write", "irreversible"]
MAX_OUTPUT = 48_000
MAX_ARTIFACT = 16_000_000
ID = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$")
SKIP = {".git", "node_modules", ".venv", "venv", ".mcp-artifacts", "__pycache__", "build", "dist"}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode()).hexdigest()


def validate_manifest(row):
    if not isinstance(row, dict) or row.get("schemaVersion") != 1 or not ID.fullmatch(str(row.get("id", ""))):
        raise ValueError("invalid tool manifest identity/version")
    if row.get("kind") not in {"cli", "mcp", "container", "catalog"}:
        raise ValueError("invalid driver kind")
    allowed = {"schemaVersion", "id", "name", "source", "license", "licenseVerified", "kind", "binary", "categories", "markers", "operations", "fallbacks", "os", "arch", "requiredModules", "targets", "runtime", "image"}
    if set(row) - allowed:
        raise ValueError("unknown manifest fields")
    if not all(isinstance(row.get(k), str) and row[k] for k in ("name", "source")):
        raise ValueError("manifest name and source required")
    if not isinstance(row.get("license"), str) or not row["license"].strip():
        raise ValueError("license expression is required")
    # Full SPDX parsing uses the installed packaging library (also an SDK dependency).
    if row["license"] != "NOASSERTION":
        from packaging.licenses import canonicalize_license_expression
        canonicalize_license_expression(row["license"])
    for key in ("categories", "markers", "fallbacks", "os", "arch"):
        if not isinstance(row.get(key, []), list) or not all(isinstance(x, str) for x in row.get(key, [])):
            raise ValueError(f"{key} must be a string list")
    if not isinstance(row.get("operations"), dict):
        raise ValueError("operations must be an object")
    for name, op in row["operations"].items():
        if not isinstance(op, dict) or set(op) - {"argv", "inputSchema", "risk", "network", "cache", "timeoutSeconds", "tool", "upstreamSchemaDigest"}:
            raise ValueError("unknown operation fields")
        if not ID.fullmatch(name) or op.get("risk") not in RISKS or not isinstance(op.get("network"), bool):
            raise ValueError("invalid operation name/risk/network policy")
        if "cache" in op and type(op["cache"]) is not bool:
            raise ValueError("cache must be a boolean")
        Draft202012Validator.check_schema(op["inputSchema"])
        if op["inputSchema"].get("type") != "object" or op["inputSchema"].get("additionalProperties") is not False:
            raise ValueError("operation input must be a closed object schema")
        if not 1 <= op.get("timeoutSeconds", 300) <= 3600:
            raise ValueError("timeout must be between 1 and 3600 seconds")
        if row["kind"] in {"cli", "container"}:
            argv = op.get("argv")
            if not isinstance(argv, list) or not argv or not all(isinstance(x, str) and "\0" not in x for x in argv):
                raise ValueError("argv must be a nonempty string array")
        if row["kind"] == "mcp" and not ID.fullmatch(op.get("tool", "")):
            raise ValueError("MCP operation must pin an upstream tool name")


def validate_policy(config):
    if not isinstance(config, dict) or set(config) - {"tools", "keywords", "defaults", "permissions", "toolPath", "maxParallel"}:
        raise ValueError("unknown operator configuration fields")
    keywords = config.get("keywords", {})
    if not isinstance(keywords, dict) or not all(isinstance(k, str) and k and isinstance(v, str) for k, v in keywords.items()):
        raise ValueError("keywords must map nonempty stems to search terms")
    if not isinstance(config.get("tools", []), list) or not isinstance(config.get("permissions", {}), dict):
        raise ValueError("tools must be a list and permissions an object")
    if type(config.get("maxParallel", 3)) is not int or not 1 <= config.get("maxParallel", 3) <= 3:
        raise ValueError("maxParallel must be 1-3")
    for p in config.get("toolPath", "/usr/local/bin:/usr/bin:/bin").split(os.pathsep):
        if not Path(p).is_absolute():
            raise ValueError("toolPath must contain absolute directories only")
    booleans = {"network", "allowUnreviewedLicense", "trustedHost", "workspaceWrite", "cache"}
    lists = {"risks", "operations", "licenses", "environment", "runtimeRoots", "devicePaths", "devices", "hosts"}
    for policy in [config.get("defaults", {}), *config.get("permissions", {}).values()]:
        if not isinstance(policy, dict) or set(policy) - booleans - lists - {"secrets", "toolchainDigest", "binarySha256", "addressSpaceBytes"}:
            raise ValueError("unknown permission fields")
        address_space = policy.get("addressSpaceBytes", 2_147_483_648)
        if type(address_space) is not int or not 268_435_456 <= address_space <= 4_398_046_511_104:
            raise ValueError("addressSpaceBytes must be 256 MiB to 4 TiB; this limits virtual address space, not resident RAM")
        if any(type(policy[k]) is not bool for k in booleans & policy.keys()):
            raise ValueError("permission switches must be booleans")
        if any(not isinstance(policy[k], list) or not all(isinstance(v, str) for v in policy[k]) for k in lists & policy.keys()):
            raise ValueError("permission lists must contain strings")
        if any(r not in RISKS for r in policy.get("risks", [])):
            raise ValueError("unknown permission risk")
        if not isinstance(policy.get("secrets", {}), dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in policy.get("secrets", {}).items()):
            raise ValueError("secret handles must be a string mapping")
        for key in ("binarySha256", "toolchainDigest"):
            if key in policy and not re.fullmatch(r"[a-f0-9]{64}", policy[key]):
                raise ValueError(f"{key} must be a SHA256 digest")


def load_config(path, workspace):
    """Load explicit private layers, never discover config in a tool's workspace.

    Layers contain manifests/search vocabulary only. Grants stay in the operator
    config; a layer cannot silently widen permissions. Duplicate IDs fail closed.
    """
    roots = (Path(workspace).resolve(), Path(__file__).resolve().parents[1])

    def read_private(filename):
        filename = Path(filename).resolve(strict=True)
        if any(filename.is_relative_to(root) for root in roots):
            raise ValueError("operator config and layers must be outside workspace and application repository")
        if filename.stat().st_size > 2_000_000:
            raise ValueError("private config exceeds 2 MB")
        value = json.loads(filename.read_text())
        if not isinstance(value, dict):
            raise ValueError("private config must be an object")
        return filename, value

    filename, config = read_private(path)
    layers = config.pop("layers", [])
    if not isinstance(layers, list) or len(layers) > 64 or not all(isinstance(p, str) and p for p in layers):
        raise ValueError("layers must be at most 64 explicit file paths")
    validate_policy(config)
    config.setdefault("tools", [])
    config.setdefault("keywords", {})
    for layer in layers:
        _, content = read_private(filename.parent / layer)
        if set(content) - {"tools", "keywords"}:
            raise ValueError("layers may contain only tools and keywords, not permission grants")
        validate_policy(content)
        overlap = config["keywords"].keys() & content.get("keywords", {}).keys()
        if overlap:
            raise ValueError("duplicate layer keyword")
        config["tools"].extend(content.get("tools", []))
        config["keywords"].update(content.get("keywords", {}))
    ids = set()
    for row in config["tools"]:
        validate_manifest(row)
        if row["id"] in ids:
            raise ValueError("duplicate layer tool ID")
        ids.add(row["id"])
    return config


def fingerprint(root: Path):
    """Bounded metadata-only walk, no dependency installs or executable probes."""
    names, truncated = [], False
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in SKIP and not (Path(directory) / d).is_symlink())
        for name in sorted(files):
            path = Path(directory) / name
            if path.is_symlink():
                continue
            names.append(path.relative_to(root).as_posix())
            if len(names) >= 6000:
                truncated = True
                break
        if truncated:
            break
    return {"digest": digest(names), "files": names, "truncated": truncated}


def source_digest(root: Path):
    """Fail closed for caching if the *complete* tree cannot be hashed cheaply."""
    hashed, total, count = hashlib.sha256(), 0, 0
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs.sort()
        if any((Path(directory) / d).is_symlink() for d in dirs):
            return None
        for name in sorted(files):
            path = Path(directory) / name
            if not path.is_file() or path.is_symlink():
                return None
            count += 1
            total += path.stat().st_size
            if count > 20_000 or total > 64_000_000:
                return None
            hashed.update(path.relative_to(root).as_posix().encode())
            hashed.update(b"\0")
            hashed.update(path.read_bytes())
    return hashed.hexdigest()


class Fabric:
    def __init__(self, workspace: str, state_dir: str, config: dict | None = None):
        self.root = Path(workspace).resolve(strict=True)
        self.config = config or {}
        validate_policy(self.config)
        if not self.root.is_dir() or self.root == Path("/") or self.root == Path.home():
            raise ValueError("a specific project directory is required")
        self.state_dir = Path(state_dir).resolve()
        if self.state_dir.is_relative_to(self.root):
            raise ValueError("fabric state/policy must be outside the tool workspace")
        self.rows = {}
        custom_ids = set()
        for row in self.config.get("tools", []):
            validate_manifest(row)
            if row["id"] in custom_ids:
                raise ValueError("duplicate custom tool ID")
            custom_ids.add(row["id"])
            self.rows[row["id"]] = row
        for row in self.rows.values():
            validate_manifest(row)
        for row in self.rows.values():
            if any(id_ not in self.rows for id_ in row.get("fallbacks", [])):
                raise ValueError("fallback references an unknown tool")
        if set(self.config.get("permissions", {})) - self.rows.keys():
            raise ValueError("permissions reference an unknown tool")
        # Separate namespace per project; another project's job IDs grant no access.
        self.store = RuntimeStore(self.state_dir / digest(str(self.root))[:24] / "fabric.sqlite3")
        self.store.initialize()
        self.artifacts = ArtifactStore(self.store)
        self.active = {}
        self.slots = asyncio.Semaphore(min(3, max(1, self.config.get("maxParallel", 3))))
        self.mcp_runner = None
        self.metrics = {"searches": 0, "runs": 0, "cacheHits": 0, "failures": 0}
        meter = metrics.get_meter("custom-opencode.tool-fabric", "1.0.0")
        self.executions = meter.create_counter("fabric.executions")
        self.latency = meter.create_histogram("fabric.duration", unit="s")
        self.lock_file = None

    def start(self):
        # One facade per workspace owns recovery and cancellation. Other instances
        # must not mark live jobs interrupted or race an idempotency key.
        import fcntl
        self.lock_file = open(self.store.paths.root / "owner.lock", "a")
        try:
            fcntl.flock(self.lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.lock_file.close()
            self.lock_file = None
            raise RuntimeError("a tool fabric already owns this workspace")
        for job in self.store.list_tasks(states=["queued", "running"], limit=1000):
            self.store.transition(job["id"], "needs_attention", error="Facade interrupted; execution was not replayed. Inspect artifacts/device before retrying.")

    def _row(self, id_):
        if id_ not in self.rows:
            raise ValueError("unknown toolId")
        return self.rows[id_]

    def _policy(self, id_):
        return {**self.config.get("defaults", {}), **self.config.get("permissions", {}).get(id_, {})}

    def _reason(self, row, op=None):
        policy = self._policy(row["id"])
        if row.get("os") and platform.system().lower() not in row["os"]:
            return "unsupported operating system"
        if row.get("arch") and platform.machine().lower() not in row["arch"]:
            return "unsupported architecture"
        if row["license"] == "NOASSERTION" and not policy.get("allowUnreviewedLicense", False):
            return "license review required"
        allowed = policy.get("licenses")
        if allowed is not None and row["license"] not in allowed:
            return "license not allowed by operator policy"
        if not row["operations"]:
            return "catalog only; configure a driver/operation"
        if op is not None:
            if op["risk"] not in policy.get("risks", ["read", "build"]):
                return "operation risk not authorized by operator policy"
            if op["network"] and not policy.get("network", False):
                return "network not authorized"
            if policy.get("operations") is not None and op not in [row["operations"].get(n) for n in policy["operations"]]:
                return "operation not authorized"
        if row["kind"] == "mcp":
            if not row.get("runtime"):
                return "upstream MCP not configured"
        elif row["kind"] == "container":
            if not re.fullmatch(r"[^\s]+@sha256:[0-9a-f]{64}", row.get("image", "")):
                return "container image must be digest-pinned"
            if not shutil.which("docker"):
                return "docker unavailable"
        elif row["kind"] == "cli":
            binary = row.get("binary") or next(iter(row["operations"].values()))["argv"][0]
            if not self._binary(binary):
                return "executable not installed"
            for module in row.get("requiredModules", []):
                import importlib.util
                if importlib.util.find_spec(module) is None:
                    return f"Python module {module} not installed in facade interpreter"
        if row["kind"] in {"cli", "mcp"} and not policy.get("trustedHost", False) and not shutil.which("bwrap"):
            return "bubblewrap unavailable; no automatic unsandboxed fallback"
        if op is None and row["operations"]:
            reasons = [self._reason(row, item) for item in row["operations"].values()]
            if all(reasons):
                return reasons[0]
        return None

    def _binary(self, name):
        # Do not resolve executables through the project or an inherited PATH.
        path = shutil.which(name, path=self.config.get("toolPath", "/usr/local/bin:/usr/bin:/bin"))
        if not path:
            return None
        resolved = Path(path).resolve()
        if resolved.is_relative_to(self.root):
            return None
        # Keep the invocation path: resolving a venv's python symlink would lose
        # pyvenv.cfg and silently run the system interpreter instead.
        return str(Path(path).absolute())

    def search(self, query="", max_results=8, include_unavailable=False, intent="", target=""):
        if not isinstance(query, str) or len(query) > 4000 or not isinstance(max_results, int) or not 1 <= max_results <= 12:
            raise ValueError("query/maxResults out of bounds")
        started = time.monotonic()
        fp = fingerprint(self.root)
        terms = re.findall(r"[\w.-]+", f"{query} {intent}".casefold())
        terms += [w for stem, expansion in self.config.get("keywords", {}).items() if any(t.startswith(stem.casefold()) for t in terms) for w in expansion.casefold().split()]
        results = []
        # ponytail: bounded lexical ranking; replace only with a measured routing dataset.
        for row in self.rows.values():
            reason = self._reason(row)
            if target and row.get("targets") and target not in row["targets"]:
                continue
            hay = " ".join([row["id"], row["name"], *row["categories"], *row["operations"]]).casefold()
            task_fit = sum(t in hay for t in set(terms))
            evidence = [p for p in fp["files"] if any(fnmatch.fnmatch(p, m) or fnmatch.fnmatch(Path(p).name, m) for m in row["markers"])][:3]
            if terms and not task_fit:
                continue
            if reason and not include_unavailable:
                continue
            key = digest(row)
            hot = any(v[1] == row["id"] and self.store.get_task(id_)["state"] == "running" for id_, v in self.active.items())
            state = "HOT" if hot else "WARM" if self.store.cache_get("fabric-schema", key) else "COLD"
            score = task_fit * 10 + min(3, len(evidence)) * 2 + (0 if reason else 1)
            results.append({"id": row["id"], "name": row["name"], "score": score, "state": state,
                            "available": reason is None, "reason": reason or "driver found and policy eligible; execution not yet verified",
                            "evidence": evidence, "operations": list(row["operations"]), "kind": row["kind"]})
        results.sort(key=lambda r: (-r["score"], r["id"]))
        self.metrics["searches"] += 1
        return {"projectFingerprint": fp["digest"], "scanTruncated": fp["truncated"], "results": results[:max_results],
                "catalogSize": len(self.rows), "elapsedMs": round((time.monotonic() - started) * 1000, 2)}

    def inspect(self, tool_ids):
        if not isinstance(tool_ids, list) or not 1 <= len(tool_ids) <= 5:
            raise ValueError("inspect accepts 1-5 tool IDs")
        result = []
        for id_ in tool_ids:
            row = self._row(id_)
            value = {"id": id_, "name": row["name"], "kind": row["kind"], "source": row["source"],
                     "license": row["license"], "licenseVerified": row.get("licenseVerified", False),
                     "schemaDigest": digest(row), "unavailableReason": self._reason(row),
                     "operations": {name: {"inputSchema": op["inputSchema"], "risk": op["risk"], "network": op["network"],
                                            "unavailableReason": self._reason(row, op)} for name, op in row["operations"].items()},
                     "fallbacks": row.get("fallbacks", [])}
            if len(json.dumps(result + [value])) > MAX_OUTPUT:
                raise ValueError("schema budget exceeded; inspect fewer tools")
            self.store.cache_set("fabric-schema", digest(row), value, ttl_seconds=86400)
            result.append(value)
        return {"tools": result}

    def _arguments(self, op, arguments):
        if not isinstance(arguments, dict) or len(json.dumps(arguments)) > MAX_OUTPUT:
            raise ValueError("arguments must be an object within the 48 KB budget")
        checker = FormatChecker()
        @checker.checks("workspace-file")
        def valid_file(value):
            return isinstance(value, str) and not Path(value).is_absolute() and safe_repo_file(self.root, value) is not None
        Draft202012Validator(op["inputSchema"], format_checker=checker).validate(arguments)
        return arguments

    def _env(self, policy):
        env = {"PATH": self.config.get("toolPath", "/usr/local/bin:/usr/bin:/bin"), "LANG": "C.UTF-8", "CI": "1",
               "HOME": "/tmp/fabric-home", "TMPDIR": "/tmp", "PYTHONDONTWRITEBYTECODE": "1"}
        for name in policy.get("environment", []):
            if not re.fullmatch(r"[A-Z_][A-Z0-9_]*", name):
                raise ValueError("invalid environment name")
            if name.startswith(("LD_", "DYLD_")):
                raise PermissionError("loader injection variables are forbidden")
            if name in os.environ:
                env[name] = os.environ[name]
        for name, reference in policy.get("secrets", {}).items():
            if not re.fullmatch(r"[A-Z_][A-Z0-9_]*", name) or reference not in os.environ:
                raise PermissionError("declared secret handle unavailable")
            if name.startswith(("LD_", "DYLD_")):
                raise PermissionError("loader injection variables are forbidden")
            env[name] = os.environ[reference]
        return env

    def command(self, row, op, arguments, output: Path):
        policy = self._policy(row["id"])
        trusted = bool(policy.get("trustedHost", False))
        work = str(self.root) if trusted else "/workspace"
        out = str(output) if trusted else "/artifacts"
        values = {**arguments, "output": out, "workspace": work}
        props = op["inputSchema"].get("properties", {})
        for name, value in arguments.items():
            spec = props.get(name, {})
            if spec.get("format") == "workspace-file":
                values[name] = str(Path(work) / value)
            if spec.get("type") == "array" and spec.get("items", {}).get("format") == "workspace-file":
                values[name] = [str(Path(work) / v) for v in value]
        argv = []
        for token in op["argv"]:
            value = values.get(token[1:-1]) if token.startswith("{") and token.endswith("}") else None
            if isinstance(value, list):
                argv.extend(value)
            else:
                argv.append(token.format_map(values))
        env = self._env(policy)
        if row["kind"] == "container":
            container_name = "fabric-" + output.name
            cmd = ["docker", "run", "--rm", "--pull=never", "--name", container_name, "--read-only", "--cap-drop=ALL",
                   "--security-opt=no-new-privileges", "--pids-limit=128", "--memory=2g", "--cpus=2", "--user", f"{os.getuid()}:{os.getgid()}",
                   "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m", "--network", "bridge" if op["network"] else "none",
                   "--mount", f"type=bind,src={self.root},dst=/workspace" + ("" if policy.get("workspaceWrite") else ",readonly"),
                   "--mount", f"type=bind,src={output},dst=/artifacts", "--workdir", "/workspace"]
            for name, value in env.items():
                # The image owns executable lookup; the host's PATH can hide its
                # Java/Node/toolchain installation or point to nonexistent paths.
                if name != "PATH":
                    cmd.extend(["--env", f"{name}={value}"])
            return cmd + [row["image"], *argv], env, container_name
        binary = self._binary(argv[0])
        if not binary:
            raise FileNotFoundError("operation executable not installed")
        if policy.get("binarySha256") and hashlib.sha256(Path(binary).read_bytes()).hexdigest() != policy["binarySha256"]:
            raise PermissionError("executable digest changed")
        argv[0] = binary
        if trusted:
            # Explicit operator escape hatch for SDKs/probes that cannot be jailed.
            # It is never selected as an automatic fallback.
            return argv, env, None
        cmd = [shutil.which("bwrap"), "--die-with-parent", "--new-session", "--unshare-all", "--cap-drop", "ALL"]
        if op["network"]:
            cmd.append("--share-net")
        for path in ("/usr", "/bin", "/sbin", "/lib", "/lib64"):
            if Path(path).exists():
                cmd.extend(["--ro-bind", path, path])
        for path in ("/etc/ld.so.cache", "/etc/ssl/certs", "/etc/resolv.conf", "/etc/hosts"):
            if Path(path).exists():
                cmd.extend(["--ro-bind", path, path])
        # Administrator-specified SDK roots; no implicit home or / mount.
        for path in policy.get("runtimeRoots", []):
            p = Path(path).resolve(strict=True)
            if p == Path("/") or p == Path.home():
                raise PermissionError("runtimeRoots must name specific toolchain directories")
            cmd.extend(["--ro-bind", str(p), str(p)])
        cmd.extend(["--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/tmp/fabric-home",
                    "--bind" if policy.get("workspaceWrite") else "--ro-bind", str(self.root), "/workspace",
                    "--bind", str(output), "/artifacts", "--chdir", "/workspace"])
        for device in policy.get("devicePaths", []):
            p = Path(device).resolve(strict=True)
            if not str(p).startswith("/dev/") or p.is_dir():
                raise PermissionError("devicePaths must name individual /dev nodes")
            cmd.extend(["--dev-bind", str(p), str(p)])
        return cmd + ["--", *argv], env, None

    @contextmanager
    def device_lock(self, op, args, policy):
        if not op["risk"].startswith("device") and op["risk"] != "irreversible":
            yield
            return
        import fcntl
        device = args.get("device")
        if not device or device not in policy.get("devices", []):
            raise PermissionError("an exact operator-authorized device identity is required")
        path = self.state_dir / ("device-" + digest(device) + ".lock")
        with path.open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise RuntimeError("device busy")
            yield

    async def run(self, tool_id, operation, arguments=None, dry_run=False, idempotency_key=None):
        if self.lock_file is None:
            raise RuntimeError("fabric.start() required")
        row = self._row(tool_id)
        op = row["operations"].get(operation)
        if op is None:
            raise ValueError("unknown operation; use catalog.inspect")
        if type(dry_run) is not bool:
            raise ValueError("dryRun must be a boolean")
        arguments = self._arguments(op, {} if arguments is None else arguments)
        reason = self._reason(row, op)
        policy = self._policy(tool_id)
        if policy.get("operations") is not None and operation not in policy["operations"]:
            reason = "operation not authorized"
        if (op["risk"].startswith("device") or op["risk"] == "irreversible") and arguments.get("device") not in policy.get("devices", []):
            reason = "exact device identity not authorized"
        if dry_run:
            return {"dryRun": True, "toolId": tool_id, "operation": operation, "risk": op["risk"], "network": op["network"],
                    "allowed": reason is None, "reason": reason, "schemaDigest": digest(row)}
        if reason:
            raise PermissionError(reason)
        if op["risk"].startswith("device") or op["risk"] == "irreversible":
            if arguments.get("device") not in policy.get("devices", []):
                raise PermissionError("exact device identity not authorized")
        signature = digest([tool_id, operation, arguments, digest(row), policy])
        if idempotency_key is not None:
            if not isinstance(idempotency_key, str) or not 1 <= len(idempotency_key) <= 128:
                raise ValueError("invalid idempotencyKey")
            previous = self.store.cache_get("fabric-idempotency", idempotency_key)
            if previous:
                if previous["signature"] != signature:
                    raise ValueError("idempotencyKey reused for a different request")
                return self.status(previous["jobId"])
        if len(self.active) >= 32:
            raise RuntimeError("job queue full")
        negative = self.store.cache_get("fabric-negative", signature)
        if negative:
            raise RuntimeError(negative)
        job = self.store.create_task(session_id="tool-fabric", project_dir=str(self.root), kind="tool-fabric",
                                     text=f"{tool_id}.{operation}", metadata={"toolId": tool_id, "operation": operation, "signature": signature})
        if idempotency_key:
            self.store.cache_set("fabric-idempotency", idempotency_key, {"signature": signature, "jobId": job["id"]})
        task = asyncio.create_task(self._execute(job["id"], row, op, arguments, signature))
        self.active[job["id"]] = (task, tool_id)
        task.add_done_callback(lambda _: self.active.pop(job["id"], None))
        self.metrics["runs"] += 1
        return self.status(job["id"])

    async def _execute(self, job_id, row, op, args, signature):
        started = time.monotonic()
        span = trace.get_tracer("custom-opencode.tool-fabric").start_span("fabric.execute", attributes={"fabric.job_id": job_id, "fabric.tool_id": row["id"], "fabric.risk": op["risk"]})
        output = self.store.paths.root / "work" / job_id
        try:
            output.mkdir(parents=True, mode=0o700)
            async with self.slots:
                self.store.transition(job_id, "running", event="fabric.started", data={"toolId": row["id"]})
                policy = self._policy(row["id"])
                with self.device_lock(op, args, policy):
                    cache_key = None
                    tree = None
                    if op.get("cache") and policy.get("cache", False) and policy.get("toolchainDigest") and not policy.get("workspaceWrite") and not op["network"] and op["risk"] in {"read", "build"}:
                        tree = await asyncio.to_thread(source_digest, self.root)
                        if tree:
                            binary = self._binary(op["argv"][0])
                            binary_hash = hashlib.sha256(Path(binary).read_bytes()).hexdigest() if binary else row.get("image")
                            cache_key = digest([signature, tree, binary_hash, self._env(policy), platform.platform()])
                            cached = self.store.cache_get("fabric-results", cache_key)
                            if cached and self._cache_valid(cached):
                                self.store.cache_set("fabric-result", job_id, {**cached, "cacheHit": True})
                                self.store.transition(job_id, "completed", event="fabric.cache_hit")
                                self.metrics["cacheHits"] += 1
                                return
                    async with asyncio.timeout(op.get("timeoutSeconds", 300)):
                        if row["kind"] == "mcp":
                            if self.mcp_runner is None:
                                raise RuntimeError("MCP driver unavailable")
                            result = await self.mcp_runner(row, op, args, output)
                        else:
                            result = await self._process(row, op, args, output)
                    artifacts = self._collect(job_id, output)
                    result.update({"artifacts": artifacts, "schemaDigest": digest(row), "cacheHit": False})
                    self.store.cache_set("fabric-result", job_id, result)
                    ok = result.get("exitCode", 1) == 0 and not result.get("isError")
                    self.store.transition(job_id, "completed" if ok else "failed", event="fabric.finished",
                                          data={"exitCode": result.get("exitCode"), "artifactCount": len(artifacts)})
                    if ok and cache_key and tree == await asyncio.to_thread(source_digest, self.root):
                        self.store.cache_set("fabric-results", cache_key, result, ttl_seconds=86400)
                    if not ok:
                        self.metrics["failures"] += 1
        except asyncio.CancelledError:
            self.store.transition(job_id, "cancelled", event="fabric.cancelled", error="Cancelled; side effects may have occurred. No automatic replay.")
            raise
        except Exception as exc:
            # Exception text from an upstream may contain secrets. Store a category.
            category = type(exc).__name__
            self.metrics["failures"] += 1
            self.store.cache_set("fabric-negative", signature, f"last attempt failed ({category}); retry after 30 seconds", ttl_seconds=30)
            self.store.transition(job_id, "failed", event="fabric.failed", error=f"{category}; inspect bounded output/artifacts. No automatic retry.")
        finally:
            state = self.status(job_id)["state"]
            labels = {"fabric.tool_id": row["id"], "fabric.state": state}
            self.executions.add(1, labels)
            self.latency.record(time.monotonic() - started, labels)
            span.set_attribute("fabric.state", state)
            span.end()

    async def _process(self, row, op, args, output):
        argv, env, container = self.command(row, op, args, output)
        if not container:
            argv = self.limit_command(argv, op, self._policy(row["id"]))
        proc = await asyncio.create_subprocess_exec(*argv, cwd=self.root, env=env, stdin=asyncio.subprocess.DEVNULL,
                                                     stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True)
        async def drain(stream):
            chunks, size, truncated = [], 0, False
            while chunk := await stream.read(8192):
                remaining = MAX_OUTPUT - size
                if remaining > 0:
                    chunks.append(chunk[:remaining])
                    size += min(remaining, len(chunk))
                if len(chunk) > remaining:
                    truncated = True
            return b"".join(chunks).decode("utf-8", errors="replace"), truncated
        readers = [asyncio.create_task(drain(proc.stdout)), asyncio.create_task(drain(proc.stderr))]
        try:
            await proc.wait()
            values = await asyncio.gather(*readers)
            return {"exitCode": proc.returncode, "stdout": self._redact(values[0][0], row), "stderr": self._redact(values[1][0], row),
                    "outputTruncated": any(v[1] for v in values)}
        finally:
            # Kill descendants even if the leader exited while pipes remain open.
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            if container:
                stop = await asyncio.create_subprocess_exec("docker", "rm", "-f", container, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                try:
                    await asyncio.wait_for(stop.wait(), 5)
                except TimeoutError:
                    stop.kill()
                    await stop.wait()
            await proc.wait()
            for task in readers:
                task.cancel()
            await asyncio.gather(*readers, return_exceptions=True)

    @staticmethod
    def limit_command(argv, op, policy=None):
        limiter = shutil.which("prlimit")
        if not limiter:
            raise RuntimeError("prlimit required for bounded local tool execution")
        address_space = (policy or {}).get("addressSpaceBytes", 2_147_483_648)
        return [limiter, f"--as={address_space}", "--fsize=67108864", "--nofile=1024", f"--cpu={op.get('timeoutSeconds', 300)}", "--", *argv]

    def _redact(self, text, row):
        for ref in self._policy(row["id"]).get("secrets", {}).values():
            value = os.environ.get(ref)
            if value:
                text = text.replace(value, "[REDACTED]")
        return text

    def _collect(self, job_id, output):
        rows, total = [], 0
        for directory, dirs, files in os.walk(output, followlinks=False):
            dirs[:] = [d for d in dirs if not (Path(directory) / d).is_symlink()]
            for name in sorted(files):
                path = safe_repo_file(output, str((Path(directory) / name).relative_to(output)))
                if path is None:
                    continue
                size = path.stat().st_size
                if len(rows) >= 32 or size > MAX_ARTIFACT or total + size > 64_000_000:
                    continue
                data = path.read_bytes()
                total += len(data)
                artifact = self.artifacts.put(task_id=job_id, project_dir=str(self.root), kind="tool-fabric",
                                              title=str(path.relative_to(output)), content=data, mime="application/octet-stream")
                artifact["uri"] = f"artifact://{artifact['id']}"
                rows.append(artifact)
        return rows

    def _cache_valid(self, result):
        for ref in result.get("artifacts", []):
            value = self.artifacts.get(ref["id"], limit=1)
            if not value or value["sha256"] != ref["sha256"]:
                return False
            with self.store.connect() as db:
                row = db.execute("SELECT file_path FROM artifacts WHERE id=?", (ref["id"],)).fetchone()
            if row and row["file_path"]:
                path = Path(row["file_path"])
                if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != ref["sha256"]:
                    return False
        return True

    def status(self, job_id):
        job = self.store.get_task(job_id)
        if not job or job["project_dir"] != str(self.root) or job["kind"] != "tool-fabric":
            raise ValueError("unknown jobId")
        return {"jobId": job_id, "state": job["state"], "toolId": job["metadata"]["toolId"], "operation": job["metadata"]["operation"],
                "createdAt": job["created_at"], "updatedAt": job["updated_at"], "error": job["last_error"],
                "result": self.store.cache_get("fabric-result", job_id)}

    async def cancel(self, job_id):
        self.status(job_id)
        value = self.active.get(job_id)
        if value:
            value[0].cancel()
            await asyncio.gather(value[0], return_exceptions=True)
            # A task cancelled before its first instruction never enters finally.
            if self.status(job_id)["state"] not in TERMINAL_STATES:
                self.store.transition(job_id, "cancelled", event="fabric.cancelled")
        return self.status(job_id)

    async def close(self):
        for id_ in list(self.active):
            await self.cancel(id_)
        if self.lock_file:
            self.lock_file.close()
            self.lock_file = None
