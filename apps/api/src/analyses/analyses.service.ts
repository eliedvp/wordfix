import { Injectable, Logger } from '@nestjs/common';
import {
  type AnalysisDto,
  type BlockContextDto,
  type DocumentModel,
  type IssueCategory,
  type IssueDto,
  type IssueListDto,
  type IssueLocationDto,
  type IssueNature,
  isTerminalStatus,
} from '@wordfix/shared';
import { AiUsageService } from '../ai/usage.service.js';
import { AppError } from '../common/errors/app-error.js';
import { newId } from '../common/ids.js';
import { PROMPT_VERSION } from '../engine/prompts/prompts.v1.js';
import { LocationResolver } from '../engine/postprocess/location.js';
import type { Issue, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AnalysisQueue } from '../queue/analysis.queue.js';
import { QuotaService } from '../security/quota.service.js';
import { toAnalysisDto } from './analysis-mapper.js';
import type { ListIssuesQuery } from './dto/list-issues.query.js';

const BLOCK_TEXT_LIMIT = 4000;

@Injectable()
export class AnalysesService {
  private readonly logger = new Logger(AnalysesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: AnalysisQueue,
    private readonly usage: AiUsageService,
    private readonly quota: QuotaService,
  ) {}

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
    if (await this.usage.isExhausted()) throw new AppError('AI_BUDGET_EXHAUSTED');
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
    if (content) {
      const model = content.model as unknown as DocumentModel;
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
    return { items: dtos, total, blocks };
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
