const N8N_WEBHOOK = "https://brompton.app.n8n.cloud/webhook/oaas-query";
const ALLOWED_ORIGIN = "https://edge-oaas.com";
const RATE_STORE = "oaas-rate-limits";

// In-memory sliding-window counters (best-effort; reset per container restart)
const ipCounters      = new Map();
const sessionCounters = new Map();
const loginIpCounters = new Map();

const CHAT_WINDOW_MS    = 60_000;
const CHAT_IP_LIMIT     = 30;
const CHAT_SESSION_LIMIT = 20;
const LOGIN_WINDOW_MS   = 5 * 60_000;
const LOGIN_IP_LIMIT    = 10;
const LOGIN_LOCKOUT_FAIL = 5;
const LOGIN_LOCKOUT_MS  = 15 * 60_000;

function slidingCheck(map, key, limit, windowMs) {
  const now = Date.now();
  const e = map.get(key);
  if (!e || now - e.start >= windowMs) {
    map.set(key, { count: 1, start: now });
    return true;
  }
  e.count++;
  return e.count <= limit;
}

const BASE_HEADERS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

function tooManyRequests(retryAfter, message) {
  return {
    statusCode: 429,
    headers: { ...BASE_HEADERS, "Retry-After": String(retryAfter) },
    body: JSON.stringify({ success: false, error: message, retryAfter }),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: BASE_HEADERS, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: BASE_HEADERS, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // Client IP (Netlify header takes precedence over x-forwarded-for)
  const ip = (
    event.headers["x-nf-client-connection-ip"] ||
    (event.headers["x-forwarded-for"] || "").split(",")[0] ||
    "unknown"
  ).trim();

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch {
    return { statusCode: 400, headers: BASE_HEADERS, body: JSON.stringify({ success: false, error: "Invalid request body" }) };
  }

  const isLogin = body.action === "login";

  // ── Rate limiting ──
  if (isLogin) {
    if (!slidingCheck(loginIpCounters, ip, LOGIN_IP_LIMIT, LOGIN_WINDOW_MS)) {
      return tooManyRequests(300, "Too many login attempts from this IP. Please wait 5 minutes before trying again.");
    }
  } else {
    if (!slidingCheck(ipCounters, ip, CHAT_IP_LIMIT, CHAT_WINDOW_MS)) {
      return tooManyRequests(60, "Too many requests. Please wait a moment and try again.");
    }
    const sid = String(body.sessionId || "");
    if (sid && !slidingCheck(sessionCounters, sid, CHAT_SESSION_LIMIT, CHAT_WINDOW_MS)) {
      return tooManyRequests(60, "Too many requests in this session. Please wait a moment and try again.");
    }
  }

  // ── Login: check persistent lockout, then track failures ──
  if (isLogin) {
    let store = null;
    try {
      const { getStore } = require("@netlify/blobs");
      store = getStore(RATE_STORE);
    } catch {}

    const lockoutKey = "login-lockout-" + ip;

    if (store) {
      try {
        const lockout = await store.get(lockoutKey, { type: "json" });
        if (lockout && lockout.lockedUntil && Date.now() < lockout.lockedUntil) {
          const retryAfter = Math.ceil((lockout.lockedUntil - Date.now()) / 1000);
          return tooManyRequests(
            retryAfter,
            `Too many failed login attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`
          );
        }
      } catch {}
    }

    // Proxy login request
    let upstream, responseBody;
    try {
      upstream = await fetch(N8N_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: event.body,
      });
      responseBody = await upstream.text();
    } catch {
      return { statusCode: 502, headers: BASE_HEADERS, body: JSON.stringify({ success: false, error: "Service unavailable. Please try again." }) };
    }

    // Track failures / clear on success
    if (store) {
      try {
        let upstreamData;
        try { upstreamData = JSON.parse(responseBody); } catch {}
        if (upstreamData && upstreamData.success === false) {
          const current = (await store.get(lockoutKey, { type: "json" }).catch(() => null)) || {};
          const failCount = (current.failCount || 0) + 1;
          const lockedUntil = failCount >= LOGIN_LOCKOUT_FAIL ? Date.now() + LOGIN_LOCKOUT_MS : null;
          await store.set(lockoutKey, JSON.stringify({ failCount, lockedUntil }));
        } else if (upstreamData && upstreamData.organizations) {
          await store.delete(lockoutKey).catch(() => {});
        }
      } catch {}
    }

    return {
      statusCode: upstream.status,
      headers: { ...BASE_HEADERS, "Content-Type": upstream.headers.get("content-type") || "application/json" },
      body: responseBody,
    };
  }

  // ── Chat proxy ──
  try {
    const upstream = await fetch(N8N_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: event.body,
    });
    const responseBody = await upstream.text();
    return {
      statusCode: upstream.status,
      headers: { ...BASE_HEADERS, "Content-Type": upstream.headers.get("content-type") || "application/json" },
      body: responseBody,
    };
  } catch {
    return { statusCode: 502, headers: BASE_HEADERS, body: JSON.stringify({ success: false, error: "Service unavailable. Please try again." }) };
  }
};
