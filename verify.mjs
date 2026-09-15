#!/usr/bin/env node
// Verifies a build. Exit 0 = safe to publish, 1 = needs human review.
// Usage: node tools/verify.mjs --upstream /tmp/upstream [--report report.md]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1] ?? true]] : []))
);
const ROOT = resolve(args.root ?? ".");
const UP = resolve(args.upstream);
const cfg = JSON.parse(readFileSync(join(ROOT, "fork.config.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(ROOT, "UPSTREAM.lock.json"), "utf8"));

const results = []; // {level: PASS|WARN|FAIL|INFO, msg}
const add = (level, msg) => results.push({ level, msg });

// ---------- helpers ----------
function hostOf(u) {
  try { return new URL(String(u)).hostname.toLowerCase().replace(/\.$/, ""); } catch { return null; }
}
const inList = (h, list) => !!h && list.some((d) => h === d || h.endsWith("." + d));
const isAllowed = (h) => inList(h, cfg.allowedHosts);
const urlsIn = (text) => [...text.matchAll(/https?:\/\/[^\s"'`,)\\<>]+/g)].map((m) => m[0]);

// ---------- A. module static checks ----------
const moduleText = readFileSync(join(ROOT, lock.module.output), "utf8");
const ownRaw = `https://raw.githubusercontent.com/${lock.fork.owner}/${lock.fork.repo}/`;
let moduleOk = true;
for (const u of urlsIn(moduleText)) {
  if (u.startsWith(ownRaw)) continue;
  const h = hostOf(u);
  if (isAllowed(h)) continue;
  moduleOk = false;
  add("FAIL", `Module references a non-allowlisted URL: \`${u}\``);
}
for (const m of moduleText.matchAll(/script-path\s*=\s*([^,\s]+)/g)) {
  if (!m[1].startsWith(ownRaw)) { moduleOk = false; add("FAIL", `script-path not served from this fork: \`${m[1]}\``); }
}
if (moduleOk) add("PASS", "Module only references this fork and allowlisted hosts.");

// ---------- B. license ----------
const lic = readFileSync(join(ROOT, "LICENSE"), "utf8");
if (!/Apache License/i.test(lic)) add("FAIL", "Upstream LICENSE is no longer Apache-2.0 — review before redistributing.");
else add("PASS", "Upstream license is still Apache-2.0.");

// ---------- C. script static checks ----------
const SUSPICIOUS = [
  [/\beval\s*\(/, "eval()"],
  [/\bnew\s+Function\s*\(/, "new Function()"],
  [/(?<![\w$.])Function\s*\(\s*["'`]/, "Function('...') constructor"],
  [/globalThis\s*(?:\.\s*|\[\s*["'`])\s*(\$done|\$httpClient|\$task|fetch)\b/, "global lookup of a guarded API"],
  [/\[\s*["'`](\$done|\$httpClient|\$task)["'`]\s*\]/, "bracket lookup of a guarded API"],
  [/\b(XMLHttpRequest|WebSocket|EventSource|sendBeacon|importScripts)\b/, "browser networking API"],
];

const scripts = Object.keys(lock.files).filter((p) => p.endsWith(".js"));
for (const p of scripts) {
  const up = readFileSync(join(UP, p), "utf8");
  const built = readFileSync(join(ROOT, p), "utf8");

  if (!built.includes(up.replace(/\s*$/, ""))) add("FAIL", `${p}: built file does not contain the upstream code verbatim.`);
  if (!built.includes(`relay-guard ${cfg.guardVersion}`)) add("FAIL", `${p}: guard header missing.`);
  try { new vm.Script(built, { filename: p }); add("PASS", `${p}: compiles.`); }
  catch (e) { add("FAIL", `${p}: syntax error after wrapping: ${e.message}`); }

  const hosts = new Map();
  for (const u of urlsIn(up)) { const h = hostOf(u); if (h) hosts.set(h, u); }
  for (const [h, u] of hosts) {
    if (isAllowed(h)) continue;
    if (inList(h, cfg.knownUpstreamRelays)) add("INFO", `${p}: contains known upstream relay \`${h}\` (neutralized by guard).`);
    else if (inList(h, cfg.benignStringHosts)) add("INFO", `${p}: mentions \`${u}\` (string only, not allowlisted for requests).`);
    else add("FAIL", `${p}: NEW non-allowlisted host in upstream code: \`${u}\``);
  }
  for (const [re, label] of SUSPICIOUS) {
    const m = up.match(re);
    if (m) add("FAIL", `${p}: suspicious construct (${label}): \`${up.slice(Math.max(0, m.index - 40), m.index + 60)}\``);
  }
}

// ---------- D. behavioural sandbox ----------
const moduleLines = moduleText.split(/\r?\n/);
const phaseOf = (p) => {
  const line = moduleLines.find((l) => l.includes(`${ownRaw}${lock.fork.branch}/${p}`));
  return /type\s*=\s*http-request/.test(line ?? "") ? "request" : "response";
};

function runScript(code, sc, store) {
  return new Promise((done) => {
    const calls = { done: [], http: [] };
    const events = [];
    let finished = false, timer = null;
    const finish = (why) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      setTimeout(() => done({ calls, events, why }), 20); // let stray async egress surface
    };
    const ctx = vm.createContext({
      console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
      setTimeout, clearTimeout,
      __RELAY_GUARD_EVENTS__: events,
      __store: store,
      __rec: calls,
      __finish: finish,
    });
    vm.runInContext(`
      var $argument = undefined;
      var $notification = { post: function () {} };
      var $persistentStore = {
        read: function (k) { return __store.has(k) ? __store.get(k) : null; },
        write: function (v, k) { __store.set(k, v); return true; }
      };
      var $httpClient = {};
      ["get","post","put","delete","head"].forEach(function (m) {
        $httpClient[m] = function (o, cb) { __rec.http.push(typeof o === "string" ? o : o.url); if (cb) cb("offline", null, null); };
      });
      var fetch = function (i) { __rec.http.push(typeof i === "string" ? i : (i && (i.url || i.href))); return Promise.reject(new Error("offline")); };
      var XMLHttpRequest = function () { __rec.http.push("xhr://unknown"); };
      var WebSocket = function (u) { __rec.http.push(String(u)); };
      var $done = function (o) { __rec.done.push(o === undefined ? null : o); __finish("done"); };
      var $request = { url: ${JSON.stringify(sc.url)}, method: "POST",
        headers: ${JSON.stringify(sc.headers)}, body: new Uint8Array(${JSON.stringify(sc.body ?? [])}) };
      ${sc.response ? `var $response = { status: 200, headers: {}, body: new Uint8Array(0) };` : ""}
    `, ctx);
    timer = setTimeout(() => finish("timeout"), 3000);
    try { vm.runInContext(code, ctx, { timeout: 5000 }); }
    catch (e) { calls.error = String(e); }
  });
}

function foreignEgress(res) {
  const bad = [];
  for (const d of res.calls.done) {
    if (!d || typeof d !== "object") continue;
    if (d.url != null && !isAllowed(hostOf(d.url))) bad.push(`$done url -> ${d.url}`);
    for (const hs of [d.headers, d.response?.headers]) {
      for (const [k, v] of Object.entries(hs ?? {})) {
        if (/^location$/i.test(k) && /^[a-z]+:|^\/\//i.test(String(v)) && !isAllowed(hostOf(String(v).replace(/^\/\//, "https://")))) bad.push(`Location -> ${v}`);
      }
    }
  }
  for (const u of res.calls.http) if (!isAllowed(hostOf(u))) bad.push(`network API -> ${u}`);
  return bad;
}
const isEmptyResponse = (res) => {
  const d = res.calls.done.at(-1);
  return d?.response?.status === 200 && d.response.body?.length === 0;
};

// Minimal Onesie body: OnesieRequest{3: EncryptedInnertubeRequest{5: encryptedClientKey}}
const KEY = [1, 2, 3, 4];
const onesieBody = [0x1a, 2 + KEY.length, 0x2a, KEY.length, ...KEY];
const oc = cfg.onesieCache;
const seededStore = () => new Map([[oc.storeKey, JSON.stringify({ [oc.videoKey]: {
  clientKey: "dGVzdC1jbGllbnQta2V5", encryptKey: Buffer.from(KEY).toString("base64"),
} })]]);
const UA = { "User-Agent": "com.google.ios.youtube/20.0 (iPhone; iOS 26)" };
const INIT = "https://rr1---sn-test.googlevideo.com/initplayback?source=youtube&oad=0&ack=1&id=x";

for (const p of scripts) {
  const built = readFileSync(join(ROOT, p), "utf8");
  const up = readFileSync(join(UP, p), "utf8");

  if (phaseOf(p) === "request") {
    // canary: does upstream (unguarded) still try to relay?
    const canary = await runScript(up, { url: INIT, headers: UA, body: onesieBody }, seededStore());
    const upstreamRelays = foreignEgress(canary);
    if (upstreamRelays.length) add("INFO", `${p}: upstream still relays when a key is cached (${upstreamRelays[0].split("?")[0]}).`);
    else add("WARN", `${p}: upstream no longer relays in the Onesie scenario — mechanism may have changed; worth a look.`);

    const store = seededStore();
    const r1 = await runScript(built, { url: INIT, headers: UA, body: onesieBody }, store);
    const leak1 = foreignEgress(r1);
    if (leak1.length) add("FAIL", `${p}: guard LEAKED: ${leak1.join("; ")}`);
    else add("PASS", `${p}: no egress outside allowlist (Onesie, key cached).`);
    const unexpected = r1.events.filter((e) => !(e.type === "$done.url" && inList(e.host, cfg.knownUpstreamRelays)));
    if (unexpected.length) add("FAIL", `${p}: blocked a NEW egress attempt: ${unexpected.map((e) => e.type + " -> " + e.host).join("; ")}`);
    if (upstreamRelays.length) {
      if (r1.events.length && isEmptyResponse(r1)) add("PASS", `${p}: relay attempt blocked and replaced with upstream's own local fallback.`);
      else add("FAIL", `${p}: relay attempt was not converted to the local fallback (events=${r1.events.length}).`);
      const cleared = !JSON.parse(store.get(oc.storeKey) ?? "{}")[oc.videoKey];
      const r2 = await runScript(built, { url: INIT, headers: UA, body: onesieBody }, store);
      if (cleared && r2.events.length === 0 && isEmptyResponse(r2)) add("PASS", `${p}: cached key cleared; next start uses the local path without hitting the guard.`);
      else add("WARN", `${p}: cache-clear constants look stale (onesieCache in fork.config.json). Blocking still works, but every start goes through the guard.`);
    }

    for (const sc of [
      { name: "Onesie, no key", url: INIT, headers: UA, body: onesieBody, store: new Map() },
      { name: "log_event", url: "https://youtubei.googleapis.com/youtubei/v1/log_event?alt=proto", headers: { ...UA, "Content-Encoding": "gzip", "x-youtube-hot-hash-data": "x" }, store: seededStore() },
    ]) {
      const r = await runScript(built, sc, sc.store);
      const leak = foreignEgress(r);
      if (leak.length || r.events.length) add("FAIL", `${p} [${sc.name}]: unexpected egress attempt: ${[...leak, ...r.events.map((e) => e.type + "->" + e.host)].join("; ")}`);
      else add("PASS", `${p} [${sc.name}]: no egress outside allowlist.`);
    }
  } else {
    for (const ep of ["browse", "next", "player", "get_watch", "config", "search", "guide"]) {
      const r = await runScript(built, { url: `https://youtubei.googleapis.com/youtubei/v1/${ep}?prettyPrint=false`, headers: UA, response: true }, seededStore());
      const leak = foreignEgress(r);
      if (leak.length) add("FAIL", `${p} [${ep}]: guard LEAKED: ${leak.join("; ")}`);
      else if (r.events.length) add("FAIL", `${p} [${ep}]: response script tried to reach \`${r.events[0].host}\` (blocked) — new behaviour, review.`);
      else if (r.calls.error || r.why === "timeout") add("INFO", `${p} [${ep}]: no egress (mock body is empty, so ${r.calls.error ? "it threw" : "it didn't finish"} — expected).`);
      else add("PASS", `${p} [${ep}]: no egress outside allowlist.`);
    }
  }
}

// ---------- report ----------
const order = { FAIL: 0, WARN: 1, INFO: 2, PASS: 3 };
results.sort((a, b) => order[a.level] - order[b.level]);
const fails = results.filter((r) => r.level === "FAIL").length;
const icon = { FAIL: "❌", WARN: "⚠️", INFO: "ℹ️", PASS: "✅" };
const report = [
  `## Relay-free sync ${fails ? "needs review" : "passed"}`,
  "",
  `Upstream: ${lock.upstream.repo} @ \`${lock.upstream.commit}\` (${lock.upstream.commitDate})`,
  `Guard: relay-guard ${lock.guardVersion}`,
  "",
  ...results.map((r) => `- ${icon[r.level]} ${r.msg}`),
].join("\n");
if (args.report && args.report !== true) writeFileSync(args.report, report + "\n");
console.log(report);
process.exit(fails ? 1 : 0);
