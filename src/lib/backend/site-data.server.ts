// /api/site-data: the website's content (read by visitors, published from the admin panel),
// plus admin sign-in, team, activity log and backups.
import {
  addUser,
  adminKeyConfigured,
  delUser,
  getSession,
  hasAdminKey,
  listUsers,
  logAct,
  login,
  logout,
  readLog,
  setCred,
  type Session,
} from "./auth.server";
import { d1 } from "./d1.server";
import { FAQ_CATS_SEED, FAQ_SEED } from "./faq-seed";
import { db, fail, json, now, readTextLimited, serverError, TOOL_KEY_RE, tooLarge } from "./util.server";

const MAX_BYTES = 4.5 * 1024 * 1024; // largest request we accept at all
// Cloudflare D1 cannot store a row bigger than about 2 MB, and the limit is in BYTES (Urdu and other
// non-English letters take 2-3 bytes each), so the site content is measured in bytes with a margin.
const D1_ROW_MAX = 1_900_000;
const byteLen = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
const AUTO_BACKUP_EVERY = 5 * 60 * 1000;
const KEEP_AUTO = 30;
const KEEP_OTHER = 30;
// Request caps: a sign-in request is tiny; signed-in requests may carry the whole site (or a backup file).
const MAX_ADMIN_BODY = MAX_BYTES + 3 * 1024 * 1024;
const MAX_IMPORT_TOOLS = 500;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form site JSON
type Json = any;

// While the saved site has no FAQs, it starts with the built-in DHA Multan FAQs (see faq-seed.ts).
// Once any FAQ exists (for example after the first publish from the admin) the saved FAQs are used as they are.
export function withFaqSeed(d: Json): Json {
  if (!isObj(d)) return d;
  if (Array.isArray(d.faqs) && d.faqs.length) return d;
  const cats = Array.isArray(d.faqCats) ? (d.faqCats as Json[]) : [];
  const haveAll = FAQ_CATS_SEED.every((c) => cats.some((x) => x && x.id === c.id));
  return {
    ...d,
    faqCats: haveAll ? cats : FAQ_CATS_SEED.map((c) => ({ ...c })),
    faqs: FAQ_SEED.map((f) => ({ ...f })),
  };
}

export async function readSite(): Promise<{ data: Json; savedAt: number } | null> {
  const { data } = await db().from("site_state").select("data, saved_at").eq("id", 1).maybeSingle();
  return data ? { data: withFaqSeed(data.data as Json), savedAt: Number(data.saved_at) } : null;
}

// Short-lived in-memory copy of the site for public page views, so most visits skip the large database read
// (the main cost of a slow first response). Admin reads/writes always use readSite() and see fresh data; a save
// clears this copy in the same Worker instance, other instances catch up within SITE_CACHE_MS.
const SITE_CACHE_MS = 15_000;
let siteCache: { at: number; value: { data: Json; savedAt: number } | null } | null = null;

export function invalidateSiteCache(): void {
  siteCache = null;
}

export async function readSiteCached(): Promise<{ data: Json; savedAt: number } | null> {
  if (siteCache && Date.now() - siteCache.at < SITE_CACHE_MS) return siteCache.value;
  const value = await readSite();
  siteCache = { at: Date.now(), value };
  return value;
}

async function trimBackups() {
  for (const [auto, keep] of [
    [true, KEEP_AUTO],
    [false, KEEP_OTHER],
  ] as const) {
    let q = db().from("site_backups").select("id").order("id", { ascending: false }).range(keep, keep);
    q = auto ? q.eq("reason", "auto") : q.neq("reason", "auto");
    const { data } = await q;
    if (data?.[0]) {
      let d = db().from("site_backups").delete().lte("id", data[0].id);
      d = auto ? d.eq("reason", "auto") : d.neq("reason", "auto");
      await d;
    }
  }
}

