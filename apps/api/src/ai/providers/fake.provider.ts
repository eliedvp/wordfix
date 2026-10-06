import {
  AiError,
  type AiProvider,
  type StructuredRequest,
  type StructuredResult,
} from '../ai-provider.js';

/**
 * Fournisseur déterministe, RÉSERVÉ AUX TESTS AUTOMATISÉS (refusé par la
 * configuration hors NODE_ENV=test). Il ne « devine » rien : il réagit à des
 * marqueurs connus placés dans les documents de test, pour exercer tout le
 * pipeline (ancrage, nature, déduplication, contradictions) sans appel réseau.
 */

/** Fautes connues : extrait fautif → correction. */
export const FAKE_TYPOS: Record<string, string> = {
  'serveurs informatique': 'serveurs informatiques',
  'les donné ': 'les données ',
  'il ont': 'ils ont',
  'nous avons réalisés': 'nous avons réalisé',
};

/**
 * Cas ambigus du moteur de langue : expressions que le faux fournisseur « connaît ».
 * Il choisit l'option qui, remise dans la phrase, forme une de ces expressions ;
 * sinon il répond « verify ». Il garde le mot tel quel s'il figure dans FAKE_KEEP.
 */
export const FAKE_COLLOCATIONS = [
  'permis de conduire',
  'dans le cadre de',
  'les tâches qui',
  'la communication interne',
  'les utilisateurs ont',
];
export const FAKE_KEEP = ['floculés'];

const CASE_BLOCK =
  /\[(c\d+)\]\nMot : « ([^\n]*) »\nPhrase : « ([^\n]*) »\nInformation : [^\n]*\nOptions :\n((?: {2}[a-z]\) [^\n]*\n?)+)/g;
const OPTION_LINE = /^ {2}[a-z]\) (?:remplacer « (.*) » par « (.*) »|« (.*) »)$/;

function ambiguityDecisions(input: string): unknown {
  const decisions = [...input.matchAll(CASE_BLOCK)].map((match) => {
    const [, caseId = '', word = '', phrase = '', optionLines = ''] = match;
    if (FAKE_KEEP.includes(word)) {
      return {
        caseId,
        decision: 'keep',
        correction: null,
        justification: 'Mot existant.',
        confidence: 'medium',
      };
    }
    for (const line of optionLines.split('\n')) {
      const option = OPTION_LINE.exec(line);
      if (!option) continue;
      const original = option[1] ?? word;
      const replacement = option[2] ?? option[3] ?? '';
      const candidate = phrase.replace(original, replacement).toLocaleLowerCase('fr');
      if (FAKE_COLLOCATIONS.some((expression) => candidate.includes(expression))) {
        return {
          caseId,
          decision: 'correct',
          correction: replacement,
          justification: 'Expression usuelle.',
          confidence: 'high',
        };
      }
    }
    return {
      caseId,
      decision: 'verify',
      correction: null,
      justification: 'Contexte insuffisant.',
      confidence: 'low',
    };
  });
  return { decisions };
}

const BLOCK_LINE = /^\[(b_\d{6})\] \(([^)]*)\)\n([^\n]*)/gm;

function blocksOf(input: string): { id: string; label: string; text: string }[] {
  return [...input.matchAll(BLOCK_LINE)].map((m) => ({
    id: m[1] ?? '',
    label: m[2] ?? '',
    text: m[3] ?? '',
  }));
}

export class FakeAiProvider implements AiProvider {
  readonly name = 'fake';
  /** Permet aux tests de simuler une panne du fournisseur. */
  failNext: Error | null = null;
  /** Panne d'une étape précise (tous ses appels), pour tester un repli ciblé. */
  failSchemas = new Map<string, Error>();
  /** Réponse brute imposée pour une étape (réponse invalide, option inventée…). */
  responses = new Map<string, unknown>();
  calls: string[] = [];

  generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls.push(request.schemaName);
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      return Promise.reject(error);
    }
    const failure = this.failSchemas.get(request.schemaName);
    if (failure) return Promise.reject(failure);
    const raw = this.responses.has(request.schemaName)
      ? this.responses.get(request.schemaName)
      : this.respond(request.schemaName, request.input);
    // Comme le vrai fournisseur : une réponse hors schéma est une erreur « invalid_output ».
    const parsed = request.schema.safeParse(raw);
    if (!parsed.success) {
      return Promise.reject(
        new AiError('invalid_output', 'réponse hors schéma (fournisseur de test)'),
      );
    }
    const data = parsed.data;
    return Promise.resolve({
      data,
      usage: {
        inputTokens: Math.ceil(request.input.length / 4),
        outputTokens: 50,
        cachedTokens: 0,
      },
    });
  }

  private respond(schemaName: string, input: string): unknown {
    const blocks = blocksOf(input).filter((b) => !b.label.startsWith('CONTEXTE'));
    switch (schemaName) {
      case 'local_review':
        return {
          issues: blocks.flatMap((block) =>
            Object.entries(FAKE_TYPOS)
              .filter(([wrong]) => block.text.includes(wrong))
              .map(([wrong, right]) => ({
                blockId: block.id,
                category: 'grammar',
                subtype: 'agreement',
                original: wrong,
                suggestion: right,
                explanation: 'Accord à corriger.',
                severity: 'major',
                confidence: 'high',
              })),
          ),
        };
      case 'context_review': {
        const facts = blocks.flatMap((block) => {
          const match = /durée du stage est de (\d+ mois)/i.exec(block.text);
          return match
            ? [{ subject: 'durée du stage', value: match[1] ?? '', blockId: block.id }]
            : [];
        });
        return {
          issues: blocks
            .filter((block) => block.text.includes('Par ailleurs, sans transition'))
            .map((block) => ({
              blockId: block.id,
              category: 'structure',
              subtype: 'weak_transition',
              original: 'Par ailleurs, sans transition',
              suggestion: null,
              explanation: 'Le passage semble abrupt ; une transition pourrait aider.',
              severity: 'minor',
              confidence: 'medium',
            })),
          digest: {
            summary: 'Résumé de test.',
            keyFacts: facts,
            terms: [],
            dominantTense: 'present',
          },
        };
      }
      case 'global_review': {
        const facts = [...input.matchAll(/durée du stage = ([^\n]+) \[(b_\d{6})\]/g)];
        const distinct = new Map(facts.map((m) => [m[1], m[2]]));
        if (distinct.size < 2) return { issues: [] };
        const [first, second] = [...distinct.values()];
        return {
          issues: [
            {
              category: 'coherence',
              subtype: 'contradiction',
              blockId: first,
              relatedBlockIds: [second],
              explanation: 'La durée du stage semble différente selon les sections.',
              severity: 'major',
              confidence: 'medium',
            },
          ],
        };
      }
      case 'language_ambiguity':
        return ambiguityDecisions(input);
      case 'contradiction_check': {
        const durations = [...input.matchAll(/(\d+ mois)/g)].map((m) => m[1] ?? '');
        return {
          verdict: new Set(durations).size > 1 ? 'contradictory' : 'compatible',
          excerptA: durations[0] ?? '',
          excerptB: durations[1] ?? '',
          explanation: 'Les deux passages pourraient indiquer des durées différentes.',
        };
      }
      default:
        throw new Error(`schéma inconnu : ${schemaName}`);
    }
  }
}
