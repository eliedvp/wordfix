import { describe, expect, it } from 'vitest';
import { anchorExcerpt } from './anchor.js';

describe('anchorExcerpt', () => {
  const text = 'L’entreprise dispose de plusieurs serveurs informatique et d’un « pare-feu ».';

  it('trouve un extrait exact et calcule sa position', () => {
    const anchor = anchorExcerpt(text, 'serveurs informatique');
    expect(anchor).toEqual({ start: 34, end: 55, text: 'serveurs informatique' });
  });

  it('tolère les apostrophes et guillemets droits du modèle', () => {
    const anchor = anchorExcerpt(text, "L'entreprise dispose");
    expect(anchor?.text).toBe('L’entreprise dispose');
    expect(anchorExcerpt(text, '"pare-feu"')?.text).toBe('« pare-feu »');
  });

  it('tolère les espaces multiples', () => {
    expect(anchorExcerpt('Deux  espaces ici.', 'Deux espaces')?.text).toBe('Deux  espaces');
  });

  it('rejette un extrait inventé', () => {
    expect(anchorExcerpt(text, 'serveurs informatiques modernes')).toBeNull();
    expect(anchorExcerpt(text, '   ')).toBeNull();
  });
});
