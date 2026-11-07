// Товлолтоор (5 минут тутам) дуудагдаж, цаг нь болсон БАТЛАГДСАН постуудыг нийтэлнэ.
// Зөвхөн Vault-д хадгалсан нууц (x-cron-secret)-тэй хүсэлтийг хүлээн авна.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.117.3";

const GRAPH = "https://graph.facebook.com/v26.0";
const RUPLOAD = "https://rupload.facebook.com/video-upload/v26.0";

class PublishError extends Error {}

type Post = {
  id: string; user_id: string; kind: string; body: string; channels: string[];
  media_path: string | null; media_type: string | null; external_ids: Record<string, string>;
};
type Channel = { platform: string; account_id: string; access_token: string };

function fbError(data: any, status: number): PublishError {
  const e = data?.error || {};
  const code = e.code;
  if (code === 190) return new PublishError("Facebook-ийн холболтын хугацаа дууссан байна. Тохиргооноос Facebook-оо дахин холбоод \"Дахин оролдох\" дарна уу.");
  if (code === 10 || code === 200 || (code >= 200 && code < 300)) return new PublishError("Facebook нийтлэх эрх өгөөгүй байна. Токен авахдаа pages_manage_posts эрхийг зөвшөөрсөн эсэхээ шалгаад дахин холбоно уу.");
  if (code === 368) return new PublishError("Facebook энэ үйлдлийг түр хаасан байна. Хэсэг хугацааны дараа дахин оролдоно уу.");
  if (code === 4 || code === 17 || code === 32 || code === 613) return new PublishError("Facebook-ийн хязгаарт хүрсэн байна (хэт олон хүсэлт). Хэсэг хүлээгээд дахин оролдоно уу.");
  if (code === 324 || code === 1363030 || code === 352) return new PublishError("Facebook зураг/видеог хүлээж авсангүй. Файлын төрөл, хэмжээг шалгана уу (reel: босоо 9:16, 3-90 секунд).");
  return new PublishError(`Facebook алдаа өглөө: ${e.error_user_msg || e.message || "HTTP " + status}`);
}

async function fbPost(url: string, params: Record<string, string>, headers: Record<string, string> = {}) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw fbError(data, r.status);
  return data;
}

async function signedUrl(db: SupabaseClient, path: string) {
  const { data, error } = await db.storage.from("media").createSignedUrl(path, 3600);
  if (error || !data?.signedUrl) throw new PublishError("Хавсаргасан зураг/видео олдсонгүй. Постоо засаад файлаа дахин оруулна уу.");
  return data.signedUrl;
}

async function publishFacebook(db: SupabaseClient, post: Post, ch: Channel): Promise<string> {
  const page = ch.account_id, token = ch.access_token;

  if (post.kind === "reel") {
    if (post.media_type !== "video" || !post.media_path) throw new PublishError("Reel-д видео хавсаргаагүй байна.");
    const fileUrl = await signedUrl(db, post.media_path);
    const start = await fbPost(`${GRAPH}/${page}/video_reels`, { upload_phase: "start", access_token: token });
    const videoId = start.video_id;
    if (!videoId) throw new PublishError("Facebook reel эхлүүлж чадсангүй.");
    await fbPost(`${RUPLOAD}/${videoId}`, {}, { Authorization: `OAuth ${token}`, file_url: fileUrl });
    await fbPost(`${GRAPH}/${page}/video_reels`, {
      upload_phase: "finish", video_id: videoId, video_state: "PUBLISHED",
      description: post.body, access_token: token,
    });
    return String(videoId);
  }

  if (post.media_type === "image" && post.media_path) {
    const url = await signedUrl(db, post.media_path);
    const res = await fbPost(`${GRAPH}/${page}/photos`, { url, message: post.body, access_token: token });
    return String(res.post_id || res.id);
  }
  if (post.media_type === "video" && post.media_path) {
    const file_url = await signedUrl(db, post.media_path);
    const res = await fbPost(`${GRAPH}/${page}/videos`, { file_url, description: post.body, access_token: token });
    return String(res.id);
  }
  const res = await fbPost(`${GRAPH}/${page}/feed`, { message: post.body, access_token: token });
  return String(res.id);
}

async function publishOne(db: SupabaseClient, post: Post) {
  const ids: Record<string, string> = { ...(post.external_ids || {}) };
  try {
    const { data: chans } = await db.from("channels").select("platform, account_id, access_token").eq("user_id", post.user_id);
    for (const name of post.channels) {
      if (ids[name]) continue; // аль хэдийн нийтлэгдсэн суваг — дахин нийтлэхгүй
      const ch = (chans || []).find((c: Channel) => c.platform === name);
      if (!ch) throw new PublishError(`${name === "facebook" ? "Facebook" : "Instagram"} холбогдоогүй байна. Тохиргооноос холбоод "Дахин оролдох" дарна уу.`);
      if (name === "facebook") ids.facebook = await publishFacebook(db, post, ch);
      else throw new PublishError("Instagram-д нийтлэх боломж 4-р шатанд нэмэгдэнэ.");
      // Суваг бүрийн дараа шууд хадгална — дахин оролдоход давхардахгүй
      await db.from("posts").update({ external_ids: ids }).eq("id", post.id);
    }
    await db.from("posts").update({ status: "published", published_at: new Date().toISOString(), error: null, external_ids: ids }).eq("id", post.id);
    return { id: post.id, ok: true };
  } catch (e) {
    const msg = e instanceof PublishError ? e.message : "Тодорхойгүй алдаа гарлаа. \"Дахин оролдох\" дарна уу.";
    if (!(e instanceof PublishError)) console.error(e);
    await db.from("posts").update({ status: "failed", error: msg, external_ids: ids }).eq("id", post.id);
    return { id: post.id, ok: false, error: msg };
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  const secret = req.headers.get("x-cron-secret") || "";
  const { data: ok } = secret ? await db.rpc("check_cron_secret", { p_secret: secret }) : { data: false };
  if (!ok) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });

  const { data: posts, error } = await db.rpc("claim_due_posts", { p_limit: 3 });
  if (error) {
    console.error(error);
    return new Response(JSON.stringify({ error: "claim failed" }), { status: 500 });
  }
  const results = [];
  for (const p of (posts || []) as Post[]) results.push(await publishOne(db, p));
  return new Response(JSON.stringify({ processed: results.length, results }), { headers: { "Content-Type": "application/json" } });
});
