---
name: walk_pagination
description: Page through a table or paginated list. Records row counts and first-row text per page; flags suspicious if duplicate or vanishing rows appear.
type: playbook
categories: [table]
estimatedDurationMs: 6000
---

# Usage

Page through a table using Next-buttons up to `maxPages`. Records row counts and first-row text per page. Flags `suspicious` if duplicate or vanishing rows appear, or if Next is enabled but advancing it doesn't change the page.

# Inputs

- `tableId` (required): the table ID from the latest snapshot
- `maxPages` (optional, integer 1–20): maximum pages to walk. Default: 5
