"""What a template is, as data.

A template describes how to install, monitor and control one service. Two
kinds - a Docker container, or a native systemd unit on the host - and the same
opcode vocabulary underneath both.

The single rule this file exists to enforce, in its shape rather than in a
comment: **a template can never express a shell command**. `Step` holds an
opcode and typed fields; there is no member anywhere that is "a line to run".
The one escape hatch, `script`, is a separate opcode that only a template
declaring `privileged: true` may use, and the module puts that behind its own
confirmation. Everything else is argv, and `{{field}}` substitution always
produces exactly one argv element - never a fragment a parser could split on
whitespace an attacker chose.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

SCHEMA_VERSION = 1

TemplateKind = Literal["container", "service"]

#: Every opcode the engine will execute. A template naming anything else is
#: rejected at import, so this tuple is the whole attack surface.
OPCODES: tuple[str, ...] = (
    "dockerRun",
    "dockerRm",
    "dockerStop",
    "dockerPull",
    "dockerRmi",
    "download",
    "writeFile",
    "mkdir",
    "chmod",
    "systemctl",
    "apt",
    "run",
    "script",
)

#: `script` is the only opcode that reaches a shell, and only for a template
#: that declared itself privileged.
PRIVILEGED_OPCODES: frozenset[str] = frozenset({"script"})

#: Directories a template may write into. Anything outside these is refused at
#: import: a template that can write `/etc/sudoers.d` or a user's `authorized_keys`
#: is a root shell with extra steps.
WRITABLE_PREFIXES: tuple[str, ...] = (
    "/etc/systemd/system/",
    "/opt/",
    "/etc/boredagent-services/",
    "/var/lib/boredagent-services/",
    "/usr/local/bin/",
)

FieldInput = Literal["text", "password", "number", "checkbox", "select"]


@dataclass(frozen=True)
class TemplateField:
    """One value the user supplies before an instance can be installed."""

    id: str
    label: str
    input: FieldInput = "text"
    required: bool = False
    secret: bool = False
    default: str | None = None
    options: tuple[str, ...] = ()
    help: str | None = None

    def to_public(self) -> dict[str, Any]:
        """The schema half - never a value, and never a stored secret."""
        return {
            "id": self.id,
            "label": self.label,
            "input": self.input,
            "required": self.required,
            "secret": self.secret,
            "default": self.default,
            "options": list(self.options),
            "help": self.help,
        }


@dataclass(frozen=True)
class Step:
    """One opcode with its typed arguments.

    `args` is deliberately a mapping rather than a command line. The engine
    reads the members each opcode defines and ignores the rest, so a template
    cannot smuggle an extra word into a command by adding a key.
    """

    op: str
    args: dict[str, Any] = field(default_factory=dict)
    #: Keep going when this step fails. For cleanup that runs before an install,
    #: where "there was nothing to remove" is the normal case.
    ignore_errors: bool = False


@dataclass(frozen=True)
class ContainerUnit:
    """One container an instance owns."""

    name: str
    image: str
    #: The container whose state decides the instance's, and whose logs are the
    #: default. Exactly one unit is primary.
    primary: bool = False
    #: A unit that may be missing without the instance counting as broken -
    #: PacketStream's watchtower. Missing means `degraded`, not `failed`.
    optional: bool = False
    restart: str = "always"
    pull: bool = False
    args: tuple[str, ...] = ()
    env: dict[str, str] = field(default_factory=dict)
    volumes: tuple[str, ...] = ()
    pre_install: tuple[Step, ...] = ()


@dataclass(frozen=True)
class ServiceUnit:
    """One systemd unit an instance owns."""

    unit: str
    primary: bool = False
    optional: bool = False
    install: tuple[Step, ...] = ()
    uninstall: tuple[Step, ...] = ()


@dataclass(frozen=True)
class ValidateRules:
    """How `validate` decides an instance is not merely running but working.

    A running container proves the image started, not that the credentials were
    accepted - these services fail by running happily and logging a rejection.
    Matching that log is a signal, not a proof: its absence never means the
    account is good, and the wording is chosen to say so.
    """

    log_tail: int = 80
    fail_patterns: tuple[str, ...] = ()


@dataclass(frozen=True)
class Template:
    id: str
    display_name: str
    kind: TemplateKind
    version: str = "1.0.0"
    description: str = ""
    schema_version: int = SCHEMA_VERSION
    privileged: bool = False
    fields: tuple[TemplateField, ...] = ()
    containers: tuple[ContainerUnit, ...] = ()
    services: tuple[ServiceUnit, ...] = ()
    validate: ValidateRules = field(default_factory=ValidateRules)
    #: Field ids whose values must never appear in a log line or an inspect.
    redact: tuple[str, ...] = ()

    @property
    def unit_names(self) -> tuple[str, ...]:
        """Every unit this template owns, primary first.

        This tuple is the access-control list for logs: a request naming a unit
        that is not in it is a 404, which is what stops a template being used to
        read a container it has nothing to do with.
        """
        if self.kind == "container":
            names = [unit.name for unit in self.containers if unit.primary]
            names += [unit.name for unit in self.containers if not unit.primary]
            return tuple(names)
        names = [unit.unit for unit in self.services if unit.primary]
        names += [unit.unit for unit in self.services if not unit.primary]
        return tuple(names)

    @property
    def primary_unit(self) -> str | None:
        units = self.unit_names
        return units[0] if units else None

    @property
    def required_units(self) -> tuple[str, ...]:
        if self.kind == "container":
            return tuple(u.name for u in self.containers if not u.optional)
        return tuple(u.unit for u in self.services if not u.optional)

    @property
    def secret_field_ids(self) -> tuple[str, ...]:
        declared = {f.id for f in self.fields if f.secret}
        return tuple(sorted(declared | set(self.redact)))

    def field(self, field_id: str) -> TemplateField | None:
        for candidate in self.fields:
            if candidate.id == field_id:
                return candidate
        return None

    def to_public(self) -> dict[str, Any]:
        """What `GET /v1/templates` answers with - schema, never values."""
        return {
            "id": self.id,
            "displayName": self.display_name,
            "kind": self.kind,
            "version": self.version,
            "description": self.description,
            "schemaVersion": self.schema_version,
            "privileged": self.privileged,
            "fields": [f.to_public() for f in self.fields],
            "units": list(self.unit_names),
            "requiredUnits": list(self.required_units),
            "primaryUnit": self.primary_unit,
        }
