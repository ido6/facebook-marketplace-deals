// stdout belongs to the MCP protocol: a single stray write there breaks the
// connection. Every log line goes to stderr.

const write = (level: string, msg: string) => process.stderr.write(`[fbmp ${level}] ${msg}\n`);

export const log = {
  info: (msg: string) => write("info", msg),
  warn: (msg: string) => write("warn", msg),
  error: (msg: string) => write("error", msg),
};
