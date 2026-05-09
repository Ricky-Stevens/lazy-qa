---
name: perf_web_vitals
description: Measures Core Web Vitals (LCP, CLS, FCP, TTFB) on the current page. Flags pages with poor performance scores. Zero LLM cost — pure browser measurement.
type: playbook
categories: [performance]
estimatedDurationMs: 8000
---

# Usage

Measures Core Web Vitals on a page using the browser's Navigation Timing and Performance Observer APIs. Compares against Google's "poor" thresholds: LCP > 2500ms, CLS > 0.1, FCP > 1800ms, TTFB > 800ms. Returns `suspicious` if any metric exceeds its threshold, `ok` if all pass.

# Inputs

- `route` (required): URL to navigate to and measure.
