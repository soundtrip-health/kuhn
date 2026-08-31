/**
 * Provider-neutral argument validation (STH-1).
 *
 * Kuhn tool descriptors carry JSON Schema parameters (the model-facing
 * contract, owned by Kuhn). This module validates and normalizes arguments
 * against that schema on the provider-neutral side of the seam — it is what
 * neutral tests and adapters without a native schema compiler (e.g. Pi,
 * STH-8) use. The Claude adapter compiles the same schemas to Zod instead,
 * because the Claude Agent SDK validates natively; both paths enforce the
 * same subset and the same accept/reject verdicts (asserted in
 * validate.test.js), so a tool behaves identically whichever adapter runs.
 *
 * Supported subset (exactly what Kuhn's tool schemas use):
 * - object: properties, required; unknown keys are stripped (zod parity)
 * - string: minLength, pattern (+ patternMessage)
 * - number / integer: minimum, maximum (integer rejects non-integers)
 * - boolean
 * - array: items, minItems, maxItems
 * - enum
 * - default: applied to absent keys (freshly cloned)
 *
 * There is no type coercion — a string where a number is expected fails,
 * matching zod's non-coercing behavior.
 *
 * @typedef {object} ValidateOk
 * @property {true} ok
 * @property {object} value - arguments with defaults applied, unknown keys stripped
 *
 * @typedef {object} ValidateFail
 * @property {false} ok
 * @property {string[]} errors
 *
 * @param {object} parameters - JSON Schema object (the descriptor's `parameters`)
 * @param {unknown} args - raw model-supplied arguments
 * @returns {ValidateOk | ValidateFail}
 */
export function validateArgs(parameters, args) {
  if (args == null || typeof args !== 'object' || Array.isArray(args)) {
    return { ok: false, errors: ['arguments must be an object'] };
  }
  const errors = [];
  const props = parameters?.properties ?? {};
  const required = new Set(parameters?.required ?? []);
  const value = {};

  for (const [key, schema] of Object.entries(props)) {
    const raw = args[key];
    if (raw === undefined) {
      if (required.has(key)) {
        errors.push(`${key} is required`);
      } else if (schema?.default !== undefined) {
        value[key] = structuredClone(schema.default);
      }
      continue;
    }
    if (raw === null) {
      errors.push(`${key} must not be null`);
      continue;
    }
    checkValue(schema, raw, key, errors);
    value[key] = raw;
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

function checkValue(schema, value, path, errors) {
  const label = path || 'arguments';
  if (schema?.enum) {
    if (!schema.enum.includes(value)) {
      errors.push(`${label} must be one of: ${schema.enum.map((v) => `"${v}"`).join(', ')}`);
    }
    return;
  }
  switch (schema?.type) {
    case 'string': {
      if (typeof value !== 'string') {
        errors.push(`${label} must be a string`);
        return;
      }
      if (schema.minLength != null && value.length < schema.minLength) {
        errors.push(`${label} must be at least ${schema.minLength} character(s)`);
      }
      if (schema.pattern != null && !new RegExp(schema.pattern).test(value)) {
        errors.push(schema.patternMessage ?? `${label} does not match the allowed pattern`);
      }
      break;
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`${label} must be a ${schema.type === 'integer' ? 'integer' : 'number'}`);
        return;
      }
      if (schema.type === 'integer' && !Number.isInteger(value)) {
        errors.push(`${label} must be an integer`);
        return;
      }
      if (schema.minimum != null && value < schema.minimum) {
        errors.push(`${label} must be >= ${schema.minimum}`);
      }
      if (schema.maximum != null && value > schema.maximum) {
        errors.push(`${label} must be <= ${schema.maximum}`);
      }
      break;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        errors.push(`${label} must be a boolean`);
      }
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) {
        errors.push(`${label} must be an array`);
        return;
      }
      if (schema.minItems != null && value.length < schema.minItems) {
        errors.push(`${label} must have at least ${schema.minItems} item(s)`);
      }
      if (schema.maxItems != null && value.length > schema.maxItems) {
        errors.push(`${label} must have at most ${schema.maxItems} item(s)`);
      }
      if (schema.items) {
        value.forEach((item, i) => checkValue(schema.items, item, `${label}[${i}]`, errors));
      }
      break;
    }
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        errors.push(`${label} must be an object`);
        return;
      }
      const subProps = schema.properties ?? {};
      const subRequired = new Set(schema.required ?? []);
      for (const [key, sub] of Object.entries(subProps)) {
        const item = value[key];
        if (item === undefined) {
          if (subRequired.has(key)) errors.push(`${label}.${key} is required`);
          continue;
        }
        if (item === null) {
          errors.push(`${label}.${key} must not be null`);
          continue;
        }
        checkValue(sub, item, `${label}.${key}`, errors);
      }
      break;
    }
    default:
      // No type constraint in the subset — accept anything non-null.
      break;
  }
}
