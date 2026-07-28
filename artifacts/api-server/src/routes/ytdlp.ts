import { Router, type IRouter } from "express";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import path from "path";
import os from "os";
import fs from "fs";
import { requireAuth } from "../middlewares/requireAuth";
import { isSafePublicUrl } from "../lib/ssrfGuard";

const execFileAsync = promisify(execFile);
const router: IRouter = Router();

// ── Error classification ───────────────────────────────────────────────────────

interface YtdlpErrorInfo {
  userMessage: string;
  code: string;
  /** HTTP status to return: 422 for rejected URLs, 504 for network/timeout, 500 for unexpected */
  status: number;
}

function classifyYtdlpError(stderr: string, fallback: string): YtdlpErrorInfo {
  const text = (stderr + "\n" + fallback).toLowerCase();

  if (text.includes("private video") || text.includes("video is private")) {
    return { userMessage: "This video is private.", code: "PRIVATE_VIDEO", status: 422 };
  }
  if (
    text.includes("members-only") ||
    text.includes("members only") ||
    text.includes("join this channel")
  ) {
    return {
      userMessage: "This video is for channel members only.",
      code: "MEMBERS_ONLY",
      status: 422,
    };
  }
  if (
    text.includes("age-restricted") ||
    text.includes("age restricted") ||
    text.includes("sign in to confirm your age")
  ) {
    return {
      userMessage: "This video is age-restricted and cannot be downloaded without sign-in.",
      code: "AGE_RESTRICTED",
      status: 422,
    };
  }
  if (
    text.includes("not available in your country") ||
    text.includes("geo") ||
    (text.includes("blocked") && text.includes("country"))
  ) {
    return {
      userMessage: "This video is not available in the server's region (geo-blocked).",
      code: "GEO_BLOCKED",
      status: 422,
    };
  }
  if (
    text.includes("video unavailable") ||
    text.includes("has been removed") ||
    text.includes("no longer available") ||
    text.includes("account has been terminated")
  ) {
    return {
      userMessage: "This video is unavailable or has been removed.",
      code: "VIDEO_UNAVAILABLE",
      status: 422,
    };
  }
  if (
    text.includes("copyright") ||
    text.includes("takedown") ||
    text.includes("content warning")
  ) {
    return {
      userMessage: "This video has been removed due to a copyright claim.",
      code: "COPYRIGHT",
      status: 422,
    };
  }
  if (
    text.includes("unsupported url") ||
    text.includes("no suitable") ||
    text.includes("no video formats") ||
    text.includes("is not a valid url") ||
    text.includes("unable to extract")
  ) {
    return {
      userMessage: "This URL is not supported. Make sure it points to a video page.",
      code: "UNSUPPORTED_URL",
      status: 422,
    };
  }
  if (
    text.includes("timed out") ||
    text.includes("timeout") ||
    text.includes("connection refused") ||
    text.includes("network") ||
    text.includes("ssl")
  ) {
    return {
      userMessage: "Connection timed out reaching the video source. Try again later.",
      code: "NETWORK_ERROR",
      status: 504,
    };
  }

  // Extract the last meaningful line from stderr for display
  const meaningful = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("[debug]") && !l.startsWith("WARNING:"))
    .slice(-3)
    .join(" ");

  return {
    userMessage: meaningful || "An unexpected error occurred. Please try a different URL.",
    code: "UNKNOWN",
    status: 500,
  };
}

// All yt-dlp endpoints are resource-intensive (spawn subprocesses / download
// full videos). Require a valid Clerk session on every route in this router.
router.use(requireAuth);

function validateUrl(url: string): boolean {
  return isSafePublicUrl(url);
}

// GET /ytdlp/info?url=...
router.get("/ytdlp/info", async (req, res): Promise<void> => {
  const url = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;

  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "Missing required query param: url" });
    return;
  }

  if (!validateUrl(url)) {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }

  req.log.info({ url }, "Fetching video info");

  try {
    const { stdout } = await execFileAsync("yt-dlp", [
      "--dump-json",
      "--no-playlist",
      "--no-warnings",
      "--extractor-args", "youtube:player_client=ios,android,web",
      url,
    ]);

    const info = JSON.parse(stdout);

    res.json({
      id: info.id,
      title: info.title,
      description: info.description ?? null,
      uploader: info.uploader ?? null,
      duration: info.duration ?? null,
      view_count: info.view_count ?? null,
      like_count: info.like_count ?? null,
      upload_date: info.upload_date ?? null,
      thumbnail: info.thumbnail ?? null,
      webpage_url: info.webpage_url,
      extractor: info.extractor,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: string }).stderr ?? "";
    req.log.error({ err: message, stderr }, "yt-dlp info failed");
    const { userMessage, code, status } = classifyYtdlpError(stderr, message);
    res.status(status).json({ error: userMessage, code });
  }
});