async function backupCurrent(reason: string, by: string, note?: string, onlyIfDue = false): Promise<boolean> {
  const cur = await readSite();
  if (!cur) return false;
  if (onlyIfDue) {
    const { data: last } = await db()
      .from("site_backups")
      .select("created_at")
      .order("created_at", { ascending: false })
      .limit(1);
    if (last?.[0] && now() - Number(last[0].created_at) < AUTO_BACKUP_EVERY) return false;
  }
  const { error } = await db()
    .from("site_backups")
    .insert({ saved_at: cur.savedAt, data: cur.data, reason, note: note?.slice(0, 120) || null, created_by: by, created_at: now() });
  if (error) throw new Error("Could not create a backup: " + error.message);
  await trimBackups();
  return true;
}

async function writeSite(data: Json, by: string, prevAt = 0): Promise<number> {
  const savedAt = Math.max(now(), prevAt + 1);
  const { error } = await db().from("site_state").upsert({ id: 1, data, saved_at: savedAt, updated_by: by });
  if (error) throw new Error(error.message);
  invalidateSiteCache();
  return savedAt;
}

const LABELS: Record<string, string> = {
  title: "site name",
  logo: "logo",
  logoImg: "logo",
  accent: "colours",
  accentCustom: "colours",
  siteBg: "colours",
  surface: "colours",
  nav: "menu",
  delay: "slider timing",
  slides: "hero slider",
  boxes: "tool boxes",
  docs: "documents",
  pages: "pages",
  arts: "Newsflash articles",
  vids: "videos",
  gal: "gallery",
  projs: "projects",
  projCats: "project categories",
  projNav: "menu",
  seo: "SEO settings",
  banner: "banner",
  notes: "notifications",
  perf: "speed settings",
  faqs: "FAQs",
  faqCats: "FAQ categories",
  faqNav: "menu",
  wa: "WhatsApp button",
};

function changedKeys(a: Json | undefined, b: Json): string {
  const set = new Set<string>();
  for (const k of Object.keys(b)) {
    if (JSON.stringify(a?.[k]) !== JSON.stringify(b[k])) set.add(LABELS[k] || k);
  }
  return [...set].join(", ");
}

export function sameSeoOwnerFields(a: Json | undefined, b: Json): boolean {
  const sa = (a?.seo as Json) || {};
  const sb = (b?.seo as Json) || {};
  return (sa.ads || "") === (sb.ads || "") && (sa.head || "") === (sb.head || "");
}

const isObj = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

// Saves only if nobody else saved in the meantime (one atomic statement), so two admins publishing at the
// same moment cannot silently overwrite each other. Returns null when the site changed under us.
async function writeSiteIfUnchanged(data: Json, by: string, prevAt: number | null): Promise<number | null> {
  const savedAt = Math.max(now(), (prevAt ?? 0) + 1);
  const text = JSON.stringify(data);
  const stmt =
    prevAt === null
      ? d1()
          .prepare("INSERT INTO site_state (id, data, saved_at, updated_by) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO NOTHING")
          .bind(text, savedAt, by)
      : d1()
          .prepare("UPDATE site_state SET data = ?, saved_at = ?, updated_by = ? WHERE id = 1 AND saved_at = ?")
          .bind(text, savedAt, by, prevAt);
  const r = await stmt.run();
  invalidateSiteCache();
  return (r.meta?.changes ?? 0) > 0 ? savedAt : null;
}

async function publish(request: Request, s: Session, body: Json, raw: string): Promise<Response> {
  if (raw.length > MAX_BYTES) return fail(413, "The site content is too large.");
  const data = body.data;
  if (!isObj(data)) return fail(400, "Missing site data.");
  if (byteLen(data) > D1_ROW_MAX) {
    return fail(413, "The site content is larger than the database allows (about 1.9 MB). Move pictures into the Photo library (Optimise & speed) and try again.");
  }
  const cur = await readSite();
  if (cur && !body.force && Number(body.base || 0) !== cur.savedAt) {
    return json({ ok: false, error: "A newer version was saved elsewhere.", savedAt: cur.savedAt }, 409);
  }
  if (s.role !== "owner" && !sameSeoOwnerFields(cur?.data, data)) {
    return fail(403, "Only the owner can change the AdSense ID and custom head code.");
  }
  await backupCurrent("auto", s.user, undefined, true);
  let savedAt: number;
  if (body.force) {
    savedAt = await writeSite(data, s.user, cur?.savedAt || 0);
  } else {
    const done = await writeSiteIfUnchanged(data, s.user, cur ? cur.savedAt : null);
    if (done === null) {
      const latest = await readSite();
      return json({ ok: false, error: "A newer version was saved elsewhere.", savedAt: latest?.savedAt ?? 0 }, 409);
    }
    savedAt = done;
  }
  const what = changedKeys(cur?.data, data);
  await logAct(request, s.user, "publish", (body.force ? "overwrite: " : "") + (what || "no visible changes"));
  return json({ ok: true, savedAt });
}

