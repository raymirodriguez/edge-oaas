// In-memory fallback for when Blobs context isn't available.
// Module-level so it survives across requests within the same warm container.
let memLogs = [];

const MAX_LOGS = 200;
const BLOB_KEY = "logs";
const STORE_NAME = "oaas-debug-logs";

const HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function ok(body) { return { statusCode: 200, headers: HEADERS, body: JSON.stringify(body) }; }
function err(status, msg) { return { statusCode: status, headers: HEADERS, body: JSON.stringify({ error: msg }) }; }

async function readLogs(store) {
  if (!store) return [...memLogs];
  try {
    const raw = await store.get(BLOB_KEY, { type: "json" });
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [...memLogs];
  }
}

async function writeLogs(store, logs) {
  memLogs = logs; // always keep in-memory copy as fallback
  if (!store) return;
  try { await store.set(BLOB_KEY, JSON.stringify(logs)); } catch {}
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return ok({});

  // Try to get a Blobs store; degrade gracefully to in-memory if unavailable.
  let store = null;
  try {
    const { getStore } = require("@netlify/blobs");
    store = getStore(STORE_NAME);
  } catch {
    // Blobs not available — in-memory fallback active
  }

  // ── POST ──
  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return err(400, "Invalid JSON body"); }

    if (body._clear === true) {
      memLogs = [];
      if (store) { try { await store.set(BLOB_KEY, JSON.stringify([])); } catch {} }
      return ok({ ok: true, cleared: true });
    }

    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      sessionId:  String(body.sessionId  || ""),
      nodeName:   String(body.nodeName   || ""),
      timestamp:  String(body.timestamp  || new Date().toISOString()),
      data:       body.data ?? {},
      receivedAt: new Date().toISOString(),
    };

    const logs = [entry, ...(await readLogs(store))].slice(0, MAX_LOGS);
    await writeLogs(store, logs);

    return ok({ ok: true, id: entry.id, storage: store ? "blobs" : "memory" });
  }

  // ── GET ──
  if (event.httpMethod === "GET") {
    const { sessionId } = event.queryStringParameters || {};
    let logs = await readLogs(store);
    if (sessionId) logs = logs.filter(l => l.sessionId === sessionId);
    return ok(logs);
  }

  return err(405, "Method not allowed");
};
