"""The terminal half. A thin HTTP client, deliberately.

Every command except `serve` and `token show` talks to the running daemon over
HTTP rather than doing the work itself. That is not indirection for its own
sake: two code paths that both drive Docker would drift, and the one the CLI
used would be the one nobody tested. This way the terminal and a fleet manager
exercise exactly the same routes.

The consequence is that most commands need the daemon to be running, and the
error when it is not says so in the one sentence that fixes it.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import typer

from . import __version__
from .config import DEFAULT_CONFIG_PATH, load_config

app = typer.Typer(
    add_completion=False,
    no_args_is_help=True,
    help="Control the BoredAgent daemon on this machine.",
)
templates_app = typer.Typer(no_args_is_help=True, help="The template library.")
token_app = typer.Typer(no_args_is_help=True, help="The bearer token this agent requires.")
app.add_typer(templates_app, name="templates")
app.add_typer(token_app, name="token")

DEFAULT_URL = "http://127.0.0.1:8741"


class Client:
    def __init__(self, url: str, token: str) -> None:
        self._url = url.rstrip("/")
        self._token = token

    def request(self, method: str, path: str, body: Any = None, **params: Any) -> Any:
        import httpx

        try:
            response = httpx.request(
                method,
                f"{self._url}{path}",
                headers={"authorization": f"Bearer {self._token}"},
                json=body,
                params={k: v for k, v in params.items() if v is not None},
                timeout=120.0,
            )
        except httpx.ConnectError:
            typer.secho(
                "boredagent.service is not answering on "
                f"{self._url} - try: sudo systemctl start boredagent",
                fg=typer.colors.RED,
                err=True,
            )
            raise typer.Exit(2) from None
        except httpx.HTTPError as err:
            typer.secho(f"request failed: {err}", fg=typer.colors.RED, err=True)
            raise typer.Exit(2) from None

        if response.status_code == 401:
            typer.secho(
                "the token was refused. Check --token-file, or BOREDAGENT_TOKEN.",
                fg=typer.colors.RED,
                err=True,
            )
            raise typer.Exit(3)
        try:
            payload = response.json()
        except ValueError:
            typer.secho(f"unreadable answer ({response.status_code})", fg=typer.colors.RED, err=True)
            raise typer.Exit(2) from None
        if response.status_code >= 400:
            detail = payload.get("detail") or payload.get("message") or payload
            typer.secho(f"{response.status_code}: {detail}", fg=typer.colors.RED, err=True)
            raise typer.Exit(1)
        return payload

    def get(self, path: str, **params: Any) -> Any:
        return self.request("GET", path, None, **params)

    def post(self, path: str, body: Any = None, **params: Any) -> Any:
        return self.request("POST", path, body, **params)


def _resolve_token(token: str | None, token_file: Path | None) -> str:
    if token:
        return token
    import os

    from_env = os.environ.get("BOREDAGENT_TOKEN")
    if from_env:
        return from_env.strip()
    path = token_file or load_config().token_file
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        typer.secho(
            f"no token: {path} could not be read and BOREDAGENT_TOKEN is not set. "
            "Run this as root, or pass --token.",
            fg=typer.colors.RED,
            err=True,
        )
        raise typer.Exit(3) from None


@app.callback()
def main_callback(
    ctx: typer.Context,
    url: str = typer.Option(DEFAULT_URL, "--url", help="Where the daemon is listening."),
    token: str | None = typer.Option(None, "--token", help="Overrides the token file. Not logged."),
    token_file: Path | None = typer.Option(None, "--token-file", help="Where to read the token from."),
) -> None:
    ctx.obj = {"url": url, "token": token, "token_file": token_file}


def _client(ctx: typer.Context) -> Client:
    options = ctx.obj or {}
    return Client(options.get("url") or DEFAULT_URL, _resolve_token(options.get("token"), options.get("token_file")))


def _print(value: Any) -> None:
    typer.echo(json.dumps(value, indent=2, sort_keys=True))


def _bytes(value: int | None) -> str:
    if not value:
        return "0 B"
    size = float(value)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} B"
        size /= 1024
    return f"{size:.1f} TB"


# --------------------------------------------------------------------- serve


@app.command()
def serve(
    config: Path | None = typer.Option(None, "--config", help="Overrides BOREDAGENT_CONFIG."),
    host: str | None = typer.Option(None, "--host"),
    port: int | None = typer.Option(None, "--port"),
) -> None:
    """Run the daemon in the foreground. For debugging; use systemd in production."""
    import uvicorn

    from .app import create_app

    resolved = load_config(config)
    application = create_app(resolved)
    uvicorn.run(
        application,
        host=host or resolved.bind,
        port=port or resolved.port,
        log_level="info",
        access_log=False,
    )


# ------------------------------------------------------------------ reading


@app.command()
def status(ctx: typer.Context) -> None:
    """Network and every instance, as a table."""
    client = _client(ctx)
    net = client.get("/v1/net/status")
    instances = client.get("/v1/instances")["instances"]

    online = net.get("online")
    label = "online" if online else ("offline" if online is False else "not measured yet")
    colour = typer.colors.GREEN if online else (typer.colors.RED if online is False else typer.colors.YELLOW)
    typer.secho(f"Network   : {label}", fg=colour)
    typer.echo(f"Public IP : {net.get('publicIp') or '-'}  (via {net.get('lastIpSource') or '-'})")
    latency = net.get("latencyMs")
    typer.echo(
        f"Latency   : {latency if latency is not None else '-'} ms"
        f"  (last target {net.get('lastPingTarget') or '-'})"
    )
    typer.echo("")
    if not instances:
        typer.echo("No templates are loaded. Push one with: boredagent templates import <file>")
        return
    typer.echo(f"{'TEMPLATE':<16} {'STATE':<10} UNITS")
    for row in instances:
        units = ", ".join(f"{u['name']}={u['state']}" for u in row["units"])
        typer.echo(f"{row['id']:<16} {row['state']:<10} {units}")


@app.command()
def net(ctx: typer.Context, history: bool = typer.Option(False, "--history")) -> None:
    """Reachability and public address."""
    client = _client(ctx)
    if history:
        _print(client.get("/v1/net/history", kind="ping", limit=50))
        return
    _print(client.get("/v1/net/status"))


@app.command()
def instances(ctx: typer.Context) -> None:
    """Everything installed on this machine."""
    _print(_client(ctx).get("/v1/instances"))


@app.command()
def stats(ctx: typer.Context, days: int = typer.Option(0, "--days", help="Daily rows instead of today.")) -> None:
    """Bandwidth and uptime: today, or the last N days."""
    client = _client(ctx)
    if days <= 0:
        current = client.get("/v1/stats/current")
        if not current.get("enabled"):
            typer.echo("Telemetry is switched off in the config.")
            return
        typer.echo(f"Day {current.get('day')}, so far:")
        typer.echo(f"{'TEMPLATE/UNIT':<28} {'RX':>10} {'TX':>10} {'UPTIME':>8}")
        for row in current.get("units", []):
            name = f"{row['template']}/{row['unit']}"
            flag = " *" if row.get("partial") else ""
            typer.echo(
                f"{name:<28} {_bytes(row['rx']):>10} {_bytes(row['tx']):>10}"
                f" {row['uptimeRatio'] * 100:>7.1f}%{flag}"
            )
        if any(row.get("partial") for row in current.get("units", [])):
            typer.echo("")
            typer.echo(
                "* a floor rather than a total: host-native units are measured from socket "
                "counters, which miss connections that open and close between samples."
            )
        return

    import time

    since = int(time.time() * 1000) - days * 86_400_000
    rows = client.get("/v1/stats/daily", since=since).get("rows", [])
    _print(rows)


@app.command()
def events(
    ctx: typer.Context,
    days: int = typer.Option(1, "--days"),
    kind: str | None = typer.Option(None, "--kind"),
) -> None:
    """Incidents: link drops, address changes, units going down, latency episodes."""
    import time

    since = int(time.time() * 1000) - max(1, days) * 86_400_000
    rows = _client(ctx).get("/v1/stats/events", since=since, kind=kind).get("rows", [])
    if not rows:
        typer.echo("Nothing recorded in that window.")
        return
    for row in rows:
        moment = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(row["ts"] / 1000))
        detail = {k: v for k, v in row.items() if k not in {"ts", "kind"}}
        typer.echo(f"{moment}  {row['kind']:<14} {json.dumps(detail, sort_keys=True)}")


@app.command()
def logs(
    ctx: typer.Context,
    template_id: str = typer.Argument(..., metavar="TEMPLATE"),
    tail: int = typer.Option(200, "--tail"),
    since: str | None = typer.Option(None, "--since"),
    unit: str | None = typer.Option(None, "--unit"),
    follow: bool = typer.Option(False, "-f", "--follow"),
) -> None:
    """Container or journal lines for one template, with secrets masked."""
    options = ctx.obj or {}
    token = _resolve_token(options.get("token"), options.get("token_file"))
    base = (options.get("url") or DEFAULT_URL).rstrip("/")
    if not follow:
        body = Client(base, token).get(
            f"/v1/instances/{template_id}/logs", tail=tail, since=since, unit=unit
        )
        for line in body["lines"]:
            typer.echo(line)
        return

    import httpx

    params = {"tail": tail}
    if unit:
        params["unit"] = unit
    try:
        with httpx.stream(
            "GET",
            f"{base}/v1/instances/{template_id}/logs/stream",
            headers={"authorization": f"Bearer {token}"},
            params=params,
            timeout=None,
        ) as response:
            if response.status_code >= 400:
                typer.secho(f"{response.status_code}: could not follow", fg=typer.colors.RED, err=True)
                raise typer.Exit(1)
            for line in response.iter_lines():
                if line.startswith("data: "):
                    payload = json.loads(line[6:])
                    typer.echo(payload.get("line", ""))
    except KeyboardInterrupt:
        # Ctrl+C ends the follow, not the daemon.
        return
    except httpx.ConnectError:
        typer.secho(
            f"boredagent.service is not answering on {base} - try: sudo systemctl start boredagent",
            fg=typer.colors.RED,
            err=True,
        )
        raise typer.Exit(2) from None


# ----------------------------------------------------------------- lifecycle


def _lifecycle(ctx: typer.Context, template_id: str, verb: str) -> None:
    result = _client(ctx).post(f"/v1/instances/{template_id}/{verb}")
    message = result.get("message") or json.dumps(result, sort_keys=True)
    typer.secho(message, fg=typer.colors.GREEN if result.get("ok", True) else typer.colors.RED)


@app.command()
def start(ctx: typer.Context, template_id: str = typer.Argument(..., metavar="TEMPLATE")) -> None:
    """Start every unit of one template."""
    _lifecycle(ctx, template_id, "start")


@app.command()
def stop(ctx: typer.Context, template_id: str = typer.Argument(..., metavar="TEMPLATE")) -> None:
    """Stop every unit of one template."""
    _lifecycle(ctx, template_id, "stop")


@app.command()
def restart(ctx: typer.Context, template_id: str = typer.Argument(..., metavar="TEMPLATE")) -> None:
    """Restart every unit of one template."""
    _lifecycle(ctx, template_id, "restart")


@app.command()
def validate(ctx: typer.Context, template_id: str = typer.Argument(..., metavar="TEMPLATE")) -> None:
    """Check an instance is running, and that its log does not say it was rejected."""
    result = _client(ctx).post(f"/v1/instances/{template_id}/validate")
    colour = typer.colors.GREEN if result.get("ok") else typer.colors.RED
    typer.secho(f"{template_id}: {result.get('state')}", fg=colour)
    for issue in result.get("issues", []):
        mark = "!" if issue["level"] == "error" else "-"
        typer.echo(f"  {mark} {issue['message']}")
    typer.echo(f"\n  {result.get('note', '')}")


@app.command()
def install(
    ctx: typer.Context,
    template_id: str = typer.Argument(..., metavar="TEMPLATE"),
    interactive: bool = typer.Option(False, "--interactive", "-i", help="Prompt for each field."),
    set_: list[str] = typer.Option([], "--set", help="field=value, repeatable."),
) -> None:
    """Install a template's units with the values it asks for."""
    client = _client(ctx)
    template = client.get(f"/v1/templates/{template_id}")
    values: dict[str, str] = {}
    for pair in set_:
        key, _, value = pair.partition("=")
        if not key or not _:
            typer.secho(f'--set "{pair}" is not field=value', fg=typer.colors.RED, err=True)
            raise typer.Exit(1)
        values[key] = value

    if interactive:
        for field in template["fields"]:
            if field["id"] in values:
                continue
            label = field["label"] + (" (required)" if field["required"] else "")
            default = field.get("default") or ""
            # Reading from the tty rather than stdin so that piping a script
            # into this command does not silently consume its own remaining
            # lines as answers.
            answer = typer.prompt(
                label,
                default=default,
                hide_input=bool(field.get("secret")),
                show_default=not field.get("secret"),
            )
            if answer:
                values[field["id"]] = answer
    else:
        for field in template["fields"]:
            if field["required"] and field["id"] not in values:
                typer.secho(
                    f'"{field["id"]}" is required. Use --interactive, or --set {field["id"]}=...',
                    fg=typer.colors.RED,
                    err=True,
                )
                raise typer.Exit(1)

    result = client.post(f"/v1/instances/{template_id}/install", values)
    typer.secho(result.get("message", "installed"), fg=typer.colors.GREEN)


