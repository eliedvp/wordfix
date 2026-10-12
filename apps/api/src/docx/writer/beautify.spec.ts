import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { buildDocx } from '../../../test/fixtures/builders.js';
import { parseDocx } from '../parser/docx-parser.js';
import { beautifyDocx, harmonizeLayout, typographyEdits } from './beautify.js';

const NB = '\u00a0';

async function texts(buffer: Buffer): Promise<string[]> {
  return (await parseDocx(buffer)).blocks.map((block) => block.text);
}

/** Remplace des fragments de word/document.xml (fabrication de cas précis). */
async function patchDocumentXml(buffer: Buffer, replace: (xml: string) => string): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml')!.async('string');
  zip.file('word/document.xml', replace(xml));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function documentXml(buffer: Buffer): Promise<string> {
  return (await JSZip.loadAsync(buffer)).file('word/document.xml')!.async('string');
}

describe('Embellir : typographie française', () => {
  const SENTENCE =
    'Attention! Il dit «bonjour» et « salut » ; voici la note: rien  de plus ? Voir https://exemple.fr/a?b=1 à 10:30.';

  it('espaces insécables, guillemets et espaces doubles ; zones techniques et heures intactes', async () => {
    const source = await buildDocx([{ h: 1, text: 'Conclusion: bilan' }, { p: SENTENCE }]);
    const result = await beautifyDocx(source, { typography: true, layout: false });
    expect(await texts(result.buffer)).toEqual([
      `Conclusion${NB}: bilan`,
      `Attention${NB}! Il dit «${NB}bonjour${NB}» et «${NB}salut${NB}»${NB}; voici la note${NB}: rien de plus${NB}? Voir https://exemple.fr/a?b=1 à 10:30.`,
    ]);
    expect(result.typography).toBe(10);
    expect(result.layout).toBe(0);
  });

  it('ne modifie que des espaces (jamais d’autres caractères)', async () => {
    const model = await parseDocx(await buildDocx([{ p: SENTENCE }, { table: [['A ; b']] }]));
    const strip = (text: string) => text.replace(/[\s\u00a0]+/g, '');
    const edits = typographyEdits(model);
    expect(edits.length).toBeGreaterThan(0);
    for (const edit of edits) expect(strip(edit.replacement)).toBe(strip(edit.expectedOriginal));
  });

  it('déjà conforme : aucune modification, même fichier', async () => {
    const source = await buildDocx([
      { p: `Bonjour${NB}! «${NB}Oui${NB}» : non.`.replace(' :', `${NB}:`) },
    ]);
    const result = await beautifyDocx(source, { typography: true, layout: false });
    expect(result.typography).toBe(0);
    expect(result.buffer).toBe(source);
  });

  it('deux passages : le second ne change plus rien', async () => {
    const source = await buildDocx([{ p: SENTENCE }]);
    const first = await beautifyDocx(source, { typography: true, layout: false });
    const second = await beautifyDocx(first.buffer, { typography: true, layout: false });
    expect(second.typography).toBe(0);
    expect(await texts(second.buffer)).toEqual(await texts(first.buffer));
  });
});

describe('Embellir : mise en page des paragraphes de texte courant', () => {
  async function sample(): Promise<Buffer> {
    const built = await buildDocx(
      [
        { h: 1, text: 'Titre' },
        { p: 'Paragraphe déjà justifié.' },
        { p: 'Paragraphe aligné à gauche.' },
        { p: 'Paragraphe sans alignement.' },
        { p: 'Paragraphe centré.' },
        { bullet: 'Élément de liste' },
        { table: [['Cellule']] },
      ],
      { header: 'En-tête' },
    );
    // Le générateur justifie tous les paragraphes : cas précis fabriqués ici.
    return patchDocumentXml(built, (xml) => {
      let n = 0;
      return xml.replace(/<w:jc w:val="both"\/>/g, (match) => {
        n++;
        if (n === 2) return '<w:jc w:val="left"/>';
        if (n === 3) return '';
        if (n === 4) return '<w:jc w:val="center"/>';
        return match;
      });
    });
  }

  it('justifie et espace le texte courant ; titres, listes, tableaux, centrés et en-têtes intacts', async () => {
    const source = await sample();
    const result = await harmonizeLayout(source);
    // 4 paragraphes de texte courant : tous reçoivent l'espacement ; 2 sont justifiés.
    expect(result.paragraphs).toBe(4);
    expect(await texts(result.buffer)).toEqual(await texts(source));

    const xml = await documentXml(result.buffer);
    const paragraph = (text: string) => {
      const index = xml.indexOf(text);
      const start =
        xml.lastIndexOf('<w:p>', index) >= xml.lastIndexOf('<w:p ', index)
          ? xml.lastIndexOf('<w:p>', index)
          : xml.lastIndexOf('<w:p ', index);
      return xml.slice(start, index);
    };
    for (const text of [
      'Paragraphe déjà justifié.',
      'Paragraphe aligné à gauche.',
      'Paragraphe sans alignement.',
    ]) {
      expect(paragraph(text)).toContain('<w:jc w:val="both"/>');
      expect(paragraph(text)).toContain(
        '<w:spacing w:after="120" w:line="276" w:lineRule="auto"/>',
      );
    }
    expect(paragraph('Paragraphe centré.')).toContain('<w:jc w:val="center"/>');
    for (const text of ['Titre', 'Élément de liste', 'Cellule']) {
      expect(paragraph(text)).not.toContain('w:line="276"');
    }
    // w:spacing avant w:jc, comme l'exige le schéma de Word.
    const left = paragraph('Paragraphe aligné à gauche.');
    expect(left.indexOf('<w:spacing')).toBeLessThan(left.indexOf('<w:jc'));
  });

  it('espacement propre au paragraphe conservé ; deux passages ne changent plus rien', async () => {
    const source = await patchDocumentXml(await sample(), (xml) =>
      xml.replace('<w:jc w:val="left"/>', '<w:spacing w:after="0"/><w:jc w:val="left"/>'),
    );
    const first = await harmonizeLayout(source);
    const xml = await documentXml(first.buffer);
    expect(xml).toContain('<w:spacing w:after="0"/><w:jc w:val="both"/>');
    const second = await harmonizeLayout(first.buffer);
    expect(second.paragraphs).toBe(0);
  });

  it('les deux options ensemble : texte identique aux espaces près', async () => {
    const source = await buildDocx([{ p: 'Pourquoi?  Parce que.' }]);
    const result = await beautifyDocx(source, { typography: true, layout: true });
    expect(result.typography).toBe(2);
    expect(result.layout).toBe(1);
    expect(await texts(result.buffer)).toEqual([`Pourquoi${NB}? Parce que.`]);
  });
});
