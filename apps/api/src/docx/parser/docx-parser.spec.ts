import { describe, expect, it } from 'vitest';
import { buildDocx, filler, patchDocx } from '../../../test/fixtures/builders.js';
import { parseDocx } from './docx-parser.js';
import { parseWithMammoth } from './mammoth-fallback.js';
import { flattenSections } from './sections.js';

describe('parseDocx', () => {
  it('construit l’arbre des sections et rattache chaque bloc', async () => {
    const buffer = await buildDocx(
      [
        { p: 'Texte avant le premier titre.' },
        { h: 1, text: '1. Introduction' },
        { p: filler(40) },
        { h: 2, text: '1.1 Contexte' },
        { p: filler(30, 2) },
        { h: 1, text: '2. Méthodologie' },
        { p: filler(20, 3) },
      ],
      { header: 'Rapport de stage — 2026', footer: 'Page' },
    );
    const model = await parseDocx(buffer);
    const sections = flattenSections(model.sections);

    expect(sections.map((s) => s.title)).toEqual([
      'Début du document',
      '1. Introduction',
      '1.1 Contexte',
      '2. Méthodologie',
    ]);
    expect(sections[2]?.path).toBe('1. Introduction > 1.1 Contexte');
    expect(sections[1]?.wordCount).toBe(70);

    const contexte = model.blocks.find((b) => b.text.startsWith(filler(30, 2).slice(0, 20)));
    expect(contexte?.sectionId).toBe(sections[2]?.id);
    expect(model.blocks.filter((b) => b.kind === 'heading')).toHaveLength(3);
    expect(
      model.blocks.some((b) => b.kind === 'header' && b.text.includes('Rapport de stage')),
    ).toBe(true);
    expect(model.meta.headingsInferred).toBe(false);
  });

  it('garde les ancres vers les runs du XML d’origine', async () => {
    const model = await parseDocx(await buildDocx([{ p: 'Une phrase simple.' }]));
    const block = model.blocks[0];
    expect(block?.anchor.xmlPart).toBe('word/document.xml');
    expect(block?.anchor.runs[0]).toMatchObject({ start: 0, end: 18 });
    expect(block?.sentences).toEqual([{ start: 0, end: 18 }]);
  });

  it('lit les tableaux cellule par cellule, les listes et les notes', async () => {
    const model = await parseDocx(
      await buildDocx([
        { h: 1, text: 'Résultats' },
        { p: 'Voir le tableau ci-dessous.', footnote: 'Source : enquête interne.' },
        {
          table: [
            ['Indicateur', 'Valeur'],
            ['Disponibilité', '99 %'],
          ],
        },
        { bullet: 'Premier point' },
        { bullet: 'Sous-point', level: 1 },
      ]),
    );
    const cells = model.blocks.filter((b) => b.kind === 'table_cell');
    expect(cells.map((c) => c.text)).toEqual(['Indicateur', 'Valeur', 'Disponibilité', '99 %']);
    expect(cells[3]?.table).toEqual({ index: 0, row: 1, col: 1 });

    const items = model.blocks.filter((b) => b.kind === 'list_item');
    expect(items.map((i) => i.list?.level)).toEqual([0, 1]);

    const note = model.blocks.find((b) => b.kind === 'footnote');
    const caller = model.blocks.find((b) => b.text.startsWith('Voir le tableau'));
    expect(note?.text).toBe('Source : enquête interne.');
    expect(note?.noteOf).toBe(caller?.id);
    expect(note?.sectionId).toBe(caller?.sectionId);
    expect(model.meta.tableCount).toBe(1);
  });

  it('déduit les titres mis en forme à la main quand aucun n’est stylé', async () => {
    const model = await parseDocx(
      await buildDocx([
        { p: '1. Introduction', bold: true },
        { p: filler(50) },
        { p: '1.2 Objectifs du stage' },
        { p: filler(30) },
      ]),
    );
    const headings = model.blocks.filter((b) => b.kind === 'heading');
    expect(headings.map((h) => [h.text, h.heading?.level, h.heading?.source])).toEqual([
      ['1. Introduction', 1, 'inferred'],
      ['1.2 Objectifs du stage', 2, 'inferred'],
    ]);
    expect(model.meta.headingsInferred).toBe(true);
  });

  it('estime les pages au nombre de mots, puis avec les sauts de rendu de Word', async () => {
    const plain = await buildDocx(Array.from({ length: 6 }, (_, i) => ({ p: filler(200, i) })));
    const byWords = await parseDocx(plain);
    expect(byWords.meta.pageMethod).toBe('word_count');
    expect(byWords.blocks.at(-1)?.page).toBe(3);

    // Word écrit <w:lastRenderedPageBreak/> là où il a changé de page à l'affichage.
    const rendered = await patchDocx(plain, async (zip) => {
      const xml = await zip.file('word/document.xml')!.async('string');
      let count = 0;
      zip.file(
        'word/document.xml',
        xml.replace(/<w:r>/g, (match) =>
          count++ % 2 === 1 ? `${match}<w:lastRenderedPageBreak/>` : match,
        ),
      );
    });
    const byBreaks = await parseDocx(rendered);
    expect(byBreaks.meta.pageMethod).toBe('rendered_break');
    expect(byBreaks.blocks.map((b) => b.page)).toEqual([1, 2, 2, 3, 3, 4]);
  });

  it('ignore le texte supprimé en mode suivi et les instructions de champ', async () => {
    const base = await buildDocx([{ p: 'MARQUEUR' }]);
    const patched = await patchDocx(base, async (zip) => {
      const xml = await zip.file('word/document.xml')!.async('string');
      zip.file(
        'word/document.xml',
        xml.replace(
          /<w:p>(?:(?!<w:p>).)*MARQUEUR(?:(?!<\/w:p>).)*<\/w:p>/s,
          '<w:p><w:r><w:t xml:space="preserve">Version </w:t></w:r>' +
            '<w:del w:id="1" w:author="a"><w:r><w:delText>ancienne </w:delText></w:r></w:del>' +
            '<w:ins w:id="2" w:author="a"><w:r><w:t xml:space="preserve">nouvelle </w:t></w:r></w:ins>' +
            '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> DATE </w:instrText></w:r>' +
            '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>2026</w:t></w:r>' +
            '<w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t xml:space="preserve"> &amp; fin.</w:t></w:r></w:p>',
        ),
      );
    });
    const model = await parseDocx(patched);
    expect(model.blocks[0]?.text).toBe('Version nouvelle 2026 & fin.');
  });

  it('décode les caractères écrits en références numériques (&#8217; &#xA0;)', async () => {
    const base = await buildDocx([{ p: 'MARQUEUR' }]);
    const patched = await patchDocx(base, async (zip) => {
      const xml = await zip.file('word/document.xml')!.async('string');
      zip.file(
        'word/document.xml',
        xml.replace(
          /<w:p>(?:(?!<w:p>).)*MARQUEUR(?:(?!<\/w:p>).)*<\/w:p>/s,
          '<w:p><w:r><w:t xml:space="preserve">L&#8217;eau&#160;: 10&#xA0;% (&amp;#160; reste écrit)</w:t></w:r></w:p>',
        ),
      );
    });
    const block = (await parseDocx(patched)).blocks[0];
    expect(block?.text).toBe('L’eau\u00a0: 10\u00a0% (&#160; reste écrit)');
    expect(block?.anchor.runs).toEqual([{ runIndex: 0, start: 0, end: block?.text.length }]);
  });
});

describe('parseWithMammoth (secours)', () => {
  it('extrait titres, paragraphes et tableaux sans ancre XML', async () => {
    const model = await parseWithMammoth(
      await buildDocx([{ h: 1, text: 'Introduction' }, { p: filler(30) }, { table: [['A', 'B']] }]),
    );
    expect(model.blocks.map((b) => b.kind)).toEqual([
      'heading',
      'paragraph',
      'table_cell',
      'table_cell',
    ]);
    expect(model.blocks[1]?.anchor.paragraphIndex).toBe(-1);
    expect(flattenSections(model.sections).map((s) => s.title)).toEqual(['Introduction']);
  });
});
