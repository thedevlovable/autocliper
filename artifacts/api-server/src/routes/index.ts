import { Router, type IRouter } from "express";
import healthRouter from "./health";
import ytdlpRouter from "./ytdlp";
import cookiesRouter from "./cookies";
import videoToolsRouter from "./videoTools";
import socialScheduleRouter from "./socialSchedule";
import uploadsRouter from "./uploads";
import historyRouter from "./history";
import ytDownloadRouter from "./ytDownload";
import authRouter from "./auth";
import billingRouter from "./billing";
import payRouter from "./pay";
import adminRouter from "./admin";
import referralRouter from "./referral";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(billingRouter);
router.use(payRouter);
router.use(adminRouter);
router.use(referralRouter);
router.use(ytdlpRouter);
router.use(cookiesRouter);
router.use(uploadsRouter);
router.use(videoToolsRouter);
router.use(socialScheduleRouter);
router.use(historyRouter);
router.use(ytDownloadRouter);

// Unknown API path → JSON 404 (never Express's default HTML error page)
router.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

export default router;
