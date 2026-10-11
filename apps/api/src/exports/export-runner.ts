import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ErrorCode } from '@wordfix/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { exportKey, FILE_STORAGE, type FileStorage } from '../storage/file-storage.js';
import { ExportChildRunner } from './export-child-runner.js';
import type { FrozenEdit } from './export-mapper.js';

/**
 * Traitement d'un export (service d'export) : copie de l'original, corrections
 * appliquées dans un processus enfant, fichier produit enregistré à part. L'original
 * n'est jamais modifié. Les journaux ne contiennent que des identifiants, des
 * nombres, des durées et des codes : aucun texte du document.
 */
@Injectable()
export class ExportRunner {
  private readonly logger = new Logger(ExportRunner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly child: ExportChildRunner,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  /** Une panne passagère (base, stockage) est levée : BullMQ refera un essai. */
  async run(exportId: string): Promise<void> {
    const row = await this.prisma.export.findUnique({
      where: { id: exportId },
      include: { document: true },
    });
    if (!row || row.status === 'READY' || row.status === 'FAILED') return;
    const log = { exportId, analysisId: row.analysisId };
    const document = row.document;

    if (row.expiresAt <= new Date() || !document.storageKey || document.fileDeletedAt) {
      await this.markFailed(exportId, 'FILE_EXPIRED');
      this.logger.warn(log, 'Export impossible : fichier d’origine expiré');
      return;
    }
    const claimed = await this.prisma.export.updateMany({
      where: { id: exportId, status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
    if (claimed.count === 0) return;

    const source = await this.storage.get(document.storageKey);
    const edits = row.edits as unknown as FrozenEdit[];
    const startedAt = Date.now();
    const outcome = await this.child.run(source, edits);
    const durationMs = Date.now() - startedAt;

    if (outcome.kind === 'timeout') {
      await this.markFailed(exportId, 'EXPORT_TIMEOUT');
      this.logger.warn({ ...log, durationMs }, 'Export arrêté (délai dépassé)');
      return;
    }
    if (outcome.kind === 'too_large') {
      await this.markFailed(exportId, 'EXPORT_TOO_LARGE');
      this.logger.warn({ ...log, cause: outcome.cause, durationMs }, 'Export arrêté (mémoire)');
      return;
    }
    if (outcome.kind === 'error') {
      await this.markFailed(exportId, 'EXPORT_FAILED');
      this.logger.error({ ...log, problem: outcome.problem, durationMs }, 'Export en échec');
      return;
    }

    const skipped = outcome.skipped.map(({ id, reason }) => ({ issueId: id, reason }));
    if (!outcome.file || outcome.applied.length === 0) {
      // Aucune correction applicable : aucun fichier, jamais l'original à sa place.
      await this.markFailed(exportId, 'EXPORT_NO_APPLICABLE', skipped);
      this.logger.warn(
        { ...log, skipped: skipped.length, durationMs },
        'Aucune correction applicable',
      );
      return;
    }

    const key = exportKey(document.id, exportId);
    await this.storage.put(key, outcome.file);
    const done = await this.prisma.export.updateMany({
      where: { id: exportId, status: 'RUNNING' },
      data: {
        status: 'READY',
        storageKey: key,
        appliedCount: outcome.applied.length,
        skipped,
        completedAt: new Date(),
      },
    });
    if (done.count === 0) {
      // Déjà publié par une autre exécution du même export (reprise BullMQ) : même
      // fichier, on le garde. Export supprimé ou déclaré en échec entre-temps : le
      // fichier produit ne doit pas rester.
      const current = await this.prisma.export.findUnique({
        where: { id: exportId },
        select: { status: true },
      });
      if (current?.status !== 'READY') await this.storage.delete(key);
      return;
    }
    this.logger.log(
      { ...log, applied: outcome.applied.length, skipped: skipped.length, durationMs },
      'Document corrigé prêt',
    );
  }

  async markFailed(
    exportId: string,
    errorCode: ErrorCode,
    skipped: { issueId: string; reason: string }[] = [],
  ): Promise<void> {
    await this.prisma.export.updateMany({
      where: { id: exportId, status: { in: ['QUEUED', 'RUNNING'] } },
      data: {
        status: 'FAILED',
        errorCode,
        skipped,
        completedAt: new Date(),
      },
    });
  }
}
