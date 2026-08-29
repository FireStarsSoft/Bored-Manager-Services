"""How many bytes a unit has moved, and how honestly we can say so.

Two very different measurements wear one name here, and the difference is
recorded on every row rather than hidden:

**Containers** have their own network namespace, so Docker keeps exact
cumulative counters per container. Reading them once a minute and taking the
delta is precise. `partial` is false.

**Host-native units** do not. Linux has no per-process byte counter: cgroup v2
dropped `net_cls`/`net_prio` accounting, and `/proc/<pid>/net/dev` is per
*namespace*, not per process - reading it for a service in the host namespace
returns the whole machine's traffic, which would silently report a host total
as if it were one unit's. So the figure is built from the per-socket counters
`ss -tuanpi` reports for the PIDs in the unit's cgroup, and `partial` is true,
because that method has two known holes:

- a socket opened *and* closed entirely between two samples is never seen;
- UDP sockets carry no such counters at all.

For a long-lived TCP service this is close to exact. For something doing many
short connections it is a floor, not a total - and a floor labelled as one is
worth more than a precise-looking number that is wrong.

**Why sockets are accounted individually.** Each socket's counters are its own
and vanish when it closes. Summing the live sockets and taking the delta of
that sum would read a closed 1 GB connection as the machine un-sending a
gigabyte; the accumulator below instead tracks each socket's last-seen value
and only ever adds increases, so a socket that goes away keeps the bytes it
already contributed.
"""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass, field

from .. import systemdutil

#: `users:(("pawns-cli",pid=1234,fd=7))`
_USERS_RE = re.compile(r"pid=(\d+)")
#: The counters `ss -i` prints. `bytes_acked` is what the peer confirmed
#: receiving, which is the closest thing to "sent" the kernel exposes here.
_BYTES_SENT_RE = re.compile(r"\bbytes_sent:(\d+)")
_BYTES_ACKED_RE = re.compile(r"\bbytes_acked:(\d+)")
_BYTES_RECEIVED_RE = re.compile(r"\bbytes_received:(\d+)")

SS_TIMEOUT_S = 10


@dataclass(frozen=True)
class Counters:
    """Bytes for one unit. Cumulative in a snapshot, a delta in a sample."""

    rx: int
    tx: int
    #: True when the figure is a floor rather than a total - see the module note.
    partial: bool


def delta(current: Counters | None, previous: Counters | None) -> Counters | None:
    """Bytes since the previous cumulative reading, treating a drop as a reset.

    A container that restarted starts its counters at zero again. Reporting the
    negative difference would show a day with minus several gigabytes; treating
    it as a fresh baseline loses at most one sampling interval of traffic, which
    is much the smaller error.
    """
    if current is None:
        return None
    if previous is None:
        return Counters(0, 0, current.partial)
    rx = current.rx - previous.rx
    tx = current.tx - previous.tx
    if rx < 0 or tx < 0:
        return Counters(max(0, current.rx), max(0, current.tx), current.partial)
    return Counters(rx, tx, current.partial)


def container_counters(docker, name: str) -> Counters | None:
    """Cumulative rx/tx for one container, summed over its interfaces."""
    stats = docker.stats(name)
    if not isinstance(stats, dict):
        return None
    networks = stats.get("networks")
    if not isinstance(networks, dict):
        # A container sharing the host's network namespace (`--network host`)
        # reports nothing here. "Unknown" is right; charting zero would claim
        # it moved nothing.
        return None
    rx = 0
    tx = 0
    for interface in networks.values():
        if not isinstance(interface, dict):
            continue
        rx += int(interface.get("rx_bytes") or 0)
        tx += int(interface.get("tx_bytes") or 0)
    return Counters(rx, tx, partial=False)


