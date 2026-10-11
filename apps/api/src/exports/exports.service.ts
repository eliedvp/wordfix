import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DocumentModel, ExportDto } from '@wordfix/shared';
import { AppError } from '../common/errors/app-error.js';
import { newId } from '../common/ids.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ExportQueue } from '../queue/export.queue.js';
import { QuotaService } from '../security/quota.service.js';
import { FILE_STORAGE, type FileStorage } from '../storage/file-storage.js';
import { correctedFileName, type FrozenEdit, toExportDto } from './export-mapper.js';

/**
 * Documents corrigés (API). La demande fige la liste des corrections (points acceptés
 * avec leur suggestion, points modifiés avec le texte de l'utilisateur) ; le service
 * d'export les applique ensuite à une copie de l'original. Chaque accès vérifie que
 * le document appartient à la session ; un export d'une autre session répond 404.
 */
@Injectable()
export class ExportsService {
  private readonly logger = new Logger(ExportsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: ExportQueue,
    private readonly quota: QuotaService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  async create(ownerId: string, analysisId: string): Promise<ExportDto> {
    const analysis = await this.prisma.analysis.findFirst({
      where: { id: analysisId, document: { ownerId } },
      include: { document: true },
    });
    if (!analysis) throw new AppError('NOT_FOUND');
    await this.quota.consumeExport(ownerId);
    if (analysis.status !== 'COMPLETED') throw new AppError('ANALYSIS_NOT_READY');

    const document = analysis.document;
    const now = new Date();
    if (!document.storageKey || document.fileDeletedAt || document.fileExpiresAt <= now) {
      throw new AppError('FILE_EXPIRED');
    }

    const edits = await this.frozenEdits(analysisId, document.id);
    if (edits.length === 0) throw new AppError('EXPORT_NOTHING_TO_APPLY');
    const editsHash = createHash('sha256').update(JSON.stringify(edits)).digest('hex');

    // Mêmes corrections, export encore valide : on le renvoie au lieu d'en refaire un.
    const existing = await this.prisma.export.findFirst({
      where: {
        analysisId,
        editsHash,
        status: { in: ['QUEUED', 'RUNNING', 'READY'] },
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return toExportDto(existing);

    const created = await this.prisma.export.create({
      data: {
        id: newId('exp'),
        analysisId,
        documentId: document.id,
        edits: edits as unknown as Prisma.InputJsonValue,
        editsHash,
        requestedCount: edits.length,
        // Jamais plus longtemps que le fichier d'origine (24 h après l'import).
        expiresAt: document.fileExpiresAt,
      },
    });
    await this.queue.enqueue(created.id);
    this.logger.log({ exportId: created.id, analysisId, edits: edits.length }, 'Export demandé');
    return toExportDto(created);
  }

  async get(ownerId: string, exportId: string): Promise<ExportDto> {
    const row = await this.prisma.export.findFirst({
      where: { id: exportId, document: { ownerId } },
    });
    if (!row) throw new AppError('NOT_FOUND');
    return toExportDto(row);
  }

  async download(ownerId: string, exportId: string): Promise<{ data: Buffer; fileName: string }> {
    const row = await this.prisma.export.findFirst({
      where: { id: exportId, document: { ownerId } },
      include: { document: { select: { originalName: true } } },
    });
    if (!row) throw new AppError('NOT_FOUND');
    if (row.expiresAt <= new Date()) throw new AppError('EXPORT_EXPIRED');
    if (row.status !== 'READY' || !row.storageKey) throw new AppError('EXPORT_NOT_READY');
    let data: Buffer;
    try {
      data = await this.storage.get(row.storageKey);
    } catch (error) {
      throw new AppError('EXPORT_EXPIRED', { cause: error });
    }
    return { data, fileName: correctedFileName(row.document.originalName) };
  }

  /**
   * Corrections figées : positions et textes tels qu'analysés. Le texte de référence
   * de chaque paragraphe vient du modèle enregistré ; le service d'export vérifie
   * qu'il correspond toujours au fichier avant toute modification.
   */
  private async frozenEdits(analysisId: string, documentId: string): Promise<FrozenEdit[]> {
    const issues = await this.prisma.issue.findMany({
      where: {
        analysisId,
        OR: [
          { status: 'accepted', suggestion: { not: null } },
          { status: 'edited', userText: { not: null } },
        ],
      },
      orderBy: { docOrder: 'asc' },
      select: {
        id: true,
        status: true,
        blockId: true,
        charStart: true,
        charEnd: true,
        original: true,
        suggestion: true,
        userText: true,
      },
    });
    if (issues.length === 0) return [];
    const content = await this.prisma.documentContent.findUnique({ where: { documentId } });
    const model = content?.model as DocumentModel | undefined;
    const blockTexts = new Map((model?.blocks ?? []).map((block) => [block.id, block.text]));
    return issues.map((issue) => ({
      id: issue.id,
      blockId: issue.blockId,
      start: issue.charStart,
      end: issue.charEnd,
      expectedBlockText: blockTexts.get(issue.blockId) ?? '',
      expectedOriginal: issue.original,
      replacement: (issue.status === 'edited' ? issue.userText : issue.suggestion) ?? '',
    }));
  }
}
