# Services

Watch and control systemd services across every machine in an IP range, from the one machine Bored Manager is connected to.

## What it adds

| Where | What |
|---|---|
| Sidebar → Services | **Overview** (a status wall, one card per machine), **Machines**, **Services** (every machine and unit in one table), **Bulk install**, **Jobs**, **Module settings** |
| Overview cards | **Service fleet** (status donut, on by default) and **Fleet status wall** (the same wall, compact) |
| History | `service-fleet`: machines up, unreachable, degraded, services running and failed |

## How it reaches other machines

A module can only run commands on the machine the app is connected to. So that machine becomes a **jump host**: one command is sent to it, and that command opens up to `maxParallel` SSH sessions of its own and pipes a small script into each target's `sh -s`.

That means the connected machine needs:

- `ssh` (openssh-client), `xargs`, `base64` and `mktemp` — without these the module cannot work at all and says so on every page;
- `timeout` — without it one wedged machine can hold a sweep until the whole command times out;
- `sshpass` — only for addresses that log in with a password. An SSH key needs nothing extra.

Settings → Module settings shows exactly which of these were found. SSH connections are multiplexed (`ControlMaster` / `ControlPersist`), so the second sweep of a subnet is much faster than the first — that is what makes a `/24` practical.

## Which machines get a card

An address inside a subnet only earns a card once something at that address answers. Three things count:

- an answer that proves a machine is there, **including one that refuses the login** or presents an unexpected host key — "found it, cannot get in" is the case most worth seeing;
- being added as a single address rather than found inside a block, so a machine that has never once answered is visibly down rather than absent;
- having earned a card before — a machine that stops answering turns red, it does not disappear.

Without that rule, watching one `/24` would draw 249 red cards for addresses nothing has ever lived at.

## What the colours mean

| Colour | Meaning |
|---|---|
| Green | Reached, and every watched service that applies to it is running |
| Amber | Reached, but a watched service is stopped, failed, masked or not installed; or the machine has no systemd; or nothing can be started on it because sudo is not usable |
| Red | Not reachable, or a service marked **critical** is down (`criticalDownIsRed`) |
| Grey | Not swept yet |

Each card shows the watched services first, then whatever else is running. The rest are in the card's drawer, along with the machine's details and an SSH shell.

## Check, then confirm

Everything that changes more than one thing is a check/apply pair: the module resolves what would happen, reports it, and only then offers to apply. The check **freezes the resolved list** into its token, so a machine that appeared while the report was being read is not acted on — and a bulk install freezes the exact commands, so what runs is what was read.

- **Bulk action by description** — "restart every failed `docker.service` on `10.0.0.*`".
- **Bulk install** — installs a watched service everywhere it is missing, using each machine's own package manager.
- **Address rules** and **watched services** — so a subnet that covers 65 thousand addresses is refused before it is saved, not on the next sweep.
- **Rules** — the limits everything else measures against.

Ticking rows in the Services table and pressing Start or Stop skips the check step: what is selected is on screen already, and every one of those buttons asks for confirmation first.

## Credentials are stored in clear text

A password typed into an address rule is written to `data/user-settings/module-config/service-fleet.json` **unencrypted**. A module has no way to encrypt anything: `ctx.configSet` writes plain JSON, and the app's own encryption is server-private. The check that saves a rule says so every time.

Use an SSH key where you can — there is then nothing to store. The key path is read on the **connected machine**, not on the server running Bored Manager.

Passwords never appear in a process list on either machine: a login password is written to a file inside a private temporary directory and handed to `sshpass -f`, and a sudo password is a shell variable inside the script that is piped to the target.

## What it runs on the target

A sweep only reads, and needs no sudo:

```sh
hostname; . /etc/os-release; command -v systemctl; id -u; uname -r; cut -d' ' -f1 /proc/uptime
systemctl list-units --type=service --state=running,failed --plain --no-legend --no-pager
systemctl show --no-pager -p Id -p LoadState -p ActiveState -p SubState -p UnitFileState -p Description <watched units>
sudo -n true          # only to find out whether control is possible
```

An action runs `systemctl <action> <unit>` as root, through `sudo -S` or `sudo -n` per the address rule. Bulk install adds the machine's own package manager (`apt-get install -y`, `dnf install -y`, `zypper --non-interactive install`, `pacman -S --noconfirm`, `apk add`) and then `systemctl enable` / `start`. Nothing is ever written to the target's disk, and nothing is downloaded — a custom install command containing a URL is refused.

Only systemd is supported. A machine without it gets an amber card saying so rather than an empty one.

## Settings it reads

| Setting | What it does |
|---|---|
| Update intervals → Services (fleet) → slow | How often every machine is swept over SSH. **Manual only** is a real choice; the sweep then runs on request and after an action. |
| Update intervals → Services (fleet) → fast | How often the pages re-read the last sweep. This never touches the network. |
| Module settings → Rules | Parallelism, timeouts, connection reuse, the largest range allowed, how much of each machine to read, and when a check starts warning. |

Only the sweep, the jobs, and four explicit buttons (Probe, Test, a unit's detail panel, an action) go to the network. Everything the pages poll is answered from memory.

## When it shows nothing

- **"This module cannot reach anything from here"** — the connected machine has no `ssh`. Install openssh-client on it, or connect somewhere that has it.
- **No cards** — either nothing is configured yet, or nothing in the configured range answered. Machines page → Sweep now, and check the address rule's **Test**.
- **No services on a card** — the machine was reached but has no systemd, or the rules are set to list only watched services and none apply here.

## Files

| File | What |
|---|---|
| `main/index.ts` | `activate`: builds everything, registers all 36 methods, owns the lifecycle |
| `main/fanout.ts` | The jump-host script, the stdin protocol, and the framing that survives `xargs -P` |
| `main/units.ts` | The scripts that run on the monitored machines, and their parsers |
| `main/sweep.ts` | The poller: plan the addresses, fan out, publish the wall |
| `main/roster.ts` | Which addresses are machines, what colour each card is, and the table rows |
| `main/store.ts` | The roster and job history on disk, per jump host |
| `main/config.ts` | Address rules, watched services, and which credentials reach one address |
| `main/net.ts` | IPv4 arithmetic and the machine-matching globs |
| `main/rules.ts` | The limits, their bounds, and the overrides in force |
| `main/probe.ts` | What the connected machine can do for us |
| `main/actions.ts` | One machine or many: `systemctl`, and the `journalctl` tail |
| `main/jobs.ts` | Cancellable jobs, one item per machine |
| `main/bulk.ts` | Bulk action by description, with the resolved list frozen into the token |
| `main/install.ts` | Bulk install, with the exact commands frozen into the token |
| `main/editors.ts` | The check/apply pairs behind address rules, watched services and rules |
| `main/options.ts` | What the dropdowns offer, all from memory |
