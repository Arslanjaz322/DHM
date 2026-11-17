// Tool boxes: saved tool data (/api/tool-data), uploaded ZIP projects (/api/tool-zip)
// and serving those ZIP files to visitors at /_tool/<id>.<version>/<file>.
import { getSession, hasAdminKey, logAct, ownerSession } from "./auth.server";
import { d1 } from "./d1.server";
import {
  db,
  fail,
  json,
  mimeFor,
  now,
  randHex,
  readBufferLimited,
  serverError,
  readTextLimited,
  sha256Hex,
  storageGet,
  storageList,
  storagePut,
  storageRemove,
  TOOL_KEY_RE,
  tooLarge,
} from "./util.server";

const ZID = /^[a-f0-9]{16}$/;
const ZV = /^[a-f0-9]{8}$/;
const MAX_FILE = 25 * 1024 * 1024;
const TICKET_MS = 30 * 60 * 1000;
const MAX_JSON_BODY = 2 * 1024 * 1024; // finalize carries the file list of a whole ZIP
const MAX_FINALIZE_FILES_JSON = 1024 * 1024;
const SANDBOX =
  "sandbox allow-scripts allow-forms allow-modals allow-downloads allow-popups allow-popups-to-escape-sandbox";

const fileKey = async (id: string, v: string, p: string) => `${id}/${v}/${(await sha256Hex(p)).slice(0, 40)}`;

function safePath(p: string): string | null {
  if (!p || p.length > 400 || p.startsWith("/") || p.includes("\\") || p.includes("\0")) return null;
  const segs = p.split("/");
  if (segs.some((s) => !s || s === "." || s === "..")) return null;
  return p;
}

/* ---------- /api/tool-data ---------- */
export async function toolDataGET(request: Request): Promise<Response> {
  const tool = new URL(request.url).searchParams.get("tool") || "";
  if (!TOOL_KEY_RE.test(tool)) return fail(400, "Missing tool.");
  const { data } = await db().from("tool_data").select("data").eq("tool", tool).maybeSingle();
  return json({ ok: true, data: data?.data ?? null }, 200, { "access-control-allow-origin": "*" });
}

export async function toolDataPOST(request: Request): Promise<Response> {
  // Saving tool rates/fees needs the owner's username + password login (X-Owner-Token).
  const s = await ownerSession(request);
  if (!s) return fail(401, "Sign in as the owner to save.");
  // D1 stores at most about 2 MB per row (measured in bytes)
  const raw = await readTextLimited(request, 1_900_000);
  if (raw === null) return fail(413, "Tool data is larger than 1.9 MB.");
  let body: { tool?: string; data?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, "Invalid request.");
  }
  if (!body || typeof body !== "object") return fail(400, "Invalid request.");
  const tool = String(body.tool || "");
  if (!TOOL_KEY_RE.test(tool)) return fail(400, "Missing tool.");
  const { error } = await db().from("tool_data").upsert({ tool, data: (body.data ?? null) as never, updated_at: now() });
  if (error) {
    console.error("tool-data save failed", error.message);
    return serverError(new Error(error.message));
  }
  return json({ ok: true });
}

/* ---------- /api/tool-zip ---------- */
// ZIP versions older than an hour that no live box, the site or any backup still mentions.
async function unreferencedZips(live: Set<string>): Promise<{ id: string; v: string }[]> {
  const { data: zips } = await db().from("tool_zips").select("id, v, created_at");
  // At most 20 per run: every candidate costs one database query and a Worker request may only run a limited number.
  const cand = (zips || [])
    .filter((z) => !live.has(`${z.id}.${z.v}`) && Number(z.created_at) < now() - 3600000)
    .slice(0, 20);
  if (!cand.length) return [];
  // Ask SQLite whether the site or any backup still mentions the ZIP. Loading every backup (up to ~2 MB
  // each) into the Worker would run out of memory, so the search happens inside the database.
  const out: { id: string; v: string }[] = [];
  for (const z of cand) {
    const id = String(z.id);
    const v = String(z.v);
    const r = await d1()
      .prepare(
        "SELECT 1 AS hit FROM site_state WHERE instr(data, ?1) > 0 AND instr(data, ?2) > 0 " +
          "UNION ALL SELECT 1 FROM site_backups WHERE instr(data, ?1) > 0 AND instr(data, ?2) > 0 LIMIT 1",
      )
      .bind(id, v)
      .all();
    if (!(r.results || []).length) out.push({ id, v });
  }
  return out;
}
async function removeVersion(id: string, v: string) {
  const names = await storageList("tools", `${id}/${v}`).catch(() => []);
  if (names.length) await storageRemove("tools", names.map((n) => `${id}/${v}/${n}`)).catch(() => {});
  await db().from("tool_zips").delete().eq("id", id).eq("v", v);
}

