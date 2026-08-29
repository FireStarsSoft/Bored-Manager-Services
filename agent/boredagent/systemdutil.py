"""The systemd half: unit state, logs, and the PIDs a unit owns.

Everything here shells out to `systemctl` and `journalctl` with an argv list and
no shell. Unit names arrive from a template that has already been through the
validator's `SYSTEMD_UNIT_RE`, so they cannot contain a space or a separator -
but they are still passed as single argv elements rather than interpolated, so
that property is enforced twice rather than assumed once.
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .dockerutil import UnitStatus

#: Where a system unit's processes live under cgroup v2. This is how a unit's
#: PIDs are found for per-process byte accounting.
CGROUP_ROOT = Path("/sys/fs/cgroup/system.slice")

SHOW_TIMEOUT_S = 15
ACTION_TIMEOUT_S = 120


def _run(argv: list[str], timeout: int = SHOW_TIMEOUT_S) -> tuple[int, str]:
    try:
        completed = subprocess.run(  # noqa: S603 - argv list, shell=False
            argv, capture_output=True, text=True, timeout=timeout, check=False
        )
    except FileNotFoundError:
        return 127, f"{argv[0]} is not installed"
    except subprocess.TimeoutExpired:
        return 124, f"{argv[0]} did not finish within {timeout}s"
    return completed.returncode, ((completed.stdout or "") + (completed.stderr or "")).strip()


def available() -> bool:
    code, _ = _run(["systemctl", "--version"])
    return code == 0


@dataclass(frozen=True)
class UnitShow:
    load_state: str
    active_state: str
    sub_state: str
    result: str
    exec_main_status: int | None
    n_restarts: int
    active_enter_timestamp: str | None
    main_pid: int | None


def show(unit: str) -> UnitShow | None:
    """`systemctl show`, parsed. None when systemd has never heard of the unit."""
    keys = [
        "LoadState",
        "ActiveState",
        "SubState",
        "Result",
        "ExecMainStatus",
        "NRestarts",
        "ActiveEnterTimestamp",
        "MainPID",
    ]
    code, out = _run(["systemctl", "show", unit, "--property=" + ",".join(keys)])
    if code != 0 and not out:
        return None
    parsed: dict[str, str] = {}
    for line in out.splitlines():
        if "=" in line:
            key, _, value = line.partition("=")
            parsed[key.strip()] = value.strip()
    if not parsed:
        return None

    def as_int(key: str) -> int | None:
        raw = parsed.get(key, "")
        return int(raw) if raw.lstrip("-").isdigit() else None

    return UnitShow(
        load_state=parsed.get("LoadState", "not-found"),
        active_state=parsed.get("ActiveState", "inactive"),
        sub_state=parsed.get("SubState", ""),
        result=parsed.get("Result", ""),
        exec_main_status=as_int("ExecMainStatus"),
        n_restarts=as_int("NRestarts") or 0,
        active_enter_timestamp=parsed.get("ActiveEnterTimestamp") or None,
        main_pid=as_int("MainPID") or None,
    )


def describe(unit: str) -> UnitStatus:
    """A unit's state in the same vocabulary containers use.

    Mapping systemd's two-axis state onto one word loses detail, and the detail
    that matters is kept: `failed` is `exited` with a non-zero `exitCode`, so a
    unit that stopped cleanly and one that crashed do not read the same.
    """
    detail = show(unit)
    if detail is None or detail.load_state == "not-found":
        return UnitStatus(name=unit, state="absent")

    active = detail.active_state
    if active == "active":
        state = "running"
    elif active == "activating" or active == "deactivating":
        state = "restarting"
    elif active == "failed":
        state = "exited"
    else:
        state = "exited" if detail.load_state == "loaded" else "absent"

    return UnitStatus(
        name=unit,
        state=state,
        image=None,
        status=f"{active}/{detail.sub_state}".strip("/"),
        started_at=detail.active_enter_timestamp,
        restart_count=detail.n_restarts,
        exit_code=detail.exec_main_status,
        health="unhealthy" if active == "failed" else None,
    )


def logs(unit: str, tail: int = 200, since: str | None = None, timestamps: bool = True) -> list[str]:
    argv = ["journalctl", "-u", unit, "-n", str(max(1, tail)), "--no-pager"]
    if not timestamps:
        argv += ["-o", "cat"]
    if since:
        argv += ["--since", since]
    code, out = _run(argv, timeout=30)
    if code != 0 and not out:
        return []
    return [line for line in out.splitlines() if line]


def follow(unit: str, tail: int = 100):
    """New journal lines for one unit, as a generator."""
    argv = ["journalctl", "-u", unit, "-n", str(max(0, tail)), "-f", "--no-pager"]
    process = subprocess.Popen(  # noqa: S603 - argv list, shell=False
        argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True
    )
    try:
        if process.stdout is None:
            return
        for line in process.stdout:
            stripped = line.rstrip("\n")
            if stripped:
                yield stripped
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()


def action(unit: str, verb: str) -> tuple[bool, str]:
    if verb not in {"start", "stop", "restart", "enable", "disable"}:
        return False, f'"{verb}" is not an action this agent performs'
    code, out = _run(["systemctl", verb, unit], timeout=ACTION_TIMEOUT_S)
    return code == 0, out or ("ok" if code == 0 else f"systemctl exited {code}")


_PID_RE = re.compile(r"^\d+$")


def unit_pids(unit: str) -> list[int]:
    """Every PID in the unit's cgroup, not just its MainPID.

    A service that forks workers does its transfers in those workers, so
    accounting only the main process would report close to zero for exactly the
    services worth measuring. Reading `cgroup.procs` is how systemd itself
    enumerates a unit.
    """
    path = CGROUP_ROOT / unit / "cgroup.procs"
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        detail = show(unit)
        return [detail.main_pid] if detail and detail.main_pid else []
    return [int(line) for line in raw.split() if _PID_RE.match(line)]


def info() -> dict[str, Any]:
    code, out = _run(["systemctl", "--version"])
    if code != 0:
        return {"available": False, "error": out}
    first = out.splitlines()[0] if out else ""
    return {"available": True, "version": first}
