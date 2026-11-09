// Admin access is OPEN: there is no username, password, email or token check any more.
// Every request is treated as the owner. (Sign-in was removed on request.)
import { clientIp, db, json, now } from "./util.server";

export type Role = "owner" | "editor";
export type Session = { user: string; role: Role; isMain: boolean; tokenHash: string };

const OPEN_SESSION: Session = { user: "admin", role: "owner", isMain: true, tokenHash: "open" };
// The admin page sends this constant in the X-Admin-Token header; it is never checked.
const OPEN_TOKEN = "0".repeat(64);

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

// Always returns the owner session: no sign-in is needed.
export async function getSession(_request: Request): Promise<Session | null> {
  return OPEN_SESSION;
}

// Kept so the admin page's old "sign in" call still works: it always succeeds.
export async function login(_request: Request, _body: { user?: string; pass?: string }): Promise<Response> {
  return json({ ok: true, token: OPEN_TOKEN, user: OPEN_SESSION.user, role: OPEN_SESSION.role });
}

export async function logout(_request: Request, _s: Session | null): Promise<Response> {
  return json({ ok: true });
}

const removed = () => json({ ok: false, error: "Accounts and passwords have been removed: the admin panel is open." }, 410);

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
