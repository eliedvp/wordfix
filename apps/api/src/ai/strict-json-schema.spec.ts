import { describe, expect, it } from 'vitest';
import { contextReviewSchema, localReviewSchema } from '../engine/schemas.js';
import { toStrictJsonSchema } from './strict-json-schema.js';

function walk(node: unknown, visit: (obj: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) node.forEach((child) => walk(child, visit));
  else if (node && typeof node === 'object') {
    visit(node as Record<string, unknown>);
    Object.values(node).forEach((child) => walk(child, visit));
  }
}

describe('toStrictJsonSchema', () => {
  it.each([
    ['local', localReviewSchema],
    ['context', contextReviewSchema],
  ])('produit un schéma strict compatible (%s)', (_name, schema) => {
    const json = toStrictJsonSchema(schema);
    expect(json.type).toBe('object');
    walk(json, (obj) => {
      if (obj.type === 'object' && obj.properties) {
        expect(obj.additionalProperties).toBe(false);
        expect(obj.required).toEqual(Object.keys(obj.properties));
      }
      for (const forbidden of ['maxLength', 'minLength', 'maxItems', 'pattern', 'default']) {
        expect(obj).not.toHaveProperty(forbidden);
      }
    });
  });
});
