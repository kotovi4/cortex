import { describe, it, expect } from "vitest";
import {
  generateApiKey,
  hashApiKey,
  effectiveProjectId,
  type ResolvedKey,
} from "../src/lib/engine/apiKeys";

describe("generateApiKey", () => {
  it("секретный ключ с префиксом sk_", () => {
    expect(generateApiKey("secret")).toMatch(/^sk_[A-Za-z0-9_-]+$/);
  });
  it("публичный ключ с префиксом pub_", () => {
    expect(generateApiKey("public")).toMatch(/^pub_[A-Za-z0-9_-]+$/);
  });
  it("ключи уникальны", () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateApiKey("secret")));
    expect(keys.size).toBe(50);
  });
});

describe("hashApiKey", () => {
  it("sha256 (известное значение)", () => {
    // sha256("abc")
    expect(hashApiKey("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
  it("детерминирован и не равен исходному ключу", () => {
    const k = generateApiKey("secret");
    expect(hashApiKey(k)).toBe(hashApiKey(k));
    expect(hashApiKey(k)).not.toBe(k);
  });
});

describe("effectiveProjectId", () => {
  const secret: ResolvedKey = {
    id: "1", orgId: "o1", projectId: "key-proj", type: "secret", scopes: ["chat"], domainAllowlist: null,
  };
  const pub: ResolvedKey = {
    id: "2", orgId: "o1", projectId: "key-proj", type: "public", scopes: ["chat"], domainAllowlist: null,
  };

  it("секретный ключ может адресовать проект из запроса", () => {
    expect(effectiveProjectId(secret, "req-proj")).toBe("req-proj");
  });
  it("секретный без запроса → проект ключа", () => {
    expect(effectiveProjectId(secret, null)).toBe("key-proj");
  });
  it("публичный ключ заблокирован на проект ключа (запрос игнорируется)", () => {
    expect(effectiveProjectId(pub, "req-proj")).toBe("key-proj");
  });
});
