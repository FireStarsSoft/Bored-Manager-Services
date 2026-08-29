"""Telemetry on disk: raw samples, incidents, and one row per unit per day.

Three JSONL series, one file per day each, under `/var/lib/boredagent/telemetry`.
Same shape as the module-side record store in the app, and for the same reason:
appending a line is cheap and crash-safe, a day is a natural unit to sweep, and
a filename that sorts chronologically makes a range query a file filter rather
than a scan.

The retention split is the interesting part. Raw samples are kept for days and
daily rows for **over a year**, because they answer different questions: raw
samples are for working out why yesterday's rollup looks odd, and a daily row is
the answer somebody wants in six months. A daily row is also about 200 bytes, so
400 of them per unit is nothing.

Keeping that year locally is what lets the module backfill: a module that was
switched off for a week asks for the days it missed and gets them, instead of
those days being lost because nothing was listening.
"""

from __future__ import annotations

import calendar
import json
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Iterator

DAY_MS = 86_400_000
DAY_FILE_RE = re.compile(r"^(\d{8})\.jsonl$")

#: Series names, which are also the directory names.
SAMPLES = "samples"
EVENTS = "events"
DAILY = "daily"


def day_key(ts_ms: int, offset_min: int = 0) -> str:
    """`YYYYMMDD` for a timestamp, in the configured local day.

    The offset exists so a rollup boundary can match the operator's midnight
    rather than UTC's - a household reading "yesterday's total" means their
    yesterday.
    """
    shifted = time.gmtime((ts_ms + offset_min * 60_000) / 1000)
    return time.strftime("%Y%m%d", shifted)


def day_start_ms(key: str, offset_min: int = 0) -> int:
    """The first millisecond of the day this key names.

    `calendar.timegm` rather than `time.mktime`: the key was produced from a
    UTC-based struct in `day_key`, and mktime would read it back as local time,
    shifting every bucket boundary by the server's own timezone.
    """
    parsed = time.strptime(key, "%Y%m%d")
    return calendar.timegm(parsed) * 1000 - offset_min * 60_000


@dataclass(frozen=True)
class Row:
    ts: int
    data: dict[str, Any]


class Series:
    """One append-only JSONL series, bucketed by day."""

    def __init__(self, directory: Path, retention_days: int) -> None:
        self._dir = directory
        self._retention_days = max(1, retention_days)
        self._dir.mkdir(parents=True, exist_ok=True, mode=0o700)

    def append(self, row: dict[str, Any], offset_min: int = 0) -> None:
        ts = int(row.get("ts") or time.time() * 1000)
        row = {**row, "ts": ts}
        path = self._dir / f"{day_key(ts, offset_min)}.jsonl"
        try:
            with open(path, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(row, sort_keys=True) + "\n")
            os.chmod(path, 0o600)
        except OSError:
            # Telemetry is never worth failing an action over: an agent that
            # cannot write a sample must still be able to manage its services.
            pass

    def _files(self) -> list[tuple[str, Path]]:
        try:
            out = []
            for entry in self._dir.iterdir():
                match = DAY_FILE_RE.match(entry.name)
                if match:
                    out.append((match.group(1), entry))
            return sorted(out)
        except OSError:
            return []

    def read(
        self,
        since_ms: int | None = None,
        until_ms: int | None = None,
        limit: int = 5000,
        offset_min: int = 0,
    ) -> list[dict[str, Any]]:
        """Rows in a window, oldest first, capped.

        Whole day files outside the window are never opened - which is what
        keeps "the last week" cheap when a year is on disk.
        """
        lower = since_ms if since_ms is not None else -(2**62)
        upper = until_ms if until_ms is not None else 2**62
        out: list[dict[str, Any]] = []
        for key, path in self._files():
            start = day_start_ms(key, offset_min)
            if start + DAY_MS < lower or start > upper:
                continue
            for row in _read_rows(path):
                ts = row.get("ts")
                if not isinstance(ts, int) or ts < lower or ts > upper:
                    continue
                out.append(row)
                if len(out) >= limit:
                    return out
        return out

    def sweep(self, now_ms: int | None = None) -> int:
        """Delete day files past retention. Answers how many went."""
        cutoff = (now_ms or int(time.time() * 1000)) - self._retention_days * DAY_MS
        removed = 0
        for key, path in self._files():
            if day_start_ms(key) + DAY_MS > cutoff:
                continue
            try:
                path.unlink(missing_ok=True)
                removed += 1
            except OSError:
                continue
        return removed

    def days(self) -> list[str]:
        return [key for key, _ in self._files()]


def _read_rows(path: Path) -> Iterator[dict[str, Any]]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return
    for line in text.splitlines():
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            # One torn line - a crash mid-append - must not hide the rest of
            # the day.
            continue
        if isinstance(parsed, dict):
            yield parsed


class TelemetryStore:
    def __init__(self, root: Path, raw_days: int, daily_days: int, offset_min: int = 0) -> None:
        self.samples = Series(root / SAMPLES, raw_days)
        self.events = Series(root / EVENTS, daily_days)
        self.daily = Series(root / DAILY, daily_days)
        self._offset_min = offset_min

    def add_sample(self, row: dict[str, Any]) -> None:
        self.samples.append(row, self._offset_min)

    def add_event(self, row: dict[str, Any]) -> None:
        self.events.append(row, self._offset_min)

    def add_daily(self, rows: Iterable[dict[str, Any]]) -> None:
        for row in rows:
            self.daily.append(row, self._offset_min)

    def sweep(self) -> dict[str, int]:
        return {
            SAMPLES: self.samples.sweep(),
            EVENTS: self.events.sweep(),
            DAILY: self.daily.sweep(),
        }
