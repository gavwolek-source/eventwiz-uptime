#!/usr/bin/env node
// check.mjs -- the outside check of www.eventwiz.ai (launch-restore-alert-1, 2026-09-27).
//
// Runs on GitHub's machines, NOT on Gavin's PC, so a PC that is off is never mistaken for a site that is down.
// Live copy: github.com/gavwolek-source/eventwiz-uptime (a public repo, so its Actions minutes are free).
// Source of truth: eventwiz scripts/uptime-monitor/ -- publish.sh copies it across; UPTIME#1 checks they match.
//
// What it does, each run:
//   With LOOP_MINUTES > 0 (the chain, how it runs live): rounds ROUND_GAP seconds apart for LOOP_MINUTES, then it
//   leaves a `.chain-ok` file and the workflow starts the next run. A chain does not wait on GitHub's schedule, which
//   MEASURED 2026-09-27 started NO scheduled run in the first 80+ minutes of a new repo (users report hours to days).
//   The schedule remains only as a restarter if the chain breaks. With LOOP_MINUTES 0: ROUNDS rounds, then stop.
//   Each round: ROUND_GAP seconds apart. In each round every target is fetched at once. A target that fails is
//   fetched again RETRIES times, RETRY_GAP seconds apart, and only a failure that repeats EVERY time counts.
//   (MEASURED 2026-09-27 on GitHub's runners: single connection resets in 0.1 s happen -- one on the live event data,
//   two in a row from a third-party test host -- so one recheck was not enough; two blips never page.)
//   Site state: DOWN if any target's failure repeated, UP if every target passed, and UNKNOWN when this machine
//   could not reach the control address either -- a runner with no network is not an outage, and UNKNOWN never
//   changes the state or sends a message.
//   Telegram: ONE message when the state goes UP -> DOWN, ONE when it goes DOWN -> UP. Nothing on a good run.
//   A message that fails to send leaves the state as it was, so the next run sends it again; the run goes red.
//
// A target passes when it answers the expected HTTP status, within TIMEOUT seconds, AND its body contains the
// expected text. A slow page that answers correctly inside TIMEOUT passes -- slowness alone never pages.
//
// Monitors (env):
//   TARGETS_JSON  the live targets (a secret: it names the event page)    -> state/live.json, no label
//   TEST_TARGETS  labelled test targets (a repo variable, normally unset)  -> state/test.json, every message "TEST"
//   Target: {"name": "rsvp api", "url": "...", "status": 404, "contains": "Invalid RSVP link", "headers": {...}}
//   Test targets can also come from `test-targets.json` in the repo, re-read (after a git pull) EVERY round, so a
//   pushed change reaches a run that is already going -- that is how the alarm is proved end to end.
// Other env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, LOOP_MINUTES (0), ROUNDS (2), ROUND_GAP (150), RETRIES (2), RETRY_GAP (15), TIMEOUT (30),
//   CONTROL_URL (https://api.github.com/zen), COMMIT_STATE=1 to commit+push a changed state file at once.
// URLs are never printed: logs name targets only (the live list is a secret; GitHub also masks secrets).
//
// 🔴 A BROKEN CHECKER NEVER GOES RED (vercel-builds-uptime-1, 2026-09-27). MEASURED: run 36293593043 (04:11Z) failed in
// 6 s on this checker's own bug ("no targets configured"), and GitHub emailed Gavin "All jobs have failed" while the site
// was up. A red run is GitHub's email to the person who started it; only a site outage may reach his phone, and that is
// this file's own Telegram. So every step of the workflow is continue-on-error, a failure writes its reason to
// `.checker-broken`, and the last step (`--health`, always runs) records {ok, kind, why} in state/health.json --
// committed only when ok/kind CHANGES, like state/live.json. The PC reads it: UPTIME#1 goes OPEN, and
// `reality-check-uptime.mjs --notify` (pipeline-uptime-watch.timer, hourly) puts ONE line in Gavin's digest when the
// checker breaks and one when it is fixed. What the workflow cannot catch (the checkout step itself, a runner that
// dies) still fails the run; GitHub's email for that is a per-person setting (see README).
//
//   node check.mjs              one run
//   node check.mjs --health     (workflow's last step) record the checker's own health from the step outcomes; exit 0
//   node check.mjs --self-test  hermetic proof of the rules above (no network, no Telegram); exit 1 on any red arm
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const CFG = {
  loopMinutes: num(process.env.LOOP_MINUTES, 0),
  rounds: num(process.env.ROUNDS, 2),
  roundGap: num(process.env.ROUND_GAP, 150),
  retryGap: num(process.env.RETRY_GAP, 15),
  retries: num(process.env.RETRIES, 2),
  timeout: num(process.env.TIMEOUT, 30),
  control: process.env.CONTROL_URL || 'https://api.github.com/zen',
};

