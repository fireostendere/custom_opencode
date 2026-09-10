# Universal Tool Fabric

Tool Fabric is an optional workspace-scoped, domain-neutral MCP facade. Its default
catalog is empty. The public repository contains the mechanism and its test harness,
not an operator's tools, boards, accounts, endpoints, credentials or workflows.
Backend, frontend, hardware, data analysis, or any other domain are private data
layers using the same manifest contract, not branches in the broker implementation.
Discovery starts no tool processes. Entries without operations are **catalog only**.

## Public mechanism, private layers

Keep the operator configuration and layer files outside both this repository and
every workspace supplied to tools. The loader rejects in-tree files, including
symlinks pointing into a workspace. Layers are explicitly selected, never discovered
from untrusted project files. Do not copy private configurations into `config/`,
fixtures, documentation, or Git. `.private/` is ignored for local reference material,
but it is not an allowed location for active policy or layers.

For example, an external `tool-fabric.json` can select any layers you define:

```json
{
  "layers": ["layers/backend.json", "layers/frontend.json", "layers/my-tools.json"],
  "defaults": {"risks": ["read", "build"], "network": false},
  "permissions": {}
}
```

Paths are relative to the operator config (absolute paths also work). Each layer
contains `{"tools": [...], "keywords": {"провер": "lint test"}}`. `tools` contains
the complete manifests described below; `keywords` optionally supplies private
search vocabulary. Layer names and categories are arbitrary. Duplicate tool IDs or
keyword stems are rejected rather than silently overridden. Layers cannot contain
permission grants; those belong exclusively to the operator config. Inline `tools`
and `keywords` in the operator config also work. No config means no enabled tools.

The old engineering catalog is retained only as an ignored local reference under
`.private/tool-fabric/legacy_catalog.py`; it is not shipped or imported. No user's
actual device configuration is generated, migrated, or published automatically.

The external tool list is stable:

1. `catalog.search`: at most 12 compact candidates, deterministic task/filename ranking.
2. `catalog.inspect`: at most 5 tools' input schemas, availability and policy reasons.
3. `tool.run`: validated arguments, optional dry run, durable job handle.
4. `job.status`: state, bounded stdout/stderr, content-addressed artifact metadata.
5. `job.cancel`: cancellation of queued/running work, including subprocess cleanup.

