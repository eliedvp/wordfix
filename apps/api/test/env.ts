import { TEST_DATABASE_URL, TEST_REDIS_URL } from './test-env.js';

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.REDIS_URL = TEST_REDIS_URL;
process.env.WEB_ORIGIN = 'http://localhost:3000';