async function listBackups(): Promise<Response> {
  const { data } = await db()
    .from("site_backups")
    .select("id, saved_at, reason, note, created_by, created_at")
    .order("created_at", { ascending: false })
    .limit(80);
  const backups = (data || []).map((b) => ({
    id: b.id,
    at: Number(b.created_at),
    savedAt: Number(b.saved_at),
    reason: b.reason,
    note: b.note || "",
    by: b.created_by || "",
  }));
  return json({ ok: true, backups });
}

async function findBackup(body: Json) {
  let q = db().from("site_backups").select("id, data, saved_at, created_at, reason, note");
  if (body.id !== undefined) q = q.eq("id", Number(body.id));
  else q = q.eq("created_at", Number(body.at));
  const { data } = await q.limit(1).maybeSingle();
  return data;
}

async function restore(request: Request, s: Session, body: Json): Promise<Response> {
  if (s.role !== "owner") return fail(403, "Only the owner can restore backups.");
  const b = await findBackup(body);
  if (!b) return fail(404, "That backup no longer exists.");
  await backupCurrent("before-restore", s.user, "Before restoring " + new Date(Number(b.created_at)).toISOString());
  const cur = await readSite();
  const savedAt = await writeSite(b.data as Json, s.user, cur?.savedAt || 0);
  await logAct(request, s.user, "restore", "backup from " + new Date(Number(b.created_at)).toISOString());
  return json({ ok: true, data: b.data, savedAt });
}

async function exportAll(s: Session): Promise<Response> {
  if (s.role !== "owner") return fail(403, "Only the owner can download a full backup.");
  const site = await readSite();
  const [{ data: tools }, { data: media }, { data: zips }] = await Promise.all([
    db().from("tool_data").select("tool, data, updated_at"),
    db().from("media_items").select("id, name, type, size, alt, opt, kind, at"),
    db().from("tool_zips").select("id, v, entry, name, admin, files").eq("finalized", true),
  ]);
  return json({
    ok: true,
    site,
    tools: tools || [],
    media: (media || []).map((m) => ({ ...m, url: "/media/" + m.id })),
    toolZips: zips || [],
  });
}

async function importBackup(request: Request, s: Session, body: Json, raw: string): Promise<Response> {
  if (s.role !== "owner") return fail(403, "Only the owner can restore backups.");
  if (raw.length > MAX_BYTES + 2 * 1024 * 1024) return fail(413, "The backup's site content is too large.");
  const data = body.data;
  if (!isObj(data) || !("pages" in data || "arts" in data || "boxes" in data || "title" in data)) {
    return fail(400, "This file does not look like a website backup.");
  }
  if (byteLen(data) > D1_ROW_MAX) return fail(413, "The site content in this backup is larger than the database allows (about 1.9 MB).");
  await backupCurrent("before-import", s.user, "Before restoring from a backup file");
  const cur = await readSite();
  const savedAt = await writeSite(data, s.user, cur?.savedAt || 0);
  const tools = Array.isArray(body.tools) ? (body.tools as Json[]).slice(0, MAX_IMPORT_TOOLS) : [];
  // Saved in groups of 30 (one query per group): one query per tool would exceed the number of database
  // queries a single Worker request may run (50 on the Free plan).
  const rows = new Map<string, string | null>();
  for (const t of tools) {
    if (!t || typeof t.tool !== "string" || !TOOL_KEY_RE.test(t.tool)) continue;
    const text = t.data == null ? null : JSON.stringify(t.data);
    if (text !== null && new TextEncoder().encode(text).length > D1_ROW_MAX) continue; // too big for one row
    rows.set(t.tool, text);
  }
  const list = [...rows];
  const stamp = now();
  for (let i = 0; i < list.length; i += 30) {
    const chunk = list.slice(i, i + 30);
    await d1()
      .prepare(
        "INSERT INTO tool_data (tool, data, updated_at) VALUES " +
          chunk.map(() => "(?, ?, ?)").join(", ") +
          " ON CONFLICT (tool) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
      )
      .bind(...chunk.flatMap(([k, v]) => [k, v, stamp]))
      .run();
  }
  await logAct(request, s.user, "restore", `from a backup file (${String(body.name || "backup").slice(0, 80)})`);
  return json({ ok: true, savedAt });
}

