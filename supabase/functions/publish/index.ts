// Товлолтоор (5 минут тутам) дуудагдаж, цаг нь болсон БАТЛАГДСАН постуудыг нийтэлнэ.
// Зөвхөн Vault-д хадгалсан нууц (x-cron-secret)-тэй хүсэлтийг хүлээн авна.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.117.3";

const GRAPH = "https://graph.facebook.com/v26.0";
const RUPLOAD = "https://rupload.facebook.com/video-upload/v26.0";

class PublishError extends Error {}
class StillProcessing extends Error {} // Instagram видео боловсруулж дуусаагүй — дараагийн удаа үргэлжлүүлнэ

type Post = {
  id: string; user_id: string; kind: string; body: string; channels: string[];
  media_path: string | null; media_type: string | null; external_ids: Record<string, string>;
  extra_media?: string[];
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
  if (/^https:\/\//.test(path)) return path;
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

  const extra = (post.extra_media || []).filter(Boolean);
  if (post.media_type === "image" && post.media_path && extra.length) {
    // Олон зурагтай пост: зургуудыг нийтлэхгүйгээр хуулаад, нэг постод хавсаргана
    const params: Record<string, string> = { message: post.body, access_token: token };
    const all = [post.media_path, ...extra];
    for (let i = 0; i < all.length; i++) {
      const url = await signedUrl(db, all[i]);
      const ph = await fbPost(`${GRAPH}/${page}/photos`, { url, published: "false", access_token: token });
      params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: ph.id });
    }
    const res = await fbPost(`${GRAPH}/${page}/feed`, params);
    return String(res.id);
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

async function fbGet(url: string, params: Record<string, string>) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u);
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw fbError(data, r.status);
  return data;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Instagram: 1) контейнер үүсгэх 2) бэлэн болохыг хүлээх 3) нийтлэх
async function publishInstagram(db: SupabaseClient, post: Post, ch: Channel, ids: Record<string, string>): Promise<string> {
  const ig = ch.account_id, token = ch.access_token;
  if (!post.media_path) throw new PublishError("Instagram-д зураг эсвэл видео заавал хэрэгтэй.");

  let container = ids.instagram_container;
  if (!container) {
    const extra = (post.extra_media || []).filter(Boolean);
    let res;
    if (post.media_type === "image" && extra.length) {
      const children: string[] = [];
      for (const pth of [post.media_path, ...extra]) {
        const c = await fbPost(`${GRAPH}/${ig}/media`, { image_url: await signedUrl(db, pth), is_carousel_item: "true", access_token: token });
        children.push(String(c.id));
      }
      res = await fbPost(`${GRAPH}/${ig}/media`, { media_type: "CAROUSEL", children: children.join(","), caption: post.body, access_token: token });
    } else {
      const url = await signedUrl(db, post.media_path);
      const params: Record<string, string> = { caption: post.body, access_token: token };
      if (post.media_type === "video") { params.media_type = "REELS"; params.video_url = url; }
      else params.image_url = url;
      res = await fbPost(`${GRAPH}/${ig}/media`, params);
    }
    container = String(res.id);
    ids.instagram_container = container;
    await db.from("posts").update({ external_ids: ids }).eq("id", post.id);
  }

  // Бэлэн болтол хүлээнэ (видео удаан байж болно)
  const deadline = Date.now() + 40_000;
  while (true) {
    const st = await fbGet(`${GRAPH}/${container}`, { fields: "status_code", access_token: token });
    if (st.status_code === "FINISHED") break;
    if (st.status_code === "ERROR" || st.status_code === "EXPIRED") {
      delete ids.instagram_container;
      throw new PublishError("Instagram зураг/видеог боловсруулж чадсангүй. Зураг: JPG, харьцаа 4:5-аас 1.91:1 хооронд. Reel: босоо MP4, 3–90 секунд.");
    }
    if (Date.now() > deadline) throw new StillProcessing();
    await sleep(5000);
  }
  const pub = await fbPost(`${GRAPH}/${ig}/media_publish`, { creation_id: container, access_token: token });
  delete ids.instagram_container;
  return String(pub.id);
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
      else if (name === "instagram") ids.instagram = await publishInstagram(db, post, ch, ids);
      // Суваг бүрийн дараа шууд хадгална — дахин оролдоход давхардахгүй
      await db.from("posts").update({ external_ids: ids }).eq("id", post.id);
    }
    await db.from("posts").update({ status: "published", published_at: new Date().toISOString(), error: null, external_ids: ids }).eq("id", post.id);
    return { id: post.id, ok: true };
  } catch (e) {
    if (e instanceof StillProcessing) {
      // Видео боловсруулагдаж байна: 5 минутын дараа товлолт дахин авна
      await db.from("posts").update({ status: "approved", external_ids: ids }).eq("id", post.id);
      return { id: post.id, ok: false, pending: true };
    }
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
