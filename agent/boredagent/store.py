"""On-disk state: credentials, the template library, and installed instances.

Three files, all under `/var/lib/boredagent`, all written the same way: to a
temporary file in the same directory with restrictive permissions, then
renamed over the target. A half-written credentials file would lock the
operator out of every service the agent manages, and rename is the only step
that is atomic on the filesystems this runs on.

Credentials are `0600` and owned by the service user. They are *not* encrypted:
the agent has to be able to read them unattended after a reboot, so any key it
could use would have to sit beside them, which buys nothing. What is enforced
instead is that they never leave - `to_public()` on a template returns schema
without values, and every log line goes through `redact.py` with these values
as input.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any


def _write_private_json(path: Path, value: Any, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return fallback
    except (OSError, json.JSONDecodeError):
        # A corrupt state file must not stop the agent: reachability monitoring
        # and every read-only route still work without it, and returning the
        # fallback lets the operator see that and rewrite it through the API.
        return fallback


class CredentialStore:
    """Field values per template id. Values in, schema out."""

    def __init__(self, path: Path) -> None:
        self._path = path
        raw = _read_json(path, {})
        self._data: dict[str, dict[str, str]] = {}
        if isinstance(raw, dict):
            for template_id, values in raw.items():
                if isinstance(template_id, str) and isinstance(values, dict):
                    self._data[template_id] = {
                        k: v for k, v in values.items() if isinstance(k, str) and isinstance(v, str)
                    }

    def get(self, template_id: str) -> dict[str, str]:
        return dict(self._data.get(template_id, {}))

    def has(self, template_id: str) -> bool:
        return bool(self._data.get(template_id))

    def set(self, template_id: str, values: dict[str, str]) -> None:
        self._data[template_id] = {k: v for k, v in values.items() if isinstance(v, str)}
        self._flush()

    def forget(self, template_id: str) -> None:
        if self._data.pop(template_id, None) is not None:
            self._flush()

    def secrets_for(self, template_id: str, secret_ids: tuple[str, ...]) -> list[str]:
        """The exact values redaction should mask for this template."""
        values = self._data.get(template_id, {})
        return [values[key] for key in secret_ids if values.get(key)]

    def all_secrets(self) -> list[str]:
        """Every stored value, for redacting text that names no one template.

        Deliberately every value rather than only the ones marked secret: a
        device name is not a secret, but masking it in a log costs nothing,
        and getting the "is this one secret" question wrong costs a password.
        """
        out: list[str] = []
        for values in self._data.values():
            out.extend(v for v in values.values() if v)
        return out

    def _flush(self) -> None:
        _write_private_json(self._path, self._data)


class TemplateStore:
    """The template library, one JSON document per template.

    Documents are kept as raw JSON rather than as objects, and re-validated on
    every load. An agent that was upgraded may have tightened its rules since a
    template was written, and re-reading through the current validator is what
    makes it refuse a document it would no longer accept - rather than running
    something it would now reject only because it accepted it once.
    """

    def __init__(self, directory: Path) -> None:
        self._dir = directory
        self._dir.mkdir(parents=True, exist_ok=True, mode=0o700)

    def _path(self, template_id: str) -> Path:
        return self._dir / f"{template_id}.json"

    def ids(self) -> list[str]:
        try:
            return sorted(p.stem for p in self._dir.glob("*.json"))
        except OSError:
            return []

    def read_raw(self, template_id: str) -> Any | None:
        return _read_json(self._path(template_id), None)

    def write_raw(self, template_id: str, document: Any) -> None:
        _write_private_json(self._path(template_id), document, mode=0o640)

    def delete(self, template_id: str) -> bool:
        path = self._path(template_id)
        if not path.exists():
            return False
        path.unlink(missing_ok=True)
        return True


class InstanceStore:
    """What has been installed from which template, and when.

    Small on purpose: live state comes from Docker or systemd, which are the
    truth. This file only records intent - that the operator asked for this
    template to be running here - so that a container removed behind the
    agent's back reads as "installed and gone" rather than "never installed".
    """

    def __init__(self, path: Path) -> None:
        self._path = path
        raw = _read_json(path, {})
        self._data: dict[str, dict[str, Any]] = raw if isinstance(raw, dict) else {}

    def all(self) -> dict[str, dict[str, Any]]:
        return {k: dict(v) for k, v in self._data.items()}

    def get(self, template_id: str) -> dict[str, Any] | None:
        entry = self._data.get(template_id)
        return dict(entry) if entry else None

    def mark_installed(self, template_id: str, template_version: str, at_ms: int) -> None:
        entry = self._data.get(template_id, {})
        entry.update(
            {
                "templateId": template_id,
                "templateVersion": template_version,
                "installedAt": entry.get("installedAt", at_ms),
                "updatedAt": at_ms,
            }
        )
        self._data[template_id] = entry
        self._flush()

    def forget(self, template_id: str) -> None:
        if self._data.pop(template_id, None) is not None:
            self._flush()

    def _flush(self) -> None:
        _write_private_json(self._path, self._data, mode=0o640)
