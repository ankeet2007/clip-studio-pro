import app from "./app";
import { logger } from "./lib/logger";
import { reconcileInterruptedJobs } from "./lib/clipProcessor";
import { restoreTokenFromDB } from "./routes/auth";

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

async function start(): Promise<void> {
  // Restore YouTube OAuth2 token from DB so yt-dlp can authenticate without
  // re-running the device flow after every restart or redeployment.
  await restoreTokenFromDB();

  // Clean up any clips left mid-flight by a previous process BEFORE we start
  // accepting traffic. If this ran after app.listen, a freshly POSTed clip could
  // be swept into the pending/processing -> error reconciliation by mistake.
  await reconcileInterruptedJobs();

  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
  });
}

void start();
