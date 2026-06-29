/**
 * Лёгкий PDF text extractor без внешних зависимостей.
 * Поддерживает FlateDecode (zlib) сжатие потоков.
 */

import { inflateSync } from "zlib";

export async function extractTextFromPdf(buffer: ArrayBuffer): Promise<string> {
  const bytes = Buffer.from(buffer);
  const raw = bytes.toString("latin1");

  const streams = extractStreams(raw, bytes);
  const textParts: string[] = [];

  for (const stream of streams) {
    const extracted = extractTextFromStream(stream);
    if (extracted.trim()) textParts.push(extracted);
  }

  if (textParts.length > 0) return textParts.join("\n\n");

  // Fallback — прямое сканирование Tj по всему файлу
  return directScan(raw);
}

// ─── Извлечение и декомпрессия потоков ───

function extractStreams(raw: string, bytes: Buffer): string[] {
  const result: string[] = [];
  let pos = 0;

  while (pos < raw.length) {
    const streamStart = raw.indexOf("stream", pos);
    if (streamStart === -1) break;

    // Заголовок объекта перед "stream" — ищем /Filter
    const objHeader = raw.slice(Math.max(0, streamStart - 500), streamStart);
    const isFlate =
      /\/Filter\s*\/FlateDecode/.test(objHeader) ||
      /\/Filter\s*\[.*?\/FlateDecode.*?\]/.test(objHeader);

    // Пропускаем \r\n или \n после "stream"
    let dataStart = streamStart + 6;
    if (raw[dataStart] === "\r") dataStart++;
    if (raw[dataStart] === "\n") dataStart++;

    const streamEnd = raw.indexOf("endstream", dataStart);
    if (streamEnd === -1) break;

    // Убираем завершающий \r\n перед endstream
    let dataEnd = streamEnd;
    if (raw[dataEnd - 1] === "\n") dataEnd--;
    if (raw[dataEnd - 1] === "\r") dataEnd--;

    if (isFlate) {
      try {
        const compressed = bytes.slice(dataStart, dataEnd);
        const decompressed = inflateSync(compressed);
        result.push(decompressed.toString("latin1"));
      } catch {
        // Битый поток — пропускаем
      }
    } else {
      result.push(raw.slice(dataStart, dataEnd));
    }

    pos = streamEnd + 9;
  }

  return result;
}

// ─── Парсинг текстовых операторов ───

function extractTextFromStream(stream: string): string {
  const parts: string[] = [];
  let pos = 0;
  while (pos < stream.length) {
    const bt = stream.indexOf("BT", pos);
    if (bt === -1) break;
    const et = stream.indexOf("ET", bt + 2);
    if (et === -1) break;
    const text = parseTextBlock(stream.slice(bt + 2, et));
    if (text.trim()) parts.push(text);
    pos = et + 2;
  }
  return parts.join(" ");
}

function parseTextBlock(block: string): string {
  const parts: string[] = [];
  let pos = 0;

  while (pos < block.length) {
    while (pos < block.length && /\s/.test(block[pos])) pos++;
    if (pos >= block.length) break;

    if (block[pos] === "(") {
      const { str, end } = parseLiteralString(block, pos);
      parts.push(decodePdfString(str));
      pos = end;
      continue;
    }

    if (block[pos] === "[") {
      const { parts: arr, end } = parseArray(block, pos);
      parts.push(arr.join(""));
      pos = end;
      const tj = block.slice(pos).match(/^\s*TJ/);
      if (tj) pos += tj[0].length;
      continue;
    }

    if (block[pos] === "<" && block[pos + 1] !== "<") {
      const closePos = block.indexOf(">", pos + 1);
      if (closePos !== -1) {
        parts.push(decodeHexString(block.slice(pos + 1, closePos)));
        pos = closePos + 1;
        const tj = block.slice(pos).match(/^\s*Tj/);
        if (tj) pos += tj[0].length;
        continue;
      }
    }

    const nl = block.slice(pos).match(/^(T\*|Td|TD)\s/);
    if (nl) { parts.push("\n"); pos += nl[0].length; continue; }

    if (block[pos] === "'" && pos > 0 && /\s/.test(block[pos - 1])) {
      parts.push("\n"); pos++; continue;
    }

    const token = block.slice(pos).match(/^[^\s\[\]()<>]+/);
    if (token) pos += token[0].length;
    else pos++;
  }

  return parts.join("");
}

function parseLiteralString(block: string, start: number): { str: string; end: number } {
  let depth = 0, str = "", i = start + 1;
  while (i < block.length) {
    const ch = block[i];
    if (ch === "\\" && i + 1 < block.length) {
      const next = block[i + 1];
      if (/[0-7]/.test(next)) {
        const oct = block.slice(i + 1, i + 4).match(/^[0-7]{1,3}/);
        if (oct) { str += String.fromCharCode(parseInt(oct[0], 8)); i += oct[0].length + 1; continue; }
      }
      const escMap: Record<string, string> = { n: "\n", r: "\r", t: "\t", "(": "(", ")": ")", "\\": "\\" };
      str += escMap[next] ?? next;
      i += 2;
    } else if (ch === "(") { depth++; str += ch; i++; }
    else if (ch === ")") {
      if (depth === 0) {
        i++;
        const op = block.slice(i).match(/^\s*(Tj|'|")\s/);
        if (op) i += op[0].length;
        break;
      }
      depth--; str += ch; i++;
    } else { str += ch; i++; }
  }
  return { str, end: i };
}

function parseArray(block: string, start: number): { parts: string[]; end: number } {
  const parts: string[] = [];
  let i = start + 1;
  while (i < block.length && block[i] !== "]") {
    while (i < block.length && /\s/.test(block[i])) i++;
    if (block[i] === "]") break;
    if (block[i] === "(") {
      const { str, end } = parseLiteralString(block, i);
      parts.push(decodePdfString(str)); i = end;
    } else if (block[i] === "<" && block[i + 1] !== "<") {
      const close = block.indexOf(">", i + 1);
      if (close !== -1) { parts.push(decodeHexString(block.slice(i + 1, close))); i = close + 1; }
      else i++;
    } else if (block[i] === "]") break;
    else {
      const num = block.slice(i).match(/^-?\d+\.?\d*/);
      if (num) { if (parseFloat(num[0]) < -100) parts.push(" "); i += num[0].length; }
      else i++;
    }
  }
  return { parts, end: i + 1 };
}

function decodePdfString(str: string): string {
  if (str.length >= 2 && str.charCodeAt(0) === 0xfe && str.charCodeAt(1) === 0xff) {
    let result = "";
    for (let i = 2; i + 1 < str.length; i += 2)
      result += String.fromCodePoint((str.charCodeAt(i) << 8) | str.charCodeAt(i + 1));
    return result;
  }
  return str;
}

function decodeHexString(hex: string): string {
  const clean = hex.replace(/\s/g, "");
  let result = "";
  for (let i = 0; i < clean.length; i += 2) {
    const b = parseInt(clean.slice(i, i + 2), 16);
    if (!isNaN(b)) result += String.fromCharCode(b);
  }
  return decodePdfString(result);
}

function directScan(raw: string): string {
  const parts: string[] = [];
  const regex = /\(([^)\\]*(?:\\.[^)\\]*)*)\)\s*Tj/g;
  let match;
  while ((match = regex.exec(raw)) !== null) {
    const str = decodePdfString(
      match[1].replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
    );
    if (str.trim()) parts.push(str);
  }
  return parts.join(" ");
}
