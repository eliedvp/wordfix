import { describe, expect, it } from 'vitest';
import { isId, newId } from './ids.js';

describe('newId', () => {
  it('produit un identifiant préfixé de 20 caractères en minuscules', () => {
    const id = newId('doc');
    expect(id).toMatch(/^doc_[0-9a-z]{20}$/);
    expect(isId('doc', id)).toBe(true);
  });

  it('ne produit pas de doublon sur 10 000 tirages', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newId('iss')));
    expect(ids.size).toBe(10_000);
  });

  it('refuse un identifiant d’un autre type ou mal formé', () => {
    expect(isId('ana', newId('doc'))).toBe(false);
    expect(isId('doc', 'doc_../../etc/passwd')).toBe(false);
    expect(isId('doc', 42)).toBe(false);
  });
});
