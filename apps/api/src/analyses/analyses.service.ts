import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type AcceptReliableResultDto,
  type AnalysisDto,
  type BlockContextDto,
  type DocumentModel,
  type DocumentStructureDto,
  type IssueCategory,
  type IssueDto,
  type IssueListDto,
  type IssueLocationDto,
  type IssueNature,
  isReliableCorrection,
  isTerminalStatus,
  RELIABLE_CATEGORIES,
  type UndoAcceptResultDto,
} from '@wordfix/shared';
import { aiEnabled } from '../ai/models.js';
import { AiUsageService } from '../ai/usage.service.js';
import { AppError } from '../common/errors/app-error.js';
import type { Env } from '../config/env.schema.js';
import { newId } from '../common/ids.js';
import { PROMPT_VERSION } from '../engine/prompts/prompts.v1.js';
import { LocationResolver } from '../engine/postprocess/location.js';
import { summarizeStructure } from '../engine/structure.js';
import type { Issue, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AnalysisQueue } from '../queue/analysis.queue.js';
import { QuotaService } from '../security/quota.service.js';
import { reviewedIssuesWhere, toAnalysisDto } from './analysis-mapper.js';
import type { ListIssuesQuery } from './dto/list-issues.query.js';

const BLOCK_TEXT_LIMIT = 4000;

