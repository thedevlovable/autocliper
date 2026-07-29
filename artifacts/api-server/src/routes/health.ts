import { Router, type IRouter } from "express";
import { checkStorageHealth } from "../lib/fileStore";

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
  });
});

export default router;
