/**
 * SummaryMemory — a per-agent rolling log of recently-attempted playbooks.
 *
 * Replaces the chunked-conversation history-compaction trick from v1. The
 * agent loop keeps one continuous Anthropic conversation and prepends a
 * compact textual summary of past playbook attempts to every turn's user
 * message, so the agent always knows what they've already tried even when
 * the older turn-pairs have been elided by the sliding-window compaction.
 *
 * Capped at the 30 most-recent entries; older entries fall off when the cap
 * is exceeded. This keeps the serialised tail bounded on long runs.
 */

export interface MemoryEntry {
  /** ISO 8601 timestamp the entry was added. */
  ts: string;
  /** Playbook the agent invoked (without the `mcp__playbooks__` prefix). */
  playbookName: string;
  /** Route the playbook ran against. */
  route: string;
  /** Stable id of the form/table/modal/wizard the playbook targeted, when applicable. */
  targetId: string | null;
  /** Outcome status the playbook returned. */
  status: 'ok' | 'failed' | 'suspicious';
  /** Concise human-readable summary, suitable for a single bullet line. */
  oneLineSummary: string;
}

/**
 * Rolling list of recent playbook attempts. Single-writer-per-agent — the
 * loop appends an entry after every playbook tool result is parsed.
 */
export class SummaryMemory {
  private entries: MemoryEntry[] = [];
  private readonly maxEntries = 30;

  /** Append a new entry; drops the oldest entry once the cap is exceeded. */
  add(entry: MemoryEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.shift();
    }
  }

  /**
   * Render entries as a compact bullet list. Returns an empty string when
   * there are no entries — callers should treat empty as "do not include the
   * summary section in the next user message".
   */
  serialize(): string {
    if (this.entries.length === 0) return '';
    const lines = this.entries.map(
      (e) =>
        `- [${e.status}] ${e.playbookName}${e.targetId ? `(${e.targetId})` : ''} on ${e.route} — ${e.oneLineSummary}`,
    );
    return `Playbooks attempted so far:\n${lines.join('\n')}`;
  }

  /** Number of entries currently held. */
  size(): number {
    return this.entries.length;
  }

  /** Read-only snapshot of all entries. Used by tests and telemetry. */
  list(): MemoryEntry[] {
    return [...this.entries];
  }
}