export function sydney(ms) {
  try {
    return new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit',
      day: 'numeric', month: 'short', hour12: false }).format(new Date(ms));
  } catch { return new Date(ms).toISOString().slice(0, 16) + ' UTC'; }
}

// one HTTP probe -> {ok, why, ms}
export async function probe(t, timeoutS) {
  const t0 = Date.now();
  try {
    const r = await fetch(t.url, { headers: { 'user-agent': 'eventwiz-uptime/1', ...(t.headers || {}) },
      redirect: 'follow', signal: AbortSignal.timeout(timeoutS * 1000), cache: 'no-store' });
    const body = await r.text();
    const ms = Date.now() - t0;
    if (r.status !== (t.status ?? 200)) return { ok: false, why: `HTTP ${r.status}`, ms };
    if (t.contains && !body.includes(t.contains)) return { ok: false, why: `HTTP ${r.status} but the page was not the right one`, ms };
    return { ok: true, why: `HTTP ${r.status}`, ms };
  } catch (e) {
    const ms = Date.now() - t0;
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    return { ok: false, why: timedOut ? `no answer in ${timeoutS} s` : `could not connect (${e?.cause?.code || e?.name || 'error'})`, ms };
  }
}

// one round for one monitor: every target at once, a failure re-checked after retryGap; -> {state, failing, lines}
export async function round(targets, io, cfg) {
  const control = await io.probe({ url: cfg.control, status: 200 }, cfg.timeout);
  const first = await Promise.all(targets.map((t) => io.probe(t, cfg.timeout)));
  const failed = targets.map((t, i) => (first[i].ok ? null : i)).filter((i) => i !== null);
  const again = {}; // i -> [recheck results]; a target stops being rechecked the moment one passes
  let still = failed;
  for (let k = 0; k < (cfg.retries ?? 1) && still.length; k++) {
    await io.sleep(cfg.retryGap);
    await Promise.all(still.map(async (i) => { (again[i] ||= []).push(await io.probe(targets[i], cfg.timeout)); }));
    still = still.filter((i) => !again[i].at(-1).ok);
  }
  const failing = still.map((i) => ({ name: targets[i].name, why: (again[i]?.at(-1) ?? first[i]).why }));
  const lines = targets.map((t, i) => `${t.name}: ${first[i].why} ${(first[i].ms / 1000).toFixed(1)}s`
    + (again[i] || []).map((x) => ` -> recheck ${x.why} ${(x.ms / 1000).toFixed(1)}s`).join(''));
  lines.push(`control: ${control.ok ? 'reachable' : control.why}`);
  if (!failing.length) return { state: 'UP', failing, lines };
  // this machine cannot reach the outside world either: we cannot see the site, which is not the same as it being down
  if (!control.ok) return { state: 'UNKNOWN', failing, lines };
  return { state: 'DOWN', failing, lines };
}

