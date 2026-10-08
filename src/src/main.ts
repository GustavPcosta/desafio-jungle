import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadConfig } from './infrastructure/config/config.js';

const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
app.enableShutdownHooks(); // SIGTERM/SIGINT -> onApplicationShutdown
const { port } = loadConfig();
await app.listen(port, '0.0.0.0');
process.stdout.write(JSON.stringify({ level: 'info', time: new Date().toISOString(), msg: 'wagering service listening', port }) + '\n');
