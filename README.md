# Cortex — RAG-движок

Самостоятельный HTTP-сервис (Hono + Drizzle) — лицензируемое RAG-ядро, вынесенное
из монолита `ai-support`. Контракт `/api/v1`, аутентификация по API-ключам.

Принцип: **код в репозитории неизменный; всё «чьё» (БД, секреты, тенанты, документы)
— через env/конфиг/API.** Переход на инфраструктуру компании = смена `.env` + повторный
ingest, без правок кода.

## Стек

- **Hono** (`@hono/node-server`) — хендлеры на веб-стандартах (`Response`/`ReadableStream`),
  SSE переносится из монолита ~1:1.
- **Drizzle ORM** + PostgreSQL 16 + pgvector.
- Провайдер LLM: Yandex / Gemini (`AI_PROVIDER`).

## Структура

```
src/
  server.ts            точка входа (Hono) + /health + /api/v1/*
  types.ts             AppEnv (тенант из ключа)
  lib/
    db/                drizzle-клиент + схема (documents, chunks, query_logs, api_keys)
    logger.ts
    engine/            ЯДРО (IP): rag, embeddings, chunker, ai-provider,
                       pdfExtractor, rateLimit, escalation, apiKeys + barrel index.ts
  middleware/auth.ts   requireApiKey(scope) — X-API-Key → тенант
  routes/              chat (SSE), documents (ingest/list), analytics
scripts/init-dev.ts    dev-инициализация на общей с монолитом БД
drizzle/               миграции (для чистой БД)
```

## Запуск (dev, на своих данных)

1. `npm install`
2. Создать `.env` (см. `.env.example`). Для dev `DATABASE_URL` может указывать на ту же
   БД, что у монолита — там уже есть `documents`/`chunks`. ⚠️ До прода определить
   единственного писателя в общие таблицы.
3. Инициализация:
   - **Общая dev-БД** (таблицы движка уже есть): `npm run init-dev` — создаст `api_keys`
     и выдаст сид-ключ.
   - **Чистая БД** (компания, Фаза 5C): `npm run db:generate && npm run db:migrate`.
4. `npm run dev` — сервис на `SERVER_ADDRESS` (дефолт `0.0.0.0:8080`).

## Контракт `/api/v1`

Аутентификация: заголовок `X-API-Key`. Тенант (`orgId`/`projectId`) берётся из ключа.
Полный справочник по ручкам, форматам и тенантам — [docs/api.md](docs/api.md); парсинг товара — [docs/extract-product.md](docs/extract-product.md).
Поставка компании (Docker-образ + цикл обновлений) — [docs/delivery.md](docs/delivery.md); выдача доступа Quotcat (POC) — [docs/quotcat-poc.md](docs/quotcat-poc.md).

| Метод | Путь | Scope | Назначение |
|--|--|--|--|
| POST | `/api/v1/chat` | `chat` | Ответ на вопрос. `{ message, stream?, history? }`. `stream:true` → SSE. |
| POST | `/api/v1/documents` | `documents` | Загрузка: multipart (`file`) или JSON (`{text,title}`). |
| GET | `/api/v1/documents` | `documents` | Список документов тенанта. |
| GET | `/api/v1/documents/:id` | `documents` | Содержимое документа. |
| GET | `/api/v1/analytics` | `analytics` | Метрики покрытия (`coverageRate`). |
| POST | `/api/v1/extract-product` | `extract` | Парсинг товара по ссылке (`{ url }`) → `{ data, meta }`. Только секретный ключ. См. [docs/extract-product.md](docs/extract-product.md). |
| GET | `/health` | — | Readiness (проверка БД). |

## Смоук-тест

```bash
KEY=<сид-ключ из init-dev>
curl -s localhost:8080/health
curl -s -XPOST localhost:8080/api/v1/documents -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"title":"test","text":"Котикам нужен корм дважды в день."}'
curl -s -XPOST localhost:8080/api/v1/chat -H "X-API-Key: $KEY" \
  -H 'Content-Type: application/json' -d '{"message":"Как часто кормить котика?"}'
```

## Тесты

```bash
npm test          # vitest — юнит-тесты чистой логики (без сети/БД)
npm run typecheck # tsc --noEmit
```

Покрыто: SSRF (`isPrivateIp`), `htmlToText`/микроразметка, `chunker`, API-ключи (`generateApiKey`/`hashApiKey`/`effectiveProjectId`), `withRetry`, `extractProduct` (парсинг/коэрция, LLM замокан). Внешние вызовы (LLM/БД/сеть) не используются — мокаются.

См. полный план и границы IP в `ai-support/refactoring/engine-refactor-plan.md` (Фаза 5,
раздел 10) и `LICENSE`.
