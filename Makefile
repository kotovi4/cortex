# Сборка и публикация образа cortex (как у сервисов компании).
# Версия передаётся через v=, например:  make release v=1.1.0
#
# IMAGE_NAME берётся из .env (туда добавить адрес реестра компании), напр.:
#   IMAGE_NAME=cr.yandex/<REGISTRY_ID>/cortex
-include .env
export

IMAGE ?= $(IMAGE_NAME)

.PHONY: release build push migrate run-local guard-v guard-image

# Собрать и запушить версию: make release v=1.1.0
release: build push

build: guard-v guard-image
	docker build --platform linux/amd64 -t $(IMAGE):$(v) .

push: guard-v guard-image
	docker push $(IMAGE):$(v)

# Прогнать миграции на БД из .env (один раз и при изменении схемы): make migrate v=1.1.0
migrate: guard-v guard-image
	docker run --rm --env-file .env $(IMAGE):$(v) npm run db:migrate

# Локальная проверка, что образ собирается и стартует: make run-local
run-local:
	docker build -t cortex:dev .
	docker run --rm --env-file .env -p 8080:8080 cortex:dev

guard-v:
	@test -n "$(v)" || { echo "Укажи версию: make release v=1.1.0"; exit 1; }

guard-image:
	@test -n "$(IMAGE)" || { echo "Не задан IMAGE_NAME (в .env): IMAGE_NAME=cr.yandex/<REGISTRY_ID>/cortex"; exit 1; }
