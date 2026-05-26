// broadcast-log.js — in-memory ring buffer of last 100 broadcast events
// Persisted across daemon ticks but not across process restarts (intentional — we want fresh signal).
const MAX_EVENTS = 100;
const events = [];

export function logBroadcast(event) {
  const entry = {
    ts: new Date().toISOString(),
    ...event,
  };
  events.unshift(entry);
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
  return entry;
}

export function getBroadcasts() {
  return events;
}

export function getBroadcastStats() {
  const now = Date.now();
  const last_24h = events.filter(e => now - new Date(e.ts).getTime() < 86400000).length;
  const last_1h  = events.filter(e => now - new Date(e.ts).getTime() < 3600000).length;
  const by_worker = events.reduce((acc, e) => {
    acc[e.worker] = (acc[e.worker] || 0) + 1;
    return acc;
  }, {});
  const healthy = events.filter(e => e.healthy === true).length;
  const total = events.length;
  return {
    total_events_in_buffer: total,
    events_last_1h: last_1h,
    events_last_24h: last_24h,
    healthy_events: healthy,
    healthy_percent: total > 0 ? Math.round((healthy / total) * 100) : 0,
    by_worker,
    oldest_event_ts: events[events.length - 1]?.ts || null,
    newest_event_ts: events[0]?.ts || null,
  };
}
