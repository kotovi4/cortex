# Образ движка cortex. Запуск через tsx (отдельной компиляции нет).
# Внутри образа только код движка; данные/секреты — снаружи через env при запуске.
FROM node:24-slim

WORKDIR /app

# Зависимости. --include=dev: tsx и drizzle-kit нужны в рантайме (запуск + миграции).
# --omit=optional: без playwright (headless). Для headless — см. docs/delivery.md.
COPY package*.json ./
RUN npm install --include=dev --omit=optional

# Исходники (node_modules/.env/.git исключены через .dockerignore).
COPY . .

ENV NODE_ENV=production
# Адрес по умолчанию; компания может переопределить в своём окружении.
ENV SERVER_ADDRESS=0.0.0.0:8080
EXPOSE 8080

# Старт сервиса. Миграции БД прогоняются отдельной командой при деплое:
#   docker run --env-file .env <image> npm run db:migrate
CMD ["npm", "run", "start"]
