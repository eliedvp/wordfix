import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import type { Env } from '../config/env.schema.js';
import { AnalysisRunner } from '../engine/analysis-runner.js';
import { ANALYSIS_QUEUE, type AnalysisJobData } from '../queue/queue.constants.js';

/** Consommateur de la file d'analyses (processus worker uniquement). */
@Processor(ANALYSIS_QUEUE, { lockDuration: 120_000 })
export class AnalysisProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(AnalysisProcessor.name);

  constructor(
    private readonly runner: AnalysisRunner,
    private readonly config: ConfigService<Env, true>,
  ) {
    super();
  }

  onModuleInit(): void {
    this.worker.concurrency = this.config.get('WORKER_CONCURRENCY', { infer: true });
  }

  async process(job: Job<AnalysisJobData>): Promise<void> {
    this.logger.log(
      { analysisId: job.data.analysisId, attempt: job.attemptsMade + 1 },
      'Début du traitement',
    );
    await this.runner.run(job.data.analysisId);
  }

  /** Après le dernier essai, l'analyse est marquée en échec (l'utilisateur peut relancer). */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<AnalysisJobData> | undefined, error: Error): Promise<void> {
    if (!job) return;
    const attempts = job.opts.attempts ?? 1;
    this.logger.error(
      { analysisId: job.data.analysisId, attempt: job.attemptsMade, err: error },
      'Échec du traitement',
    );
    if (job.attemptsMade >= attempts) {
      await this.runner.markFailed(job.data.analysisId, 'ANALYSIS_FAILED');
    }
  }
}
