---
name: discover_route_affordances
description: "Probe the current route non-destructively for toolbar/header buttons and table row kebabs. Surfaces affordances the link-graph crawler can't see. Auto-runs once per route; pass force:true after page state changes."
type: playbook
categories: [discovery]
estimatedDurationMs: 8000
---

# Usage

Probe the current route non-destructively: click toolbar/header buttons and table row kebabs, observe what each opens (modal, wizard, menu, navigation, toast, inert), then dismiss. Auto-runs on first agent visit per route; invoke manually with `force: true` after you create new rows or otherwise change page state.

# Inputs

- `force` (optional, boolean): re-probe even if this route has already been probed. Default: false.
