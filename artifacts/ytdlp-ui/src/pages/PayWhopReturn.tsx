/**
 * Whop embedded-checkout completion page.
 *
 * The status in the URL is only display context. The API verifies the receipt
 * with Whop and grants the plan only after Whop reports a paid payment.
 */
import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";
import { Link, useLocation } from "wouter";
import { AppHeader } from "../components/AppHeader";
import { apiFetch, useAuth, ApiError } from "../lib/auth";

type VerifyResult = { status: "paid" | "pending" | "failed"; state?: string };

export default function PayWhopReturn() {
  const { user, loading: authLoading, refresh } = useAuth();
  const [, setLocation] = useLocation();
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string>("");
  const receiptId = useMemo(
    () => new URLSearchParams(window.location.search).get("receipt_id")?.trim() ?? "",
    [],
  );

  useEffect(() => {
    if (!receiptId || !user || authLoading) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const verify = async () => {
      try {
        const next = await apiFetch<VerifyResult>("/pay/whop/verify", {
          method: "POST",
          body: JSON.stringify({ receiptId }),
        });
        if (stopped) return;
        setResult(next);
        if (next.status === "pending") timer = setTimeout(verify, 3000);
        if (next.status === "paid") {
          await refresh();
          timer = setTimeout(() => setLocation("/account"), 2200);
        }
      } catch (err) {
        if (stopped) return;
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          setError(err.message);
        } else {
          timer = setTimeout(verify, 4000);
        }
      }
    };
    void verify();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [authLoading, receiptId, refresh, setLocation, user]);

  let icon = <Loader2 className="w-10 h-10 text-[#D1FE17] animate-spin" />;
  let title = "Confirming your payment…";
  let text = "Whop is confirming the payment. Your Pro plan will activate automatically.";
  if (!receiptId) {
    icon = <XCircle className="w-10 h-10 text-red-400" />;
    title = "Payment receipt not found";
    text = "Please return to pricing and try the checkout again.";
  } else if (!authLoading && !user) {
    icon = <Clock className="w-10 h-10 text-[#D1FE17]" />;
    title = "Log in to finish activation";
    text = "Log in with the same AutoCliper account used for checkout.";
  } else if (error) {
    icon = <XCircle className="w-10 h-10 text-red-400" />;
    title = "We couldn't verify this payment";
    text = error;
  } else if (result?.status === "paid") {
    icon = <CheckCircle2 className="w-10 h-10 text-[#D1FE17]" />;
    title = "AutoCliper Pro is active!";
    text = "Your subscription has been verified and activated. Taking you to your account…";
  } else if (result?.status === "failed") {
    icon = <XCircle className="w-10 h-10 text-red-400" />;
    title = "Payment was not completed";
    text = "No Pro subscription was activated. You can try again from the pricing page.";
  }

  return (
    <div className="min-h-screen bg-[#0d0d0d] text-white font-sans">
      <AppHeader />
      <main className="min-h-[75vh] flex items-center justify-center px-4">
        <div className="max-w-lg w-full rounded-3xl bg-[#1a1a1a] border border-white/10 p-8 text-center">
          <div className="flex justify-center mb-5">{icon}</div>
          <h1 className="text-2xl font-black">{title}</h1>
          <p className="text-white/55 mt-3 leading-relaxed">{text}</p>
          {(!receiptId || error || result?.status === "failed") && (
            <Link
              href="/#pricing"
              className="inline-block mt-7 px-5 py-3 rounded-xl bg-[#D1FE17] text-black font-black text-sm"
            >
              Back to pricing
            </Link>
          )}
        </div>
      </main>
    </div>
  );
}