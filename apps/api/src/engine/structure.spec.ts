import { beforeAll, describe, expect, it } from 'vitest';
import { buildDocx } from '../../test/fixtures/builders.js';
import { parseDocx } from '../docx/parser/docx-parser.js';
import { loadSpellingDictionaries } from './language/spelling/dictionaries.js';
import { runRules } from './rules/rules.js';
import { summarizeStructure } from './structure.js';

async function modelOf(nodes: Parameters<typeof buildDocx>[0]) {
  return parseDocx(await buildDocx(nodes));
}

describe('résumé de structure (présence des éléments)', () => {
  // Pour comparer avec les règles : dictionnaire chargé une fois (≈ 5 s).
  beforeAll(() => loadSpellingDictionaries(), 60_000);

  it('document sans titre ni sommaire : tout à zéro', async () => {
    const structure = summarizeStructure(await modelOf([{ p: 'Un simple paragraphe.' }]));
    expect(structure).toMatchObject({
      headings: 0,
      inferredHeadings: 0,
      numberedHeadings: 0,
      comparedNumberedHeadings: 0,
      tocEntries: 0,
      comparableTocEntries: 0,
    });
    expect(['rendered_break', 'word_count']).toContain(structure.pageMethod);
  });

  it('titres stylés, numérotés à la main ou non', async () => {
    const structure = summarizeStructure(
      await modelOf([
        { h: 1, text: '1. Introduction' },
        { p: 'Texte.' },
        { h: 2, text: '1.1 Contexte' },
        { h: 1, text: 'Conclusion' },
      ]),
    );
    expect(structure).toMatchObject({
      headings: 3,
      inferredHeadings: 0,
      numberedHeadings: 2,
      // « 1. » puis « 1.1 » : niveaux différents, aucun numéro comparé à un précédent.
      comparedNumberedHeadings: 0,
    });
    expect(
      runRules(
        await modelOf([
          { h: 1, text: '1. Introduction' },
          { h: 2, text: '1.4 Contexte' },
        ]),
      ).filter((i) => i.subtype === 'heading_numbering'),
    ).toHaveLength(0);
  });

  it('sommaire Word : entrées comptées, titre « Sommaire » et entrées trop courtes exclues de la comparaison', async () => {
    const structure = summarizeStructure(
      await modelOf([
        { toc: 'Sommaire' },
        { toc: '1. Introduction\t3' },
        { toc: '2. Méthode\t5' },
        { toc: 'A' },
        { h: 1, text: '1. Introduction' },
        { h: 1, text: '2. Méthode' },
      ]),
    );
    expect(structure).toMatchObject({ tocEntries: 4, comparableTocEntries: 2, headings: 2 });
  });

  it('présence et conformité sont distinctes : sommaire présent et conforme, ou présent avec un écart', async () => {
    const conform = await modelOf([
      { toc: '1. Introduction\t3' },
      { h: 1, text: '1. Introduction' },
    ]);
    expect(summarizeStructure(conform).comparableTocEntries).toBe(1);
    expect(runRules(conform).filter((i) => i.subtype === 'toc_mismatch')).toHaveLength(0);

    const outdated = await modelOf([
      { toc: '1. Introduction\t3' },
      { toc: '2. Partie supprimée\t7' },
      { h: 1, text: '1. Introduction' },
    ]);
    expect(summarizeStructure(outdated).comparableTocEntries).toBe(2);
    expect(runRules(outdated).filter((i) => i.subtype === 'toc_mismatch')).toHaveLength(1);
  });

  it('les titres comptés comme numérotés sont exactement ceux que la règle contrôle', async () => {
    const model = await modelOf([
      { h: 1, text: '1. Introduction' },
      { h: 2, text: '1.1 Contexte' },
      { h: 2, text: '1.3 Objectifs' },
      { h: 1, text: 'Annexes' },
    ]);
    expect(summarizeStructure(model).numberedHeadings).toBe(3);
    // Seul « 1.3 » est comparé (à « 1.1 ») : c'est là que la règle relève le saut.
    expect(summarizeStructure(model).comparedNumberedHeadings).toBe(1);
    expect(runRules(model).filter((i) => i.subtype === 'heading_numbering')).toHaveLength(1);
  });

  it('numéros comparés : même suivi que la règle (réinitialisation par un niveau supérieur)', async () => {
    const model = await modelOf([
      { h: 1, text: '1. Introduction' },
      { h: 2, text: '1.1 Contexte' },
      { h: 2, text: '1.2 Enjeux' },
      { h: 1, text: '2. Méthode' },
      { h: 2, text: '2.1 Terrain' },
      { h: 1, text: '3. Résultats' },
    ]);
    // 1.2 (après 1.1), 2. (après 1.), 3. (après 2.) ; 1.1 et 2.1 ouvrent leur niveau.
    expect(summarizeStructure(model)).toMatchObject({
      numberedHeadings: 6,
      comparedNumberedHeadings: 3,
    });
    expect(runRules(model).filter((i) => i.subtype === 'heading_numbering')).toHaveLength(0);
  });

  it('titres déduits de leur apparence (sans style) : comptés à part', async () => {
    const model = await modelOf([
      { p: '1. Introduction', bold: true },
      { p: 'Un paragraphe de contenu assez long pour ne pas être pris pour un titre du document.' },
      { p: '2. Méthode', bold: true },
      { p: 'Un autre paragraphe de contenu assez long pour ne pas être pris pour un titre.' },
    ]);
    const structure = summarizeStructure(model);
    expect(model.meta.headingsInferred).toBe(true);
    expect(structure.inferredHeadings).toBe(2);
    expect(structure.headings).toBe(2);
    expect(structure.numberedHeadings).toBe(2);
  });
});
