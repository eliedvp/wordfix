import { TEST_DATABASE_URL, TEST_REDIS_URL } from './test-env.js';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.REDIS_URL = TEST_REDIS_URL;
process.env.WEB_ORIGIN = 'http://localhost:3000';
process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_LOCAL_DIR = `${process.env.TMPDIR ?? '/tmp'}/wordfix-test-storage`;
process.env.AI_PROVIDER = 'fake';
process.env.AI_CONCURRENCY = '2';
process.env.WORKER_CONCURRENCY = '1';
// Limites larges par défaut ; les tests de quotas les abaissent explicitement.
process.env.RATE_LIMIT_PER_MINUTE = '100000';
process.env.QUOTA_ANALYSES_PER_HOUR = '1000';
process.env.QUOTA_ANALYSES_PER_IP_PER_DAY = '1000';
process.env.QUOTA_UPLOADS_PER_IP_PER_HOUR = '1000';
