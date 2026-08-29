# BoredAgent — the contract

What the agent guarantees to anything talking to it, and the reasoning behind
the parts that are not obvious. [README.md](README.md) is how to use it; this is
what it promises.

It supersedes the working plan the agent was written from
(`InternetSharing/BoredAgent/Plan.MD`, since deleted). Three things changed from
that plan during implementation, and each is marked **amended** below.

---

## 1. What it is

A systemd daemon on one Linux machine, Python 3.12, FastAPI on `0.0.0.0:8741`,
driven from the terminal by `boredagent` and over HTTP by anything holding its
token. It does three jobs:

1. runs services described by JSON **templates** — Docker containers or native
   systemd units;
2. measures internet reachability and public IPv4 **continuously**, one probe a
   second;
3. keeps **daily telemetry** — bytes moved, uptime, incidents — for over a year.

## 2. Decisions that are fixed

| Item | Decision |
|---|---|
| Service and binary name | `boredagent` |
| Bind | `0.0.0.0:8741` |
| Auth | Bearer token on every route except `GET /v1/health` |
| Token | `/etc/boredagent/token`, `0640 root:boredagent`, printed once at install |
| Config | `/etc/boredagent/config.toml`, never overwritten by a later install |
| State | `/var/lib/boredagent/` — credentials `0600`, templates, instances, telemetry |
| Docker | SDK over `/var/run/docker.sock`; the service user is in the `docker` group |
| Runs as | `boredagent`, never root |
| TLS | none in v1 — LAN only, token, firewall |

## 3. Templates — **amended**

The plan defined three hardcoded `PlatformAdapter` classes (Honeygain, Pawns,
PacketStream). That became a **template engine**: the three are now JSON
documents like any other, and containers are the primary case rather than the
only one.

A template is validated by `boredagent/templates/validate.py` before it is ever
stored. That validator is the security boundary of the whole agent — a template
is user-authored JSON executed with root-adjacent privilege — so what it refuses
matters more than what it accepts:

| Rule | Why |
|---|---|
| A fixed opcode list: `dockerRun`, `dockerRm`, `dockerStop`, `dockerPull`, `dockerRmi`, `download`, `writeFile`, `mkdir`, `chmod`, `systemctl`, `apt`, `run`, `script` | There is no member anywhere that is "a line to run". |
| `run` and the others take **argv arrays** | No shell parses them, so nothing in a value can become an operator. |
| `{{field}}` always yields exactly **one** argv element | A password containing a space, a quote or a semicolon stays one argument. |
| `download` requires a `sha256` | A URL says where a file came from; only a hash says what it is. It may come from a field — so a generic template can ask the operator for both — but never be absent, and never be spliced together from a field and other text. |
| `writeFile`/`mkdir` confined to `/etc/systemd/system/`, `/opt/`, `/usr/local/bin/`, `/etc/boredagent-services/`, `/var/lib/boredagent-services/` | A template that can write `sudoers.d` or an `authorized_keys` is a root shell with extra steps. |
| Paths are literal — no `{{field}}` in a path | Otherwise the prefix could be escaped at install time by whoever fills the form. |
| `script` (a real shell) requires `"privileged": true` | The escape hatch exists, but a template has to declare it, and the fleet manager puts that behind a red confirmation. |

Every problem is reported at once, not one per attempt. A template that fails is
rejected, never repaired.

**Re-validated on every read.** A document accepted by an older agent is not
trusted by a newer one because it was trusted once: if a rule tightens, the
template stops loading and says why.

Exactly one unit is `primary` — it decides the instance's state and owns the
default log. A unit marked `optional` may be missing without the instance
failing; that is `degraded`, which is what PacketStream without its watchtower
is: still earning, not updating itself.

## 4. Network monitoring

Two **independent** asyncio loops. Each sleeps one second, runs exactly one
probe, records it, and moves to the next entry in its pool. Every probe is
bounded below the interval (`ping -W 1`, `dig +time=1 +tries=1`) — that is what
keeps "one target per second" true rather than aspirational.

**Reachability.** Seven addresses across four operators. `online` when a
**majority** of the last `offline_window` (5) succeeded; `offline` only when the
**whole** window failed. The asymmetry is the point: one operator blocking ICMP
must not read as an outage, and one reply must not clear one. Transitions emit
`link_down` / `link_up`; the first reading emits neither, because an agent that
has just started has not seen the link come up — it has looked for the first
time.

**Public IPv4.** Seven DNS sources — four Google, two OpenDNS, Akamai — one per
tick. Cloudflare is deliberately excluded: it is in the ping pool, and one
operator answering both questions would let a single outage look like two
independent failures agreeing. A failed tick keeps the last known address and
records the error rather than blanking it. HTTP fallback (`api.ipify.org`, then
`ifconfig.me`) only after a whole DNS round failed, at most once per
`http_ip_fallback_s`.

## 5. Telemetry — **new**

Not in the original plan. Three series under `/var/lib/boredagent/telemetry/`,
one JSONL file per day each: raw `samples` (7 days), `events` (180), and
`daily` (400 — a daily row is about 200 bytes).

Keeping a year locally is what lets a fleet manager that was switched off for a
week ask for the days it missed rather than losing them.

**Bandwidth, and how honest it is.** Containers have their own network
namespace, so Docker keeps exact cumulative counters; sampled once a minute with
`stream=false` and differenced. A decrease means the container restarted, so a
new baseline starts rather than a negative delta being recorded.

