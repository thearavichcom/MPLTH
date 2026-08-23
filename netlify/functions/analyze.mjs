// netlify/functions/analyze.mjs
// HSIFY — streaming proxy to the Anthropic Messages API.
// Uses Netlify's v2 (Web API) function format so it gets the 60s streaming
// execution limit instead of the 10s synchronous limit.
// IMPORTANT: delete the old netlify/functions/analyze.js — two files with the
// same base name will conflict.

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const MAX_IMAGES = 4;
const MAX_IMAGE_CHARS = 1_500_000;
const MAX_TOTAL_CHARS = 4_000_000;
const ALLOWED_MEDIA = ["image/jpeg", "image/png", "image/webp", "image/gif"];

const fail = (status, error) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/* ────────────────────────────────────────────────────────────
   LEGAL GROUNDING
   ──────────────────────────────────────────────────────────── */
const GROUNDING = `Thailand uses AHTN 2022 at 8 digits (digits 1-6 = WCO HS, digits 7-8 = ASEAN). Never call an 8-digit code "HS 2022". Legal basis: พระราชกำหนดพิกัดอัตราศุลกากร (ฉบับที่ 7) พ.ศ. 2564, in force 1 Jan 2022. You cannot access the ITD tariff database. Never state a numeric import duty rate from memory — always refer the user to the ITD link instead.

GIR method:
- GIR 1 sets the 4-digit heading, read with the binding Section/Chapter Notes. Cite the Note when decisive.
- GIR 6 sets the 6-digit and (mutatis mutandis) 8-digit levels. Any 8-digit answer must cite GIR 6. Compare only same-level subheadings.
- State which digit level each criterion resolves. Do not attribute to digits 7-8 what is decided higher up. E.g. under 73.04 the stainless split is at 6 digits (7304.11 vs 7304.19), so stainless line pipe can never be 7304.19.xx.
- Standards (API, DIN, IEC) do not determine classification; use them only as evidence of objective characteristics.

Honesty: give a confidence level; never invent a rate, licence or agency name; list missing determinative facts instead of guessing; if two codes are arguable, say so.`;

const CLASSIFY_SECTIONS = `Respond in Markdown using EXACTLY these 5 headings, in this order:

## Recommended Classification
8-digit AHTN code, official nomenclature wording, confidence level. Max 3 lines.

## Duty & Tax
- MFN duty rate: you have NO access to the ITD database. NEVER state, estimate or recall a numeric MFN rate — no number, no range, no "likely duty-free". Write only: "อัตราอากร MFN: ตรวจสอบที่ http://itd.customs.go.th/igtf/viewerImportTariff.do?param=main"
- VAT: Thailand's standard 7% (statutory, not code-dependent).
- FTA: state (a) whether an agreement is in force with the stated origin, (b) whether this heading is normally covered or sits on a sensitive / exclusion list, (c) the preferential rate you believe applies, and (d) the certificate of origin form. Label the rate "อัตราอ้างอิง — ต้องยืนยัน" / "indicative — must be confirmed" and give the ITD privilege link http://itd.customs.go.th/igtf/ViewerPrivilege.do?param=main . Say plainly if no FTA is in force.
- AD / Safeguard: flag as a risk to check with the Department of Foreign Trade. Never give a figure.
Max 6 lines. Mandatory section — never omit.

## Licences & Controls
Name the controlling agency (e.g. Department of Livestock Development, FDA, TISI, Department of Foreign Trade) and any permit, standard or NSW measure. If genuinely unrestricted, write "Freely importable — no additional licence required." Then list documents beyond Invoice / Packing List / BL. Max 6 lines. Mandatory section — never omit.

## Classification Rationale (GIR)
Heading (GIR 1 + governing Section/Chapter Note), then 6-digit and 8-digit (GIR 6). Name the criterion at each level. Add any seriously arguable alternative code and why it was rejected. HARD LIMIT: 5 bullets, one line each.

## Information Still Needed
Facts that would confirm or change this. "None" only if genuinely complete. Max 4 bullets.

Be terse throughout. Bullets over prose. No preamble, no closing summary.`;

const VERIFY_SECTIONS = `Respond in Markdown using EXACTLY these 4 headings, in this order:

## Verdict
✅ Correct / ⚠ Arguable / ❌ Incorrect, plus a confidence level. Max 2 lines.

## Recommended Code
Only if different from the submitted code. Otherwise "The submitted code is appropriate."

## Duty, Tax & Controls
You have NO access to the ITD tariff database and CANNOT look up rates. NEVER state, estimate or recall a numeric import duty rate — no number, no range, no "likely duty-free". Write "Import duty rate: verify at http://itd.customs.go.th/igtf/viewerImportTariff.do?param=main". VAT is Thailand's standard 7%. Name the controlling agency and any permit. Mandatory — never omit.

## Assessment (GIR)
Test the code against the heading text and binding Notes. GIR 1 for the heading, GIR 6 for the 6- and 8-digit levels. HARD LIMIT: 5 bullets, one line each. End with any missing determinative facts.

Be terse. Bullets over prose. No preamble.`;

const IMAGE_INSTRUCTION = `Images attached: state what is visible (form, material, markings, nameplate, packaging) before classifying. Mark inferences with "appears to be". Photos rarely show material composition or degree of processing — put those under Information Still Needed rather than assuming. If image and text conflict, say so and explain which you relied on.`;

