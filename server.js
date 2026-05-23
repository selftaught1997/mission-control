#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = Number(process.env.MISSION_CONTROL_PORT || process.env.PORT || 18792);
const HOST = process.env.MISSION_CONTROL_HOST || '0.0.0.0';
const POLL_INTERVAL_MS = Math.max(250, Number(process.env.MISSION_CONTROL_POLL_MS || 1000));
const ROOT = __dirname;
const WORKSPACE = path.resolve(ROOT, '..');
const EVENT_LOG = path.join(ROOT, 'events.ndjson');
const RUNTIME_LOG = path.join(ROOT, 'runtime-events.ndjson');
const TRANSCRIPT_LOG = path.join(ROOT, 'transcript-events.ndjson');
const GATEWAY_URL = process.env.MISSION_CONTROL_GATEWAY_URL || 'ws://127.0.0.1:18789';
const RUNTIME_STALE_MS = Math.max(5000, Number(process.env.MISSION_CONTROL_RUNTIME_STALE_MS || 45000));
const SESSION_STALE_MS = Math.max(10000, Number(process.env.MISSION_CONTROL_SESSION_STALE_MS || 10 * 60 * 1000));
const HISTORY_LIMIT = Math.max(10, Number(process.env.MISSION_CONTROL_HISTORY_LIMIT || 80));
const SESSION_LIMIT = Math.max(10, Number(process.env.MISSION_CONTROL_SESSION_LIMIT || 80));
const TIMELINE_LIMIT = Math.max(20, Number(process.env.MISSION_CONTROL_TIMELINE_LIMIT || 220));

const AGENTS = [
  { id: 'gustav', name: 'Gustav', root: ROOT, statusPath: path.join(ROOT, 'agent-status.json') },
  { id: 'altair', name: 'Altair', root: path.join(WORKSPACE, 'altair'), statusPath: path.join(WORKSPACE, 'altair/status.json') },
  { id: 'lyra', name: 'Lyra', root: path.join(WORKSPACE, 'lyra'), statusPath: path.join(WORKSPACE, 'lyra/status.json') },
  { id: 'vega', name: 'Vega', root: path.join(WORKSPACE, 'vega'), statusPath: path.join(WORKSPACE, 'vega/status.json'), optional: true }
];

const clients = new Set();
let lastSnapshotSignature = '';
let lastEventLogSize = 0;

const runtimeState = {
  connected: false,
  connecting: false,
  degraded: true,
  gatewayUrl: GATEWAY_URL,
  status: 'starting',
  lastRuntimeEventAt: null,
  lastConnectAt: null,
  lastDisconnectAt: null,
  lastSessionRefreshAt: null,
  reconnectAttempts: 0,
  lastError: null,
  trackedSessionCount: 0,
  subscribedSessionCount: 0,
  backfill: { pending: 0, complete: 0, failed: 0 },
  logReplayAt: null,
  lastHealth: null
};

const runtimeModel = {
  client: null,
  modules: null,
  sessions: new Map(),
  transcripts: new Map(),
  runtimeEvents: new Map(),
  transcriptKeys: new Set(),
  runtimeKeys: new Set(),
  subscriptions: new Map(),
  liveDeltas: new Map(),
  started: false
};

function sendJson(res, status, body) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(text);
}

function safeJoin(base, requested) {
  const resolved = path.resolve(base, requested.replace(/^\/+/, ''));
  return resolved.startsWith(base) ? resolved : null;
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function statSafe(filePath) {
  try {
    return await fsp.stat(filePath);
  } catch {
    return null;
  }
}

async function listJson(dir) {
  try {
    const names = await fsp.readdir(dir);
    const rows = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const filePath = path.join(dir, name);
      const stat = await statSafe(filePath);
      const data = await readJson(filePath, {});
      rows.push({ name, path: rel(filePath), stat, data });
    }
    return rows.sort((a, b) => (b.stat?.mtimeMs || 0) - (a.stat?.mtimeMs || 0));
  } catch {
    return [];
  }
}

function rel(filePath) {
  return path.relative(WORKSPACE, filePath).split(path.sep).join('/');
}

function fileUrl(filePath) {
  return `/files/${rel(filePath)}`;
}

function normalizeWorkspacePath(filePath) {
  if (!filePath) return null;
  const resolved = path.isAbsolute(filePath) ? filePath : path.join(WORKSPACE, filePath);
  return resolved.startsWith(WORKSPACE) ? rel(resolved) : filePath;
}

function stableHash(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function toIso(value) {
  if (!value) return new Date().toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function extractText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (typeof part.thinking === 'string') return part.thinking ? '[thinking]' : '';
      if (part.type === 'toolCall') return `[tool call] ${part.name || part.toolName || 'tool'}`;
      if (part.type === 'toolResult') return `[tool result] ${part.name || part.toolName || 'tool'}`;
      return firstString(part.content, part.value, part.summary) || '';
    }).filter(Boolean).join('\n');
  }
  if (typeof content === 'object') return firstString(content.text, content.content, content.summary) || JSON.stringify(content).slice(0, 800);
  return String(content);
}

function inferAgentFromSessionKey(sessionKey) {
  const lower = String(sessionKey || '').toLowerCase();
  if (lower.includes('altair')) return 'altair';
  if (lower.includes('lyra')) return 'lyra';
  if (lower.includes('vega')) return 'vega';
  if (lower.startsWith('agent:main:') || lower.includes('gustav') || lower.includes('telegram:direct:1430710013')) return 'gustav';
  return 'gustav';
}

function inferSessionKey(raw) {
  return firstString(
    raw?.sessionKey,
    raw?.key,
    raw?.session?.key,
    raw?.session?.sessionKey,
    raw?.message?.sessionKey,
    raw?.payload?.sessionKey,
    raw?.payload?.key
  );
}

