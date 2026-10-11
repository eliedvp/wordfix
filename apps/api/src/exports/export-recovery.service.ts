import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { recoverStaleExports } from './export-recovery.js';

const RECOVERY_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Récupération des exports bloqués par le service d'export lui-même : au démarrage
 * (après un arrêt brutal), puis toutes les 5 minutes.
 */
@Injectable()
export class ExportRecoveryService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ExportRecoveryService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.recover();
    this.timer = setInterval(() => void this.recover(), RECOVERY_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async recover(now = new Date()): Promise<number> {
    try {
      const count = await recoverStaleExports(this.prisma, now);
      if (count > 0) this.logger.warn({ count }, 'Exports bloqués marqués en échec');
      return count;
    } catch (error) {
      this.logger.error({ err: error }, 'Récupération des exports bloqués impossible');
      return 0;
    }
  }
}
