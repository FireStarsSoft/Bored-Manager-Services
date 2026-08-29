"""The template library over HTTP.

`GET` answers with schema and never with values: a field marked secret appears
as a field, so a client can draw a form, and its value never leaves the machine.
`PUT` validates before it writes, and answers with the findings either way -
a rejected template returns 422 with everything that is wrong, not the first
thing.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request, Response, status

from .deps import require_template, runtime

router = APIRouter(prefix="/v1/templates", tags=["templates"])


@router.get("")
def list_templates(request: Request) -> dict[str, Any]:
    rt = runtime(request)
    loaded = rt.registry.load_all()
    return {
        "templates": [
            {
                **entry.template.to_public(),
                "hasCredentials": rt.credentials.has(entry.template.id),
                "warnings": [f.to_public() for f in entry.findings if f.level == "warning"],
            }
            for entry in loaded
        ],
        # Templates on disk that will not load. Surfaced rather than swallowed:
        # one that silently vanished from the list is the hardest failure to
        # diagnose from the other end of an API.
        "problems": {
            template_id: [f.to_public() for f in findings]
            for template_id, findings in rt.registry.problems().items()
        },
    }


@router.get("/{template_id}")
def get_template(request: Request, template_id: str) -> dict[str, Any]:
    template = require_template(request, template_id)
    rt = runtime(request)
    return {
        **template.to_public(),
        "hasCredentials": rt.credentials.has(template.id),
    }


@router.put("/{template_id}")
def put_template(request: Request, template_id: str, document: dict[str, Any], response: Response) -> dict[str, Any]:
    """Import or replace one template."""
    result = runtime(request).registry.put(template_id, document)
    if not result.ok:
        response.status_code = status.HTTP_422_UNPROCESSABLE_ENTITY
        return {"ok": False, "findings": [f.to_public() for f in result.findings]}
    return {
        "ok": True,
        "template": result.template.to_public() if result.template else None,
        "findings": [f.to_public() for f in result.findings],
    }


@router.delete("/{template_id}")
def delete_template(request: Request, template_id: str, response: Response) -> dict[str, Any]:
    """Remove a template. Anything installed from it is left alone.

    Deleting the description of a service does not stop the service - that
    would make tidying a library a destructive act. Uninstall first if that is
    what you meant.
    """
    removed = runtime(request).registry.delete(template_id)
    if not removed:
        response.status_code = status.HTTP_404_NOT_FOUND
        return {"ok": False, "message": f'no template "{template_id}"'}
    return {
        "ok": True,
        "message": f"{template_id} removed from the library. Anything it installed is still running.",
    }
