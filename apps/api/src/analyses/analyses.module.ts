import { Module } from '@nestjs/common';
import { AnalysesController } from './analyses.controller.js';
import { AnalysesService } from './analyses.service.js';

@Module({
  controllers: [AnalysesController],
  providers: [AnalysesService],
})
export class AnalysesModule {}
