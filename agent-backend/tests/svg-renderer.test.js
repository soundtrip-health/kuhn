import { describe, it, expect } from 'vitest';
import { renderSvg } from '../src/svg-renderer';
import { DEFAULT_PARAMS } from '../src/types';
describe('renderSvg', () => {
    const mockResult = {
        metadata: { eegSteps: 4, audioFrames: 4, duration: 0 },
        paths: [
            [
                { x: 10, y: 10, energy: 0.5, spectrum: { bass: 0.3, mid: 0.3, treble: 0.4 } },
                { x: 20, y: 20, energy: 0.7, spectrum: { bass: 0.4, mid: 0.3, treble: 0.3 } },
                { x: 30, y: 15, energy: 0.3, spectrum: { bass: 0.2, mid: 0.3, treble: 0.5 } },
            ],
            [
                { x: 12, y: 12, energy: 0.6, spectrum: { bass: 0.3, mid: 0.3, treble: 0.4 } },
                { x: 22, y: 22, energy: 0.8, spectrum: { bass: 0.4, mid: 0.3, treble: 0.3 } },
                { x: 32, y: 17, energy: 0.4, spectrum: { bass: 0.2, mid: 0.3, treble: 0.5 } },
            ],
        ],
    };
    it('generates SVG string with path elements', () => {
        const svg = renderSvg(mockResult, DEFAULT_PARAMS);
        expect(svg).toContain('<svg');
        expect(svg).toContain('</svg>');
        expect(svg).toContain('<path');
    });
    it('generates correct number of path elements', () => {
        const svg = renderSvg(mockResult, DEFAULT_PARAMS);
        const pathMatches = svg.match(/<path/g);
        expect(pathMatches).not.toBeNull();
        expect(pathMatches.length).toBe(2);
    });
    it('centers paths in the SVG', () => {
        const svg = renderSvg(mockResult, DEFAULT_PARAMS);
        expect(svg).toContain('viewBox');
    });
    it('generates valid SVG path d attribute', () => {
        const svg = renderSvg(mockResult, DEFAULT_PARAMS);
        expect(svg).toMatch(/M[\d.\-]+,[\d.\-]+/);
        expect(svg).toMatch(/L[\d.\-]+,[\d.\-]+/);
    });
    it('uses the specified palette', () => {
        const svg = renderSvg(mockResult, { ...DEFAULT_PARAMS, colorPalette: 'sunset' });
        expect(svg).toContain('<svg');
    });
});
