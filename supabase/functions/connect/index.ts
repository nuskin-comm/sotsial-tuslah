// Facebook хуудас холбох функц.
// Хэрэглэгчийн богино хугацаат токеныг урт хугацаат болгож, хуудасны токеныг
// зөвхөн серверт (channels хүснэгтэд) хадгална. Токен хөтөч рүү буцахгүй.
// Supabase Secrets: META_APP_ID, META_APP_SECRET
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const GRAPH = "https://graph.facebook.com/v26.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

class UserError extends Error {}

async function graph(path: string, params: Record<string, string>) {
  const url = new URL(GRAPH + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url);
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    const e = data.error || {};
    if (e.code === 190) throw new UserError("Токен хүчингүй эсвэл хугацаа нь дууссан байна. Graph API Explorer-оос шинэ токен аваад дахин оролдоно уу.");
    if (e.code === 101 || e.code === 1) throw new UserError("META_APP_ID эсвэл META_APP_SECRET буруу байна. Supabase Secrets-ээ шалгана уу.");
    throw new UserError(`Facebook алдаа: ${e.message || r.status}`);
  }
  return data;
}

async function pagesFor(userToken: string) {
  const appId = Deno.env.get("META_APP_ID");
  const secret = Deno.env.get("META_APP_SECRET");
  if (!appId || !secret) throw new UserError("Supabase Secrets дээр META_APP_ID, META_APP_SECRET оруулаагүй байна.");
  const ex = await graph("/oauth/access_token", {
    grant_type: "fb_exchange_token", client_id: appId, client_secret: secret, fb_exchange_token: userToken,
  });
  const acc = await graph("/me/accounts", { fields: "id,name,access_token,tasks", access_token: ex.access_token, limit: "100" });
  const diag: string[] = [];
  const pages = (acc.data || []) as { id: string; name: string; access_token: string; tasks?: string[] }[];
  if (!pages.length) {
    // Facebook Login for Business: сонгосон хуудсууд токены granular_scopes-д байдаг
    const dbg = await graph("/debug_token", { input_token: ex.access_token, access_token: `${appId}|${secret}` }).catch((e) => { diag.push("debug_token: " + e.message); return null; });
    const scopes = (dbg?.data?.granular_scopes || []) as { scope: string; target_ids?: string[] }[];
    diag.push("scopes: " + (scopes.map((s) => `${s.scope}[${(s.target_ids || []).join("/")}]`).join(", ") || "хоосон"));
    diag.push("token type: " + (dbg?.data?.type || "?") + ", valid: " + dbg?.data?.is_valid);
    const ids = new Set<string>();
    for (const s of scopes) if (s.scope.startsWith("pages_")) for (const id of s.target_ids || []) ids.add(id);
    for (const id of ids) {
      const p = await graph(`/${id}`, { fields: "id,name,access_token,tasks", access_token: ex.access_token }).catch((e) => { diag.push(`page ${id}: ${e.message}`); return null; });
      if (p?.access_token) pages.push(p);
      else if (p) diag.push(`page ${id}: access_token алга`);
    }
  }
  if (!pages.length) {
    // Яагаад хуудас олдсонгүйг энгийнээр тайлбарлана
    const perms = await graph("/me/permissions", { access_token: ex.access_token }).catch(() => ({ data: [] }));
    const granted = new Set((perms.data || []).filter((p: { status: string }) => p.status === "granted").map((p: { permission: string }) => p.permission));
    const need = ["pages_show_list", "pages_manage_posts", "pages_read_engagement"];
    const missing = need.filter((p) => !granted.has(p));
    if (missing.length) {
      throw new UserError(`Токен авахдаа дараах эрхийг зөвшөөрөөгүй байна: ${missing.join(", ")}. Graph API Explorer дээр "Generate Access Token" дахин дарж, бүх эрхийг зөвшөөрнө үү.`);
    }
    throw new UserError("Эрхүүд зөв байна, гэхдээ хуудсаа сонгоогүй байна. Graph API Explorer дээр \"Generate Access Token\" дахин дараад, Facebook-ийн цонхонд \"Edit access\" дарж Nu Skin хуудсаа ✅ чагтлаад шинэ токеноо оруулна уу. [Оношлогоо: " + diag.join(" | ") + "]");
  }
  return pages;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "Зөвхөн POST" });

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return reply(401, { error: "Нэвтрээгүй байна." });
  const url = Deno.env.get("SUPABASE_URL")!;
  const asUser = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { auth: { persistSession: false } });
  const { data: u, error: ue } = await asUser.auth.getUser(token);
  if (ue || !u?.user) return reply(401, { error: "Нэвтрэх хугацаа дууссан байна. Дахин нэвтэрнэ үү." });

  try {
    const body = await req.json().catch(() => ({}));
    const userToken = String(body.user_token || "").trim();
    if (!userToken) return reply(400, { error: "Токеноо оруулна уу." });
    const pages = await pagesFor(userToken);

    if (body.action === "list_pages") {
      return reply(200, { pages: pages.map((p) => ({ id: p.id, name: p.name })) });
    }

    if (body.action === "save_page") {
      const page = pages.find((p) => p.id === String(body.page_id));
      if (!page) throw new UserError("Сонгосон хуудас олдсонгүй.");
      if (page.tasks && !page.tasks.includes("CREATE_CONTENT")) {
        throw new UserError("Энэ хуудсанд пост оруулах эрх танд алга байна.");
      }
      const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
      const { error } = await admin.from("channels").upsert({
        user_id: u.user.id, platform: "facebook", account_id: page.id, account_name: page.name,
        access_token: page.access_token, connected_at: new Date().toISOString(), last_error: null,
      }, { onConflict: "user_id,platform" });
      if (error) throw error;
      return reply(200, { ok: true, name: page.name });
    }
    return reply(400, { error: "Буруу үйлдэл." });
  } catch (e) {
    if (e instanceof UserError) return reply(400, { error: e.message });
    console.error(e);
    return reply(500, { error: "Серверт алдаа гарлаа. Дахин оролдоно уу." });
  }
});
