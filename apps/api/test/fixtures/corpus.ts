/**
 * Corpus de la stratégie de tests (QA) : les 13 types de documents définis dans
 * le dossier de conception, générés à la demande. Chaque cas décrit le
 * comportement attendu du backend.
 */
import type { ErrorCode } from '@wordfix/shared';
import {
  buildDocx,
  buildFakePdf,
  buildOleFile,
  buildPlainZip,
  filler,
  type FixtureNode,
  patchDocx,
} from './builders.js';
import { CLEAN_PARAGRAPHS, INJECTED_ERRORS } from './prose.js';

export interface CorpusCase {
  key: string;
  title: string;
  filename: string;
  build: () => Promise<Buffer>;
  /** Code d'erreur attendu à l'import, ou null si le document doit être accepté. */
  uploadError: ErrorCode | null;
  /** Statut HTTP attendu à l'import. */
  uploadStatus: number;
}

/** Rapport réaliste d'environ `pages` pages (≈ 400 mots par page). */
function report(pages: number): FixtureNode[] {
  const nodes: FixtureNode[] = [];
  const target = pages * 400;
  const sections = Math.max(2, Math.round(pages / 3));
  const perSection = target / sections;
  let index = 0;
  for (let s = 0; s < sections; s++) {
    nodes.push({ h: 1, text: `${s + 1}. Partie ${s + 1}` });
    let sectionWords = 0;
    while (sectionWords < perSection) {
      const paragraph = CLEAN_PARAGRAPHS[index++ % CLEAN_PARAGRAPHS.length] ?? '';
      const count = paragraph.split(/\s+/).length;
      nodes.push({ p: paragraph });
      sectionWords += count;
    }
  }
  return nodes;
}

