# CLAUDE.md

Context for AI assistants (Claude Code, claude.ai chats) working on this repo.
Chats and Claude Code do not share conversation history: this file is the shared
memory. Update it after any meaningful change. The repo is public, so keep
personal data out of it.

## What this repo is

A relay-free fork of the YouTube (Music) Enhance module from
[Maasea/sgmodule](https://github.com/Maasea/sgmodule), for Shadowrocket.

When a Onesie key is cached, upstream's request script redirects
`initplayback` requests to a third-party relay (`*.maasea.workers.dev`). This
fork runs the upstream scripts byte-for-byte inside a wrapper (relay-guard).
The wrapper blocks all network egress outside Google hosts. It turns a blocked
relay attempt into upstream's own local fallback path, so ad blocking keeps
working with no third party in the loop.

## Layout

| Path | Role |
|---|---|
| `.github/workflows/sync-upstream.yml` | Every 6 h or manually (`force` input): clone upstream, build, verify, publish. `PUBLISH_MODE=direct` pushes to `main`; `pr` opens a PR. On failure it opens an issue with the report and publishes nothing. |
| `tools/build.mjs` | Reads the upstream module and collects referenced scripts via `rawPrefixes`. Wraps each `.js` in the guard and rewrites `script-path`s to this repo's raw URLs with `?v=<hash8>`. Extracts MITM hosts into `RUN_ON`, copies `LICENSE`, and writes `UPSTREAM.lock.json`. Skips the build when the fingerprint is unchanged. The fingerprint covers the template, config, owner/repo, module and script hashes. |
| `tools/guard-template.js` | The wrapper. Placeholders are filled by `build.mjs`. |
| `tools/verify.mjs` | Static and behavioural checks. Exit 0 means safe to publish; exit 1 means it needs review. |
| `fork.config.json` | Allowlists, upstream location, Onesie cache keys, guard version. |
| `UPSTREAM.lock.json` | **Generated.** Upstream commit, hashes, `mitm.runOn`. |
| `YouTubeAds.sgmodule`, `Script/Youtube/*.js`, `LICENSE` | **Generated.** Never edit by hand. |

## Guard behaviour (relay-guard 1.1.0)

**Run-on check.** The guard refuses to run when the request host is outside
`RUN_ON`, the module's own `[MITM]` hostnames. In that case it passes the
request through with `$done({})`. An empty `RUN_ON` also fails closed.

**Egress allowlist.** Egress is limited to `allowedHosts`, matched as a domain
or any subdomain. This list is deliberately broader than the MITM list.

**`$done` checks.** A `$done` call is blocked if it carries a `url`, or a
`Location` header, pointing off the allowlist. The guard then uses a fallback:
- For `initplayback`, it returns an empty 200 and clears the cached Onesie key
  (`onesieCache`). The app then falls back to `/youtubei/v1/player`, which the
  response script handles locally.
- Otherwise it calls `$done({})`.

**Network APIs.**
- `$httpClient`, `$task.fetch` and `fetch` are wrapped with the allowlist.
- `XMLHttpRequest`, `WebSocket`, `EventSource`, `Image` and `importScripts` throw.
- `navigator.sendBeacon` is a no-op.

These wrapped versions are passed into the upstream code as function
parameters, shadowing the globals. Every block is logged as `[relay-guard] blocked …`.

## Verify checks

**A. Module**
- Every URL points to this fork's raw URL or an allowlisted host.
- Every `script-path` is served from this fork.
- Only the sections `Rule`, `URL Rewrite`, `Map Local`, `Script`, `MITM`, `Header Rewrite` and `Body Rewrite` are allowed.
- `[Rule]` entries must use REJECT policies only.
- `[MITM]` hostnames must match `allowedMitmHosts` exactly, and at least one must be present.

**B. License.** Upstream must still be Apache-2.0.

**C. Scripts (static)**
- The upstream code is contained verbatim in the built file.
- The guard header carries the current `guardVersion`.
- The built file compiles.
- Any new non-allowlisted host is a FAIL. Hosts in `knownUpstreamRelays` or `benignStringHosts` are reported as INFO only.
- These constructs FAIL: `eval`, `new Function`, `Function('…')`, global or bracket lookups of guarded APIs, browser networking APIs, `atob(`, `$httpAPI`.

**D. Sandbox (behavioural)**
- Request script:
  - Canary: unguarded upstream should still attempt the relay; if it doesn't, a WARN says the mechanism may have changed.
  - Guarded run leaks nothing.
  - A blocked relay becomes the local fallback.
  - The cached key is cleared.
  - The "Onesie, no key" and `log_event` scenarios cause no egress.
- Response script: the browse, next, player, get_watch, config, search and guide endpoints cause no egress.

**E. Run-on.** Each built script must refuse a request from a foreign host.

## Security invariants (do not weaken)

- `allowedMitmHosts` is the tight boundary: currently `*.googlevideo.com` and
  `youtubei.googleapis.com`, with exact matching. The MITM check must never be
  compared against `allowedHosts`: that list trusts all of `googleapis.com`, and
  a wildcard MITM there would reach well beyond YouTube.
- Widening either allowlist needs a stated reason in the commit message.
- Upstream code stays byte-for-byte. Change behaviour only in the guard.
- Everything fails closed. Guard errors lead to the fallback. An empty MITM
  list makes the build refuse to run. A verify FAIL publishes nothing.
- Don't add another pipeline alongside this one. Pushes made with
  `GITHUB_TOKEN` don't trigger other workflows, so a second workflow would
  never audit an upstream sync.

## Threat model

The scripts run inside a MITM proxy on a phone that also runs sensitive apps.
The realistic worst cases are:
- An upstream update exfiltrates YouTube auth headers, or other data from the intercepted traffic.
- An upstream update widens MITM to hosts other apps use.

The defences, each covered by the checks above:
- MITM scoped to two hosts.
- No egress outside Google hosts.
- A run-on check inside every script.
- Automatic syncs blocked on anything new.

## How to make changes

- **Tooling or config:** edit `tools/` or `fork.config.json`. Bump
  `guardVersion` whenever `guard-template.js` changes. Then run the workflow
  manually with `force` ticked. Template or config changes also alter the
  fingerprint, so the next scheduled run rebuilds anyway.
- **Local run:**
  ```sh
  git clone --depth 1 https://github.com/Maasea/sgmodule.git /tmp/upstream
  node tools/build.mjs --upstream /tmp/upstream --owner <owner> --repo <repo> --force
  node tools/verify.mjs --upstream /tmp/upstream --report /tmp/report.md
  ```
  Don't commit a locally built output unless it came from the real upstream.
- **When a sync fails:** read the issue report. If the new behaviour is benign,
  update the relevant config list deliberately and explain why in the commit.
  Don't loosen a check to make it pass.
- **Testing changes:** also test against hostile upstream variants. Useful ones:
  a MITM wildcard, an extra MITM host, a missing hostname line, a `[General]`
  section, a PROXY rule, and a script calling a foreign host. Each must FAIL,
  or be refused by the build.

## History

- **2026-09:**
  - Added the guard run-on check and verify section A2 (sections, REJECT-only rules, MITM hosts).
  - Added `atob`/`$httpAPI` to the suspicious list and `mitm.runOn` to the lock.
  - Review fixes:
    - The MITM check had been compared against the broad egress list; it now uses the exact `allowedMitmHosts`.
    - An empty `RUN_ON` had disabled the guard; it now fails closed, and the build refuses.
    - Added verify section E.
  - Guard bumped to 1.1.0.
  - A separate Python audit pipeline was proposed and rejected as a duplicate of this one.
