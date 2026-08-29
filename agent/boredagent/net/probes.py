"""The two probes, each one process, each finishing inside its own tick.

Every probe here is bounded below the monitor's interval on purpose. The loops
run one probe per second, and a probe that can outlive its tick would make the
pool rotate slower than it claims to - so `ping -W 1` and `dig +time=1 +tries=1`
are not tuning, they are what keeps "one target per second" true.
"""

from __future__ import annotations

import asyncio
import ipaddress
import re
from dataclasses import dataclass

#: `time=12.3 ms`, in the several spellings ping uses across distributions.
_RTT_RE = re.compile(r"time[=<]\s*([\d.]+)\s*ms", re.IGNORECASE)


@dataclass(frozen=True)
class PingSample:
    ts: int
    target: str
    ok: bool
    latency_ms: float | None = None
    error: str | None = None

    def to_public(self) -> dict[str, object]:
        return {
            "ts": self.ts,
            "target": self.target,
            "ok": self.ok,
            "latencyMs": self.latency_ms,
            "error": self.error,
        }


@dataclass(frozen=True)
class IpSample:
    ts: int
    source: str
    public_ip: str | None
    ok: bool
    error: str | None = None

    def to_public(self) -> dict[str, object]:
        return {
            "ts": self.ts,
            "source": self.source,
            "publicIp": self.public_ip,
            "ok": self.ok,
            "error": self.error,
        }


async def _run(argv: list[str], timeout: float) -> tuple[int, str]:
    """One subprocess, killed rather than allowed to overrun its tick."""
    try:
        process = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
    except FileNotFoundError:
        return 127, f"{argv[0]} is not installed"
    except OSError as err:
        return 1, str(err)
    try:
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        process.kill()
        # Reap it, or the event loop collects zombies one per second.
        try:
            await process.wait()
        except ProcessLookupError:
            pass
        return 124, "timed out"
    return process.returncode or 0, (stdout or b"").decode("utf-8", errors="replace").strip()


def parse_rtt(output: str) -> float | None:
    match = _RTT_RE.search(output)
    if not match:
        return None
    try:
        return float(match.group(1))
    except ValueError:
        return None


async def ping_once(target: str, now_ms: int, timeout_s: float = 1.0) -> PingSample:
    """One ICMP echo. `-c 1 -W 1` so it cannot outlive its tick."""
    whole = max(1, int(round(timeout_s)))
    code, output = await _run(
        ["ping", "-4", "-n", "-c", "1", "-W", str(whole), target], timeout=timeout_s + 0.5
    )
    if code == 0:
        rtt = parse_rtt(output)
        if rtt is not None:
            return PingSample(now_ms, target, True, rtt)
        # Exit 0 with no parsable RTT: the host answered, so it is reachable,
        # and the number is what is missing rather than the answer.
        return PingSample(now_ms, target, True, None, "no round-trip time in the reply")
    if code == 127:
        return PingSample(now_ms, target, False, None, output)
    return PingSample(now_ms, target, False, None, "timed out" if code == 124 else "no reply")


def parse_ipv4(output: str) -> str | None:
    """First IPv4 in dig's output, with the quotes a TXT answer carries."""
    for line in output.splitlines():
        candidate = line.strip().strip('"').strip()
        if not candidate:
            continue
        try:
            address = ipaddress.ip_address(candidate)
        except ValueError:
            continue
        if address.version == 4:
            return str(address)
    return None


async def public_ip_once(
    name: str, args: tuple[str, ...], now_ms: int, timeout_s: float = 1.0
) -> IpSample:
    """Ask one DNS source what it sees our address as."""
    argv = ["dig", "+short", "-4", "+time=1", "+tries=1", *args]
    code, output = await _run(argv, timeout=timeout_s + 0.5)
    if code == 127:
        return IpSample(now_ms, name, None, False, output)
    if code != 0:
        return IpSample(now_ms, name, None, False, "timed out" if code == 124 else "dig failed")
    address = parse_ipv4(output)
    if address is None:
        return IpSample(now_ms, name, None, False, "no IPv4 in the answer")
    return IpSample(now_ms, name, address, True)


async def public_ip_http(now_ms: int, timeout_s: float = 2.0) -> IpSample:
    """The fallback, used only when a whole DNS round has failed.

    Deliberately not a normal source: it is one more party learning this
    machine's address, and it is slower. It exists so a network that blocks
    outbound DNS to everything but its own resolver still reports an address.
    """
    import httpx

    for url in ("https://api.ipify.org", "https://ifconfig.me/ip"):
        try:
            async with httpx.AsyncClient(timeout=timeout_s) as client:
                response = await client.get(url, headers={"accept": "text/plain"})
            address = parse_ipv4(response.text)
            if address:
                return IpSample(now_ms, f"http:{url}", address, True)
        except Exception:  # noqa: BLE001 - any failure is just "try the next one"
            continue
    return IpSample(now_ms, "http", None, False, "no HTTP fallback answered")
