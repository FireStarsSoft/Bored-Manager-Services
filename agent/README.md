# BoredAgent

A small daemon that runs on one Linux machine and does three things:

- **runs services from templates** — Docker containers or native systemd units,
  described by JSON rather than by code, so adding a platform is a file rather
  than a release;
- **watches the connection** — one probe a second, rotating through four
  operators, so "the internet is down" can be told apart from "one operator is
  having a bad minute";
- **remembers** — bytes moved, uptime and incidents, folded into one row per
  unit per day and kept for over a year.

It is driven from the terminal with `boredagent`, and over HTTP by
[Bored Manager's Services module](../service-fleet/), which manages a fleet of
these at once.

---

## Installing

On the target machine, from a copy of this directory:

```bash
sudo bash install/agent-install.sh
```

The installer runs in three phases and prints all of them. **Phase 0 is
read-only**: it checks fourteen things and, if a required one fails, stops
before it has changed anything at all. Phase 1 is eight numbered steps. Phase 2
is a fixed result block, printed whether it worked or not, that ends with the
token:

```text
========== KET QUA CAI DAT BOREDAGENT ==========
Ket qua     : SUCCESS
Service     : active
Health HTTP : OK
Bind        : 0.0.0.0:8741
URL LAN     : http://192.168.1.40:8741
Token file  : /etc/boredagent/token
Token       : 9f2c…                    <- shown once
CLI         : /usr/local/bin/boredagent
UFW goi y   : sudo ufw allow from 192.168.0.0/16 to any port 8741 proto tcp
===============================================
```

**Write the token down.** It is printed once, on a first install, and is the
only way anything reaches this agent. It stays in `/etc/boredagent/token`.

Removing it:

```bash
sudo bash install/agent-install.sh --uninstall   # the agent, not what it runs
sudo bash install/agent-install.sh --purge       # also config, credentials, telemetry
```

Neither touches the containers or units the agent installed. Removing the
manager is not the same as removing what it manages.

---

## Using it from the terminal

```bash
boredagent status              # network and every instance, as a table
boredagent net                 # reachability and public address
boredagent stats               # today's bytes and uptime per unit
boredagent stats --days 30     # the daily rows
boredagent events --days 7     # link drops, address changes, crashes, latency episodes
boredagent logs honeygain -f   # follow one unit's log, secrets masked
boredagent validate pawns      # is it running, and does its log say it was accepted
```

Installing a service means importing a template and filling in what it asks
for:

```bash
boredagent templates import ../service-fleet/templates/honeygain.container.json
boredagent install honeygain --interactive
```

Every command except `serve` and `token show` is an HTTP client talking to the
running daemon. That is deliberate: two code paths both driving Docker would
drift, and the one the CLI used would be the one nobody tested. It also means
the daemon has to be running, and the error when it is not says so.

---

## Templates

A template describes one service. Two kinds — `container` (Docker) and
`service` (a systemd unit) — with the same vocabulary underneath.

```jsonc
{
  "id": "honeygain",
  "displayName": "Honeygain",
  "kind": "container",
  "fields": [
    { "id": "email",    "label": "Account email", "required": true },
    { "id": "password", "label": "Password", "input": "password", "required": true },
    { "id": "device",   "label": "Device name", "required": true }
  ],
  "container": {
    "units": [{
      "name": "honeygain",
      "image": "honeygain/honeygain",
      "primary": true,
      "args": ["-tou-accept", "-email", "{{email}}", "-pass", "{{password}}", "-device", "{{device}}"]
    }]
  },
  "redact": ["password"]
}
```

Six worked examples live in [`../service-fleet/templates/`](../service-fleet/templates/):
three containers (Honeygain, Pawns.app, PacketStream), one native platform
(Pawns.app under systemd) and two generic shapes to copy for anything else.

### What a template cannot do, and why

A template is JSON somebody wrote, arriving over HTTP, executed with
root-adjacent privilege. The rules below are what make that a reasonable thing
to do, and they are enforced at import — a template that breaks one is rejected
with every problem listed, not the first.

| Rule | Reason |
|---|---|
| A fixed set of opcodes, and no way to express a shell command | There is no member anywhere that is "a line to run". Everything is argv. |
| `{{field}}` always becomes exactly **one** argv element | A value containing a space, a quote or a semicolon is one argument containing those characters, never two arguments and an operator. |
| `download` requires a literal `sha256` | A URL says where a file came from; only a hash says what it is. The URL and the hash may both come from a field — the operator is then the one vouching — but neither may be absent, and neither may be spliced together from parts. |
| `writeFile` and `mkdir` are limited to a few directories | A template that can write `/etc/sudoers.d` or an `authorized_keys` is a root shell with extra steps. |
| Paths are literal — no `{{field}}` in a path | Otherwise the allowed prefix could be escaped at install time by whoever fills the form. |
| `script` (a real shell) needs `"privileged": true` | The escape hatch exists, but a template has to declare that it is one, and the fleet manager puts that behind a red confirmation naming the template. |

---

## The API

Everything but `GET /v1/health` needs `Authorization: Bearer <token>`.

```bash
TOKEN=$(sudo cat /etc/boredagent/token)
curl -s http://192.168.1.40:8741/v1/health
curl -s -H "Authorization: Bearer $TOKEN" http://192.168.1.40:8741/v1/net/status
curl -s -H "Authorization: Bearer $TOKEN" http://192.168.1.40:8741/v1/stats/daily?since=1756425600000
```

| Method | Path | |
|---|---|---|
| GET | `/v1/health` | the only open route; says only that an agent is here and its version |
| GET | `/v1/info` | versions, whether Docker and systemd are usable, what is configured |
| GET · PUT · DELETE | `/v1/templates[/{id}]` | the library |
| GET | `/v1/instances[/{id}]` | what is installed, and its state |
| POST | `/v1/instances/{id}/install` · `/uninstall` · `/start` · `/stop` · `/restart` · `/validate` | |
| GET | `/v1/instances/{id}/logs` · `/logs/stream` | snapshot · SSE follow |
| GET | `/v1/net/status` · `/v1/net/history` | live reachability, and five minutes of samples |
| GET | `/v1/stats/current` · `/daily` · `/events` | today, the daily rows, the incident log |
| WS | `/v1/ws/live?token=…` | a frame a second; log lines only if you subscribe |

A WebSocket takes its token in the query string, because a browser cannot set a
header on a handshake. Subscribe to a log with
`{"subscribe": ["logs", "packetstream", "psclient"]}`.

---

## What the numbers mean

**Reachability.** One ping a second, rotating through seven addresses across
four operators. A **majority** of the last five makes it online; the **whole**
window has to fail before it is offline. That asymmetry is the point — a single
operator blocking ICMP should not read as an outage, and one reply should not
clear one.

**Public address.** One DNS source a second, rotating through Google, OpenDNS
and Akamai. Cloudflare is deliberately not among them: it is in the ping pool,
and one source answering both questions would let a single operator's outage
look like two independent failures agreeing with each other. A failed tick keeps
the last known address rather than blanking it.

**Bandwidth, and where it is honest.** Containers have their own network
namespace, so Docker keeps exact counters and the figure is exact. Host-native
units do not — Linux has no per-process byte counter — so their figure is built
from the socket counters `ss` reports for the processes in the unit's cgroup.
That method misses connections that open *and* close between two samples, and
UDP entirely. Rows measured that way are flagged **`partial`**, and the CLI and
the fleet UI label them:

> `* a floor rather than a total`

A floor that says so is worth more than a precise-looking number that is wrong.

**Uptime.** Every sample writes the time it ran. A gap larger than the sampling
interval allows becomes an `agent_gap` incident, and that time counts as neither
uptime nor downtime — so a day the agent spent switched off does not roll up as
a day of perfect uptime and no traffic.

---

## Security, stated plainly

- **The token is the only thing protecting this.** It is 32 bytes of hex, and it
  is compared in constant time. There is no second factor and no user accounts.
- **There is no TLS.** Traffic between a fleet manager and this agent is plain
  HTTP on your LAN. On a home network that is a reasonable trade; on a network
  you share with people you do not know, it is not. Put a firewall rule in front
  of the port:
  ```bash
  sudo ufw allow from 192.168.0.0/16 to any port 8741 proto tcp
  ```
- **Credentials are stored unencrypted**, at `/var/lib/boredagent/credentials.json`,
  mode `0640`. They are not encrypted because the agent has to read them
  unattended after a reboot, so any key it could use would have to sit beside
  them. What is enforced instead is that they never leave: the API returns field
  *schemas* and never values, container inspects are filtered to drop `Env` and
  `Cmd`, and every log line is masked twice — once against the exact stored
  values, and once against the shapes a secret takes.
- **The service does not run as root.** It runs as `boredagent`, in the `docker`
  group, with exactly two extra capabilities (`CAP_NET_ADMIN`,
  `CAP_DAC_READ_SEARCH`) so it can read the socket statistics that per-process
  bandwidth needs.
- **CORS defaults to `*`.** Convenient for a browser-based manager on the LAN,
  and a smaller risk than cookies would be because the token is not sent
  automatically. Narrow it in `config.toml` if you know the origin.

---

## Configuration

`/etc/boredagent/config.toml`, generated from
[`config/config.example.toml`](config/config.example.toml) on a first install
and **never overwritten** afterwards. Every key also has a default in code, so a
file written by an older version keeps working when new keys appear.

Environment overrides: `BOREDAGENT_CONFIG`, `BOREDAGENT_TOKEN`,
`BOREDAGENT_BIND`, `BOREDAGENT_PORT`.

---

## Working on it

```bash
python3 -m venv venv && ./venv/bin/pip install -e '.[dev]'
./venv/bin/pytest          # 100 tests, no daemon and no Docker required
./venv/bin/python -m boredagent serve --port 8742
```

The tests build a whole app through `create_app` around a fake Docker and a
temporary state directory, so they exercise the production dependency graph —
including the auth dependencies, which are the thing most worth not accidentally
testing around.