export function message(label, prev, next, failing, nowMs, nTargets) {
  const pre = label ? `${label} (a test of the outside check, not the real site) — ` : '';
  if (next === 'DOWN') {
    return `${pre}EventWiz site DOWN, seen from outside this PC.\n`
      + failing.map((f) => `• ${f.name}: ${f.why}`).join('\n')
      + `\nFirst seen failing ${sydney(nowMs)} Sydney. One more message when it is back.`;
  }
  const mins = prev.since ? Math.max(1, Math.round((nowMs - prev.since) / 60000)) : null;
  return `${pre}EventWiz site back UP — all ${nTargets} checks pass (${sydney(nowMs)} Sydney).`
    + (mins ? ` It was down about ${mins} min, from ${sydney(prev.since)}.` : '');
}

export async function sendTelegram(text, env = process.env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return { ok: false, why: 'Telegram is not configured' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    return j.ok ? { ok: true, id: j.result?.message_id } : { ok: false, why: `Telegram said ${r.status} ${j.description || ''}` };
  } catch (e) { return { ok: false, why: `Telegram unreachable (${e?.name})` }; }
}

// the whole run; io = {probe, sleep, send, now, readState, writeState, log, chainOk}. `monitors` is a list, or a
// function returning the list, called afresh every round. Returns an exit code.
export async function runAll(monitors, io, cfg = CFG) {
  let rc = 0;
  const list = typeof monitors === 'function' ? monitors : () => monitors;
  const t0 = io.now();
  const another = (r) => (cfg.loopMinutes > 0
    ? io.now() - t0 + cfg.roundGap * 1000 < cfg.loopMinutes * 60000
    : r < cfg.rounds);
  for (let r = 1; ; r++) {
    if (r > 1) await io.sleep(cfg.roundGap);
    for (const m of list()) {
      const res = await round(m.targets, io, cfg);
      const tag = m.label ? `[${m.label}] ` : '';
      io.log(`round ${r} ${tag}${res.state} | ${res.lines.join(' | ')}`);
      if (res.state === 'UNKNOWN') continue;
      const prev = io.readState(m.stateFile) || { status: 'UP' };
      if (prev.status === res.state) continue;
      const now = io.now();
      const text = message(m.label, prev, res.state, res.failing, now, m.targets.length);
      const sent = await io.send(text);
      if (!sent.ok) {
        io.log(`${tag}state is ${res.state} but the message did not send: ${sent.why} -- state NOT advanced, next run retries`);
        io.broken?.(`a ${res.state} message did not send (${sent.why})`);
        rc = 1;
        continue;
      }
      io.log(`${tag}SENT ${prev.status} -> ${res.state} (telegram message ${sent.id ?? '?'})`);
      io.writeState(m.stateFile, { status: res.state, since: now, failing: res.failing, changed_utc: new Date(now).toISOString(), telegram_message_id: sent.id ?? null });
    }
    if (!another(r)) break;
  }
  // only a run that did its whole loop hands on to a next one: a run that dies early never starts a rapid-fire chain
  if (cfg.loopMinutes > 0) io.chainOk();
  return rc;
}

