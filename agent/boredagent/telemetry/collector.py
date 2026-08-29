"""The telemetry loop: sample, notice, and fold each day into one row per unit.

Three jobs on one timer:

1. **Sample** every unit's byte counters and state, once a minute.
2. **Notice** the things worth an incident row - a unit that went down, one that
   crashed rather than stopped, a hole in our own heartbeat - and write one row
   per episode rather than one per tick.
3. **Roll up** at the day boundary into a row per unit and a row per host.

The heartbeat is what makes the third job honest. Without it, a day the agent
spent switched off would roll up as a day of zero traffic and full uptime,
because nothing recorded that nobody was looking. Every sample writes the time
it ran; a gap between consecutive samples larger than the interval allows is
recorded as `agent_gap`, and the rollup counts that time as unknown rather than
as uptime.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any

from ..config import TelemetryConfig
from ..dockerutil import DockerClient
from ..templates.model import Template
from . import bandwidth
from .store import DAY_MS, TelemetryStore, day_key, day_start_ms


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class UnitMemory:
    """What the collector remembers about one unit between samples."""

    last_counters: bandwidth.Counters | None = None
    last_state: str | None = None
    last_restart_count: int = 0
    day: str | None = None
    rx: int = 0
    tx: int = 0
    partial: bool = False
    samples: int = 0
    running_samples: int = 0
    restarts: int = 0
    unknown_samples: int = 0


@dataclass
class HostMemory:
    day: str | None = None
    latencies: list[float] = field(default_factory=list)
    online_samples: int = 0
    samples: int = 0
    public_ips: set[str] = field(default_factory=set)
    events: dict[str, int] = field(default_factory=dict)


class TelemetryCollector:
    def __init__(
        self,
        config: TelemetryConfig,
        store: TelemetryStore,
        docker: DockerClient,
        instances,
        monitor,
    ) -> None:
        self._config = config
        self._store = store
        self._docker = docker
        self._instances = instances
        self._monitor = monitor
        self._bandwidth = bandwidth.UnitBandwidth()
        self._units: dict[str, UnitMemory] = {}
        self._host = HostMemory()
        self._last_sample_ms: int | None = None
        self._task: asyncio.Task[None] | None = None
        self._stopping = asyncio.Event()

    # ------------------------------------------------------------- lifecycle

    def start(self) -> None:
        if self._task or not self._config.enabled:
            return
        self._stopping.clear()
        self._task = asyncio.create_task(self._loop(), name="boredagent-telemetry")

    async def stop(self) -> None:
        self._stopping.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._task = None
        # Fold whatever this partial day holds, so a clean shutdown does not
        # lose the hours since midnight.
        self.flush_day(_now_ms())

    async def _loop(self) -> None:
        while True:
            try:
                await asyncio.wait_for(self._stopping.wait(), timeout=self._config.sample_s)
                return
            except asyncio.TimeoutError:
                pass
            try:
                self.sample()
            except Exception:  # noqa: BLE001 - telemetry never stops the agent
                continue

    # ---------------------------------------------------------------- sampling

    def record_event(self, kind: str, data: dict[str, Any] | None = None, ts: int | None = None) -> None:
        """One incident row. Called by the network monitor as well as from here."""
        moment = ts or _now_ms()
        self._store.add_event({"ts": moment, "kind": kind, **(data or {})})
        self._host.events[kind] = self._host.events.get(kind, 0) + 1

    def sample(self, now_ms: int | None = None) -> None:
        now = now_ms or _now_ms()
        self._check_day_boundary(now)
        self._check_heartbeat(now)

        # One `ss` read for every host-native unit in this tick, rather than one
        # per unit - see bandwidth.ss_output.
        templates = [loaded.template for loaded in self._instances._registry.load_all()]
        needs_ss = any(t.kind == "service" for t in templates)
        ss_text = bandwidth.ss_output() if needs_ss else ""

        for template in templates:
            for unit in self._instances.units_of(template):
                self._sample_unit(template, unit, now, ss_text)

        self._sample_host(now)
        self._last_sample_ms = now

    def _sample_unit(self, template: Template, unit, now: int, ss_text: str) -> None:
        key = f"{template.id}/{unit.name}"
        memory = self._units.setdefault(key, UnitMemory())

        current = self._bandwidth.read(template.kind, unit.name, self._docker, ss_text)
        step = bandwidth.delta(current, memory.last_counters)
        memory.last_counters = current

        if step is None:
            memory.unknown_samples += 1
        else:
            memory.rx += step.rx
            memory.tx += step.tx
            memory.partial = memory.partial or step.partial
        memory.samples += 1
        if unit.state == "running":
            memory.running_samples += 1

        # A restart is only visible as a counter going up. Docker's RestartCount
        # and systemd's NRestarts both survive across samples, so comparing them
        # catches a crash-restart that happened entirely between two ticks.
        if unit.restart_count > memory.last_restart_count:
            delta_restarts = unit.restart_count - memory.last_restart_count
            memory.restarts += delta_restarts
            self.record_event(
                "unit_crash",
                {
                    "template": template.id,
                    "unit": unit.name,
                    "restarts": delta_restarts,
                    "exitCode": unit.exit_code,
                },
                now,
            )
        memory.last_restart_count = unit.restart_count

        if memory.last_state is not None and unit.state != memory.last_state:
            if unit.state in {"exited", "absent", "dead", "unhealthy"}:
                # "Stopped" and "crashed" are different incidents. A non-zero
                # exit is the only thing that separates them after the fact.
                crashed = unit.exit_code not in (None, 0)
                self.record_event(
                    "unit_down",
                    {
                        "template": template.id,
                        "unit": unit.name,
                        "state": unit.state,
                        "exitCode": unit.exit_code,
                        "crashed": crashed,
                    },
                    now,
                )
            elif unit.state == "running" and memory.last_state in {"exited", "absent", "dead", "unhealthy"}:
                self.record_event(
                    "unit_up", {"template": template.id, "unit": unit.name}, now
                )
        memory.last_state = unit.state

        self._store.add_sample(
            {
                "ts": now,
                "template": template.id,
                "unit": unit.name,
                "state": unit.state,
                "rx": step.rx if step else None,
                "tx": step.tx if step else None,
                "partial": step.partial if step else None,
            }
        )

    def _sample_host(self, now: int) -> None:
        self._host.samples += 1
        if self._monitor.online:
            self._host.online_samples += 1
        latencies = self._monitor.recent_latencies()
        if latencies:
            self._host.latencies.append(latencies[-1])
        if self._monitor.public_ip:
            self._host.public_ips.add(self._monitor.public_ip)

    def _check_heartbeat(self, now: int) -> None:
        """A gap larger than two intervals means nobody was watching."""
        if self._last_sample_ms is None:
            return
        gap = now - self._last_sample_ms
        allowed = self._config.sample_s * 1000 * 2.5
        if gap > allowed:
            self.record_event(
                "agent_gap",
                {
                    "fromTs": self._last_sample_ms,
                    "toTs": now,
                    "durationMs": gap,
                    "note": "the agent was not running or not sampling; this time is not counted as uptime",
                },
                now,
            )
            # The gap is time nobody measured, so it counts against neither
            # uptime nor downtime.
            for memory in self._units.values():
                memory.unknown_samples += int(gap / (self._config.sample_s * 1000))

    # ----------------------------------------------------------------- rollup

    def _check_day_boundary(self, now: int) -> None:
        today = day_key(now, self._config.day_offset_min)
        if self._host.day is None:
            self._host.day = today
            for memory in self._units.values():
                memory.day = today
            return
        if self._host.day != today:
            self.flush_day(now)

    def flush_day(self, now: int) -> None:
        """Write one row per unit and one for the host, then start the next day."""
        day = self._host.day
        if day is None:
            return
        rows: list[dict[str, Any]] = []
        stamp = day_start_ms(day, self._config.day_offset_min) + DAY_MS // 2

        for key, memory in self._units.items():
            if not memory.samples:
                continue
            template_id, _, unit_name = key.partition("/")
            counted = max(1, memory.samples)
            rows.append(
                {
                    "ts": stamp,
                    "day": day,
                    "scope": "unit",
                    "template": template_id,
                    "unit": unit_name,
                    "rx": memory.rx,
                    "tx": memory.tx,
                    "bytes": memory.rx + memory.tx,
                    # True when any sample in the day came from the socket-counter
                    # method, which is a floor rather than a total.
                    "partial": memory.partial,
                    "samples": memory.samples,
                    "uptimeRatio": round(memory.running_samples / counted, 4),
                    "unknownSamples": memory.unknown_samples,
                    "restarts": memory.restarts,
                }
            )

        latencies = sorted(self._host.latencies)
        host_samples = max(1, self._host.samples)
        rows.append(
            {
                "ts": stamp,
                "day": day,
                "scope": "host",
                "onlineRatio": round(self._host.online_samples / host_samples, 4),
                "samples": self._host.samples,
                "latencyP50": _percentile(latencies, 0.50),
                "latencyP95": _percentile(latencies, 0.95),
                "latencyMax": latencies[-1] if latencies else None,
                "publicIps": sorted(self._host.public_ips),
                "events": dict(self._host.events),
            }
        )
        self._store.add_daily(rows)
        self._store.sweep()

        next_day = day_key(now, self._config.day_offset_min)
        self._host = HostMemory(day=next_day)
        for memory in self._units.values():
            memory.day = next_day
            memory.rx = 0
            memory.tx = 0
            memory.partial = False
            memory.samples = 0
            memory.running_samples = 0
            memory.restarts = 0
            memory.unknown_samples = 0

    # ------------------------------------------------------------------ reads

    def current(self) -> dict[str, Any]:
        """Today so far, without waiting for the boundary."""
        units = []
        for key, memory in self._units.items():
            template_id, _, unit_name = key.partition("/")
            counted = max(1, memory.samples)
            units.append(
                {
                    "template": template_id,
                    "unit": unit_name,
                    "rx": memory.rx,
                    "tx": memory.tx,
                    "bytes": memory.rx + memory.tx,
                    "partial": memory.partial,
                    "samples": memory.samples,
                    "uptimeRatio": round(memory.running_samples / counted, 4),
                    "restarts": memory.restarts,
                }
            )
        latencies = sorted(self._host.latencies)
        return {
            "day": self._host.day,
            "sinceMs": day_start_ms(self._host.day, self._config.day_offset_min)
            if self._host.day
            else None,
            "units": sorted(units, key=lambda row: (row["template"], row["unit"])),
            "host": {
                "onlineRatio": round(self._host.online_samples / max(1, self._host.samples), 4),
                "samples": self._host.samples,
                "latencyP50": _percentile(latencies, 0.50),
                "latencyP95": _percentile(latencies, 0.95),
                "publicIps": sorted(self._host.public_ips),
                "events": dict(self._host.events),
            },
        }

    def daily(self, since_ms: int | None, until_ms: int | None, limit: int = 5000) -> list[dict[str, Any]]:
        return self._store.daily.read(since_ms, until_ms, limit, self._config.day_offset_min)

    def events(
        self, since_ms: int | None, until_ms: int | None, kind: str | None, limit: int = 5000
    ) -> list[dict[str, Any]]:
        rows = self._store.events.read(since_ms, until_ms, limit, self._config.day_offset_min)
        return [row for row in rows if kind is None or row.get("kind") == kind]


def _percentile(sorted_values: list[float], fraction: float) -> float | None:
    if not sorted_values:
        return None
    index = min(len(sorted_values) - 1, max(0, int(round(fraction * (len(sorted_values) - 1)))))
    return round(sorted_values[index], 1)
