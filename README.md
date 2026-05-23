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

## Local runtime logs

Runtime-backed continuity is stored in append-only NDJSON logs:

- `runtime-events.ndjson`
- `transcript-events.ndjson`

These logs support restart/reconnect recovery and should remain runtime-generated artifacts, not source-controlled project history.
