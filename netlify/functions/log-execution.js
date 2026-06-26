let memLogs = [];

const MAX_LOGS = 200;
const BLOB_KEY = "logs";
const STORE_NAME = "oaas-debug-logs";
const ALLOWED_ORIGIN = "https://edge-oaas.com";

function corsHeaders(origin) {
  const allow = (origin === ALLOWED_ORIGIN || origin === "http://localhost:8888") ? origin : ALLOWED_ORIGIN;
  return {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-admin-token",
    "Vary": "Origin",
  };
}

function ok(body, origin)       { return { statusCode: 200, headers: corsHeaders(origin), body: JSON.stringify(body) }; }
function err(status, msg, orig) { return { statusCode: status, headers: corsHeaders(orig), body: JSON.stringify({ error: msg }) }; }

function checkAdminToken(event) {
  const secret = process.env.ADMIN_TOKEN;
  const provided = event.headers["x-admin-token"] || event.headers["X-Admin-Token"] || "";
  console.log("[auth] secret set:", !!secret, "secret len:", (secret||"").length, "provided len:", provided.length, "match:", provided === secret);
  if (!secret) return false;
  return provided === secret;
}

async function readLogs(store) {
  if (!store) return [...memLogs];
  try {
    const raw = await store.get(BLOB_KEY, { type: "json" });
    return Array.isArray(raw) ? raw : [];
  } catch { return [...memLogs]; }
}

async function writeLogs(store, logs) {
  memLogs = logs;
  if (!store) return;
  try { await store.set(BLOB_KEY, JSON.stringify(logs)); } catch {}
}

exports.handler = async (event) => {
  const origin = event.headers["origin"] || event.headers["Origin"] || ALLOWED_ORIGIN;

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(origin), body: "" };
  }

  let store = null;
  try {
    const { getStore } = require("@netlify/blobs");
    store = getStore(STORE_NAME);
  } catch {}

  // ── POST ──
  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return err(400, "Invalid JSON body", origin); }

    // Clear requires admin auth
    if (body._clear === true) {
      if (!checkAdminToken(event)) return err(401, "Unauthorized", origin);
      memLogs = [];
      if (store) { try { await store.set(BLOB_KEY, JSON.stringify([])); } catch {} }
      return ok({ ok: true, cleared: true }, origin);
    }

    // Write path (used by n8n) — no admin token required
    const entry = {
      id:         Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      sessionId:  String(body.sessionId  || ""),
      nodeName:   String(body.nodeName   || ""),
      timestamp:  String(body.timestamp  || new Date().toISOString()),
      data:       body.data ?? {},
      receivedAt: new Date().toISOString(),
    };
    const logs = [entry, ...(await readLogs(store))].slice(0, MAX_LOGS);
    await writeLogs(store, logs);
    return ok({ ok: true, id: entry.id, storage: store ? "blobs" : "memory" }, origin);
  }

  // ── GET — admin only ──
  if (event.httpMethod === "GET") {
    if (!checkAdminToken(event)) return err(401, "Unauthorized — provide x-admin-token header", origin);
    const { sessionId } = event.queryStringParameters || {};
    let logs = await readLogs(store);
    if (sessionId) logs = logs.filter(l => l.sessionId === sessionId);
    return ok(logs, origin);
  }

  return err(405, "Method not allowed", origin);
};
