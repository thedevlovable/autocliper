import { describe, expect, it } from "vitest";
import {
  isWhopPaymentPaid,
  WHOP_PRO_PLAN_ID,
  WHOP_PRO_PRICE_USD,
  type WhopPaymentSnapshot,
} from "../lib/whop";

const paidPayment = (overrides: Partial<WhopPaymentSnapshot> = {}): WhopPaymentSnapshot => ({
  id: "pay_test123456",
  planId: WHOP_PRO_PLAN_ID,
  email: "buyer@example.com",
  currency: "usd",
  subtotal: WHOP_PRO_PRICE_USD,
  status: "paid",
  substatus: "succeeded",
  paidAt: new Date().toISOString(),
  membershipStatus: "active",
  ...overrides,
});

describe("Whop payment validation", () => {
  it("accepts a paid AutoCliper Pro payment for exactly $7.99 USD", () => {
    expect(isWhopPaymentPaid(paidPayment())).toBe(true);
  });

  it("rejects a payment for another plan", () => {
    expect(isWhopPaymentPaid(paidPayment({ planId: "plan_other" }))).toBe(false);
  });

  it("rejects a payment with the wrong amount or currency", () => {
    expect(isWhopPaymentPaid(paidPayment({ subtotal: 7.9 }))).toBe(false);
    expect(isWhopPaymentPaid(paidPayment({ currency: "inr" }))).toBe(false);
  });

  it("rejects pending, failed, and cancelled payments", () => {
    expect(isWhopPaymentPaid(paidPayment({ status: "pending" }))).toBe(false);
    expect(isWhopPaymentPaid(paidPayment({ status: "failed" }))).toBe(false);
    expect(isWhopPaymentPaid(paidPayment({ substatus: "canceled" }))).toBe(false);
  });
});