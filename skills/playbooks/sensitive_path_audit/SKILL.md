---
name: sensitive_path_audit
description: Probe well-known sensitive paths (.git, .env, /backup, /api/swagger, /robots.txt, etc.) and flag any that return 200 with non-error content.
type: playbook
categories: [security]
estimatedDurationMs: 10000
personaAllowlist: [bobby-tables, caine]
---

# Usage

Probe a broader list of often-forgotten sensitive paths and flag any that return 200 with non-error content. Default paths include `.git/HEAD`, `.env`, `/backup`, `/api/swagger`, `/admin`, `/debug`, `/internal`, `/api/users`, `/robots.txt`, `/sitemap.xml`, `/api/admin`.

# Inputs

- `paths` (optional): array of paths to probe. Defaults to the built-in sensitive-path list.
