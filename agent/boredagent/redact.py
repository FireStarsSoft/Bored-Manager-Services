"""Keeping secrets out of anything that leaves the process.

Two different jobs, and conflating them is how secrets escape:

- `redact_line` works on **text we did not write** - container logs, command
  output. It cannot know where a secret is, so it looks for the shapes one
  takes: a flag that is documented to carry one, an assignment, a URL with
  credentials in it. This is best-effort by nature.
- `redact_values` works on **text we did write**, given the exact secret values
  from the credential store. That one is not best-effort: if a value is in the
  string it comes out.

Both run. The second catches what the first cannot guess, and the first catches
what the second has no value for (a token the service printed, a password the
user typed into the wrong field).
"""

from __future__ import annotations

import re
from collections.abc import Iterable

MASK = "[redacted]"

#: The least a secret can be and still be worth masking. Below this, masking
#: does more harm than good: a two-character value appears inside ordinary
#: words, and redacting it would shred the log it was meant to protect.
MIN_SECRET_LEN = 4

#: Flags and variables documented to carry a secret, in the forms the three
#: seed templates actually use: `-pass X`, `-password=X`, `CID=X`.
_FLAG_NAMES = (
    "pass",
    "password",
    "passwd",
    "secret",
    "token",
    "apikey",
    "api-key",
    "api_key",
    "cid",
    "auth",
    "authorization",
)

_SEPARATED = re.compile(
    r"(?P<flag>(?:^|[\s\"'])-{0,2}(?:" + "|".join(_FLAG_NAMES) + r"))"
    r"(?P<sep>\s*[=:]\s*|\s+)"
    r"(?P<value>\"[^\"]*\"|'[^']*'|\S+)",
    re.IGNORECASE,
)

#: `scheme://user:secret@host` - the password half only.
_URL_CREDENTIALS = re.compile(r"(?P<head>[a-z][a-z0-9+.-]*://[^\s:/@]+:)(?P<secret>[^\s@]+)(?P<tail>@)", re.IGNORECASE)

#: A bearer token in a header echoed into a log.
_BEARER = re.compile(r"(?P<head>bearer\s+)(?P<secret>[A-Za-z0-9._~+/=-]{8,})", re.IGNORECASE)

#: Long hex runs - our own token is 32 bytes of it, and a leaked one is the
#: worst single thing that could appear here.
_LONG_HEX = re.compile(r"\b[0-9a-f]{32,}\b", re.IGNORECASE)


def redact_line(line: str) -> str:
    """Mask anything that looks like a secret in text we did not author."""
    if not line:
        return line
    out = _SEPARATED.sub(lambda m: f"{m.group('flag')}{m.group('sep')}{MASK}", line)
    out = _URL_CREDENTIALS.sub(lambda m: f"{m.group('head')}{MASK}{m.group('tail')}", out)
    out = _BEARER.sub(lambda m: f"{m.group('head')}{MASK}", out)
    out = _LONG_HEX.sub(MASK, out)
    return out


def redact_values(text: str, secrets: Iterable[str]) -> str:
    """Mask exact secret values wherever they appear.

    Longest first: a password that contains another secret as a substring would
    otherwise be half-masked, leaving the rest readable.
    """
    if not text:
        return text
    out = text
    for secret in sorted({s for s in secrets if s and len(s) >= MIN_SECRET_LEN}, key=len, reverse=True):
        out = out.replace(secret, MASK)
    return out


def redact(text: str, secrets: Iterable[str] = ()) -> str:
    """Both passes, values first so a known secret is never merely guessed at."""
    return redact_line(redact_values(text, secrets))


def redact_all(lines: Iterable[str], secrets: Iterable[str] = ()) -> list[str]:
    materialised = list(secrets)
    return [redact(line, materialised) for line in lines]
