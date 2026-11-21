import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { aiConfigured, aiModel } from "../config";
import { parseRequest, riyadhLocalToUtc, type ParsedRequest } from "../domain/recommend";
import { stripPii } from "../security/pii";

/**
 * Optional Claude-powered request understanding. SERVER-ONLY: the API key never
 * reaches the browser. Claude only turns free-form Arabic/English into structured
 * preferences; ranking stays deterministic and uses only stored records, so the
 * model cannot fabricate availability, prices or traffic.
 */

const RequestSchema = z.object({
  destination: z.enum(["olaya", "wurud", "malqa", "kfr"]).nullable(),
  arrival_time_local: z.string().nullable().describe("Riyadh local time HH:MM in 24h format, or null if not stated or 'now'"),
  arrival_tomorrow: z.boolean(),
  duration_hours: z.number().nullable(),
  budget_sar: z.number().nullable(),
  max_walk_meters: z.number().nullable(),
});

const SYSTEM = `You convert a driver's parking request (Arabic or English, Riyadh, Saudi Arabia) into structured preferences.
Destinations you can map: olaya (Al Olaya, العليا, Kingdom Centre, Al Faisaliah), wurud (Al Wurud, الورود), malqa (Al Malqa, الملقا), kfr (King Fahd Road, طريق الملك فهد). Use null when the destination is elsewhere or unclear.
"Reasonable walking distance" means 800 m; "very close" means 400 m. Leave a field null when the request does not state it. Do not guess prices or availability.`;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 20_000, maxRetries: 1 });
  return client;
}

export async function understandRequest(text: string, now: Date): Promise<{ parsed: ParsedRequest; aiUsed: boolean; aiError?: string }> {
  const fallback = parseRequest(text, now);
  if (!aiConfigured()) return { parsed: fallback, aiUsed: false };

  try {
    const response = await getClient().beta.messages.parse({
      model: aiModel(),
      max_tokens: 2000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: betaZodOutputFormat(RequestSchema) },
      system: SYSTEM,
      // Data minimisation: contact details, ID numbers, plates and payment data never leave the server.
      messages: [{ role: "user", content: stripPii(text.slice(0, 1000)).text }],
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) {
      return { parsed: fallback, aiUsed: false, aiError: "no_structured_output" };
    }
    const p = response.parsed_output;
    const understood: string[] = [];
    let arrival = now;
    let arrivalIsNow = true;
    const m = p.arrival_time_local?.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      arrival = riyadhLocalToUtc(now, Number(m[1]), Number(m[2]), p.arrival_tomorrow ? 1 : 0);
      arrivalIsNow = Math.abs(arrival.getTime() - now.getTime()) < 20 * 60_000;
      understood.push("arrival");
    }
    if (p.destination) understood.push("destination");
    if (p.duration_hours) understood.push("duration");
    if (p.budget_sar !== null) understood.push("budget");
    if (p.max_walk_meters) understood.push("walk");
    return {
      aiUsed: true,
      parsed: {
        destination: p.destination,
        arrival: arrival.toISOString(),
        arrivalIsNow,
        durationHours: Math.max(1, Math.min(12, Math.ceil(p.duration_hours ?? 2))),
        budgetSar: p.budget_sar !== null && p.budget_sar >= 0 ? p.budget_sar : null,
        maxWalkM: Math.max(100, Math.min(3000, p.max_walk_meters ?? 800)),
        understood,
        source: "ai",
      },
    };
  } catch (error) {
    // Typed SDK errors → fall back to the deterministic parser; never surface secrets.
    let code = "unknown";
    if (error instanceof Anthropic.AuthenticationError) code = "auth";
    else if (error instanceof Anthropic.RateLimitError) code = "rate_limited";
    else if (error instanceof Anthropic.APIError) code = `api_${error.status}`;
    console.error("[rakna] AI assistant fell back to rules:", code);
    return { parsed: fallback, aiUsed: false, aiError: code };
  }
}