const langLine = (lang) =>
  lang === "th"
    ? `Write the entire response in Thai. Keep the Markdown headings in English exactly as specified. Keep tariff codes, certificate form names and legal instrument names in their official form. Use standard Thai customs terminology: อัตราอากรขาเข้า, ภาษีมูลค่าเพิ่ม, ใบอนุญาตนำเข้า, หน่วยงานผู้ควบคุม.`
    : `Write the entire response in English. Keep Thai legal instrument names in Thai script with an English gloss on first mention.`;

const buildSystem = (mode, lang, hasImages) =>
  `You are a Thai customs tariff classification specialist advising a freight forwarder.

${GROUNDING}

${mode === "verify" ? VERIFY_SECTIONS : CLASSIFY_SECTIONS}

${langLine(lang)}
Be concise and specific. Prefer short paragraphs and bullet lists over long prose.` +
  (hasImages ? `\n\n${IMAGE_INSTRUCTION}` : "");

/* ────────────────────────────────────────────────────────────
   HANDLER (Netlify v2 — streaming)
   ──────────────────────────────────────────────────────────── */
export default async (req) => {
  if (req.method !== "POST") return fail(405, "Method Not Allowed");

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return fail(500, "API key not configured");

  let body;
  try {
    body = await req.json();
  } catch {
    return fail(400, "Invalid JSON");
  }

  const { mode, description, origin, purpose, extra, hsCode, lang } = body;
  const images = Array.isArray(body.images) ? body.images : [];

  /* ── validation ── */
  if (mode === "verify") {
    if (!hsCode || !description) {
      return fail(400, "Both an HS code and a product description are required");
    }
  } else if (!description && images.length === 0) {
    return fail(400, "Provide a product description, an image, or both");
  }

  if (images.length > MAX_IMAGES) {
    return fail(400, `Too many images — the maximum is ${MAX_IMAGES}`);
  }

  let totalChars = 0;
  for (const img of images) {
    if (!img || typeof img.data !== "string" || !img.data) {
      return fail(400, "An attached image is malformed");
    }
    if (!ALLOWED_MEDIA.includes(img.media_type)) {
      return fail(400, `Unsupported image type: ${img.media_type}. Use JPEG, PNG, WebP or GIF.`);
    }
    if (img.data.length > MAX_IMAGE_CHARS) {
      return fail(413, "An image is too large after compression — please attach a smaller one");
    }
    totalChars += img.data.length;
  }
  if (totalChars > MAX_TOTAL_CHARS) {
    return fail(413, "Attached images are too large in total — please remove one");
  }

  /* ── user text ── */
  let userText;
  if (mode === "verify") {
    userText =
      `HS code submitted for verification: ${hsCode}\n` +
      `Product description: ${description}\n\n` +
      `Verify this code and complete every section.`;
  } else {
    const lines = [];
    lines.push(
      description
        ? `Goods to be imported: ${description}`
        : `Goods to be imported: see attached image(s) — no written description was provided.`
    );
    if (origin) lines.push(`Country of origin: ${origin}`);
    if (purpose) lines.push(`Intended purpose: ${purpose}`);
    if (extra) lines.push(`Additional details: ${extra}`);
    lines.push(`\nClassify these goods and complete every section.`);
    userText = lines.join("\n");
  }

  const content = [
    ...images.map((img) => ({
      type: "image",
      source: { type: "base64", media_type: img.media_type, data: img.data },
    })),
    { type: "text", text: userText },
  ];

  const outLang = lang === "th" ? "th" : "en";

  /* ── upstream call, streaming ── */
  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: outLang === "th" ? 4500 : 1800,
        stream: true,
        system: buildSystem(mode, outLang, images.length > 0),
        messages: [{ role: "user", content }],
      }),
    });
  } catch (err) {
    return fail(502, err.message || "Could not reach the Anthropic API");
  }

  if (!upstream.ok) {
    let msg = `Anthropic API error (HTTP ${upstream.status})`;
    try {
      const errBody = await upstream.json();
      msg = errBody?.error?.message || msg;
    } catch { /* keep default */ }
    return fail(upstream.status, msg);
  }

  /* ── re-emit SSE text deltas as a plain text stream ── */
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      let buffer = "";
      let emitted = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;

            let ev;
            try { ev = JSON.parse(payload); } catch { continue; }

            if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
              controller.enqueue(encoder.encode(ev.delta.text));
              emitted = true;
            } else if (ev.type === "message_delta" && ev.delta?.stop_reason === "max_tokens") {
              controller.enqueue(encoder.encode(
                "\n\n---\n\n_⚠ The response reached its length limit before completing every section._"
              ));
            } else if (ev.type === "error") {
              controller.enqueue(encoder.encode(
                `\n\n---\n\n_⚠ Upstream error: ${ev.error?.message || "unknown"}_`
              ));
            }
          }
        }

        if (!emitted) {
          controller.enqueue(encoder.encode("_The model returned an empty response — please try again._"));
        }
      } catch (err) {
        controller.enqueue(encoder.encode(
          `\n\n---\n\n_⚠ The stream was interrupted: ${err.message || "unknown error"}_`
        ));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
};
