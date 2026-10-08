import { SQSClient, GetQueueUrlCommand } from '@aws-sdk/client-sqs';
import { AppConfig } from '../config/config.js';

export function createSqsClient(cfg: AppConfig['sqs']): SQSClient {
  return new SQSClient({
    region: cfg.region, endpoint: cfg.endpoint,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    maxAttempts: 3,
  });
}

export async function resolveQueueUrl(client: SQSClient, name: string, attempts = 30): Promise<string> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return (await client.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!; }
    catch (e) { last = e; await new Promise((r) => setTimeout(r, 1000)); }
  }
  throw last;
}
