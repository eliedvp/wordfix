import { toJSONSchema, type ZodType } from 'zod';

type JsonSchema = Record<string, unknown>;

/**
 * Convertit un schéma zod en JSON Schema compatible avec le mode « strict » des
 * sorties structurées d'OpenAI : toutes les propriétés obligatoires (les valeurs
 * absentes sont `null`), aucune propriété supplémentaire, pas de mots-clés non
 * pris en charge. Les contraintes retirées (longueurs…) sont revérifiées par zod
 * à la réception.
 */
export function toStrictJsonSchema(schema: ZodType): JsonSchema {
  const raw = toJSONSchema(schema, { target: 'draft-7', io: 'output' }) as JsonSchema;
  delete raw.$schema;
  return strictify(raw);
}

const UNSUPPORTED_KEYWORDS = [
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
  'default',
];

function strictify(node: unknown): JsonSchema {
  if (Array.isArray(node)) return node.map(strictify) as unknown as JsonSchema;
  if (!node || typeof node !== 'object') return node as JsonSchema;

  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node as JsonSchema)) {
    if (UNSUPPORTED_KEYWORDS.includes(key)) continue;
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(value as JsonSchema).map(([name, child]) => [name, strictify(child)]),
      );
    } else if (value && typeof value === 'object') {
      out[key] = strictify(value);
    } else {
      out[key] = value;
    }
  }
  if (out.type === 'object' && out.properties) {
    out.required = Object.keys(out.properties);
    out.additionalProperties = false;
  }
  return out;
}