/**
 * What visitors may see: the site without its unpublished drafts (pages, articles, projects, videos,
 * photos, FAQs). Only used once the owner has locked the admin with ADMIN_KEY: the admin then loads the
 * full copy by sending the key. Rules are deliberately the same or looser than the website's own
 * "published" checks in site.html, so nothing that is visible today can disappear.
 */
export function publicView(d: Json): Json {
  if (!isObj(d)) return d;
  const out: Json = { ...d };
  const keep = (k: string, fn: (x: Json) => boolean) => {
    if (Array.isArray(out[k])) out[k] = (out[k] as Json[]).filter(fn);
  };
  keep("arts", (x) => !!x && !!x.pub);
  keep("pages", (x) => !!x && !!x.pub);
  keep("projs", (x) => !!x && !!x.pub);
  keep("vids", (x) => !!x && !!x.pub);
  keep("gal", (x) => !!x && !!x.pub);
  keep("faqs", (x) => !!x && x.pub !== false);
  return out;
}

/** The copy of the site the person asking is allowed to read. */
export function dataFor(request: Request, d: Json): Json {
  return adminKeyConfigured() && !hasAdminKey(request) ? publicView(d) : d;
}

export async function siteDataGET(request: Request): Promise<Response> {
  const site = await readSite();
  // Nothing published yet: the website shows its built-in starting content.
  if (!site) return json({ data: null, savedAt: 0 });
  return json({ data: dataFor(request, site.data), savedAt: site.savedAt });
}

export async function siteDataPOST(request: Request): Promise<Response> {
  const raw = await readTextLimited(request, MAX_ADMIN_BODY);
  if (raw === null) return tooLarge();
  let body: Json;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return fail(400, "Invalid request.");
  }
  const action = typeof body.action === "string" ? body.action : "";

  if (action === "login") return login(request, body as { user?: string; pass?: string });

  const s = await getSession(request);
  if (action === "logout") return logout(request, s);
  if (!s) return fail(401, "Not signed in.");

  try {
    switch (action) {
      case "":
        return await publish(request, s, body, raw);
      case "session":
        return json({ ok: true, user: s.user, role: s.role });
      case "setcred":
        return await setCred(request, s, body as Record<string, string>);
      case "users":
        return await listUsers(s);
      case "adduser":
        return await addUser(request, s, body as Record<string, string>);
      case "deluser":
        return await delUser(request, s, body as Record<string, string>);
      case "log":
        return await readLog();
      case "backups":
        return await listBackups();
      case "backup": {
        const b = await findBackup(body);
        if (!b) return fail(404, "That backup no longer exists.");
        return json({ ok: true, data: b.data, savedAt: Number(b.saved_at), at: Number(b.created_at), reason: b.reason, note: b.note || "" });
      }
      case "backupnow": {
        if (s.role !== "owner") return fail(403, "Only the owner can create backups.");
        const made = await backupCurrent("manual", s.user, typeof body.note === "string" ? body.note : "");
        if (!made) return fail(400, "Nothing is published yet, so there is nothing to back up.");
        await logAct(request, s.user, "backup", "manual backup created");
        return json({ ok: true });
      }
      case "delbackup": {
        if (s.role !== "owner") return fail(403, "Only the owner can delete backups.");
        await db().from("site_backups").delete().eq("id", Number(body.id));
        await logAct(request, s.user, "backup", "backup deleted");
        return json({ ok: true });
      }
      case "restore":
        return await restore(request, s, body);
      case "export":
        return await exportAll(s);
      case "importbackup":
        return await importBackup(request, s, body, raw);
      default:
        return fail(400, "Unknown action.");
    }
  } catch (e) {
    console.error("site-data error", e);
    return serverError(e);
  }
}
