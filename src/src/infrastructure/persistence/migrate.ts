import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from './orm-config.js';

const direction = process.argv[2] ?? 'up';
const orm = await MikroORM.init(buildOrmConfig());
try {
  const migrator = orm.getMigrator();
  if (direction === 'down') console.log('reverted:', (await migrator.down()).map((m) => m.name));
  else console.log('applied:', (await migrator.up()).map((m) => m.name));
} finally {
  await orm.close();
}
