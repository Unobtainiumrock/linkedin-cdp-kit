# Unattended scheduling (templates only)

These unit files are **not installed** by the kit. Copy and parameterize them for your host.

## Requirements

- The machine must be awake at timer fire time.
- Use a **headed** Chrome profile with `--remote-debugging-port` and a manual login.
- After sleep or suspend, the next run re-evaluates gates (cooldown, review hold, attempting rows).

## Timer catch-up

`OnUnitActiveSec` does not stack missed runs while powered off. A long sleep yields one run at wake.

## Parameters to set

- `WORKDIR` — state directory for ledger/runtime JSON
- `CDP_URL` — e.g. `http://127.0.0.1:9222`
- `NODE` — path to Node 22+