import { Router, type IRouter } from "express";
import healthRouter from "./health";
import ytdlpRouter from "./ytdlp";
import videoToolsRouter from "./videoTools";
import historyRouter from "./history";

const router: IRouter = Router();

router.use(healthRouter);
router.use(ytdlpRouter);
router.use(videoToolsRouter);
router.use(historyRouter);

export default router;
