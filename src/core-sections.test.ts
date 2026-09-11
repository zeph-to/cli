import { describe, expect, it } from 'vitest';
import { coreSection } from './core-sections.js';

describe('coreSection', () => {
    const core = '### Alpha (Rule 1)\n\n1. one\n\n#### Sub\n\nsub text\n\n### Beta\n\n2. two\n';

    it('returns one section, heading included, up to the next ### heading', () => {
        expect(coreSection(core, 'Alpha')).toBe('### Alpha (Rule 1)\n\n1. one\n\n#### Sub\n\nsub text');
        expect(coreSection(core, 'Beta')).toBe('### Beta\n\n2. two');
    });

    it('matches the heading by title, not by the number the extractor appends', () => {
        expect(coreSection(core, 'Alpha (Rule 1)')).toContain('1. one');
    });

    it('throws on a heading the core does not carry', () => {
        expect(() => coreSection(core, 'Gamma')).toThrow(/Gamma/);
    });
});
