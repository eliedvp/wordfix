import type { Block, DocumentModel } from '@wordfix/shared';
import type { CandidateIssue } from '../types.js';

/**
 * Règles déterministes : gratuites, instantanées et fiables. Elles couvrent ce
 * qu'un programme vérifie mieux qu'un modèle (mots doublés, numérotation des
 * titres, sommaire, graphies concurrentes, sigles, phrases très longues).
 * Chaque règle est plafonnée pour ne jamais noyer l'utilisateur.
 */

const LANGUAGE_BLOCKS = new Set<Block['kind']>([
  'paragraph',
  'list_item',
  'table_cell',
  'caption',
  'footnote',
  'endnote',
]);
const PROSE_BLOCKS = new Set<Block['kind']>(['paragraph', 'list_item', 'footnote', 'endnote']);

export const RULE_CAPS = {
  repeatedWord: 30,
  doubleSpace: 10,
  longSentence: 15,
  headingNumbering: 10,
  acronym: 5,
  terminology: 8,
  toc: 5,
};

/** Seuil au-delà duquel une phrase est signalée comme très longue. */
export const LONG_SENTENCE_WORDS = 45;

export function runRules(model: DocumentModel): CandidateIssue[] {
  return [
    ...repeatedWords(model),
    ...doubleSpaces(model),
    ...longSentences(model),
    ...headingNumbering(model),
    ...undefinedAcronyms(model),
    ...terminologyVariants(model),
    ...tocMismatch(model),
  ];
}

function issue(
  partial: Omit<CandidateIssue, 'source' | 'relatedBlockIds'> & { relatedBlockIds?: string[] },
): CandidateIssue {
  return { source: 'rules', relatedBlockIds: [], ...partial };
}

// --- Mots doublés : « le le », « de de » ------------------------------------

/** Répétitions légitimes en français (« nous nous sommes », « vous vous êtes »). */
const ALLOWED_REPEATS = new Set(['nous', 'vous']);

function repeatedWords(model: DocumentModel): CandidateIssue[] {
  const out: CandidateIssue[] = [];
  const pattern = /(?<![\p{L}\p{N}])(\p{L}{1,30})[ \u00a0]+(\1)(?![\p{L}\p{N}])/giu;
  for (const block of model.blocks) {
    if (!LANGUAGE_BLOCKS.has(block.kind)) continue;
    for (const match of block.text.matchAll(pattern)) {
      const word = match[1] ?? '';
      if (ALLOWED_REPEATS.has(word.toLowerCase())) continue;
      if (word.toLowerCase() !== (match[2] ?? '').toLowerCase()) continue;
      const start = match.index;
      out.push(
        issue({
          category: 'spelling',
          subtype: 'typo',
          blockId: block.id,
          original: match[0],
          suggestion: word,
          explanation: `Le mot « ${word} » est écrit deux fois de suite.`,
          severity: 'major',
          confidence: 'high',
          range: { start, end: start + match[0].length },
        }),
      );
      if (out.length >= RULE_CAPS.repeatedWord) return out;
    }
  }
  return out;
}

// --- Espaces doubles entre deux mots ----------------------------------------

function doubleSpaces(model: DocumentModel): CandidateIssue[] {
  const out: CandidateIssue[] = [];
  for (const block of model.blocks) {
    if (!PROSE_BLOCKS.has(block.kind)) continue;
    for (const match of block.text.matchAll(/(?<=\S) {2,}(?=\S)/g)) {
      const start = match.index;
      out.push(
        issue({
          category: 'punctuation',
          subtype: 'spacing',
          blockId: block.id,
          original: match[0],
          suggestion: ' ',
          explanation: 'Deux espaces se suivent entre ces mots.',
          severity: 'minor',
          confidence: 'high',
          range: { start, end: start + match[0].length },
        }),
      );
      if (out.length >= RULE_CAPS.doubleSpace) return out;
    }
  }
  return out;
}

// --- Phrases très longues ----------------------------------------------------

function longSentences(model: DocumentModel): CandidateIssue[] {
  const out: CandidateIssue[] = [];
  for (const block of model.blocks) {
    if (!PROSE_BLOCKS.has(block.kind)) continue;
    for (const sentence of block.sentences) {
      const text = block.text.slice(sentence.start, sentence.end);
      const words = text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
      if (words <= LONG_SENTENCE_WORDS) continue;
      out.push(
        issue({
          category: 'style',
          subtype: 'too_long',
          blockId: block.id,
          original: text,
          suggestion: null,
          explanation: `Cette phrase compte ${words} mots : la découper pourrait la rendre plus facile à lire.`,
          severity: 'minor',
          confidence: 'medium',
          range: { start: sentence.start, end: sentence.end },
        }),
      );
      if (out.length >= RULE_CAPS.longSentence) return out;
    }
  }
  return out;
}

