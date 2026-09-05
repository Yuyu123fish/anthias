import { isAbsolute } from "node:path";
import { cleanupExpiredSessions } from "./cleanup.js";

const sessionDirectory = process.argv[2];
const cleanupAbortController = new AbortController();
const timeout = setTimeout(() => cleanupAbortController.abort(), 30_000);
const stopCleanup = () => cleanupAbortController.abort();
process.on("message", stopCleanup);
process.once("disconnect", stopCleanup);

try {
  if (sessionDirectory !== undefined && isAbsolute(sessionDirectory)) {
    const result = await cleanupExpiredSessions({
      sessionDirectory,
      signal: cleanupAbortController.signal,
    });
    if (process.connected) {
      await new Promise<void>((resolve) => process.send?.(result, () => resolve()));
    }
  }
} finally {
  clearTimeout(timeout);
  process.off("message", stopCleanup);
  process.off("disconnect", stopCleanup);
  if (process.connected) {
    process.disconnect();
  }
}
