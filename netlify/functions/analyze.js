// netlify/functions/analyze.js
// HSIFY — HS Code classification proxy to the Anthropic Messages API.
// Supports text-only and text+image (vision) analysis.

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5";
const MAX_IMAGES = 4;
const MAX_IMAGE_CHARS = 1_500_000;   // ~1.1 MB decoded, per image
const MAX_TOTAL_CHARS = 4_000_000;   // stay well under Netlify's 6 MB body limit
const ALLOWED_MEDIA = ["image/jpeg", "image/png", "image/webp", "image/gif"];

const json = (statusCode, obj) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});

/* ────────────────────────────────────────────────────────────
   SHARED LEGAL GROUNDING
   ──────────────────────────────────────────────────────────── */
const GROUNDING = `LEGAL BASIS — follow exactly:
- Thailand classifies goods under the ASEAN Harmonised Tariff Nomenclature (AHTN) 2022 at 8 digits. Digits 1-6 are the WCO Harmonized System; digits 7-8 are the ASEAN-level subdivision. Never call an 8-digit code "HS 2022" — it is AHTN 2022.
- Legal instrument: พระราชกำหนดพิกัดอัตราศุลกากร (ฉบับที่ 7) พ.ศ. 2564, in force from 1 January 2022, amending พระราชกำหนดพิกัดอัตราศุลกากร พ.ศ. 2530.
- Rates are further modified by ประกาศกระทรวงการคลัง issued from time to time, so any rate you state MUST be presented as indicative and subject to verification on the Thai Customs ITD system.

CLASSIFICATION METHOD — the General Interpretative Rules (หลักเกณฑ์การตีความพิกัดอัตราศุลกากร) are applied in strict order:
- GIR 1 governs the 4-digit heading, and is decided by the terms of the heading TOGETHER WITH the relevant Section and Chapter Notes. Section/Chapter Notes are legally binding, not commentary — cite the specific Note when one is decisive or exclusionary.
- GIR 2-5 apply only if GIR 1 leaves the heading undetermined (incomplete/unassembled goods, mixtures, composite goods, sets, packing).
- GIR 6 governs BOTH the 6-digit subheading and, applied mutatis mutandis, the 8-digit AHTN subheading. Any 8-digit answer MUST cite GIR 6 in addition to GIR 1. Comparison is only ever permitted between subheadings at the SAME level (one-dash vs one-dash, two-dash vs two-dash).
- State which digit level each criterion resolves. Do not attribute a distinction to the 7th-8th digits when it is actually decided at the 6-digit level or above. Example of the error to avoid: under heading 73.04 the stainless / non-stainless split for line pipe is decided at 6 digits (7304.11 vs 7304.19), NOT at the 8-digit level — so a stainless line pipe can never sit under any 7304.19.xx code.
- Product standards (API, DIN, JIS, IEC, ASTM) do not themselves determine classification; the Subheading Explanatory Notes state that the subheadings apply irrespective of the standard met. Use a standard only as evidence of the goods' objective characteristics or intended use.

HONESTY REQUIREMENTS:
- Give a confidence level (High / Medium / Low) and say plainly what would change the answer.
- If a determinative fact is missing (material composition, degree of processing, exact function, whether presented assembled, dimensions), do not guess — list it under "Information Still Needed".
- Never invent a specific duty rate or a licence requirement. If you are not certain of the current figure, say so and point to the ITD system rather than stating a number with false precision.
- If two codes are genuinely arguable, present both and explain why you prefer one. Do not manufacture false certainty.`;

const CLASSIFY_SECTIONS = `Respond in Markdown using EXACTLY these headings, in this order:

## Recommended Classification
The 8-digit AHTN code, the official nomenclature wording, and a confidence level.

## Classification Rationale (GIR)
Walk the reasoning: Chapter → heading (GIR 1 + the governing Section/Chapter Note) → 6-digit subheading (GIR 6) → 8-digit AHTN subdivision (GIR 6). State which criterion resolves at which digit level.

## Alternative Codes Considered
Codes a customs officer might reasonably argue for, and the specific reason each is rejected. Write "None — the heading text is unambiguous" if that is genuinely the case.

## Import Duty & Tax
Indicative MFN rate, VAT, and any excise. Flag Anti-Dumping / Safeguard exposure where the goods are in a category commonly subject to it. State that all figures must be confirmed at http://itd.customs.go.th/igtf/viewerImportTariff.do?param=main

## FTA Preferential Treatment
Only for the stated country of origin. If there is no FTA in force with Thailand, say so explicitly and state that the MFN rate applies. Name the correct certificate of origin form. Note that FTA eligibility depends on the rules of origin for the specific code, not merely on the country. If a rate is exempt or reduced, do not assume 0% for sensitive-list goods such as steel — say it must be checked.

## Licences, Permits & Requirements
Agencies involved, mandatory standards, NSW measures. If genuinely unrestricted, write "Freely importable — no additional licence required."

## Supporting Documents
Invoice, Packing List, B/L or AWB, plus documents specific to these goods.

## Information Still Needed
Facts that would confirm or change this classification. Write "None" only if the description is genuinely complete.`;

