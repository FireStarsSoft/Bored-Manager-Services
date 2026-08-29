"""Lifecycle and logs for what a template installed on this machine."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Request, Response, status
from fastapi.responses import StreamingResponse

from .deps import bad_request, require_template, runtime, unit_or_404

router = APIRouter(prefix="/v1/instances", tags=["instances"])


@router.get("")
def list_instances(request: Request) -> dict[str, Any]:
    return {"instances": runtime(request).instances.list()}


@router.get("/{template_id}")
def get_instance(request: Request, template_id: str) -> dict[str, Any]:
    template = require_template(request, template_id)
    return runtime(request).instances.status(template)


@router.post("/{template_id}/install")
def install(request: Request, template_id: str, values: dict[str, Any], response: Response) -> dict[str, Any]:
    template = require_template(request, template_id)
    cleaned = {k: v if isinstance(v, str) else str(v) for k, v in (values or {}).items()}
    result = runtime(request).instances.install(template, cleaned)
    if not result.ok:
        # A refusal for a missing value is the caller's fault (422); anything
        # else got as far as the daemon and came back (502).
        response.status_code = (
            status.HTTP_422_UNPROCESSABLE_ENTITY
            if result.message.startswith("missing required values")
            else status.HTTP_502_BAD_GATEWAY
        )
    return result.to_public()


@router.post("/{template_id}/uninstall")
def uninstall(request: Request, template_id: str, response: Response, forget: int = 0) -> dict[str, Any]:
    template = require_template(request, template_id)
    result = runtime(request).instances.uninstall(template, forget=bool(forget))
    if not result.ok:
        response.status_code = status.HTTP_502_BAD_GATEWAY
    return result.to_public()


@router.post("/{template_id}/{verb}")
def lifecycle(request: Request, template_id: str, verb: str, response: Response) -> dict[str, Any]:
    if verb not in {"start", "stop", "restart", "validate"}:
        raise bad_request(f'"{verb}" is not start, stop, restart or validate')
    template = require_template(request, template_id)
    rt = runtime(request)
    if verb == "validate":
        return rt.instances.validate(template)
    result = rt.instances.lifecycle(template, verb)
    if not result.ok:
        response.status_code = status.HTTP_502_BAD_GATEWAY
    return result.to_public()


@router.get("/{template_id}/logs")
def logs(
    request: Request,
    template_id: str,
    tail: int = 200,
    since: str | None = None,
    timestamps: int = 1,
    unit: str | None = None,
) -> dict[str, Any]:
    template = require_template(request, template_id)
    rt = runtime(request)
    target = unit_or_404(template, unit)
    capped = max(1, min(tail, rt.config.logs.max_tail))
    read = rt.instances.logs(template, target, capped, since, bool(timestamps))
    if read is None:
        raise bad_request("that unit could not be read")
    resolved, lines = read
    return {"template": template.id, "unit": resolved, "tail": capped, "lines": lines}


@router.get("/{template_id}/logs/stream")
async def logs_stream(
    request: Request, template_id: str, tail: int = 100, unit: str | None = None
) -> StreamingResponse:
    """Server-sent events, one JSON object per line.

    The generator runs in a worker thread because the Docker SDK and
    `journalctl` are both blocking, and holding the event loop for the lifetime
    of a follow would stop every other request - including the one-second
    network probes.
    """
    template = require_template(request, template_id)
    rt = runtime(request)
    target = unit_or_404(template, unit)
    source = rt.instances.follow(template, target, tail=tail)
    if source is None:
        raise bad_request("that unit could not be followed")

    import json

    queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=1000)
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()

    def pump() -> None:
        try:
            for resolved, line in source:
                if stop.is_set():
                    return
                payload = json.dumps({"unit": resolved, "line": line})
                # A slow client must not grow an unbounded queue in the agent.
                # Dropping the oldest is better than holding a gigabyte for a
                # browser tab somebody closed.
                try:
                    loop.call_soon_threadsafe(queue.put_nowait, payload)
                except asyncio.QueueFull:
                    pass
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    worker = loop.run_in_executor(None, pump)

    async def events():
        try:
            while True:
                if await request.is_disconnected():
                    return
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    # A comment frame keeps proxies from closing an idle follow.
                    yield ": keep-alive\n\n"
                    continue
                if item is None:
                    return
                yield f"data: {item}\n\n"
        finally:
            stop.set()
            worker.cancel()

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"cache-control": "no-cache", "x-accel-buffering": "no"},
    )
