type E2eVars = Partial<Record<'E2E_DATABASE_URL' | 'POSTGRES_PORT', string | undefined>>;

export function resolveE2eDatabaseUrl(env: E2eVars, dotenv: E2eVars): string;
export function readRootEnv(file?: string): E2eVars;
export function e2eDatabaseUrl(): string;
