import { describe, expect, it } from 'vitest';
import { buildDocx, patchDocx } from '../../../test/fixtures/builders.js';
import { DocxPackage, PART_LIMITS } from '../package-reader.js';
import { parseDocx } from './docx-parser.js';
import { partKindOf, walkPart } from './parts.js';
import { parseXml, tagOf } from './xml.js';

/** Document varié : titres, note, puce, tableau, en-tête, pied, suivi, champ, zone de texte, lien. */
async function richDocx(): Promise<Buffer> {
  const base = await buildDocx(
    [
      { h: 1, text: 'Introduction' },
      { p: 'Texte avec une note.', footnote: 'Première note.' },
      { bullet: 'Un point' },
      { table: [['Cellule A', 'Cellule B']] },
      { p: 'MARQUEUR' },
      { p: 'Autre note.', footnote: 'Seconde note.' },
    ],
    { header: 'En-tête du rapport', footer: 'Pied de page' },
  );
  return patchDocx(base, async (zip) => {
    const xml = await zip.file('word/document.xml')!.async('string');
    zip.file(
      'word/document.xml',
      xml.replace(
        /<w:p>(?:(?!<w:p>).)*MARQUEUR(?:(?!<\/w:p>).)*<\/w:p>/s,
        '<w:p><w:r><w:t xml:space="preserve">Avant </w:t></w:r>' +
          '<w:del w:id="1" w:author="a"><w:r><w:delText>supprimé </w:delText></w:r></w:del>' +
          '<w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="wps"><w:drawing><w:txbxContent><w:p><w:r><w:t>Dans la zone</w:t></w:r></w:p></w:txbxContent></w:drawing></mc:Choice></mc:AlternateContent></w:r>' +
          '<w:hyperlink r:id="rId99"><w:r><w:t>lien</w:t></w:r></w:hyperlink>' +
          '<w:r><w:t xml:space="preserve"> après.</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t>Paragraphe suivant.</w:t></w:r></w:p>',
      ),
    );
  });
}

describe('Parcours commun à la lecture et à l’écriture', () => {
  it('chaque bloc du modèle désigne exactement le paragraphe et les runs retrouvés pour l’écriture', async () => {
    const buffer = await richDocx();
    const model = await parseDocx(buffer);
    const pkg = await DocxPackage.open(buffer);
    try {
      const parts = new Set(model.blocks.map((block) => block.anchor.xmlPart));
      expect([...parts].sort()).toEqual([
        'word/document.xml',
        'word/footer1.xml',
        'word/footnotes.xml',
        'word/header1.xml',
      ]);
      for (const part of parts) {
        const kind = partKindOf(part, pkg.mainPart);
        expect(kind).not.toBeNull();
        const walk = walkPart(
          part,
          kind!,
          parseXml(await pkg.readPart(part, PART_LIMITS.mainDocument), part),
        );
        const byIndex = new Map(walk.paragraphs.map((p) => [p.paragraphIndex, p]));
        for (const block of model.blocks.filter((b) => b.anchor.xmlPart === part)) {
          const paragraph = byIndex.get(block.anchor.paragraphIndex);
          expect(paragraph?.text).toBe(block.text);
          expect(paragraph?.runs).toEqual(block.anchor.runs);
          expect(tagOf(paragraph!.xml.paragraph)).toBe('w:p');
          for (const run of block.anchor.runs) {
            expect(tagOf(paragraph!.xml.runs[run.runIndex]!)).toBe('w:r');
          }
        }
      }
    } finally {
      pkg.close();
    }
  });

  it('numérotation : notes de séparation exclues, zone de texte et texte supprimé non comptés', async () => {
    const buffer = await richDocx();
    const model = await parseDocx(buffer);
    // Notes : les séparateurs ne prennent pas d'index, la numérotation est continue.
    const notes = model.blocks.filter((b) => b.kind === 'footnote');
    expect(notes.map((b) => [b.text, b.anchor.paragraphIndex])).toEqual([
      ['Première note.', 0],
      ['Seconde note.', 1],
    ]);
    // Le paragraphe de la zone de texte n'est ni lu ni numéroté.
    const marked = model.blocks.find((b) => b.text.startsWith('Avant'));
    const next = model.blocks.find((b) => b.text === 'Paragraphe suivant.');
    expect(marked?.text).toBe('Avant lien après.');
    expect(next!.anchor.paragraphIndex).toBe(marked!.anchor.paragraphIndex + 1);
    // Le run supprimé (w:del) n'est pas compté ; le run de la zone de texte l'est.
    expect(marked?.anchor.runs.map((r) => r.runIndex)).toEqual([0, 2, 3]);
  });

  it('nature des parties', () => {
    expect(partKindOf('word/document.xml', 'word/document.xml')).toBe('body');
    expect(partKindOf('word/document2.xml', 'word/document2.xml')).toBe('body');
    expect(partKindOf('word/header3.xml', 'word/document.xml')).toBe('header');
    expect(partKindOf('word/footer.xml', 'word/document.xml')).toBe('footer');
    expect(partKindOf('word/footnotes.xml', 'word/document.xml')).toBe('footnotes');
    expect(partKindOf('word/endnotes.xml', 'word/document.xml')).toBe('endnotes');
    expect(partKindOf('word/styles.xml', 'word/document.xml')).toBeNull();
  });
});
