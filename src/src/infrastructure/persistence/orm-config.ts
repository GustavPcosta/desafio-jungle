import { defineConfig } from '@mikro-orm/postgresql';
import { Migration20260801000001_initial_schema } from './migrations/Migration20260801000001_initial_schema.js';

export function buildOrmConfig(clientUrl = process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering') {
  return defineConfig({
    clientUrl,
    entities: [], // Domain classes are persisted through explicit repositories (see ARCHITECTURE.md)
    discovery: { warnWhenNoEntities: false },
    pool: { min: 2, max: Number(process.env.DB_POOL_MAX ?? 20) },
    migrations: {
      migrationsList: [{ name: 'Migration20260801000001_initial_schema', class: Migration20260801000001_initial_schema }],
      transactional: true, allOrNothing: true, snapshot: false, disableForeignKeys: false,
    },
  });
}
