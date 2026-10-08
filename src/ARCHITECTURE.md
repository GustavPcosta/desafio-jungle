# ARCHITECTURE

## 1. Visão geral
Hexagonal/DDD enxuto. O domínio (`src/domain`) não depende de Nest nem do ORM. Um único use case
(`ProcessWagerTransactionUseCase`) atende HTTP, SQS e o worker de `PENDING_REFERENCE`.
Toda alteração financeira acontece em **uma transação SQL**: inbox (se SQS) + transação + saldo + ledger + outbox.

## 2. Garantias no schema (seção 5/6 do desafio)
Migration reversível `Migration20260801000001_initial_schema`:
- `wallets`: `UNIQUE(player_id,currency)`, `CHECK(balance >= 0)`, `CHECK(version >= 1)`.
- `wager_transactions`: `UNIQUE(idempotency_key)`, `UNIQUE(provider_id, external_transaction_id)`, CHECKs de kind/status, valor, referência obrigatória para REFUND/ROLLBACK,
  `failure_code` ⇔ REJECTED/FAILED, `processed_at` ⇔ estado terminal; índice único parcial `(reference_transaction_id) WHERE kind IN (REFUND,ROLLBACK) AND status='PROCESSED'`.
- `wallet_ledger_entries`: **append-only** por triggers (`UPDATE/DELETE/TRUNCATE` levantam exceção), `CHECK` aritmético (`before ± amount = after`), `after >= 0`, `UNIQUE(wallet_id, transaction_id)`.
- `inbox_messages`: PK `(consumer_name, message_id)`. `outbox_messages`: índice parcial dos pendentes.

## 3. Concorrência
Unidade = `walletId`. **Lock pessimista por linha** (`SELECT … FOR UPDATE` na wallet) no início de toda operação, **mais** `UPDATE … WHERE version = :esperada` como defesa em profundidade.
Wallets diferentes nunca se bloqueiam (sem lock global; testado). `lock_timeout` de 5 s por transação: estouro → `503`/retry, nunca saldo errado.
*Por que não optimistic?* Hot wallets (muitas apostas na mesma carteira) gerariam tempestade de retries; o lock serializa só a seção crítica curta e dá resultado determinístico no cenário "duas apostas de 80 em 100".
Ordem de locks fixa (wallet → linha da transação) em todos os caminhos, evitando deadlock. Métricas: histograma de espera de lock e contador de contenção (>25 ms).

## 4. Idempotência
Persistente, decidida por constraints (nunca por memória). Fluxo: lock da wallet → `INSERT … ON CONFLICT DO NOTHING` da transação → se já existia, compara `payloadHash`:
igual ⇒ replay (`idempotentReplay:true`, **mesmo status e saldo observado originalmente**, guardado em `observed_balance`); diferente ⇒ `409 IDEMPOTENCY_CONFLICT`.
`payloadHash = sha256(JSON canônico com chaves ordenadas)` de `{providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money (escala 2), referenceExternalTransactionId|null}`; header e metadados de transporte ficam de fora ("25" e "25.00" têm o mesmo hash).
A chave é a fonte da verdade; também existe unicidade `(provider, externalId)` — mesma operação com outra chave e payload igual é replay, com payload diferente é conflito.

## 5. Interpretações adotadas (documentadas conforme o enunciado)
- **Reversão única por referência, de qualquer tipo**: mais estrito que "mesmo tipo" — evita REFUND *e* ROLLBACK da mesma BET creditarem duas vezes. Um ROLLBACK *de um REFUND* continua permitido (referência diferente).
- WIN pode referenciar uma BET (opcional, campo `referenceExternalTransactionId`); se informada e ausente, vai a `PENDING_REFERENCE`. LOSS idem.
- Valor deve ser > 0, exceto LOSS (≥ 0). `OPENING` é rejeitado pela API e pela fila (schema zod) e só nasce em `POST /wallets`.
- Wallet inexistente: nada é persistido (FK). HTTP `404`; SQS → DLQ `WALLET_NOT_FOUND` (fica visível para investigação).
- `ROLLBACK` de `LOSS` → `REFERENCE_KIND_NOT_ALLOWED`. Referência que está `REJECTED/FAILED` → `REFERENCE_NOT_PROCESSED`; ainda pendente → continua `PENDING_REFERENCE`.
- Wallet com `version` 1 após `open`; o lançamento OPENING documenta o saldo inicial sem incrementar `version` (só muda quando há movimentação posterior).

## 6. Estados de `WagerTransaction`
`PENDING → PROCESSED | PENDING_REFERENCE | REJECTED | FAILED`; `PENDING_REFERENCE → PROCESSED | PENDING_REFERENCE (reagendada) | REJECTED | FAILED`.
Estados terminais não transicionam: tentar é `InvalidTransactionStateError` (erro de programação). `FAILED` é usado pelo worker quando um erro de domínio inesperado/permanente ocorre ao reprocessar.

## 7. Referências fora de ordem (7.1)
Persistida como `PENDING_REFERENCE` (HTTP 202) com `next_attempt_at`. Worker agendado (qualquer nº de instâncias; serializa por lock de wallet e revalida estado/horário dentro da transação).
Backoff exponencial 2 s·2ⁿ (teto 5 min); **limite: 10 tentativas ou TTL de 1 h** (o que vier primeiro) — a referência de uma rodada normalmente chega em segundos; 1 h cobre filas atrasadas/DLQ re-drive sem manter pendências para sempre.
Esgotado: `REJECTED REFERENCE_NOT_FOUND` + evento `WagerTransactionRejected`.

