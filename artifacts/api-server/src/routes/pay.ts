/**
 * UPI payment routes (ZapUPI).
 *
 *   POST /pay/upi/order          → start a UPI payment for a plan (logged in)
 *   GET  /pay/upi/order/:id      → my order's status; nudges a confirm while pending
 *   POST /pay/zapupi/webhook     → public gateway callback (untrusted — id only)
 *
 * The webhook is unsigned, so it is treated purely as a "go check order X"
 * hint: all verification happens server-side in confirmZapupiOrder() against
 * ZapUPI's order-status API. See lib/zapupi.ts for the security model.
 */
import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { pool } from "../lib/db";
import { requireUser } from "../middlewares/sessionAuth";
import {
  confirmZapupiOrder,
  createZapupiOrder,
  isUpiPlan,
  isZapupiConfigured,
  toPublicUpiOrder,
  UPI_ORDER_ID_RE,
  type UpiOrderRow,
} from "../lib/zapupi";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Each create hits the gateway's paid API — keep order creation modest.
const createOrderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many payment attempts — please wait a few minutes and try again." },
});

// ── POST /pay/upi/order ──────────────────────────────────────────────────────
router.post("/pay/upi/order", createOrderLimiter, requireUser, async (req, res): Promise<void> => {
  if (!pool) { res.status(503).json({ error: "Payments unavailable — database is not configured." }); return; }
  if (!isZapupiConfigured()) {
    res.status(503).json({ error: "UPI payments are not set up yet — please use the manual request instead." });
    return;
  }
  const plan = String((req.body ?? {}).plan ?? "");
  if (!isUpiPlan(plan)) {
    res.status(400).json({ error: "Pick a valid plan (Starter or Pro)." });
    return;
  }
  try {
    const order = await createZapupiOrder({ userId: req.currentUser!.id, plan });
    res.json(order);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message || "Could not start the UPI payment." });
  }
});

// ── GET /pay/upi/order/:orderId ──────────────────────────────────────────────
router.get("/pay/upi/order/:orderId", requireUser, async (req, res): Promise<void> => {
  if (!pool) { res.status(503).json({ error: "Payments unavailable." }); return; }
  const orderId = String(req.params.orderId ?? "");
  if (!UPI_ORDER_ID_RE.test(orderId)) { res.status(404).json({ error: "Order not found." }); return; }

  const { rows } = await pool.query<UpiOrderRow>(
    `SELECT * FROM upi_orders WHERE order_id = $1`,
    [orderId],
  );
  let row = rows[0];
  const me = req.currentUser!;
  if (!row || (row.user_id !== me.id && me.role !== "admin")) {
    res.status(404).json({ error: "Order not found." });
    return;
  }

  // While pending, every poll double-checks with the gateway — so the success
  // page works even if the webhook never arrives (autoscale, dev, outages).
  if (row.status === "pending" && isZapupiConfigured()) {
    try {
      await confirmZapupiOrder(orderId);
      const fresh = await pool.query<UpiOrderRow>(
        `SELECT * FROM upi_orders WHERE order_id = $1`,
        [orderId],
      );
      if (fresh.rows[0]) row = fresh.rows[0];
    } catch (err) {
      // Gateway hiccup — report the row as-is; the client keeps polling.
      logger.warn({ orderId, err: (err as Error).message }, "upi order poll confirm failed");
    }
  }

  res.json({ order: toPublicUpiOrder(row) });
});

// ── POST /pay/zapupi/webhook (public) ────────────────────────────────────────
router.post("/pay/zapupi/webhook", async (req, res): Promise<void> => {
  const orderId = String((req.body ?? {}).order_id ?? "");
  if (UPI_ORDER_ID_RE.test(orderId) && pool && isZapupiConfigured()) {
    try {
      const result = await confirmZapupiOrder(orderId);
      logger.info({ orderId, state: result.state }, "zapupi webhook processed");
    } catch (err) {
      // Never surface errors to the gateway — our poll path will finish the job.
      logger.warn({ orderId, err: (err as Error).message }, "zapupi webhook confirm failed");
    }
  } else if (orderId) {
    logger.warn({ orderId: orderId.slice(0, 40) }, "zapupi webhook ignored (bad id or unconfigured)");
  }
  res.json({ ok: true });
});

export default router;
