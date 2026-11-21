// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Providers, useApp } from "@/components/providers";
import { dirFor, DISCLAIMER, ERROR_MESSAGES, STATUS_LABEL } from "@/lib/i18n";

function Probe() {
  const { L, dir, setLang } = useApp();
  return (
    <div>
      <p data-testid="text">{L("Map", "الخريطة")}</p>
      <p data-testid="dir">{dir}</p>
      <button onClick={() => setLang("en")}>en</button>
    </div>
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { user: null, demoMode: true, aiEnabled: false, demoUsers: [] } }), { headers: { "Content-Type": "application/json" } })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("12. Arabic RTL display", () => {
  it("defaults to Arabic with right-to-left direction on <html>", async () => {
    render(<Providers initialLang="ar"><Probe /></Providers>);
    expect(screen.getByTestId("text").textContent).toBe("الخريطة");
    expect(screen.getByTestId("dir").textContent).toBe("rtl");
    expect(document.documentElement.dir).toBe("rtl");
    expect(document.documentElement.lang).toBe("ar");
  });

  it("switches to English and left-to-right", async () => {
    render(<Providers initialLang="ar"><Probe /></Providers>);
    await act(async () => screen.getByText("en").click());
    expect(screen.getByTestId("text").textContent).toBe("Map");
    expect(document.documentElement.dir).toBe("ltr");
  });

  it("has complete Arabic translations for statuses, errors and the mandatory disclaimer", () => {
    expect(dirFor("ar")).toBe("rtl");
    expect(dirFor("en")).toBe("ltr");
    for (const v of [...Object.values(STATUS_LABEL), ...Object.values(ERROR_MESSAGES), DISCLAIMER]) {
      expect(v.ar).toMatch(/[؀-ۿ]/);
      expect(v.en.length).toBeGreaterThan(0);
    }
    expect(DISCLAIMER.en).toBe("Community parking signals are informational only. Availability is not guaranteed. Always follow local parking regulations.");
  });
});
