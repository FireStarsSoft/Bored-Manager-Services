"""The FastAPI application, and the one place everything is assembled.

`Runtime` holds what the routes need and is built once in the lifespan, so
nothing in this package reaches for a module-level global. That is what lets a
test build a whole app around fake Docker and a temporary state directory.

The ordering in the lifespan is deliberate: stores first (they only touch
disk), then the monitor (which starts probing immediately), then telemetry
(which reads through the other two). Shutdown reverses it, and the telemetry
collector flushes the partial day on its way out so a restart does not lose the
hours since midnight.
"""

from __future__ import annotations

import time
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import __version__, systemdutil
from .auth import require_token
from .config import Config, load_config, load_token
from .dockerutil import DockerClient
from .engine.instances import InstanceManager
from .net.monitor import NetEvent, NetMonitor
from .store import CredentialStore, InstanceStore, TemplateStore
from .telemetry.collector import TelemetryCollector
from .telemetry.store import TelemetryStore
from .templates.registry import TemplateRegistry

#: Events held for the live channel between frames. Bounded, because a client
#: that never connects must not be able to grow this without limit.
EVENT_BUFFER = 200


@dataclass
class Runtime:
    config: Config
    docker: DockerClient
    credentials: CredentialStore
    registry: TemplateRegistry
    instances: InstanceManager
    monitor: NetMonitor
    telemetry: TelemetryCollector | None = None
    _events: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=EVENT_BUFFER))

    def push_event(self, event: NetEvent) -> None:
        self._events.append(event.to_public())
        if self.telemetry is not None:
            self.telemetry.record_event(event.type, event.data, event.ts)

    def drain_events(self) -> list[dict[str, Any]]:
        out = list(self._events)
        self._events.clear()
        return out


def build_runtime(config: Config) -> Runtime:
    docker = DockerClient(config.docker.socket)
    credentials = CredentialStore(config.credentials_file)
    registry = TemplateRegistry(TemplateStore(config.templates_dir))
    instances = InstanceManager(registry, credentials, InstanceStore(config.instances_file), docker)
    runtime = Runtime(
        config=config,
        docker=docker,
        credentials=credentials,
        registry=registry,
        instances=instances,
        monitor=NetMonitor(config.net, config.telemetry),
    )
    # Wired after construction because the monitor's listener needs the runtime
    # that holds the monitor.
    runtime.monitor._on_event = runtime.push_event  # noqa: SLF001 - one-time wiring
    if config.telemetry.enabled:
        runtime.telemetry = TelemetryCollector(
            config.telemetry,
            TelemetryStore(
                config.telemetry_dir,
                config.telemetry.raw_days,
                config.telemetry.daily_days,
                config.telemetry.day_offset_min,
            ),
            docker,
            instances,
            runtime.monitor,
        )
    return runtime


def create_app(config: Config | None = None, token: str | None = None) -> FastAPI:
    resolved = config or load_config()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        runtime = build_runtime(resolved)
        app.state.runtime = runtime
        app.state.token = token if token is not None else load_token(resolved)
        app.state.started_at = int(time.time() * 1000)
        runtime.monitor.start()
        if runtime.telemetry:
            runtime.telemetry.start()
        try:
            yield
        finally:
            if runtime.telemetry:
                await runtime.telemetry.stop()
            await runtime.monitor.stop()

    app = FastAPI(
        title="BoredAgent",
        version=__version__,
        lifespan=lifespan,
        # The docs are behind the same token as everything else. They are a
        # complete description of what this agent will do when asked, which is
        # not something to hand out on a LAN.
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    if resolved.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(resolved.cors_origins),
            allow_credentials=False,
            allow_methods=["GET", "POST", "PUT", "DELETE"],
            allow_headers=["authorization", "content-type"],
        )

    @app.get("/v1/health", tags=["health"])
    def health() -> dict[str, Any]:
        """The only route without a token.

        Deliberately says nothing but "an agent is here and which version it
        is": a fleet manager needs to tell a reachable-but-unauthorised agent
        from an unreachable one, and that is the whole job.
        """
        return {"ok": True, "service": "boredagent", "version": __version__}

    @app.get("/v1/info", tags=["health"], dependencies=[Depends(require_token)])
    def info(request: Request) -> dict[str, Any]:
        rt: Runtime = request.app.state.runtime
        return {
            "service": "boredagent",
            "version": __version__,
            "startedAt": request.app.state.started_at,
            "docker": rt.docker.info(),
            "systemd": systemdutil.info(),
            "telemetry": {
                "enabled": rt.telemetry is not None,
                "sampleSeconds": resolved.telemetry.sample_s,
                "dailyDays": resolved.telemetry.daily_days,
            },
            "net": {
                "intervalSeconds": resolved.net.interval_s,
                "pingTargets": list(resolved.net.ping_targets),
                "ipSources": [name for name, _ in resolved.net.ip_sources],
            },
        }

    # Everything below this line needs the token. The dependency is attached to
    # the routers rather than to each route, so a route added later cannot be
    # left unauthenticated by forgetting it.
    from .api import routes_instances, routes_live, routes_net, routes_templates

    app.include_router(routes_templates.router, dependencies=[Depends(require_token)])
    app.include_router(routes_instances.router, dependencies=[Depends(require_token)])
    app.include_router(routes_net.router, dependencies=[Depends(require_token)])
    # This router protects its own routes: the SSE one carries the dependency
    # on the route, and the WebSocket checks the query token itself, because a
    # dependency raising HTTPException cannot answer a handshake.
    app.include_router(routes_live.router)

    @app.exception_handler(RuntimeError)
    async def runtime_error(_: Request, err: RuntimeError) -> JSONResponse:
        """A failure that came from Docker or systemd, not from the request."""
        return JSONResponse(status_code=502, content={"detail": str(err)})

    return app
