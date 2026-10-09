import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type AnalysisStatus,
  type AnalysisWarning,
  type DocumentModel,
  isTerminalStatus,
  MAX_DOCUMENT_WORDS,
  PARSER_VERSION,
} from '@wordfix/shared';
import {
  AI_FAILURE_CODES,
  AI_PROVIDER,
  AiError,
  type AiProvider,
  type TokenUsage,
} from '../ai/ai-provider.js';
import { aiModels } from '../ai/models.js';
import { guardAi } from './ai-guard.js';
import { AiUsageService } from '../ai/usage.service.js';
import { forEachConcurrent } from '../common/concurrency.js';
import { AppError } from '../common/errors/app-error.js';
import { newId } from '../common/ids.js';
import type { Env } from '../config/env.schema.js';
import { extractDocument } from '../docx/extract-document.js';
import type { AnalysisChunk, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FILE_STORAGE, type FileStorage } from '../storage/file-storage.js';
import { planContextGroups, planLocalChunks } from './chunking.js';
import { formatBlock, formatOutline, sectionIndex, wrapDocument } from './formatting.js';
import { looksFrench } from './language.js';
import { anchorExcerpt } from './postprocess/anchor.js';
import { finalizeIssues } from './postprocess/finalize.js';
import { LocationResolver } from './postprocess/location.js';
import { materialize } from './postprocess/materialize.js';
import { computeProgress, type StageCounts } from './progress.js';
import {
  CONTEXT_INSTRUCTIONS,
  GLOBAL_INSTRUCTIONS,
  LOCAL_INSTRUCTIONS,
  VERIFY_INSTRUCTIONS,
} from './prompts/prompts.v1.js';
import { checkDocumentGrammar } from './language/grammar/check-document.js';
import { getGrammalecte } from './language/grammar/grammalecte-client.js';
import {
  type AmbiguityCase,
  collectAmbiguities,
  fallbackIssues,
  planBatches,
} from './language/ambiguity/cases.js';
import { resolveAmbiguities } from './language/ambiguity/resolve.js';
import { LANGUAGE_ENGINE_CONFIG } from './language/config.js';
import { loadSpellingDictionaries } from './language/spelling/dictionaries.js';
import type { GrammarFindings } from './language/types.js';
import { runRules } from './rules/rules.js';
import { AMBIGUITY_CHUNK_INDEX } from './skipped-ai-checks.js';
import {
  contextReviewSchema,
  globalReviewSchema,
  localReviewSchema,
  type SectionDigest,
  verificationSchema,
} from './schemas.js';
import type { CandidateIssue } from './types.js';

/** Plafonds par morceau, pour signaler l'important plutôt que tout réécrire. */
const LOCAL_MAX_ISSUES = 25;
const LOCAL_MAX_STYLE = 8;
const MAX_VERIFICATIONS = 10;
/**
 * Au-delà de cette part de morceaux en échec pour une cause interne (hors IA),
 * l'analyse est considérée comme ratée.
 */
const MAX_FAILED_RATIO = 0.1;
/** Tentatives par morceau avant de le marquer en échec. */
const CHUNK_ATTEMPTS = 2;

const ACTIVE_STATUSES: AnalysisStatus[] = [
  'QUEUED',
  'EXTRACTING',
  'ANALYZING_LOCAL',
  'ANALYZING_CONTEXT',
  'ANALYZING_GLOBAL',
  'FINALIZING',
];

class AnalysisStopped extends Error {}

interface RunState {
  analysisId: string;
  documentId: string;
  model: DocumentModel;
  resolver: LocationResolver;
  modelFast: string;
  modelSmart: string;
  /** Fournisseur IA de cette analyse, avec coupe-circuit (voir ai-guard.ts). */
  ai: AiProvider;
}

interface LocalChunkPlan {
  blocks: string[];
  context: string | null;
}
interface ContextChunkPlan {
  blocks: string[];
  sections: string[];
}
/** Lot de cas ambigus du moteur de langue (étape « verify », index ≥ 100). */
interface AmbiguityChunkPlan {
  kind: 'ambiguity';
  cases: AmbiguityCase[];
}

