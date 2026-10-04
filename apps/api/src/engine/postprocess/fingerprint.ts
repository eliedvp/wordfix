import { createHash } from 'node:crypto';

/** Empreinte stable d'un problème : un même problème n'est enregistré qu'une fois. */
export function fingerprint(parts: {
  category: string;
  subtype: string;
  blockId: string;
  start: number;
  end: number;
}): string {
  return createHash('sha1')
    .update([parts.category, parts.subtype, parts.blockId, parts.start, parts.end].join('|'))
    .digest('hex');
}
