"""A whole agent, built around a fake Docker and a temporary state directory.

The app is assembled from `create_app` rather than from hand-wired parts, so
these tests exercise the same dependency graph production does - including the
auth dependencies, which are the thing most worth not accidentally testing
around.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from boredagent.app import create_app
from boredagent.config import Config, NetConfig, TelemetryConfig
from boredagent.dockerutil import UnitStatus

TOKEN = "0123456789abcdef" * 4


class FakeDocker:
    """Enough of DockerClient for the routes, with no daemon anywhere."""

    def __init__(self) -> None:
        self.containers: dict[str, dict[str, Any]] = {}
        self.pulled: list[str] = []
        self.log_lines: dict[str, list[str]] = {}

    # ---- reads
    def describe(self, name: str) -> UnitStatus:
        entry = self.containers.get(name)
        if entry is None:
            return UnitStatus(name=name, state="absent")
        return UnitStatus(
            name=name,
            state=entry.get("state", "running"),
            image=entry.get("image"),
            status=entry.get("state", "running"),
            restart_count=entry.get("restarts", 0),
            exit_code=entry.get("exit_code"),
        )

    def logs(self, name: str, tail: int = 200, since=None, timestamps=True) -> list[str]:
        return self.log_lines.get(name, [])[-tail:]

    def follow(self, name: str, tail: int = 100):
        yield from self.log_lines.get(name, [])

    def stats(self, name: str):
        entry = self.containers.get(name)
        if entry is None:
            return None
        return {"networks": {"eth0": {"rx_bytes": entry.get("rx", 0), "tx_bytes": entry.get("tx", 0)}}}

    def info(self) -> dict[str, Any]:
        return {"available": True, "version": "fake"}

    # ---- writes
    def remove_container(self, name: str, force: bool = True) -> bool:
        return self.containers.pop(name, None) is not None

    def stop_container(self, name: str, timeout: int = 20) -> bool:
        if name not in self.containers:
            return False
        self.containers[name]["state"] = "exited"
        self.containers[name]["exit_code"] = 0
        return True

    def start_container(self, name: str) -> bool:
        if name not in self.containers:
            return False
        self.containers[name]["state"] = "running"
        return True

    def restart_container(self, name: str, timeout: int = 20) -> bool:
        if name not in self.containers:
            return False
        self.containers[name]["state"] = "running"
        self.containers[name]["restarts"] = self.containers[name].get("restarts", 0) + 1
        return True

    def remove_image(self, reference: str) -> None:
        return None

    def pull(self, reference: str) -> None:
        self.pulled.append(reference)

    def run(self, *, name, image, args, env, volumes, restart) -> str:
        self.containers[name] = {
            "state": "running",
            "image": image,
            "args": args,
            "env": env,
            "restarts": 0,
        }
        return "deadbeefcafe"[:12]


@pytest.fixture
def state_dir(tmp_path: Path) -> Path:
    return tmp_path / "state"


@pytest.fixture
def config(state_dir: Path) -> Config:
    return Config(
        state_dir=state_dir,
        token_file=state_dir / "token",
        # The probe loops would otherwise start real subprocesses during tests.
        net=NetConfig(interval_s=3600.0),
        telemetry=TelemetryConfig(enabled=False),
    )


@pytest.fixture
def docker() -> FakeDocker:
    return FakeDocker()


@pytest.fixture
def client(config: Config, docker: FakeDocker):
    app = create_app(config, token=TOKEN)
    with TestClient(app) as test_client:
        # Swap the real Docker client for the fake once the lifespan has built
        # the runtime, so the wiring under test is the production wiring.
        app.state.runtime.docker = docker
        app.state.runtime.instances._docker = docker
        test_client.headers.update({"authorization": f"Bearer {TOKEN}"})
        yield test_client


@pytest.fixture
def honeygain_doc() -> dict[str, Any]:
    root = Path(__file__).resolve().parents[2] / "service-fleet" / "templates"
    return json.loads((root / "honeygain.container.json").read_text(encoding="utf-8"))


@pytest.fixture
def packetstream_doc() -> dict[str, Any]:
    root = Path(__file__).resolve().parents[2] / "service-fleet" / "templates"
    return json.loads((root / "packetstream.container.json").read_text(encoding="utf-8"))