interface VerifyChunkPlan {
  blockA: string;
  blockB: string;
  explanation: string;
  severity: CandidateIssue['severity'];
  confidence: CandidateIssue['confidence'];
}

/**
 * Exécute une analyse de bout en bout, étape par étape, en enregistrant chaque
 * résultat au fil de l'eau. L'exécution est reprenable : si le worker s'arrête,
 * la nouvelle tentative saute les morceaux déjà traités (rien n'est payé deux fois).
 */
@Injectable()
export class AnalysisRunner {
  private readonly logger = new Logger(AnalysisRunner.name);
  private readonly concurrency: number;
  private readonly modelFast: string;
  private readonly modelSmart: string;
  private readonly grammarEnabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(AI_PROVIDER) private readonly ai: AiProvider,
    private readonly usage: AiUsageService,
    config: ConfigService<Env, true>,
  ) {
    this.concurrency = config.get('AI_CONCURRENCY', { infer: true });
    const models = aiModels(config);
    this.modelFast = models.fast;
    this.modelSmart = models.smart;
    this.grammarEnabled = config.get('GRAMMAR_ENGINE', { infer: true }) === 'grammalecte';
  }

  async run(analysisId: string): Promise<void> {
    const analysis = await this.prisma.analysis.findUnique({
      where: { id: analysisId },
      include: { document: true },
    });
    if (!analysis || isTerminalStatus(analysis.status)) return;
    const log = { analysisId, documentId: analysis.documentId };
    const startedAt = Date.now();

    try {
      await this.transition(analysisId, 'EXTRACTING', {
        startedAt: analysis.startedAt ?? new Date(),
        modelFast: this.modelFast,
        modelSmart: this.modelSmart,
      });
      const { model, warnings } = await this.loadModel(analysis.document);
      const state: RunState = {
        analysisId,
        documentId: analysis.documentId,
        model,
        resolver: new LocationResolver(model),
        modelFast: this.modelFast,
        modelSmart: this.modelSmart,
        ai: guardAi(this.ai, { analysisId, logger: this.logger }),
      };
      if (analysis.chunksTotal === 0) await this.plan(state, warnings);
      this.logger.log({ ...log, stage: 'extract', words: model.meta.wordCount }, 'Document prêt');

      await this.transition(analysisId, 'ANALYZING_LOCAL');
      await this.runChunks(state, 'local', (chunk) => this.processLocal(state, chunk));

      await this.transition(analysisId, 'ANALYZING_CONTEXT');
      await this.runChunks(state, 'context', (chunk) => this.processContext(state, chunk));

      await this.transition(analysisId, 'ANALYZING_GLOBAL');
      await this.runChunks(state, 'global', () => this.processGlobal(state));
      await this.runChunks(state, 'verify', (chunk) => this.processVerify(state, chunk));

      await this.transition(analysisId, 'FINALIZING');
      await this.finalize(state);
      this.logger.log({ ...log, durationMs: Date.now() - startedAt }, 'Analyse terminée');
    } catch (error) {
      if (error instanceof AnalysisStopped) {
        this.logger.log(log, 'Analyse interrompue (annulée ou supprimée)');
        return;
      }
      if (error instanceof AppError) {
        await this.markFailed(analysisId, error.code);
        this.logger.warn({ ...log, code: error.code }, 'Analyse impossible');
        return;
      }
      if (error instanceof AiError && !error.retryable) {
        await this.markFailed(analysisId, 'AI_UNAVAILABLE');
        this.logger.error({ ...log, kind: error.kind }, 'Fournisseur IA inutilisable');
        return;
      }
      // Erreur inattendue : BullMQ retentera le job, qui reprendra où il s'est arrêté.
      throw error;
    }
  }

  /** Marque l'analyse en échec définitif (appelé aussi après le dernier essai BullMQ). */
  async markFailed(analysisId: string, errorCode: string): Promise<void> {
    await this.prisma.analysis.updateMany({
      where: { id: analysisId, status: { in: ACTIVE_STATUSES } },
      data: { status: 'FAILED', errorCode, completedAt: new Date() },
    });
  }

  // --- Étape 1 : lecture du document ------------------------------------------

  private async loadModel(document: {
    id: string;
    storageKey: string | null;
    fileDeletedAt: Date | null;
  }): Promise<{ model: DocumentModel; warnings: AnalysisWarning[] }> {
    const warnings: AnalysisWarning[] = [];
    const existing = await this.prisma.documentContent.findUnique({
      where: { documentId: document.id },
    });

    let model: DocumentModel;
    if (existing) {
      model = existing.model as unknown as DocumentModel;
      if (existing.parserVersion.includes('mammoth')) warnings.push('PARSER_FALLBACK');
    } else {
      if (!document.storageKey || document.fileDeletedAt) throw new AppError('FILE_EXPIRED');
      let buffer: Buffer;
      try {
        buffer = await this.storage.get(document.storageKey);
      } catch (error) {
        throw new AppError('FILE_EXPIRED', { cause: error });
      }
      const extraction = await extractDocument(buffer);
      model = extraction.model;
      if (extraction.usedFallback) warnings.push('PARSER_FALLBACK');

      if (model.meta.wordCount === 0) throw new AppError('EMPTY_DOCUMENT');
      if (model.meta.wordCount > MAX_DOCUMENT_WORDS) throw new AppError('DOCUMENT_TOO_LONG');

      await this.prisma.$transaction([
        this.prisma.documentContent.upsert({
          where: { documentId: document.id },
          create: {
            documentId: document.id,
            parserVersion: extraction.usedFallback ? `${PARSER_VERSION}+mammoth` : PARSER_VERSION,
            model: model as unknown as Prisma.InputJsonValue,
          },
          update: {},
        }),
        this.prisma.document.update({
          where: { id: document.id },
          data: {
            wordCount: model.meta.wordCount,
            declaredPages: model.meta.declaredPages,
            estimatedPages: model.meta.estimatedPages,
          },
        }),
      ]);
    }

    if (model.meta.headingsInferred) warnings.push('HEADINGS_INFERRED');
    if (!looksFrench(model)) warnings.push('NON_FRENCH_DOCUMENT');
    const skipped = model.meta.skipped;
    if (skipped.images + skipped.equations + skipped.textBoxes > 0)
      warnings.push('ELEMENTS_SKIPPED');
    return { model, warnings };
  }

  /** Planifie tous les appels IA et enregistre les résultats des règles déterministes. */
  private async plan(state: RunState, warnings: AnalysisWarning[]): Promise<void> {
    const local = planLocalChunks(state.model);
    const context = planContextGroups(state.model);
    const chunks: Prisma.AnalysisChunkCreateManyInput[] = [
      ...local.map((chunk, index) => ({
        id: newId('chk'),
        analysisId: state.analysisId,
        stage: 'local' as const,
        index,
        blockIds: { blocks: chunk.blockIds, context: chunk.contextBlockId },
      })),
      ...context.map((group, index) => ({
        id: newId('chk'),
        analysisId: state.analysisId,
        stage: 'context' as const,
        index,
        blockIds: { blocks: group.blockIds, sections: group.sectionIds },
      })),
      {
        id: newId('chk'),
        analysisId: state.analysisId,
        stage: 'global' as const,
        index: 0,
        blockIds: { blocks: [] },
      },
    ];

    // Les dictionnaires sont chargés une seule fois par processus (déjà fait au
    // démarrage du worker : cet appel ne fait alors qu'attendre la même instance).
    await loadSpellingDictionaries();
    const grammar = await this.checkGrammar(state);
    const ambiguity = await this.planAmbiguities(state, runRules(state.model, { grammar }));
    chunks.push(...ambiguity.chunks);
    const ruleIssues = ambiguity.direct
      .map((candidate) => materialize(candidate, state.resolver, state.analysisId))
      .flatMap((result) => (result.ok ? [result.data] : []));

    await this.prisma.$transaction([
      this.prisma.analysisChunk.createMany({ data: chunks, skipDuplicates: true }),
      this.prisma.issue.createMany({ data: ruleIssues, skipDuplicates: true }),
      this.prisma.analysis.update({
        where: { id: state.analysisId },
        data: {
          chunksTotal: chunks.length,
          warnings: warnings,
        },
      }),
    ]);
  }

  /**
   * Cas ambigus du moteur de langue (étape C) : seuls les cas que le moteur
   * déterministe ne peut pas trancher sont confiés à l'IA, par lots, dans un
   * budget strict par analyse. Les cas hors budget (ou si le plafond quotidien de
   * jetons est atteint) gardent leur forme sans IA (« À vérifier » pour un mot
   * inconnu, rien pour un mot qui existe). Les lots deviennent des morceaux de
   * l'étape « verify » : reprenables, jamais payés deux fois.
   */
  private async planAmbiguities(
    state: RunState,
    candidates: CandidateIssue[],
  ): Promise<{ direct: CandidateIssue[]; chunks: Prisma.AnalysisChunkCreateManyInput[] }> {
    const config = LANGUAGE_ENGINE_CONFIG.ambiguity;
    const { direct, cases } = collectAmbiguities(candidates, state.model, config);
    const exhausted = cases.length > 0 && (await this.usage.isExhausted());
    const { batches, overflow } = planBatches(
      cases,
      exhausted ? { maxBatches: 0, maxCasesPerBatch: 1 } : config.ai,
    );
    this.logger.log(
      {
        analysisId: state.analysisId,
        ambiguousCases: cases.length,
        sentToAi: cases.length - overflow.length,
        batches: batches.length,
        overBudget: overflow.length,
        dailyBudgetExhausted: exhausted,
      },
      'Cas ambigus du moteur de langue',
    );
    return {
      direct: [...direct, ...overflow.flatMap(fallbackIssues)],
      chunks: batches.map((batch, index) => ({
        id: newId('chk'),
        analysisId: state.analysisId,
        stage: 'verify' as const,
        index: AMBIGUITY_CHUNK_INDEX + index,
        blockIds: { kind: 'ambiguity', cases: batch } as unknown as Prisma.InputJsonValue,
      })),
    };
  }

  /** Lot de cas ambigus : décision de l'IA, ou repli de chaque cas si elle échoue. */
  private async processAmbiguity(state: RunState, plan: AmbiguityChunkPlan) {
    const config = LANGUAGE_ENGINE_CONFIG.ambiguity.ai;
    const { issues, usage, stats } = await resolveAmbiguities(
      state.ai,
      state.modelFast,
      plan.cases,
      config.maxOutputTokens,
    );
    this.logger.log(
      {
        analysisId: state.analysisId,
        ...stats,
        tokensIn: usage.inputTokens,
        tokensOut: usage.outputTokens,
      },
      stats.failed ? 'Cas ambigus : IA indisponible, repli sans IA' : 'Cas ambigus résolus',
    );
    return { issues, usage, result: stats };
  }

  /**
   * Vérification grammaticale du document par Grammalecte (processus unique du
   * worker, lots de paragraphes). En cas d'échec, l'analyse continue sans elle :
   * les autres vérifications ne doivent pas en dépendre.
   */
  private async checkGrammar(state: RunState): Promise<GrammarFindings | null> {
    if (!this.grammarEnabled) return null;
    const startedAt = Date.now();
    try {
      const findings = await checkDocumentGrammar(getGrammalecte(), state.model);
      this.logger.log(
        { analysisId: state.analysisId, durationMs: Date.now() - startedAt, blocks: findings.size },
        'Vérification grammaticale terminée',
      );
      return findings;
    } catch (error) {
      this.logger.warn(
        {
          analysisId: state.analysisId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Vérification grammaticale impossible : analyse poursuivie sans elle',
      );
      return null;
    }
  }

  // --- Exécution des morceaux --------------------------------------------------

  private async runChunks(
    state: RunState,
    stage: AnalysisChunk['stage'],
    process: (
      chunk: AnalysisChunk,
    ) => Promise<{ issues: CandidateIssue[]; usage: TokenUsage; result?: unknown }>,
  ): Promise<void> {
    const chunks = await this.prisma.analysisChunk.findMany({
      where: {
        analysisId: state.analysisId,
        stage,
        OR: [{ status: 'PENDING' }, { status: 'FAILED', attempts: { lt: CHUNK_ATTEMPTS * 2 } }],
      },
      orderBy: { index: 'asc' },
    });

    await forEachConcurrent(
      chunks,
      stage === 'local' || stage === 'context' ? this.concurrency : 2,
      async (chunk) => {
        await this.assertActive(state.analysisId);
        const started = Date.now();
        let attempt = 0;
        for (;;) {
          attempt++;
          try {
            const output = await process(chunk);
            await this.saveChunk(state, chunk, output, Date.now() - started);
            return;
          } catch (error) {
            if (error instanceof AnalysisStopped) throw error;
            // Une erreur IA, même définitive, ne concerne que ce morceau : il est
            // marqué en échec et l'analyse continue (repli sans IA).
            const aiError = error instanceof AiError ? error : null;
            if (attempt < CHUNK_ATTEMPTS && aiError?.kind === 'invalid_output') continue;
            await this.prisma.analysisChunk.update({
              where: { id: chunk.id },
              data: {
                status: 'FAILED',
                attempts: { increment: attempt },
                errorCode: aiError ? aiError.kind : 'unexpected',
              },
            });
            this.logger.warn(
              { analysisId: state.analysisId, stage, chunk: chunk.index, err: error },
              'Morceau en échec',
            );
            await this.updateProgress(state.analysisId);
            return;
          }
        }
      },
    );
  }

  private async saveChunk(
    state: RunState,
    chunk: AnalysisChunk,
    output: { issues: CandidateIssue[]; usage: TokenUsage; result?: unknown },
    durationMs: number,
  ): Promise<void> {
    const accepted: Prisma.IssueCreateManyInput[] = [];
    let rejected = 0;
    for (const candidate of output.issues) {
      const result = materialize(candidate, state.resolver, state.analysisId);
      if (result.ok) accepted.push(result.data);
      else rejected++;
    }

    await this.prisma.$transaction([
      this.prisma.issue.createMany({ data: accepted, skipDuplicates: true }),
      this.prisma.analysisChunk.update({
        where: { id: chunk.id },
        data: {
          status: 'DONE',
          attempts: { increment: 1 },
          tokensIn: output.usage.inputTokens,
          tokensOut: output.usage.outputTokens,
          issueCount: accepted.length,
          errorCode: null,
          ...(output.result !== undefined
            ? { result: output.result as Prisma.InputJsonValue }
            : {}),
        },
      }),
      this.prisma.analysis.update({
        where: { id: state.analysisId },
        data: {
          tokensIn: { increment: output.usage.inputTokens },
          tokensOut: { increment: output.usage.outputTokens },
        },
      }),
    ]);
    await this.usage.record(output.usage);
    await this.updateProgress(state.analysisId);

    this.logger.log(
      {
        analysisId: state.analysisId,
        stage: chunk.stage,
        chunk: chunk.index,
        durationMs,
        tokensIn: output.usage.inputTokens,
        tokensOut: output.usage.outputTokens,
        issues: accepted.length,
        rejected,
      },
      'Morceau analysé',
    );
  }

  // --- Étape 2 : analyse locale (phrase / paragraphe) --------------------------

  private async processLocal(state: RunState, chunk: AnalysisChunk) {
    const plan = chunk.blockIds as unknown as LocalChunkPlan;
    const allowed = new Set(plan.blocks);
    const parts: string[] = [];
    if (plan.context) {
      const block = state.resolver.block(plan.context);
      if (block) parts.push(formatBlock(block, null, true));
    }
    for (const id of plan.blocks) {
      const block = state.resolver.block(id);
      if (block) parts.push(formatBlock(block, state.resolver.sectionPath(block)));
    }

    const { data, usage } = await state.ai.generateStructured({
      model: state.modelFast,
      instructions: LOCAL_INSTRUCTIONS,
      input: wrapDocument(parts.join('\n\n')),
      schema: localReviewSchema,
      schemaName: 'local_review',
      maxOutputTokens: 12_000,
    });

    let style = 0;
    const issues: CandidateIssue[] = [];
    for (const item of data.issues) {
      if (!allowed.has(item.blockId)) continue;
      if (item.category === 'style' && ++style > LOCAL_MAX_STYLE) continue;
      issues.push({ ...item, source: 'local', relatedBlockIds: [] });
      if (issues.length >= LOCAL_MAX_ISSUES) break;
    }
    return { issues, usage };
  }

  // --- Étape 3 : analyse contextuelle (section avec son contexte) -------------

  private async processContext(state: RunState, chunk: AnalysisChunk) {
    const plan = chunk.blockIds as unknown as ContextChunkPlan;
    const allowed = new Set(plan.blocks);
    const sections = sectionIndex(state.model);
    const titles = plan.sections.map((id) => sections.get(id)?.path).filter(Boolean);

    const body = plan.blocks
      .map((id) => state.resolver.block(id))
      .filter((block) => block !== undefined)
      .map((block) => formatBlock(block, null));

    const input = [
      `Plan du document :\n${formatOutline(state.model)}`,
      `Section(s) à relire : ${titles.join(' ; ')}`,
      wrapDocument(body.join('\n\n')),
    ].join('\n\n');

    const { data, usage } = await state.ai.generateStructured({
      model: state.modelSmart,
      instructions: CONTEXT_INSTRUCTIONS,
      input,
      schema: contextReviewSchema,
      schemaName: 'context_review',
      maxOutputTokens: 10_000,
    });

    const issues: CandidateIssue[] = data.issues
      .filter((item) => allowed.has(item.blockId))
      .slice(0, 8)
      .map((item) => ({ ...item, source: 'context', relatedBlockIds: [] }));

    const digest: SectionDigest = {
      ...data.digest,
      keyFacts: data.digest.keyFacts.filter((fact) => allowed.has(fact.blockId)),
    };
    return { issues, usage, result: { digest, sections: plan.sections } };
  }

  // --- Étape 4 : analyse globale (cohérence du document entier) ----------------

  private async processGlobal(state: RunState) {
    const contextChunks = await this.prisma.analysisChunk.findMany({
      where: { analysisId: state.analysisId, stage: 'context', status: 'DONE' },
      orderBy: { index: 'asc' },
    });
    const noUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    // Moins de deux sections : rien à comparer entre parties.
    const sectionCount = contextChunks.reduce(
      (sum, c) => sum + ((c.result as { sections?: string[] } | null)?.sections?.length ?? 0),
      0,
    );
    if (contextChunks.length === 0 || sectionCount < 2) {
      return { issues: [], usage: noUsage, result: { skipped: true } };
    }

    const sections = sectionIndex(state.model);
    const sheets = contextChunks.map((c) => {
      const result = c.result as { digest: SectionDigest; sections: string[] } | null;
      if (!result) return '';
      const titles = result.sections.map((id) => sections.get(id)?.path ?? id).join(' ; ');
      const facts = result.digest.keyFacts
        .map((fact) => `  - ${fact.subject} = ${fact.value} [${fact.blockId}]`)
        .join('\n');
      return [
        `### ${titles}`,
        `Résumé : ${result.digest.summary}`,
        `Faits clés :\n${facts || '  (aucun)'}`,
        `Termes : ${result.digest.terms.join(', ') || '(aucun)'}`,
        `Temps dominant : ${result.digest.dominantTense}`,
      ].join('\n');
    });

    const { data, usage } = await state.ai.generateStructured({
      model: state.modelSmart,
      instructions: GLOBAL_INSTRUCTIONS,
      input: wrapDocument(
        `Plan :\n${formatOutline(state.model)}\n\nFiches des sections :\n\n${sheets.join('\n\n')}`,
      ),
      schema: globalReviewSchema,
      schemaName: 'global_review',
      maxOutputTokens: 8_000,
    });

    const issues: CandidateIssue[] = [];
    const verifications: VerifyChunkPlan[] = [];
    for (const item of data.issues) {
      if (!state.resolver.block(item.blockId)) continue;
      const related = item.relatedBlockIds.filter((id) => state.resolver.block(id));
      if (item.subtype === 'contradiction') {
        const other = related[0];
        if (other && verifications.length < MAX_VERIFICATIONS) {
          verifications.push({
            blockA: item.blockId,
            blockB: other,
            explanation: item.explanation,
            severity: item.severity,
            confidence: item.confidence,
          });
        }
        continue;
      }
      issues.push({
        category: item.category,
        subtype: item.subtype,
        blockId: item.blockId,
        original: null,
        suggestion: null,
        explanation: item.explanation,
        severity: item.severity,
        confidence: item.confidence,
        source: 'global',
        relatedBlockIds: related,
      });
    }

    if (verifications.length > 0) {
      const created = await this.prisma.analysisChunk.createMany({
        data: verifications.map((plan, index) => ({
          id: newId('chk'),
          analysisId: state.analysisId,
          stage: 'verify' as const,
          index,
          blockIds: plan as unknown as Prisma.InputJsonValue,
        })),
        skipDuplicates: true,
      });
      if (created.count > 0) {
        await this.prisma.analysis.update({
          where: { id: state.analysisId },
          data: { chunksTotal: { increment: created.count } },
        });
      }
    }
    return { issues, usage, result: { verifications: verifications.length } };
  }

  // --- Étape 5 : vérification ciblée des contradictions ------------------------

  private async processVerify(state: RunState, chunk: AnalysisChunk) {
    const stored = chunk.blockIds as unknown as VerifyChunkPlan | AmbiguityChunkPlan;
    if ('kind' in stored && stored.kind === 'ambiguity')
      return this.processAmbiguity(state, stored);
    const plan = stored as VerifyChunkPlan;
    const a = state.resolver.block(plan.blockA);
    const b = state.resolver.block(plan.blockB);
    const noUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    if (!a || !b) return { issues: [], usage: noUsage };

    const input = [
      `Contradiction supposée : ${plan.explanation}`,
      wrapDocument(
        `Passage A — ${state.resolver.sectionPath(a)}\n${a.text}\n\nPassage B — ${state.resolver.sectionPath(b)}\n${b.text}`,
      ),
    ].join('\n\n');

    const { data, usage } = await state.ai.generateStructured({
      model: state.modelFast,
      instructions: VERIFY_INSTRUCTIONS,
      input,
      schema: verificationSchema,
      schemaName: 'contradiction_check',
      maxOutputTokens: 3_000,
    });

    if (data.verdict === 'compatible')
      return { issues: [], usage, result: { verdict: data.verdict } };

    const excerptA = anchorExcerpt(a.text, data.excerptA) ? data.excerptA : null;
    const issue: CandidateIssue = {
      category: 'coherence',
      subtype: 'contradiction',
      blockId: a.id,
      original: excerptA,
      suggestion: null,
      explanation: data.explanation,
      severity: plan.severity,
      confidence: data.verdict === 'contradictory' ? plan.confidence : 'low',
      source: 'verify',
      relatedBlockIds: [b.id],
      relatedExcerpts: { [b.id]: data.excerptB },
      verdict: data.verdict,
    };
    return { issues: [issue], usage, result: { verdict: data.verdict } };
  }

  // --- Étape 6 : finalisation --------------------------------------------------

  private async finalize(state: RunState): Promise<void> {
    const chunks = await this.prisma.analysisChunk.findMany({
      where: { analysisId: state.analysisId },
      select: { stage: true, status: true, errorCode: true, result: true },
    });
    const failed = chunks.filter((c) => c.status !== 'DONE');
    // Échecs dus à la couche IA : non bloquants (résultats déterministes conservés).
    const aiFailed = failed.filter((c) => AI_FAILURE_CODES.has(c.errorCode ?? ''));
    // Lots de cas ambigus terminés en repli : IA indisponible, ou requête refusée.
    const ambiguityFailures = chunks
      .filter((c) => c.status === 'DONE')
      .map((c) => (c.result as { failed?: unknown } | null)?.failed)
      .filter((code): code is string => typeof code === 'string');
    const ambiguityFallback = ambiguityFailures.some((code) => AI_FAILURE_CODES.has(code));
    const ambiguityInternal = ambiguityFailures.some((code) => !AI_FAILURE_CODES.has(code));
    // Échecs internes (hors IA, dont les requêtes refusées par le fournisseur, signe
    // d'un bug WordFix) : ils peuvent toujours faire échouer l'analyse.
    const otherFailed = failed.filter((c) => !AI_FAILURE_CODES.has(c.errorCode ?? ''));
    const core = chunks.filter((c) => c.stage === 'local' || c.stage === 'context');
    const coreOtherFailed = otherFailed.filter((c) => c.stage === 'local' || c.stage === 'context');

    if (core.length > 0 && coreOtherFailed.length / core.length > MAX_FAILED_RATIO) {
      await this.markFailed(state.analysisId, 'ANALYSIS_FAILED');
      return;
    }

    const { capped, scoreDetail } = await finalizeIssues(
      this.prisma,
      state.analysisId,
      state.model.meta.wordCount,
    );

    const current = await this.prisma.analysis.findUnique({
      where: { id: state.analysisId },
      select: { warnings: true },
    });
    const warnings = new Set((current?.warnings as AnalysisWarning[] | null) ?? []);
    if (otherFailed.length > 0 || ambiguityInternal) warnings.add('PARTIAL_ANALYSIS');
    if (aiFailed.length > 0 || ambiguityFallback) warnings.add('AI_CHECKS_SKIPPED');
    if (capped) warnings.add('ISSUES_CAPPED');

    const updated = await this.prisma.analysis.updateMany({
      where: { id: state.analysisId, status: 'FINALIZING' },
      data: {
        status: 'COMPLETED',
        progress: 100,
        score: scoreDetail.score,
        scoreDetail: scoreDetail as unknown as Prisma.InputJsonValue,
        warnings: [...warnings],
        completedAt: new Date(),
      },
    });
    if (updated.count === 0) throw new AnalysisStopped();
  }

  // --- Outils -------------------------------------------------------------------

  /**
   * Change de statut seulement si l'analyse est toujours active : une analyse
   * annulée (ou supprimée) entre-temps n'est jamais « ressuscitée ».
   */
  private async transition(
    analysisId: string,
    status: AnalysisStatus,
    data: Prisma.AnalysisUpdateManyMutationInput = {},
  ): Promise<void> {
    const result = await this.prisma.analysis.updateMany({
      where: { id: analysisId, status: { in: ACTIVE_STATUSES } },
      data: { ...data, status },
    });
    if (result.count === 0) throw new AnalysisStopped();
    await this.updateProgress(analysisId);
  }

  private async assertActive(analysisId: string): Promise<void> {
    const current = await this.prisma.analysis.findUnique({
      where: { id: analysisId },
      select: { status: true },
    });
    if (!current || isTerminalStatus(current.status)) throw new AnalysisStopped();
  }

  private async updateProgress(analysisId: string): Promise<void> {
    const [analysis, groups] = await Promise.all([
      this.prisma.analysis.findUnique({ where: { id: analysisId }, select: { status: true } }),
      this.prisma.analysisChunk.groupBy({
        by: ['stage', 'status'],
        where: { analysisId },
        _count: { _all: true },
      }),
    ]);
    if (!analysis || isTerminalStatus(analysis.status)) return;

    const counts: StageCounts = {
      local: { total: 0, settled: 0 },
      context: { total: 0, settled: 0 },
      global: { total: 0, settled: 0 },
    };
    let settledAll = 0;
    for (const group of groups) {
      const key = group.stage === 'verify' ? 'global' : group.stage;
      counts[key].total += group._count._all;
      if (group.status !== 'PENDING') {
        counts[key].settled += group._count._all;
        settledAll += group._count._all;
      }
    }
    await this.prisma.analysis.updateMany({
      where: { id: analysisId, status: { in: ACTIVE_STATUSES } },
      data: { progress: computeProgress(analysis.status, counts), chunksDone: settledAll },
    });
  }
}
