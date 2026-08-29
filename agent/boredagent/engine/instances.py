"""Instances: a template plus the values it was installed with, on this machine.

This is where the two backends meet one vocabulary. A caller asks for
`start("honeygain")` and does not need to know whether that is a container or a
systemd unit, and the state it gets back uses the same words either way.

The aggregation rule is the part worth reading twice: an instance is `running`
only when every **required** unit is running. An optional unit that is missing
makes it `degraded` - which exists so PacketStream without its watchtower reads
as "working, something to look at" rather than either "fine" (it is not
updating itself) or "broken" (it is still earning).
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from .. import systemdutil
from ..dockerutil import DockerClient, UnitStatus
from ..redact import redact_all
from ..store import CredentialStore, InstanceStore
from ..templates.model import Template
from ..templates.registry import TemplateRegistry
from .ops import (
    ExecutionLog,
    StepResult,
    apply_defaults,
    missing_required,
    run_steps,
    substitute_all,
)

#: An instance's overall state, worst-first when several apply.
INSTANCE_STATES = ("absent", "installing", "degraded", "stopped", "failed", "running")


@dataclass
class ActionResult:
    ok: bool
    message: str
    details: dict[str, Any] | None = None

    def to_public(self) -> dict[str, Any]:
        out: dict[str, Any] = {"ok": self.ok, "message": self.message}
        if self.details:
            out["details"] = self.details
        return out


def aggregate_state(template: Template, units: list[UnitStatus]) -> str:
    by_name = {u.name: u for u in units}
    required = template.required_units
    if not units or all(by_name.get(n, UnitStatus(n, "absent")).state == "absent" for n in template.unit_names):
        return "absent"

    required_states = [by_name.get(name, UnitStatus(name, "absent")).state for name in required]
    if any(state == "absent" for state in required_states):
        # A required unit that is gone is not "stopped": the instance is not
        # installed any more, whatever the store still records.
        return "failed"
    if any(state in {"unhealthy", "dead"} for state in required_states):
        return "failed"
    if any(state in {"exited", "created"} for state in required_states):
        failed = [
            by_name[name]
            for name in required
            if name in by_name and by_name[name].exit_code not in (None, 0)
        ]
        return "failed" if failed else "stopped"
    if all(state == "running" for state in required_states):
        optional_absent = [
            name
            for name in template.unit_names
            if name not in required and by_name.get(name, UnitStatus(name, "absent")).state != "running"
        ]
        return "degraded" if optional_absent else "running"
    return "stopped"


class InstanceManager:
    def __init__(
        self,
        registry: TemplateRegistry,
        credentials: CredentialStore,
        instances: InstanceStore,
        docker: DockerClient,
    ) -> None:
        self._registry = registry
        self._credentials = credentials
        self._instances = instances
        self._docker = docker

    # ------------------------------------------------------------------ reads

    def template(self, template_id: str) -> Template | None:
        loaded = self._registry.load(template_id)
        return loaded.template if loaded else None

    def units_of(self, template: Template) -> list[UnitStatus]:
        if template.kind == "container":
            return [self._docker.describe(name) for name in template.unit_names]
        return [systemdutil.describe(unit) for unit in template.unit_names]

    def status(self, template: Template) -> dict[str, Any]:
        units = self.units_of(template)
        record = self._instances.get(template.id) or {}
        return {
            "id": template.id,
            "displayName": template.display_name,
            "kind": template.kind,
            "state": aggregate_state(template, units),
            "units": [u.to_public() for u in units],
            "hasCredentials": self._credentials.has(template.id),
            "installedAt": record.get("installedAt"),
            "updatedAt": record.get("updatedAt"),
            "templateVersion": template.version,
        }

    def list(self) -> list[dict[str, Any]]:
        return [self.status(loaded.template) for loaded in self._registry.load_all()]

    def logs(
        self,
        template: Template,
        unit: str | None,
        tail: int,
        since: str | None = None,
        timestamps: bool = True,
    ) -> tuple[str, list[str]] | None:
        """Log lines for one unit, redacted. None when the unit is not this
        template's - which the caller turns into a 404 rather than a 403, so
        the API cannot be used to discover which containers exist."""
        target = unit or template.primary_unit
        if target is None or target not in template.unit_names:
            return None
        if template.kind == "container":
            since_epoch = None
            if since and since.isdigit():
                since_epoch = int(since)
            raw = self._docker.logs(target, tail=tail, since=since_epoch, timestamps=timestamps)
        else:
            raw = systemdutil.logs(target, tail=tail, since=since, timestamps=timestamps)
        return target, redact_all(raw, self._secrets(template))

    def follow(self, template: Template, unit: str | None, tail: int = 100):
        target = unit or template.primary_unit
        if target is None or target not in template.unit_names:
            return None
        secrets = self._secrets(template)
        source = (
            self._docker.follow(target, tail=tail)
            if template.kind == "container"
            else systemdutil.follow(target, tail=tail)
        )

        def generate():
            for line in source:
                yield target, redact_all([line], secrets)[0]

        return generate()

    def _secrets(self, template: Template) -> list[str]:
        return self._credentials.secrets_for(template.id, template.secret_field_ids)

    # ----------------------------------------------------------------- writes

    def install(self, template: Template, values: dict[str, str]) -> ActionResult:
        merged = apply_defaults(template, values)
        missing = missing_required(template, merged)
        if missing:
            return ActionResult(False, f"missing required values: {', '.join(missing)}")

        # Credentials are stored *before* the install runs. An install that
        # fails halfway has still put containers on the machine, and the next
        # attempt needs the same values to clean up after itself.
        self._credentials.set(template.id, merged)

        log = ExecutionLog()
        if template.kind == "container":
            for unit in template.containers:
                pre = run_steps(unit.pre_install, merged, self._docker)
                log.steps.extend(pre.steps)
                if not pre.ok:
                    return ActionResult(False, f"preparing {unit.name} failed", {"steps": log.to_public()})
                try:
                    if unit.pull:
                        self._docker.pull(unit.image)
                    container_id = self._docker.run(
                        name=unit.name,
                        image=unit.image,
                        args=substitute_all(unit.args, merged),
                        env={k: substitute_all((v,), merged)[0] for k, v in unit.env.items()},
                        volumes=list(unit.volumes),
                        restart=unit.restart,
                    )
                except RuntimeError as err:
                    return ActionResult(False, str(err), {"steps": log.to_public()})
                log.steps.append(
                    StepResult("dockerRun", True, f"{unit.name} started as {container_id}")
                )
        else:
            for unit in template.services:
                result = run_steps(unit.install, merged, self._docker)
                log.steps.extend(result.steps)
                if not result.ok:
                    return ActionResult(False, f"installing {unit.unit} failed", {"steps": log.to_public()})

        self._instances.mark_installed(template.id, template.version, int(time.time() * 1000))
        return ActionResult(True, f"{template.display_name} installed", {"steps": log.to_public()})

    def uninstall(self, template: Template, forget: bool = False) -> ActionResult:
        values = apply_defaults(template, self._credentials.get(template.id))
        log = ExecutionLog()
        if template.kind == "container":
            for unit in template.containers:
                try:
                    removed = self._docker.remove_container(unit.name, force=True)
                except RuntimeError as err:
                    return ActionResult(False, str(err), {"steps": log.to_public()})
                log.steps.append(
                    StepResult("dockerRm", True, f"{unit.name} {'removed' if removed else 'was not there'}")
                )
        else:
            for unit in template.services:
                result = run_steps(unit.uninstall, values, self._docker)
                log.steps.extend(result.steps)

        self._instances.forget(template.id)
        if forget:
            self._credentials.forget(template.id)
        kept = "" if forget else " Credentials were kept; uninstall with ?forget=1 to drop them."
        return ActionResult(True, f"{template.display_name} removed.{kept}", {"steps": log.to_public()})

    def lifecycle(self, template: Template, verb: str) -> ActionResult:
        if verb not in {"start", "stop", "restart"}:
            return ActionResult(False, f'"{verb}" is not start, stop or restart')
        touched: list[str] = []
        for name in template.unit_names:
            try:
                if template.kind == "container":
                    method = {
                        "start": self._docker.start_container,
                        "stop": self._docker.stop_container,
                        "restart": self._docker.restart_container,
                    }[verb]
                    if method(name):
                        touched.append(name)
                else:
                    ok, message = systemdutil.action(name, verb)
                    if not ok:
                        return ActionResult(False, f"{name}: {message}")
                    touched.append(name)
            except RuntimeError as err:
                return ActionResult(False, str(err))
        if not touched:
            return ActionResult(False, f"nothing to {verb} - no unit of {template.display_name} is installed")
        return ActionResult(True, f"{verb}ed {', '.join(touched)}")

    def validate(self, template: Template) -> dict[str, Any]:
        """Is it running, and does its own log say it was accepted?

        Two separate questions, and the second is deliberately weak. These
        services fail by running happily and logging a rejection, so a log match
        is a signal worth surfacing - but its *absence* proves nothing, and the
        wording says so rather than implying a clean bill of health.
        """
        units = self.units_of(template)
        state = aggregate_state(template, units)
        issues: list[dict[str, str]] = []

        for name in template.required_units:
            unit = next((u for u in units if u.name == name), None)
            if unit is None or unit.state == "absent":
                issues.append({"level": "error", "message": f"{name} is not installed"})
            elif unit.state != "running":
                issues.append({"level": "error", "message": f"{name} is {unit.state}, not running"})

        for name in template.unit_names:
            if name in template.required_units:
                continue
            unit = next((u for u in units if u.name == name), None)
            if unit is None or unit.state != "running":
                issues.append(
                    {
                        "level": "warning",
                        "message": f"{name} is optional and is not running - the instance works without it",
                    }
                )

        if not self._credentials.has(template.id):
            issues.append({"level": "warning", "message": "no credentials are stored for this template"})

        matched: list[str] = []
        if template.validate.fail_patterns and template.primary_unit:
            read = self.logs(template, template.primary_unit, template.validate.log_tail)
            lines = read[1] if read else []
            lowered = [line.lower() for line in lines]
            for pattern in template.validate.fail_patterns:
                needle = pattern.lower()
                if any(needle in line for line in lowered):
                    matched.append(pattern)
        if matched:
            issues.append(
                {
                    "level": "error",
                    "message": "the last "
                    f"{template.validate.log_tail} log lines contain "
                    f"{', '.join(repr(m) for m in matched)} - this usually means the credentials were rejected",
                }
            )

        return {
            "id": template.id,
            "state": state,
            "ok": not any(i["level"] == "error" for i in issues),
            "issues": issues,
            "checkedPatterns": list(template.validate.fail_patterns),
            "note": (
                "A clean log is not proof the account is good: these services only complain when "
                "they are rejected, and some do not complain at all."
            ),
        }
