/**
 * Fabrique de documents de test.
 *
 * Les .docx sont générés à la volée avec la bibliothèque `docx` (décision D2) :
 * pas de fichiers binaires dans le dépôt, et un contenu connu à l'avance.
 * Les fichiers piégés ou invalides sont construits avec JSZip.
 */
import {
  AlignmentType,
  Document,
  Footer,
  FootnoteReferenceRun,
  Header,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from 'docx';
import JSZip from 'jszip';

export type FixtureNode =
  | { h: 1 | 2 | 3 | 4; text: string }
  | { p: string; bold?: boolean; footnote?: string }
  | { bullet: string; level?: number }
  | { table: string[][] }
  | { pageBreak: true };

const HEADINGS = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
} as const;

export async function buildDocx(
  nodes: FixtureNode[],
  options: { header?: string; footer?: string; title?: string } = {},
): Promise<Buffer> {
  const footnotes: Record<number, { children: Paragraph[] }> = {};
  let footnoteId = 0;
  const children: (Paragraph | Table)[] = [];

  if (options.title) {
    children.push(new Paragraph({ text: options.title, heading: HeadingLevel.TITLE }));
  }

  for (const node of nodes) {
    if ('h' in node) {
      children.push(new Paragraph({ text: node.text, heading: HEADINGS[node.h] }));
    } else if ('p' in node) {
      const runs: (TextRun | FootnoteReferenceRun)[] = [
        new TextRun({ text: node.p, bold: node.bold }),
      ];
      if (node.footnote) {
        footnoteId++;
        footnotes[footnoteId] = { children: [new Paragraph(node.footnote)] };
        runs.push(new FootnoteReferenceRun(footnoteId));
      }
      children.push(new Paragraph({ children: runs, alignment: AlignmentType.JUSTIFIED }));
    } else if ('bullet' in node) {
      children.push(new Paragraph({ text: node.bullet, bullet: { level: node.level ?? 0 } }));
    } else if ('table' in node) {
      children.push(
        new Table({
          rows: node.table.map(
            (row) =>
              new TableRow({
                children: row.map((cell) => new TableCell({ children: [new Paragraph(cell)] })),
              }),
          ),
        }),
      );
    } else {
      children.push(new Paragraph({ text: '', pageBreakBefore: true }));
    }
  }

  const doc = new Document({
    creator: 'WordFix tests',
    footnotes,
    sections: [
      {
        headers: options.header
          ? { default: new Header({ children: [new Paragraph(options.header)] }) }
          : undefined,
        footers: options.footer
          ? { default: new Footer({ children: [new Paragraph(options.footer)] }) }
          : undefined,
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}

/** Phrase de remplissage réaliste pour fabriquer des documents longs. */
export function filler(words: number, seed = 1): string {
  const vocabulary = [
    'le',
    'projet',
    'consiste',
    'à',
    'mettre',
    'en',
    'place',
    'une',
    'infrastructure',
    'réseau',
    'fiable',
    'pour',
    'les',
    'équipes',
    'de',
    'l’entreprise',
    'qui',
    'travaillent',
    'chaque',
    'jour',
    'avec',
    'des',
    'outils',
    'numériques',
    'adaptés',
    'au',
    'contexte',
  ];
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(vocabulary[(i * 7 + seed) % vocabulary.length] ?? 'mot');
  const sentence = out.join(' ');
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

/** Modifie une partie XML d'un .docx existant (pour fabriquer des cas limites). */
export async function patchDocx(
  buffer: Buffer,
  patch: (zip: JSZip) => Promise<void> | void,
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buffer);
  await patch(zip);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Archive ZIP qui n'est pas un document Word. */
export async function buildPlainZip(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('readme.txt', 'Ceci est une archive ZIP, pas un document Word.');
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** « Bombe ZIP » : une entrée minuscule une fois compressée, énorme une fois décompressée. */
export async function buildZipBomb(): Promise<Buffer> {
  const base = await buildDocx([{ p: 'Document piégé.' }]);
  return patchDocx(base, (zip) => {
    zip.file('word/media/bomb.bin', Buffer.alloc(150 * 1024 * 1024, 0));
  });
}

/** En-tête OLE (format binaire Word 97-2003 ou .docx chiffré). */
export function buildOleFile(encrypted: boolean): Buffer {
  const header = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const body = Buffer.alloc(4096, 0);
  if (encrypted) Buffer.from('EncryptedPackage', 'utf16le').copy(body, 1024);
  return Buffer.concat([header, body]);
}

/** Faux PDF renommé en .docx. */
export function buildFakePdf(): Buffer {
  return Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n', 'latin1');
}
