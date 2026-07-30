import { Router, type IRouter } from "express";
import { checkStorageHealth } from "../lib/fileStore";
import { ENCODE_INFO, getJobQueueStats } from "./videoTools";

const router: IRouter = Router();

router.get("/healthz", async (_req, res): Promise<void> => {
  const storage = await checkStorageHealth();
  const allOk = storage.ok;
  res.status(allOk ? 200 : 503).json({
    status: allOk ? "ok" : "degraded",
    storage: storage.ok
      ? "ok"
      : { status: "unreachable", error: storage.error },
    storageCircuit: {
      state: storage.circuit,
      consecutiveFailures: storage.consecutiveFailures,
    },
    encode: ENCODE_INFO,
    jobQueue: getJobQueueStats(),
  });
});

export default router;
