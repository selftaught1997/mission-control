# Mission Control v2 Notes

Mission Control v2 separates an agent's current live state from its last task outcome.

- Current live state comes from each agent status file and describes what is happening now, including `status`, `state`, `current_step`, `detail`, and the current task or brief id.
- Last task outcome is historical result metadata, including `last_task_id`, `last_result_status`, `last_outcome`, and `last_report_path`.

The dashboard reads the full current model from `GET /api/snapshot`. Live updates are delivered over `GET /api/events` as server-sent events; the same endpoint also accepts `POST` requests to append structured events to `events.ndjson`.
