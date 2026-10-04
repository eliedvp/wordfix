import { Module } from '@nestjs/common';
import { IssuesController } from './issues.controller.js';

@Module({ controllers: [IssuesController] })
export class IssuesModule {}
