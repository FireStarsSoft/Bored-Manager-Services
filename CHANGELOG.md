# Changelog

Module versions are independent of the app's. Needs Bored Manager **0.3.2** for the `pie` block.

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