Host-native units have no such thing — cgroup v2 dropped byte accounting, and
`/proc/<pid>/net/dev` is per *namespace*, so reading it would report the whole
machine's traffic as one unit's. Instead the unit's PIDs come from
`/sys/fs/cgroup/system.slice/<unit>/cgroup.procs` and its bytes are summed from
the per-socket counters `ss -tuanpi` reports, **accumulated per socket**: a
closed connection keeps what it contributed rather than appearing as the machine
un-sending a gigabyte. Two holes remain — a socket opened *and* closed between
two samples, and UDP — so those rows carry `partial: true` and every surface
labels them a floor. **Amended:** the unit therefore needs
`AmbientCapabilities=CAP_NET_ADMIN CAP_DAC_READ_SEARCH` while still running as
`boredagent`, not as root.

**Incidents** are episodes, not ticks: one `latency_spike` per episode with its
peak and duration, not one per slow second. `unit_down` records whether the exit
was clean; `unit_crash` comes from a restart counter rising. `agent_gap` is a
hole in the agent's own heartbeat — that time counts as neither uptime nor
downtime, so a day the agent spent switched off does not roll up as perfect
uptime and no traffic.

## 6. API `/v1` — **amended**

The plan's `/v1/platforms` became `/v1/templates` + `/v1/instances`, and
`/v1/stats/*` is new.

Everything but health needs `Authorization: Bearer <token>`; the WebSocket takes
`?token=` because a browser cannot set a header on a handshake. Errors: **401**
bad or missing token, **404** unknown template *or a unit that is not that
template's*, **422** a missing required value, **502** Docker or systemd failed.

| Method | Path | |
|---|---|---|
| GET | `/v1/health` | the only open route; says only that an agent is here and its version |
| GET | `/v1/info` | versions, whether Docker and systemd are usable, what is configured |
| GET · PUT · DELETE | `/v1/templates[/{id}]` | the library; `GET` returns field *schemas*, never values |
| GET | `/v1/instances[/{id}]` | installed instances; safe inspect only, never raw `Env`/`Cmd` |
| POST | `/v1/instances/{id}/install` | body = field values |
| POST | `/v1/instances/{id}/uninstall` | `?forget=1` also drops credentials |
| POST | `/v1/instances/{id}/{start\|stop\|restart\|validate}` | |
| GET | `/v1/instances/{id}/logs[/stream]` | snapshot · SSE follow |
| GET | `/v1/net/status` · `/v1/net/history` | live state; five minutes of samples |
| GET | `/v1/stats/{current\|daily\|events}` | telemetry |
| WS · GET | `/v1/ws/live` · `/v1/live/sse` | a frame a second; log lines only on subscribe |

**Reading a unit that is not named by the instance's template is 404, not 403.**
A 403 would confirm the container exists, turning the route into a way to
enumerate what runs on the machine.

## 7. Secrets

Credentials are stored unencrypted at `/var/lib/boredagent/credentials.json`,
mode `0600`. Not encrypted because the agent must read them unattended after a
reboot, so any key it could use would sit beside them. What is enforced instead:

- the API returns field **schemas** and `hasCredentials`, never values;
- container inspects are filtered — no raw `Env`, no `Cmd`;
- every log line is masked **twice**: once against the exact stored values, once
  against the shapes a secret takes (flags documented to carry one, `user:pass@`
  URLs, bearer tokens, long hex runs);
- the token is compared in constant time.

## 8. The installer

`install/agent-install.sh`, three phases, always in this order:

- **Phase 0 — preflight, read-only.** Fourteen checks. A required failure exits
  non-zero having changed *nothing*: a machine that cannot run the agent is left
  exactly as it was. Required: root, Debian family, amd64/arm64, `systemctl`,
  writable `/opt` `/var/lib` `/etc`, the source tree present. The rest warn.
- **Phase 1 — eight numbered steps.** Packages, service user, copy to
  `/opt/boredagent`, venv, token and config, unit, CLI symlink and enable, then
  a health check retried for 15 s.
- **Phase 2 — a fixed result block**, printed whether it succeeded or failed, so
  there is always something to paste. It carries the token, once, on a first
  install; a later install keeps the existing one, because changing it would
  lock out every manager that already had it.

`--uninstall` removes the agent; `--purge` also removes config, credentials and
telemetry. **Neither touches the containers or units the agent installed.**
Removing the manager is not removing what it manages.

## 9. Releasing

`agent/pyproject.toml` holds the version — the single source of truth. The
tarball is packed by `npm run agent:pack`: fixed mtime, fixed owner, fixed
modes, sorted entries, gzip without a timestamp.

**The tar is byte-reproducible across platforms; the gzip wrapper is not.**
Different zlib builds compress identical input to different bytes, so a pack on
a laptop and a pack on a CI runner give `.tar.gz` files of the same length and
different hashes. The packer prints both hashes for that reason: the inner-tar
one answers "did the source change" from anywhere, and the `.tar.gz` one is what
a target machine checks its download against.

So `AGENT_SHA256` in the module must be **the hash of the published asset**.
Release the agent first, read the hash off the release, then pin it and release
the module — which is the order [RELEASE.md](../../BoredManager-Main/docs/RELEASE.md)
prescribes anyway.

Tag `agent-v<version>`. The workflow verifies the tag matches `pyproject.toml`,
runs the tests, checks the installer parses, packs twice and compares, then
publishes with **`--latest=false`** — the app finds a *module* by taking the
single zip on `releases/latest`, so an agent release claiming latest would hide
the module from every install.

## 10. Out of scope

TLS, several users, a web dashboard of its own, Prometheus, reinstalling a
platform when the address changes, Windows. Any of them can be added without
changing the `/v1` prefix — only by adding fields or routes.
