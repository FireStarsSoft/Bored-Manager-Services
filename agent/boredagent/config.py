"""Configuration, read once at startup from TOML with environment overrides.

The defaults here are the whole configuration: `/etc/boredagent/config.toml` is
generated from `config/config.example.toml` at install time and is never
overwritten by a later install, so an agent that has been running for a year
keeps whatever the operator set. That means every key has to have a sensible
default *in code* as well - a config file written by an older version will not
mention keys added since.
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field, replace
from pathlib import Path

DEFAULT_CONFIG_PATH = Path("/etc/boredagent/config.toml")

#: Round-robin pool for the reachability probe, in the order it is walked.
#: Four operators, so one of them blocking ICMP cannot read as "offline".
DEFAULT_PING_TARGETS: tuple[str, ...] = (
    "1.1.1.1",
    "1.0.0.1",
    "8.8.8.8",
    "8.8.4.4",
    "9.9.9.9",
    "208.67.222.222",
    "149.112.112.112",
)

#: Round-robin pool for "what is my public IPv4", as (name, argv) pairs.
#:
#: Cloudflare is deliberately absent: it is in the ping pool, and a source that
#: answers both questions would let one operator's outage look like two
#: independent failures agreeing with each other.
DEFAULT_IP_SOURCES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("google_ns1", ("txt", "o-o.myaddr.l.google.com", "@216.239.32.10")),
    ("google_ns2", ("txt", "o-o.myaddr.l.google.com", "@216.239.34.10")),
    ("google_ns3", ("txt", "o-o.myaddr.l.google.com", "@216.239.36.10")),
    ("google_ns4", ("txt", "o-o.myaddr.l.google.com", "@216.239.38.10")),
    ("opendns_1", ("myip.opendns.com", "@208.67.222.222")),
    ("opendns_2", ("myip.opendns.com", "@208.67.220.220")),
    ("akamai", ("whoami.akamai.net", "@193.108.91.2")),
)


@dataclass(frozen=True)
class DockerConfig:
    socket: str = "unix:///var/run/docker.sock"


@dataclass(frozen=True)
class LogConfig:
    #: Ceiling on `tail`; a client asking for more gets this.
    max_tail: int = 5000
    #: Run every line through redact.py before it leaves the process.
    redact: bool = True


@dataclass(frozen=True)
class NetConfig:
    interval_s: float = 1.0
    ping_timeout_s: float = 1.0
    #: Samples considered when deciding online/offline. Offline needs the whole
    #: window to fail, so one operator blocking ICMP is not an outage.
    offline_window: int = 5
    #: Ring-buffer length, per kind. 300 at 1s is five minutes.
    history_size: int = 300
    #: Least time between HTTP fallbacks, used only when a whole DNS round failed.
    http_ip_fallback_s: float = 15.0
    ping_targets: tuple[str, ...] = DEFAULT_PING_TARGETS
    ip_sources: tuple[tuple[str, tuple[str, ...]], ...] = DEFAULT_IP_SOURCES


@dataclass(frozen=True)
class TelemetryConfig:
    enabled: bool = True
    #: How often a unit's byte counters are read. Per minute is cheap; streaming
    #: `docker stats` is not, and this is the difference between the two.
    sample_s: float = 60.0
    #: Raw per-sample rows are only kept long enough to debug a bad rollup.
    raw_days: int = 7
    #: One row per unit per day is tiny, so this can be generous - it is what
    #: lets a module that was switched off for a week backfill the gap.
    daily_days: int = 400
    #: Local day boundary for the rollup. Offset in minutes from UTC.
    day_offset_min: int = 0
    #: A latency episode opens when RTT exceeds median * this...
    spike_factor: float = 3.0
    #: ...or this many milliseconds, whichever is larger. The floor stops a
    #: 2ms-median LAN from reporting a spike every time a packet takes 7ms.
    spike_floor_ms: float = 150.0
    #: Consecutive samples over the threshold before an episode is recorded.
    spike_samples: int = 3


@dataclass(frozen=True)
class Config:
    bind: str = "0.0.0.0"
    port: int = 8741
    token_file: Path = Path("/etc/boredagent/token")
    cors_origins: tuple[str, ...] = ("*",)
    state_dir: Path = Path("/var/lib/boredagent")
    docker: DockerConfig = field(default_factory=DockerConfig)
    logs: LogConfig = field(default_factory=LogConfig)
    net: NetConfig = field(default_factory=NetConfig)
    telemetry: TelemetryConfig = field(default_factory=TelemetryConfig)

    @property
    def credentials_file(self) -> Path:
        return self.state_dir / "credentials.json"

    @property
    def templates_dir(self) -> Path:
        return self.state_dir / "templates"

    @property
    def instances_file(self) -> Path:
        return self.state_dir / "instances.json"

    @property
    def telemetry_dir(self) -> Path:
        return self.state_dir / "telemetry"


def _as_float(raw: object, fallback: float) -> float:
    return float(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) else fallback


def _as_int(raw: object, fallback: int) -> int:
    return int(raw) if isinstance(raw, int) and not isinstance(raw, bool) else fallback


def _as_bool(raw: object, fallback: bool) -> bool:
    return raw if isinstance(raw, bool) else fallback


def _as_str_tuple(raw: object, fallback: tuple[str, ...]) -> tuple[str, ...]:
    if not isinstance(raw, list):
        return fallback
    values = tuple(item for item in raw if isinstance(item, str) and item.strip())
    return values or fallback


def _ip_sources(raw: object, fallback: tuple[tuple[str, tuple[str, ...]], ...]):
    """Read `[[net.ip_sources]]` tables, each `{ name, args }`.

    A malformed entry is skipped rather than failing startup: the pool is
    round-robin and degrades to the entries that did parse, which is a better
    outcome than a daemon that will not boot because one line has a typo.
    """
    if not isinstance(raw, list):
        return fallback
    out: list[tuple[str, tuple[str, ...]]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        args = entry.get("args")
        if not isinstance(name, str) or not name.strip():
            continue
        if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
            continue
        out.append((name, tuple(args)))
    return tuple(out) or fallback


def load_config(path: Path | None = None) -> Config:
    """Read the config file, then let the environment win over it.

    Environment overrides exist so the unit file and a debugging shell can move
    the agent without editing a root-owned file - `BOREDAGENT_CONFIG` is how
    systemd points at it in the first place.
    """
    config_path = path or Path(os.environ.get("BOREDAGENT_CONFIG", DEFAULT_CONFIG_PATH))
    raw: dict[str, object] = {}
    try:
        with open(config_path, "rb") as handle:
            raw = tomllib.load(handle)
    except FileNotFoundError:
        # Running before `agent-install.sh` has written one - every default
        # below is usable, so this is a warning-free path on purpose.
        raw = {}
    except (OSError, tomllib.TOMLDecodeError) as err:
        raise SystemExit(f"boredagent: {config_path} could not be read: {err}") from err

    docker_raw = raw.get("docker") if isinstance(raw.get("docker"), dict) else {}
    logs_raw = raw.get("logs") if isinstance(raw.get("logs"), dict) else {}
    net_raw = raw.get("net") if isinstance(raw.get("net"), dict) else {}
    tel_raw = raw.get("telemetry") if isinstance(raw.get("telemetry"), dict) else {}

    defaults = Config()
    config = Config(
        bind=raw.get("bind") if isinstance(raw.get("bind"), str) else defaults.bind,
        port=_as_int(raw.get("port"), defaults.port),
        token_file=Path(raw["token_file"]) if isinstance(raw.get("token_file"), str) else defaults.token_file,
        cors_origins=_as_str_tuple(raw.get("cors_origins"), defaults.cors_origins),
        state_dir=Path(raw["state_dir"]) if isinstance(raw.get("state_dir"), str) else defaults.state_dir,
        docker=DockerConfig(
            socket=docker_raw.get("socket")
            if isinstance(docker_raw.get("socket"), str)
            else defaults.docker.socket
        ),
        logs=LogConfig(
            max_tail=_as_int(logs_raw.get("max_tail"), defaults.logs.max_tail),
            redact=_as_bool(logs_raw.get("redact"), defaults.logs.redact),
        ),
        net=NetConfig(
            interval_s=_as_float(net_raw.get("interval_s"), defaults.net.interval_s),
            ping_timeout_s=_as_float(net_raw.get("ping_timeout_s"), defaults.net.ping_timeout_s),
            offline_window=_as_int(net_raw.get("offline_window"), defaults.net.offline_window),
            history_size=_as_int(net_raw.get("history_size"), defaults.net.history_size),
            http_ip_fallback_s=_as_float(
                net_raw.get("http_ip_fallback_s"), defaults.net.http_ip_fallback_s
            ),
            ping_targets=_as_str_tuple(net_raw.get("ping_targets"), defaults.net.ping_targets),
            ip_sources=_ip_sources(net_raw.get("ip_sources"), defaults.net.ip_sources),
        ),
        telemetry=TelemetryConfig(
            enabled=_as_bool(tel_raw.get("enabled"), defaults.telemetry.enabled),
            sample_s=_as_float(tel_raw.get("sample_s"), defaults.telemetry.sample_s),
            raw_days=_as_int(tel_raw.get("raw_days"), defaults.telemetry.raw_days),
            daily_days=_as_int(tel_raw.get("daily_days"), defaults.telemetry.daily_days),
            day_offset_min=_as_int(tel_raw.get("day_offset_min"), defaults.telemetry.day_offset_min),
            spike_factor=_as_float(tel_raw.get("spike_factor"), defaults.telemetry.spike_factor),
            spike_floor_ms=_as_float(tel_raw.get("spike_floor_ms"), defaults.telemetry.spike_floor_ms),
            spike_samples=_as_int(tel_raw.get("spike_samples"), defaults.telemetry.spike_samples),
        ),
    )

    bind = os.environ.get("BOREDAGENT_BIND")
    port = os.environ.get("BOREDAGENT_PORT")
    if bind:
        config = replace(config, bind=bind)
    if port and port.isdigit():
        config = replace(config, port=int(port))
    return config


def load_token(config: Config) -> str:
    """The bearer token every route but `/v1/health` requires.

    `BOREDAGENT_TOKEN` wins over the file so a test rig never has to write to
    `/etc`. A missing token is fatal rather than "auth off": an agent that binds
    0.0.0.0 and accepts anything would be a worse failure than not starting.
    """
    from_env = os.environ.get("BOREDAGENT_TOKEN")
    if from_env and from_env.strip():
        return from_env.strip()
    try:
        token = config.token_file.read_text(encoding="utf-8").strip()
    except OSError as err:
        raise SystemExit(
            f"boredagent: no token. {config.token_file} could not be read ({err}) and "
            "BOREDAGENT_TOKEN is not set. Run agent-install.sh, or set the variable."
        ) from err
    if not token:
        raise SystemExit(f"boredagent: {config.token_file} is empty - refusing to serve without a token")
    return token