def ss_output() -> str:
    """One `ss` call for the whole machine, filtered per unit afterwards.

    One call rather than one per unit: `ss` walks every socket either way, so
    asking once is both cheaper and consistent - two calls a second apart could
    attribute a socket that changed owner to both units or to neither.
    """
    try:
        completed = subprocess.run(  # noqa: S603 - argv list, shell=False
            ["ss", "-tuanpi"], capture_output=True, text=True, timeout=SS_TIMEOUT_S, check=False
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return ""
    return completed.stdout or ""


def _socket_blocks(output: str) -> list[str]:
    """`ss -i` prints a continuation line per socket; join each pair."""
    blocks: list[str] = []
    for line in output.splitlines():
        if not line.strip():
            continue
        if line.startswith((" ", "\t")) and blocks:
            blocks[-1] += " " + line.strip()
        else:
            blocks.append(line.strip())
    return blocks


def socket_counters(pids: set[int], output: str) -> dict[str, tuple[int, int]] | None:
    """Per-socket cumulative bytes for sockets owned by these PIDs.

    Keyed by local and peer address, which is what identifies a connection for
    as long as it exists. None when `ss` gave us nothing to read, so the caller
    can record "unknown" rather than zero.
    """
    if not pids or not output.strip():
        return None
    out: dict[str, tuple[int, int]] = {}
    for block in _socket_blocks(output):
        owners = {int(pid) for pid in _USERS_RE.findall(block)}
        if not owners & pids:
            continue
        columns = block.split()
        # `Netid State Recv-Q Send-Q Local:Port Peer:Port ...`
        local = columns[4] if len(columns) > 4 else "?"
        peer = columns[5] if len(columns) > 5 else "?"
        sent = _BYTES_ACKED_RE.search(block) or _BYTES_SENT_RE.search(block)
        received = _BYTES_RECEIVED_RE.search(block)
        key = f"{local}->{peer}"
        # A key can repeat across a listening socket and its children; add
        # rather than overwrite so neither is lost.
        rx_prev, tx_prev = out.get(key, (0, 0))
        out[key] = (
            rx_prev + (int(received.group(1)) if received else 0),
            tx_prev + (int(sent.group(1)) if sent else 0),
        )
    return out


@dataclass
class HostAccumulator:
    """Running totals for one host-native unit, socket by socket.

    Holding per-socket state is what makes the total monotonic across
    connection churn: a socket that closes keeps whatever it contributed, and a
    new one starts from zero instead of appearing as a jump.
    """

    rx: int = 0
    tx: int = 0
    _seen: dict[str, tuple[int, int]] = field(default_factory=dict)

    def update(self, sockets: dict[str, tuple[int, int]]) -> None:
        for key, (rx, tx) in sockets.items():
            last_rx, last_tx = self._seen.get(key, (0, 0))
            # Only increases count. A socket key that gets reused by a new
            # connection starts lower than the one before it, and adding the
            # difference would subtract the old connection's traffic.
            self.rx += max(0, rx - last_rx)
            self.tx += max(0, tx - last_tx)
            self._seen[key] = (rx, tx)
        # Sockets that are gone stay out of `_seen` from here, so their bytes
        # are neither double-counted nor withdrawn.
        for key in [k for k in self._seen if k not in sockets]:
            del self._seen[key]

    def snapshot(self) -> Counters:
        return Counters(self.rx, self.tx, partial=True)


class UnitBandwidth:
    """Cumulative counters per unit, whichever measurement applies."""

    def __init__(self) -> None:
        self._hosts: dict[str, HostAccumulator] = {}

    def read(self, kind: str, name: str, docker, ss_text: str | None = None) -> Counters | None:
        if kind == "container":
            return container_counters(docker, name)
        pids = set(systemdutil.unit_pids(name))
        if not pids:
            # Not running. Its accumulator is kept, so a restart continues the
            # same total rather than starting the day again.
            accumulator = self._hosts.get(name)
            return accumulator.snapshot() if accumulator else None
        sockets = socket_counters(pids, ss_output() if ss_text is None else ss_text)
        if sockets is None:
            return None
        accumulator = self._hosts.setdefault(name, HostAccumulator())
        accumulator.update(sockets)
        return accumulator.snapshot()
