# POC: доступ Quotcat к `extract-product`

Цель: дать Quotcat **доступ к запущенному инстансу cortex по API** (НЕ исходники),
чтобы их бэкенд звал `POST /api/v1/extract-product`. Самый низкий порог: парсинг
работает по любой ссылке, данные предзагружать не нужно.

> **Инстанс** = запущенная копия cortex по сетевому адресу (`host:port`) со своим
> `.env` и БД. Код — твой, не передаётся; компания получает доступ к инстансу + ключ.

---

## 0. Перед стартом (не технич., но обязательно)
- [ ] Зафиксировать происхождение IP письменно (твоё, личное время) — **до** интеграции.
- [ ] Договориться о принципах лицензии/роялти, пока Quotcat не зависим (рычаг максимален).
- [ ] Оформить как **time-boxed POC**, не «тихо в прод». Отдаём доступ к инстансу, не код.

## 1. Поднять доступный инстанс cortex
- [ ] Где крутится: маленькая VM/VPS (Yandex Cloud и т.п.) / временный туннель к dev / инфра компании. Для POC проще VM или туннель.
- [ ] **Postgres** для инстанса — нужен минимум для таблицы `api_keys` (extract-product сам документы не читает, но сервис стартует с БД и проверяет ключ).
- [ ] `.env`:
  - `SERVER_ADDRESS=0.0.0.0:8080`
  - `DATABASE_URL=...`
  - `AI_PROVIDER=yandex`, `YANDEX_API_KEY=...`, `YANDEX_FOLDER_ID=...`
  - опц. `ENABLE_HEADLESS=1` (+ `npx playwright install chromium`) — для JS-страниц
  - опц. тарифы `YANDEX_LITE_RUB_PER_1K` / `YANDEX_PRO_RUB_PER_1K` — для себестоимости в `meta`
- [ ] Миграции: чистая БД → `npm run db:migrate`; общая dev-БД → `npm run init-dev`.
- [ ] Запуск (`npm run start`) → проверить `GET /health`.
- [ ] Сеть: инстанс доступен бэкенду Quotcat (внутр. сеть / firewall / HTTPS). CORS не нужен — вызов server-to-server.

## 2. Выдать Quotcat ключ
- [ ] Сгенерировать **секретный ключ `sk_`** со scope `extract` (через `init-dev` или скрипт ключей). Если в POC и helpdesk — добавить `chat`/`documents`.
- [ ] Передать ключ безопасно (не в гит, не в мессенджер). Показывается один раз.

## 3. Что отдать бэкенду Quotcat
- [ ] `ENGINE_URL` (адрес инстанса) + ключ → в их секреты/env.
- [ ] Контракт и коды ошибок: [extract-product.md](extract-product.md).
- [ ] curl-пример (ниже).

## 4. Интеграция на стороне Quotcat (их работа)
- [ ] `POST /api/v1/extract-product { url }` → `{ data: Product, meta }`.
- [ ] Маппинг `Product` в их offer-сущность; **цена/профиль дилера — их логика** (движок = ЧТО, Quotcat = ЦЕНА).
- [ ] Обработка ошибок (`EAI_EMPTY_PAGE` для JS-страниц без headless и пр.).

## 5. Замер для ценообразования
- [ ] По реальным URL собрать `meta.usageTokens` / `meta.costRub` → средняя себестоимость операции.

---

## curl-пример
```bash
curl -s -XPOST "$ENGINE_URL/api/v1/extract-product" \
  -H "X-API-Key: sk_..." \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://shop.example/product/123"}'
# → { "data": { name, price, currency, sku, specs, images, description, sourceUrl }, "meta": { source, models, usageTokens, costRub } }
```

## Что НЕ входит в POC (это уже для прода в их меше)
- Раздел 10 (mesh-края): JWT от gateway, выравнивание конвертов, `/metrics`, Docker→`cr.yandex`, Jenkins.
- Отдельная БД компании, мониторинг, SLA, перевод ключей Yandex на аккаунт компании.
