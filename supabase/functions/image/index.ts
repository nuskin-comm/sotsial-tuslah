// Постерын ДЭВСГЭР зургийг OpenAI-ийн зургийн AI-аар үүсгэнэ.
// Бичвэр, бүтээгдэхүүн, лого зурахгүй — тэдгээрийг апп өөрөө жинхэнэ зураг, зөв кириллээр нэмнэ.
// Supabase Secrets: OPENAI_API_KEY, (заавал биш) OPENAI_IMAGE_MODEL
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const DEFAULT_MODEL = "gpt-image-2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "Зөвхөн POST" });

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return reply(401, { error: "Нэвтрээгүй байна." });
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false },
  });
  const { data: u, error: ue } = await sb.auth.getUser(token);
  if (ue || !u?.user) return reply(401, { error: "Нэвтрэх хугацаа дууссан байна. Дахин нэвтэрнэ үү." });

  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) return reply(400, { error: "OpenAI-ийн түлхүүр (OPENAI_API_KEY) Supabase Secrets дээр оруулаагүй байна." });
  const model = Deno.env.get("OPENAI_IMAGE_MODEL") || DEFAULT_MODEL;

  const body = await req.json().catch(() => ({}));
  const topic = String(body.topic || "").slice(0, 300);
  const mood = String(body.mood || "").slice(0, 300);

  const prompt = [
    "Premium, minimalist product-photography BACKDROP for a luxury skincare brand advertisement.",
    `Theme / scene idea: ${topic || "elegant skincare"}.`,
    mood ? `Mood: ${mood}.` : "Mood: elegant, calm, confident, trustworthy.",
    "Soft natural daylight, gentle shadows, refined textures (e.g. marble, silk, stone, water, botanicals), muted neutral palette with subtle deep green accents.",
    "Composition: vertical. Leave a clean, empty surface in the lower-middle area where a product will be placed later, and generous calm empty space at the top for a headline.",
    "STRICTLY: no text, no letters, no numbers, no logos, no watermarks, no products, no bottles, no packaging, no people, no hands.",
  ].join(" ");

  const r = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, size: "1024x1536", quality: "medium", n: 1 }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || "";
    if (r.status === 401) return reply(400, { error: "OpenAI-ийн түлхүүр буруу эсвэл хүчингүй байна." });
    if (r.status === 429) return reply(400, { error: "OpenAI-ийн дансны үлдэгдэл дууссан эсвэл түр ачаалалтай байна." });
    if (r.status === 404 || /model/i.test(msg)) return reply(400, { error: `OpenAI-д "${model}" зургийн загвар олдсонгүй. Supabase Secrets дээр OPENAI_IMAGE_MODEL-ийг зөв нэрээр тохируулна уу.` });
    if (/organization must be verified|verify/i.test(msg)) return reply(400, { error: "OpenAI зургийн загвар ашиглахын тулд OpenAI дээр байгууллагаа баталгаажуулах (Verify organization) шаардлагатай байна." });
    if (/safety|moderation/i.test(msg)) return reply(400, { error: "OpenAI энэ сэдвээр зураг зурахаас татгалзлаа. Сэдвээ өөрөөр бичээд дахин оролдоно уу." });
    console.error(r.status, msg);
    return reply(400, { error: `OpenAI алдаа өглөө (${r.status}). Дахин оролдоно уу.` });
  }
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) return reply(500, { error: "OpenAI зураг буцаасангүй. Дахин оролдоно уу." });
  return reply(200, { image: `data:image/png;base64,${b64}` });
});
