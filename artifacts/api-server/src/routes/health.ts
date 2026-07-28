import { Router, type IRouter } from "express";
import { checkStorageHealth } from "./videoTools";

const router: IRouter = Router();

router.get("/healthz", async (_req, res): Promise<void> => {
  const storage = await checkStorageHealth();
  const allOk = storage.ok;
  res.status(allOk ? 200 : 503).json({
    status: allOk ? "ok" : "degraded",
    storage: storage.ok
      ? "ok"
      : { status: "unreachable", error: storage.error },
  });
});

export default router;
