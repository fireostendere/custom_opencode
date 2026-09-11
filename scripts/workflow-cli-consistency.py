#!/usr/bin/env python3
"""Static consistency guard between CI workflows and the harness scripts they run.

Guards the regression classes that actually broke Clean Regression jobs silently:

- wrong or unknown CLI flags and missing required flags in workflow invocations
  (native-clean-install once passed --workdir to install-native-regression.py,
  which requires --output; the job died with argparse exit 2 after a full
  runner setup and uploaded an empty artifact directory);
- upload-artifact paths that do not match the --output/mkdir directory the same
  job declares (native-budget-wire uploaded a nonexistent evidence/ subdirectory
  and the upload only warned "No files were found");
- masked failures: harness output piped through tee without pipefail, `|| true`
  on harness invocations, continue-on-error steps;
- pinned @opencode-ai/cli installs without post-install binary validation (a
  broken npm postinstall leaves the placeholder opencode2.exe that only dies
  with "Exec format error" deep inside a suite);
- push triggers on clean-regression.yml that drop main or astra2, letting
  branch pushes skip CI entirely.

Static analysis only: workflow text plus each Python harness's argparse via ast.
Harnesses are never executed. Scripts that parse argv manually (no
add_argument calls) get existence checks only.

Usage: workflow-cli-consistency.py [workflow-dir]   (default .github/workflows)
"""
from __future__ import annotations

import ast
import re
import shlex
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HARNESS = re.compile(r"\b(?:python3|python|node|bash)\s+(scripts/[A-Za-z0-9._-]+)((?:[^\n|&;])*)")
OPTION_CACHE: dict[str, tuple[set[str], set[str], bool]] = {}
ERRORS: list[str] = []


def fail(message: str) -> None:
    ERRORS.append(message)


def normalize_temp(value: str) -> str:
    return (
        value.replace("${{ runner.temp }}", "%TEMP%")
        .replace("$RUNNER_TEMP", "%TEMP%")
        .strip("\"'")
        .rstrip("/")
    )


def split_jobs(text: str) -> dict[str, str]:
    """Map job id -> job body text (workflow files keep the stable 2-space style)."""
    jobs: dict[str, list[str]] = {}
    current: str | None = None
    in_jobs = False
    for line in text.splitlines():
        if re.match(r"^jobs:\s*$", line):
            in_jobs, current = True, None
            continue
        if not in_jobs:
            continue
        if re.match(r"^\S", line):
            in_jobs, current = False, None
            continue
        header = re.match(r"^  ([A-Za-z0-9_-]+):\s*$", line)
        if header:
            current = header.group(1)
            jobs[current] = []
        elif current is not None:
            jobs[current].append(line)
    return {name: "\n".join(body) for name, body in jobs.items()}


def run_blocks(body: str) -> list[str]:
    """Collect the shell text of every `run:` step in a job body."""
    blocks: list[str] = []
    lines = body.splitlines()
    index = 0
    while index < len(lines):
        match = re.match(r"^(\s*)(?:-\s+)?run:\s*(\|)?\s*(.*)$", lines[index])
        if not match:
            index += 1
            continue
        indent, block, inline = match.groups()
        if block:
            collected: list[str] = []
            index += 1
            while index < len(lines):
                line = lines[index]
                if line.strip() and not line.startswith(indent + "  "):
                    break
                collected.append(line)
                index += 1
            blocks.append("\n".join(collected).replace("\\\n", " "))
        else:
            blocks.append(inline)
            index += 1
    return blocks


def artifact_paths(body: str) -> list[str]:
    paths: list[str] = []
    lines = body.splitlines()
    for index, line in enumerate(lines):
        if "actions/upload-artifact" not in line:
            continue
        for follow in lines[index + 1 : index + 8]:
            if re.match(r"\s*-\s+(uses|run|name):", follow):
                break
            match = re.match(r"\s*path:\s*(.+?)\s*$", follow)
            if match:
                paths.append(normalize_temp(match.group(1)))
                break
    return paths


def script_options(relative: str) -> tuple[set[str], set[str], bool]:
    """(defined long options, required long options, uses argparse) for a script."""
    path = ROOT / relative
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    defined: set[str] = set()
    required: set[str] = set()
    parser_based = False
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        function = node.func
        if not (isinstance(function, ast.Attribute) and function.attr == "add_argument"):
            continue
        parser_based = True
        names = [
            argument.value
            for argument in node.args
            if isinstance(argument, ast.Constant) and isinstance(argument.value, str)
        ]
        longs = {name.split("=")[0] for name in names if name.startswith("--")}
        defined |= longs
        if any(
            keyword.arg == "required"
            and isinstance(keyword.value, ast.Constant)
            and keyword.value.value is True
            for keyword in node.keywords
        ):
            required |= longs
    return defined, required, parser_based