// GET /ytdlp/formats?url=...
router.get("/ytdlp/formats", async (req, res): Promise<void> => {
  const url = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;

  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "Missing required query param: url" });
    return;
  }

  if (!validateUrl(url)) {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }

  req.log.info({ url }, "Fetching video formats");

  try {
    const { stdout } = await execFileAsync("yt-dlp", [
      "--dump-json",
      "--no-playlist",
      "--no-warnings",
      "--extractor-args", "youtube:player_client=ios,android,web",
      url,
    ]);

    const info = JSON.parse(stdout);

    const formats = (info.formats ?? []).map((f: Record<string, unknown>) => ({
      format_id: f.format_id,
      format_note: f.format_note ?? undefined,
      ext: f.ext,
      resolution: f.resolution ?? (f.width && f.height ? `${f.width}x${f.height}` : "audio only"),
      fps: f.fps ?? null,
      filesize: f.filesize ?? null,
      tbr: f.tbr ?? null,
      vcodec: f.vcodec ?? null,
      acodec: f.acodec ?? null,
      url: null, // omit direct URLs for security
    }));

    res.json({
      id: info.id,
      title: info.title,
      formats,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: string }).stderr ?? "";
    req.log.error({ err: message, stderr }, "yt-dlp formats failed");
    const { userMessage, code, status } = classifyYtdlpError(stderr, message);
    res.status(status).json({ error: userMessage, code });
  }
});

// POST /ytdlp/download
router.post("/ytdlp/download", async (req, res): Promise<void> => {
  const { url, format = "best", audio_only = false } = req.body as {
    url?: string;
    format?: string;
    audio_only?: boolean;
  };

  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "Missing required field: url" });
    return;
  }

  if (!validateUrl(url)) {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }

  req.log.info({ url, format, audio_only }, "Starting download");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytdlp-"));
  const outputTemplate = path.join(tmpDir, "%(title)s.%(ext)s");

  const args: string[] = [
    "--no-playlist",
    "--no-warnings",
    "-o", outputTemplate,
  ];

  if (audio_only) {
    args.push("-x", "--audio-format", "mp3");
  } else {
    args.push("-f", format);
  }

  args.push(url);

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("yt-dlp", args);
      let stderrBuf = "";
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf += chunk.toString();
      });
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else {
          const err = new Error(`yt-dlp exited with code ${code}`) as Error & { stderr: string };
          err.stderr = stderrBuf;
          reject(err);
        }
      });
      proc.on("error", reject);
    });

    const files = fs.readdirSync(tmpDir);
    if (files.length === 0) {
      res.status(500).json({ error: "No file was produced by yt-dlp. The format may be unavailable.", code: "NO_OUTPUT" });
      return;
    }

    const filePath = path.join(tmpDir, files[0]);
    const ext = path.extname(filePath).slice(1);
    const filename = path.basename(filePath);

    const mimeTypes: Record<string, string> = {
      mp4: "video/mp4",
      webm: "video/webm",
      mkv: "video/x-matroska",
      mp3: "audio/mpeg",
      m4a: "audio/mp4",
      opus: "audio/ogg",
      ogg: "audio/ogg",
    };

    const contentType = mimeTypes[ext] ?? "application/octet-stream";

    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(filename)}"`
    );

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);

    stream.on("close", () => {
      // Clean up temp files
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    });
  } catch (err: unknown) {
    // Clean up on error
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    const message = err instanceof Error ? err.message : String(err);
    const stderr = (err as { stderr?: string }).stderr ?? "";
    req.log.error({ err: message, stderr }, "yt-dlp download failed");
    const { userMessage, code, status } = classifyYtdlpError(stderr, message);
    res.status(status).json({ error: userMessage, code });
  }
});

export default router;
