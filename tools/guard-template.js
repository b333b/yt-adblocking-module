/*
 * relay-guard __GUARD_VERSION__ (injected by tools/build.mjs; do not edit by hand)
 * Upstream: __UPSTREAM_REPO__ @ __UPSTREAM_SHA__ : __UPSTREAM_PATH__
 * License: Apache-2.0 (see LICENSE). Statement of changes (Apache-2.0 §4b):
 *   The upstream script below is included byte-for-byte, but it runs inside
 *   this wrapper, which blocks any network egress (redirects, Location headers,
 *   $httpClient/$task/fetch, browser networking APIs) to hosts outside:
 *   __ALLOW_LIST__
 */
;(function (__G) {
  var ALLOW = __ALLOW_JSON__;
  var ONESIE = __ONESIE_JSON__;

  function report(evt) {
    try { console.log("[relay-guard] blocked " + evt.type + " -> " + evt.host); } catch (_) {}
    try { if (__G && __G.__RELAY_GUARD_EVENTS__) __G.__RELAY_GUARD_EVENTS__.push(evt); } catch (_) {}
  }

  function hostOf(u) {
    if (typeof u !== "string") {
      if (u && typeof u === "object" && typeof u.href === "string") u = u.href; else return null;
    }
    var h = null;
    try { if (typeof URL === "function") h = new URL(u).hostname; } catch (_) { h = null; }
    if (h === null) {
      var m = /^[a-z][a-z0-9+.\-]*:\/\/([^\/\\?#]*)/i.exec(u);
      if (!m) return null;
      h = m[1];
      var at = h.lastIndexOf("@");
      if (at >= 0) h = h.slice(at + 1);
      h = h.replace(/:\d*$/, "");
    }
    h = String(h).toLowerCase().replace(/\.$/, "");
    if (!h || /[^a-z0-9.\-]/.test(h)) return null; // IPv6, escapes, odd input: fail closed
    return h;
  }

  function hostAllowed(h) {
    if (!h) return false;
    for (var i = 0; i < ALLOW.length; i++) {
      var d = ALLOW[i];
      if (h === d || (h.length > d.length && h.slice(-(d.length + 1)) === "." + d)) return true;
    }
    return false;
  }

  // Absolute URL required (used for anything that makes a request)
  function allowedAbsolute(u) { return hostAllowed(hostOf(u)); }

  // Location header: relative paths stay on the same (already allowed) host
  function allowedLocation(v) {
    v = String(v == null ? "" : v).trim();
    if (/^\/\//.test(v)) return allowedAbsolute("https:" + v);
    if (/^[a-z][a-z0-9+.\-]*:/i.test(v)) return allowedAbsolute(v);
    return !/^[\\]/.test(v);
  }

  var reqUrl = "", reqHeaders = {};
  try {
    if (typeof $request !== "undefined" && $request) {
      reqUrl = String($request.url || "");
      reqHeaders = $request.headers || {};
    }
  } catch (_) {}

  function short(v) { return String(v == null ? "" : v).slice(0, 120); }

  // Mirrors upstream's own non-relay path: forget the cached Onesie key so the
  // app falls back to /youtubei/v1/player, which the response script handles locally.
  function clearOnesieKey() {
    try {
      if (!ONESIE || !ONESIE.storeKey || typeof $persistentStore === "undefined") return;
      var raw = $persistentStore.read(ONESIE.storeKey);
      if (!raw) return;
      var cfg = JSON.parse(raw);
      var ua = reqHeaders["user-agent"] != null ? reqHeaders["user-agent"] : reqHeaders["User-Agent"];
      var pk = String(ua || "").indexOf("music") >= 0 ? ONESIE.musicKey : ONESIE.videoKey;
      if (cfg && cfg[pk]) {
        delete cfg[pk];
        $persistentStore.write(JSON.stringify(cfg), ONESIE.storeKey);
      }
    } catch (_) {}
  }

  function fallback() {
    if (/\/initplayback/.test(reqUrl)) {
      clearOnesieKey();
      return { response: { status: 200, headers: { "Content-Type": "text/plain" }, body: new Uint8Array(0) } };
    }
    return {};
  }

  var realDone = typeof $done === "function" ? $done : undefined;

  function guardedDone(obj) {
    if (!realDone) return;
    var kind = null, host = null;
    try {
      if (obj && typeof obj === "object") {
        if (obj.url != null && !allowedAbsolute(obj.url)) {
          kind = "$done.url"; host = hostOf(obj.url) || short(obj.url);
        }
        var sets = [obj.headers, obj.response && typeof obj.response === "object" ? obj.response.headers : null];
        for (var s = 0; s < sets.length && !kind; s++) {
          var hs = sets[s];
          if (!hs || typeof hs !== "object") continue;
          for (var k in hs) {
            if (/^location$/i.test(k) && !allowedLocation(hs[k])) {
              kind = "Location header"; host = hostOf(String(hs[k])) || short(hs[k]); break;
            }
          }
        }
      }
    } catch (e) {
      kind = "guard-error"; host = short(e);
    }
    if (kind) {
      report({ type: kind, host: host, request: short(reqUrl) });
      return realDone(fallback());
    }
    return realDone.apply(this, arguments);
  }

  function guardHttpClient(hc) {
    if (!hc) return hc;
    var out = {};
    ["get", "post", "put", "delete", "head", "options", "patch"].forEach(function (m) {
      if (typeof hc[m] !== "function") return;
      out[m] = function (opts, cb) {
        var u = typeof opts === "string" ? opts : (opts && opts.url);
        if (!allowedAbsolute(u)) {
          report({ type: "$httpClient." + m, host: hostOf(u) || short(u), request: short(reqUrl) });
          if (typeof cb === "function") { try { cb("blocked by relay-guard", null, null); } catch (_) {} }
          return;
        }
        return hc[m].apply(hc, arguments);
      };
    });
    return out;
  }

  function guardTask(t) {
    if (!t) return t;
    return {
      fetch: function (req) {
        var u = req && req.url;
        if (!allowedAbsolute(u)) {
          report({ type: "$task.fetch", host: hostOf(u) || short(u), request: short(reqUrl) });
          return Promise.reject({ error: "blocked by relay-guard" });
        }
        return t.fetch(req);
      }
    };
  }

  var gFetch = typeof fetch === "function" ? function (input, init) {
    var u = typeof input === "string" ? input : (input && (input.url || input.href));
    if (!allowedAbsolute(u)) {
      report({ type: "fetch", host: hostOf(u) || short(u), request: short(reqUrl) });
      return Promise.reject(new TypeError("blocked by relay-guard"));
    }
    return fetch(input, init);
  } : undefined;

  function blockedApi(name) {
    return function () {
      report({ type: name, host: "(any)", request: short(reqUrl) });
      throw new Error(name + " blocked by relay-guard");
    };
  }

  var gNavigator = typeof navigator !== "undefined" ? {
    userAgent: navigator.userAgent,
    language: navigator.language,
    sendBeacon: function () { report({ type: "sendBeacon", host: "(any)", request: short(reqUrl) }); return false; }
  } : undefined;

  (function ($done, $httpClient, $task, fetch, XMLHttpRequest, WebSocket, EventSource, Image, importScripts, navigator) {
/* ===== upstream code (unchanged) ===== */
__UPSTREAM_CODE__
/* ===== end upstream code ===== */
  })(
    guardedDone,
    guardHttpClient(typeof $httpClient !== "undefined" ? $httpClient : undefined),
    guardTask(typeof $task !== "undefined" ? $task : undefined),
    gFetch,
    typeof XMLHttpRequest !== "undefined" ? blockedApi("XMLHttpRequest") : undefined,
    typeof WebSocket !== "undefined" ? blockedApi("WebSocket") : undefined,
    typeof EventSource !== "undefined" ? blockedApi("EventSource") : undefined,
    typeof Image !== "undefined" ? blockedApi("Image") : undefined,
    typeof importScripts !== "undefined" ? blockedApi("importScripts") : undefined,
    gNavigator
  );
})(typeof globalThis !== "undefined" ? globalThis : this);
