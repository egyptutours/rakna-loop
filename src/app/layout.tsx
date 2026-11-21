import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { IBM_Plex_Sans_Arabic } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { AppShell } from "@/components/app-shell";
import type { Lang } from "@/lib/types";

const plex = IBM_Plex_Sans_Arabic({
  subsets: ["arabic", "latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex",
  display: "swap",
});

export const metadata: Metadata = {
  title: "RAKNA LOOP — ركنة لوب",
  description: "Leave a Spot. Earn Rewards. Help Your City Move. — اترك موقفًا، اكسب نقاطًا، وساعد غيرك.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#163828",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Arabic is the default language; English is the alternative.
  const lang: Lang = (await cookies()).get("rakna_lang")?.value === "en" ? "en" : "ar";
  return (
    <html lang={lang} dir={lang === "ar" ? "rtl" : "ltr"} className={plex.variable}>
      <body className="min-h-dvh">
        <Providers initialLang={lang}>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
