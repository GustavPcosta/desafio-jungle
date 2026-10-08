import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { EventPublisher } from '../../application/ports.js';
import { OutboxMessage } from '../../application/domain/outbox-message.js';

/** Publishes integration events to a FIFO queue. FIFO dedup is only an optimisation; consumers dedupe by eventId. */
export class SqsEventPublisher implements EventPublisher {
  constructor(private readonly client: SQSClient, private readonly queueUrl: string) {}
  async publish(msg: OutboxMessage): Promise<void> {
    await this.client.send(new SendMessageCommand({
      QueueUrl: this.queueUrl, MessageBody: JSON.stringify(msg.payload),
      MessageGroupId: msg.aggregateId, MessageDeduplicationId: msg.id,
      MessageAttributes: { eventType: { DataType: 'String', StringValue: msg.eventType } },
    }));
  }
}
