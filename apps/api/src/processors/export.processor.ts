import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { ExportRunner } from '../exports/export-runner.js';
import { EXPORT_QUEUE, type ExportJobData } from '../queue/queue.constants.js';

/**
 * Consommateur de la file d'export (service d'export uniquement) : une seule tâche à
 * la fois. Le verrou dépasse la durée maximale d'un export (120 s par défaut).
 */
@Processor(EXPORT_QUEUE, { concurrency: 1, lockDuration: 180_000 })
export class ExportProcessor extends WorkerHost {
  private readonly logger = new Logger(ExportProcessor.name);

  constructor(private readonly runner: ExportRunner) {
    super();
  }

  async process(job: Job<ExportJobData>): Promise<void> {
    await this.runner.run(job.data.exportId);
  }

  /** Après le dernier essai (panne passagère répétée), l'export est marqué en échec. */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<ExportJobData> | undefined, error: Error): Promise<void> {
    if (!job) return;
    this.logger.error(
      { exportId: job.data.exportId, attempt: job.attemptsMade, err: { name: error.name } },
      'Échec du traitement de l’export',
    );
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      await this.runner.markFailed(job.data.exportId, 'EXPORT_FAILED');
    }
  }
}
