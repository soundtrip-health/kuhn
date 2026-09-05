// Platform-level pre-configured models (issue #138): parsing and validation
// of KUHN_PLATFORM_MODELS — inline JSON or a file — with field-level errors.
import { describe, expect, it } from 'vitest';
import { PlatformModelsError, parsePlatformModels } from './platform-models.js';

const PROVIDERS = ['anthropic', 'openai', 'openrouter', 'google', 'openai-compatible'];
const parse = (value, readFile) => parsePlatformModels(typeof value === 'string' ? value : JSON.stringify(value), { providers: PROVIDERS, readFile });

describe('parsePlatformModels', () => {
  it('returns [] for an unset variable and normalizes a full entry', () => {
    expect(parse('')).toEqual([]);
    expect(parse('   ')).toEqual([]);
    const [entry] = parse([{
      slug: 'local-qwen', name: ' Qwen on vLLM ', provider: 'OpenAI-Compatible', model_id: 'Qwen3-27B',
      base_url: 'http://vllm.lan:8000/v1/', api_key_env: 'LOCAL_LLM_API_KEY',
      capabilities: { contextWindow: 32768, maxTokens: 8192, reasoning: false, tools: true, input: ['text', 'text'] },
      cost_weight: 0.5, data_policy: ' on-prem ', routes: { ra: 0.5, '*': 0.2 },
    }]);
    expect(entry).toEqual({
      slug: 'local-qwen', name: 'Qwen on vLLM', provider: 'openai-compatible', model_id: 'Qwen3-27B',
      base_url: 'http://vllm.lan:8000/v1', api_key_env: 'LOCAL_LLM_API_KEY',
      capabilities: { contextWindow: 32768, maxTokens: 8192, reasoning: false, tools: true, input: ['text'] },
      cost_weight: 0.5, data_policy: 'on-prem', routes: { ra: 0.5, '*': 0.2 },
    });
  });

  it('fills defaults: name from the model id, no key, catalog cost weight, no routes', () => {
    const [entry] = parse([{ slug: 'gem', provider: 'google', model_id: 'gemini-2.5-flash' }]);
    expect(entry).toEqual({
      slug: 'gem', name: 'gemini-2.5-flash (platform)', provider: 'google', model_id: 'gemini-2.5-flash',
      base_url: null, api_key_env: null, capabilities: {}, cost_weight: null, data_policy: null, routes: {},
    });
  });

  it('reads a file when the value is a path', () => {
    const files = { '/etc/kuhn/models.json': JSON.stringify([{ slug: 'a', provider: 'openai', model_id: 'gpt-5-mini' }]) };
    expect(parse('/etc/kuhn/models.json', (p) => files[p] ?? (() => { throw new Error('ENOENT'); })())).toHaveLength(1);
    expect(() => parse('/etc/kuhn/missing.json', () => { throw new Error('ENOENT'); })).toThrow(/cannot read \/etc\/kuhn\/missing.json: ENOENT/);
  });

  it.each([
    ['{"slug":"x"}', /must be a JSON array/],
    ['[nope', /not valid JSON/],
    [[null], /entry 0: must be an object/],
    [[{ slug: 'Bad Slug', provider: 'openai', model_id: 'm' }], /entry 0 \(slug\)/],
    [[{ slug: 'pi-preview', provider: 'openai', model_id: 'm' }], /reserved/],
    [[{ slug: 'a', provider: 'openai', model_id: 'm' }, { slug: 'a', provider: 'openai', model_id: 'm' }], /listed twice/],
    [[{ slug: 'a', provider: 'vertex', model_id: 'm' }], /entry 0 \(provider\): must be one of/],
    [[{ slug: 'a', provider: 'openai', model_id: 'has space' }], /entry 0 \(model_id\)/],
    [[{ slug: 'a', provider: 'openai-compatible', model_id: 'm' }], /base_url\): is required/],
    [[{ slug: 'a', provider: 'openai-compatible', model_id: 'm', base_url: 'ftp://x/v1' }], /must use http or https/],
    [[{ slug: 'a', provider: 'openai-compatible', model_id: 'm', base_url: 'http://u:p@x/v1' }], /credentials/],
    [[{ slug: 'a', provider: 'openai', model_id: 'm', base_url: 'https://x/v1' }], /only allowed for openai-compatible/],
    [[{ slug: 'a', provider: 'openai', model_id: 'm', api_key_env: 'sk-live-value' }], /environment variable NAME/],
    [[{ slug: 'a', provider: 'openai', model_id: 'm', cost_weight: 0 }], /cost_weight/],
    [[{ slug: 'a', provider: 'openai', model_id: 'm', capabilities: { contextWindow: 10 } }], /capabilities.contextWindow/],
    [[{ slug: 'a', provider: 'openai', model_id: 'm', capabilities: { vision: true } }], /unknown capability/],
    [[{ slug: 'a', provider: 'openai', model_id: 'm', routes: { ra: 2 } }], /routes.ra\): difficulty ceiling/],
    [[{ slug: 'a', provider: 'openai', model_id: 'm', routes: ['ra'] }], /routes\): must be an object/],
  ])('rejects %j with a field-level error', (value, pattern) => {
    expect(() => parse(value)).toThrow(PlatformModelsError);
    expect(() => parse(value)).toThrow(pattern);
    expect(() => parse(value)).toThrow(/^KUHN_PLATFORM_MODELS:/);
  });
});