function normalizeSession(raw) {
  const sessionKey = inferSessionKey(raw);
  if (!sessionKey) return null;
  const updatedAt = toIso(raw.updatedAt || raw.updated_at || raw.lastUpdated || raw.last_activity_at || raw.timestamp || Date.now());
  const displayLabel = firstString(
    raw.origin?.label,
    raw.label,
    raw.derivedTitle,
    raw.displayName,
    sessionKey
  ) || sessionKey;
  const ownerAgent = inferAgentFromSessionKey(sessionKey);
  const existing = runtimeModel.sessions.get(sessionKey) || {};
  const status = firstString(raw.status, existing.status) || 'known';
  return {
    ...existing,
    sessionKey,
    label: displayLabel,
    ownerAgent,
    channel: firstString(raw.origin?.surface, raw.origin?.provider, raw.lastChannel, raw.channel, existing.channel) || 'runtime',
    chatType: firstString(raw.chatType, raw.origin?.chatType, raw.kind, existing.chatType) || 'direct',
    status,
    runtimeStatus: status,
    lastUpdated: updatedAt,
    lastActivity: toIso(raw.updatedAt || raw.lastActivity || raw.timestamp || existing.lastActivity || updatedAt),
    subscriptionStatus: existing.subscriptionStatus || 'pending',
    subscribed: existing.subscribed === true,
    backfillStatus: existing.backfillStatus || 'pending',
    backfilledAt: existing.backfilledAt || null,
    stale: Date.now() - Date.parse(updatedAt) > SESSION_STALE_MS,
    raw: { ...existing.raw, ...raw }
  };
}

function summarizeRuntimeEvent(type, raw, sessionKey) {
  if (type === 'session.message') {
    const role = raw?.message?.role || raw?.role || 'message';
    return `${role} message`;
  }
  if (type === 'chat') {
    const text = extractText(raw?.content || raw?.delta || raw?.message?.content || raw?.text);
    return text ? `chat ${text.slice(0, 120)}` : 'chat activity';
  }
  if (type === 'session.tool') {
    const phase = firstString(raw?.phase, raw?.data?.phase);
    const name = firstString(raw?.toolName, raw?.name, raw?.tool?.name, raw?.data?.name) || 'tool';
    return phase ? `${name} ${phase}` : `tool ${name}`;
  }
  if (type === 'sessions.changed') return `session changed ${sessionKey || ''}`.trim();
  if (type === 'agent') return `agent ${raw?.agentId || raw?.agent || raw?.status || 'activity'}`;
  if (type === 'health') return raw?.ok === false ? 'runtime health degraded' : 'runtime health ok';
  return type;
}

function normalizeRuntimeEvent(type, raw, source = 'live') {
  const sessionKey = inferSessionKey(raw);
  const timestamp = toIso(raw?.timestamp || raw?.ts || raw?.message?.timestamp || raw?.updatedAt || Date.now());
  const agent = firstString(raw?.agent, raw?.agentId, raw?.session?.agentId) || (sessionKey ? inferAgentFromSessionKey(sessionKey) : null);
  const runId = firstString(raw?.runId, raw?.sessionId, raw?.session?.sessionId);
  const toolName = firstString(raw?.toolName, raw?.name, raw?.tool?.name, raw?.message?.toolName, raw?.data?.name);
  const dedupeKey = firstString(raw?.dedupeKey, raw?.id, raw?.eventId, raw?.__openclaw?.id) ||
    `runtime:${type}:${sessionKey || 'global'}:${runId || ''}:${toolName || ''}:${timestamp}:${stableHash(raw || {})}`;
  return {
    dedupeKey,
    timestamp,
    eventType: type,
    sessionKey,
    agent,
    runId,
    toolName,
    summary: summarizeRuntimeEvent(type, raw, sessionKey),
    source,
    raw
  };
}

function normalizeTranscriptMessage(sessionKey, raw, source = 'live') {
  const message = raw?.message && typeof raw.message === 'object' ? raw.message : raw;
  const role = firstString(message?.role, raw?.role) || 'message';
  const timestamp = toIso(message?.timestamp || raw?.timestamp || raw?.ts || raw?.updatedAt || Date.now());
  const content = extractText(message?.content ?? raw?.content ?? raw?.delta ?? raw?.text);
  const messageId = firstString(message?.id, message?.messageId, message?.responseId, message?.toolCallId, message?.__openclaw?.id, raw?.id, raw?.__openclaw?.id);
  const seq = message?.seq ?? message?.__openclaw?.seq ?? raw?.seq ?? raw?.__openclaw?.seq ?? null;
  const toolName = firstString(message?.toolName, message?.name, raw?.toolName, raw?.name);
  const dedupeKey = firstString(raw?.dedupeKey, message?.dedupeKey) ||
    `transcript:${sessionKey}:${messageId || seq || `${role}:${timestamp}:${stableHash({ content, toolName })}`}`;
  return {
    id: dedupeKey,
    dedupeKey,
    timestamp,
    sessionKey,
    role,
    content,
    messageId: messageId || null,
    seq,
    ownerAgent: inferAgentFromSessionKey(sessionKey),
    toolName,
    source,
    raw: message
  };
}

async function appendNdjson(filePath, row) {
  await fsp.appendFile(filePath, JSON.stringify(row) + '\n');
}

