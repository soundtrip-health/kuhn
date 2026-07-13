import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db/projects.js', () => ({ updateProjectConfig: vi.fn() }));
vi.mock('../storage.js', () => ({ writeProjectFile: vi.fn(async () => ({ created: true })) }));

import { updateProjectConfig } from '../db/projects.js';
import { writeProjectFile } from '../storage.js';
import { applyProjectConfig } from './project-config.js';

const CANONICAL = {
  title: 'GLP-1 RWE Study',
  project_type: 'rwe-protocol',
  research_question: 'Does GLP-1 use reduce MACE in T2D?',
  deliverables: ['FDA RWE protocol'],
  timeline: 'Draft by 2026-08-01',
  source_materials: ['seed_docs/protocol.pdf'],
};

beforeEach(() => {
  vi.clearAllMocks();
  updateProjectConfig.mockResolvedValue({ id: 1, config: { ...CANONICAL } });
});

describe('applyProjectConfig', () => {
  it('merges the canonical config, sets the type, and writes project.json', async () => {
    const { created } = await applyProjectConfig(1, CANONICAL);
    expect(created).toBe(true);
    expect(updateProjectConfig).toHaveBeenCalledWith(1, {
      projectType: 'rwe-protocol',
      config: CANONICAL,
    });
    expect(writeProjectFile).toHaveBeenCalledWith(
      1, 'project.json', JSON.stringify(CANONICAL, null, 2) + '\n',
    );
  });

  it('merges extraConfig into the DB blob but keeps it out of project.json', async () => {
    await applyProjectConfig(1, CANONICAL, { extraConfig: { setup: { status: 'complete' } } });
    expect(updateProjectConfig).toHaveBeenCalledWith(1, {
      projectType: 'rwe-protocol',
      config: { ...CANONICAL, setup: { status: 'complete' } },
    });
    const written = writeProjectFile.mock.calls[0][2];
    expect(written).not.toContain('setup');
  });
});
