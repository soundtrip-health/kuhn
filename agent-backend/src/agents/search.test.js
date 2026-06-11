import { describe, it, expect } from 'vitest';
import { parseArxivFeed } from './search.js';

const SAMPLE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ArXiv Query Results</title>
  <entry>
    <id>http://arxiv.org/abs/2401.01234v1</id>
    <published>2024-01-02T00:00:00Z</published>
    <title>Target Trial Emulation &amp; Real-World
      Evidence</title>
    <summary>A study of TTE methods
      in observational data.</summary>
    <author><name>Jane Doe</name></author>
    <author><name>Richard Roe</name></author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2402.05678v2</id>
    <published>2024-02-10T00:00:00Z</published>
    <title>Second Paper</title>
    <summary>Another abstract.</summary>
    <author><name>Alice Smith</name></author>
  </entry>
</feed>`;

describe('parseArxivFeed', () => {
  it('extracts entries with decoded text and normalized whitespace', () => {
    const results = parseArxivFeed(SAMPLE_FEED);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      id: '2401.01234v1',
      title: 'Target Trial Emulation & Real-World Evidence',
      authors: ['Jane Doe', 'Richard Roe'],
      summary: 'A study of TTE methods in observational data.',
      published: '2024-01-02T00:00:00Z',
      url: 'http://arxiv.org/abs/2401.01234v1',
    });
    expect(results[1].authors).toEqual(['Alice Smith']);
  });

  it('returns an empty array for a feed with no entries', () => {
    expect(parseArxivFeed('<feed><title>empty</title></feed>')).toEqual([]);
  });
});
