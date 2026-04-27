---
name: idor_probe
description: Probe a route containing an id segment (numeric or UUID) by navigating to common guessed ids. Flags any 200 that returns non-error content as suspicious (likely IDOR).
type: playbook
categories: [security]
estimatedDurationMs: 8000
---

# Usage

Probe a route containing an ID segment (numeric or UUID) by navigating to common guessed IDs and recording the response status and page heading. Flags any 200 that returns non-error content as suspicious (likely IDOR).

# Inputs

- `routeWithId` (required): a path like `/clients/123` or `/users/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`
- `candidates` (optional): array of id strings to try. Default: `["1", "0", "-1", "99999", "abc", "admin", "<uuid-zeros>"]`
