import express, { type Express } from "express";
import cors from "cors";
import compression from "compression";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import pinoHttp from "pino-http";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// Compress all JSON/text API responses — cuts bandwidth ~70%
app.use(compression());

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

// Clerk proxy MUST be before body parsers (streams raw bytes)
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(cors({ credentials: true, origin: true }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// Clerk session middleware — populates auth on every request
// Only enable when CLERK_SECRET_KEY is configured (skip in early dev without secrets)
if (process.env.CLERK_SECRET_KEY) {
  app.use(
    clerkMiddleware((req) => ({
      publishableKey: publishableKeyFromHost(
        getClerkProxyHost(req) ?? "",
        process.env.CLERK_PUBLISHABLE_KEY,
      ),
    })),
  );
}

// Root health check (before static files so it always returns JSON)
app.get("/healthz", (_req, res) => res.json({ status: "ok" }));

app.use("/api", router);

// Serve the built frontend whenever the dist folder exists.
// NODE_ENV is not reliably set to "production" by the hosting environment,
// so we gate only on whether the build output is present.
const __serverDir = path.dirname(fileURLToPath(import.meta.url));
const frontendDist = path.resolve(__serverDir, "../../ytdlp-ui/dist/public");
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  // SPA fallback — all non-API routes serve index.html
  // Express 5 requires named wildcards; bare "*" is rejected by path-to-regexp v8
  app.get("/{*path}", (_req, res) => {
    res.sendFile(path.join(frontendDist, "index.html"));
  });
}

export default app;
