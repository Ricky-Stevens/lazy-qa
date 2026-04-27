---
name: header_audit
description: Fetch a list of paths and inspect their response headers for security hardening posture. Status suspicious if any path is missing critical headers.
type: playbook
categories: [security]
estimatedDurationMs: 4000
---

# Usage

Fetch a list of paths and inspect their response headers for hardening posture: X-Frame-Options OR CSP `frame-ancestors`, Strict-Transport-Security (HTTPS only), X-Content-Type-Options, Referrer-Policy, basic CSP presence. Probes paths under `target.allowed_hosts` only; off-allowlist paths are skipped.

# Inputs

- `paths` (required): array of path strings or absolute URLs to audit (minimum 1)
