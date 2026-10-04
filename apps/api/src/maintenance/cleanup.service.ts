import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { FILE_STORAGE, type FileStorage } from '../storage/file-storage.js';

const BATCH = 100;
/** Une analyse « active » depuis plus longtemps a perdu son job (Redis vidé, panne). */
const STALE_ANALYSIS_MS = 2 * 60 * 60 * 1000;
/** Les sessions invitées sans document sont oubliées après 30 jours d'inactivité. */
const GUEST_INACTIVITY_MS = 30 * 24 * 60 * 60 * 1000;

export interface CleanupReport {
  filesDeleted: number;
  documentsDeleted: number;
  staleAnalyses: number;
  guestsDeleted: number;
}

/**
 * Cycle de vie des documents (décision D6), exécuté toutes les heures par le worker :
 * - fichier source supprimé au plus tard 24 h après l'import ;
 * - texte extrait, analyses et résultats supprimés après 7 jours (document entier) ;
 * - analyses bloquées marquées en échec, sessions invitées inactives oubliées.
 */
@Injectable()
export class CleanupService {
  private readonly logger = new Logger(CleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  async run(now = new Date()): Promise<CleanupReport> {
    const report: CleanupReport = {
      filesDeleted: 0,
      documentsDeleted: 0,
      staleAnalyses: 0,
      guestsDeleted: 0,
    };

    // 1. Documents arrivés au bout de la conservation : tout est supprimé.
    for (;;) {
      const expired = await this.prisma.document.findMany({
        where: { contentExpiresAt: { lte: now } },
        select: { id: true, storageKey: true },
        take: BATCH,
      });
      if (expired.length === 0) break;
      for (const document of expired) {
        if (document.storageKey) await this.storage.delete(document.storageKey);
      }
      const { count } = await this.prisma.document.deleteMany({
        where: { id: { in: expired.map((d) => d.id) } },
      });
      report.documentsDeleted += count;
    }

    // 2. Fichiers source de plus de 24 h.
    for (;;) {
      const files = await this.prisma.document.findMany({
        where: { fileExpiresAt: { lte: now }, storageKey: { not: null } },
        select: { id: true, storageKey: true },
        take: BATCH,
      });
      if (files.length === 0) break;
      for (const file of files) {
        if (file.storageKey) await this.storage.delete(file.storageKey);
        await this.prisma.document.update({
          where: { id: file.id },
          data: { storageKey: null, fileDeletedAt: now },
        });
        report.filesDeleted++;
      }
    }

    // 3. Analyses restées actives trop longtemps (job perdu).
    const stale = await this.prisma.analysis.updateMany({
      where: {
        status: {
          in: [
            'QUEUED',
            'EXTRACTING',
            'ANALYZING_LOCAL',
            'ANALYZING_CONTEXT',
            'ANALYZING_GLOBAL',
            'FINALIZING',
          ],
        },
        createdAt: { lte: new Date(now.getTime() - STALE_ANALYSIS_MS) },
      },
      data: { status: 'FAILED', errorCode: 'ANALYSIS_FAILED', completedAt: now },
    });
    report.staleAnalyses = stale.count;

    // 4. Sessions invitées sans document et inactives.
    const guests = await this.prisma.user.deleteMany({
      where: {
        isGuest: true,
        lastSeenAt: { lte: new Date(now.getTime() - GUEST_INACTIVITY_MS) },
        documents: { none: {} },
      },
    });
    report.guestsDeleted = guests.count;

    this.logger.log(report, 'Nettoyage terminé');
    return report;
  }
}
