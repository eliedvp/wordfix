import { describe, expect, it } from 'vitest';
import { buildDocx, filler } from '../../../test/fixtures/builders.js';
import { parseDocx } from '../../docx/parser/docx-parser.js';
import { runRules } from './rules.js';

async function rulesFor(nodes: Parameters<typeof buildDocx>[0]) {
  return runRules(await parseDocx(await buildDocx(nodes)));
}

describe('règles déterministes', () => {
  it('repère les mots doublés, mais pas « nous nous »', async () => {
    const issues = await rulesFor([{ p: 'Le le projet a commencé. Nous nous sommes réunis.' }]);
    const repeated = issues.filter((i) => i.subtype === 'typo');
    expect(repeated).toHaveLength(1);
    expect(repeated[0]).toMatchObject({ original: 'Le le', suggestion: 'Le', confidence: 'high' });
  });

  it('repère les espaces doubles', async () => {
    const issues = await rulesFor([{ p: 'Un texte  avec deux espaces.' }]);
    expect(issues.find((i) => i.subtype === 'spacing')?.range).toEqual({ start: 8, end: 10 });
  });

  it('signale les phrases de plus de 45 mots', async () => {
    const issues = await rulesFor([{ p: filler(60) }, { p: filler(20) }]);
    expect(issues.filter((i) => i.subtype === 'too_long')).toHaveLength(1);
  });

  it('détecte un saut dans la numérotation des titres', async () => {
    const issues = await rulesFor([
      { h: 1, text: '1. Introduction' },
      { h: 2, text: '1.1 Contexte' },
      { h: 2, text: '1.3 Objectifs' },
      { h: 1, text: '2. Méthode' },
      { h: 2, text: '2.1 Démarche' },
    ]);
    const numbering = issues.filter((i) => i.subtype === 'heading_numbering');
    expect(numbering).toHaveLength(1);
    expect(numbering[0]?.explanation).toContain('1.2');
  });

  it('signale un sigle utilisé sans définition', async () => {
    const issues = await rulesFor([
      { p: 'Le SIRH est central. Le SIRH sera migré.' },
      { p: 'Le système d’information (SI) est ancien. Le SI sera remplacé.' },
    ]);
    const acronyms = issues.filter((i) => i.subtype === 'acronym').map((i) => i.original);
    expect(acronyms).toEqual(['SIRH']);
  });

  it('repère deux graphies d’un même terme', async () => {
    const issues = await rulesFor([
      { p: 'Envoyez un email au client.' },
      { p: 'Un deuxième email suit.' },
      { p: 'Le e-mail est archivé.' },
    ]);
    const variant = issues.find((i) => i.subtype === 'terminology_variant');
    expect(variant).toMatchObject({ original: 'e-mail', suggestion: 'email' });
    expect(variant?.relatedBlockIds).toHaveLength(1);
  });
});
