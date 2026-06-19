const { getStore } = require("@netlify/blobs");

const MAX_LOGS = 200;
const BLOB_KEY = "logs";
const STORE_NAME = "oaas-debug-logs";

exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  let store;
  try {
    store = getStore(STORE_NAME);
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Blob store unavailable: " + err.message }),
    };
  }

  // ── POST: append a log entry (or clear all) ──
  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON body" }) };
    }

    // Optional clear action
    if (body._clear === true) {
      try { await store.set(BLOB_KEY, JSON.stringify([])); } catch {}
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, cleared: true }) };
    }

    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      sessionId: String(body.sessionId || ""),
      nodeName:  String(body.nodeName  || ""),
      timestamp: String(body.timestamp || new Date().toISOString()),
      data:      body.data ?? {},
      receivedAt: new Date().toISOString(),
    };

    let logs = [];
    try {
      const raw = await store.get(BLOB_KEY, { type: "json" });
      logs = Array.isArray(raw) ? raw : [];
    } catch { logs = []; }

    logs = [entry, ...logs].slice(0, MAX_LOGS);

    try {
      await store.set(BLOB_KEY, JSON.stringify(logs));
    } catch (err) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Write failed: " + err.message }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, id: entry.id }) };
  }

  // ── GET: return logs, optionally filtered by sessionId ──
  if (event.httpMethod === "GET") {
    const { sessionId } = event.queryStringParameters || {};

    let logs = [];
    try {
      const raw = await store.get(BLOB_KEY, { type: "json" });
      logs = Array.isArray(raw) ? raw : [];
    } catch { logs = []; }

    if (sessionId) {
      logs = logs.filter(l => l.sessionId === sessionId);
    }

    return { statusCode: 200, headers, body: JSON.stringify(logs) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
};
