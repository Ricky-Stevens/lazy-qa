/**
 * A bug, regression, or unexpected behaviour reported by an agent.
 *
 * Schema lives inline in `tools/findings-server.ts` — that's where Zod
 * validates incoming MCP calls. This type is the runtime shape we pass
 * around the orchestrator and write to disk.
 */
export interface Finding {
  id: string;
  ts: string;
  severity: 'critical' | 'major' | 'minor' | 'cosmetic';
  category:
    | 'validation'
    | 'error-handling'
    | 'ux-confusion'
    | 'visual-regression'
    | 'broken-feature'
    | 'performance'
    | 'unexpected-behavior'
    | 'accessibility'
    | 'other';
  title: string;
  description: string;
  stepsToReproduce: string[];
  expected: string;
  actual: string;
  route?: string;
  confidence: 'certain' | 'likely' | 'maybe-flake';
  source: 'agent' | 'heuristic';
  agentId?: string;
  /** Set when source='heuristic'. Currently unused — heuristic finder was retired
   * with note_step. Kept on the type so persisted findings from older runs still parse. */
  ruleName?: string;
  /** Path (relative to the run directory) to a screenshot captured at the moment
   * the finding was filed. Set when the agent reports with `attach_screenshot: true`. */
  screenshotPath?: string;
  /** Optional list of tool calls the agent recommends a reviewer (or replay
   * tool) execute to reproduce the finding. */
  reproductionActions?: Array<{ tool: string; args: Record<string, unknown> }>;
  httpStatus?: number;
  httpMethod?: string;
  requestUrl?: string;
  consoleErrors?: string[];
  /** URL of the page at the moment the finding was filed. Auto-captured by
   *  the harness — agents do not set this directly. */
  filedAtUrl?: string;
  /** First N bytes of the HTTP response body at the time the finding was
   *  filed (when available). Auto-captured by the harness. */
  responseBodySample?: string;
}
