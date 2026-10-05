import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema.js';
import { FILE_STORAGE, type FileStorage } from './file-storage.js';
import { LocalDiskStorage } from './local-disk.storage.js';
import { S3Storage } from './s3.storage.js';

@Global()
@Module({
  providers: [
    {
      provide: FILE_STORAGE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): FileStorage => {
        if (config.get('STORAGE_DRIVER', { infer: true }) === 's3') {
          return new S3Storage({
            endpoint: config.get('STORAGE_ENDPOINT', { infer: true }) ?? '',
            region: config.get('STORAGE_REGION', { infer: true }) ?? 'auto',
            accessKeyId: config.get('STORAGE_ACCESS_KEY', { infer: true }) ?? '',
            secretAccessKey: config.get('STORAGE_SECRET_KEY', { infer: true }) ?? '',
            bucket: config.get('STORAGE_BUCKET', { infer: true }) ?? '',
          });
        }
        return new LocalDiskStorage(config.get('STORAGE_LOCAL_DIR', { infer: true }));
      },
    },
  ],
  exports: [FILE_STORAGE],
})
export class StorageModule {}
