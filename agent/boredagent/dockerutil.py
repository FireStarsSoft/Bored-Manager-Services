"""The Docker half, wrapped so nothing else imports the SDK directly.

Two things this file is careful about:

- **Inspect is filtered, never passed through.** A container's raw inspect
  carries `Config.Env` and `Config.Cmd`, which is where every credential a
  template passed in ends up. `describe()` returns the handful of fields the
  API actually needs and drops the rest, so a secret cannot reach a client
  through a field nobody remembered to redact.
- **Absence is not an error.** A container that is not there is a normal state
  for this agent - it is what "installed, then removed behind our back" looks
  like - so it comes back as `absent` rather than raising.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

try:  # pragma: no cover - exercised by whether docker is installed
    import docker as docker_sdk
    from docker.errors import APIError, DockerException, ImageNotFound, NotFound
except ImportError:  # pragma: no cover
    docker_sdk = None

    class DockerException(Exception):  # type: ignore[no-redef]
        pass

    class APIError(DockerException):  # type: ignore[no-redef]
        pass

    class NotFound(DockerException):  # type: ignore[no-redef]
        pass

    class ImageNotFound(DockerException):  # type: ignore[no-redef]
        pass


#: Container states, as the agent reports them. `absent` is ours - Docker has
#: no state for a container that does not exist, but every caller needs one.
UNIT_STATES = ("absent", "created", "running", "exited", "paused", "restarting", "unhealthy", "dead")


@dataclass(frozen=True)
class UnitStatus:
    name: str
    state: str
    image: str | None = None
    status: str | None = None
    started_at: str | None = None
    restart_count: int = 0
    exit_code: int | None = None
    health: str | None = None

    def to_public(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "state": self.state,
            "image": self.image,
            "status": self.status,
            "startedAt": self.started_at,
            "restartCount": self.restart_count,
            "exitCode": self.exit_code,
            "health": self.health,
        }


class DockerUnavailable(RuntimeError):
    pass


class DockerClient:
    """A thin, lazy wrapper. The connection is made on first use so the agent
    still starts - and still monitors the network - on a machine where the
    Docker daemon is down or not installed."""

    def __init__(self, socket: str) -> None:
        self._socket = socket
        self._client: Any | None = None
        self._error: str | None = None

    @property
    def available(self) -> bool:
        try:
            self._connect()
        except DockerUnavailable:
            return False
        return True

    @property
    def error(self) -> str | None:
        return self._error

    def _connect(self) -> Any:
        if self._client is not None:
            return self._client
        if docker_sdk is None:
            self._error = "the docker Python package is not installed"
            raise DockerUnavailable(self._error)
        try:
            client = docker_sdk.DockerClient(base_url=self._socket)
            client.ping()
        except DockerException as err:
            self._error = f"cannot reach the Docker daemon at {self._socket}: {err}"
            raise DockerUnavailable(self._error) from err
        self._client = client
        self._error = None
        return client

    # ---------------------------------------------------------------- reading

    def describe(self, name: str) -> UnitStatus:
        """A container's state, with nothing in it that could carry a secret."""
        try:
            client = self._connect()
        except DockerUnavailable:
            return UnitStatus(name=name, state="absent")
        try:
            container = client.containers.get(name)
        except NotFound:
            return UnitStatus(name=name, state="absent")
        except DockerException as err:
            return UnitStatus(name=name, state="absent", status=str(err)[:200])

        attrs: dict[str, Any] = container.attrs or {}
        state: dict[str, Any] = attrs.get("State") or {}
        health = (state.get("Health") or {}).get("Status")
        raw_state = str(state.get("Status") or "created")
        # An unhealthy container is running as far as Docker is concerned, but
        # not as far as anyone watching a fleet is concerned.
        resolved = "unhealthy" if health == "unhealthy" else raw_state
        image = None
        config = attrs.get("Config") or {}
        if isinstance(config.get("Image"), str):
            image = config["Image"]
        return UnitStatus(
            name=name,
            state=resolved if resolved in UNIT_STATES else "created",
            image=image,
            status=str(state.get("Status") or ""),
            started_at=state.get("StartedAt"),
            restart_count=int(attrs.get("RestartCount") or 0),
            exit_code=state.get("ExitCode") if isinstance(state.get("ExitCode"), int) else None,
            health=health,
        )

    def logs(self, name: str, tail: int = 200, since: int | None = None, timestamps: bool = True) -> list[str]:
        try:
            client = self._connect()
            container = client.containers.get(name)
        except NotFound:
            return []
        except (DockerUnavailable, DockerException):
            return []
        try:
            raw = container.logs(tail=tail, since=since, timestamps=timestamps, stdout=True, stderr=True)
        except DockerException as err:
            return [f"[agent] could not read logs: {err}"]
        text = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw)
        return [line for line in text.splitlines() if line]

    def follow(self, name: str, tail: int = 100):
        """A generator of new log lines. The caller is responsible for closing it."""
        client = self._connect()
        container = client.containers.get(name)
        stream = container.logs(stream=True, follow=True, tail=tail, timestamps=True, stdout=True, stderr=True)
        for chunk in stream:
            text = chunk.decode("utf-8", errors="replace") if isinstance(chunk, bytes) else str(chunk)
            for line in text.splitlines():
                if line:
                    yield line

    def stats(self, name: str) -> dict[str, Any] | None:
        """One-shot stats for a container.

        `stream=False` on purpose: a streaming stats connection per container
        held open forever is what makes `docker stats` expensive, and once a
        minute is plenty to turn cumulative counters into deltas.
        """
        try:
            client = self._connect()
            container = client.containers.get(name)
            return container.stats(stream=False)
        except (DockerUnavailable, DockerException):
            return None

    # ---------------------------------------------------------------- writing

    def remove_container(self, name: str, force: bool = True) -> bool:
        try:
            client = self._connect()
            client.containers.get(name).remove(force=force)
            return True
        except NotFound:
            return False
        except DockerUnavailable:
            raise
        except DockerException as err:
            raise RuntimeError(f"could not remove {name}: {err}") from err

    def stop_container(self, name: str, timeout: int = 20) -> bool:
        try:
            client = self._connect()
            client.containers.get(name).stop(timeout=timeout)
            return True
        except NotFound:
            return False
        except DockerUnavailable:
            raise
        except DockerException as err:
            raise RuntimeError(f"could not stop {name}: {err}") from err

    def start_container(self, name: str) -> bool:
        try:
            client = self._connect()
            client.containers.get(name).start()
            return True
        except NotFound:
            return False
        except DockerException as err:
            raise RuntimeError(f"could not start {name}: {err}") from err

    def restart_container(self, name: str, timeout: int = 20) -> bool:
        try:
            client = self._connect()
            client.containers.get(name).restart(timeout=timeout)
            return True
        except NotFound:
            return False
        except DockerException as err:
            raise RuntimeError(f"could not restart {name}: {err}") from err

    def remove_image(self, reference: str) -> None:
        try:
            client = self._connect()
            client.images.remove(reference, force=False)
        except (ImageNotFound, NotFound):
            return
        except DockerException as err:
            raise RuntimeError(f"could not remove image {reference}: {err}") from err

    def pull(self, reference: str) -> None:
        client = self._connect()
        try:
            client.images.pull(reference)
        except DockerException as err:
            raise RuntimeError(f"could not pull {reference}: {err}") from err

    def run(
        self,
        *,
        name: str,
        image: str,
        args: list[str],
        env: dict[str, str],
        volumes: list[str],
        restart: str,
    ) -> str:
        """Create and start one container.

        `command` is a **list**, which is what keeps a value containing a space
        one argument instead of two. The SDK passes it to the daemon as an
        array, so no shell is involved anywhere in this path.
        """
        client = self._connect()
        policy = {"Name": restart} if restart and restart != "no" else {"Name": "no"}
        if restart == "on-failure":
            policy["MaximumRetryCount"] = 5
        try:
            container = client.containers.run(
                image,
                command=args or None,
                name=name,
                detach=True,
                environment=env or None,
                volumes=volumes or None,
                restart_policy=policy,
            )
        except APIError as err:
            raise RuntimeError(f"could not start {name}: {err}") from err
        return str(container.id)[:12]

    def info(self) -> dict[str, Any]:
        try:
            client = self._connect()
            raw = client.version()
        except (DockerUnavailable, DockerException):
            return {"available": False, "error": self._error}
        return {
            "available": True,
            "version": raw.get("Version"),
            "apiVersion": raw.get("ApiVersion"),
        }
