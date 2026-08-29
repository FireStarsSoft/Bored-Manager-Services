"""The live channel: one frame a second, and log lines only if asked for.

A client that connects gets network and instance state on a timer. Log lines
are **opt-in** - a subscriber has to name a template and a unit - because a
fleet manager watching fifty agents wants fifty state frames a second and not
fifty log firehoses.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter, Depends, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse

from ..auth import require_token, token_matches
from .deps import runtime

router = APIRouter(prefix="/v1", tags=["live"])

#: How often a live frame goes out when nothing has happened.
FRAME_INTERVAL_S = 1.0


def _frame(rt: Any) -> dict[str, Any]:
    monitor = rt.monitor
    last = monitor.last_ping
    return {
        "ts": last.ts if last else None,
        "net": {
            "online": monitor.online,
            "latencyMs": last.latency_ms if last and last.ok else None,
            "pingTarget": last.target if last else None,
            "publicIp": monitor.public_ip,
        },
        "instances": {
            row["id"]: {"state": row["state"], "units": {u["name"]: u["state"] for u in row["units"]}}
            for row in rt.instances.list()
        },
        "events": rt.drain_events(),
    }


# The token is required on this route rather than on the router, because the
# WebSocket below cannot use an HTTP dependency - a handshake has no way to
# carry a 401. Putting it here keeps SSE authenticated without making the
# router look as though it protects both.
@router.get("/live/sse", dependencies=[Depends(require_token)])
async def live_sse(request: Request) -> StreamingResponse:
    rt = runtime(request)

    async def events():
        while True:
            if await request.is_disconnected():
                return
            yield f"data: {json.dumps(_frame(rt))}\n\n"
            await asyncio.sleep(FRAME_INTERVAL_S)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"cache-control": "no-cache", "x-accel-buffering": "no"},
    )


@router.websocket("/ws/live")
async def live_ws(websocket: WebSocket) -> None:
    """The same frames, plus an optional log subscription.

    The token arrives in the query string because a browser cannot set a header
    on a WebSocket handshake. The connection is closed with 1008 rather than
    accepted-then-closed, so a client with a bad token learns why immediately.
    """
    expected = getattr(websocket.app.state, "token", "")
    if not token_matches(websocket.query_params.get("token"), expected):
        await websocket.close(code=1008, reason="a valid token is required")
        return

    await websocket.accept()
    rt = websocket.app.state.runtime
    subscription: dict[str, str] | None = None
    log_task: asyncio.Task[None] | None = None
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=500)

    async def pump_logs(template_id: str, unit: str) -> None:
        template = rt.instances.template(template_id)
        if template is None:
            await queue.put({"type": "error", "message": f'no template "{template_id}"'})
            return
        source = rt.instances.follow(template, unit)
        if source is None:
            await queue.put({"type": "error", "message": f'"{unit}" is not a unit of {template_id}'})
            return
        loop = asyncio.get_running_loop()

        def pump() -> None:
            for resolved, line in source:
                payload = {"type": "log", "template": template_id, "unit": resolved, "line": line}
                try:
                    loop.call_soon_threadsafe(queue.put_nowait, payload)
                except asyncio.QueueFull:
                    pass

        await loop.run_in_executor(None, pump)

    async def receive() -> None:
        """Read subscribe messages until the client goes away."""
        nonlocal subscription, log_task
        while True:
            raw = await websocket.receive_text()
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                await websocket.send_text(json.dumps({"type": "error", "message": "not JSON"}))
                continue
            wanted = message.get("subscribe") if isinstance(message, dict) else None
            if not isinstance(wanted, list) or not wanted or wanted[0] != "logs":
                continue
            if log_task:
                log_task.cancel()
                log_task = None
            if len(wanted) < 2:
                subscription = None
                continue
            template_id = str(wanted[1])
            unit = str(wanted[2]) if len(wanted) > 2 else ""
            template = rt.instances.template(template_id)
            resolved = unit or (template.primary_unit if template else "")
            subscription = {"template": template_id, "unit": resolved or ""}
            log_task = asyncio.create_task(pump_logs(template_id, resolved or ""))

    reader = asyncio.create_task(receive())
    try:
        while True:
            if reader.done():
                return
            await websocket.send_text(json.dumps({"type": "frame", **_frame(rt)}))
            deadline = asyncio.get_running_loop().time() + FRAME_INTERVAL_S
            # Drain whatever log lines arrived during this frame's window,
            # rather than sleeping and letting them queue up behind the frame.
            while True:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    break
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=remaining)
                except asyncio.TimeoutError:
                    break
                await websocket.send_text(json.dumps(item))
    except (WebSocketDisconnect, RuntimeError):
        return
    finally:
        reader.cancel()
        if log_task:
            log_task.cancel()
