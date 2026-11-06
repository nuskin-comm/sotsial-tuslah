// AI-аар пост бичүүлэх серверийн функц.
// API түлхүүрүүд зөвхөн Supabase-ийн нууц хадгалалтад (Edge Function Secrets) байна:
//   ANTHROPIC_API_KEY  — Claude ашиглах бол
//   OPENAI_API_KEY     — OpenAI ашиглах бол
//   OPENAI_MODEL       — (заавал биш) OpenAI-ийн загварын нэр
import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const CLAUDE_MODEL = "claude-opus-5-5";
const OPENAI_DEFAULT_MODEL = "gpt-6.1-sol";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

class UserError extends Error {}

const SCHEMA = {
  type: "object",
  properties: {
    caption: { type: "string", description: "Нийтлэгдэх бичвэр (hashtag-тай)" },
    script: { type: "string", description: "Зөвхөн reel-д: видеон дээр хэлэх үг. Постерт хоосон." },
  },
  required: ["caption", "script"],
  additionalProperties: false,
};

function buildPrompt(profile: Record<string, string>, input: Record<string, string>) {
  const system = `Чи бол нэг хүний сошиал хуудсанд пост бичдэг туслах. Зөвхөн монгол кирилл үсгээр бичнэ.

ХАТУУ ДҮРЭМ:
- Доор өгөгдсөн мэдээлэлд байхгүй тоо, хувь, судалгаа, үнэ, хямдрал, шагнал, хэрэглэгчийн сэтгэгдэл, баримт бүү зохио.
- Эмчилгээний болон эрүүл мэндийн амлалт бүү өг ("эмчилнэ", "100% арилгана", "гарантитай" гэх мэт).
- Бүтээгдэхүүний найрлага, үр дүнгийн талаар зөвхөн хэрэглэгчийн өгсөн мэдээллээр бич. Мэдээлэл дутуу бол ерөнхий, үнэн зөв байдлаар бич.
- Өөр брэнд, өрсөлдөгчийг бүү дурд.
- Хэрэглэгчийн жишээ постуудын хэв маяг, өгүүлбэрийн урт, emoji хэрэглээг дуурай.

ХЭЛБЭР:
- Постер: 60–150 үгтэй, эхний мөр нь анхаарал татсан, төгсгөлд нь зөөлөн уриалга (жишээ нь мессеж бичихийг урих), дараа нь 3–6 hashtag. "script" хоосон.
- Reel: "caption" нь богино (20–60 үг) тайлбар + 3–6 hashtag. "script" нь 20–40 секундийн видеон дээр хэлэх үг, хэсэг бүрийг шинэ мөрөнд.

ХЭРЭГЛЭГЧИЙН ТУХАЙ:
Брэнд: ${profile.brand_name || "(бичээгүй)"}
Юу хийдэг: ${profile.about || "(бичээгүй)"}
Хэнд зориулж: ${profile.audience || "(бичээгүй)"}
Өнгө аяс: ${profile.tone || "(бичээгүй)"}

ЖИШЭЭ ПОСТУУД:
${profile.sample_posts || "(байхгүй)"}`;

  let user = `Төрөл: ${input.kind === "reel" ? "Reel" : "Постер"}\nСэдэв: ${input.topic}`;
  if (input.current) user += `\n\nОдоогийн хувилбар:\n${input.current}`;
  if (input.instruction) user += `\n\nӨөрчлөх хүсэлт: ${input.instruction}`;
  else if (input.current) user += `\n\nӨөр өнцгөөс шинэ хувилбар бич.`;
  return { system, user };
}

async function withClaude(system: string, user: string) {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new UserError("Claude-ийн түлхүүр (ANTHROPIC_API_KEY) Supabase дээр оруулаагүй байна.");
  const client = new Anthropic({ apiKey: key });
  try {
    const res = await client.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      system,
      messages: [{ role: "user", content: user }],
    });
    if (res.stop_reason === "refusal") throw new UserError("AI энэ хүсэлтэд бичихээс татгалзлаа. Сэдвээ өөрөөр томъёолоод дахин оролдоно уу.");
    if (res.stop_reason === "max_tokens") throw new UserError("AI-ийн хариу хэт урт болж тасарлаа. Дахин оролдоно уу.");
    const text = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    return JSON.parse(text);
  } catch (e) {
    if (e instanceof UserError) throw e;
    if (e instanceof Anthropic.AuthenticationError) throw new UserError("Claude-ийн түлхүүр буруу эсвэл хүчингүй болсон байна.");
    if (e instanceof Anthropic.RateLimitError) throw new UserError("Claude түр ачаалалтай байна. Хэдэн секунд хүлээгээд дахин оролдоно уу.");
    if (e instanceof Anthropic.APIError && e.status === 402) throw new UserError("Claude-ийн дансны үлдэгдэл дууссан байна.");
    if (e instanceof Anthropic.APIError) throw new UserError(`Claude алдаа өглөө (${e.status}). Дахин оролдоно уу.`);
    throw e;
  }
}

async function withOpenAI(system: string, user: string) {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new UserError("OpenAI-ийн түлхүүр (OPENAI_API_KEY) Supabase дээр оруулаагүй байна.");
  const model = Deno.env.get("OPENAI_MODEL") || OPENAI_DEFAULT_MODEL;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      response_format: { type: "json_schema", json_schema: { name: "post", strict: true, schema: SCHEMA } },
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401) throw new UserError("OpenAI-ийн түлхүүр буруу эсвэл хүчингүй болсон байна.");
    if (r.status === 429) throw new UserError("OpenAI түр ачаалалтай эсвэл дансны үлдэгдэл дууссан байна.");
    if (r.status === 404) throw new UserError(`OpenAI-д "${model}" загвар олдсонгүй. Supabase дээр OPENAI_MODEL-ийг зөв нэрээр тохируулна уу.`);
    throw new UserError(`OpenAI алдаа өглөө (${r.status}). Дахин оролдоно уу.`);
  }
  const msg = data.choices?.[0]?.message;
  if (msg?.refusal) throw new UserError("AI энэ хүсэлтэд бичихээс татгалзлаа.");
  return JSON.parse(msg?.content || "{}");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "Зөвхөн POST" });

  // Нэвтэрсэн хэрэглэгч мөн эсэхийг шалгана
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return reply(401, { error: "Нэвтрээгүй байна." });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userErr } = await sb.auth.getUser(token);
  if (userErr || !userData?.user) return reply(401, { error: "Нэвтрэх хугацаа дууссан байна. Дахин нэвтэрнэ үү." });

  try {
    const input = await req.json().catch(() => ({}));
    const topic = String(input.topic || "").trim().slice(0, 1000);
    const current = String(input.current || "").trim().slice(0, 5000);
    const instruction = String(input.instruction || "").trim().slice(0, 500);
    const kind = input.kind === "reel" ? "reel" : "poster";
    if (!topic && !current) return reply(400, { error: "Сэдвээ бичнэ үү." });

    const { data: profile } = await sb.from("profile").select("*").maybeSingle();
    const { system, user } = buildPrompt(profile || {}, { topic, current, instruction, kind });
    const provider = profile?.ai_provider === "openai" ? "openai" : "claude";
    const out = provider === "openai" ? await withOpenAI(system, user) : await withClaude(system, user);

    return reply(200, {
      caption: String(out.caption || "").trim(),
      script: kind === "reel" ? String(out.script || "").trim() : "",
      provider,
    });
  } catch (e) {
    if (e instanceof UserError) return reply(400, { error: e.message });
    console.error(e);
    return reply(500, { error: "Серверт алдаа гарлаа. Дахин оролдоно уу." });
  }
});
