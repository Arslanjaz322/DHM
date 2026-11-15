// Visitor reviews: anyone can post (published at once), the admin hides / shows / deletes them.
// GET  /api/reviews          -> published reviews (public)
// GET  /api/reviews?all=1    -> every review incl. hidden (admin)
// POST /api/reviews          -> { name, rating, text, page, hp }  (public submit)
// POST /api/reviews          -> { action: "hide" | "show" | "delete", id }  (admin)
import { getSession, logAct } from "./auth.server";
import { db, fail, fullIp, json, now, readTextLimited, serverError, sha256Hex } from "./util.server";

const MAX_LIST = 500;
const RATE_MAX = 3; // reviews per visitor per hour
const RATE_WINDOW = 60 * 60 * 1000;
// Links and e-mail addresses are refused so open posting cannot be used for spam.
const SPAM_RE = /https?:|www\.|[a-z0-9-]+\.(com|net|org|pk|info|xyz|ru|biz|io|top|site|online)\b|[^\s@]+@[^\s@]+\.[a-z]{2,}/i;

const clean = (s: unknown, max: number) =>
  String(s ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);

export type ReviewInput = { name: string; rating: number; text: string; page: string };

/** Validates a public review; returns the cleaned values or an error message for the visitor. */
export function validateReview(b: Record<string, unknown>): { ok: true; v: ReviewInput } | { ok: false; error: string } {
  const name = clean(b["name"], 60).replace(/\n/g, " ");
  const text = clean(b["text"], 1000);
  const rating = Math.round(Number(b["rating"]));
  let page = String(b["page"] ?? "/").slice(0, 200);
  if (!page.startsWith("/")) page = "/";
  if (name.length < 2) return { ok: false, error: "Please enter your name." };
  if (!(rating >= 1 && rating <= 5)) return { ok: false, error: "Please choose a star rating." };
  if (text.length < 10) return { ok: false, error: "Please write at least 10 characters." };
  if (SPAM_RE.test(name) || SPAM_RE.test(text)) return { ok: false, error: "Links and e-mail addresses are not allowed in reviews." };
  return { ok: true, v: { name, rating, text, page } };
}

export async function reviewsGET(request: Request): Promise<Response> {
  try {
    const all = new URL(request.url).searchParams.get("all") === "1";
    if (all) {
      const s = await getSession(request);
      if (!s) return fail(401, "Not signed in.");
      const { data } = await db()
        .from("reviews")
        .select("id,name,rating,text,page,status,created_at")
        .order("id", { ascending: false })
        .limit(2000);
      return json({ ok: true, reviews: data || [] });
    }
    const { data } = await db()
      .from("reviews")
      .select("id,name,rating,text,created_at")
      .eq("status", "published")
      .order("id", { ascending: false })
      .limit(MAX_LIST);
    return json({ ok: true, reviews: data || [] }, 200, { "cache-control": "no-cache" });
  } catch (e) {
    console.error("reviews GET failed", e);
    return serverError(e);
  }
}

export async function reviewsPOST(request: Request): Promise<Response> {
  try {
    const raw = await readTextLimited(request, 16 * 1024);
    if (raw === null) return fail(413, "This request is too large.");
    let b: Record<string, unknown>;
    try {
      b = JSON.parse(raw);
    } catch {
      return fail(400, "Invalid request.");
    }
    if (!b || typeof b !== "object") return fail(400, "Invalid request.");

    // ---- admin actions ----
    if (b["action"] !== undefined) {
      const s = await getSession(request);
      if (!s) return fail(401, "Not signed in.");
      const id = Math.floor(Number(b["id"]));
      if (!(id > 0)) return fail(400, "Missing review.");
      const action = String(b["action"]);
      if (action === "hide" || action === "show") {
        await db().from("reviews").update({ status: action === "hide" ? "hidden" : "published" }).eq("id", id);
      } else if (action === "delete") {
        await db().from("reviews").delete().eq("id", id);
      } else {
        return fail(400, "Unknown action.");
      }
      await logAct(request, s.user, "review-" + action, "#" + id);
      return json({ ok: true });
    }

    // ---- public submit ----
    if (String(b["hp"] ?? "").trim()) return json({ ok: true }); // honeypot: bots fill it, people never see it
    const r = validateReview(b);
    if (!r.ok) return fail(400, r.error);

    const t = now();
    const key = "rv:" + (await sha256Hex(fullIp(request))).slice(0, 32);
    const { count } = await db().from("login_attempts").select("id", { count: "exact", head: true }).eq("key", key).gt("at", t - RATE_WINDOW);
    if ((count || 0) >= RATE_MAX) return fail(429, "You have sent several reviews already. Please try again later.");
    await db().from("login_attempts").insert({ key, at: t });
    await db().from("login_attempts").delete().lt("at", t - 24 * 60 * 60 * 1000);

    await db().from("reviews").insert({ name: r.v.name, rating: r.v.rating, text: r.v.text, page: r.v.page, status: "published", created_at: t });
    return json({ ok: true });
  } catch (e) {
    console.error("reviews POST failed", e);
    return serverError(e);
  }
}
