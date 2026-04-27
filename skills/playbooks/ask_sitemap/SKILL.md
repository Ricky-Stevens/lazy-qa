---
name: ask_sitemap
description: Query the shared SiteMap for unvisited routes, untested forms, unsorted tables, unexercised modals, unexercised wizards, or 4xx routes. Returns up to 10 items in evidence.
type: playbook
categories: [discovery]
estimatedDurationMs: 200
---

# Usage

Query the shared SiteMap accessor for coverage gaps the agent should address. Use this at the start of a session or whenever you want to know what the sitemap knows about unexplored areas.

# Inputs

- `query` (required): one of `"unvisited routes"`, `"untested forms"`, `"unsorted tables"`, `"unexercised modals"`, `"unexercised wizards"`, `"4xx routes"`
