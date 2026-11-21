"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Mail } from "lucide-react";
import { useApp } from "@/components/providers";
import { Button, Card, Field, Notice, PageHeader, inputCls } from "@/components/ui";
import { supabaseBrowser } from "@/lib/client/supabase-browser";

/** Supabase Auth sign-in (email one-time code). Only active when Supabase is configured. */
export default function SignIn() {
  const { L, toast } = useApp();
  const router = useRouter();
  const sb = supabaseBrowser();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!sb) {
    return (
      <Card className="mx-auto max-w-md">
        <Notice tone="info">{L("Sign-in is available when the app is connected to Supabase. In demo mode, use the demo account switcher.", "تسجيل الدخول يشتغل إذا انربط التطبيق بـ Supabase. في الوضع التجريبي استخدم مبدّل الحسابات التجريبية.")}</Notice>
      </Card>
    );
  }

  const send = async () => {
    setBusy(true);
    const { error } = await sb.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: true } });
    setBusy(false);
    if (error) return toast(L("Could not send the code. Try again.", "ما قدرنا نرسل الرمز. جرّب مرة ثانية."), "error");
    setSent(true);
  };
  const verify = async () => {
    setBusy(true);
    const { error } = await sb.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" });
    setBusy(false);
    if (error) return toast(L("Invalid or expired code.", "الرمز غلط أو منتهي."), "error");
    router.push("/");
  };

  return (
    <div className="mx-auto max-w-md">
      <PageHeader title={L("Sign in", "تسجيل الدخول")} subtitle={L("We email you a one-time code. No password is stored by RAKNA LOOP.", "نرسل لك رمز لمرة وحدة. ركنة لوب ما يخزّن أي كلمة مرور.")} />
      <Card className="space-y-4">
        <Field label={L("Email", "البريد الإلكتروني")}>
          <input type="email" autoComplete="email" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} disabled={sent} />
        </Field>
        {sent && (
          <Field label={L("Code from the email", "الرمز اللي في البريد")}>
            <input inputMode="numeric" autoComplete="one-time-code" className={inputCls} value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
        )}
        <Button className="w-full" loading={busy} onClick={sent ? verify : send} disabled={!email.includes("@") || (sent && code.trim().length < 6)}>
          <Mail className="h-4 w-4" aria-hidden />
          {sent ? L("Verify and sign in", "تحقق وسجّل دخول") : L("Email me a code", "أرسل لي رمز")}
        </Button>
      </Card>
    </div>
  );
}