@app.command()
def uninstall(
    ctx: typer.Context,
    template_id: str = typer.Argument(..., metavar="TEMPLATE"),
    forget: bool = typer.Option(False, "--forget", help="Also delete the stored credentials."),
) -> None:
    """Remove a template's units. Credentials are kept unless --forget."""
    result = _client(ctx).post(f"/v1/instances/{template_id}/uninstall", None, forget=1 if forget else 0)
    typer.secho(result.get("message", "removed"), fg=typer.colors.GREEN)


# ------------------------------------------------------------------ templates


@templates_app.command("list")
def templates_list(ctx: typer.Context) -> None:
    """Templates this agent has, and any that will not load."""
    body = _client(ctx).get("/v1/templates")
    for template in body["templates"]:
        creds = "yes" if template["hasCredentials"] else "no"
        typer.echo(
            f"{template['id']:<16} {template['kind']:<10} units={','.join(template['units'])}  credentials={creds}"
        )
    for template_id, findings in (body.get("problems") or {}).items():
        typer.secho(f"{template_id}: will not load", fg=typer.colors.RED)
        for finding in findings:
            typer.echo(f"   {finding['level']}: {finding['where']}: {finding['message']}")


@templates_app.command("import")
def templates_import(
    ctx: typer.Context,
    path: Path = typer.Argument(..., help="A template JSON file."),
    template_id: str | None = typer.Option(None, "--id", help="Defaults to the id inside the file."),
) -> None:
    """Add or replace one template."""
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as err:
        typer.secho(f"{path}: {err}", fg=typer.colors.RED, err=True)
        raise typer.Exit(1) from None
    resolved = template_id or document.get("id")
    if not resolved:
        typer.secho("the file has no id, and none was given with --id", fg=typer.colors.RED, err=True)
        raise typer.Exit(1)
    result = _client(ctx).request("PUT", f"/v1/templates/{resolved}", document)
    typer.secho(f"{resolved} imported", fg=typer.colors.GREEN)
    for finding in result.get("findings", []):
        typer.secho(f"  {finding['level']}: {finding['message']}", fg=typer.colors.YELLOW)


@templates_app.command("remove")
def templates_remove(ctx: typer.Context, template_id: str = typer.Argument(...)) -> None:
    """Remove a template from the library. Anything it installed keeps running."""
    result = _client(ctx).request("DELETE", f"/v1/templates/{template_id}")
    typer.secho(result.get("message", "removed"), fg=typer.colors.GREEN)


# --------------------------------------------------------------------- token


@token_app.command("show")
def token_show(
    print_it: bool = typer.Option(False, "--print", help="Print the token itself, not just its path."),
    token_file: Path | None = typer.Option(None, "--token-file"),
) -> None:
    """Where the token lives. Reads the file directly - no daemon needed."""
    path = token_file or load_config().token_file
    typer.echo(f"Token file: {path}")
    if not print_it:
        typer.echo("Pass --print to show the token itself.")
        return
    try:
        typer.echo(path.read_text(encoding="utf-8").strip())
    except OSError as err:
        typer.secho(f"could not read it: {err}", fg=typer.colors.RED, err=True)
        raise typer.Exit(3) from None


@app.command()
def version() -> None:
    """Print the agent version."""
    typer.echo(__version__)


def main() -> None:
    app()


if __name__ == "__main__":  # pragma: no cover
    main()
