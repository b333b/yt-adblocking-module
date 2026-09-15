#!/usr/bin/env node
// Builds the relay-free fork from an upstream checkout.
// Usage: node tools/build.mjs --upstream /tmp/upstream [--owner you --repo name] [--force]
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, normalize, sep } from "node:path";
import { execFileSync } from "node:child_process";

const args = parseArgs(process.argv.slice(2));
const ROOT = resolve(args.root ?? ".");
const UP = resolve(need(args.upstream, "--upstream <dir>"));
const cfg = JSON.parse(readFileSync(join(ROOT, "fork.config.json"), "utf8"));
const template = readFileSync(join(ROOT, "tools/guard-template.js"), "utf8");

const [envOwner, envRepo] = (process.env.GITHUB_REPOSITORY ?? "/").split("/");
const owner = args.owner ?? envOwner;
const repo = args.repo ?? envRepo;
if (!owner || !repo) fail("Set --owner/--repo or run inside GitHub Actions (GITHUB_REPOSITORY).");
const branch = cfg.fork.branch;

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const git = (...a) => { try { return execFileSync("git", ["-C", UP, ...a], { encoding: "utf8" }).trim(); } catch { return null; } };
const upstreamSha = args.sha ?? git("rev-parse", "HEAD") ?? "unknown";
const upstreamDate = git("log", "-1", "--format=%cI") ?? "unknown";

// ---- 1. read module and collect referenced upstream files ----
const moduleSrc = readFileSync(join(UP, cfg.module.source), "utf8");
const escaped = cfg.upstream.rawPrefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
// prefix + <ref>/<path>, also tolerates refs/heads/<ref>/<path>
const refRe = new RegExp(`(?:${escaped.join("|")})(?:refs\\/heads\\/)?[^\\/\\s"',]+\\/([^\\s"',?#]+)`, "g");

const referenced = new Map(); // fullUrl -> relPath
for (const m of moduleSrc.matchAll(refRe)) referenced.set(m[0], safeRel(m[1]));
if (referenced.size === 0) fail(`No upstream script references found in ${cfg.module.source}.`);

const relPaths = [...new Set(referenced.values())];
const inputs = relPaths.map((p) => {
  const abs = join(UP, p);
  if (!existsSync(abs)) fail(`Module references ${p}, but it is missing upstream.`);
  return { path: p, buf: readFileSync(abs) };
});

// ---- 2. skip if nothing relevant changed ----
const fingerprint = sha256(
  [template, JSON.stringify(cfg), `${owner}/${repo}`, moduleSrc, ...inputs.map((i) => i.path + "\0" + sha256(i.buf))].join("\n")
);
const lockPath = join(ROOT, "UPSTREAM.lock.json");
const oldLock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : null;
if (oldLock?.fingerprint === fingerprint && !args.force) {
  console.log(JSON.stringify({ changed: false, reason: "no relevant upstream change" }));
  process.exit(0);
}

// ---- 3. build wrapped scripts ----
const allowText = cfg.allowedHosts.join(", ");
const files = {};
for (const { path, buf } of inputs) {
  let out = buf;
  if (path.endsWith(".js")) {
    const code = buf.toString("utf8");
    const filled = template
      .replaceAll("__GUARD_VERSION__", cfg.guardVersion)
      .replaceAll("__UPSTREAM_REPO__", cfg.upstream.repo)
      .replaceAll("__UPSTREAM_SHA__", upstreamSha)
      .replaceAll("__UPSTREAM_PATH__", path)
      .replaceAll("__ALLOW_LIST__", allowText)
      .replace("__ALLOW_JSON__", () => JSON.stringify(cfg.allowedHosts))
      .replace("__ONESIE_JSON__", () => JSON.stringify(cfg.onesieCache ?? null));
    // function replacer: upstream code is full of `$` sequences that must stay literal
    out = Buffer.from(filled.replace("__UPSTREAM_CODE__", () => code.replace(/\s*$/, "\n")), "utf8");
  }
  const dest = join(ROOT, path);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, out);
  files[path] = { upstreamSha256: sha256(buf), builtSha256: sha256(out) };
}

// remove files this build created previously but upstream no longer references
for (const p of Object.keys(oldLock?.files ?? {})) {
  if (!files[p] && existsSync(join(ROOT, p))) unlinkSync(join(ROOT, p));
}

// ---- 4. rewrite module ----
let mod = moduleSrc;
for (const [url, p] of referenced) {
  const v = files[p].builtSha256.slice(0, 8);
  mod = mod.split(url).join(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${p}?v=${v}`);
}
mod = mod.replace(/^#!name=(.*)$/m, (_, n) => `#!name=${n.trim()}${cfg.module.nameSuffix}`);
const lines = mod.split(/\r?\n/);
let insertAt = 0;
while (insertAt < lines.length && lines[insertAt].startsWith("#!")) insertAt++;
lines.splice(
  insertAt, 0,
  "",
  "# Auto-built relay-free fork of Maasea/sgmodule. Do not edit by hand.",
  `# Upstream commit: ${upstreamSha} (${upstreamDate})`,
  `# Scripts run inside relay-guard ${cfg.guardVersion}; network egress limited to: ${allowText}`
);
writeFileSync(join(ROOT, cfg.module.output), lines.join("\n"));

// ---- 5. license + lock ----
const lic = ["LICENSE", "LICENSE.md", "LICENSE.txt"].map((f) => join(UP, f)).find(existsSync);
if (!lic) fail("Upstream LICENSE not found; refusing to redistribute.");
writeFileSync(join(ROOT, "LICENSE"), readFileSync(lic));

const lock = {
  fingerprint,
  guardVersion: cfg.guardVersion,
  fork: { owner, repo, branch },
  upstream: { repo: cfg.upstream.repo, commit: upstreamSha, commitDate: upstreamDate },
  module: { source: cfg.module.source, output: cfg.module.output, upstreamSha256: sha256(moduleSrc) },
  license: { upstreamSha256: sha256(readFileSync(lic)) },
  files,
};
writeFileSync(lockPath, JSON.stringify(lock, null, 2) + "\n");
console.log(JSON.stringify({ changed: true, upstreamSha, files: Object.keys(files) }));

// ---- helpers ----
function parseArgs(a) {
  const o = {};
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith("--")) continue;
    const k = a[i].slice(2);
    o[k] = a[i + 1] && !a[i + 1].startsWith("--") ? a[++i] : true;
  }
  return o;
}
function need(v, what) { if (!v || v === true) fail(`Missing ${what}`); return v; }
function safeRel(p) {
  const n = normalize(decodeURIComponent(p));
  if (n.startsWith("..") || n.startsWith(sep) || n.includes(`${sep}..${sep}`)) fail(`Unsafe path in module: ${p}`);
  return n.split(sep).join("/");
}
function fail(msg) { console.error(`build: ${msg}`); process.exit(3); }