export async function toolZipPOST(request: Request): Promise<Response> {
  const s = await getSession(request);
  if (!s) return fail(401, "Not signed in.");
  const url = new URL(request.url);
  const a = url.searchParams.get("a") || "";
  try {
    if (a === "put" || a === "get") {
      const id = url.searchParams.get("id") || "";
      const v = url.searchParams.get("v") || "";
      const p = safePath(url.searchParams.get("p") || "");
      if (!ZID.test(id) || !ZV.test(v) || !p) return fail(400, "Bad file path.");
      const { data: z } = await db().from("tool_zips").select("finalized").eq("id", id).eq("v", v).maybeSingle();
      if (!z) return fail(404, "Upload not found. Start again.");
      if (a === "get") {
        const r = await storageGet("tools", await fileKey(id, v, p));
        if (!r.ok) return fail(404, "File not found.");
        return new Response(r.body, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } });
      }
      if (z.finalized) return fail(409, "This upload is already finished.");
      const buf = await readBufferLimited(request, MAX_FILE);
      if (!buf) return fail(413, `${p} is larger than 25 MB.`);
      await storagePut("tools", await fileKey(id, v, p), buf, "application/octet-stream");
      return json({ ok: true });
    }

    const jsonRaw = await readBufferLimited(request, MAX_JSON_BODY);
    if (!jsonRaw) return tooLarge();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- request JSON
    let body: any = {};
    try {
      body = JSON.parse(new TextDecoder().decode(jsonRaw) || "{}");
    } catch {
      /* empty body */
    }
    if (!body || typeof body !== "object") body = {};
    const id = String(body.id || "");
    const v = String(body.v || "");

    switch (a) {
      case "begin": {
        if (!ZID.test(id)) return fail(400, "Bad id.");
        const nv = randHex(4);
        const { error } = await db().from("tool_zips").insert({ id, v: nv, finalized: false, created_at: now() });
        if (error) throw new Error(error.message);
        return json({ ok: true, v: nv });
      }
      case "finalize": {
        if (!ZID.test(id) || !ZV.test(v)) return fail(400, "Bad id.");
        const entry = safePath(String(body.entry || ""));
        if (!entry) return fail(400, "Missing entry file.");
        // A finished upload is immutable: otherwise a live tool's entry file or its admin-only
        // paths could be rewritten after it was published.
        const { data: existing } = await db().from("tool_zips").select("finalized").eq("id", id).eq("v", v).maybeSingle();
        if (!existing) return fail(404, "Upload not found. Start again.");
        if (existing.finalized) return fail(409, "This upload is already finished.");
        const strList = (x: unknown) =>
          Array.isArray(x) ? x.filter((i): i is string => typeof i === "string" && i.length <= 400).slice(0, 2000) : [];
        const admin =
          body.admin && typeof body.admin === "object"
            ? { paths: strList(body.admin.paths), dirs: strList(body.admin.dirs) }
            : null;
        const files = Array.isArray(body.files) ? body.files.slice(0, 5000) : [];
        if (JSON.stringify(files).length > MAX_FINALIZE_FILES_JSON) return fail(413, "The file list of this ZIP is too large.");
        const { error } = await db()
          .from("tool_zips")
          .update({ entry, name: String(body.name || "").slice(0, 200), admin: admin as never, files: files as never, finalized: true })
          .eq("id", id)
          .eq("v", v);
        if (error) throw new Error(error.message);
        await logAct(request, s.user, "publish", `ZIP uploaded: ${String(body.name || "").slice(0, 80)} (${files.length} files)`);
        return json({ ok: true });
      }
      case "ticket": {
        // A ticket opens a tool's admin-only files, so it needs the owner login (X-Owner-Token)
        // or the ADMIN_KEY. Without this check anybody could mint a ticket.
        if (!hasAdminKey(request) && !(await ownerSession(request))) {
          return fail(401, "Sign in as the owner to open the admin panel of a tool.");
        }
        if (!ZID.test(id) || !ZV.test(v)) return fail(400, "Bad id.");
        const t = randHex(16);
        await db().from("tool_tickets").delete().lt("expires_at", now());
        await db().from("tool_tickets").insert({ t, zid: id, v, expires_at: now() + TICKET_MS });
        return json({ ok: true, t });
      }
      case "gc": {
        const live = (Array.isArray(body.live) ? body.live : [])
          .map((x: { id?: string; v?: string }) => `${x?.id}.${x?.v}`)
          .filter((x: string) => /^[a-f0-9]{16}\.[a-f0-9]{8}$/.test(x));
        const data = await unreferencedZips(new Set(live));
        for (const z of data || []) await removeVersion(z.id, z.v);
        return json({ ok: true, removed: (data || []).length });
      }
      default:
        return fail(400, "Unknown action.");
    }
  } catch (e) {
    console.error("tool-zip error", e);
    return serverError(e);
  }
}

