"""Reachability, public address, and the telemetry built on top of them."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request

from .deps import bad_request, parse_ms, runtime

router = APIRouter(prefix="/v1", tags=["net"])


@router.get("/net/status")
def net_status(request: Request) -> dict[str, Any]:
    return runtime(request).monitor.status()


@router.get("/net/history")
def net_history(request: Request, kind: str = "ping", limit: int = 300) -> dict[str, Any]:
    if kind not in {"ping", "ip"}:
        raise bad_request('kind has to be "ping" or "ip"')
    rows = runtime(request).monitor.history(kind, max(1, min(limit, 5000)))
    return {"kind": kind, "samples": rows}


@router.get("/stats/current")
def stats_current(request: Request) -> dict[str, Any]:
    """Today so far, without waiting for the day boundary."""
    collector = runtime(request).telemetry
    if collector is None:
        return {"enabled": False}
    return {"enabled": True, **collector.current()}


@router.get("/stats/daily")
def stats_daily(
    request: Request,
    since: str | None = None,
    until: str | None = None,
    limit: int = 2000,
) -> dict[str, Any]:
    """One row per unit per day, plus one per host per day.

    This is what a fleet manager reads to backfill: the agent keeps well over a
    year of these, so a manager that was switched off for a week asks for the
    days it missed rather than losing them.
    """
    collector = runtime(request).telemetry
    if collector is None:
        return {"enabled": False, "rows": []}
    rows = collector.daily(parse_ms(since, "since"), parse_ms(until, "until"), max(1, min(limit, 5000)))
    return {"enabled": True, "rows": rows}


@router.get("/stats/events")
def stats_events(
    request: Request,
    since: str | None = None,
    until: str | None = None,
    kind: str | None = None,
    limit: int = 2000,
) -> dict[str, Any]:
    collector = runtime(request).telemetry
    if collector is None:
        return {"enabled": False, "rows": []}
    rows = collector.events(
        parse_ms(since, "since"), parse_ms(until, "until"), kind, max(1, min(limit, 5000))
    )
    return {"enabled": True, "rows": rows}
