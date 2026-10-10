import { describe, expect, it } from 'vitest';
import { ZipFile as YazlZipFile } from 'yazl';
import { buildDocx, patchDocx } from '../../../test/fixtures/builders.js';
import { DocxPackageError } from '../package-reader.js';
import { parseDocx } from '../parser/docx-parser.js';
import type { WalkedParagraph } from '../parser/parts.js';
import { childByTag, childrenOf, tagOf, type XmlNode } from '../parser/xml.js';
import { SafeZip } from '../zip-reader.js';
import { DocxRewriteError, type PartEdit, rewriteDocx } from './rewrite-docx.js';
import { hasInvalidXmlChar, XmlRewriteError } from './xml-writer.js';

/**
 * Socle d'écriture : aucune correction linguistique ici. Les modifications de test
 * remplacent directement le texte d'un run pour vérifier que seule la partie
 * concernée change et que tout le reste du paquet est conservé.
 */

/** Octets factices d'une image, stockée sans compression comme le font souvent Word et LibreOffice. */
const IMAGE = Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 37) % 256));

async function richDocx(): Promise<Buffer> {
  const base = await buildDocx(
    [
      { h: 1, text: 'Introduction' },
      { p: 'Premier paragraphe du rapport.', footnote: 'Une note.' },
      { table: [['Cellule A', 'Cellule B']] },
      { p: 'Dernier paragraphe.' },
    ],
    { header: 'En-tête du rapport', footer: 'Pied de page' },
  );
  return patchDocx(base, (zip) => {
    zip.file('word/media/image1.png', IMAGE, { compression: 'STORE' });
  });
}

interface EntryInfo {
  name: string;
  method: number;
  modified: number;
  data: Buffer;
}

async function entries(buffer: Buffer): Promise<EntryInfo[]> {
  const zip = await SafeZip.open(buffer);
  try {
    const out: EntryInfo[] = [];
    for (const entry of zip.order) {
      out.push({
        name: entry.fileName,
        method: entry.compressionMethod,
        modified: entry.getLastModDate().getTime(),
        data: entry.fileName.endsWith('/')
          ? Buffer.alloc(0)
          : await zip.read(entry.fileName, entry.uncompressedSize),
      });
    }
    return out;
  } finally {
    zip.close();
  }
}

/**
 * Recopie l'archive en ajoutant des entrées, y compris sous un nom déjà présent
 * (impossible avec JSZip, qui indexe par nom) : archives ambiguës à refuser.
 */
