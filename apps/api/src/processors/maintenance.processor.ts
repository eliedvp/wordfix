import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import type { OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { CleanupService } from '../maintenance/cleanup.service.js';
import { MAINTENANCE_QUEUE } from '../queue/queue.constants.js';

const CLEANUP_SCHEDULER = 'cleanup-hourly';

/** Purge planifiée toutes les heures (un seul planificateur, même avec plusieurs workers). */
@Processor(MAINTENANCE_QUEUE)
export class MaintenanceProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    private readonly cleanup: CleanupService,
    @InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      CLEANUP_SCHEDULER,
      { every: 60 * 60 * 1000 },
      { name: 'cleanup', opts: { removeOnComplete: 24, removeOnFail: 24 } },
    );
  }

  async process(): Promise<void> {
    await this.cleanup.run();
  }
}