function realIo() {
  return {
    probe, now: () => Date.now(), log: (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`),
    sleep: (s) => new Promise((res) => setTimeout(res, s * 1000)),
    send: (text) => sendTelegram(text),
    chainOk: () => writeFileSync('.chain-ok', new Date().toISOString() + '\n'),
    broken: noteBroken,
    readState: (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } },
    writeState: (f, v) => {
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, JSON.stringify(v, null, 1) + '\n');
      if (process.env.COMMIT_STATE !== '1') return;
      const git = (...a) => execFileSync('git', a, { stdio: 'pipe' });
      try {
        git('add', '--', f);
        git('-c', 'user.name=eventwiz-uptime', '-c', 'user.email=eventwiz-uptime@users.noreply.github.com', 'commit', '-q', '-m', `state: ${f} -> ${v.status}`);
        git('pull', '-q', '--rebase');
        git('push', '-q');
      } catch (e) { console.log(`state commit failed (the message was sent; the next run may send it again): ${String(e.message).slice(0, 200)}`); }
    },
  };
}

// the reason this run's checker is broken, for the --health step (the first reason wins; the file is never committed)
function noteBroken(why) {
  try { if (!existsSync('.checker-broken')) writeFileSync('.checker-broken', String(why).slice(0, 300) + '\n'); } catch { /* the health step says "failed" without a reason */ }
}

// The checker's own health from the workflow's step outcomes (GitHub's steps.<id>.outcome: the result BEFORE
// continue-on-error). -> {ok, kind, why} | null when the run was cancelled (a cancelled run says nothing either way).
export function healthOf({ selftest, check, chain, note = '', loop = true }) {
  const o = [selftest, check, chain];
  if (o.includes('cancelled')) return null;
  if (selftest !== 'success') return { ok: false, kind: 'selftest', why: "the checker's own self-test is red, so the site was not checked" };
  if (check !== 'success') return { ok: false, kind: 'check', why: note ? `the check step failed: ${note}` : 'the check step failed (no reason recorded)' };
  if (chain === 'failure') return { ok: false, kind: 'chain', why: 'the run could not start the next one, so the chain has stopped' };
  if (loop && chain === 'skipped') return { ok: false, kind: 'chain', why: 'the run did not finish its loop, so no next run was started' };
  return { ok: true, kind: 'ok', why: '' };
}

// Write state/health.json only when ok/kind changes; -> 'changed' | 'same' | 'cancelled'
export function recordHealth(h, io, meta = {}) {
  if (!h) return 'cancelled';
  const prev = io.readState('state/health.json');
  if (prev && prev.ok === h.ok && prev.kind === h.kind) return 'same';
  io.writeState('state/health.json', { ...h, status: h.ok ? 'CHECKER OK' : 'CHECKER BROKEN', changed_utc: new Date(io.now()).toISOString(), ...meta });
  return 'changed';
}

export function monitorsFromEnv(env = process.env) {
  const parse = (name, v) => { const t = JSON.parse(v); if (!Array.isArray(t) || !t.length) throw new Error(`${name} is not a non-empty list`); return t; };
  const live = env.TARGETS_JSON ? { label: '', targets: parse('TARGETS_JSON', env.TARGETS_JSON), stateFile: 'state/live.json' } : null;
  return () => {
    const ms = live ? [live] : [];
    let test = env.TEST_TARGETS && env.TEST_TARGETS.trim() ? env.TEST_TARGETS : null;
    if (!test) {
      if (env.COMMIT_STATE === '1') { try { execFileSync('git', ['pull', '-q', '--rebase'], { stdio: 'pipe' }); } catch { /* next round tries again */ } }
      try { const f = readFileSync('test-targets.json', 'utf8').trim(); if (f && f !== '[]') test = f; } catch { /* no file: no test monitor */ }
    }
    if (test) {
      try { ms.push({ label: 'TEST', targets: parse('TEST targets', test), stateFile: 'state/test.json' }); }
      catch (e) { console.log(`TEST targets unreadable, skipped: ${e.message}`); }
    }
    return ms;
  };
}

// ── self-test: every rule in the header, against a fake network, clock and Telegram ─────────────────────────
async function selfTest() {
  const cfg = { rounds: 1, roundGap: 0, retryGap: 0, retries: 2, timeout: 45, control: 'CONTROL' };
  let red = 0;
  const arm = (name, ok) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) red++; };
  // scripted network: answers[url] is a list consumed per call (last one repeats)
  const fakeIo = (answers, { sendOk = true, state = null } = {}) => {
    const calls = {}, sent = [], store = { f: state, chained: 0 };
    let t = Date.parse('2026-09-27T03:00:00Z');
    return {
      sent, store, calls, chainOk: () => { store.chained++; },
      probe: async (t) => { const a = answers[t.url] || [{ ok: true, why: 'HTTP 200', ms: 100 }]; const i = calls[t.url] = (calls[t.url] ?? -1) + 1; return a[Math.min(i, a.length - 1)]; },
      sleep: async (sec) => { t += sec * 1000; }, now: () => t, log: () => {},
      send: async (text) => { sent.push(text); return sendOk ? { ok: true, id: 1 } : { ok: false, why: 'fake failure' }; },
      // one slot per state file; 'f' is the one the arms read back as store.f
      readState: (file) => (file === 'f' ? store.f : store[`file:${file}`] ?? null),
      writeState: (file, v) => { if (file === 'f') store.f = v; else store[`file:${file}`] = v; },
    };
  };
  const T = [{ name: 'home', url: 'H' }, { name: 'event page', url: 'E' }, { name: 'rsvp api', url: 'R' }];
  const OK = { ok: true, why: 'HTTP 200', ms: 300 }, BAD = { ok: false, why: 'HTTP 500', ms: 200 };
  const mon = (label = '') => [{ label, targets: T, stateFile: 'f' }];

  let io = fakeIo({});
  await runAll(mon(), io, cfg);
  arm('S1 every target passes from no state: no message, nothing written', io.sent.length === 0 && io.store.f === null);

  io = fakeIo({ E: [BAD, BAD, BAD] });
  await runAll(mon(), io, cfg);
  arm('S2 a failure that repeats on both rechecks: ONE DOWN message naming the part and the reason; state DOWN',
    io.sent.length === 1 && /DOWN/.test(io.sent[0]) && /event page: HTTP 500/.test(io.sent[0]) && io.store.f?.status === 'DOWN');

  io = fakeIo({ E: [BAD, BAD] }, { state: { status: 'DOWN', since: Date.parse('2026-09-27T02:40:00Z') } });
  await runAll(mon(), io, cfg);
  arm('S3 still down on the next run: no second message', io.sent.length === 0 && io.store.f.status === 'DOWN');

  io = fakeIo({}, { state: { status: 'DOWN', since: Date.parse('2026-09-27T02:40:00Z') } });
  await runAll(mon(), io, cfg);
  arm('S4 recovery: ONE UP message with how long it was down; state UP',
    io.sent.length === 1 && /back UP/.test(io.sent[0]) && /about 20 min/.test(io.sent[0]) && io.store.f.status === 'UP');

  io = fakeIo({ R: [BAD, OK] });
  await runAll(mon(), io, cfg);
  arm('S5 a single blip that passes on the recheck: no message', io.sent.length === 0 && io.store.f === null);

  io = fakeIo({ R: [BAD, BAD, OK] });
  await runAll(mon(), io, cfg);
  arm('S5b two blips in a row, then a pass on the second recheck: no message (measured on GitHub 2026-09-27)', io.sent.length === 0 && io.store.f === null);

  io = fakeIo({ H: [{ ok: true, why: 'HTTP 200', ms: 25000 }] });
  await runAll(mon(), io, cfg);
  arm('S6 slow but answering correctly inside the 30 s limit (25 s): no message', io.sent.length === 0);

  io = fakeIo({ H: [BAD], E: [BAD], R: [BAD], CONTROL: [{ ok: false, why: 'could not connect', ms: 1 }] });
  await runAll(mon(), io, cfg);
  arm('S7 this machine cannot reach the control either: UNKNOWN, no message, state untouched', io.sent.length === 0 && io.store.f === null);

  io = fakeIo({ E: [BAD] }, { sendOk: false });
  const rc = await runAll(mon(), io, cfg);
  arm('S8 the message fails to send: state NOT advanced and the run exits 1, so the next run sends it', rc === 1 && io.store.f === null);

  io = fakeIo({ E: [BAD] });
  await runAll(mon('TEST'), io, cfg);
  arm('S9 a TEST monitor labels its message as a test', io.sent.length === 1 && /^TEST \(a test of the outside check/.test(io.sent[0]));

  // S10 drives the REAL probe() against a local server: wrong page, wrong status, timeout, slow-but-inside
  const { createServer } = await import('node:http');
  const srv = createServer((req, res) => {
    if (req.url === '/wrong') { res.writeHead(200); res.end('<html>Vercel error</html>'); }
    else if (req.url === '/500') { res.writeHead(500); res.end('x'); }
    else if (req.url === '/hang') { /* never answers */ }
    else if (req.url === '/slow') { setTimeout(() => { res.writeHead(200); res.end('EventWiz'); }, 1500); }
    else { res.writeHead(200); res.end('EventWiz'); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const p = (path, extra = {}) => probe({ url: base + path, status: 200, contains: 'EventWiz', ...extra }, 1);
  const [good, wrong, s500, hang] = await Promise.all([p('/'), p('/wrong'), p('/500'), p('/hang')]);
  const slow = await probe({ url: base + '/slow', status: 200, contains: 'EventWiz' }, 3);
  srv.closeAllConnections?.(); srv.close();
  arm('S10 real probe: right page passes; wrong page, HTTP 500 and a hang fail with a reason; slow-inside-timeout passes',
    good.ok && !wrong.ok && /not the right one/.test(wrong.why) && !s500.ok && s500.why === 'HTTP 500'
    && !hang.ok && /no answer in 1 s/.test(hang.why) && slow.ok);

  io = fakeIo({});
  await runAll(mon(), io, { ...cfg, loopMinutes: 10, roundGap: 120 });
  arm('S12 the chain: rounds 120 s apart for 10 minutes (5 rounds), then it hands on to the next run',
    io.calls.CONTROL + 1 === 5 && io.store.chained === 1); // calls[] holds the index of the last call

  io = fakeIo({});
  await runAll(mon(), io, cfg);
  arm('S13 a plain run (no loop) never starts a next run -- a run that dies early cannot start a rapid-fire chain', io.store.chained === 0);

  io = fakeIo({ X: [BAD] });
  let n = 0;
  await runAll(() => (n++ === 0 ? mon() : [...mon(), { label: 'TEST', targets: [{ name: 'test', url: 'X' }], stateFile: 't' }]), io,
    { ...cfg, loopMinutes: 5, roundGap: 120 });
  arm('S14 test targets pushed while a run is going are picked up at the next round, and page once',
    io.sent.length === 1 && /^TEST/.test(io.sent[0]));

  // S15 drives the ENTRY POINT's own wiring: MEASURED 2026-09-27, a refactor made the monitor list a function and
  // the entry point read `.length` of the function (always 0) and refused to run -- every arm above still passed.
  const { spawnSync } = await import('node:child_process');
  const entry = spawnSync(process.execPath, [process.argv[1]], { encoding: 'utf8', cwd: (await import('node:os')).tmpdir(),
    env: { PATH: process.env.PATH, TARGETS_JSON: JSON.stringify([{ name: 'unroutable', url: 'http://127.0.0.1:9/', status: 200 }]),
      ROUNDS: '1', RETRIES: '0', TIMEOUT: '2', CONTROL_URL: 'http://127.0.0.1:9/' } });
  arm('S15 the entry point runs the configured targets (one round, no network: UNKNOWN, nothing sent)',
    /round 1 UNKNOWN \| unroutable: could not connect/.test(entry.stdout) && !/no targets configured/.test(entry.stdout));

  arm('S11 no URL is ever printed: log lines carry target names only',
    (await (async () => { const lines = []; const io2 = fakeIo({ E: [BAD] }); io2.log = (s) => lines.push(s);
      await runAll(mon(), io2, cfg); return lines.length > 0 && lines.every((l) => !/https?:\/\//.test(l)); })()));

  // H: the checker's own health (vercel-builds-uptime-1) -- a broken checker is recorded once per change, never red
  const S = 'success', F = 'failure', K = 'skipped';
  arm('H1 every step succeeded -> OK', healthOf({ selftest: S, check: S, chain: S })?.ok === true);
  arm('H2 the 27 Sep 04:11Z failure (check step failed, "no targets") -> BROKEN naming the reason',
    (() => { const h = healthOf({ selftest: S, check: F, chain: K, note: 'no targets configured (TARGETS_JSON / TEST_TARGETS are empty)' });
      return h.ok === false && h.kind === 'check' && /no targets configured/.test(h.why); })());
  arm('H3 self-test red (check skipped) -> BROKEN selftest', healthOf({ selftest: F, check: K, chain: K })?.kind === 'selftest');
  arm('H4 could not start the next run -> BROKEN chain', healthOf({ selftest: S, check: S, chain: F })?.kind === 'chain');
  arm('H5 a manual once=yes run skips the chain on purpose -> OK', healthOf({ selftest: S, check: S, chain: K, loop: false })?.ok === true);
  arm('H6 a cancelled run records nothing', healthOf({ selftest: S, check: 'cancelled', chain: K }) === null);
  const hio = fakeIo({});
  const hs = [healthOf({ selftest: S, check: F, chain: K, note: 'x' }), healthOf({ selftest: S, check: F, chain: K, note: 'y' }),
    healthOf({ selftest: S, check: S, chain: S }), healthOf({ selftest: S, check: S, chain: S })].map((h) => recordHealth(h, hio));
  arm('H7 health is written only on a change: broken, still broken (new wording), fixed, still fixed -> changed, same, changed, same',
    hs.join() === 'changed,same,changed,same' && hio.store['file:state/health.json']?.ok === true);
  const nio = fakeIo({ E: [BAD] }, { sendOk: false }); const notes = []; nio.broken = (w) => notes.push(w);
  await runAll(mon(), nio, cfg);
  arm('H8 a message that fails to send records WHY the checker is broken', notes.length === 1 && /did not send \(fake failure\)/.test(notes[0]));
  const { mkdtempSync } = await import('node:fs');
  const hdir = mkdtempSync(`${(await import('node:os')).tmpdir()}/uptime-health-`);
  const empty = spawnSync(process.execPath, [process.argv[1]], { encoding: 'utf8', cwd: hdir, env: { PATH: process.env.PATH } });
  const hstep = spawnSync(process.execPath, [process.argv[1], '--health'], { encoding: 'utf8', cwd: hdir,
    env: { PATH: process.env.PATH, SELFTEST_OUTCOME: S, CHECK_OUTCOME: empty.status === 0 ? S : F, CHAIN_OUTCOME: K, LOOP_MINUTES: '55' } });
  let written = null; try { written = JSON.parse(readFileSync(`${hdir}/state/health.json`, 'utf8')); } catch { /* none */ }
  arm('H9 ENTRY POINT, end to end: no targets -> the check exits 1 and records why; --health exits 0 and writes BROKEN with that reason',
    empty.status === 1 && hstep.status === 0 && written?.ok === false && /no targets configured/.test(written?.why || ''));

  console.log(red ? `SELF-TEST RED: ${red} arm(s)` : 'SELF-TEST GREEN: 25/25');
  return red ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--self-test')) process.exit(await selfTest());
  if (process.argv.includes('--health')) {
    // never exits non-zero: this step exists so that a broken checker is recorded, not emailed
    try {
      const e = process.env;
      let note = '';
      try { note = readFileSync('.checker-broken', 'utf8').trim(); } catch { /* no reason recorded */ }
      const h = healthOf({ selftest: e.SELFTEST_OUTCOME, check: e.CHECK_OUTCOME, chain: e.CHAIN_OUTCOME, note, loop: e.LOOP_MINUTES !== '0' });
      const said = recordHealth(h, realIo(), { run_url: e.RUN_URL || null });
      console.log(`checker health: ${h ? (h.ok ? 'OK' : `BROKEN (${h.kind}) ${h.why}`) : 'run cancelled, nothing recorded'} -- state/health.json ${said}`);
    } catch (err) { console.log(`checker health could not be recorded: ${String(err?.message || err).slice(0, 200)}`); }
    process.exit(0);
  }
  const monitors = monitorsFromEnv();
  if (!monitors().length) {
    noteBroken('no targets configured (TARGETS_JSON / TEST_TARGETS are empty)');
    console.log('no targets configured (TARGETS_JSON / TEST_TARGETS): nothing checked -- this run proves nothing'); process.exit(1);
  }
  let rc;
  try { rc = await runAll(monitors, realIo()); } catch (err) { noteBroken(`the checker crashed: ${String(err?.message || err).slice(0, 200)}`); throw err; }
  process.exit(rc);
}