const VERIFY_SECTIONS = `Respond in Markdown using EXACTLY these headings, in this order:

## Verdict
One of: ✅ Correct / ⚠ Arguable — review recommended / ❌ Incorrect. Add a confidence level.

## Assessment
Whether the submitted code matches the goods, tested against the heading text and the governing Section/Chapter Notes.

## Classification Rationale (GIR)
GIR 1 for the heading, GIR 6 for the 6-digit and 8-digit levels. State which digit level each criterion resolves at.

## Recommended Code
Only if it differs from the submitted code. Otherwise write "The submitted code is appropriate."

## Import Duty & Tax
Indicative rates for the correct code, flagged as requiring ITD verification.

## Licences, Permits & Requirements

## Information Still Needed`;

const langLine = (lang) =>
  lang === "th"
    ? `Write the entire response in Thai. Keep tariff codes, form names and legal instrument names in their official form. Keep the Markdown headings in English exactly as specified.`
    : `Write the entire response in English. Keep Thai legal instrument names in Thai script with an English gloss on first mention.`;

const buildSystem = (mode, lang) =>
  `You are a Thai customs tariff classification specialist advising a freight forwarder.

${GROUNDING}

${mode === "verify" ? VERIFY_SECTIONS : CLASSIFY_SECTIONS}

${langLine(lang)}
Be concise and specific. Prefer short paragraphs and bullet lists over long prose.`;

const IMAGE_INSTRUCTION = `IMAGES ATTACHED — additional rules:
- First state what is actually visible: form, apparent material, construction, markings, nameplate data, labels, packaging.
- Distinguish clearly between what you can SEE and what you are INFERRING. Say "appears to be" for inferences.
- Photographs rarely reveal material composition, degree of processing or precise function — the facts that most often decide classification. Where the image cannot settle these, put them under "Information Still Needed" rather than assuming.
- If the image contradicts the written description, say so explicitly and classify on the more reliable evidence, explaining which you chose and why.`;

/* ────────────────────────────────────────────────────────────
   HANDLER
   ──────────────────────────────────────────────────────────── */
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method Not Allowed" });
  }

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return json(500, { error: "API key not configured" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  const { mode, description, origin, purpose, extra, hsCode, lang } = body;
  const images = Array.isArray(body.images) ? body.images : [];

  /* ── validation ── */
  if (mode === "verify") {
    if (!hsCode || !description) {
      return json(400, { error: "Both an HS code and a product description are required" });
    }
  } else if (!description && images.length === 0) {
    return json(400, { error: "Provide a product description, an image, or both" });
  }

  if (images.length > MAX_IMAGES) {
    return json(400, { error: `Too many images — the maximum is ${MAX_IMAGES}` });
  }

  let totalChars = 0;
  for (const img of images) {
    if (!img || typeof img.data !== "string" || !img.data) {
      return json(400, { error: "An attached image is malformed" });
    }
    if (!ALLOWED_MEDIA.includes(img.media_type)) {
      return json(400, { error: `Unsupported image type: ${img.media_type}. Use JPEG, PNG, WebP or GIF.` });
    }
    if (img.data.length > MAX_IMAGE_CHARS) {
      return json(413, { error: "An image is too large after compression — please attach a smaller one" });
    }
    totalChars += img.data.length;
  }
  if (totalChars > MAX_TOTAL_CHARS) {
    return json(413, { error: "Attached images are too large in total — please remove one" });
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
    if (description) lines.push(`Goods to be imported: ${description}`);
    else lines.push(`Goods to be imported: see attached image(s) — no written description was provided.`);
    if (origin) lines.push(`Country of origin: ${origin}`);
    if (purpose) lines.push(`Intended purpose: ${purpose}`);
    if (extra) lines.push(`Additional details: ${extra}`);
    lines.push(`\nClassify these goods and complete every section.`);
    userText = lines.join("\n");
  }

  /* ── content blocks: images first, then text ── */
  const content = [
    ...images.map((img) => ({
      type: "image",
      source: { type: "base64", media_type: img.media_type, data: img.data },
    })),
    { type: "text", text: userText },
  ];

  const system =
    buildSystem(mode, lang === "th" ? "th" : "en") +
    (images.length ? `\n\n${IMAGE_INSTRUCTION}` : "");

  /* ── call Anthropic ── */
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system,
        messages: [{ role: "user", content }],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return json(response.status, {
        error: data?.error?.message || `Anthropic API error (HTTP ${response.status})`,
      });
    }

    const text = (data.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");

    if (!text.trim()) {
      return json(502, { error: "The model returned an empty response — please try again" });
    }

    return json(200, {
      result: text,
      meta: {
        model: MODEL,
        images: images.length,
        stop_reason: data.stop_reason,
        truncated: data.stop_reason === "max_tokens",
      },
    });
  } catch (err) {
    return json(500, { error: err.message || "Upstream request failed" });
  }
};
