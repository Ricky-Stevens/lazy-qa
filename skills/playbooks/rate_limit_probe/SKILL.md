---
name: rate_limit_probe
description: Sends 15 rapid identical requests to a route and checks whether rate limiting (HTTP 429) is enforced. Flags missing rate limiting as suspicious.
type: playbook
categories: [security]
estimatedDurationMs: 6000
personaAllowlist: [bobby-tables, johnny-five, dilbert, konami]
---

# Usage

Sends 15 rapid identical requests to a route using the page's request context (preserving cookies/session). If none return 429 (Too Many Requests), returns `suspicious` — rate limiting is absent. If any return 429, returns `ok` — rate limiting is working. Marked as speculative so 4xx/5xx responses don't trigger storm detection.

# Inputs

- `route` (required): URL to probe with rapid requests.
- `method` (optional): HTTP method to use — `GET` (default) or `POST`.
