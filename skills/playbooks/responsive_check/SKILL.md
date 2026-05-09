---
name: responsive_check
description: Tests the page at mobile (375x812) and tablet (768x1024) viewports. Detects forms, tables, or navigation that disappear without a mobile-friendly replacement.
type: playbook
categories: [responsive]
estimatedDurationMs: 10000
---

# Usage

Tests the current page at mobile (375x812) viewport. Compares the page model at the default viewport against mobile: looks for forms that disappeared, tables that lost columns, navigation elements that vanished without a hamburger/menu replacement, and horizontal content overflow. Returns `suspicious` if elements disappeared or layout degraded, `ok` if structure is preserved.

# Inputs

- `route` (required): URL to navigate to and test.
