import { Module } from '@nestjs/common';
import { AiModule } from './ai/ai.module.js';
import { infrastructureImports } from './app.module.js';
import { AnalysisRunner } from './engine/analysis-runner.js';
import { AnalysisProcessor } from './processors/analysis.processor.js';
import { QueueModule } from './queue/queue.module.js';

/** Processus worker : consomme les files, appelle l'IA. N'expose aucun port HTTP. */
@Module({
  imports: [...infrastructureImports, QueueModule, AiModule],
  providers: [AnalysisRunner, AnalysisProcessor],
})
export class WorkerModule {}
