# eventwiz-uptime

An outside check of https://www.eventwiz.ai, run by GitHub Actions every 5 minutes so that it does not depend on
the owner's own computer being on. It sends one Telegram message when the site stops answering correctly and one
when it recovers. Nothing else.

- `check.mjs` — the checker (Node, no dependencies). `node check.mjs --self-test` proves its rules offline.
- `.github/workflows/uptime.yml` — the schedule.
- `state/live.json` — the site's last known state, committed only when it changes (so this file's history is the
  outage history). `state/test.json` is the same for labelled test runs.

The addresses checked and the Telegram credentials are repository secrets; they are not in this repository.
Maintained from the EventWiz repository (`scripts/uptime-monitor/`); edits made here directly are overwritten.
