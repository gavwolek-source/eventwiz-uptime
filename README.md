# eventwiz-uptime

An outside check of https://www.eventwiz.ai, run by GitHub Actions so that it does not depend on the owner's own
computer being on. It checks the site every 2 minutes and sends one Telegram message when the site stops answering
correctly and one when it recovers. Nothing else.

- `check.mjs` — the checker (Node, no dependencies). `node check.mjs --self-test` proves its rules offline.
- `.github/workflows/uptime.yml` — each run checks for 55 minutes, then starts the next run itself. The schedule in it
  only restarts the chain if it ever breaks.
- `state/live.json` — the site's last known state, committed only when it changes (so this file's history is the
  outage history). `state/test.json` and `test-targets.json` are for labelled test runs; `[]` means no test is running.

The addresses checked and the Telegram credentials are repository secrets; they are not in this repository.
Maintained from the EventWiz repository (`scripts/uptime-monitor/`); edits made here directly are overwritten.
