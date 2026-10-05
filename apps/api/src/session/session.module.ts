import { Global, Module } from '@nestjs/common';
import { SessionService } from './session.service.js';

@Global()
@Module({
  providers: [SessionService],
  exports: [SessionService],
})
export class SessionModule {}