async function readNdjson(filePath, limit = 500) {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    const lines = text.trim().split('\n').filter(Boolean).slice(-limit);
    return lines.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function getSessionTranscript(sessionKey, limit = 120) {
  return (runtimeModel.transcripts.get(sessionKey) || [])
    .slice()
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
    .slice(-limit);
}

function upsertTranscript(row, opts = {}) {
  if (!row?.sessionKey || !row.dedupeKey || runtimeModel.transcriptKeys.has(row.dedupeKey)) return false;
  const normalizedRow = { id: row.id || row.dedupeKey, ...row };
  runtimeModel.transcriptKeys.add(normalizedRow.dedupeKey);
  const rows = runtimeModel.transcripts.get(normalizedRow.sessionKey) || [];
  rows.push(normalizedRow);
  rows.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  runtimeModel.transcripts.set(normalizedRow.sessionKey, rows.slice(-300));
  const session = runtimeModel.sessions.get(normalizedRow.sessionKey) || normalizeSession({ key: normalizedRow.sessionKey });
  if (session) {
    session.lastActivity = normalizedRow.timestamp;
    session.lastUpdated = normalizedRow.timestamp;
    session.ownerAgent = session.ownerAgent || normalizedRow.ownerAgent;
    session.stale = Date.now() - Date.parse(normalizedRow.timestamp) > SESSION_STALE_MS;
    runtimeModel.sessions.set(normalizedRow.sessionKey, session);
  }
  if (!opts.replay) appendNdjson(TRANSCRIPT_LOG, normalizedRow).catch((error) => console.error('transcript append failed:', error));
  return true;
}

function upsertRuntimeEvent(row, opts = {}) {
  if (!row?.dedupeKey || runtimeModel.runtimeKeys.has(row.dedupeKey)) return false;
  const normalizedRow = { id: row.id || row.dedupeKey, ...row };
  runtimeModel.runtimeKeys.add(normalizedRow.dedupeKey);
  runtimeModel.runtimeEvents.set(normalizedRow.dedupeKey, normalizedRow);
  if (runtimeModel.runtimeEvents.size > 1000) {
    const oldest = [...runtimeModel.runtimeEvents.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).slice(0, 200);
    for (const item of oldest) runtimeModel.runtimeEvents.delete(item.dedupeKey);
  }
  runtimeState.lastRuntimeEventAt = normalizedRow.timestamp;
  if (!opts.replay) appendNdjson(RUNTIME_LOG, normalizedRow).catch((error) => console.error('runtime append failed:', error));
  return true;
}

function dedupeTimelineRows(rows, limit = TIMELINE_LIMIT) {
  const seen = new Set();
  const result = [];
  for (const row of rows.filter((item) => item && item.timestamp).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))) {
    const key = row.id || `${row.event_type || 'event'}:${row.sessionKey || row.task_id || row.agent || 'global'}:${row.timestamp}:${row.summary || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
    if (result.length >= limit) break;
  }
  return result;
}

function summarizeHealth(raw) {
  const channels = Object.entries(raw?.channels || {}).reduce((acc, [name, value]) => {
    acc[name] = {
      configured: Boolean(value?.configured),
      running: Boolean(value?.running),
      lastError: value?.lastError || null,
      accountCount: Object.keys(value?.accounts || {}).length
    };
    return acc;
  }, {});
  return {
    ok: raw?.ok !== false,
    ts: raw?.ts || Date.now(),
    durationMs: raw?.durationMs ?? null,
    channelOrder: raw?.channelOrder || Object.keys(channels),
    channels
  };
}

function getRuntimeSummary() {
  runtimeState.trackedSessionCount = runtimeModel.sessions.size;
  runtimeState.subscribedSessionCount = [...runtimeModel.sessions.values()].filter((session) => session.subscribed).length;
  runtimeState.backfill = [...runtimeModel.sessions.values()].reduce((acc, session) => {
    const key = session.backfillStatus === 'complete' ? 'complete' : session.backfillStatus === 'failed' ? 'failed' : 'pending';
    acc[key] += 1;
    return acc;
  }, { pending: 0, complete: 0, failed: 0 });
  runtimeState.degraded = !runtimeState.connected || (runtimeState.lastRuntimeEventAt && Date.now() - Date.parse(runtimeState.lastRuntimeEventAt) > RUNTIME_STALE_MS);
  return {
    ...runtimeState,
    stale: runtimeState.degraded,
    trackedSessionCount: runtimeState.trackedSessionCount,
    subscribedSessionCount: runtimeState.subscribedSessionCount,
    sessionsWithTranscript: [...runtimeModel.transcripts.values()].filter((rows) => rows.length).length,
    lastHealth: runtimeState.lastHealth ? summarizeHealth(runtimeState.lastHealth) : null
  };
}

function listSessions() {
  return [...runtimeModel.sessions.values()]
    .map((session) => ({
      ...session,
      stale: Date.now() - Date.parse(session.lastActivity || session.lastUpdated || 0) > SESSION_STALE_MS,
      transcriptCount: (runtimeModel.transcripts.get(session.sessionKey) || []).length
    }))
    .sort((a, b) => Date.parse(b.lastActivity || b.lastUpdated || 0) - Date.parse(a.lastActivity || a.lastUpdated || 0));
}

function runtimeTimeline(limit = TIMELINE_LIMIT) {
  const transcript = [...runtimeModel.transcripts.values()].flat().map((row) => ({
    id: row.dedupeKey,
    timestamp: row.timestamp,
    agent: row.ownerAgent,
    event_type: `transcript.${row.role}`,
    sessionKey: row.sessionKey,
    summary: row.content ? row.content.slice(0, 220) : `${row.role} transcript event`,
    details: { role: row.role, source: row.source, toolName: row.toolName }
  }));
  const runtime = [...runtimeModel.runtimeEvents.values()]
    .filter((row) => !['session.message', 'health'].includes(row.eventType))
    .map((row) => ({
      id: row.dedupeKey,
      timestamp: row.timestamp,
      agent: row.agent || 'runtime',
      event_type: row.eventType,
      sessionKey: row.sessionKey,
      summary: row.summary,
      details: { source: row.source, toolName: row.toolName, runId: row.runId }
    }));
  return dedupeTimelineRows([...transcript, ...runtime], limit);
}

async function replayRuntimeLogs() {
  await Promise.all([
    fsp.appendFile(RUNTIME_LOG, '', { flag: 'a' }),
    fsp.appendFile(TRANSCRIPT_LOG, '', { flag: 'a' })
  ]);
  for (const row of await readNdjson(TRANSCRIPT_LOG, 2000)) upsertTranscript(row, { replay: true });
  for (const row of await readNdjson(RUNTIME_LOG, 2000)) {
    upsertRuntimeEvent(row, { replay: true });
    if (row.sessionKey && !runtimeModel.sessions.has(row.sessionKey)) {
      const session = normalizeSession({ key: row.sessionKey, updatedAt: row.timestamp, status: 'replayed' });
      if (session) runtimeModel.sessions.set(session.sessionKey, session);
    }
  }
  runtimeState.logReplayAt = new Date().toISOString();
}

async function trackSession(raw, reason = 'discovery') {
  const session = normalizeSession(raw);
  if (!session) return null;
  const existing = runtimeModel.sessions.get(session.sessionKey);
  runtimeModel.sessions.set(session.sessionKey, {
    ...existing,
    ...session,
    subscriptionStatus: existing?.subscriptionStatus || session.subscriptionStatus,
    subscribed: existing?.subscribed === true || session.subscribed,
    backfillStatus: existing?.backfillStatus || session.backfillStatus,
    backfilledAt: existing?.backfilledAt || session.backfilledAt
  });
  const event = normalizeRuntimeEvent('sessions.changed', { session, reason, timestamp: session.lastUpdated }, reason);
  if (upsertRuntimeEvent(event)) await broadcastTyped('runtime:event', event);
  subscribeSession(session.sessionKey).catch((error) => markSessionSubscription(session.sessionKey, 'failed', error.message));
  backfillSession(session.sessionKey).catch((error) => markSessionBackfill(session.sessionKey, 'failed', error.message));
  return runtimeModel.sessions.get(session.sessionKey);
}

function markSessionSubscription(sessionKey, status, error = null) {
  const session = runtimeModel.sessions.get(sessionKey);
  if (!session) return;
  session.subscriptionStatus = status;
  session.subscribed = status === 'subscribed';
  session.subscriptionError = error;
  runtimeModel.sessions.set(sessionKey, session);
}

function markSessionBackfill(sessionKey, status, error = null) {
  const session = runtimeModel.sessions.get(sessionKey);
  if (!session) return;
  session.backfillStatus = status;
  session.backfillError = error;
  if (status === 'complete') session.backfilledAt = new Date().toISOString();
  runtimeModel.sessions.set(sessionKey, session);
}

async function refreshSessions() {
  if (!runtimeModel.client || !runtimeState.connected) return;
  const result = await runtimeModel.client.request('sessions.list', { limit: SESSION_LIMIT, includeDerivedTitles: true });
  const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
  runtimeState.lastSessionRefreshAt = new Date().toISOString();
  for (const session of sessions) await trackSession(session, 'sessions.list');
  await broadcastTyped('runtime:sessions', { sessions: listSessions(), runtime: getRuntimeSummary() });
}

async function subscribeSession(sessionKey) {
  if (!runtimeModel.client || !runtimeState.connected || !sessionKey) return;
  const state = runtimeModel.subscriptions.get(sessionKey);
  if (state === 'pending' || state === 'subscribed') return;
  runtimeModel.subscriptions.set(sessionKey, 'pending');
  markSessionSubscription(sessionKey, 'subscribing');
  await runtimeModel.client.request('sessions.messages.subscribe', { key: sessionKey });
  runtimeModel.subscriptions.set(sessionKey, 'subscribed');
  markSessionSubscription(sessionKey, 'subscribed');
}

async function backfillSession(sessionKey) {
  const session = runtimeModel.sessions.get(sessionKey);
  if (!runtimeModel.client || !runtimeState.connected || !session || session.backfillStatus === 'complete' || session.backfillStatus === 'backfilling') return;
  markSessionBackfill(sessionKey, 'backfilling');
  const result = await runtimeModel.client.request('chat.history', { sessionKey, limit: HISTORY_LIMIT });
  const messages = Array.isArray(result?.messages) ? result.messages : [];
  let added = 0;
  for (const message of messages) {
    const row = normalizeTranscriptMessage(sessionKey, message, 'backfill');
    if (upsertTranscript(row)) added += 1;
  }
  markSessionBackfill(sessionKey, 'complete');
  if (added) await broadcastTyped('session:transcript', { sessionKey, transcript: getSessionTranscript(sessionKey), added, source: 'backfill' });
}

function updateHealth(raw) {
  runtimeState.lastHealth = summarizeHealth(raw);
  if (raw?.ok === false) {
    runtimeState.degraded = true;
    runtimeState.status = 'degraded';
  }
}

async function handleRuntimeEvent(evt) {
  const type = evt?.event || 'runtime.event';
  const payload = evt?.payload ?? {};
  runtimeState.lastRuntimeEventAt = new Date().toISOString();

  if (type === 'tick' || type === 'connect.challenge') return;
  if (type === 'health') updateHealth(payload);

  if (type === 'sessions.changed') {
    const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [payload?.session || payload].filter(Boolean);
    for (const session of sessions) await trackSession(session, 'sessions.changed');
  }

  const sessionKey = inferSessionKey(payload);
  if (sessionKey && !runtimeModel.sessions.has(sessionKey)) await trackSession({ key: sessionKey, updatedAt: payload?.timestamp || Date.now() }, type);

  if (type === 'session.message') {
    const key = sessionKey || inferSessionKey(payload?.message);
    if (key) {
      const row = normalizeTranscriptMessage(key, payload, 'live');
      if (upsertTranscript(row)) await broadcastTyped('session:message', { sessionKey: key, message: row });
    }
  } else if (type === 'chat') {
    const key = sessionKey || firstString(payload?.sessionKey);
    if (key) {
      const text = extractText(payload?.delta ?? payload?.content ?? payload?.message?.content ?? payload?.text);
      if (text && (payload?.final || payload?.done || payload?.message || payload?.role)) {
        const row = normalizeTranscriptMessage(key, { ...payload, role: payload.role || 'assistant', content: text }, 'live');
        if (upsertTranscript(row)) await broadcastTyped('session:message', { sessionKey: key, message: row });
      } else if (text) {
        const prev = runtimeModel.liveDeltas.get(key) || '';
        runtimeModel.liveDeltas.set(key, (prev + text).slice(-4000));
      }
    }
  }

  const runtimeEvent = normalizeRuntimeEvent(type, payload, 'live');
  if (upsertRuntimeEvent(runtimeEvent)) await broadcastTyped('runtime:event', runtimeEvent);
}

async function loadRuntimeModules() {
  if (runtimeModel.modules) return runtimeModel.modules;
  const scopes = await import('/opt/homebrew/lib/node_modules/openclaw/dist/method-scopes-DhuXuLfv.js');
  const channel = await import('/opt/homebrew/lib/node_modules/openclaw/dist/message-channel-ZzTqBBLH.js');
  runtimeModel.modules = { scopes, channel };
  return runtimeModel.modules;
}

async function startRuntimeBridge() {
  if (runtimeModel.started) return;
  runtimeModel.started = true;
  process.env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS ||= '1';
  await replayRuntimeLogs();
  try {
    const { scopes, channel } = await loadRuntimeModules();
    const client = new scopes.u({
      url: GATEWAY_URL,
      clientName: channel.h.GATEWAY_CLIENT,
      clientDisplayName: 'Mission Control v2',
      mode: channel.m.BACKEND,
      caps: [channel.f.TOOL_EVENTS],
      scopes: [scopes.a, scopes.t],
      onHelloOk: async (hello) => {
        runtimeState.connected = true;
        runtimeState.connecting = false;
        runtimeState.degraded = false;
        runtimeState.status = 'connected';
        runtimeState.lastConnectAt = new Date().toISOString();
        runtimeState.lastError = null;
        runtimeState.reconnectAttempts = 0;
        runtimeModel.subscriptions.clear();
        await broadcastTyped('runtime:status', getRuntimeSummary());
        try {
          await client.request('sessions.subscribe', {});
        } catch (error) {
          runtimeState.lastError = `sessions.subscribe failed: ${error.message}`;
        }
        try {
          await refreshSessions();
        } catch (error) {
          runtimeState.lastError = `sessions.list failed: ${error.message}`;
        }
        for (const session of listSessions()) {
          subscribeSession(session.sessionKey).catch((error) => markSessionSubscription(session.sessionKey, 'failed', error.message));
          backfillSession(session.sessionKey).catch((error) => markSessionBackfill(session.sessionKey, 'failed', error.message));
        }
        const event = normalizeRuntimeEvent('health', { ok: true, hello, timestamp: Date.now() }, 'bridge');
        if (upsertRuntimeEvent(event)) await broadcastTyped('runtime:event', event);
      },
      onEvent: (evt) => {
        handleRuntimeEvent(evt).catch((error) => {
          runtimeState.lastError = `event ${evt?.event || 'unknown'} failed: ${error.message}`;
          console.error('runtime event failed:', error);
        });
      },
      onConnectError: (error) => {
        runtimeState.connected = false;
        runtimeState.connecting = true;
        runtimeState.degraded = true;
        runtimeState.status = 'connect_error';
        runtimeState.lastError = error.message;
        runtimeState.reconnectAttempts += 1;
        broadcastTyped('runtime:status', getRuntimeSummary()).catch(() => {});
      },
      onClose: (code, reason) => {
        runtimeState.connected = false;
        runtimeState.connecting = true;
        runtimeState.degraded = true;
        runtimeState.status = 'disconnected';
        runtimeState.lastDisconnectAt = new Date().toISOString();
        runtimeState.lastError = `gateway closed (${code}): ${reason || 'no reason'}`;
        for (const session of runtimeModel.sessions.values()) {
          session.subscribed = false;
          session.subscriptionStatus = 'disconnected';
        }
        runtimeModel.subscriptions.clear();
        broadcastTyped('runtime:status', getRuntimeSummary()).catch(() => {});
      }
    });
    runtimeModel.client = client;
    runtimeState.connecting = true;
    runtimeState.status = 'connecting';
    client.start();
  } catch (error) {
    runtimeState.connected = false;
    runtimeState.connecting = false;
    runtimeState.degraded = true;
    runtimeState.status = 'disabled';
    runtimeState.lastError = error.message;
    console.error('runtime bridge failed:', error);
  }
}

function summarizeStatus(agent, raw) {
  if (!raw) {
    return {
      id: agent.id,
      name: agent.name,
      status: 'missing',
      available: false,
      current_task_id: null,
      backend: null,
      repo_path: null,
      last_updated: null,
      last_result_status: null,
      last_outcome: null,
      last_report_path: null,
      queue_counts: {},
      notes: agent.optional ? ['No local status source found yet.'] : ['Status file could not be read.']
    };
  }

  const lastUpdated = raw.last_updated || raw.updated_at || raw.updatedAt || null;
  return {
    id: agent.id,
    name: raw.agent || agent.name,
    status: raw.status || 'unknown',
    state: raw.state || raw.status || 'unknown',
    available: true,
    current_task_id: raw.current_task_id || raw.current_brief_id || raw.task || null,
    backend: raw.current_backend || raw.backend || null,
    repo_path: raw.current_repo_path || raw.repo_path || null,
    current_step: raw.current_step || null,
    detail: raw.detail || null,
    last_updated: typeof lastUpdated === 'number' ? new Date(lastUpdated).toISOString() : lastUpdated,
    last_activity_at: typeof raw.last_activity_at === 'number' ? new Date(raw.last_activity_at).toISOString() : (raw.last_activity_at || null),
    activity_counter: Number(raw.activity_counter || 0),
    last_task_id: raw.last_task_id || raw.last_brief_id || null,
    last_result_status: raw.last_result_status || null,
    last_outcome: raw.last_outcome || raw.last_result_status || null,
    last_report_path: normalizeWorkspacePath(raw.last_report_path),
    last_report_url: raw.last_report_path ? `/files/${normalizeWorkspacePath(raw.last_report_path)}` : null,
    queue_counts: raw.queue_counts || {},
    notes: raw.notes || (raw.detail ? [raw.detail] : []),
    raw
  };
}

async function collectAgents() {
  const sessions = listSessions();
  const agents = [];
  for (const agent of AGENTS) {
    const summary = summarizeStatus(agent, await readJson(agent.statusPath, null));
    const linkedSessions = sessions.filter((session) => session.ownerAgent === agent.id).slice(0, 8);
    const runtimeRecent = runtimeTimeline(80).filter((event) => event.agent === agent.id).slice(0, 8);
    const runtimeActive = linkedSessions.some((session) => session.subscribed && !session.stale && ['running', 'active', 'working'].includes(String(session.runtimeStatus || '').toLowerCase()));
    agents.push({
      ...summary,
      runtime: {
        active: runtimeState.connected && runtimeActive,
        sessions: linkedSessions,
        recent_activity: runtimeRecent
      }
    });
  }
  return agents;
}

async function collectStates(agent) {
  const buckets = ['active', 'pending', 'blocked', 'done', 'failed', 'cancelled'];
  const states = [];
  for (const bucket of buckets) {
    const dir = path.join(agent.root, 'inbox', bucket);
    const rows = await listJson(dir);
    for (const row of rows) {
      if (!row.name.endsWith('.state.json')) continue;
      states.push({
        agent: agent.id,
        bucket,
        task_id: row.data.task_id || row.data.brief_id || row.name.replace(/\.state\.json$/, ''),
        status: row.data.status || bucket,
        summary: row.data.summary || row.data.objective || row.data.result_summary || null,
        updated_at: row.data.updated_at || row.data.completed_at || row.data.started_at || row.data.created_at || row.stat?.mtime.toISOString(),
        path: row.path,
        url: fileUrl(path.join(WORKSPACE, row.path))
      });
    }
  }
  return states.sort((a, b) => Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0));
}

async function collectReports(agent) {
  const reports = await listJson(path.join(agent.root, 'reports'));
  return reports.map((row) => ({
    agent: agent.id,
    task_id: row.data.task_id || row.data.brief_id || row.name.replace(/-result\.json$/, ''),
    status: row.data.status || row.data.validation?.status || 'report',
    summary: row.data.summary || row.data.validation?.summary || row.name,
    created_at: row.data.completed_at || row.data.created_at || row.stat?.mtime.toISOString(),
    path: row.path,
    url: fileUrl(path.join(WORKSPACE, row.path)),
    type: 'report'
  }));
}

async function collectOutputs() {
  const outputRoot = path.join(WORKSPACE, 'lyra', 'outputs');
  const items = [];
  async function walk(dir) {
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      const stat = await statSafe(full);
      if (!stat) continue;
      if (stat.isDirectory()) {
        await walk(full);
      } else if (/\.(png|pdf|json|md|mp4|mov)$/i.test(name)) {
        items.push({
          agent: 'lyra',
          task_id: path.basename(path.dirname(full)),
          type: path.extname(name).slice(1).toLowerCase() || 'file',
          path: rel(full),
          url: fileUrl(full),
          created_at: stat.mtime.toISOString(),
          summary: name
        });
      }
    }
  }
  await walk(outputRoot);
  return items.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 30);
}

async function readEventLog(limit = 80) {
  return readNdjson(EVENT_LOG, limit);
}

async function collectActionEvents(limit = 25) {
  const actions = await readJson(path.join(ROOT, 'action-log.json'), []);
  if (!Array.isArray(actions)) return [];
  return actions.slice(-limit).map((entry) => ({
    id: `action-${entry.id}`,
    timestamp: entry.timestamp,
    agent: 'gustav',
    event_type: `action.${entry.category || 'log'}`.toLowerCase(),
    task_id: null,
    summary: entry.summary,
    details: { status: entry.status, category: entry.category, source: 'mission-control/action-log.json' }
  }));
}

function staleFrom(updatedAt, maxAgeDays = 14) {
  if (!updatedAt) return true;
  const ms = Date.now() - Date.parse(updatedAt);
  return !Number.isFinite(ms) || ms > maxAgeDays * 24 * 60 * 60 * 1000;
}

function sourceEnvelope(source, data, maxAgeDays = 14) {
  const updatedAt = data?.updatedAt || data?.updated_at || null;
  return {
    updatedAt,
    source: data?.source || source,
    asOf: data?.asOf || null,
    stale: staleFrom(updatedAt, maxAgeDays),
    notes: data?.notes || null
  };
}

async function readExecutiveJson(name, fallbackItems = []) {
  const filePath = path.join(ROOT, 'executive', name);
  const data = await readJson(filePath, null);
  if (!data || typeof data !== 'object') {
    return {
      ...sourceEnvelope(`mission-control/executive/${name}`, { updatedAt: null, notes: 'Source unavailable or malformed.' }),
      items: fallbackItems,
      error: 'unavailable'
    };
  }
  return {
    ...sourceEnvelope(`mission-control/executive/${name}`, data),
    items: Array.isArray(data.items) ? data.items : fallbackItems,
    locations: Array.isArray(data.locations) ? data.locations : undefined
  };
}

function parseMarkdownTable(lines, startIndex) {
  const rows = [];
  let started = false;
  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line && !started) continue;
    if (!line) break;
    started = true;
    if (!line.startsWith('|')) continue;
    if (/^\|\s*-+/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length >= 3 && cells[0] !== 'Draft') rows.push(cells);
  }
  return rows;
}

function parseSupportAssets(lines, startIndex) {
  const assets = [];
  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.startsWith('## ')) break;
    if (!line.startsWith('- ')) continue;
    const match = line.match(/`([^`]+)`(?:\s*[–-]\s*(.*))?/);
    if (match) assets.push([match[1], 'Support asset', match[2] || 'Supports a review item.']);
  }
  return assets;
}

