import { describe, it, expect } from "vitest";
import { isPrivateIp, htmlToText, buildPageFromHtml, isSafeUrl } from "../src/lib/engine/pageFetch";

describe("isPrivateIp (SSRF)", () => {
  const blocked = [
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "127.0.0.1",
    "169.254.169.254", // AWS metadata
    "0.1.2.3",
    "100.64.0.1", // CGNAT
    "::1",
    "fc00::1",
    "fd12::1",
    "fe80::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:192.168.0.1",
  ];
  for (const ip of blocked) {
    it(`блокирует ${ip}`, () => expect(isPrivateIp(ip)).toBe(true));
  }

  const allowed = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"];
  for (const ip of allowed) {
    it(`пропускает ${ip}`, () => expect(isPrivateIp(ip)).toBe(false));
  }
});

describe("isSafeUrl", () => {
  it("блокирует localhost по имени (без DNS)", async () => {
    const r = await isSafeUrl(new URL("https://localhost/admin"));
    expect(r.safe).toBe(false);
  });
});

describe("htmlToText", () => {
  it("вырезает script/style и теги, схлопывает пробелы", () => {
    const html = "<style>.x{}</style><div>Привет <b>мир</b></div><script>bad()</script>";
    const t = htmlToText(html);
    expect(t).toContain("Привет");
    expect(t).toContain("мир");
    expect(t).not.toContain("bad()");
    expect(t).not.toContain("<");
  });

  it("декодирует html-сущности", () => {
    expect(htmlToText("A &amp; B &lt;C&gt;")).toBe("A & B <C>");
  });
});

describe("buildPageFromHtml (микроразметка)", () => {
  it("извлекает ld+json и OpenGraph", () => {
    const html = `
      <title>Товар X</title>
      <meta property="og:title" content="Товар X OG" />
      <meta property="product:price:amount" content="1990" />
      <script type="application/ld+json">{"@type":"Product","name":"Товар X"}</script>
      <body>Описание товара X</body>`;
    const page = buildPageFromHtml(html, "https://shop/x", "https://shop/x");
    expect(page.title).toBe("Товар X");
    expect(page.url).toBe("https://shop/x");
    expect(page.ldjson).toHaveLength(1);
    expect((page.ldjson[0] as { name: string }).name).toBe("Товар X");
    expect(page.openGraph["og:title"]).toBe("Товар X OG");
    expect(page.openGraph["product:price:amount"]).toBe("1990");
    expect(page.text).toContain("Описание товара X");
  });

  it("не падает на битом ld+json", () => {
    const html = `<script type="application/ld+json">{ broken json </script><body>ok</body>`;
    const page = buildPageFromHtml(html, "https://shop/y", "https://shop/y");
    expect(page.ldjson).toHaveLength(0);
    expect(page.text).toContain("ok");
  });
});
