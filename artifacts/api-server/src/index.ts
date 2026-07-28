import app from "./app";
import { logger } from "./lib/logger";
import { checkStorageHealth } from "./routes/videoTools";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Startup probe — warn loudly if Object Storage is unreachable so ops can
  // catch misconfiguration before users hit it.  Non-blocking: the server
  // continues listening even if storage is down so existing local-cache hits
  // still work while the issue is investigated.
  checkStorageHealth().then(({ ok, error }) => {
    if (ok) {
      logger.info("[storage] Object Storage reachability check passed");
    } else {
      logger.error(
        { error },
        "[storage] Object Storage is NOT reachable at startup — uploads will fail until this is resolved",
      );
    }
  }).catch(() => { /* checkStorageHealth swallows its own errors */ });
});
