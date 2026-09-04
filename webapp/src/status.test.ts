// @vitest-environment jsdom
//
// Status-bar model chip (issue #107): what the routed-model indicator shows.
import { beforeEach, describe, expect, it } from 'vitest';
import { compactModel, setAgentModel } from './status';

beforeEach(() => {
  document.body.innerHTML = '<footer id="statusbar"><span id="status-model"></span></footer>';
});

describe('compactModel', () => {
  it('drops the claude- prefix and a date suffix, leaves other ids alone', () => {
    expect(compactModel('claude-sonnet-4-5-20250929')).toBe('sonnet-4-5');
    expect(compactModel('claude-opus-4-1')).toBe('opus-4-1');
    expect(compactModel('gpt-5.6-luna')).toBe('gpt-5.6-luna');
    expect(compactModel(null)).toBe('unknown model');
  });
});

describe('setAgentModel', () => {
  it('shows agent, model and difficulty, with the run history in the tooltip', () => {
    const pm = { agent: 'pm', label: 'PM', model: 'claude-opus-4-1', profile: 'opus', source: 'org' as const, difficulty: 1 };
    const ra = { agent: 'ra', label: 'RA', model: 'claude-haiku-4-5-20251001', profile: 'haiku', source: 'org' as const, difficulty: 0.3 };
    setAgentModel(ra, [pm, ra]);
    const node = document.getElementById('status-model')!;
    expect(node.textContent).toBe('RA · haiku-4-5 · d=0.3');
    expect(node.dataset.source).toBe('org');
    expect(node.title).toContain('PM: claude-opus-4-1 (profile opus), difficulty 1, org route');
    expect(node.title).toContain('RA: claude-haiku-4-5-20251001 (profile haiku), difficulty 0.3, org route');
  });

  it('omits difficulty for job-row seeds and marks the deployment default', () => {
    setAgentModel({ agent: 'writer', label: 'Writer', model: 'claude-sonnet-4-5', profile: 'deployment-default', source: 'deployment' });
    const node = document.getElementById('status-model')!;
    expect(node.textContent).toBe('Writer · sonnet-4-5');
    expect(node.dataset.source).toBe('deployment');
    expect(node.title).toContain('deployment default');
  });

  it('clears the chip', () => {
    setAgentModel({ agent: 'pm', label: 'PM', model: 'x', profile: null });
    setAgentModel(null);
    const node = document.getElementById('status-model')!;
    expect(node.textContent).toBe('');
    expect(node.hasAttribute('title')).toBe(false);
  });
});
