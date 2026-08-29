"""Two independent one-second loops: is there internet, and what is our address.

Independent on purpose. Reachability and public IP fail for different reasons
and at different rates, and a single loop doing both would either halve the
rotation of each pool or make one wait on the other's timeout.

Each loop runs **one** probe per tick and moves to the next entry in its pool.
That is what makes an outage distinguishable from one operator having a bad
day: over seven seconds the ping loop has asked Cloudflare, Google, Quad9 and
OpenDNS, so "everything failed" means something, where "8.8.8.8 failed" would
not.
"""

from __future__ import annotations

import asyncio
import statistics
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ..config import NetConfig, TelemetryConfig
from .probes import IpSample, PingSample, ping_once, public_ip_http, public_ip_once


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class NetEvent:
    type: str
    ts: int
    data: dict[str, Any] = field(default_factory=dict)

    def to_public(self) -> dict[str, Any]:
        return {"type": self.type, "ts": self.ts, **self.data}


class NetMonitor:
    """Live reachability and public-IPv4 state, plus a short history of each."""

    def __init__(
        self,
        config: NetConfig,
        telemetry: TelemetryConfig | None = None,
        on_event: Callable[[NetEvent], None] | None = None,
        on_ping: Callable[[PingSample], None] | None = None,
    ) -> None:
        self._config = config
        self._telemetry = telemetry or TelemetryConfig()
        self._on_event = on_event
        self._on_ping = on_ping

        self._pings: deque[PingSample] = deque(maxlen=max(10, config.history_size))
        self._ips: deque[IpSample] = deque(maxlen=max(10, config.history_size))
        self._last_by_target: dict[str, PingSample] = {}

        self._online: bool | None = None
        self._public_ip: str | None = None
        self._last_ip_source: str | None = None
        self._last_ip_error: str | None = None
        self._last_change_at: int | None = None
        self._last_http_fallback = 0.0
        self._dns_round_failures = 0

        # Latency-episode state. An episode is one event with a peak and a
        # duration, not one event per slow tick - a flapping link would
        # otherwise write thousands of rows nobody can read.
        self._spike_run = 0
        self._spike_started: int | None = None
        self._spike_peak = 0.0

        self._tasks: list[asyncio.Task[None]] = []
        self._stopping = asyncio.Event()

    # ------------------------------------------------------------- lifecycle

    def start(self) -> None:
        if self._tasks:
            return
        self._stopping.clear()
        self._tasks = [
            asyncio.create_task(self._ping_loop(), name="boredagent-ping"),
            asyncio.create_task(self._ip_loop(), name="boredagent-ip"),
        ]

    async def stop(self) -> None:
        self._stopping.set()
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        self._tasks = []

    # ------------------------------------------------------------------ loops

    async def _sleep(self) -> bool:
        """Wait one interval; False when the agent is shutting down."""
        try:
            await asyncio.wait_for(self._stopping.wait(), timeout=self._config.interval_s)
        except asyncio.TimeoutError:
            return True
        return False

    async def _ping_loop(self) -> None:
        targets = list(self._config.ping_targets) or ["1.1.1.1"]
        index = 0
        while await self._sleep():
            target = targets[index % len(targets)]
            index += 1
            try:
                sample = await ping_once(target, _now_ms(), self._config.ping_timeout_s)
            except Exception as err:  # noqa: BLE001 - a probe must never kill the loop
                sample = PingSample(_now_ms(), target, False, None, str(err)[:120])
            self._record_ping(sample)

    async def _ip_loop(self) -> None:
        sources = list(self._config.ip_sources)
        if not sources:
            return
        index = 0
        while await self._sleep():
            name, args = sources[index % len(sources)]
            round_ended = index % len(sources) == len(sources) - 1
            index += 1
            try:
                sample = await public_ip_once(name, args, _now_ms(), self._config.ping_timeout_s)
            except Exception as err:  # noqa: BLE001
                sample = IpSample(_now_ms(), name, None, False, str(err)[:120])
            self._record_ip(sample)

            if sample.ok:
                self._dns_round_failures = 0
            elif round_ended:
                self._dns_round_failures += 1
                await self._maybe_http_fallback()

    async def _maybe_http_fallback(self) -> None:
        """Only after a whole DNS round failed, and at most once per window."""
        now = time.monotonic()
        if now - self._last_http_fallback < self._config.http_ip_fallback_s:
            return
        self._last_http_fallback = now
        try:
            sample = await public_ip_http(_now_ms())
        except Exception as err:  # noqa: BLE001
            sample = IpSample(_now_ms(), "http", None, False, str(err)[:120])
        self._record_ip(sample)

    # ---------------------------------------------------------------- recording

    def _record_ping(self, sample: PingSample) -> None:
        self._pings.append(sample)
        self._last_by_target[sample.target] = sample
        if self._on_ping:
            self._on_ping(sample)

        window = list(self._pings)[-self._config.offline_window :]
        successes = sum(1 for s in window if s.ok)
        if len(window) >= min(self._config.offline_window, 2):
            # Online on a majority; offline only when the entire window failed.
            # The asymmetry is the point: one operator blocking ICMP should not
            # read as an outage, and a single reply should not clear one.
            if successes == 0:
                online = False
            elif successes * 2 > len(window):
                online = True
            else:
                online = self._online if self._online is not None else False
            if online != self._online:
                previous = self._online
                self._online = online
                self._last_change_at = sample.ts
                if previous is not None:
                    self._emit(
                        NetEvent(
                            "link_up" if online else "link_down",
                            sample.ts,
                            {"window": len(window), "ok": successes},
                        )
                    )

        self._track_spike(sample)

    def _track_spike(self, sample: PingSample) -> None:
        """Open an episode when latency stays high; close it with one event."""
        recent = [s.latency_ms for s in self._pings if s.ok and s.latency_ms is not None]
        if len(recent) < 10:
            return
        median = statistics.median(recent[-60:]) or 0.0
        threshold = max(median * self._telemetry.spike_factor, self._telemetry.spike_floor_ms)

        latency = sample.latency_ms if sample.ok else None
        over = latency is not None and latency > threshold
        if over:
            self._spike_run += 1
            self._spike_peak = max(self._spike_peak, latency or 0.0)
            if self._spike_started is None:
                self._spike_started = sample.ts
            return

        if self._spike_run >= self._telemetry.spike_samples and self._spike_started is not None:
            self._emit(
                NetEvent(
                    "latency_spike",
                    sample.ts,
                    {
                        "startedAt": self._spike_started,
                        "durationMs": sample.ts - self._spike_started,
                        "peakMs": round(self._spike_peak, 1),
                        "baselineMs": round(median, 1),
                        "samples": self._spike_run,
                    },
                )
            )
        self._spike_run = 0
        self._spike_started = None
        self._spike_peak = 0.0

    def _record_ip(self, sample: IpSample) -> None:
        self._ips.append(sample)
        self._last_ip_source = sample.source
        if not sample.ok:
            # A failed tick keeps the last known address rather than blanking
            # it: "we could not ask" is not "the address went away".
            self._last_ip_error = sample.error
            return
        self._last_ip_error = None
        if sample.public_ip and sample.public_ip != self._public_ip:
            previous = self._public_ip
            self._public_ip = sample.public_ip
            if previous is not None:
                self._emit(
                    NetEvent(
                        "ip_changed",
                        sample.ts,
                        {"from": previous, "to": sample.public_ip, "source": sample.source},
                    )
                )

    def _emit(self, event: NetEvent) -> None:
        if self._on_event:
            try:
                self._on_event(event)
            except Exception:  # noqa: BLE001 - a listener must not stop monitoring
                pass

    # ------------------------------------------------------------------ reads

    @property
    def online(self) -> bool | None:
        return self._online

    @property
    def public_ip(self) -> str | None:
        return self._public_ip

    @property
    def last_ping(self) -> PingSample | None:
        return self._pings[-1] if self._pings else None

    def recent_latencies(self) -> list[float]:
        return [s.latency_ms for s in self._pings if s.ok and s.latency_ms is not None]

    def status(self) -> dict[str, Any]:
        last = self.last_ping
        return {
            "online": self._online,
            "offlineWindow": self._config.offline_window,
            "latencyMs": last.latency_ms if last and last.ok else None,
            "lastPingTarget": last.target if last else None,
            "publicIp": self._public_ip,
            "lastIpSource": self._last_ip_source,
            "lastIpError": self._last_ip_error,
            "lastChangeAt": self._last_change_at,
            "intervalS": self._config.interval_s,
            "lastByTarget": {
                target: sample.to_public() for target, sample in sorted(self._last_by_target.items())
            },
        }

    def history(self, kind: str, limit: int = 300) -> list[dict[str, Any]]:
        source = self._pings if kind == "ping" else self._ips
        capped = max(1, min(limit, len(source)))
        return [sample.to_public() for sample in list(source)[-capped:]]
