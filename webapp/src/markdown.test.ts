// @vitest-environment jsdom
//
// Issue #108: user-authored Markdown (org promotion preview, chat replies)
// must never reach the app DOM with active content. These tests exercise the
// one renderer every `marked` sink goes through.

import { describe, expect, it } from 'vitest';

import { escapeHtml, renderInlineMarkdown, renderMarkdown } from './markdown';

/** Parse rendered HTML into a detached element for structural assertions. */
function dom(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('renderMarkdown — hostile input', () => {
  it('strips event handlers from otherwise-allowed elements', () => {
    const out = renderMarkdown('<img src="x" onerror="alert(1)"> <a href="/p" onclick="alert(2)">l</a>');
    expect(out).not.toMatch(/onerror|onclick|alert/);
    expect(dom(out).querySelector('img')?.getAttribute('src')).toBe('x');
    expect(dom(out).querySelector('a')?.getAttribute('href')).toBe('/p');
  });

  it('removes script-capable elements and their contents', () => {
    const out = renderMarkdown([
      '<script>alert(1)</script>',
      '<iframe src="https://evil.example"></iframe>',
      '<object data="x.swf"></object><embed src="x.swf">',
      '<style>body{display:none}</style>',
      '<form action="https://evil.example"><button>go</button></form>',
      '<template><img src=x onerror=alert(1)></template>',
    ].join('\n\n'));
    for (const tag of ['script', 'iframe', 'object', 'embed', 'style', 'form', 'button', 'template']) {
      expect(dom(out).querySelector(tag), tag).toBeNull();
    }
    expect(out).not.toContain('alert');
    expect(out).not.toContain('display:none');
  });

  it('drops javascript:, data: and vbscript: URLs from links and images', () => {
    const out = renderMarkdown([
      '[a](javascript:alert(1))',
      '[b](JaVaScRiPt:alert(1))',
      '[c](data:text/html;base64,PHNjcmlwdD4=)',
      '[d](vbscript:msgbox)',
      '![e](javascript:alert(1))',
      '<a href="&#106;avascript:alert(1)">f</a>',
    ].join('\n\n'));
    for (const a of dom(out).querySelectorAll('a, img')) {
      expect(a.hasAttribute('href')).toBe(false);
      expect(a.hasAttribute('src')).toBe(false);
    }
    expect(out).not.toMatch(/javascript:|data:|vbscript:/i);
  });

  it('removes active SVG and MathML entirely', () => {
    const out = renderMarkdown('<svg onload="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)"><text>x</text></a></svg><math><mi>y</mi></math>');
    expect(dom(out).querySelector('svg, math')).toBeNull();
    expect(out).not.toContain('alert');
  });

  it('drops style, id, name and data-/aria- attributes', () => {
    const out = renderMarkdown('<p id="x" name="n" style="position:fixed" data-k="v" aria-label="z" class="c">t</p>');
    const p = dom(out).querySelector('p')!;
    expect(p.getAttributeNames().sort()).toEqual(['class']);
  });

  it('allows only disabled checkboxes, never other inputs', () => {
    const out = renderMarkdown('- [x] done\n\n<input type="text" name="pw" autofocus onfocus="alert(1)"><input type="checkbox" onclick="alert(2)">');
    const inputs = [...dom(out).querySelectorAll('input')];
    expect(inputs.length).toBe(2);
    for (const i of inputs) {
      expect(i.getAttribute('type')).toBe('checkbox');
      expect(i.hasAttribute('disabled')).toBe(true);
      expect(i.getAttributeNames()).not.toContain('onclick');
    }
    expect(out).not.toContain('alert');
  });

  it('handles the classic stored-XSS payloads without executing markup', () => {
    const payloads = [
      '"><img src=x onerror=alert(1)>',
      '<a href="javascript:alert(1)">x</a>',
      '<details open ontoggle=alert(1)>',
      '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
      '<svg><animate onbegin=alert(1) attributeName=x dur=1s>',
    ];
    for (const p of payloads) {
      const out = renderMarkdown(p);
      expect(out, p).not.toMatch(/on[a-z]+\s*=|javascript:|alert/i);
    }
  });
});

describe('renderMarkdown — ordinary scientific Markdown', () => {
  it('keeps headings, emphasis, lists, blockquotes and code', () => {
    const out = dom(renderMarkdown('# T\n\n**b** _i_ ~~d~~ `c`\n\n> q\n\n- a\n- b\n\n1. x\n\n```r\nx <- 1\n```\n\n---'));
    expect(out.querySelector('h1')?.textContent).toBe('T');
    expect(out.querySelector('strong')?.textContent).toBe('b');
    expect(out.querySelector('em')?.textContent).toBe('i');
    expect(out.querySelector('del')?.textContent).toBe('d');
    expect(out.querySelector('blockquote')).not.toBeNull();
    expect(out.querySelectorAll('ul li').length).toBe(2);
    expect(out.querySelector('ol li')?.textContent).toBe('x');
    expect(out.querySelector('pre code')?.getAttribute('class')).toBe('language-r');
    expect(out.querySelector('pre code')?.textContent).toBe('x <- 1\n');
    expect(out.querySelector('hr')).not.toBeNull();
  });

  it('keeps GFM tables with column alignment', () => {
    const out = dom(renderMarkdown('| a | b |\n|:--|--:|\n| 1 | 2 |'));
    expect(out.querySelector('table thead th')?.getAttribute('align')).toBe('left');
    expect(out.querySelectorAll('tbody td')[1]?.getAttribute('align')).toBe('right');
  });

  it('keeps http(s), mailto and relative links, opened safely in a new tab', () => {
    const out = dom(renderMarkdown('[a](https://doi.org/10.1000/x "DOI") [b](mailto:pi@lab.example) [c](../fig.md) [d](#sec)'));
    const hrefs = [...out.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['https://doi.org/10.1000/x', 'mailto:pi@lab.example', '../fig.md', '#sec']);
    for (const a of out.querySelectorAll('a')) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    }
    expect(out.querySelector('a')?.getAttribute('title')).toBe('DOI');
  });

  it('keeps images with src, alt and title', () => {
    const img = dom(renderMarkdown('![Figure 1](figures/f1.png "Fig")')).querySelector('img')!;
    expect(img.getAttribute('src')).toBe('figures/f1.png');
    expect(img.getAttribute('alt')).toBe('Figure 1');
    expect(img.getAttribute('title')).toBe('Fig');
  });

  it('keeps inline sub/sup HTML that scientific prose uses', () => {
    const out = dom(renderMarkdown('H<sub>2</sub>O and x<sup>2</sup>'));
    expect(out.querySelector('sub')?.textContent).toBe('2');
    expect(out.querySelector('sup')?.textContent).toBe('2');
  });

  it('escapes literal angle brackets in code spans', () => {
    const out = renderMarkdown('use `<script>` carefully');
    expect(out).toContain('&lt;script&gt;');
    expect(dom(out).querySelector('script')).toBeNull();
  });

  it('tolerates empty input', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderInlineMarkdown('')).toBe('');
  });
});

describe('renderInlineMarkdown', () => {
  it('renders inline formatting without a wrapping paragraph', () => {
    const out = renderInlineMarkdown('**bold** and [l](https://x.example)');
    expect(out).not.toContain('<p>');
    expect(dom(out).querySelector('strong')?.textContent).toBe('bold');
    expect(dom(out).querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('sanitizes inline payloads too', () => {
    const out = renderInlineMarkdown('note <img src=x onerror=alert(1)> [x](javascript:alert(2))');
    expect(out).not.toMatch(/onerror|javascript:|alert/);
  });
});

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
});
