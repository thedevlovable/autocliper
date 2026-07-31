import express, { type Express } from "express";
import cors from "cors";
import compression from "compression";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
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

// Trust the first proxy hop (Replit / Railway / Render reverse proxies).
// Required for express-rate-limit to read the real client IP from X-Forwarded-For.
app.set("trust proxy", 1);

// Security headers — XSS, clickjacking, MIME sniff, etc.
// contentSecurityPolicy disabled — frontend serves inline scripts via Vite
app.use(helmet({ contentSecurityPolicy: false }));

// Compress all JSON/text API responses — cuts bandwidth ~70%
app.use(compression());

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Heavy clip/download jobs get tighter per-IP limits to prevent abuse.
// General API gets a more generous window.
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests — please slow down and try again shortly." },
  // Downloader progress polls run every ~4s per active job and have their own
  // dedicated limiter inside the yt routes — exempt them here so one active
  // download can't eat the general budget and 429 unrelated endpoints.
  skip: (req) => req.path.startsWith("/yt/progress"),
});

const clipLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 10,              // 10 clip jobs per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many clip requests — please wait a moment before trying again." },
});

const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,              // 20 yt-dlp downloads per IP per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many download requests — please slow down." },
});

app.use("/api", generalLimiter);
app.use("/api/video/clip", clipLimiter);
app.use("/api/ytdlp/download", downloadLimiter);

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

// ALLOWED_ORIGIN — defaults to autocliper.com in prod, open in dev.
// Set this env var to lock down CORS to a specific domain.
const allowedOrigin = process.env.ALLOWED_ORIGIN
  ?? (process.env.NODE_ENV === "production" ? "https://autocliper.com" : "*");
app.use(
  cors({
    credentials: allowedOrigin !== "*",
    origin: allowedOrigin === "*" ? true : allowedOrigin,
  }),
);
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
  // Hashed assets (JS/CSS chunks produced by Vite) are immutable — cache 1 year.
  // index.html must never be cached so the SPA always boots fresh.
  app.use(
    express.static(frontendDist, {
      maxAge: "1y",
      immutable: true,
      etag: true,
      setHeaders(res, filePath) {
        if (filePath.endsWith("index.html")) {
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        }
      },
    }),
  );
  // SPA fallback — all non-API routes serve index.html
  // Express 5 requires named wildcards; bare "*" is rejected by path-to-regexp v8
  app.get("/{*path}", (_req, res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(path.join(frontendDist, "index.html"));
  });
}

export default app;
