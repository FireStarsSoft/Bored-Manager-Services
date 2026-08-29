"""What every route reaches for, and the two refusals they all share.

Everything the agent owns hangs off `app.state`, assembled once in `app.py`'s
lifespan. Routes take it through these helpers rather than importing a global,
so a test can build a whole app around fakes without patching module state.
"""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException, Request, status

from ..templates.model import Template


def runtime(request: Request) -> Any:
    return request.app.state.runtime


def require_template(request: Request, template_id: str) -> Template:
    """The template, or a 404 that does not say whether the file exists.

    A template that is on disk but no longer passes validation is 404 rather
    than 500: from a client's point of view it is not usable, and the reason is
    available on `GET /v1/templates` under `problems` rather than being spread
    across every route that touches it.
    """
    template = runtime(request).instances.template(template_id)
    if template is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f'no usable template "{template_id}" - GET /v1/templates lists what is loaded, and why anything is not',
        )
    return template


def unit_or_404(template: Template, unit: str | None) -> str:
    """Resolve a unit name against the template that is allowed to own it.

    This is the access control for logs. A unit outside the template's own list
    is a **404**, not a 403: a 403 would confirm the container exists, turning
    this route into a way to enumerate what is running on the machine.
    """
    target = unit or template.primary_unit
    if target is None or target not in template.unit_names:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f'"{unit}" is not a unit of {template.id}',
        )
    return target


def bad_request(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


def unprocessable(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=detail)


def docker_error(detail: str) -> HTTPException:
    """502, because the failure is the daemon's rather than the request's."""
    return HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=detail)


def parse_ms(raw: str | None, field: str) -> int | None:
    """Accept epoch milliseconds or an ISO-8601 instant."""
    if raw is None or raw == "":
        return None
    if raw.isdigit():
        return int(raw)
    from datetime import datetime

    try:
        return int(datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError as err:
        raise bad_request(f"{field} is neither epoch milliseconds nor an ISO-8601 time") from err
