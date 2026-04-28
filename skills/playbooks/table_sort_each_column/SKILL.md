---
name: table_sort_each_column
description: Click each sortable column header on a table; verify rows actually re-order. Detects "sort indicator updates but rows are unchanged" bugs.
type: playbook
categories: [table]
estimatedDurationMs: 8000
---

# Usage

For every column flagged `sortable` in the snapshot's TableSpec, click the header and check the first-row text changed. If it didn't, the sort is broken.

# Inputs

- `tableId` (required): table ID from the latest snapshot

# Outcome

- `ok` if every sortable column changed row order on click
- `suspicious` if any column failed to re-order — each is a candidate finding
