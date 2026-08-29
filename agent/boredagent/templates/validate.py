"""Turning untrusted JSON into a Template, or refusing to.

This is the security boundary of the whole agent. A template is authored by a
user, arrives over HTTP, and is executed with root-adjacent privilege - so this
file's job is to make the set of things a template can express small enough to
reason about, and then to reject everything outside it.

Findings are returned rather than raised, one per problem, so an import can
tell the user everything that is wrong at once instead of one thing per attempt.
A template with any `error` finding is never constructed.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal

from .model import (
    OPCODES,
    PRIVILEGED_OPCODES,
    SCHEMA_VERSION,
    WRITABLE_PREFIXES,
    ContainerUnit,
    ServiceUnit,
    Step,
    Template,
    TemplateField,
    ValidateRules,
)

Level = Literal["error", "warning", "info"]

ID_RE = re.compile(r"^[a-z][a-z0-9-]{1,31}$")
FIELD_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
#: Docker object names, as the daemon itself accepts them.
UNIT_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$")
SYSTEMD_UNIT_RE = re.compile(r"^[a-zA-Z0-9@_.\\-]{1,96}\.(service|timer|socket)$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
#: `{{field}}` - the only interpolation there is.
PLACEHOLDER_RE = re.compile(r"\{\{\s*([a-z][a-z0-9_]*)\s*\}\}")

MAX_STEPS = 64
MAX_UNITS = 8
MAX_FIELDS = 32
MAX_ARGS = 64


@dataclass(frozen=True)
class Finding:
    level: Level
    where: str
    message: str

    def to_public(self) -> dict[str, str]:
        return {"level": self.level, "where": self.where, "message": self.message}


@dataclass
class ValidationResult:
    findings: list[Finding]
    template: Template | None

    @property
    def ok(self) -> bool:
        return self.template is not None and not any(f.level == "error" for f in self.findings)

    def to_public(self) -> dict[str, Any]:
        return {"ok": self.ok, "findings": [f.to_public() for f in self.findings]}


class _Collector:
    def __init__(self) -> None:
        self.findings: list[Finding] = []

    def error(self, where: str, message: str) -> None:
        self.findings.append(Finding("error", where, message))

    def warn(self, where: str, message: str) -> None:
        self.findings.append(Finding("warning", where, message))

    @property
    def failed(self) -> bool:
        return any(f.level == "error" for f in self.findings)


def _str(raw: Any) -> str | None:
    return raw.strip() if isinstance(raw, str) and raw.strip() else None


def _str_tuple(raw: Any) -> tuple[str, ...]:
    if not isinstance(raw, list):
        return ()
    return tuple(item for item in raw if isinstance(item, str))


def _placeholders(text: str) -> set[str]:
    return {m.group(1) for m in PLACEHOLDER_RE.finditer(text)}


def _check_placeholders(c: _Collector, where: str, text: str, known: set[str]) -> None:
    for name in _placeholders(text) - known:
        c.error(where, f'refers to {{{{{name}}}}}, which is not one of this template\'s fields')


#: A value that is nothing but one placeholder: `{{binary_url}}`, never
#: `https://x/{{ver}}/y`.
WHOLE_PLACEHOLDER_RE = re.compile(r"^\{\{\s*([a-z][a-z0-9_]*)\s*\}\}$")


def _literal_or_field(
    c: _Collector, where: str, value: str | None, known: set[str], what: str
) -> str | None:
    """Accept a literal, or one field standing in for the whole value.

    A download's URL and hash may come from the operator at install time - that
    is how a generic template can be a shape rather than a specific service. The
    guarantee this file exists to keep is not "the template author chose the
    hash", it is **"there is a hash, and the bytes are checked against it"**;
    whoever supplies it is still vouching for exact bytes, and the engine
    re-checks the substituted value before it downloads anything.

    What is refused is a *partial* placeholder - `https://host/{{ver}}/bin`.
    Splicing a field into the middle of a URL or a digest lets the shape of the
    value be decided somewhere other than where it is reviewed, and there is no
    case here that needs it.
    """
    if value is None:
        return None
    whole = WHOLE_PLACEHOLDER_RE.match(value)
    if whole:
        name = whole.group(1)
        if name not in known:
            c.error(where, f'refers to {{{{{name}}}}}, which is not one of this template\'s fields')
            return None
        return None  # supplied at install time; the engine checks it then
    if _placeholders(value):
        c.error(
            where,
            f"builds its {what} out of a field and other text; it has to be either a literal "
            f"or one whole field",
        )
        return None
    return value


def _check_path(c: _Collector, where: str, path: str) -> None:
    """A writable path must be absolute, inside an allowed prefix, and literal.

    `..` is refused even inside an allowed prefix: `/opt/x/../../etc/sudoers.d/y`
    starts with `/opt/` and is not under it. A placeholder in a path is refused
    outright rather than checked after substitution, because the value comes
    from the user at install time and would let the prefix be escaped later.
    """
    if not path.startswith("/"):
        c.error(where, f'"{path}" is not an absolute path')
        return
    if ".." in path.split("/"):
        c.error(where, f'"{path}" contains "..", which could leave the allowed directories')
        return
    if _placeholders(path):
        c.error(where, f'"{path}" interpolates a field into a path; paths have to be literal')
        return
    if not any(path.startswith(prefix) for prefix in WRITABLE_PREFIXES):
        allowed = ", ".join(WRITABLE_PREFIXES)
        c.error(where, f'"{path}" is outside the directories a template may write to ({allowed})')


def _step(c: _Collector, where: str, raw: Any, known: set[str], privileged: bool) -> Step | None:
    if not isinstance(raw, dict):
        c.error(where, "is not an object")
        return None
    op = _str(raw.get("op"))
    if op is None:
        c.error(where, "has no `op`")
        return None
    if op not in OPCODES:
        c.error(where, f'"{op}" is not one of the opcodes a template may use ({", ".join(OPCODES)})')
        return None
    if op in PRIVILEGED_OPCODES and not privileged:
        c.error(
            where,
            f'"{op}" runs a shell, so it is only allowed in a template that declares "privileged": true',
        )
        return None

    args: dict[str, Any] = {k: v for k, v in raw.items() if k not in {"op", "ignoreErrors"}}

    # Per-opcode shape. Anything an opcode does not name is ignored by the
    # engine, so only what it reads has to be checked.
    if op in {"dockerRm", "dockerStop", "dockerRmi", "dockerPull"}:
        target = _str(args.get("target"))
        if target is None:
            c.error(where, f"`{op}` needs a `target`")
        elif op != "dockerPull" and not UNIT_NAME_RE.match(target):
            c.error(where, f'"{target}" is not a valid container name')
    elif op == "download":
        raw_url = _str(args.get("url"))
        dest = _str(args.get("dest"))
        raw_digest = _str(args.get("sha256"))
        if raw_url is None:
            c.error(where, "`download` needs a `url`")
        else:
            literal_url = _literal_or_field(c, where, raw_url, known, "url")
            if literal_url is not None and not literal_url.startswith(("http://", "https://")):
                c.error(where, "`download` needs an http(s) `url`")
        if dest is None:
            c.error(where, "`download` needs a `dest`")
        else:
            _check_path(c, where, dest)
        if raw_digest is None:
            # The one requirement that makes a download reviewable at all: the
            # URL can serve anything tomorrow, the hash cannot. It may come from
            # a field, but it may not be absent.
            c.error(where, "`download` needs a `sha256`; a URL on its own is not reviewable")
        else:
            literal_digest = _literal_or_field(c, where, raw_digest, known, "sha256")
            if literal_digest is not None and not SHA256_RE.match(literal_digest.lower()):
                c.error(where, "`download` needs a 64-character hex `sha256`")
    elif op == "writeFile":
        path = _str(args.get("path"))
        if path is None:
            c.error(where, "`writeFile` needs a `path`")
        else:
            _check_path(c, where, path)
        if not isinstance(args.get("content"), str):
            c.error(where, "`writeFile` needs string `content`")
        else:
            _check_placeholders(c, where, args["content"], known)
    elif op in {"mkdir", "chmod"}:
        path = _str(args.get("path"))
        if path is None:
            c.error(where, f"`{op}` needs a `path`")
        else:
            _check_path(c, where, path)
        if op == "chmod" and not re.fullmatch(r"0?[0-7]{3}", str(args.get("mode", ""))):
            c.error(where, "`chmod` needs an octal `mode` like \"0644\"")
    elif op in {"systemctl", "apt", "run", "dockerRun"}:
        argv = args.get("argv")
        if not isinstance(argv, list) or not argv:
            c.error(where, f"`{op}` needs a non-empty `argv` array")
        elif len(argv) > MAX_ARGS:
            c.error(where, f"`argv` has more than {MAX_ARGS} entries")
        elif not all(isinstance(a, str) for a in argv):
            c.error(where, "every `argv` entry has to be a string")
        else:
            for entry in argv:
                _check_placeholders(c, where, entry, known)
        if op == "run":
            program = _str(args.get("program"))
            if program is None:
                c.error(where, "`run` needs a `program`")
            elif not program.startswith("/") and "/" in program:
                c.error(where, f'"{program}" is neither an absolute path nor a bare command name')
    elif op == "script":
        body = args.get("body")
        if not isinstance(body, str) or not body.strip():
            c.error(where, "`script` needs a non-empty `body`")
        else:
            _check_placeholders(c, where, body, known)

    return Step(op=op, args=args, ignore_errors=bool(raw.get("ignoreErrors")))


def _steps(c: _Collector, where: str, raw: Any, known: set[str], privileged: bool) -> tuple[Step, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list):
        c.error(where, "is not an array")
        return ()
    if len(raw) > MAX_STEPS:
        c.error(where, f"has more than {MAX_STEPS} steps")
        return ()
    out = []
    for index, entry in enumerate(raw):
        step = _step(c, f"{where}[{index}]", entry, known, privileged)
        if step is not None:
            out.append(step)
    return tuple(out)


def _fields(c: _Collector, raw: Any) -> tuple[TemplateField, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list):
        c.error("fields", "is not an array")
        return ()
    if len(raw) > MAX_FIELDS:
        c.error("fields", f"declares more than {MAX_FIELDS} fields")
        return ()
    out: list[TemplateField] = []
    seen: set[str] = set()
    for index, entry in enumerate(raw):
        where = f"fields[{index}]"
        if not isinstance(entry, dict):
            c.error(where, "is not an object")
            continue
        field_id = _str(entry.get("id"))
        if field_id is None or not FIELD_ID_RE.match(field_id):
            c.error(where, "needs an `id` of lowercase letters, digits and underscores")
            continue
        if field_id in seen:
            c.error(where, f'field "{field_id}" is declared twice')
            continue
        seen.add(field_id)
        label = _str(entry.get("label"))
        if label is None:
            c.error(where, f'field "{field_id}" has no label')
            continue
        input_kind = _str(entry.get("input")) or "text"
        if input_kind not in {"text", "password", "number", "checkbox", "select"}:
            c.error(where, f'"{input_kind}" is not a known input kind')
            continue
        options = _str_tuple(entry.get("options"))
        if input_kind == "select" and not options:
            c.error(where, f'field "{field_id}" is a select with no options')
            continue
        secret = bool(entry.get("secret")) or input_kind == "password"
        if input_kind == "password" and not secret:
            c.warn(where, f'field "{field_id}" is a password but is not marked secret; treating it as one')
        out.append(
            TemplateField(
                id=field_id,
                label=label,
                input=input_kind,  # type: ignore[arg-type]
                required=bool(entry.get("required")),
                secret=secret,
                default=_str(entry.get("default")),
                options=options,
                help=_str(entry.get("help")),
            )
        )
    return tuple(out)


def _containers(c: _Collector, raw: Any, known: set[str], privileged: bool) -> tuple[ContainerUnit, ...]:
    if not isinstance(raw, dict):
        c.error("container", "is missing for a template of kind \"container\"")
        return ()
    units_raw = raw.get("units")
    if not isinstance(units_raw, list) or not units_raw:
        c.error("container.units", "needs at least one unit")
        return ()
    if len(units_raw) > MAX_UNITS:
        c.error("container.units", f"declares more than {MAX_UNITS} units")
        return ()
    out: list[ContainerUnit] = []
    seen: set[str] = set()
    for index, entry in enumerate(units_raw):
        where = f"container.units[{index}]"
        if not isinstance(entry, dict):
            c.error(where, "is not an object")
            continue
        name = _str(entry.get("name"))
        image = _str(entry.get("image"))
        if name is None or not UNIT_NAME_RE.match(name):
            c.error(where, "needs a valid container `name`")
            continue
        if name in seen:
            c.error(where, f'container "{name}" is declared twice')
            continue
        seen.add(name)
        if image is None:
            c.error(where, f'container "{name}" has no `image`')
            continue
        if _placeholders(image) or _placeholders(name):
            c.error(where, "a container name or image may not interpolate a field")
            continue
        args = _str_tuple(entry.get("args"))
        for arg in args:
            _check_placeholders(c, where, arg, known)
        env_raw = entry.get("env") if isinstance(entry.get("env"), dict) else {}
        env = {}
        for key, value in env_raw.items():
            if not isinstance(key, str) or not isinstance(value, str):
                c.error(where, "every `env` key and value has to be a string")
                continue
            _check_placeholders(c, where, value, known)
            env[key] = value
        volumes = _str_tuple(entry.get("volumes"))
        out.append(
            ContainerUnit(
                name=name,
                image=image,
                primary=bool(entry.get("primary")),
                optional=bool(entry.get("optional")),
                restart=_str(entry.get("restart")) or "always",
                pull=bool(entry.get("pull")),
                args=args,
                env=env,
                volumes=volumes,
                pre_install=_steps(c, f"{where}.preInstall", entry.get("preInstall"), known, privileged),
            )
        )
    return tuple(out)


def _services(c: _Collector, raw: Any, known: set[str], privileged: bool) -> tuple[ServiceUnit, ...]:
    if not isinstance(raw, dict):
        c.error("service", 'is missing for a template of kind "service"')
        return ()
    units_raw = raw.get("units")
    if not isinstance(units_raw, list) or not units_raw:
        c.error("service.units", "needs at least one unit")
        return ()
    if len(units_raw) > MAX_UNITS:
        c.error("service.units", f"declares more than {MAX_UNITS} units")
        return ()
    out: list[ServiceUnit] = []
    seen: set[str] = set()
    for index, entry in enumerate(units_raw):
        where = f"service.units[{index}]"
        if not isinstance(entry, dict):
            c.error(where, "is not an object")
            continue
        unit = _str(entry.get("unit"))
        if unit is None or not SYSTEMD_UNIT_RE.match(unit):
            c.error(where, "needs a `unit` like \"something.service\"")
            continue
        if unit in seen:
            c.error(where, f'unit "{unit}" is declared twice')
            continue
        seen.add(unit)
        out.append(
            ServiceUnit(
                unit=unit,
                primary=bool(entry.get("primary")),
                optional=bool(entry.get("optional")),
                install=_steps(c, f"{where}.install", entry.get("install"), known, privileged),
                uninstall=_steps(c, f"{where}.uninstall", entry.get("uninstall"), known, privileged),
            )
        )
    return tuple(out)


def validate_template(raw: Any) -> ValidationResult:
    """Read one template document. Never raises; never half-builds."""
    c = _Collector()
    if not isinstance(raw, dict):
        c.error("template", "is not a JSON object")
        return ValidationResult(c.findings, None)

    schema_version = raw.get("schemaVersion", SCHEMA_VERSION)
    if not isinstance(schema_version, int) or schema_version > SCHEMA_VERSION:
        c.error(
            "schemaVersion",
            f"is {schema_version!r}; this agent understands up to {SCHEMA_VERSION}",
        )
        return ValidationResult(c.findings, None)

    template_id = _str(raw.get("id"))
    if template_id is None or not ID_RE.match(template_id):
        c.error("id", "needs to be 2-32 lowercase letters, digits and dashes, starting with a letter")
    display_name = _str(raw.get("displayName")) or template_id or ""
    if not display_name:
        c.error("displayName", "is missing")
    kind = _str(raw.get("kind"))
    if kind not in {"container", "service"}:
        c.error("kind", 'has to be "container" or "service"')
    version = _str(raw.get("version")) or "1.0.0"
    if not VERSION_RE.match(version):
        c.error("version", "is not in x.y.z form")

    privileged = bool(raw.get("privileged"))
    fields = _fields(c, raw.get("fields"))
    known = {f.id for f in fields}

    containers: tuple[ContainerUnit, ...] = ()
    services: tuple[ServiceUnit, ...] = ()
    if kind == "container":
        containers = _containers(c, raw.get("container"), known, privileged)
    elif kind == "service":
        services = _services(c, raw.get("service"), known, privileged)

    primary_count = len([u for u in containers if u.primary]) + len([u for u in services if u.primary])
    unit_total = len(containers) + len(services)
    if unit_total and primary_count != 1:
        # The primary decides the instance's state and is the default for logs.
        # Zero or two makes both of those ambiguous.
        c.error("units", f"exactly one unit has to be `primary` (found {primary_count})")

    validate_raw = raw.get("validate") if isinstance(raw.get("validate"), dict) else {}
    log_tail = validate_raw.get("logTail", 80)
    if not isinstance(log_tail, int) or not 1 <= log_tail <= 5000:
        c.warn("validate.logTail", "is not between 1 and 5000; using 80")
        log_tail = 80
    rules = ValidateRules(log_tail=log_tail, fail_patterns=_str_tuple(validate_raw.get("failPatterns")))

    redact_ids = _str_tuple(raw.get("redact"))
    for redact_id in redact_ids:
        if redact_id not in known:
            c.warn("redact", f'names "{redact_id}", which is not one of this template\'s fields')

    if privileged:
        c.warn(
            "privileged",
            "runs a shell as root on every machine it is deployed to. Only import this from a source you trust.",
        )

    if c.failed:
        return ValidationResult(c.findings, None)

    template = Template(
        id=template_id or "",
        display_name=display_name,
        kind=kind,  # type: ignore[arg-type]
        version=version,
        description=_str(raw.get("description")) or "",
        schema_version=schema_version,
        privileged=privileged,
        fields=fields,
        containers=containers,
        services=services,
        validate=rules,
        redact=tuple(r for r in redact_ids if r in known),
    )
    return ValidationResult(c.findings, template)
