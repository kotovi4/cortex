import type { ResolvedKey } from "./lib/engine/apiKeys";

// Контекст Hono: тенант, резолвнутый из API-ключа middleware'ом requireApiKey.
export type AppEnv = {
  Variables: {
    tenant: ResolvedKey;
  };
};
