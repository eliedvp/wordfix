import type { AiProvider, StructuredRequest, StructuredResult } from '../ai-provider.js';

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
  calls: string[] = [];

  generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls.push(request.schemaName);
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      return Promise.reject(error);
    }
    const data = request.schema.parse(this.respond(request.schemaName, request.input));
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
