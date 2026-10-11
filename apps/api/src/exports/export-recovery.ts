import type { PrismaService } from '../prisma/prisma.service.js';

/** Un export en attente ou en cours depuis plus longtemps est considéré comme bloqué. */
export const STALE_EXPORT_MS = 15 * 60 * 1000;

/**
 * Exports bloqués (service arrêté, job perdu) : marqués en échec, sans fichier. Appelé
 * au démarrage et périodiquement par le service d'export, et par la purge horaire.
 */
export async function recoverStaleExports(
  prisma: PrismaService,
  now = new Date(),
): Promise<number> {
  const limit = new Date(now.getTime() - STALE_EXPORT_MS);
  const { count } = await prisma.export.updateMany({
    where: {
      OR: [
        { status: 'QUEUED', createdAt: { lte: limit } },
        { status: 'RUNNING', startedAt: { lte: limit } },
        { status: 'RUNNING', startedAt: null, createdAt: { lte: limit } },
      ],
    },
    data: { status: 'FAILED', errorCode: 'EXPORT_FAILED', completedAt: now },
  });
  return count;
}