`fabric://status` exposes counters; `artifact://{id}` exposes a bounded artifact
slice as JSON/base64, never executable report HTML. The facade uses the official
[Python MCP SDK](https://github.com/modelcontextprotocol/python-sdk) for modern and
legacy protocol negotiation, rather than hand-coding a protocol version.
See the [MCP specification](https://modelcontextprotocol.io/specification/latest).

## Install and connect

Supported execution host: Linux, including WSL2. Use Linux toolchains in WSL.
Native macOS/Windows drivers are not declared supported; a catalog hit does not
establish compatibility with a particular board, FPGA family or tool version.

Create an isolated environment, outside the projects that will be given to tools:

```sh
python3 -m venv /path/to/operator/fabric-venv
/path/to/operator/fabric-venv/bin/pip install -r scripts/tool-fabric-requirements.txt
```

Install `bubblewrap` and `util-linux` (`prlimit`) through the host package manager.
No engineering toolchains, browsers, services, containers or firmware tools are
downloaded by the facade. Install the engines you actually need, and pin their
versions in your toolchain distribution.

Configure `.env`, then apply your normal OpenCode install/update workflow:

```sh
OPENCODE_TOOL_FABRIC=1
OPENCODE_FABRIC_PYTHON=/path/to/operator/fabric-venv/bin/python
OPENCODE_FABRIC_LAUNCHER=/absolute/path/custom_opencode/scripts/tool-fabric.sh
OPENCODE_FABRIC_CONFIG=/path/to/operator/tool-fabric.json
```

`config-manager` adds a `fabric` MCP binding using the current project directory.
An explicitly configured binding with that name wins. Existing MCP profiles still
control exposure: include `fabric` in the desired profile. Turning this option off
does not delete manually configured servers or profile membership.

A generic MCP client can launch the same server:

```json
{
  "command": "/path/to/operator/fabric-venv/bin/python",
  "args": ["/absolute/path/custom_opencode/app/tool_fabric_mcp.py",
           "--workspace", "/path/to/project",
           "--config", "/path/to/operator/tool-fabric.json"]
}
```

Each project has its own SQLite database in
`$XDG_STATE_HOME/custom-opencode/tool-fabric/<workspace-hash>/`. This reuses the
existing RuntimeStore and ArtifactStore implementations, but separates tool jobs
from the inference scheduler. One process owns a workspace database at a time.

## Operator policy

Configuration is trusted operator data outside the workspace. Tool arguments cannot
grant permissions, change an executable, inject environment variables or select a
shell. Default policy permits read/build operations inside a read-only workspace
sandbox, with a writable artifact directory and no network/devices. Missing
bubblewrap fails closed. Tools that require project writes need `workspaceWrite`.

```json
{
  "toolPath": "/opt/toolchains/bin:/usr/local/bin:/usr/bin:/bin",
  "maxParallel": 3,
  "defaults": {"risks": ["read", "build"], "network": false},
  "permissions": {
    "custom-linter": {
      "runtimeRoots": ["/opt/toolchains"],
      "cache": true,
      "toolchainDigest": "<replace with 64 lowercase hex digits of your pinned toolchain>"
    }
  }
}
```

This permissions fragment requires a layer defining `custom-linter` (below).
Replace the toolchain digest placeholder before using the example. `binarySha256`
can additionally pin the exact executable; a changed digest blocks execution.
`allowUnreviewedLicense` is an operator decision, not a legal conclusion. License
strings are SPDX expressions validated with `packaging`. Operator license metadata
is not a pinned-release audit; mixed/unknown bundles can use `NOASSERTION` and cannot
run until reviewed/authorized. `licenses` can restrict the exact expressions allowed
by policy. No adapter-core license or redistribution rights are inferred here.

`environment` lists explicitly inherited names. `secrets` maps a child environment
name to an operator environment-variable handle. Values are never placed in the
catalog. Exact declared secret values are redacted from captured text, but this is
not a defense against an authorized upstream deliberately encoding/exfiltrating a
secret; only grant credentials to trusted upstreams.

`trustedHost: true` is an explicit unsandboxed escape hatch for specific local
toolchains/probes. It grants that driver the operator's host filesystem access;
it is never an automatic fallback. `runtimeRoots` mounts specific toolchain
directories read-only inside bubblewrap. Containers require an image pinned with
`@sha256:...`, run without a Docker socket or privileged mode, and use `--pull=never`.

For physical devices, permit the exact driver operation and identity:

```json
{
  "permissions": {
    "custom-device-driver": {
      "risks": ["device-write"],
      "operations": ["flash"],
      "devices": ["EXPLICIT_DEVICE_ID"],
      "devicePaths": ["/dev/REPLACE_WITH_EXACT_DEVICE_NODE"]
    }
  }
}
```

This optional example applies only if you define such a driver in a private layer;
it is not a required hardware dependency of the harness. Replace all placeholders.
The same exact identity must appear in `arguments.device`. Device locks serialize
access across workspace databases under the same state directory. A static USB
node grant may need updating after reconnect. No fuse/OTP/erase operation is
provided by default. Configure reviewed target-specific operations rather than
permitting arbitrary scripts that can override device selection. Cancellation or USB
disconnect can leave partial writes: no automatic hardware retry or cache replay.

## Driver manifests

`tools` is an optional list of complete manifests defining catalog entries.
The implementation supports three execution mechanisms: CLI, digest-pinned OCI,
and native MCP (stdio or HTTPS Streamable HTTP). Python/Rust/Go library integrations
run as CLI drivers in their own sandbox; there is no need to load library code into
the facade process or implement a second internal RPC protocol.

Example of a typed CLI operation:

```json
{
  "schemaVersion": 1,
  "id": "custom-linter",
  "name": "Custom linter",
  "source": "https://example.org/your-reviewed-tool",
  "license": "MIT",
  "kind": "cli",
  "binary": "/opt/tools/linter",
  "categories": ["lint"],
  "markers": ["*.txt"],
  "fallbacks": [],
  "operations": {
    "lint": {
      "argv": ["/opt/tools/linter", "--json", "{file}"],
      "inputSchema": {
        "type": "object", "additionalProperties": false,
        "properties": {"file": {"type": "string", "format": "workspace-file"}},
        "required": ["file"]
      },
      "risk": "read", "network": false, "timeoutSeconds": 60
    }
  }
}
```

`workspace-file` rejects absolute paths, missing files and symlink escapes. Array
arguments expand to separate argv entries. `{workspace}` and `{output}` are broker
paths. Templates are operator-supplied argv entries; user strings never become a
shell command. Scripts/netlists may still contain executable instructions, which
is why a validated filename alone does not replace sandboxing.

For `kind: "container"`, add `image: "repository@sha256:<64 hex digits>"` and use
the executable name inside that image. For `kind: "mcp"`, specify
`runtime.command` (argv) or `runtime.url`, and each operation's upstream `tool`
plus a reviewed `inputSchema`. If the upstream schema differs only in presentation,
pin its exact `upstreamSchemaDigest` (SHA256 of canonical sorted compact JSON).
The broker checks the live schema before every call. A schema change fails the
job and never silently widens the declared input/permission surface.

Remote MCP additionally requires operation `network: true`, policy `network: true`
and exact `hosts`. It uses HTTPS without URL credentials, inherited proxies or
redirect following. `runtime.headerSecrets` maps header names to explicitly allowed
secret handles. Upstream sampling/elicitation is not delegated. Existing standalone
MCP servers are not automatically imported/moved behind the broker; bind reviewed
operations to avoid changing their permissions or starting duplicate connections.

## Jobs, limits and caching

At most three jobs execute concurrently; the queue is capped at 32. Jobs keep
durable state, output and artifact digests. An idempotency key returns the same
job even after failure/restart; it is not permission to replay a side effect.
Interrupted jobs become `needs_attention`. Different arguments with the same key
are rejected. Failure backoff is 30 seconds, without automatic operation retry.

Local process groups are terminated on timeout/cancel. Local execution has CPU,
address-space, file-size and descriptor limits; OCI additionally has memory/PID/CPU
limits. Stdout and stderr are drained but each retained prefix is limited to 48 KB.
Artifacts are limited to 32 files, 16 MB each and 64 MB total per result.
Artifact resources return `nextUri` when further chunks are available. Upstream
stdio frames and HTTP responses are bounded at 1 MiB before parsing; a stdio
connection also has an 8 MiB cumulative receive budget. Compressed HTTP responses
are rejected to prevent decompression bombs.

Schema metadata has a one-day TTL and a manifest digest key. Native MCP connection
schemas are rechecked at execution, so a missed change notification cannot authorize
a stale call. Native connections are scoped to a job and close immediately afterward;
there is no idle process pool or `PINNED` mode yet.

Artifact caching is opt-in and requires an operator-supplied complete toolchain
digest. The key covers manifest/policy, argv inputs, full source tree, executable,
allowlisted environment and platform. Symlinks or a tree beyond the hashing budget
disable caching. Changed input trees and corrupt artifacts invalidate a hit.
Device/network operations never use result caching. Cached artifacts remain
accessible by URI; a cache hit does not recreate project-side writes.
Caching is disabled for `workspaceWrite` operations for that reason.

OpenTelemetry API spans (`fabric.execute`), counters (`fabric.executions`) and
histograms (`fabric.duration`) use the application's configured provider. No collector,
Prometheus, Grafana or exporter is started automatically. SQLite events and
`fabric://status` work without an external telemetry service.

## Verification and limits of acceptance

```sh
python3 scripts/tool-fabric-smoke.py
node scripts/tool-fabric-config-smoke.mjs
```

The smoke exercises actual CLI subprocesses and an SDK MCP subprocess, modern and
legacy wire connections, five-tool exposure, input/path validation, schema drift,
cache invalidation/corruption, cancellation, timeout, bounded output, idempotency and
restart recovery. Tests do not invoke paid models, production services or hardware.

The public harness tests the broker, not any user's selected integrations.
Vendor tool/version matrices, private engines' real acceptance fixtures,
physical HIL, native macOS/Windows isolation, persistent browser sessions, upstream
OAuth delegation, hot-pool pinning, an HTTP facade, MCP Tasks extension, GUI EDA
automation and a full observability deployment are not provided. `job.*` is the
portable asynchronous API. Fallback entries are returned for an explicit next
choice; a different simulator or physical write is never silently substituted.
Network authorization for general CLI tools grants network access, not a
domain-filtering proxy. Do not interpret a manifest's descriptive metadata as a
hardware compatibility guarantee or a license/compliance audit.
