"""Bearer token, checked the same way on every route but health.

Two things worth stating:

- The comparison is **constant-time**. A token is 32 bytes of hex and the agent
  is on a LAN; a naive `==` leaks its prefix to anyone who can time responses,
  and `compare_digest` costs nothing to use.
- WebSockets take the token in the **query string**, because a browser cannot
  set a header on a WebSocket handshake. That puts it somewhere more likely to
  be logged, which is a real cost and the reason the README says to keep this
  on a network you trust and to bind it behind a firewall rule.
"""

from __future__ import annotations

import hmac

from fastapi import HTTPException, Request, status

UNAUTHORIZED = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="a bearer token is required",
    headers={"WWW-Authenticate": "Bearer"},
)


def token_matches(candidate: str | None, expected: str) -> bool:
    if not candidate or not expected:
        return False
    return hmac.compare_digest(candidate.strip(), expected)


def token_from_header(request: Request) -> str | None:
    header = request.headers.get("authorization") or ""
    scheme, _, value = header.partition(" ")
    if scheme.lower() != "bearer":
        return None
    return value.strip() or None


def require_token(request: Request) -> None:
    """FastAPI dependency. Raises 401 rather than returning anything."""
    expected = getattr(request.app.state, "token", "")
    supplied = token_from_header(request)
    # A query token is accepted on ordinary routes too, so `curl` and a browser
    # tab can reach the same URL a WebSocket client would - but the header is
    # tried first, so the ordinary path never puts a secret in a URL.
    if supplied is None:
        supplied = request.query_params.get("token")
    if not token_matches(supplied, expected):
        raise UNAUTHORIZED
