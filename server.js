#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const url = require('url');

const PORT = Number(process.env.MISSION_CONTROL_PORT || process.env.PORT || 18792);
const HOST = process.env.MISSION_CONTROL_HOST || '0.0.0.0';
const ROOT = __dirname;
const WORKSPACE = path.resolve(ROOT, '..');
const EVENT_LOG = path.join(ROOT, 'events.ndjson');
const AGENTS = [
  { id: 'altair', name: 'Altair', root: path.join(WORKSPACE, 'altair'), statusPath: path.join(WORKSPACE, 'altair/status.json') },
  { id: 'lyra', name: 'Lyra', root: path.join(WORKSPACE, 'lyra'), statusPath: path.join(WORKSPACE, 'lyra/status.json') },
  { id: 'vega', name: 'Vega', root: path.join(WORKSPACE, 'vega'), statusPath: path.join(WORKSPACE, 'vega/status.json'), optional: true }
];

const clients = new Set();
let lastSnapshotSignature = '';
let lastEventLogSize = 0;

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
      last_report_path: null,
      queue_counts: {},
      notes: agent.optional ? ['No local status source found yet.'] : ['Status file could not be read.']
    };
  }

  return {
    id: agent.id,
    name: agent.name,
    status: raw.status || 'unknown',
    available: true,
    current_task_id: raw.current_task_id || raw.current_brief_id || null,
    backend: raw.current_backend || raw.backend || null,
    repo_path: raw.current_repo_path || raw.repo_path || null,
    last_updated: raw.last_updated || raw.updated_at || raw.updatedAt || null,
    last_task_id: raw.last_task_id || raw.last_brief_id || null,
    last_result_status: raw.last_result_status || null,
    last_report_path: normalizeWorkspacePath(raw.last_report_path),
    last_report_url: raw.last_report_path ? `/files/${normalizeWorkspacePath(raw.last_report_path)}` : null,
    queue_counts: raw.queue_counts || {},
    notes: raw.notes || [],
    raw
  };
}

async function collectAgents() {
  const agents = [];
  for (const agent of AGENTS) {
    agents.push(summarizeStatus(agent, await readJson(agent.statusPath, null)));
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
  try {
    const text = await fsp.readFile(EVENT_LOG, 'utf8');
    return text.trim().split('\n').filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean).slice(-limit);
  } catch {
    return [];
  }
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
  const events = [...loggedEvents, ...stateEvents, ...reportEvents, ...actionEvents]
    .filter((event) => event.timestamp)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, 100);

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
    schema_version: '1.0',
    generated_at: new Date().toISOString(),
    source: 'mission-control-v2',
    private_local_first: true,
    totals,
    agents,
    tasks: states,
    reports,
    outputs,
    events
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
  for (const res of clients) {
    writeSse(res, eventName, data);
  }
}

async function poll() {
  const snapshot = await buildSnapshot();
  const signature = JSON.stringify({
    agents: snapshot.agents.map((agent) => [agent.id, agent.status, agent.current_task_id, agent.last_updated, agent.last_result_status]),
    totals: snapshot.totals,
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
    for (const event of events.slice(-5)) {
      await broadcast('event', event);
    }
  }
  lastEventLogSize = size;
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/snapshot') {
    return sendJson(res, 200, await buildSnapshot());
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
  server.listen(PORT, HOST, () => {
    console.log(`Mission Control v2 listening on http://${HOST}:${PORT}`);
  });
  setInterval(() => {
    poll().catch((error) => console.error('poll failed:', error));
  }, 2000);
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = {
  buildSnapshot,
  appendEvent,
  handleApi,
  readEventLog,
  server,
  writeSse
};
