# eventwiz-uptime

An outside check of https://www.eventwiz.ai, run by GitHub Actions so that it does not depend on the owner's own
computer being on. It checks the site every 2 minutes and sends one Telegram message when the site stops answering
correctly and one when it recovers. Nothing else.

- `check.mjs` — the checker (Node, no dependencies). `node check.mjs --self-test` proves its rules offline.
- `.github/workflows/uptime.yml` — each run checks for 55 minutes, then starts the next run itself. The schedule in it
  only restarts the chain if it ever breaks.
- `state/health.json` — the checker's OWN health (`CHECKER OK` / `CHECKER BROKEN` and why), committed only when it
  changes. A broken checker never turns a run red: every step is continue-on-error, so GitHub does not email "All jobs
  have failed" when only the checker broke. The owner's PC reads this file and says so in its daily digest; only a real
  outage is sent at once, by Telegram. What no step can catch (the checkout itself failing, a runner dying) still fails
  the run, and GitHub's email for that is a per-person setting: GitHub → Settings → Notifications → System → Actions
  ("On GitHub" / "Email" / "Only notify for failed workflows"; deselect "Email" in that dropdown to stop the emails).
- `state/live.json` — the site's last known state, committed only when it changes (so this file's history is the
  outage history). `state/test.json` and `test-targets.json` are for labelled test runs; `[]` means no test is running.

The addresses checked and the Telegram credentials are repository secrets; they are not in this repository.
Maintained from the EventWiz repository (`scripts/uptime-monitor/`); edits made here directly are overwritten.
