import { Router, type IRouter } from "express";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import path from "path";
import os from "os";
import fs from "fs";

const execAsync = promisify(exec);
const router: IRouter = Router();

function validateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
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
    const { stdout } = await execAsync(
      `yt-dlp --dump-json --no-playlist --no-warnings --extractor-args "youtube:player_client=ios,android,web" "${url.replace(/"/g, '\\"')}"`
    );

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
    req.log.error({ err: message }, "yt-dlp info failed");
    res.status(500).json({ error: `yt-dlp error: ${message}` });
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
    const { stdout } = await execAsync(
      `yt-dlp --dump-json --no-playlist --no-warnings --extractor-args "youtube:player_client=ios,android,web" "${url.replace(/"/g, '\\"')}"`
    );

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
    req.log.error({ err: message }, "yt-dlp formats failed");
    res.status(500).json({ error: `yt-dlp error: ${message}` });
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
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`yt-dlp exited with code ${code}`));
      });
      proc.on("error", reject);
    });

    const files = fs.readdirSync(tmpDir);
    if (files.length === 0) {
      res.status(500).json({ error: "No file was downloaded" });
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
    req.log.error({ err: message }, "yt-dlp download failed");
    res.status(500).json({ error: `yt-dlp error: ${message}` });
  }
});

export default router;
