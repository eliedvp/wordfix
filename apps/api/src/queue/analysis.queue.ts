import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { ANALYSIS_JOB_ATTEMPTS, ANALYSIS_QUEUE, type AnalysisJobData } from './queue.constants.js';

@Injectable()
export class AnalysisQueue {
  constructor(@InjectQueue(ANALYSIS_QUEUE) private readonly queue: Queue<AnalysisJobData>) {}

  /** Un seul job par analyse : l'identifiant du job est celui de l'analyse. */
  async enqueue(analysisId: string): Promise<void> {
    await this.queue.add(
      'analyze',
      { analysisId },
      {
        jobId: analysisId,
        attempts: ANALYSIS_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: { age: 24 * 60 * 60 },
        removeOnFail: { age: 7 * 24 * 60 * 60 },
      },
    );
  }

  /** Retire le job s'il n'a pas encore démarré (annulation, suppression). */
  async removeIfPending(analysisId: string): Promise<void> {
    const job = await this.queue.getJob(analysisId);
    if (!job) return;
    if ((await job.isWaiting()) || (await job.isDelayed())) {
      await job.remove().catch(() => undefined);
    }
  }
}
