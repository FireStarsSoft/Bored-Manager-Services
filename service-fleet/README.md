# Services

A fleet of [BoredAgents](../agent/), watched and controlled from one page.

Point it at an IP range. It finds the machines over SSH, offers to install the
agent on the ones that do not have it, and from then on drives everything over
each agent's own API: deploy a service from a JSON template, watch what it is
doing, and keep a year of daily bandwidth, uptime and incident history for every
machine.

## How it reaches other machines

`ctx.exec` only ever talks to the one machine the app is connected to, so that
machine becomes a jump host. Two transports run from there, and the split is the
whole design:

| | Used for | Why |
|---|---|---|
| **SSH** (`main/fanout.ts`) | finding machines, installing and removing the agent | The only thing that can tell "nothing is at .137" from "a machine is there and refuses the login". Expensive: a session per machine. |
| **HTTP** (`main/agentfan.ts`) | everything an installed agent can answer | One `curl` per request from the jump host. Stopping twenty containers is twenty requests, not twenty SSH sessions. |

Both carry the same three properties, and any edit has to keep them:

1. **No secret is ever an argument.** SSH passwords ride stdin into `sshpass -f`;
   agent tokens go into a `curl --config` file inside a `0700` temp directory.
   `ps` on either machine shows flags and nothing else.
2. **Everything has a timeout**, per request and per batch, plus an
   `AbortSignal` so a cancelled sweep frees the jump host immediately.
3. **Output is framed and bounded.** `xargs -P` interleaves, so each request
   writes its own files and the frame is reassembled in ask order. A request is
   identified by its **index**, not its address - one batch routinely asks the
   same machine two things.

## Which machines get a card

An address inside a range that nothing answered from is a *candidate*, not a
machine: it is swept and stays out of the roster. Without that, watching one
`/24` would draw 249 red cards for addresses nothing has ever lived at.

Three things earn a card: an answer that proves a machine is there (**including**
one that refuses the login), being named as a single address, or having earned
one before. Once earned, a card is kept - a machine that stops answering turns
red rather than disappearing.

| Colour | Means |
|---|---|
| green | The agent is ready and everything it was asked to run is running. |
| amber | No agent, an out-of-date agent, a token that was refused, or a degraded service. The machine is fine; the fleet does not fully manage it. |
| red | Nothing answered, a service failed, or the machine itself reports no internet. |
| grey | Not checked yet. Never an invented zero. |

`no-agent` is deliberately its own colour: the machine answered, the agent is
simply not installed, and that is one click away from being fixed.

## Templates

A template is a JSON document describing one service - which containers or
systemd units it owns, and which values it needs from you. Six ship in
[`templates/`](templates/): three containers (Honeygain, Pawns.app,
PacketStream), one native platform under systemd, and two generic shapes to copy.

They are validated twice, by two implementations, on purpose. The agent's copy
is the one that matters - it stands between a JSON document and root on
somebody's machine. This module's copy (`main/templates/validate.ts`) exists so
you are told what is wrong *before* it is pushed to fifty machines.

What a template can never express:

- **a shell command.** A fixed list of operations, argv only. The one escape
  hatch, `script`, requires `"privileged": true` and is warned about loudly.
- **an argument that splits.** `{{field}}` always becomes exactly one argv
  element, so a password containing a space or a semicolon cannot become two.
- **an unverified download.** Every `download` needs a `sha256`. It may come
  from a field - so a generic template can ask you for both - but never absent.
- **a write outside** `/etc/systemd/system`, `/opt`, `/usr/local/bin` and the
  module's own directories. Paths are literal; a field cannot build one.

Editing a shipped template is exporting it, changing it, and importing it under
the same id. The library then shows it as yours.

## Reports

Each agent measures its own services once a minute and folds each day into one
row, keeping over a year of them. This module pulls whatever is newer than the
last row it stored - so being switched off for a week costs nothing, and the
next collection fetches the week.

**Bandwidth is exact for containers and a floor for host-native services.**
Docker keeps per-container counters; Linux has no per-process byte counter, so a
systemd unit's figure is summed from the socket counters `ss` reports for the
processes in its cgroup. That misses connections which open and close between
two samples, and UDP entirely. Those rows are flagged `floor` and labelled -
a lower bound that says so is worth more than a precise-looking number that is
wrong.

Uptime excludes time the agent itself was not running: that is recorded as an
`agent_gap` incident rather than counted as perfect uptime.

## Credentials are stored in clear text

SSH passwords, sudo passwords and **agent tokens** are all stored unencrypted -
the first two in this module's settings, the token per machine in its host data.
A module has no encryption available to it and pretending otherwise would be
worse than saying so. SSH keys are the recommended way in; the settings page
says this too.

The platform credentials you deploy (a Honeygain password, a PacketStream CID)
are stored by the *agent*, at `/var/lib/boredagent/credentials.json` mode `0640`.
They are never returned by its API and are masked in every log line it serves.

## What it runs on the target

Two things, and nothing else. The SSH sweep runs a short probe that reads the
hostname, the distribution, whether a `boredagent` unit exists and whether
Docker answers - a few hundred bytes, bounded, no unit enumeration. Installing
the agent runs `agent-install.sh`, which the machine downloads itself and checks
against a SHA-256 before unpacking.

## Settings it reads

`refresh['service-fleet']` is how often the pages re-read what is already in
memory. `slowRefresh['service-fleet']` is how often the sweep actually runs -
"Manual only" is a real choice. Telemetry collection has its own, slower timer,
set in Rules.

## Files

| File | What |
|---|---|
| `main/index.ts` | Wires everything and registers every method. |
| `main/fanout.ts` | The SSH jump-host protocol. |
| `main/agentfan.ts` | The HTTP fan-out, through `curl`. |
| `main/hostprobe.ts` | The short script the SSH sweep runs. |
| `main/sweep.ts` | Two passes - SSH to find, HTTP to ask - and the poller. |
| `main/roster.ts` | Which addresses are machines, card colour, every table's rows. |
| `main/agent/` | The pinned release, detection, install and removal. |
| `main/templates/` | The validator, the library, importing, deploying. |
| `main/telemetry/` | Pulling daily rows and incidents, and the report queries. |
| `main/actions.ts` | Instance lifecycle over HTTP. |
| `main/badges.ts` | One colour per meaning, for every chip. |
| `main/store.ts` · `main/config.ts` | Per-machine state; what the user typed. |
| `templates/*.json` | The six templates that ship. |
| `ui/pages/*.json` | The seven pages. |
