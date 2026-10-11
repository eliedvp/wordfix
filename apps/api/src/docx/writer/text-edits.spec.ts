import type { Block } from '@wordfix/shared';
import { describe, expect, it } from 'vitest';
import { buildDocx, patchDocx } from '../../../test/fixtures/builders.js';
import { parseDocx } from '../parser/docx-parser.js';
import { walkPart } from '../parser/parts.js';
import { childByTag, childrenOf, parseXml, tagOf, textOf } from '../parser/xml.js';
import { SafeZip } from '../zip-reader.js';
import { applyTextEdits, MAX_REPLACEMENT_LENGTH, type TextEdit } from './text-edits.js';
import { XmlRewriteError } from './xml-writer.js';

/**
 * T2 : remplacements ciblés. Chaque règle d'application ou de refus est vérifiée sur
 * un paragraphe XML construit à la main, inséré dans un document de test.
 */

const MARK = /<w:p>(?:(?!<w:p>).)*MARQUEUR(?:(?!<\/w:p>).)*<\/w:p>/s;
const r = (text: string, rPr = '') =>
  `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const p = (...inline: string[]) => `<w:p>${inline.join('')}</w:p>`;

/** Document : un paragraphe d'avant, les paragraphes XML donnés, un paragraphe d'après. */
async function docWith(...paragraphs: string[]): Promise<Buffer> {
  const base = await buildDocx(
    [
      { p: 'Paragraphe avant.', footnote: 'Une note avec une fote.' },
      { p: 'MARQUEUR' },
      { table: [['Cellule avec une fote']] },
      { p: 'Paragraphe après.' },
    ],
    { header: 'En-tête avec une fote', footer: 'Pied de page' },
  );
  return patchDocx(base, async (zip) => {
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file('word/document.xml', xml.replace(MARK, paragraphs.join('')));
  });
}

/** Correction du passage `original` (n-ième occurrence) dans le bloc dont le texte contient `where`. */
function edit(
  blocks: Block[],
  where: string,
  original: string,
  replacement: string,
  id = `${where}:${original}`,
  occurrence = 0,
): TextEdit {
  const block = blocks.find((b) => b.text.includes(where));
  if (!block) throw new Error(`bloc introuvable : ${where}`);
  let start = -1;
  for (let i = 0; i <= occurrence; i++) start = block.text.indexOf(original, start + 1);
  if (start < 0) throw new Error(`passage introuvable : ${original}`);
  return {
    id,
    blockId: block.id,
    start,
    end: start + original.length,
    expectedBlockText: block.text,
    expectedOriginal: original,
    replacement,
  };
}

/** Insertion de `text` à la position `at` du bloc dont le texte vaut exactement `blockText`. */
function insertion(blocks: Block[], blockText: string, at: number, text: string): TextEdit {
  const block = blocks.find((b) => b.text === blockText);
  if (!block) throw new Error(`bloc introuvable : ${blockText}`);
  return {
    id: 'insertion',
    blockId: block.id,
    start: at,
    end: at,
    expectedBlockText: block.text,
    expectedOriginal: '',
    replacement: text,
  };
}

/** Runs du paragraphe du corps dont le texte vaut `text` : mise en forme (w:rPr) et texte. */
async function runsOf(buffer: Buffer, text: string): Promise<{ format: string; text: string }[]> {
  const tree = parseXml(await documentXml(buffer), 'word/document.xml');
  const paragraph = walkPart('word/document.xml', 'body', tree).paragraphs.find(
    (candidate) => candidate.text === text,
  );
  if (!paragraph) throw new Error(`paragraphe introuvable : ${text}`);
  return paragraph.xml.runs.map((run) => {
    const rPr = childByTag(run, 'w:rPr');
    const t = childByTag(run, 'w:t');
    return {
      format: rPr
        ? childrenOf(rPr)
            .map((child) => `<${tagOf(child)}/>`)
            .join('')
        : '',
      text: t ? childrenOf(t).map(textOf).join('') : '',
    };
  });
}

async function texts(buffer: Buffer): Promise<string[]> {
  return (await parseDocx(buffer)).blocks.map((b) => b.text);
}

async function documentXml(buffer: Buffer): Promise<string> {
  const zip = await SafeZip.open(buffer);
  try {
    return await zip.readText('word/document.xml', 30 * 1024 * 1024);
  } finally {
    zip.close();
  }
}

describe('applyTextEdits : application', () => {
  it('aucune correction : fichier d’origine, rien n’est lu ni réécrit', async () => {
    const source = await docWith(p(r('Texte.')));
    const result = await applyTextEdits(source, []);
    expect(result).toEqual({ buffer: source, changed: false, applied: [], skipped: [] });
  });

  it('remplace le passage dans un run ; l’original reste intact ; le reste est inchangé', async () => {
    const source = await docWith(p(r('Une phrase avec une erreurr ici.')));
    const copy = Buffer.from(source);
    const model = await parseDocx(source);
    const result = await applyTextEdits(source, [
      edit(model.blocks, 'erreurr', 'erreurr', 'erreur', 'e1'),
    ]);
    expect(result.changed).toBe(true);
    expect(result.applied).toEqual(['e1']);
    expect(result.skipped).toEqual([]);
    expect(source.equals(copy)).toBe(true);
    expect(await texts(result.buffer)).toEqual(
      model.blocks.map((b) => b.text.replace('erreurr ici', 'erreur ici')),
    );
  });

  it('plusieurs corrections : même paragraphe, tableau, note, en-tête', async () => {
    const source = await docWith(p(r('Un mott et un autre mott.')));
    const { blocks } = await parseDocx(source);
    const result = await applyTextEdits(source, [
      edit(blocks, 'Un mott', 'mott', 'mot', 'a'),
      edit(blocks, 'Un mott', 'mott', 'mot', 'b', 1),
      edit(blocks, 'Cellule', 'fote', 'faute', 'cellule'),
      edit(blocks, 'Une note', 'fote', 'faute', 'note'),
      edit(blocks, 'En-tête', 'fote', 'faute', 'entete'),
    ]);
    expect(result.applied.sort()).toEqual(['a', 'b', 'cellule', 'entete', 'note']);
    const after = await texts(result.buffer);
    expect(after).toContain('Un mot et un autre mot.');
    expect(after).toContain('Cellule avec une faute');
    expect(after).toContain('Une note avec une faute.');
    expect(after).toContain('En-tête avec une faute');
  });

  it('plusieurs runs voisins de même mise en forme : appliqué, sans créer ni supprimer de run', async () => {
    const bold = '<w:b/>';
    const source = await docWith(p(r('Le ', bold), r('pro', bold), r('jet est prêt.', bold)));
    const { blocks } = await parseDocx(source);
    const ok = await applyTextEdits(source, [
      edit(blocks, 'Le projet', 'projet est', 'travail est'),
    ]);
    expect(ok.applied).toHaveLength(1);
    expect(await texts(ok.buffer)).toContain('Le travail est prêt.');
    const xml = await documentXml(ok.buffer);
    expect(xml.match(/<w:r>/g)?.length).toBe((await documentXml(source)).match(/<w:r>/g)?.length);
  });

  it('lien hypertexte : correction appliquée', async () => {
    const source = await docWith(
      p(r('Voir '), `<w:hyperlink r:id="rId99">${r('le sitte')}</w:hyperlink>`, r(' officiel.')),
    );
    const { blocks } = await parseDocx(source);
    const result = await applyTextEdits(source, [edit(blocks, 'Voir', 'sitte', 'site')]);
    expect(result.applied).toHaveLength(1);
    expect(await texts(result.buffer)).toContain('Voir le site officiel.');
    expect(await documentXml(result.buffer)).toContain('<w:hyperlink r:id="rId99">');
  });

  it('caractères à échapper et espaces de bord conservés', async () => {
    const source = await docWith(p(r('Prix et conditions.')));
    const { blocks } = await parseDocx(source);
    const result = await applyTextEdits(source, [edit(blocks, 'Prix', 'Prix et', 'Prix <HT> & ')]);
    expect(await texts(result.buffer)).toContain('Prix <HT> &  conditions.');
    expect(await documentXml(result.buffer)).toContain('Prix &lt;HT&gt; &amp;  conditions.');
  });

  it('insertion (passage vide) entre deux runs de même mise en forme : appliquée', async () => {
    const source = await docWith(p(r('Bonjour', '<w:i/>'), r(' monde', '<w:i/>')));
    const { blocks } = await parseDocx(source);
    const result = await applyTextEdits(source, [insertion(blocks, 'Bonjour monde', 7, ',')]);
    expect(await texts(result.buffer)).toContain('Bonjour, monde');
    expect(await runsOf(result.buffer, 'Bonjour, monde')).toEqual([
      { format: '<w:i/>', text: 'Bonjour,' },
      { format: '<w:i/>', text: ' monde' },
    ]);
  });

  it('une partie de corrections appliquée, une partie écartée : compte rendu par correction', async () => {
    const source = await docWith(
      p(r('Texte avec une fote.')),
      p(r('Avant'), '<w:r><w:tab/></w:r>', r('après une fote.')),
    );
    const { blocks } = await parseDocx(source);
    const result = await applyTextEdits(source, [
      edit(blocks, 'Texte avec', 'fote', 'faute', 'ok'),
      edit(blocks, 'Avant', 'Avant\tapr', 'Avant apr', 'tab'),
    ]);
    expect(result.applied).toEqual(['ok']);
    expect(result.skipped).toEqual([{ id: 'tab', reason: 'not_plain_text' }]);
  });
});

describe('applyTextEdits : refus avec motif', () => {
  async function skippedReason(paragraphXml: string, where: string, original: string) {
    const source = await docWith(paragraphXml);
    const { blocks } = await parseDocx(source);
    const result = await applyTextEdits(source, [edit(blocks, where, original, 'X', 'cible')]);
    // Rien d'appliqué : le fichier d'origine est renvoyé tel quel.
    expect(result.changed).toBe(false);
    expect(result.buffer).toBe(source);
    return result.skipped;
  }

  it.each([
    [
      'tabulation',
      p(r('Avant'), '<w:r><w:tab/></w:r>', r('après')),
      'Avant',
      'nt\tap',
      'not_plain_text',
    ],
    [
      'saut de ligne',
      p('<w:r><w:t>Ligne</w:t><w:br/><w:t>suite</w:t></w:r>'),
      'Ligne',
      'e\ns',
      'not_plain_text',
    ],
    [
      'résultat de champ',
      p(
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> REF x </w:instrText></w:r>',
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>',
        r('Figure 3'),
        '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
        r(' du rapport.'),
      ),
      'Figure 3',
      'Figure',
      'field',
    ],
    [
      'champ simple',
      p(`<w:fldSimple w:instr=" DATE ">${r('Lundi')}</w:fldSimple>`, r(' matin.')),
      'Lundi',
      'Lundi',
      'field',
    ],
    [
      'contrôle de contenu (en ligne)',
      p(`<w:sdt><w:sdtContent>${r('Nom du client')}</w:sdtContent></w:sdt>`),
      'Nom du',
      'client',
      'content_control',
    ],
    [
      'contrôle de contenu (paragraphe)',
      `<w:sdt><w:sdtContent>${p(r('Clause type'))}</w:sdtContent></w:sdt>`,
      'Clause',
      'type',
      'content_control',
    ],
    [
      'insertion suivie',
      p(r('Texte '), `<w:ins w:id="1" w:author="a">${r('ajouté')}</w:ins>`),
      'Texte',
      'ajouté',
      'tracked_change',
    ],
    [
      'mise en forme modifiée en révision',
      p(
        `<w:r><w:rPr><w:b/><w:rPrChange w:id="2" w:author="a"><w:rPr/></w:rPrChange></w:rPr><w:t>Gras</w:t></w:r>`,
      ),
      'Gras',
      'Gras',
      'tracked_change',
    ],
    [
      'suppression suivie entre deux runs',
      p(
        r('Le '),
        `<w:del w:id="3" w:author="a"><w:r><w:delText>vieux </w:delText></w:r></w:del>`,
        r('projet'),
      ),
      'Le projet',
      'Le projet',
      'non_adjacent',
    ],
    [
      'texte masqué entre deux runs',
      p(r('Le '), r('caché', '<w:vanish/>'), r('projet')),
      'Le projet',
      'Le projet',
      'non_adjacent',
    ],
    [
      'mises en forme différentes',
      p(r('Le pro', '<w:b/>'), r('jet')),
      'Le projet',
      'projet',
      'format_boundary',
    ],
  ])('%s', async (_name, xml, where, original, reason) => {
    expect(await skippedReason(xml, where, original)).toEqual([{ id: 'cible', reason }]);
  });

  it('correspondance avec l’analyse : bloc changé, passage différent, bloc absent, positions invalides', async () => {
    const source = await docWith(p(r('Une phrase avec une fote.')));
    const { blocks } = await parseDocx(source);
    const base = edit(blocks, 'Une phrase', 'fote', 'faute', 'x');
    const result = await applyTextEdits(source, [
      { ...base, id: 'bloc', expectedBlockText: 'Une phrase différente.' },
      { ...base, id: 'passage', expectedOriginal: 'fate' },
      { ...base, id: 'absent', blockId: 'b_999999' },
      { ...base, id: 'positions', start: 10, end: 5 },
      { ...base, id: 'hors', start: 0, end: 999 },
    ]);
    expect(result.changed).toBe(false);
    expect(result.skipped).toEqual([
      { id: 'bloc', reason: 'block_changed' },
      { id: 'passage', reason: 'original_mismatch' },
      { id: 'absent', reason: 'block_not_found' },
      { id: 'positions', reason: 'invalid_range' },
      { id: 'hors', reason: 'invalid_range' },
    ]);
  });

  it('remplacement invalide : tabulation, saut de ligne, caractère interdit, trop long, identique', async () => {
    const source = await docWith(p(r('Une phrase avec une fote.')));
    const { blocks } = await parseDocx(source);
    const base = edit(blocks, 'Une phrase', 'fote', 'faute', 'x');
    const result = await applyTextEdits(source, [
      { ...base, id: 'tab', replacement: 'fa\tute' },
      { ...base, id: 'ligne', replacement: 'fa\nute' },
      { ...base, id: 'controle', replacement: 'fa\u0001ute' },
      { ...base, id: 'long', replacement: 'a'.repeat(MAX_REPLACEMENT_LENGTH + 1) },
      { ...base, id: 'identique', replacement: 'fote' },
    ]);
    expect(result.skipped.map((s) => s.reason)).toEqual(Array(5).fill('invalid_replacement'));
  });

  it('chevauchements : seule la première correction est gardée', async () => {
    const source = await docWith(p(r('Une phrase avec une fote.')));
    const { blocks } = await parseDocx(source);
    const result = await applyTextEdits(source, [
      edit(blocks, 'Une phrase', 'une fote', 'une faute', 'large'),
      edit(blocks, 'Une phrase', 'fote', 'faute', 'interne'),
    ]);
    expect(result.applied).toEqual(['large']);
    expect(result.skipped).toEqual([{ id: 'interne', reason: 'overlap' }]);
  });

  it('entrée de sommaire : jamais corrigée automatiquement', async () => {
    const source = await docWith(p('<w:pPr><w:pStyle w:val="TOC1"/></w:pPr>', r('1. Introdution')));
    const { blocks } = await parseDocx(source);
    expect(blocks.find((b) => b.text.includes('Introdution'))?.kind).toBe('toc_entry');
    const result = await applyTextEdits(source, [
      edit(blocks, 'Introdution', 'Introdution', 'Introduction', 'toc'),
    ]);
    expect(result.skipped).toEqual([{ id: 'toc', reason: 'unsupported_block' }]);
  });

  it('document en révision : seules les zones ambiguës sont écartées', async () => {
    const source = await docWith(
      p(r('Texte '), `<w:ins w:id="1" w:author="a">${r('ajoutté')}</w:ins>`, r(' et une fote.')),
    );
    const { blocks } = await parseDocx(source);
    const result = await applyTextEdits(source, [
      edit(blocks, 'Texte', 'ajoutté', 'ajouté', 'insertion'),
      edit(blocks, 'Texte', 'fote', 'faute', 'hors-revision'),
    ]);
    expect(result.applied).toEqual(['hors-revision']);
    expect(result.skipped).toEqual([{ id: 'insertion', reason: 'tracked_change' }]);
    expect(await texts(result.buffer)).toContain('Texte ajoutté et une faute.');
  });
});

describe('applyTextEdits : frontières entre runs, sans changement de style', () => {
  const B = '<w:b/>';

  it('même mise en forme, remplacement à cheval sur la frontière : chaque run garde son style', async () => {
    const source = await docWith(p(r('Le pro', B), r('jet avance.', B)));
    const { blocks } = await parseDocx(source);
    const result = await applyTextEdits(source, [edit(blocks, 'Le projet', 'projet', 'travail')]);
    expect(result.applied).toHaveLength(1);
    expect(await runsOf(result.buffer, 'Le travail avance.')).toEqual([
      { format: B, text: 'Le travail' },
      { format: B, text: ' avance.' },
    ]);
  });

  it('même mise en forme, passage qui finit ou commence exactement à la frontière : un seul run touché', async () => {
    const source = await docWith(p(r('Le pro', B), r('jet avance.', B)));
    const { blocks } = await parseDocx(source);
    const ending = await applyTextEdits(source, [edit(blocks, 'Le projet', 'pro', 'PRO')]);
    expect(await runsOf(ending.buffer, 'Le PROjet avance.')).toEqual([
      { format: B, text: 'Le PRO' },
      { format: B, text: 'jet avance.' },
    ]);
    const starting = await applyTextEdits(source, [edit(blocks, 'Le projet', 'jet', 'JET')]);
    expect(await runsOf(starting.buffer, 'Le proJET avance.')).toEqual([
      { format: B, text: 'Le pro' },
      { format: B, text: 'JET avance.' },
    ]);
  });

  it('mises en forme différentes, passage contenu dans un run et collé à la frontière : appliqué sans changer les styles', async () => {
    const source = await docWith(p(r('Le pro', B), r('jet avance.')));
    const { blocks } = await parseDocx(source);
    const bold = await applyTextEdits(source, [edit(blocks, 'Le projet', 'pro', 'PRO')]);
    expect(await runsOf(bold.buffer, 'Le PROjet avance.')).toEqual([
      { format: B, text: 'Le PRO' },
      { format: '', text: 'jet avance.' },
    ]);
    const plain = await applyTextEdits(source, [edit(blocks, 'Le projet', 'jet', 'JET')]);
    expect(await runsOf(plain.buffer, 'Le proJET avance.')).toEqual([
      { format: B, text: 'Le pro' },
      { format: '', text: 'JET avance.' },
    ]);
  });

  it('mises en forme différentes, passage à cheval : écarté, fichier d’origine renvoyé', async () => {
    const source = await docWith(p(r('Le pro', B), r('jet avance.')));
    const { blocks } = await parseDocx(source);
    const result = await applyTextEdits(source, [
      edit(blocks, 'Le projet', 'projet', 'travail', 'x'),
    ]);
    expect(result.skipped).toEqual([{ id: 'x', reason: 'format_boundary' }]);
    expect(result.buffer).toBe(source);
  });

  it('insertion exactement à la frontière de mises en forme différentes : écartée (style ambigu)', async () => {
    const source = await docWith(p(r('Bonjour', '<w:i/>'), r(' monde')));
    const { blocks } = await parseDocx(source);
    const result = await applyTextEdits(source, [insertion(blocks, 'Bonjour monde', 7, ',')]);
    expect(result.skipped).toEqual([{ id: 'insertion', reason: 'format_boundary' }]);
    expect(result.buffer).toBe(source);
  });

  it('mêmes propriétés écrites dans un ordre différent : traitées comme différentes (prudence)', async () => {
    const source = await docWith(p(r('Le pro', '<w:b/><w:i/>'), r('jet', '<w:i/><w:b/>')));
    const { blocks } = await parseDocx(source);
    const result = await applyTextEdits(source, [
      edit(blocks, 'Le projet', 'projet', 'travail', 'x'),
    ]);
    expect(result.skipped).toEqual([{ id: 'x', reason: 'format_boundary' }]);
  });
});

describe('applyTextEdits : en-têtes et pieds de page répétés', () => {
  /** Ajoute une partie d'en-tête (ou de pied) identique à la première, comme pour la première page. */
  async function withSecondPart(kind: 'header' | 'footer'): Promise<Buffer> {
    return patchDocx(await docWith(p(r('Texte.'))), async (zip) => {
      const xml = await zip.file(`word/${kind}1.xml`)!.async('string');
      zip.file(`word/${kind}2.xml`, xml);
    });
  }

  it('même texte d’en-tête dans deux parties : correction écartée, rien n’est modifié', async () => {
    const source = await withSecondPart('header');
    const { blocks } = await parseDocx(source);
    // Le modèle ne garde qu'une occurrence du texte répété.
    expect(blocks.filter((b) => b.text === 'En-tête avec une fote')).toHaveLength(1);
    const result = await applyTextEdits(source, [edit(blocks, 'En-tête', 'fote', 'faute', 'h')]);
    expect(result.skipped).toEqual([{ id: 'h', reason: 'repeated_header_footer' }]);
    expect(result.buffer).toBe(source);
  });

  it('même texte deux fois dans une seule partie de pied de page : écartée aussi', async () => {
    const source = await patchDocx(await docWith(p(r('Texte.'))), async (zip) => {
      const xml = await zip.file('word/footer1.xml')!.async('string');
      const paragraph = /<w:p>(?:(?!<w:p>).)*Pied de page(?:(?!<\/w:p>).)*<\/w:p>/s.exec(xml)![0];
      zip.file('word/footer1.xml', xml.replace(paragraph, paragraph + paragraph));
    });
    const { blocks } = await parseDocx(source);
    const result = await applyTextEdits(source, [edit(blocks, 'Pied de', 'Pied', 'Bas', 'f')]);
    expect(result.skipped).toEqual([{ id: 'f', reason: 'repeated_header_footer' }]);
  });

  it('pied répété, en-tête unique : seul l’en-tête est corrigé ; les autres corrections continuent', async () => {
    const source = await withSecondPart('footer');
    const { blocks } = await parseDocx(source);
    const result = await applyTextEdits(source, [
      edit(blocks, 'Pied de', 'Pied', 'Bas', 'pied'),
      edit(blocks, 'En-tête', 'fote', 'faute', 'entete'),
      edit(blocks, 'Cellule', 'fote', 'faute', 'cellule'),
    ]);
    expect(result.applied.sort()).toEqual(['cellule', 'entete']);
    expect(result.skipped).toEqual([{ id: 'pied', reason: 'repeated_header_footer' }]);
    const after = await texts(result.buffer);
    expect(after).toContain('En-tête avec une faute');
    expect(after).toContain('Pied de page');
  });
});

describe('applyTextEdits : réécriture refusée', () => {
  it('partie non conservable (commentaire XML) : erreur, aucun fichier', async () => {
    const source = await patchDocx(await docWith(p(r('Une fote.'))), async (zip) => {
      const xml = await zip.file('word/document.xml')!.async('string');
      zip.file('word/document.xml', xml.replace('<w:body>', '<w:body><!-- c -->'));
    });
    const { blocks } = await parseDocx(source);
    await expect(
      applyTextEdits(source, [edit(blocks, 'Une fote', 'fote', 'faute')]),
    ).rejects.toBeInstanceOf(XmlRewriteError);
  });

  it('fichier illisible : erreur, aucun fichier', async () => {
    await expect(
      applyTextEdits(Buffer.from('pas un docx'), [
        {
          id: 'x',
          blockId: 'b_000000',
          start: 0,
          end: 1,
          expectedBlockText: 'a',
          expectedOriginal: 'a',
          replacement: 'b',
        },
      ]),
    ).rejects.toThrow();
  });
});