/* ---------- GET /_tool/<id>.<v>[.t<ticket>]/<path> ---------- */
type AdminInfo = { paths?: string[]; dirs?: string[] } | null;

function isAdminPath(p: string, admin: AdminInfo): boolean {
  if (!admin) return false;
  if ((admin.paths || []).includes(p)) return true;
  return (admin.dirs || []).some((d) => d && p.startsWith(d));
}

export async function serveTool(request: Request, rest: string): Promise<Response> {
  const notFound = () =>
    new Response("Not found", { status: 404, headers: { "content-type": "text/plain", "access-control-allow-origin": "*" } });
  const slash = rest.indexOf("/");
  const head = slash < 0 ? rest : rest.slice(0, slash);
  const m = /^([a-f0-9]{16})\.([a-f0-9]{8})(?:\.t([a-f0-9]{32}))?$/.exec(head);
  if (!m) return notFound();
  const id = m[1]!;
  const v = m[2]!;
  const ticket = m[3];
  let p = "";
  try {
    p = decodeURIComponent(slash < 0 ? "" : rest.slice(slash + 1));
  } catch {
    return notFound();
  }
  const { data: z } = await db().from("tool_zips").select("entry, admin, finalized").eq("id", id).eq("v", v).maybeSingle();
  if (!z || !z.finalized) return notFound();
  if (!p) p = z.entry || "index.html";
  if (!safePath(p)) return notFound();

  let ticketOk = false;
  if (ticket) {
    const { data: t } = await db().from("tool_tickets").select("zid, v, expires_at").eq("t", ticket).maybeSingle();
    ticketOk = !!t && t.zid === id && t.v === v && Number(t.expires_at) > now();
    if (!ticketOk) return new Response("This admin link has expired. Reopen it from the admin panel.", { status: 403 });
  }
  if (isAdminPath(p, z.admin as AdminInfo) && !ticketOk) return notFound();

  let r = await storageGet("tools", await fileKey(id, v, p), request);
  if (!r.ok && r.status !== 206 && !/\.[a-z0-9]+$/i.test(p)) {
    // folder link like "docs/" -> docs/index.html
    r.body?.cancel();
    p = p.replace(/\/?$/, "/index.html");
    r = await storageGet("tools", await fileKey(id, v, p), request);
  }
  if (!r.ok && r.status !== 206) {
    r.body?.cancel();
    return notFound();
  }
  const h = new Headers({
    "content-type": mimeFor(p),
    "content-security-policy": SANDBOX,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer", // admin links carry a ticket in the address: never leak it
    "accept-ranges": "bytes",
    "cache-control": ticket ? "private, no-store" : "public, max-age=31536000, immutable",
  });
  for (const k of ["content-length", "content-range"]) {
    const val = r.headers.get(k);
    if (val) h.set(k, val);
  }
  // Public files may be read cross-origin (sandboxed tools have no origin); admin-ticket files may not.
  if (!ticket) h.set("access-control-allow-origin", "*");
  if (ticket) h.set("x-robots-tag", "noindex, nofollow");
  return new Response(request.method === "HEAD" ? null : r.body, { status: r.status, headers: h });
}


/* ---------- HTML tool box as a real, standalone page (/tools/<box>) ---------- */
// The uploaded HTML (pasted code or a ZIP's entry file) is sent straight to the visitor as the page itself:
// no site shell, no iframe, no postMessage bridge. It keeps the sandbox CSP (it never runs with the site's origin).
// ZIP files are loaded from /_tool/<id>.<v>/ (one-year immutable cache, any origin) through a <base> tag.
const escA = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const PAGE_SHIM =
  '<script>(function(){try{localStorage.getItem("x")}catch(e){["localStorage","sessionStorage"].forEach(function(k){var m={};var st={getItem:function(a){return a in m?m[a]:null},setItem:function(a,v){m[a]=String(v)},removeItem:function(a){delete m[a]},clear:function(){m={}},key:function(i){return Object.keys(m)[i]||null}};Object.defineProperty(st,"length",{get:function(){return Object.keys(m).length}});try{Object.defineProperty(window,k,{value:st,configurable:true})}catch(x){}})}})()<\/script>';

const HASH_FIX =
  '<script>document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a[href]");if(!a)return;var h=a.getAttribute("href");if(!h||h.charAt(0)!=="#")return;e.preventDefault();if(h.length>1){var t=document.getElementById(decodeURIComponent(h.slice(1)));if(t)t.scrollIntoView()}else window.scrollTo(0,0)},true)<\/script>';

