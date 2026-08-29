"""Executing a template's steps, and the substitution that feeds them.

Two rules hold this together, and both are structural rather than advisory:

1. **Substitution produces one value, never a fragment of a command line.**
   `substitute` is applied to individual argv elements and to file contents. It
   is never applied to something that is then split on whitespace, so a value
   containing a space, a quote or a semicolon is one argument containing those
   characters - not two arguments and an operator.
2. **Nothing here reaches a shell.** Every process is started with an argv list
   and `shell=False`. The one exception, `script`, hands its body to `sh` on
   *stdin* rather than as an argument, and only runs for a template that
   declared itself privileged.
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.request import urlopen

from ..templates.model import Step, Template

PLACEHOLDER_RE = re.compile(r"\{\{\s*([a-z][a-z0-9_]*)\s*\}\}")

#: Long enough for an apt install on a slow link, short enough that a wedged
#: step cannot hold an install open forever.
STEP_TIMEOUT_S = 600
DOWNLOAD_TIMEOUT_S = 300
#: A template's binary is a helper, not an image. Anything larger is a mistake.
DOWNLOAD_MAX_BYTES = 256 * 1024 * 1024

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class StepError(RuntimeError):
    """A step failed in a way the caller should report rather than swallow."""


@dataclass
class StepResult:
    op: str
    ok: bool
    message: str
    skipped: bool = False


@dataclass
class ExecutionLog:
    steps: list[StepResult] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return all(s.ok or s.skipped for s in self.steps)

    def to_public(self) -> list[dict[str, Any]]:
        return [
            {"op": s.op, "ok": s.ok, "skipped": s.skipped, "message": s.message} for s in self.steps
        ]


def substitute(text: str, values: dict[str, str]) -> str:
    """Replace `{{field}}` with its value.

    A field with no value becomes the empty string rather than being left as
    `{{field}}`: a literal placeholder reaching a command line would be a
    confusing argument, while an empty one is at worst a missing option, and
    required fields are checked before any step runs.
    """
    return PLACEHOLDER_RE.sub(lambda m: values.get(m.group(1), ""), text)


def substitute_all(items: tuple[str, ...] | list[str], values: dict[str, str]) -> list[str]:
    return [substitute(item, values) for item in items]


def missing_required(template: Template, values: dict[str, str]) -> list[str]:
    """Required fields with nothing in them, by label.

    Checked before the first step rather than at the point of use: an install
    that got halfway and then stopped for a missing password would leave a
    half-configured unit behind.
    """
    out = []
    for spec in template.fields:
        if spec.required and not (values.get(spec.id) or "").strip():
            out.append(spec.label)
    return out


def apply_defaults(template: Template, values: dict[str, str]) -> dict[str, str]:
    merged = {}
    for spec in template.fields:
        supplied = values.get(spec.id)
        if supplied is not None and supplied != "":
            merged[spec.id] = supplied
        elif spec.default is not None:
            merged[spec.id] = spec.default
        else:
            merged[spec.id] = ""
    return merged


def _run(argv: list[str], *, stdin: str | None = None, timeout: int = STEP_TIMEOUT_S) -> tuple[int, str]:
    """One process, no shell, output captured and bounded by the caller."""
    try:
        completed = subprocess.run(  # noqa: S603 - argv list, shell=False
            argv,
            input=stdin,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as err:
        raise StepError(f"{argv[0]} is not installed on this machine") from err
    except subprocess.TimeoutExpired as err:
        raise StepError(f"{argv[0]} did not finish within {timeout}s") from err
    output = (completed.stdout or "") + (completed.stderr or "")
    return completed.returncode, output.strip()[:4000]


def _download(url: str, dest: Path, expected_sha256: str) -> str:
    """Fetch a file and refuse to keep it unless it hashes to what was promised.

    The download lands in a temporary file beside the destination and is only
    renamed into place after the digest matches, so a failed check leaves
    nothing behind that a later step could pick up by mistake.
    """
    digest = expected_sha256.strip().lower()
    if not SHA256_RE.match(digest):
        raise StepError(
            f'"{expected_sha256}" is not a 64-character sha256; refusing to download something unverifiable'
        )
    if not url.startswith(("http://", "https://")):
        raise StepError(f'"{url}" is not an http(s) URL')

    dest.parent.mkdir(parents=True, exist_ok=True)
    hasher = hashlib.sha256()
    total = 0
    fd, tmp_name = tempfile.mkstemp(dir=str(dest.parent), prefix=f".{dest.name}.", suffix=".part")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            with urlopen(url, timeout=DOWNLOAD_TIMEOUT_S) as response:  # noqa: S310 - scheme checked
                while True:
                    chunk = response.read(1 << 16)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > DOWNLOAD_MAX_BYTES:
                        raise StepError(f"the file is larger than {DOWNLOAD_MAX_BYTES // (1 << 20)} MB")
                    hasher.update(chunk)
                    handle.write(chunk)
        actual = hasher.hexdigest()
        if actual != digest:
            raise StepError(f"sha256 mismatch: expected {digest}, got {actual}")
        os.replace(tmp, dest)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return f"{total} bytes, sha256 {digest[:12]}..."


def run_step(step: Step, values: dict[str, str], docker: Any | None = None) -> StepResult:
    """Execute one opcode. Raises StepError unless the step tolerates failure."""
    op = step.op
    args = step.args

    def sub(key: str, default: str = "") -> str:
        raw = args.get(key, default)
        return substitute(raw, values) if isinstance(raw, str) else default

    def argv() -> list[str]:
        raw = args.get("argv")
        return substitute_all(raw, values) if isinstance(raw, list) else []

    try:
        if op == "dockerRm":
            if docker is None:
                raise StepError("Docker is not available on this machine")
            removed = docker.remove_container(sub("target"), force=bool(args.get("force", True)))
            return StepResult(op, True, "removed" if removed else "was not there")
        if op == "dockerStop":
            if docker is None:
                raise StepError("Docker is not available on this machine")
            stopped = docker.stop_container(sub("target"))
            return StepResult(op, True, "stopped" if stopped else "was not running")
        if op == "dockerRmi":
            if docker is None:
                raise StepError("Docker is not available on this machine")
            docker.remove_image(sub("target"))
            return StepResult(op, True, "image removed")
        if op == "dockerPull":
            if docker is None:
                raise StepError("Docker is not available on this machine")
            docker.pull(sub("target"))
            return StepResult(op, True, "pulled")
        if op == "download":
            detail = _download(sub("url"), Path(str(args.get("dest"))), sub("sha256"))
            return StepResult(op, True, detail)
        if op == "writeFile":
            path = Path(str(args.get("path")))
            path.parent.mkdir(parents=True, exist_ok=True)
            content = sub("content")
            path.write_text(content, encoding="utf-8")
            mode = str(args.get("mode", "0644"))
            os.chmod(path, int(mode, 8))
            return StepResult(op, True, f"wrote {len(content)} bytes to {path}")
        if op == "mkdir":
            path = Path(str(args.get("path")))
            path.mkdir(parents=True, exist_ok=True)
            return StepResult(op, True, f"{path} exists")
        if op == "chmod":
            path = Path(str(args.get("path")))
            os.chmod(path, int(str(args.get("mode", "0644")), 8))
            return StepResult(op, True, f"mode set on {path}")
        if op == "systemctl":
            code, out = _run(["systemctl", *argv()])
            if code != 0:
                raise StepError(out or f"systemctl exited {code}")
            return StepResult(op, True, out or "ok")
        if op == "apt":
            env_argv = ["apt-get", "-o", "DPkg::Lock::Timeout=120", *argv()]
            code, out = _run(env_argv)
            if code != 0:
                raise StepError(out or f"apt-get exited {code}")
            return StepResult(op, True, (out or "ok")[-400:])
        if op == "run":
            program = str(args.get("program"))
            resolved = program if program.startswith("/") else shutil.which(program) or program
            code, out = _run([resolved, *argv()])
            if code != 0:
                raise StepError(out or f"{program} exited {code}")
            return StepResult(op, True, out or "ok")
        if op == "script":
            # The body goes in on stdin, never as an argument, so it never
            # appears in the process list of either machine.
            code, out = _run(["sh", "-s"], stdin=substitute(str(args.get("body", "")), values))
            if code != 0:
                raise StepError(out or f"script exited {code}")
            return StepResult(op, True, out or "ok")
        raise StepError(f'"{op}" is not an opcode this agent knows')
    except StepError:
        raise
    except OSError as err:
        raise StepError(str(err)) from err


def run_steps(
    steps: tuple[Step, ...], values: dict[str, str], docker: Any | None = None
) -> ExecutionLog:
    """Run steps in order, honouring `ignoreErrors`.

    A step that tolerates failure records why it failed rather than being
    silent: "there was nothing to remove" and "the daemon refused" both leave
    the install running, and only one of them is normal.
    """
    log = ExecutionLog()
    for step in steps:
        try:
            log.steps.append(run_step(step, values, docker))
        except StepError as err:
            if step.ignore_errors:
                log.steps.append(StepResult(step.op, True, f"skipped: {err}", skipped=True))
                continue
            log.steps.append(StepResult(step.op, False, str(err)))
            break
    return log
