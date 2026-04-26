import { describe, expect, it } from 'vitest';
import { type MemoryEntry, SummaryMemory } from './summary-memory.ts';

function entry(i: number, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    ts: `2026-04-26T00:00:${String(i).padStart(2, '0')}Z`,
    playbookName: `playbook_${i}`,
    route: `/route-${i}`,
    targetId: `target-${i}`,
    status: 'ok',
    oneLineSummary: `summary ${i}`,
    ...overrides,
  };
}

describe('SummaryMemory', () => {
  it('serializes 5 entries as a 5-line bullet list', () => {
    const mem = new SummaryMemory();
    for (let i = 1; i <= 5; i++) mem.add(entry(i));

    const serialized = mem.serialize();
    expect(mem.size()).toBe(5);

    const lines = serialized.split('\n');
    // 1 header + 5 bullet lines
    expect(lines).toHaveLength(6);
    expect(lines[0]).toBe('Playbooks attempted so far:');
    for (let i = 0; i < 5; i++) {
      expect(lines[i + 1]).toBe(
        `- [ok] playbook_${i + 1}(target-${i + 1}) on /route-${i + 1} — summary ${i + 1}`,
      );
    }
  });

  it('caps at 30 entries and drops the oldest 5 when 35 are added', () => {
    const mem = new SummaryMemory();
    for (let i = 1; i <= 35; i++) mem.add(entry(i));

    expect(mem.size()).toBe(30);

    const all = mem.list();
    // Oldest 5 (entries 1..5) should have been shifted off; remaining 6..35.
    expect(all[0]?.playbookName).toBe('playbook_6');
    expect(all[all.length - 1]?.playbookName).toBe('playbook_35');
  });

  it('returns the empty string when no entries exist', () => {
    const mem = new SummaryMemory();
    expect(mem.serialize()).toBe('');
    expect(mem.size()).toBe(0);
  });

  it('omits parenthesised target id when targetId is null', () => {
    const mem = new SummaryMemory();
    mem.add(entry(1, { targetId: null }));

    const serialized = mem.serialize();
    expect(serialized).toContain('- [ok] playbook_1 on /route-1 — summary 1');
    expect(serialized).not.toContain('(target-');
  });

  it('renders different statuses verbatim', () => {
    const mem = new SummaryMemory();
    mem.add(entry(1, { status: 'failed' }));
    mem.add(entry(2, { status: 'suspicious' }));

    const serialized = mem.serialize();
    expect(serialized).toContain('[failed]');
    expect(serialized).toContain('[suspicious]');
  });
});
