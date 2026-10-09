# Mission Control v2 Notes

Mission Control v2 now combines **two planes of truth**:

- **Runtime plane** — a subscriber-first Gateway bridge that tracks live sessions, transcript activity, tool events, and runtime health.
- **File plane** — existing local status/report/output/task data from Gustav, Altair, Lyra, and related workspace files.

The dashboard keeps those planes separate where it matters:

- **Current live state** describes what is happening now, including runtime connectivity, tracked sessions, agent `status`, `state`, `current_step`, `detail`, and the current task or brief id.
- **Last task outcome** is historical result metadata, including `last_task_id`, `last_result_status`, `last_outcome`, and `last_report_path`.

## Core API surfaces

### Existing
- `GET /api/snapshot` — merged Mission Control snapshot for the board and major panels
- `GET /api/events` — SSE stream for snapshots plus typed live updates
- `POST /api/events` — append structured local events to `events.ndjson`

### Runtime-backed
- `GET /api/runtime` — runtime bridge health/connection summary
- `GET /api/sessions` — tracked runtime sessions
- `GET /api/timeline` — merged live timeline across transcript/runtime/file-backed events
- `GET /api/sessions/<encoded-session-key>/transcript` — transcript slice for a tracked session

### Executive-backed
- `GET /api/executive` — structured executive overview for Goals, Club Snapshot, Strategic Projects, Review Queue, ROI, Ops Backlog, Recent Wins, and Agent Directory

## Executive source files

Mission Control v2.1 adds a structured executive layer that is intentionally kept separate from the live runtime plane.
Current executive sources live under `mission-control/executive/` plus selected existing workspace sources:

- `executive/goals.json`
- `executive/club-snapshot.json`
- `executive/projects.json`
- `executive/agents.json`
- `../drafts/review-tracker.md` → normalized into the Review Queue
- `roi.json`
- `todo.json`
- `action-log.json`

If one of these executive sources fails, the executive layer should degrade honestly without breaking the live runtime console.

## Layout controls

Mission Control v2.2 adds a client-side layout layer on top of the live runtime console:

- `Live` / `Executive` / `Both` modes
- per-panel collapse / expand controls
- size controls for taller panels
- drag / reorder support for live and executive panels
- timeline filter chips
- sticky runtime summary controls
- `Reset layout` recovery action

Layout preferences are intentionally browser-local and are stored in `localStorage` under a versioned key. Layout state is presentation-only: collapsing or hiding a panel must not stop its live data updates.

## Agent Office panel

Mission Control v2.3 adds a lightweight visual Agent Office panel to the live dashboard. It is presentation-only and derives its workstation states from the same `snapshot.agents` records that power the Agent Status Board:

- `idle` agents rest with dimmer screens
- planning/thinking states show a subtle thought indicator
- active/runtime/backend states show working indicators
- waiting/queued states show an amber standby accent
- blocked/degraded/missing states show warning treatment
- complete/done states show a ready/check treatment

The office panel participates in the existing collapse, drag/reorder, and local layout persistence system. Reduced-motion users keep the same status visibility with looping animation toned down.

## Local runtime logs

Runtime-backed continuity is stored in append-only NDJSON logs:

- `runtime-events.ndjson`
- `transcript-events.ndjson`

These logs support restart/reconnect recovery and should remain runtime-generated artifacts, not source-controlled project history. Startup reads only the recent tail of large NDJSON logs and compacts oversized logs so the dashboard remains restartable as the runtime history grows.

## Local service

The dashboard is managed by the user LaunchAgent `ai.gustav.workspace-server`, which runs:

`/opt/homebrew/bin/node /Users/gustava-i/.openclaw/workspace/mission-control/server.js`

Expected local URL: `http://127.0.0.1:18792/v2.html`

Logs:

- `/Users/gustava-i/Library/Logs/mission-control.stdout.log`
- `/Users/gustava-i/Library/Logs/mission-control.stderr.log`