## 8. Outbox transacional
Eventos (`WagerTransactionProcessed|Rejected|PendingReference`, `WalletBalanceChanged`) entram na outbox na mesma transação. Publishers concorrentes usam `FOR UPDATE SKIP LOCKED` (sem bloqueio, sem duplicar quando ninguém cai).
Entrega **at-least-once**: se o processo morrer entre o aceite do broker e o commit, outra instância reenvia; o `eventId` (= id da outbox, também `MessageDeduplicationId`) permite dedupe no consumidor.
Falha de publicação → `attempts++` e backoff exponencial (teto 5 min), sem perder nada. Eventos vão para `wager-events.fifo` (`MessageGroupId = walletId`). Ordem estrita só dentro de um publisher; consumidores devem usar `walletVersion`/`occurredAt` (limitação conhecida de múltiplos publishers).
Efeito colateral: o lock das linhas da outbox é mantido durante o `SendMessage` (lote pequeno, 50).

## 9. SQS
Consumidor FIFO (`MessageGroupId = walletId`): grupos em paralelo, mensagens do mesmo grupo em sequência. Dedupe por **inbox persistente** `(consumerName, messageId)` na mesma transação; o broker FIFO é apenas otimização.
`ack` (DeleteMessage) só depois do commit. Classificação: rejeição de negócio ⇒ persistida e **ack**; transitório ⇒ visibilidade com backoff (2·2ⁿ s) até `SQS_MAX_RECEIVE_COUNT` e então DLQ; permanente (JSON/schema inválido, OPENING, dinheiro inválido, conflito de idempotência, mesmo `messageId` com payload diferente, wallet inexistente) ⇒ cópia na DLQ com `failureReason` + ack.
Falha transitória devolve o resto do grupo (visibilidade 0) para preservar ordem. SIGTERM (`enableShutdownHooks`): para o polling, conclui as mensagens em andamento, devolve as não iniciadas e fecha o pool.

## 10. Persistência / ORM
MikroORM v6 (preferencial) para pool, `EntityManager.transactional()` (um fork por transação, sem Identity Map compartilhado) e Migrator. **Não usei entidades mapeadas**: os agregados têm construtor privado + `rehydrate`, e o modelo precisa de `FOR UPDATE`, `ON CONFLICT` e `SKIP LOCKED` explícitos; mapear isso em Unit of Work escondia exatamente o que está sendo avaliado.
Os repositórios (`pg-repositories.ts`) executam SQL parametrizado dentro da transação do EM e reidratam via `rehydrate`. Trade-off: perdemos change tracking/Identity Map (aqui indesejáveis) e escrevemos o mapeamento à mão.
**Money**: `decimal.js` no domínio (escala 2, sem `number`); `NUMERIC(20,2)` no banco; `pg` devolve `NUMERIC` como string → reidratação exata.

## 11. API, observabilidade e auth
Mapeamento de status único em `http-errors.ts` (ver README). Logs JSON com lista permitida de campos (correlationId, messageId, transactionId, walletId, providerId…); payloads e valores não são logados.
Métricas Prometheus em `/metrics`: transações por kind/status, duplicatas, conflitos de idempotência, retries, DLQ, espera/contenção de lock, latência, lag/pendências da outbox, divergências de reconciliação. `/health/live` e `/health/ready` (Postgres + SQS).
**Autenticação: não implementada** (aceito pela seção 2). Ponto de extensão explícito: `NoopAuthGuard` + `ProviderIdentityPort`. Desenho adotado em produção: JWT OIDC de um IdP externo (Keycloak), claim do cliente → `providerId` via port, e rejeição se `body.providerId` divergir; health/metrics abertos; fila tratada como canal interno confiável.

## 12. Como foi verificado (e o que não foi)
- Rodado de verdade: 105 testes (unidade + integração + concorrência) contra **PostgreSQL 16 real** com Bun 1.4, incluindo 4 processos simultâneos na mesma wallet, `SIGKILL` + reinício, 300 apostas paralelas em wallet quente, dois/três publishers na mesma outbox e migrations up→down→up.
- O ambiente de desenvolvimento não tinha Docker: **`docker-compose.yml`, `Dockerfile` e `localstack-init.sh` não foram executados**, e `sqs.e2e.test.ts` (LocalStack real) está escrito mas foi pulado. Os testes do consumidor usam o Postgres real com o *transporte* SQS simulado.
- O boot completo do app (Nest + SQS + workers) não foi exercitado contra LocalStack; os controllers/filtro foram testados via Nest real (`http.test.ts`). Rode `docker compose up --build` e `bun run test:integration` com o LocalStack no ar para fechar essa lacuna.

## 13. Limitações / evolução
Particionamento do ledger/outbox e arquivamento; publisher com `LISTEN/NOTIFY` em vez de polling; `MessageGroupId` por wallet limita paralelismo de uma wallet quente na fila (por desenho); double-entry bookkeeping; reversões parciais (fora de escopo); DLQ re-drive tooling.
