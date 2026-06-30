# API `/api/v1` — справочник

Контракт движка cortex. Парсинг товара вынесен в отдельную доку:
[extract-product.md](extract-product.md).

## Аутентификация и тенанты

- Заголовок **`X-API-Key`** на каждый вызов (кроме `/health`).
- Типы ключей: **`sk_`** — секретный (доверенный server-to-server), **`pub_`** — публичный (встраиваемый виджет, ограниченный scope).
- Scopes: `chat`, `documents`, `analytics`, `extract`. У ключа нет нужного scope → `403`.
- Тенант (`orgId`/`projectId`) берётся **из ключа**, не из тела. Резолв — `resolveApiKey` ([apiKeys.ts](../src/lib/engine/apiKeys.ts)), кладётся в контекст (`requireApiKey(scope)`).
- **`effectiveProjectId`**: секретный ключ МОЖЕТ передать `projectId` в запросе (доверенный хост, мультипроектность); публичный — всегда привязан к `projectId` своего ключа. `projectId = null` → поиск по всем документам тенанта.

> ⚠️ Конверты ответов сейчас неоднородны: `extract-product` отдаёт мешевый `{ data }` / `{ error: { code, message } }`, а ранние ручки ниже — «плоские» формы (`{ answer … }`, `{ error: "текст" }`). Выравнивание всех ручек под `{ data }`/`{ error:{code,message} }` — задача раздела 10 (mesh-края).

---

## POST `/api/v1/chat` — ответ на вопрос
Scope `chat`. Любой ключ.

Запрос:
```json
{ "message": "Как часто кормить котика?", "stream": false, "history": [{"role":"user","content":"..."}], "projectId": "опц., только для sk_" }
```
Ответ (`stream:false`):
```json
{
  "answer": "…",
  "escalated": false,
  "operatorAvailable": true,
  "sources": [{ "document": "…", "chunk": 3, "similarity": 0.82, "excerpt": "…" }]
}
```
`stream:true` → **SSE**: события `{ "token": "…" }` по мере генерации, затем
`{ "done": true, "escalated", "operatorAvailable?", "sources": [...] }`. Ошибка в потоке → `{ "error": "…" }`.

Логика: ищет топ-5 чанков (порог 0.3) → генерирует ответ → пишет `query_logs` → решает эскалацию (`shouldEscalate`).

---

## POST `/api/v1/documents` — загрузка документа
Scope `documents`.

- **multipart/form-data**: поле `file` (pdf/docx/txt; до 25 МБ) + опц. `title`, `projectId`.
- **application/json**: `{ "text": "…", "title": "…", "fileName?", "mimeType?", "projectId?" }`.
- Загрузка по `url` → `501` (извлечение текста делает поверхность; движок принимает готовый текст).

Ответ `201`:
```json
{ "id": "uuid", "title": "…", "chunkCount": 12, "embeddingFailures": 0, "message": "Документ загружен и разбит на 12 чанков" }
```
Под капотом: `chunkText` (chunkSize 800, overlap 200) → эмбеддинги (последовательно, троттлинг 120мс — не упереться в rps Yandex) → атомарная запись `documents` + `chunks`. При сбое эмбеддинга чанк сохраняется без вектора (учитывается в `embeddingFailures`).

## GET `/api/v1/documents` — список
Scope `documents`. Query: `projectId?`. → `{ "documents": [{ id, title, fileName, mimeType, chunkCount, createdAt }] }` (до 200, новые сверху).

## GET `/api/v1/documents/:id` — содержимое
Scope `documents`. → `{ "document": {…} }`; `404` если нет; `403` если документ другого `projectId`.

---

## GET `/api/v1/analytics` — метрики покрытия
Scope `analytics`. Query: `projectId?`.
```json
{
  "total": 120, "answered": 96, "unanswered": 24,
  "coverageRate": 0.8, "avgTopSimilarity": 0.71,
  "recent": [{ "question": "…", "answered": true, "topSimilarity": 0.8, "searchMethod": "vector", "createdAt": "…" }]
}
```
`coverageRate` = доля отвеченных — ключевая бизнес-метрика («закрытые обращения»).

---

## Примитивы для доверенных поверхностей (только `sk_`)

Низкоуровневые ручки: поверхность (монолит / бэкенд Quotcat) сама оркестрирует ответ.

### POST `/api/v1/search`
Scope `chat`, **только секретный ключ**. `{ "query", "topK?": 5, "threshold?": 0.3, "projectId?" }` →
```json
{ "results": [{ "content", "documentTitle", "similarity", "chunkIndex", "searchMethod": "vector|keyword" }] }
```

### POST `/api/v1/generate`
Scope `chat`, **только секретный ключ**. Генерация поверх переданного контекста.
`{ "query", "context": SearchResult[], "history?", "stream?" }` →
`stream:false` → `{ "answer", "sources" }`; `stream:true` → SSE `{ token }` … `{ done:true }`.

> `search` + `generate` = «chat по частям»: поверхность может вставить свою логику между поиском и генерацией (фильтры, свой контекст, реранк).

---

## GET `/health`
Без ключа. Readiness (проверка БД). Для healthcheck инфраструктуры.

## Коды ошибок (общие)
`401` — нет/невалидный ключ · `403` — нет scope / не тот тип ключа / чужой проект · `400` — плохой запрос · `404` — не найдено · `501` — не реализовано (url-ingest) · `500` — внутренняя ошибка.
