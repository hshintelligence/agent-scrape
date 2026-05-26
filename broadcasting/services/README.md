# HSH Intelligence Services Registry

Each `*.json` file in this directory is a HSH Intelligence agent-native service.
The Broadcasting Tower, HERO Recruiter, and Magnet workers all iterate over
this directory and auto-broadcast each service across every channel.

## Adding a new HSH service

1. Copy `agent-scrape.json` as a template
2. Rename to `<service-id>.json`
3. Fill in endpoints, payment details, tools, broadcast_targets
4. Commit + push
5. Daemon picks it up on next heartbeat (no code changes needed)

## Schema

See `agent-scrape.json` for the canonical shape. All fields documented inline.