async function withExtraEntries(
  source: Buffer,
  extra: { name: string; data: string }[],
): Promise<Buffer> {
  const zip = await SafeZip.open(source);
  const out = new YazlZipFile();
  try {
    for (const entry of zip.order) {
      if (entry.fileName.endsWith('/')) out.addEmptyDirectory(entry.fileName);
      else out.addBuffer(await zip.read(entry.fileName, entry.uncompressedSize), entry.fileName);
    }
  } finally {
    zip.close();
  }
  for (const { name, data } of extra) out.addBuffer(Buffer.from(data), name);
  out.end();
  const chunks: Buffer[] = [];
  for await (const chunk of out.outputStream as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Remplace tout le texte du premier w:t d'un run (modification de test). */
function setRunText(run: XmlNode, text: string): void {
  const t = childByTag(run, 'w:t');
  if (!t) throw new Error('run sans w:t');
  (t['w:t'] as XmlNode[]).splice(0, childrenOf(t).length, { '#text': text });
}

/** Modification d'un bloc du modèle, à partir de ses ancres (même parcours que la lecture). */
function editBlock(part: string, paragraphIndex: number, runIndex: number, text: string): PartEdit {
  return {
    part,
    apply: (_tree, { paragraphs }) => {
      const paragraph: WalkedParagraph | undefined = paragraphs.get(paragraphIndex);
      const run = paragraph?.xml.runs[runIndex];
      if (!run) throw new Error('paragraphe ou run introuvable');
      setRunText(run, text);
      return true;
    },
  };
}

describe('rewriteDocx : aucune modification', () => {
  it('zéro modification : renvoie les octets d’origine, sans reconstruire l’archive', async () => {
    const source = await richDocx();
    const result = await rewriteDocx(source, []);
    expect(result.buffer).toBe(source);
    expect(result.changedParts).toEqual([]);
  });

  it('modification qui ne change rien : octets d’origine également', async () => {
    const source = await richDocx();
    const result = await rewriteDocx(source, [{ part: 'word/document.xml', apply: () => false }]);
    expect(result.buffer).toBe(source);
    expect(result.changedParts).toEqual([]);
  });
});

describe('rewriteDocx : réécriture', () => {
  it('réécriture sans changement de contenu : modèle identique, autres entrées intactes', async () => {
    const source = await richDocx();
    const parts = [
      'word/document.xml',
      'word/header1.xml',
      'word/footer1.xml',
      'word/footnotes.xml',
      'word/styles.xml',
    ];
    const result = await rewriteDocx(
      source,
      parts.map((part) => ({ part, apply: () => true })),
    );
    expect(result.changedParts.sort()).toEqual([...parts].sort());
    expect(await parseDocx(result.buffer)).toEqual(await parseDocx(source));

    const before = await entries(source);
    const after = await entries(result.buffer);
    expect(after.map((e) => e.name)).toEqual(before.map((e) => e.name));
    for (const [index, entry] of before.entries()) {
      const copy = after[index]!;
      expect(copy.method).toBe(entry.method);
      expect(copy.modified).toBe(entry.modified);
      // Fichier généré par la bibliothèque docx : la réécriture est identique à l'octet.
      expect(copy.data.equals(entry.data)).toBe(true);
    }
    expect(after.find((e) => e.name === 'word/media/image1.png')?.method).toBe(0);
  });

  it('modifie seulement le texte visé ; le reste du document et du paquet est conservé', async () => {
    const source = await richDocx();
    const model = await parseDocx(source);
    const target = model.blocks.find((b) => b.text === 'Dernier paragraphe.')!;
    const result = await rewriteDocx(source, [
      editBlock(
        target.anchor.xmlPart,
        target.anchor.paragraphIndex,
        target.anchor.runs[0]!.runIndex,
        'Paragraphe modifié & vérifié.',
      ),
    ]);
    expect(result.changedParts).toEqual(['word/document.xml']);

    const updated = await parseDocx(result.buffer);
    expect(updated.blocks.map((b) => b.text)).toEqual(
      model.blocks.map((b) => (b.id === target.id ? 'Paragraphe modifié & vérifié.' : b.text)),
    );
    const before = await entries(source);
    const after = await entries(result.buffer);
    expect(after.map((e) => e.name)).toEqual(before.map((e) => e.name));
    for (const [index, entry] of before.entries()) {
      if (entry.name === 'word/document.xml') continue;
      expect(after[index]!.data.equals(entry.data)).toBe(true);
    }
    // Le caractère « & » est échappé dans le XML produit.
    const documentXml = after.find((e) => e.name === 'word/document.xml')!.data.toString('utf8');
    expect(documentXml).toContain('Paragraphe modifié &amp; vérifié.');
  });

  it('retrouve les paragraphes des en-têtes, pieds de page et notes', async () => {
    const source = await richDocx();
    const model = await parseDocx(source);
    const edits = (['header', 'footer', 'footnote'] as const).map((kind) => {
      const block = model.blocks.find((b) => b.kind === kind)!;
      return editBlock(
        block.anchor.xmlPart,
        block.anchor.paragraphIndex,
        block.anchor.runs[0]!.runIndex,
        `Nouveau ${kind}`,
      );
    });
    const result = await rewriteDocx(source, edits);
    expect(result.changedParts.sort()).toEqual([
      'word/footer1.xml',
      'word/footnotes.xml',
      'word/header1.xml',
    ]);
    const updated = await parseDocx(result.buffer);
    expect(
      updated.blocks
        .filter((b) => ['header', 'footer', 'footnote'].includes(b.kind))
        .map((b) => b.text),
    ).toEqual(['Nouveau footnote', 'Nouveau footer', 'Nouveau header']);
    expect(updated.blocks.filter((b) => b.part === 'body')).toEqual(
      model.blocks.filter((b) => b.part === 'body'),
    );
  });

  it('conserve à l’identique la déclaration XML et ce qui précède la racine', async () => {
    const prolog = '\uFEFF<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
    const source = await patchDocx(await richDocx(), async (zip) => {
      const xml = await zip.file('word/document.xml')!.async('string');
      zip.file('word/document.xml', xml.replace(/^[^<]*<\?xml[^?]*\?>\s*/, prolog));
    });
    const result = await rewriteDocx(source, [{ part: 'word/document.xml', apply: () => true }]);
    const documentXml = (await entries(result.buffer))
      .find((e) => e.name === 'word/document.xml')!
      .data.toString('utf8');
    expect(documentXml.startsWith(prolog)).toBe(true);
    expect(await parseDocx(result.buffer)).toEqual(await parseDocx(source));
  });

  it('les caractères écrits en références numériques sont conservés (sous forme directe)', async () => {
    const source = await patchDocx(await richDocx(), async (zip) => {
      const xml = await zip.file('word/document.xml')!.async('string');
      zip.file(
        'word/document.xml',
        xml.replace('Dernier paragraphe.', 'L&#8217;eau&#160;: &amp;#160;'),
      );
    });
    const result = await rewriteDocx(source, [{ part: 'word/document.xml', apply: () => true }]);
    const texts = (await parseDocx(result.buffer)).blocks.map((b) => b.text);
    expect(texts).toContain('L’eau\u00a0: &#160;');
    expect(texts).toEqual((await parseDocx(source)).blocks.map((b) => b.text));
  });
});

describe('rewriteDocx : refus explicites', () => {
  it('partie absente ou non XML', async () => {
    const source = await richDocx();
    await expect(
      rewriteDocx(source, [{ part: 'word/inexistant.xml', apply: () => true }]),
    ).rejects.toMatchObject({ problem: 'missing_part' });
    await expect(
      rewriteDocx(source, [{ part: 'word/media/image1.png', apply: () => true }]),
    ).rejects.toBeInstanceOf(DocxRewriteError);
  });

  it('commentaire XML ou encodage autre que UTF-8 : refus plutôt que perte', async () => {
    const withComment = await patchDocx(await richDocx(), async (zip) => {
      const xml = await zip.file('word/document.xml')!.async('string');
      zip.file('word/document.xml', xml.replace('<w:body>', '<w:body><!-- note -->'));
    });
    await expect(
      rewriteDocx(withComment, [{ part: 'word/document.xml', apply: () => true }]),
    ).rejects.toMatchObject({ problem: 'unsupported_xml' });

    const latin1 = await patchDocx(await richDocx(), async (zip) => {
      const xml = await zip.file('word/header1.xml')!.async('string');
      zip.file('word/header1.xml', xml.replace(/encoding="UTF-8"/i, 'encoding="ISO-8859-1"'));
    });
    await expect(
      rewriteDocx(latin1, [{ part: 'word/header1.xml', apply: () => true }]),
    ).rejects.toBeInstanceOf(XmlRewriteError);
  });

  it('texte contenant un caractère interdit en XML : refusé', async () => {
    const source = await richDocx();
    const model = await parseDocx(source);
    const target = model.blocks.find((b) => b.text === 'Dernier paragraphe.')!;
    await expect(
      rewriteDocx(source, [
        editBlock(target.anchor.xmlPart, target.anchor.paragraphIndex, 0, 'texte\u0001invalide'),
      ]),
    ).rejects.toMatchObject({ problem: 'invalid_output' });
  });

  it('entrée en double (même nom) : refus, au lieu de remplacer l’une par l’autre', async () => {
    const source = await withExtraEntries(await richDocx(), [
      { name: 'word/media/image1.png', data: 'autre image' },
    ]);
    // Une modification ailleurs suffit : l'archive entière est ambiguë.
    await expect(
      rewriteDocx(source, [{ part: 'word/document.xml', apply: () => true }]),
    ).rejects.toMatchObject({ problem: 'duplicate_entry' });

    const duplicateMain = await withExtraEntries(await richDocx(), [
      { name: 'word/document.xml', data: '<w:document/>' },
    ]);
    await expect(
      rewriteDocx(duplicateMain, [{ part: 'word/document.xml', apply: () => true }]),
    ).rejects.toMatchObject({ problem: 'duplicate_entry' });
  });

  it('noms qui ne diffèrent que par la casse : refus également', async () => {
    const source = await patchDocx(await richDocx(), (zip) => {
      zip.file('WORD/Document.xml', '<w:document/>');
    });
    await expect(
      rewriteDocx(source, [{ part: 'word/header1.xml', apply: () => true }]),
    ).rejects.toBeInstanceOf(DocxRewriteError);
    await expect(
      rewriteDocx(source, [{ part: 'word/header1.xml', apply: () => true }]),
    ).rejects.toMatchObject({ problem: 'duplicate_entry' });
  });

  it('archive ambiguë sans modification demandée : octets d’origine, rien n’est réécrit', async () => {
    const source = await withExtraEntries(await richDocx(), [
      { name: 'word/media/image1.png', data: 'autre image' },
    ]);
    expect((await rewriteDocx(source, [])).buffer).toBe(source);
  });

  it('document avec macros : refusé comme à l’import', async () => {
    const macro = await patchDocx(await richDocx(), (zip) => {
      zip.file('word/vbaProject.bin', 'macro');
    });
    await expect(
      rewriteDocx(macro, [{ part: 'word/document.xml', apply: () => true }]),
    ).rejects.toBeInstanceOf(DocxPackageError);
  });

  it('l’arbre XML transmis aux modifications est celui de la lecture', async () => {
    const source = await richDocx();
    let rootTag = '';
    await rewriteDocx(source, [
      {
        part: 'word/document.xml',
        apply: (tree) => {
          rootTag = tagOf(tree[0]!);
          return false;
        },
      },
    ]);
    // La déclaration XML n'est pas dans l'arbre (elle est conservée à part).
    expect(rootTag).toBe('w:document');
  });
});

describe('Caractères interdits en XML', () => {
  it('détecte contrôles, non-caractères et demi-paires isolées ; accepte le reste', () => {
    expect(hasInvalidXmlChar('texte normal\t\n\r « é » 😀')).toBe(false);
    for (const bad of ['\u0000', '\u0001', '\u000B', '\u001F', '￾', '￿', '\uD800', '\uDC00']) {
      expect(hasInvalidXmlChar(`a${bad}b`)).toBe(true);
    }
  });
});
