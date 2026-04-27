---
name: route_404_probe
description: "Navigate each caller-supplied path (relative to the current origin) and record the HTTP status. Suspicious when any path returns 5xx. Inputs: paths (array of strings)."
type: playbook
categories: [discovery]
estimatedDurationMs: 8000
---

# Usage

Bulk-probe a list of paths and flag 5xx server errors. Use after `ask_sitemap` returns 4xx routes, or when you want to check whether paths you've guessed actually exist.

# Inputs

- `paths` (required): array of path strings, e.g. `["/admin", "/api/users", "/debug"]`
