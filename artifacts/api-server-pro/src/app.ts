import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import path from "path";
import fs from "fs";
import router from "./routes";
import mcpRouter from "./routes/mcp";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(pinoHttp({ logger, serializers: { req(req) { return { id: req.id, method: req.method, url: req.url?.split("?")[0] }; }, res(res) { return { statusCode: res.statusCode }; } } }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/api", router);

// Remote MCP connector for the Claude app (Streamable HTTP at /mcp). Mounted before the static
// catch-all so it isn't swallowed by the SPA fallback. Isolated + read-only; if it ever fails to
// mount, the render server keeps running.
try {
  app.use("/mcp", mcpRouter);
} catch (err) {
  logger.error({ err }, "Failed to mount MCP connector route (continuing without it)");
}

// OAuth discovery probes from MCP connector clients (e.g. the Claude app) must cleanly 404
// rather than fall through to the SPA catch-all below — otherwise the client receives the app's
// index.html (HTTP 200), mistakes it for a broken sign-in service, and refuses to add the
// connector ("Couldn't register with ... sign-in service"). A 404 here means "no auth required",
// so the connector connects anonymously. Matches the /<name>/mcp resource-suffixed variants too.
const noAuthDiscovery = (_req: express.Request, res: express.Response): void => {
  res.status(404).json({ error: "This MCP server requires no authentication." });
};
app.use("/.well-known/oauth-authorization-server", noAuthDiscovery);
app.use("/.well-known/oauth-protected-resource", noAuthDiscovery);
app.use("/.well-known/openid-configuration", noAuthDiscovery);

const staticDir = process.env["STATIC_DIR"];
if (staticDir) {
  app.use(express.static(staticDir));
  app.use((_req, res) => {
    const indexPath = path.join(staticDir, "index.html");
    if (fs.existsSync(indexPath)) { res.sendFile(path.resolve(indexPath)); } else { res.status(404).send("Not found"); }
  });
}

export default app;