const ADMIN_HIDE =
  '<script>(function(){function sl(t){return(t||"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")}'
  + 'function isA(el){var t=sl(el.textContent);if(t==="admin"||t==="admin-panel"||t==="admin-login"||t==="admin-area")return true;if(t)return false;var a=sl((el.getAttribute&&(el.getAttribute("aria-label")||el.getAttribute("title")))||"");return a==="admin"||/^admin[-_]?(btn|button|link|tab|toggle|open)?$/i.test(el.id||"")}'
  + 'function tabs(){var out=[];function add(el){var t=(el.textContent||"").trim();if((t||isA(el))&&t.length<=24&&out.indexOf(el)<0)out.push(el)}'
  + 'document.querySelectorAll("[role=tab],[data-tab],[data-view],[data-page],[class*=tab]>button,[class*=tab]>a,[class*=Tab]>button,[class*=Tab]>a").forEach(add);'
  + 'document.querySelectorAll("button,a,[role=button]").forEach(function(el){if(isA(el))add(el)});return out}'
  + 'function hide(){var l=tabs(),v=[];l.forEach(function(el){if(isA(el))el.style.setProperty("display","none","important");else v.push(el)});'
  + 'if(v.length<2&&l.length>v.length)v.forEach(function(el){var p=el.parentElement;if(p&&Array.prototype.every.call(p.children,function(c){return l.indexOf(c)>=0}))p.style.setProperty("display","none","important")})}'
  + 'new MutationObserver(hide).observe(document,{childList:true,subtree:true});document.addEventListener("DOMContentLoaded",hide);hide()})()<\/script>';

function storeShim(origin: string, tool: string): string {
  const url = JSON.stringify(origin + "/api/tool-data?tool=" + encodeURIComponent(tool));
  return (
    "<script>if(!window.toolStore)window.toolStore={load:function(){return fetch(" +
    url +
    ').then(function(r){return r.ok?r.json():null}).then(function(j){return j?j.data:null}).catch(function(){return null})},save:function(){return Promise.resolve(false)},siteLogin:function(){return Promise.resolve(false)},isAdmin:false};<\/script>'
  );
}

function injectHead(html: string, head: string): string {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + head);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + "<head>" + head + "</head>");
  return '<!doctype html><html><head><meta charset="utf-8">' + head + "</head><body>" + html + "</body></html>";
}

export async function standaloneToolPage(
  request: Request,
  box: { code?: unknown; zip?: { id?: string; v?: string; entry?: string } | null },
  tool: string,
  meta: { title: string; desc: string; origin: string; path: string; dis?: string },
): Promise<Response | null> {
  let html = "";
  let base = "";
  const z = box.zip;
  if (z && ZID.test(String(z.id || "")) && ZV.test(String(z.v || "")) && z.entry) {
    const entry = String(z.entry);
    if (!/\.html?$/i.test(entry)) return null;
    const r = await serveTool(new Request(request.url), `${z.id}.${z.v}/${entry.split("/").map(encodeURIComponent).join("/")}`);
    if (!r.ok) {
      r.body?.cancel();
      return null;
    }
    html = await r.text();
    const dir = entry.includes("/") ? entry.slice(0, entry.lastIndexOf("/") + 1) : "";
    base = `/_tool/${z.id}.${z.v}/` + dir.split("/").filter(Boolean).map(encodeURIComponent).join("/") + (dir ? "/" : "");
  } else if (typeof box.code === "string" && box.code.trim()) {
    html = box.code;
  } else return null;

  let head = "";
  if (base) head += `<base href="${escA(base)}">`;
  if (!/<meta[^>]+charset/i.test(html)) head += '<meta charset="utf-8">';
  if (!/<meta[^>]+name=["']?viewport/i.test(html)) head += '<meta name="viewport" content="width=device-width,initial-scale=1">';
  if (!/<title[\s>]/i.test(html)) head += `<title>${escA(meta.title)}</title>`;
  if (meta.desc && !/<meta[^>]+name=["']?description/i.test(html)) head += `<meta name="description" content="${escA(meta.desc)}">`;
  head += `<link rel="canonical" href="${escA(meta.origin + meta.path)}">`;
  head += PAGE_SHIM + storeShim(meta.origin, tool) + ADMIN_HIDE + (base ? HASH_FIX : "");
  html = injectHead(html, head);
  if (!/^\s*<!doctype/i.test(html)) html = "<!doctype html>" + html;
  const dis = String(meta.dis || "").trim();
  if (dis) {
    const note = `<p style="max-width:900px;margin:24px auto;padding:0 16px 24px;font:13px/1.5 system-ui,sans-serif;color:#555"><b>Disclaimer:</b> ${escA(dis)}</p>`;
    const i = html.toLowerCase().lastIndexOf("</body>");
    html = i >= 0 ? html.slice(0, i) + note + html.slice(i) : html + note;
  }

  return new Response(request.method === "HEAD" ? null : html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": SANDBOX,
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "cache-control": "public, max-age=60, stale-while-revalidate=600",
    },
  });
}