@Injectable()
export class AnalysesService {
  private readonly logger = new Logger(AnalysesService.name);
  private readonly aiEnabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: AnalysisQueue,
    private readonly usage: AiUsageService,
    private readonly quota: QuotaService,
    config: ConfigService<Env, true>,
  ) {
    this.aiEnabled = aiEnabled(config);
  }

  /**
   * Lance l'analyse d'un document (2e temps de l'import). Une seule analyse active
   * par document ; le fichier d'origine doit encore être disponible.
   */
  async start(ownerId: string, documentId: string, ip: string): Promise<{ analysisId: string }> {
    const document = await this.prisma.document.findFirst({
      where: { id: documentId, ownerId },
      include: { analyses: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    if (!document) throw new AppError('NOT_FOUND');
    const latest = document.analyses[0];
    if (latest && !isTerminalStatus(latest.status)) throw new AppError('ANALYSIS_IN_PROGRESS');
    if (!document.storageKey || document.fileDeletedAt) throw new AppError('FILE_EXPIRED');
    // Le budget IA ne concerne que les analyses avec IA : sans IA, l'analyse locale
    // n'est jamais refusée pour une question de budget.
    if (this.aiEnabled && (await this.usage.isExhausted())) {
      throw new AppError('AI_BUDGET_EXHAUSTED');
    }
    await this.quota.assertCanAnalyze(ownerId, ip);

    const analysis = await this.prisma.analysis.create({
      data: { id: newId('ana'), documentId, promptVersion: PROMPT_VERSION },
    });
    try {
      await this.queue.enqueue(analysis.id);
    } catch (error) {
      await this.prisma.analysis.update({
        where: { id: analysis.id },
        data: { status: 'FAILED', errorCode: 'ANALYSIS_FAILED', completedAt: new Date() },
      });
      throw error;
    }
    await this.quota.recordAnalysis(ownerId, ip);
    this.logger.log({ analysisId: analysis.id, documentId }, 'Analyse mise en file');
    return { analysisId: analysis.id };
  }

  async get(ownerId: string, analysisId: string): Promise<AnalysisDto> {
    return toAnalysisDto(this.prisma, await this.findOwned(ownerId, analysisId));
  }

  /** Annule une analyse en attente ou en cours ; le worker s'arrête au prochain point de contrôle. */
  async cancel(ownerId: string, analysisId: string): Promise<AnalysisDto> {
    const analysis = await this.findOwned(ownerId, analysisId);
    if (isTerminalStatus(analysis.status)) throw new AppError('ANALYSIS_NOT_CANCELABLE');
    const updated = await this.prisma.analysis.updateMany({
      where: { id: analysisId, status: analysis.status },
      data: { status: 'CANCELED', canceledAt: new Date(), completedAt: new Date() },
    });
    if (updated.count === 0) throw new AppError('ANALYSIS_NOT_CANCELABLE');
    await this.queue.removeIfPending(analysisId);
    this.logger.log({ analysisId }, 'Analyse annulée par l’utilisateur');
    return this.get(ownerId, analysisId);
  }

  async listIssues(
    ownerId: string,
    analysisId: string,
    query: ListIssuesQuery,
  ): Promise<IssueListDto> {
    const analysis = await this.findOwned(ownerId, analysisId);
    const where: Prisma.IssueWhereInput = { analysisId };
    if (query.category) where.category = { in: query.category.split(',') as IssueCategory[] };
    if (query.nature) where.nature = { in: query.nature.split(',') as IssueNature[] };
    if (query.status === 'open') where.status = 'open';
    if (query.status === 'done') where.status = { not: 'open' };

    const [items, total, content] = await Promise.all([
      this.prisma.issue.findMany({
        where,
        orderBy: [{ docOrder: 'asc' }, { charStart: 'asc' }],
        take: query.limit ?? 500,
        skip: query.offset ?? 0,
      }),
      this.prisma.issue.count({ where }),
      this.prisma.documentContent.findUnique({ where: { documentId: analysis.documentId } }),
    ]);

    const dtos = items.map(toIssueDto);
    const blocks: Record<string, BlockContextDto> = {};
    // Contenu extrait supprimé (expiration) : structure inconnue, jamais supposée.
    let structure: DocumentStructureDto | null = null;
    if (content) {
      const model = content.model as unknown as DocumentModel;
      structure = summarizeStructure(model);
      const resolver = new LocationResolver(model);
      const wanted = new Set(
        dtos.flatMap((dto) => [dto.location.blockId, ...dto.related.map((r) => r.blockId)]),
      );
      for (const dto of dtos) {
        dto.location.label = resolver.resolve(dto.location.blockId, 0, 0)?.label ?? null;
      }
      for (const id of wanted) {
        const block = resolver.block(id);
        if (!block) continue;
        blocks[id] = {
          id,
          kind: block.kind,
          text: block.text.slice(0, BLOCK_TEXT_LIMIT),
          sectionPath: resolver.sectionPath(block),
        };
      }
    }
    return { items: dtos, total, blocks, structure };
  }

  /**
   * « Tout corriger » : accepte d'un coup les corrections fiables encore à traiter
   * (règle partagée isReliableCorrection). Les décisions déjà prises par
   * l'utilisateur ne sont jamais modifiées. Renvoie les points acceptés par cette
   * action, pour pouvoir l'annuler.
   */
  async acceptReliable(ownerId: string, analysisId: string): Promise<AcceptReliableResultDto> {
    const analysis = await this.findOwned(ownerId, analysisId);
    if (analysis.status !== 'COMPLETED') throw new AppError('ANALYSIS_NOT_READY');
    const result = await this.prisma.$transaction(async (tx) => {
      const candidates = await tx.issue.findMany({
        where: {
          analysisId,
          status: 'open',
          category: { in: [...RELIABLE_CATEGORIES] },
          nature: 'error',
          confidence: 'high',
          suggestion: { not: null },
        },
        select: {
          id: true,
          status: true,
          category: true,
          nature: true,
          confidence: true,
          original: true,
          suggestion: true,
        },
      });
      const ids = candidates.filter(isReliableCorrection).map((issue) => issue.id);
      if (ids.length > 0) {
        await tx.issue.updateMany({
          where: { analysisId, id: { in: ids }, status: 'open' },
          data: { status: 'accepted', userText: null },
        });
      }
      return { acceptedIds: ids, analysis: await this.progress(tx, analysisId) };
    });
    this.logger.log(
      { analysisId, accepted: result.acceptedIds.length },
      'Corrections fiables acceptées (Tout corriger)',
    );
    return result;
  }

  /**
   * Annulation de « Tout corriger » : les points indiqués redeviennent « à traiter »,
   * seulement s'ils sont encore acceptés (une décision prise depuis est conservée).
   */
  async undoAccept(
    ownerId: string,
    analysisId: string,
    issueIds: string[],
  ): Promise<UndoAcceptResultDto> {
    await this.findOwned(ownerId, analysisId);
    const result = await this.prisma.$transaction(async (tx) => {
      const accepted = await tx.issue.findMany({
        where: { analysisId, id: { in: issueIds }, status: 'accepted' },
        select: { id: true },
      });
      const ids = accepted.map((issue) => issue.id);
      if (ids.length > 0) {
        await tx.issue.updateMany({
          where: { analysisId, id: { in: ids }, status: 'accepted' },
          data: { status: 'open', userText: null },
        });
      }
      return { reopenedIds: ids, analysis: await this.progress(tx, analysisId) };
    });
    this.logger.log({ analysisId, reopened: result.reopenedIds.length }, 'Tout corriger annulé');
    return result;
  }

  private async progress(tx: Prisma.TransactionClient, analysisId: string) {
    const [reviewedCount, issueCount] = await Promise.all([
      tx.issue.count({ where: reviewedIssuesWhere(analysisId) }),
      tx.issue.count({ where: { analysisId } }),
    ]);
    return { id: analysisId, reviewedCount, issueCount };
  }

  private async findOwned(ownerId: string, analysisId: string) {
    const analysis = await this.prisma.analysis.findFirst({
      where: { id: analysisId, document: { ownerId } },
      include: { document: true },
    });
    if (!analysis) throw new AppError('NOT_FOUND');
    return analysis;
  }
}

export function toIssueDto(issue: Issue): IssueDto {
  const related = (issue.related as unknown as IssueLocationDto[] | null) ?? [];
  return {
    id: issue.id,
    category: issue.category,
    subtype: issue.subtype,
    nature: issue.nature,
    severity: issue.severity,
    confidence: issue.confidence,
    source: issue.source,
    location: {
      blockId: issue.blockId,
      sectionPath: issue.sectionPath,
      paragraphInSection: issue.paragraphInSection,
      estimatedPage: issue.estimatedPage,
      charStart: issue.charStart,
      charEnd: issue.charEnd,
      label: null,
    },
    related,
    original: issue.original,
    suggestion: issue.suggestion,
    explanation: issue.explanation,
    status: issue.status,
    userText: issue.userText,
    docOrder: issue.docOrder,
  };
}
