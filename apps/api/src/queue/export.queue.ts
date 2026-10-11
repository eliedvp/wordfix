import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { EXPORT_JOB_ATTEMPTS, EXPORT_QUEUE, type ExportJobData } from './queue.constants.js';

@Injectable()
export class ExportQueue {
  constructor(@InjectQueue(EXPORT_QUEUE) private readonly queue: Queue<ExportJobData>) {}

  /** Un seul job par export : l'identifiant du job est celui de l'export. */
  async enqueue(exportId: string): Promise<void> {
    await this.queue.add(
      'export',
      { exportId },
      {
        jobId: exportId,
        attempts: EXPORT_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { age: 24 * 60 * 60 },
        removeOnFail: { age: 24 * 60 * 60 },
      },
    );
  }
}
