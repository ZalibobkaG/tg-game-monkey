import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, sql } from './index.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
await migrate(db, { migrationsFolder: join(here, 'migrations') });
console.log('✅ Миграции применены');
await sql.end();