def check_invocations(where: str, block: str) -> list[str]:
    """Validate harness invocations in a run block; return its --output dirs."""
    outputs: list[str] = []
    for match in HARNESS.finditer(block):
        relative, argument_text = match.group(1), match.group(2)
        if not (ROOT / relative).exists():
            fail(f"{where}: workflow references missing script: {relative}")
            continue
        try:
            tokens = shlex.split(argument_text, posix=True)
        except ValueError as error:
            fail(f"{where}: cannot parse arguments for {relative}: {error}")
            continue
        options = {token.split("=")[0] for token in tokens if token.startswith("--")}
        for index, token in enumerate(tokens):
            if token == "--output" and index + 1 < len(tokens):
                outputs.append(normalize_temp(tokens[index + 1]))
            elif token.startswith("--output="):
                outputs.append(normalize_temp(token.split("=", 1)[1]))
        if not relative.endswith(".py"):
            continue
        if relative not in OPTION_CACHE:
            OPTION_CACHE[relative] = script_options(relative)
        defined, required, parser_based = OPTION_CACHE[relative]
        if not parser_based:
            continue  # argv is parsed manually; static option checks are impossible
        for option in sorted(options - defined):
            fail(f"{where}: {relative} does not define {option} but the workflow passes it")
        for option in sorted(required - options):
            fail(f"{where}: {relative} requires {option} but the workflow invocation omits it")
    if outputs and not re.search(r"\btest -[sn]\b", block):
        fail(f"{where}: harness writes --output reports but the step never validates them (test -s/-n)")
    return outputs


def check_block_policies(where: str, block: str) -> None:
    if "| tee" in block and "pipefail" not in block:
        fail(f"{where}: harness output is piped through tee without pipefail; failures would be masked")
    for line in block.splitlines():
        if re.search(r"\b(?:python3?|node|bash)\s+scripts/", line) and re.search(r"\|\|\s*(true|:)", line):
            fail(f"{where}: harness invocation is masked by `|| true`: {line.strip()}")
    if "@opencode-ai/cli" in block and "npm install" in block and "--version" not in block:
        fail(f"{where}: pinned @opencode-ai/cli install without post-install validation (opencode2 --version)")


def check_triggers(name: str, text: str) -> None:
    # ponytail: branch list is intentionally hardcoded; update when the release branches change.
    if name != "clean-regression.yml":
        return
    match = re.search(r"^\s*branches:\s*\[([^\]]*)\]", text, re.MULTILINE)
    branches = {item.strip().strip("'\"") for item in match.group(1).split(",")} if match else set()
    for branch in ("main", "astra2"):
        if branch not in branches:
            fail(f"{name}: push trigger drops branch {branch!r}; pushes to it would skip CI silently")


def main(argv: list[str]) -> int:
    directory = Path(argv[1]).resolve() if len(argv) > 1 else ROOT / ".github" / "workflows"
    workflows = sorted(directory.glob("*.yml"))
    if not workflows:
        print(f"workflow-cli-consistency: no workflows found in {directory}", file=sys.stderr)
        return 2
    for workflow in workflows:
        text = workflow.read_text(encoding="utf-8")
        check_triggers(workflow.name, text)
        for job, body in split_jobs(text).items():
            where = f"{workflow.name}:{job}"
            declared: list[str] = []
            for block in run_blocks(body):
                declared.extend(check_invocations(where, block))
                declared.extend(
                    normalize_temp(found)
                    for found in re.findall(r"mkdir -p \"?(\$RUNNER_TEMP/[\w./-]+)\"?", block)
                )
                check_block_policies(where, block)
            if "continue-on-error: true" in body:
                fail(f"{where}: continue-on-error hides regressions")
            for path in artifact_paths(body):
                if path not in declared:
                    fail(
                        f"{where}: upload-artifact path {path} matches no --output/mkdir directory"
                        f" declared by the job ({sorted(set(declared)) or 'none'})"
                    )
    if ERRORS:
        print("Workflow/CLI consistency FAIL:")
        for error in ERRORS:
            print(f"- {error}")
        return 1
    print(
        f"Workflow/CLI consistency OK: {len(workflows)} workflow(s) checked"
        " (harness args, artifact paths, masking guards, CLI validation, triggers)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