export const CORPUS: CorpusCase[] = [
  {
    key: '01-petit',
    title: 'Petit document (1 page)',
    filename: '01-petit-document.docx',
    build: () =>
      buildDocx([
        { h: 1, text: 'Introduction' },
        ...CLEAN_PARAGRAPHS.slice(0, 3).map((p) => ({ p })),
      ]),
    uploadError: null,
    uploadStatus: 201,
  },
  {
    key: '02-rapport-10p',
    title: 'Rapport de 10 pages',
    filename: '02-rapport-10-pages.docx',
    build: () => buildDocx(report(10)),
    uploadError: null,
    uploadStatus: 201,
  },
  {
    key: '03-rapport-45p',
    title: 'Rapport de 45 pages',
    filename: '03-rapport-45-pages.docx',
    build: () => buildDocx(report(45)),
    uploadError: null,
    uploadStatus: 201,
  },
  {
    key: '04-beaucoup-fautes',
    title: 'Document avec beaucoup de fautes',
    filename: '04-beaucoup-de-fautes.docx',
    build: () =>
      buildDocx([
        { h: 1, text: 'Déroulement' },
        ...INJECTED_ERRORS.map((error) => ({ p: error.sentence })),
        ...INJECTED_ERRORS.map((error) => ({ p: `${error.sentence} Le le travail continue.` })),
      ]),
    uploadError: null,
    uploadStatus: 201,
  },
  {
    key: '05-presque-sans-faute',
    title: 'Document presque sans faute',
    filename: '05-presque-sans-faute.docx',
    build: () => buildDocx([{ h: 1, text: 'Bilan' }, ...CLEAN_PARAGRAPHS.map((p) => ({ p }))]),
    uploadError: null,
    uploadStatus: 201,
  },
  {
    key: '06-repetitions',
    title: 'Document avec beaucoup de répétitions',
    filename: '06-repetitions.docx',
    build: () =>
      buildDocx([
        { h: 1, text: 'Analyse' },
        {
          p: 'Le projet est un projet important. Le le projet a permis de projeter le projet dans le futur du projet.',
        },
        {
          p: 'Nous avons utilisé un e-mail pour prévenir les utilisateurs, puis un email de rappel, puis un second email.',
        },
        {
          p: 'Le Wi-Fi des bureaux a été remplacé ; le wifi de l’entrepôt le sera en juin. Le wifi reste instable.',
        },
      ]),
    uploadError: null,
    uploadStatus: 201,
  },
  {
    key: '07-contradictions',
    title: 'Document avec des contradictions',
    filename: '07-contradictions.docx',
    build: () =>
      buildDocx([
        { h: 1, text: '1. Introduction' },
        {
          p: `La durée du stage est de 3 mois au sein du service informatique. ${CLEAN_PARAGRAPHS[0]}`,
        },
        { h: 1, text: '2. Bilan' },
        { p: `${CLEAN_PARAGRAPHS[11]} Au total, la durée du stage est de 6 mois.` },
      ]),
    uploadError: null,
    uploadStatus: 201,
  },
  {
    key: '08-tableaux',
    title: 'Document avec des tableaux',
    filename: '08-tableaux.docx',
    build: () =>
      buildDocx([
        { h: 1, text: 'Inventaire' },
        { p: CLEAN_PARAGRAPHS[1] ?? '' },
        {
          table: [
            ['Équipement', 'Quantité', 'Remarque'],
            ['Serveurs', '12', 'Plusieurs serveurs informatique à remplacer'],
            ['Commutateurs', '8', 'Le le modèle est ancien'],
          ],
        },
      ]),
    uploadError: null,
    uploadStatus: 201,
  },
  {
    key: '09-titres-complexes',
    title: 'Titres et sous-titres complexes',
    filename: '09-titres-complexes.docx',
    build: () =>
      buildDocx([
        { h: 1, text: '1. Introduction' },
        { p: CLEAN_PARAGRAPHS[0] ?? '' },
        { h: 2, text: '1.1 Contexte' },
        { h: 3, text: '1.1.1 Historique' },
        { p: CLEAN_PARAGRAPHS[1] ?? '' },
        { h: 4, text: '1.1.1.1 Premières versions' },
        { p: CLEAN_PARAGRAPHS[2] ?? '' },
        { h: 2, text: '1.3 Objectifs' },
        { p: CLEAN_PARAGRAPHS[3] ?? '' },
        { h: 1, text: '2. Réalisation' },
        { p: CLEAN_PARAGRAPHS[5] ?? '' },
      ]),
    uploadError: null,
    uploadStatus: 201,
  },
  {
    key: '10-vide',
    title: 'Document vide',
    filename: '10-document-vide.docx',
    build: () => buildDocx([{ p: '' }]),
    uploadError: 'EMPTY_DOCUMENT',
    uploadStatus: 422,
  },
  {
    key: '11-corrompu',
    title: 'Document corrompu',
    filename: '11-document-corrompu.docx',
    build: async () => {
      const valid = await buildDocx(CLEAN_PARAGRAPHS.map((p) => ({ p })));
      return valid.subarray(0, Math.floor(valid.length * 0.6));
    },
    uploadError: 'CORRUPTED_FILE',
    uploadStatus: 422,
  },
  {
    key: '12a-faux-pdf',
    title: 'PDF renommé en .docx',
    filename: '12a-faux-docx.docx',
    build: () => Promise.resolve(buildFakePdf()),
    uploadError: 'UNSUPPORTED_FORMAT',
    uploadStatus: 415,
  },
  {
    key: '12b-zip',
    title: 'Archive ZIP renommée en .docx',
    filename: '12b-archive.docx',
    build: buildPlainZip,
    uploadError: 'UNSUPPORTED_FORMAT',
    uploadStatus: 415,
  },
  {
    key: '12c-doc',
    title: 'Ancien format .doc',
    filename: '12c-ancien.doc',
    build: () => Promise.resolve(buildOleFile(false)),
    uploadError: 'LEGACY_DOC_FORMAT',
    uploadStatus: 415,
  },
  {
    key: '12d-chiffre',
    title: '.docx protégé par mot de passe',
    filename: '12d-protege.docx',
    build: () => Promise.resolve(buildOleFile(true)),
    uploadError: 'PASSWORD_PROTECTED',
    uploadStatus: 422,
  },
  {
    key: '13a-trop-lourd',
    title: 'Fichier de plus de 20 Mo',
    filename: '13a-trop-lourd.docx',
    build: async () => {
      const valid = await buildDocx([{ p: CLEAN_PARAGRAPHS[0] ?? '' }]);
      // Une image incompressible de 21 Mo rend le fichier trop lourd.
      return patchDocx(valid, (zip) => {
        const noise = Buffer.alloc(21 * 1024 * 1024);
        for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
        zip.file('word/media/photo.bin', noise, { compression: 'STORE' });
      });
    },
    uploadError: 'FILE_TOO_LARGE',
    uploadStatus: 413,
  },
  {
    key: '13b-trop-long',
    title: 'Document de plus de 60 000 mots',
    filename: '13b-trop-long.docx',
    build: () => buildDocx(Array.from({ length: 62 }, (_, i) => ({ p: filler(1000, i) }))),
    uploadError: 'DOCUMENT_TOO_LONG',
    uploadStatus: 422,
  },
];
