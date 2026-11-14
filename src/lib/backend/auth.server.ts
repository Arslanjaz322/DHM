import { cfEnv } from "./d1.server";
import { clientIp, db, fail, fullIp, json, now, safeEqual } from "./util.server";

export type Role = "owner" | "editor";
export type Session = { user: string; role: Role; isMain: boolean; tokenHash: string };

export async function logAct(request: Request | null, who: string, action: string, detail = "") {
  try {
    await db()
      .from("activity_log")
      .insert({
        at: now(),
        who: who.slice(0, 60),
        action,
        detail: detail.slice(0, 500),
        ip: request ? clientIp(request) : "",
        ua: request ? (request.headers.get("user-agent") || "").slice(0, 200) : "",
      });
    const { data } = await db().from("activity_log").select("id").order("id", { ascending: false }).range(300, 300);
    if (data?.[0]) await db().from("activity_log").delete().lte("id", data[0].id);
  } catch (e) {
    console.error("activity log failed", e);
  }
}

const OWNER_MS = 12 * 60 * 60 * 1000;
const LOCK_WINDOW = 15 * 60 * 1000;
const LOCK_MAX = 8;
const te = new TextEncoder();

function ownerCreds() {
  const e = cfEnv();
  const pe = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env || {};
  const u = String((e["ADMIN_USERNAME"] as string | undefined) ?? pe["ADMIN_USERNAME"] ?? "").trim().toLowerCase();
  const p = String((e["ADMIN_PASSWORD"] as string | undefined) ?? pe["ADMIN_PASSWORD"] ?? "");
  return { u, p };
}

async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", te.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, te.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function makeOwnerToken(): Promise<string> {
  const { u, p } = ownerCreds();
  const exp = String(now() + OWNER_MS);
  return exp + "." + (await hmacHex(p + "|" + u, "owner|" + exp));
}

// Valid only with a token issued by the owner login above (header X-Owner-Token or X-Admin-Token).
export async function ownerSession(request: Request): Promise<Session | null> {
  const rawToken = request.headers.get("x-owner-token") || request.headers.get("x-admin-token") || "";
  const m = /^(\d{10,16})\.([a-f0-9]{64})$/.exec(rawToken);
  if (!m) return null;
  const { u, p } = ownerCreds();
  if (!u || !p || Number(m[1]) < now()) return null;
  const good = await hmacHex(p + "|" + u, "owner|" + m[1]);
  return safeEqual(good, m[2]!) ? { user: u, role: "owner", isMain: true, tokenHash: "owner" } : null;
}

// Require a valid owner token for ALL /admin routes and APIs
export async function getSession(request: Request): Promise<Session | null> {
  return ownerSession(request);
}

export async function login(request: Request, body: { user?: string; pass?: string }): Promise<Response> {
  const { u: cu, p: cp } = ownerCreds();
  if (!cu || !cp) {
    return fail(503, "The owner login is not set up. In Cloudflare add the secrets ADMIN_USERNAME and ADMIN_PASSWORD.");
  }
  const user = String(body.user || "").trim().toLowerCase().slice(0, 80);
  const pass = String(body.pass || "").slice(0, 200);
  const key = "ip:" + fullIp(request);
  const t = now();

  const { count } = await db()
    .from("login_attempts")
    .select("id", { count: "exact", head: true })
    .eq("key", key)
    .gt("at", t - LOCK_WINDOW);

  if ((count || 0) >= LOCK_MAX) {
    return json({ ok: false, error: "Too many attempts.", wait: LOCK_WINDOW }, 429);
  }

  // Run both constant-time checks unconditionally to prevent timing leaks
  const userOk = safeEqual(user, cu);
  const passOk = safeEqual(pass, cp);

  if (user.length > 0 && userOk && passOk) {
    await db().from("login_attempts").delete().eq("key", key);
    await logAct(request, cu, "login", "admin");
    return json({ ok: true, token: await makeOwnerToken(), user: cu, role: "owner" });
  }

  await db().from("login_attempts").insert({ key, at: t });
  await db().from("login_attempts").delete().lt("at", t - 24 * 60 * 60 * 1000);
  await logAct(request, user || "(blank)", "login-failed", "admin");
  return fail(401, "Wrong username or password.");
}

export async function logout(_request: Request, _s: Session | null): Promise<Response> {
  return json({ ok: true });
}

const removed = () => json({ ok: false, error: "Multi-user accounts are disabled; use owner login." }, 410);

export async function setCred(_request: Request, _s: Session, _b: Record<string, string>): Promise<Response> {
  return removed();
}

export async function listUsers(_s: Session): Promise<Response> {
  return json({ ok: true, users: [] });
}

export async function addUser(_request: Request, _s: Session, _b: Record<string, string>): Promise<Response> {
  return removed();
}

export async function delUser(_request: Request, _s: Session, _b: Record<string, string>): Promise<Response> {
  return removed();
}

export async function readLog(): Promise<Response> {
  const { data } = await db()
    .from("activity_log")
    .select("at, who, action, detail, ip, ua")
    .order("at", { ascending: false })
    .limit(300);
  return json({ ok: true, log: data || [] });
}
