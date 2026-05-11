---
name: accessibility_axe_audit
description: Run axe-core accessibility engine for WCAG 2.1 AA compliance. Catches color contrast, missing ARIA, focus management, and structural violations. Zero LLM cost.
type: playbook
categories: [discovery]
estimatedDurationMs: 5000
personaAllowlist: [sheldon]
---

# Usage

Runs the axe-core accessibility engine in-browser and returns all WCAG 2.1 AA violations with impact level, description, affected elements, and remediation URLs. Zero LLM cost — all analysis is done by axe-core.

Requires `axe-core` npm package to be installed. If not available, returns a graceful "not available" result.

# Inputs

- `route` (required): URL to audit for accessibility.
- `standard` (optional): WCAG standard to check against. Default: `wcag2aa`. Set to `wcag2aaa` for stricter checking.