// --- Numérotation des titres : 1.2 puis 1.4 ----------------------------------

function headingNumbering(model: DocumentModel): CandidateIssue[] {
  const out: CandidateIssue[] = [];
  const last = new Map<number, number[]>();

  for (const block of model.blocks) {
    if (block.kind !== 'heading') continue;
    const match = /^\s*(\d+(?:\.\d+)*)\.?\s+\S/.exec(block.text);
    if (!match?.[1]) continue;
    const parts = match[1].split('.').map(Number);
    const depth = parts.length;

    // Un titre de niveau supérieur réinitialise la numérotation des niveaux inférieurs.
    for (const key of [...last.keys()]) if (key > depth) last.delete(key);

    const previous = last.get(depth);
    const sameParent =
      previous !== undefined && previous.slice(0, -1).join('.') === parts.slice(0, -1).join('.');
    const current = parts.at(-1) ?? 0;
    const expected = sameParent ? (previous.at(-1) ?? 0) + 1 : null;
    last.set(depth, parts);

    if (expected === null || current === expected) continue;
    const previousLabel = previous?.join('.') ?? '';
    const expectedLabel = [...parts.slice(0, -1), expected].join('.');
    out.push(
      issue({
        category: 'structure',
        subtype: 'heading_numbering',
        blockId: block.id,
        original: match[1],
        suggestion: null,
        explanation: `La numérotation passe de « ${previousLabel} » à « ${match[1]} ». Vérifiez si une partie « ${expectedLabel} » est prévue ou si la numérotation est à corriger.`,
        severity: 'major',
        confidence: 'high',
        range: {
          start: match.index + match[0].indexOf(match[1]),
          end: match.index + match[0].indexOf(match[1]) + match[1].length,
        },
      }),
    );
    if (out.length >= RULE_CAPS.headingNumbering) break;
  }
  return out;
}

// --- Sigles jamais définis ---------------------------------------------------

/** Sigles d'usage courant qu'il serait pédant de signaler. */
const COMMON_ACRONYMS = new Set([
  'PDF',
  'URL',
  'HTML',
  'CSS',
  'SQL',
  'API',
  'USB',
  'PC',
  'TV',
  'OK',
  'CV',
  'PME',
  'SA',
  'SAS',
  'SARL',
  'UE',
  'ONU',
  'IT',
  'IA',
  'AI',
  'FAQ',
  'PIB',
  'TVA',
  'HT',
  'TTC',
  'RH',
  'DG',
  'CEO',
  'GPS',
  'WIFI',
  'ID',
  'NB',
  'PS',
  'ETC',
  'OS',
  'CPU',
  'RAM',
  'IP',
  'HTTP',
  'HTTPS',
  'XML',
  'JSON',
]);
const GLOSSARY_HEADING = /sigles|acronymes|abréviations|glossaire/i;

function undefinedAcronyms(model: DocumentModel): CandidateIssue[] {
  const body = model.blocks.filter((b) => b.part === 'body' && b.kind !== 'toc_entry');
  if (body.some((b) => b.kind === 'heading' && GLOSSARY_HEADING.test(b.text))) return [];

  const allText = body.map((b) => b.text).join('\n');
  const first = new Map<string, { block: Block; start: number }>();
  const counts = new Map<string, number>();

  for (const block of body) {
    if (block.kind === 'heading') continue;
    for (const match of block.text.matchAll(/(?<![\p{L}\p{N}])(\p{Lu}{2,6})s?(?![\p{L}\p{N}])/gu)) {
      const acronym = match[1] ?? '';
      if (COMMON_ACRONYMS.has(acronym) || /^[IVXLCDM]+$/.test(acronym)) continue;
      counts.set(acronym, (counts.get(acronym) ?? 0) + 1);
      if (!first.has(acronym)) first.set(acronym, { block, start: match.index });
    }
  }

  const out: CandidateIssue[] = [];
  for (const [acronym, count] of counts) {
    if (count < 2) continue;
    const escaped = acronym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const defined = new RegExp(`\\(\\s*${escaped}\\s*\\)|${escaped}\\s*\\(|${escaped}\\s*:`, 'u');
    if (defined.test(allText)) continue;
    const occurrence = first.get(acronym);
    if (!occurrence) continue;
    out.push(
      issue({
        category: 'coherence',
        subtype: 'acronym',
        blockId: occurrence.block.id,
        original: acronym,
        suggestion: null,
        explanation: `Le sigle « ${acronym} » semble utilisé sans être défini. Vérifiez qu’il est expliqué à sa première apparition.`,
        severity: 'minor',
        confidence: 'medium',
        range: { start: occurrence.start, end: occurrence.start + acronym.length },
      }),
    );
    if (out.length >= RULE_CAPS.acronym) break;
  }
  return out;
}

