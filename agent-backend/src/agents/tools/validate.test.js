// Neutral argument validation vs the Claude-side Zod compilation (STH-1).
//
// Both sides enforce the same JSON Schema subset with the same
// accept/reject verdicts: validateArgs (the provider-neutral path, used by
// neutral tests and by adapters without a native schema compiler) and
// jsonSchemaToShape (the Claude adapter's ZodRawShape, validated by the
// SDK natively). If the two drift, a tool behaves differently depending on
// which adapter runs it — this table pins the shared contract.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { validateArgs } from './validate.js';
import { jsonSchemaToShape } from '../provider-runtime/claude-tools.js';

// [schema, args, expectOk] — a case passes when both validators agree on the
// verdict and, for accepted input, on the normalized value (defaults
// applied, unknown keys stripped).
const cases = [
  // Object basics: required present / missing
  [
    { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    { path: 'draft/main.md', content: 'hello' },
    true,
  ],
  [
    { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    { path: 'draft/main.md' },
    false,
  ],
  // Defaults applied to absent keys
  [
    { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 25, default: 8 } }, required: ['query'] },
    { query: 'heart failure' },
    true,
  ],
  // Unknown keys stripped (zod parity)
  [
    { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    { query: 'x', surprise: 1, other: ['a'] },
    true,
  ],
  // Wrong types: string where integer expected (no coercion, zod parity)
  [
    { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 25 } }, required: [] },
    { limit: '8' },
    false,
  ],
  [
    { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 25 } }, required: [] },
    { limit: 7.5 },
    false,
  ],
  // Range bounds
  [
    { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 25 } }, required: ['limit'] },
    { limit: 0 },
    false,
  ],
  [
    { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 25 } }, required: ['limit'] },
    { limit: 25 },
    true,
  ],
  // Null where a type is expected
  [
    { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    { path: null },
    false,
  ],
  // String constraints: minLength and pattern
  [
    { type: 'object', properties: { path: { type: 'string', minLength: 1 } }, required: ['path'] },
    { path: '' },
    false,
  ],
  [
    { type: 'object', properties: { args: { type: 'string', pattern: '^(\\s*,?\\s*[\\w.$@#-]+\\s*=\\s*.+?)+$' } }, required: [] },
    { args: 'a=1, b="x y"' },
    true,
  ],
  [
    { type: 'object', properties: { args: { type: 'string', pattern: '^\\d+$' } }, required: ['args'] },
    { args: 'abc' },
    false,
  ],
  // Enum
  [
    { type: 'object', properties: { source_type: { enum: ['crossref', 'arxiv', 'manual'] } }, required: [] },
    { source_type: 'crossref' },
    true,
  ],
  [
    { type: 'object', properties: { source_type: { enum: ['crossref', 'arxiv', 'manual'] } }, required: [] },
    { source_type: 'bogus' },
    false,
  ],
  // Boolean
  [
    { type: 'object', properties: { replace_all: { type: 'boolean', default: false } }, required: [] },
    {},
    true,
  ],
  [
    { type: 'object', properties: { replace_all: { type: 'boolean' } }, required: [] },
    { replace_all: 'yes' },
    false,
  ],
  // Array items
  [
    { type: 'object', properties: { cite_keys: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['cite_keys'] },
    { cite_keys: ['a'] },
    true,
  ],
  [
    { type: 'object', properties: { cite_keys: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['cite_keys'] },
    { cite_keys: [] },
    false,
  ],
  [
    { type: 'object', properties: { cite_keys: { type: 'array', items: { type: 'string' } } }, required: ['cite_keys'] },
    { cite_keys: [1, 2] },
    false,
  ],
  // Non-object arguments
  [
    { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    'not an object',
    false,
  ],
];

describe('validateArgs / jsonSchemaToShape parity (STH-1)', () => {
  for (const [schema, args, expectOk] of cases) {
    it(`args ${JSON.stringify(args)} vs schema ${JSON.stringify(schema.properties ?? schema)} -> ${expectOk ? 'ok' : 'fail'}`, () => {
      const neutral = validateArgs(schema, args);
      const zodShape = jsonSchemaToShape(schema);
      const parsed = z.object(zodShape).safeParse(args ?? undefined);

      expect(neutral.ok, `neutral said ${JSON.stringify(neutral)}`).toBe(expectOk);
      expect(parsed.success).toBe(expectOk);
      if (expectOk) {
        // Same normalized value: defaults applied, unknown keys stripped.
        expect(neutral.value).toEqual(parsed.data);
      }
    });
  }

  it('reports which properties failed on the neutral side', () => {
    const schema = {
      type: 'object',
      properties: {
        path: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
      required: ['path', 'limit'],
    };
    const neutral = validateArgs(schema, { limit: 'x' });
    expect(neutral.ok).toBe(false);
    expect(neutral.errors.join(' ')).toMatch(/path/);
    expect(neutral.errors.join(' ')).toMatch(/limit/);
  });

  it('clones default values so callers cannot mutate the descriptor', () => {
    const schema = {
      type: 'object',
      properties: { cite_keys: { type: 'array', items: { type: 'string' }, default: ['a', 'b'] } },
      required: [],
    };
    const first = validateArgs(schema, {}).value;
    first.cite_keys.push('c');
    expect(validateArgs(schema, {}).value.cite_keys).toEqual(['a', 'b']);
  });
});
