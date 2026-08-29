"""The template library as the rest of the agent sees it.

Every read goes back through `validate_template`. That is the point of this
class: a document that was accepted by an older agent is not trusted by a newer
one just because it is already on disk. If a rule tightened, the template stops
loading and says why, rather than running under rules nobody would accept today.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..store import TemplateStore
from .model import Template
from .validate import Finding, ValidationResult, validate_template


@dataclass(frozen=True)
class LoadedTemplate:
    template: Template
    findings: tuple[Finding, ...]


class TemplateRegistry:
    def __init__(self, store: TemplateStore) -> None:
        self._store = store

    def ids(self) -> list[str]:
        return self._store.ids()

    def load(self, template_id: str) -> LoadedTemplate | None:
        """One template, or None when it is absent or no longer valid."""
        raw = self._store.read_raw(template_id)
        if raw is None:
            return None
        result = validate_template(raw)
        if not result.ok or result.template is None:
            return None
        # The id in the document is authoritative for what it calls itself, but
        # the filename is what the API addressed. A mismatch means the file was
        # renamed by hand, and answering under the requested id would make two
        # ids resolve to one template.
        if result.template.id != template_id:
            return None
        return LoadedTemplate(result.template, tuple(result.findings))

    def load_all(self) -> list[LoadedTemplate]:
        out: list[LoadedTemplate] = []
        for template_id in self.ids():
            loaded = self.load(template_id)
            if loaded is not None:
                out.append(loaded)
        return out

    def problems(self) -> dict[str, list[Finding]]:
        """Templates on disk that will not load, and why.

        Surfaced rather than swallowed: a template that silently disappeared
        from the list is the hardest kind of failure to diagnose from the other
        end of an HTTP API.
        """
        out: dict[str, list[Finding]] = {}
        for template_id in self.ids():
            raw = self._store.read_raw(template_id)
            if raw is None:
                continue
            result = validate_template(raw)
            if result.ok and result.template is not None and result.template.id == template_id:
                continue
            findings = list(result.findings)
            if result.ok and result.template is not None and result.template.id != template_id:
                findings.append(
                    Finding(
                        "error",
                        "id",
                        f'the file is named "{template_id}" but the template calls itself '
                        f'"{result.template.id}"',
                    )
                )
            out[template_id] = findings
        return out

    def put(self, template_id: str, document: Any) -> ValidationResult:
        """Validate first, write only if it passed."""
        result = validate_template(document)
        if not result.ok or result.template is None:
            return result
        if result.template.id != template_id:
            result.findings.append(
                Finding(
                    "error",
                    "id",
                    f'this template calls itself "{result.template.id}", but it was sent as '
                    f'"{template_id}"',
                )
            )
            return ValidationResult(result.findings, None)
        self._store.write_raw(template_id, document)
        return result

    def delete(self, template_id: str) -> bool:
        return self._store.delete(template_id)