// --- Graphies concurrentes : « e-mail » / « email » ---------------------------

function terminologyVariants(model: DocumentModel): CandidateIssue[] {
  type Occurrence = { block: Block; start: number; surface: string };
  const groups = new Map<string, Map<string, Occurrence[]>>();

  for (const block of model.blocks) {
    if (block.part !== 'body' || block.kind === 'toc_entry') continue;
    for (const match of block.text.matchAll(/\p{L}+(?:-\p{L}+)+|\p{L}{4,}/gu)) {
      const surface = match[0];
      const lower = surface.toLowerCase();
      const key = lower.replace(/-/g, '');
      const byForm = groups.get(key) ?? new Map<string, Occurrence[]>();
      const list = byForm.get(lower) ?? [];
      list.push({ block, start: match.index, surface });
      byForm.set(lower, list);
      groups.set(key, byForm);
    }
  }

  const out: CandidateIssue[] = [];
  for (const byForm of groups.values()) {
    if (byForm.size < 2) continue;
    // Seules les différences de trait d'union comptent ici.
    const forms = [...byForm.entries()].sort((a, b) => b[1].length - a[1].length);
    const [major, minor] = forms;
    if (!major || !minor) continue;
    const occurrence = minor[1][0];
    const reference = major[1][0];
    if (!occurrence || !reference) continue;
    out.push(
      issue({
        category: 'coherence',
        subtype: 'terminology_variant',
        blockId: occurrence.block.id,
        original: occurrence.surface,
        suggestion:
          reference.surface.toLowerCase() === reference.surface ? major[0] : reference.surface,
        explanation: `« ${occurrence.surface} » et « ${reference.surface} » sont tous deux employés dans le document. Une seule graphie serait plus cohérente.`,
        severity: 'minor',
        confidence: 'high',
        range: { start: occurrence.start, end: occurrence.start + occurrence.surface.length },
        relatedBlockIds: [reference.block.id],
      }),
    );
    if (out.length >= RULE_CAPS.terminology) break;
  }
  return out;
}

// --- Sommaire qui ne correspond plus aux titres -------------------------------

function normalizeTitle(text: string): string {
  return text
    .replace(/[\t.…\s]+\d+\s*$/u, '') // numéro de page en fin d'entrée
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function tocMismatch(model: DocumentModel): CandidateIssue[] {
  const entries = model.blocks.filter((b) => b.kind === 'toc_entry');
  const headings = model.blocks
    .filter((b) => b.kind === 'heading')
    .map((b) => normalizeTitle(b.text));
  if (entries.length === 0 || headings.length === 0) return [];

  const out: CandidateIssue[] = [];
  for (const entry of entries) {
    const title = normalizeTitle(entry.text);
    if (title.length < 3 || /^(table des matières|sommaire)$/.test(title)) continue;
    if (headings.some((h) => h === title || h.startsWith(title) || title.startsWith(h))) continue;
    const visible = entry.text.replace(/[\t.…\s]+\d+\s*$/u, '').trim();
    const start = entry.text.indexOf(visible);
    out.push(
      issue({
        category: 'structure',
        subtype: 'toc_mismatch',
        blockId: entry.id,
        original: visible,
        suggestion: null,
        explanation:
          'Cette entrée du sommaire ne correspond à aucun titre du document. Le sommaire est peut-être à mettre à jour (dans Word : clic droit sur le sommaire, « Mettre à jour les champs »).',
        severity: 'major',
        confidence: 'high',
        range: { start, end: start + visible.length },
      }),
    );
    if (out.length >= RULE_CAPS.toc) break;
  }
  return out;
}
