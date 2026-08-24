# Changelog

Module versions are independent of the app's. Needs Bored Manager **0.3.2** for the `pie` block.

## 1.1.8

- README: the Files table said `main/index.ts` registers "all 36 methods".
  It has registered 35 since the dead `jobs` method went in 1.1.7, so it now
  says what it does instead of how many, which cannot go stale again.

## 1.1.7

- Removed the dead `jobs` method: the Jobs page reads the `jobs` stream and a
  freshly opened surface is seeded from `snapshots()`, so no caller existed.
  (`capabilities` stays - it is the read-back for the jump-host probe and
  exercised by the module's tests.)

## 1.1.6

- Removed a helper that worked out which rules had been overridden for a
  settings page that does not use it - nothing called it.

## 1.1.5

- **Fixed: the Probe button opened two SSH sessions to the machine it was
  re-reading** - one to read it, and a second, immediately afterwards, only to
  republish the wall it had just updated.
- Fixed: a sweep that reached a machine and found nothing changed still wrote
  the roster to disk, because the "last seen" stamp counts as a change. It no
  longer does; the current value is written out with the next real change and
  when the module stops.
- Performance: the Machines and Services tables rebuilt and re-sorted every
  row on every fast tick - tens of thousands of rows for a /24 of machines -
  for a roster that had not moved. Both are now built once per change.

## 1.1.4

- **Fixed: cancelling a sweep dropped every address not yet reached that round
  from the status wall, the Services table and bulk targeting** - a sweep only
  covers a prefix of the configured addresses when it is cut short, but it was
  folded in as if it were a complete one, so anything after the cut-off point
  read as "no longer configured" until the next full sweep finished. A
  cancelled sweep now merges what it did reach onto the existing roster
  instead of replacing it outright.
- **Fixed: cancelling a sweep, or switching the module off mid-sweep, did not
  actually stop the batch already in flight** - the jump host kept fanning out
  to the fleet for up to the full sweep timeout regardless, because the only
  thing either action did was stop the *next* batch from starting. Both now
  abort the SSH command that is actually running.
- **Fixed: a jump host with no `timeout` binary (a stripped-down BusyBox
  image) refused to sweep at all**, even though the degraded mode described in
  Module settings - one unresponsive machine can hold up the batch for longer
  - is something the fan-out script can just run in. It now falls back to
  running `ssh` without the per-host limit instead of failing every address
  with "no sshpass" (an exit code that, without `timeout` wrapping it, no
  longer means what that message said).
- **Fixed: 'Last reached' on a machine that has never once answered showed
  roughly 20,000 days** instead of "never" - a missing timestamp was sent as
  `0`, which the age formatter reads as an epoch-1970 start rather than "no
  value".

## 1.1.3

- **Fixed: with two machines connected and this module enabled on both, each
  ran its own automatic sweep of the same configured address range** - the
  targets belong to the module, not to whichever machine happens to be the
  jump host, so this doubled the fan-out load for no benefit. Only one
  connected machine's instance runs the automatic sweep now; a manual "sweep
  now" still works from either.
- **Fixed: editing the targets or watched units from one connected machine
  could silently discard an edit just made from another - or one made by hand
  in `service-fleet.json`.** Both shared the same on-disk settings, but each
  instance kept its own copy in memory that only refreshed on its *own* next
  write, so whichever write landed last (through the UI or a text editor) won
  regardless of which was newer. Every read now goes straight to the shared
  document instead.

## 1.1.2

- **Fixed: the Sweep and Fleet sections' refresh buttons always showed
  "never" for their age**, even right after a sweep had just finished - the
  sections had a refresh control but nothing feeding it a timestamp. They now
  resolve the age from the sweep/hosts streams' own `t`.

## 1.1.1

- **Fixed: a sweep or job in flight when the module stopped could take the
  server down.** Fanning out to a fleet can sit in `ssh` for the whole sweep
  timeout; if the module was disabled, reloaded or the jump host disconnected
  meanwhile, the results came back to a revoked context and the status push,
  the log line and the job history write threw from a promise nobody was
  holding - which ended the server process. The sweeper and the job runner now
  return quietly once the module has stopped.
- **Fixed: a sweep from a jump host without logind reported every address as
  "timed out".** The fan-out script reads XDG_RUNTIME_DIR to place its SSH
  control sockets, and under `set -u` an unset one aborted the whole script
  before it had read a single record - normal on Alpine, OpenWrt, a container,
  or with `UsePAM no`. It is read defensively now.
- **The batch's passwords live for less time on the jump host.** The record
  file carrying one base64 password per host is deleted as soon as the workers
  have read it, rather than staying for the whole batch; the sweep for
  leftovers from a hard-killed run went from an hour to five minutes.
- **Module settings warns before it turns host-key checking off.** A checkbox
  has no "untouched" state, so saving that form to change something else was
  silently switching strict host-key checking back off. The check step now says
  so before you apply it.

## 1.1.0

- **Overview card is a donut.** The Service fleet widget shows machine counts as a donut: total in the centre, slices for Normal / Warning / Error / Unknown (the same colours as the status wall). Needs the app's `pie` block.

## 1.0.0

First release.

- **A status wall.** One card per machine, coloured by that machine's own health: the address, a one-line summary, a collapsible note saying what is wrong, and the services it is running as chips — watched ones first. Two chip rows by default with an arrow for the rest, and a column count you can change.
- **Many machines from one connection.** The machine the app is connected to is used as a jump host: one command fans out to the whole configured range with `xargs -P` and `ssh`, reusing connections between sweeps so a second pass over a `/24` is fast.
- **Addresses, blocks and ranges.** Watch `10.0.0.5`, `10.0.0.0/24` or `10.0.0.10-40`, each with its own user, port, key or password and sudo mode. The narrowest rule covering an address wins, so one machine can have its own login inside a subnet-wide default.
- **Watched services.** Name the units that matter, optionally only on some machines, and mark the ones whose absence is critical. They lead every card and decide its colour.
- **Control at any scale.** Start, stop, restart, reload, enable, disable, mask and unmask — on one row, on a selection across machines, or by description ("every failed `docker.service` on `10.0.0.*`") behind a check that freezes exactly what it reported.
- **Bulk install.** Install a watched service everywhere it is missing, using each machine's own package manager, then enable and start it. The check names the exact commands and they are what runs.
- **Jobs.** Anything touching more than one machine runs as a cancellable job with a result per machine, kept in a history per jump host.
- **Logs and shells.** A `journalctl -f` tail per machine and unit, and an SSH shell from any machine's drawer.
- **It says what it cannot do.** Missing `ssh` or `sshpass` on the connected machine, a machine without systemd, an account that cannot use sudo, a range too large to sweep — each is reported where it matters instead of showing an empty table.
