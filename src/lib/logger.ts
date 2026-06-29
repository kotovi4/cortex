const isDev = process.env.NODE_ENV !== "production";

function fmt(level: string, msg: string, data?: unknown): string {
  const ts = new Date().toISOString();
  if (data !== undefined) return `[${ts}] ${level} ${msg} ${JSON.stringify(data)}`;
  return `[${ts}] ${level} ${msg}`;
}

export const logger = {
  info: (msg: string, data?: unknown) => console.log(fmt("INFO ", msg, data)),
  warn: (msg: string, data?: unknown) => console.warn(fmt("WARN ", msg, data)),
  error: (msg: string, data?: unknown) => console.error(fmt("ERROR", msg, data)),
  debug: (msg: string, data?: unknown) => { if (isDev) console.log(fmt("DEBUG", msg, data)); },
};