async function buildReviewQueue() {
  const filePath = path.join(WORKSPACE, 'drafts', 'review-tracker.md');
  try {
    const stat = await statSafe(filePath);
    const text = await fsp.readFile(filePath, 'utf8');
    const lines = text.split(/\r?\n/);
    const updatedMatch = text.match(/_Last updated:\s*([^_]+)_/);
    const updatedAt = stat?.mtime ? stat.mtime.toISOString() : null;
    const sections = {
      awaitingAaronReview: [],
      backgroundInternalDocs: [],
      supportAssets: []
    };
    const sectionMap = [
      ['## Awaiting Aaron Review', 'awaitingAaronReview', parseMarkdownTable],
      ['## Background / Internal Working Docs', 'backgroundInternalDocs', parseMarkdownTable],
      ['## Support Artwork / Assets', 'supportAssets', parseSupportAssets]
    ];
    for (const [heading, key, parser] of sectionMap) {
      const index = lines.findIndex((line) => line.trim() === heading);
      if (index === -1) continue;
      sections[key] = parser(lines, index + 1).map(([draft, status, notes], idx) => ({
        id: `${key}-${idx + 1}`,
        draft: draft.replace(/`/g, ''),
        status,
        notes,
        source: rel(filePath)
      }));
    }
    return {
      updatedAt,
      source: rel(filePath),
      asOf: updatedMatch ? updatedMatch[1].trim() : null,
      stale: staleFrom(updatedAt, 3),
      counts: {
        awaitingAaronReview: sections.awaitingAaronReview.length,
        backgroundInternalDocs: sections.backgroundInternalDocs.length,
        supportAssets: sections.supportAssets.length
      },
      sections
    };
  } catch (error) {
    return {
      updatedAt: null,
      source: rel(filePath),
      stale: true,
      counts: { awaitingAaronReview: 0, backgroundInternalDocs: 0, supportAssets: 0 },
      sections: { awaitingAaronReview: [], backgroundInternalDocs: [], supportAssets: [] },
      error: error.message
    };
  }
}

async function buildRoiSummary() {
  const filePath = path.join(ROOT, 'roi.json');
  const data = await readJson(filePath, {});
  const stat = await statSafe(filePath);
  const start = new Date(data.startDate || Date.now());
  const monthsElapsed = Math.max(1, Math.round((Date.now() - start.getTime()) / (1000 * 60 * 60 * 24 * 30)));
  const hardware = Number(data.hardware || 0);
  const monthlySubscription = Number(data.monthlySubscription || 0);
  const totalCost = hardware + (monthlySubscription * monthsElapsed);
  const valueReturned = Number(data.valueReturned || 0);
  const breakEvenPercent = totalCost > 0 ? Math.min(100, Math.round((valueReturned / totalCost) * 100)) : 0;
  return {
    updatedAt: stat?.mtime ? stat.mtime.toISOString() : null,
    source: rel(filePath),
    stale: staleFrom(stat?.mtime ? stat.mtime.toISOString() : null, 30),
    startDate: data.startDate || null,
    hardware,
    monthlySubscription,
    monthsElapsed,
    totalCost,
    valueReturned,
    breakEvenPercent,
    entries: Array.isArray(data.entries) ? data.entries : [],
    notes: data.notes || null
  };
}

async function buildBacklog() {
  const filePath = path.join(ROOT, 'todo.json');
  const data = await readJson(filePath, {});
  const stat = await statSafe(filePath);
  return {
    updatedAt: stat?.mtime ? stat.mtime.toISOString() : null,
    source: rel(filePath),
    stale: staleFrom(stat?.mtime ? stat.mtime.toISOString() : null, 14),
    items: Array.isArray(data.items) ? data.items : []
  };
}

async function buildRecentWins(limit = 10) {
  const filePath = path.join(ROOT, 'action-log.json');
  const data = await readJson(filePath, []);
  const stat = await statSafe(filePath);
  const items = Array.isArray(data) ? data
    .filter((entry) => ['success', 'done', 'complete'].includes(String(entry.status || '').toLowerCase()))
    .slice(-limit)
    .reverse()
    .map((entry) => ({
      id: entry.id,
      timestamp: entry.timestamp,
      category: entry.category,
      status: entry.status,
      summary: entry.summary,
      detail: entry.detail || null
    })) : [];
  return {
    updatedAt: stat?.mtime ? stat.mtime.toISOString() : null,
    source: rel(filePath),
    stale: staleFrom(stat?.mtime ? stat.mtime.toISOString() : null, 14),
    items
  };
}

async function buildExecutiveOverview() {
  const errors = [];
  async function safe(label, loader) {
    try {
      return await loader();
    } catch (error) {
      errors.push({ source: label, error: error.message });
      return { updatedAt: null, source: label, stale: true, items: [], error: error.message };
    }
  }
  const [goals, clubSnapshot, projects, agentDirectory, reviewQueue, roi, backlog, recentWins] = await Promise.all([
    safe('mission-control/executive/goals.json', () => readExecutiveJson('goals.json')),
    safe('mission-control/executive/club-snapshot.json', () => readExecutiveJson('club-snapshot.json')),
    safe('mission-control/executive/projects.json', () => readExecutiveJson('projects.json')),
    safe('mission-control/executive/agents.json', () => readExecutiveJson('agents.json')),
    safe('drafts/review-tracker.md', buildReviewQueue),
    safe('mission-control/roi.json', buildRoiSummary),
    safe('mission-control/todo.json', buildBacklog),
    safe('mission-control/action-log.json', buildRecentWins)
  ]);
  const blocks = { goals, clubSnapshot, projects, reviewQueue, roi, backlog, recentWins, agentDirectory };
  for (const [name, block] of Object.entries(blocks)) {
    if (block?.error) errors.push({ source: name, error: block.error });
  }
  return {
    schema_version: '1.0',
    updatedAt: new Date().toISOString(),
    source: 'mission-control executive loaders',
    private_local_first: true,
    degraded: errors.length > 0,
    errors,
    goals,
    clubSnapshot,
    projects,
    reviewQueue,
    roi,
    backlog,
    recentWins,
    agentDirectory
  };
}

async function buildSnapshot() {
  const agents = await collectAgents();
  const statesNested = await Promise.all(AGENTS.map(collectStates));
  const reportsNested = await Promise.all(AGENTS.map(collectReports));
  const states = statesNested.flat().slice(0, 40);
  const reports = reportsNested.flat().sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0)).slice(0, 30);
  const outputs = await collectOutputs();
  const loggedEvents = await readEventLog();
  const actionEvents = await collectActionEvents();
  const stateEvents = states.slice(0, 20).map((state) => ({
    id: `state-${state.agent}-${state.task_id}-${state.bucket}`,
    timestamp: state.updated_at,
    agent: state.agent,
    event_type: `task.${state.bucket}`,
    task_id: state.task_id,
    summary: state.summary || `${state.agent} task ${state.bucket}`,
    details: { path: state.path, status: state.status }
  }));
  const reportEvents = reports.slice(0, 20).map((report) => ({
    id: `report-${report.agent}-${report.task_id}`,
    timestamp: report.created_at,
    agent: report.agent,
    event_type: 'report.written',
    task_id: report.task_id,
    summary: report.summary,
    details: { path: report.path, status: report.status }
  }));
  const events = dedupeTimelineRows([...runtimeTimeline(100), ...loggedEvents, ...stateEvents, ...reportEvents, ...actionEvents], 140);

  const totals = agents.reduce((acc, agent) => {
    acc.active += Number(agent.queue_counts.active || 0);
    acc.blocked += Number(agent.queue_counts.blocked || 0);
    acc.pending += Number(agent.queue_counts.pending || 0);
    acc.done += Number(agent.queue_counts.done || 0);
    acc.failed += Number(agent.queue_counts.failed || 0);
    if (['backend_running', 'running', 'working', 'active'].includes(agent.status)) acc.running += 1;
    return acc;
  }, { active: 0, blocked: 0, pending: 0, done: 0, failed: 0, running: 0 });

  return {
    schema_version: '2.0',
    generated_at: new Date().toISOString(),
    source: 'mission-control-v2',
    private_local_first: true,
    totals,
    agents,
    tasks: states,
    reports,
    outputs,
    events,
    runtime: getRuntimeSummary(),
    sessions: listSessions().slice(0, 80),
    timeline: events
  };
}

async function appendEvent(event) {
  const now = new Date().toISOString();
  const clean = {
    id: event.id || `evt-${Date.now()}`,
    timestamp: event.timestamp || now,
    agent: String(event.agent || 'mission-control'),
    event_type: String(event.event_type || 'manual.event'),
    task_id: event.task_id || null,
    summary: String(event.summary || 'Mission Control event'),
    details: event.details && typeof event.details === 'object' ? event.details : {}
  };
  await fsp.appendFile(EVENT_LOG, JSON.stringify(clean) + '\n');
  return clean;
}

function writeSse(res, eventName, data) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function broadcast(eventName, data) {
  for (const res of clients) writeSse(res, eventName, data);
}

async function broadcastTyped(eventName, data) {
  await broadcast(eventName, data);
  if (eventName !== 'runtime:status') await broadcast('runtime:status', getRuntimeSummary());
}

async function poll() {
  const snapshot = await buildSnapshot();
  const signature = JSON.stringify({
    agents: snapshot.agents.map((agent) => [agent.id, agent.status, agent.current_task_id, agent.last_updated, agent.last_result_status, agent.runtime?.active]),
    totals: snapshot.totals,
    runtime: [snapshot.runtime.connected, snapshot.runtime.status, snapshot.runtime.trackedSessionCount, snapshot.runtime.lastRuntimeEventAt],
    firstEvent: snapshot.events[0]?.id || snapshot.events[0]?.timestamp,
    firstOutput: snapshot.outputs[0]?.path
  });
  if (signature !== lastSnapshotSignature) {
    lastSnapshotSignature = signature;
    await broadcast('snapshot', snapshot);
  }

  const stat = await statSafe(EVENT_LOG);
  const size = stat?.size || 0;
  if (size > lastEventLogSize) {
    const events = await readEventLog(20);
    for (const event of events.slice(-5)) await broadcast('event', event);
  }
  lastEventLogSize = size;
}

function decodeSessionKey(encoded) {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/snapshot') return sendJson(res, 200, await buildSnapshot());
  if (pathname === '/api/executive') return sendJson(res, 200, await buildExecutiveOverview());
  if (pathname === '/api/runtime') return sendJson(res, 200, getRuntimeSummary());
  if (pathname === '/api/sessions') return sendJson(res, 200, { sessions: listSessions(), runtime: getRuntimeSummary() });
  if (pathname === '/api/timeline') {
    const snapshot = await buildSnapshot();
    return sendJson(res, 200, { timeline: snapshot.timeline || snapshot.events || [], runtime: getRuntimeSummary() });
  }
  const transcriptMatch = pathname.match(/^\/api\/sessions\/(.+)\/transcript$/);
  if (transcriptMatch) {
    const sessionKey = decodeSessionKey(transcriptMatch[1]);
    return sendJson(res, 200, {
      sessionKey,
      session: runtimeModel.sessions.get(sessionKey) || null,
      transcript: getSessionTranscript(sessionKey, 180),
      runtime: getRuntimeSummary()
    });
  }

  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    clients.add(res);
    writeSse(res, 'hello', { connected_at: new Date().toISOString() });
    writeSse(res, 'runtime:status', getRuntimeSummary());
    writeSse(res, 'runtime:sessions', { sessions: listSessions(), runtime: getRuntimeSummary() });
    writeSse(res, 'timeline', { timeline: runtimeTimeline(TIMELINE_LIMIT) });
    writeSse(res, 'snapshot', await buildSnapshot());
    req.on('close', () => clients.delete(res));
    return;
  }

  if (pathname === '/api/events' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 65536) req.destroy();
    });
    req.on('end', async () => {
      try {
        const event = await appendEvent(JSON.parse(body || '{}'));
        await broadcast('event', event);
        sendJson(res, 201, event);
      } catch (error) {
        sendJson(res, 400, { error: error.message });
      }
    });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

async function serveStatic(req, res, pathname) {
  let filePath;
  if (pathname.startsWith('/files/')) {
    filePath = safeJoin(WORKSPACE, pathname.replace(/^\/files\//, ''));
  } else {
    filePath = safeJoin(ROOT, pathname === '/' ? 'index.html' : pathname);
  }
  if (!filePath) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  const stat = await statSafe(filePath);
  if (!stat || stat.isDirectory()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.png': 'image/png',
    '.pdf': 'application/pdf',
    '.md': 'text/markdown; charset=utf-8'
  };
  res.writeHead(200, {
    'content-type': types[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'cache-control': 'no-store'
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const parsed = url.parse(req.url);
    if (parsed.pathname.startsWith('/api/')) {
      await handleApi(req, res, parsed.pathname);
    } else {
      await serveStatic(req, res, parsed.pathname);
    }
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

async function startServer() {
  await fsp.appendFile(EVENT_LOG, '', { flag: 'a' });
  const stat = await statSafe(EVENT_LOG);
  lastEventLogSize = stat?.size || 0;
  await startRuntimeBridge();
  server.listen(PORT, HOST, () => {
    console.log(`Mission Control v2 listening on http://${HOST}:${PORT}`);
  });
  setInterval(() => {
    poll().catch((error) => console.error('poll failed:', error));
  }, POLL_INTERVAL_MS);
  setInterval(() => {
    refreshSessions().catch((error) => {
      runtimeState.lastError = `session refresh failed: ${error.message}`;
    });
  }, 30000).unref?.();
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  buildSnapshot,
  buildExecutiveOverview,
  appendEvent,
  handleApi,
  readEventLog,
  server,
  writeSse,
  runtimeState,
  runtimeModel,
  startRuntimeBridge,
  normalizeTranscriptMessage,
  normalizeRuntimeEvent
};
