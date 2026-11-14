// Serves the website's single-page app with its published content and search-engine tags
// already inside the HTML, so visitors and Google see the right page immediately.
import siteHtml from "@/legacy/site.html?raw";
import { categoryCover, projectCategories, projectCover, projectPath, projectSitemapPaths, publishedProjects } from "./projects.server";
import { readSite } from "./site-data.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- free-form site JSON
type Json = any;

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const plain = (s: unknown) =>
  String(s ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[#*_>`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const slugify = (v: string) =>
  v
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

function absImg(u: unknown, origin: string): string {
  const s = String(u || "");
  if (/^https?:\/\//.test(s)) return s;
  if (s.startsWith("/")) return origin + s;
  return "";
}

type Meta = { title: string; desc: string; type?: string | undefined; img?: string | undefined; robots?: string | undefined };

function pageMeta(d: Json, path: string, origin: string): Meta {
  const title = String(d.title || "Maskan Estates");
  const seo = (d.seo || {}) as Json;
  const tpl = (t: string) => String(seo.tpl || "%page% | %site%").replace("%page%", t).replace("%site%", title);
  const def: Meta = { title, desc: String(seo.desc || ""), img: absImg(seo.og, origin) };
  const segs = path.split("/").filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  if (segs[0] === "admin") return { title: "Admin | " + title, desc: "", robots: "noindex,nofollow" };
  if (!segs.length) return def;
  const [a, b] = segs;
  if (a === "newsflash" && b) {
    const art = (d.arts || []).find((x: Json) => x.slug === b);
    if (art) return { title: tpl(art.title), desc: String(art.sum || def.desc), type: "article", img: absImg(art.img, origin) || def.img };
  }
  if (a === "newsflash") return { ...def, title: tpl("Newsflash"), desc: `Latest property notices and updates summarised by ${title}.` };
  if (a === "projects") {
    const p = segs[2] ? publishedProjects(d).find((x: Json) => x.slug === segs[2]) : null;
    if (p) {
      const desc = (String(p.sum || "").trim() || plain(p.body)).slice(0, 155) || def.desc;
      return { title: tpl(p.title), desc, img: absImg(projectCover(p), origin) || def.img };
    }
    const c = b ? projectCategories(d).find((x) => x.slug === b) : null;
    if (c) {
      return {
        ...def,
        title: tpl(c.name),
        desc: c.sum.trim() || `${c.name} by ${title}: photos and details of each project.`,
        img: absImg(categoryCover(d, c), origin) || def.img,
      };
    }
    return { ...def, title: tpl("Projects"), desc: `Projects by ${title}: photos and details, grouped by category.` };
  }
  if (a === "videos" && b) {
    const v = (d.vids || []).find((x: Json) => x.slug === b);
    if (v) return { title: tpl(v.title), desc: plain(v.desc).slice(0, 155) || def.desc, type: "video.other", img: absImg(v.thumb, origin) || def.img };
  }
  if (a === "videos") return { ...def, title: tpl("Videos"), desc: `Watch ${title} videos, played from our official channels.` };
  if (a === "gallery") return { ...def, title: tpl("Gallery"), desc: `Photo gallery from ${title}.` };
  if (a === "faqs" && b) {
    const q = (d.faqs || []).find((x: Json) => x && x.hide === true && x.pub !== false && x.slug === b && faqText(x.a));
    if (q) return { ...def, title: tpl(String(q.q)), desc: faqText(q.a).replace(/\s+/g, " ").slice(0, 155) || def.desc };
  }
  if (a === "faqs") return { ...def, title: tpl("FAQs"), desc: `Answers to frequently asked questions from ${title}.` };
  if (a === "doc") return { ...def, title: tpl("Documents"), desc: `Property checklists and document templates from ${title}.` };
  if (a === "featured" && b) {
    const f = (d.slides || []).find((x: Json) => x.slug === b);
    if (f) return { title: tpl(f.t), desc: plain(f.s || f.body).slice(0, 155) || def.desc, img: absImg(f.img, origin) || def.img };
  }
  if (a === "tools" && b) {
    const t = (d.boxes || []).find((x: Json) => slugify(String(x.title || "")) === b);
    if (t) return { ...def, title: tpl(t.title), desc: String(t.dis || def.desc) };
  }
  const pg = (d.pages || []).find((x: Json) => x.slug === a && x.pub);
  if (pg) return { ...def, title: tpl(pg.title), desc: plain(pg.body).slice(0, 155) || def.desc };
  return def;
}

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// FAQ answers are rich text (HTML) or old plain text: reduce either to readable text.
const faqText = (v: unknown): string => {
  let s = String(v ?? "");
  if (/^\s*<(p|h[1-6]|ul|ol|div|blockquote|table|hr)[\s>/]/i.test(s)) {
    s = s
      .replace(/<\/(p|h[1-6]|li|div|blockquote|tr)>|<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  } else {
    s = s.replace(/\*\*/g, "");
  }
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{2,}/g, "\n").trim();
};

// FAQ page: tells Google about every published question (schema.org FAQPage).
function faqJsonLd(d: Json, only?: string): string {
  const ok = new Set((d.faqCats || []).filter((c: Json) => c && c.pub !== false).map((c: Json) => String(c.id)));
  const items = (d.faqs || []).filter(
    (f: Json) =>
      f &&
      f.pub !== false &&
      ok.has(String(f.cat)) &&
      String(f.q || "").trim() &&
      faqText(f.a) &&
      (only ? f.hide === true && f.slug === only : f.hide !== true),
  );
  if (!items.length) return "";
  const ld = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((f: Json) => ({
      "@type": "Question",
      name: String(f.q).trim(),
      acceptedAnswer: { "@type": "Answer", text: faqText(f.a) },
    })),
  };
  return JSON.stringify(ld).replace(/</g, "\\u003c");
}

const normPath = (p: string): string => p.replace(/\/+$/, "") || "/";

const ldScript = (o: unknown): string => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`;

/** Only a real calendar date (2026-11-14 or 2026-11-14T10:00:00Z) is passed on; anything else is left out. */
const isoDate = (v: unknown): string | undefined => {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? "").trim());
  return m && !Number.isNaN(Date.parse(m[1]!)) ? m[1] : undefined;
};

const STATIC_PAGES = ["newsflash", "projects", "doc", "videos", "gallery", "faqs"];

/**
 * True when the address is a page the website really has (it mirrors parsePath() in site.html).
 * Anything else used to be answered with the home page and a 200 status, which Google counts as a
 * "soft 404"; unknown addresses now get a real 404 status (the visitor still sees the website).
 */
function isKnownPath(d: Json, rawPath: string): boolean {
  const path = normPath(rawPath);
  if (path === "/" || path === "/admin" || path.startsWith("/admin/")) return true;
  const segs = path.split("/").filter(Boolean).map(safeDecode);
  const [a, b, c] = segs;
  const n = segs.length;
  if (n === 1) return STATIC_PAGES.includes(a!) || (d.pages || []).some((x: Json) => x && x.pub && x.slug === a);
  if (a === "newsflash" && n === 2) return (d.arts || []).some((x: Json) => x && x.pub && x.slug === b);
  if (a === "projects" && n === 2) return projectCategories(d).some((x) => x.slug === b);
  if (a === "projects" && n === 3) return publishedProjects(d).some((x: Json) => x.slug === c);
  if (a === "videos" && n === 2) return (d.vids || []).some((x: Json) => x && x.pub && x.slug === b);
  if (a === "featured" && n === 2) return (d.slides || []).some((x: Json) => x && x.slug === b);
  if (a === "faqs" && n === 2) {
    const ok = new Set((d.faqCats || []).filter((x: Json) => x && x.pub !== false).map((x: Json) => String(x.id)));
    return (d.faqs || []).some(
      (f: Json) => f && f.hide === true && f.pub !== false && f.slug === b && ok.has(String(f.cat)) && String(f.q || "").trim() && faqText(f.a),
    );
  }
  if (a === "tools" && (n === 2 || n === 3)) return (d.boxes || []).some((x: Json) => slugify(String(x.title || "")) === b);
  return false;
}

/** Brand schema for the home page: tells Google the site's name, logo and address. */
function siteJsonLd(d: Json, origin: string): string[] {
  const name = String(d.title || "Maskan Estates");
  const logo = absImg(d.logoImg, origin) || origin + "/logo.png";
  const desc = String(d.seo?.desc || "").trim();
  const orgId = origin + "/#organization";
  return [
    ldScript({
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": orgId,
      name,
      url: origin + "/",
      logo: { "@type": "ImageObject", url: logo },
      ...(desc ? { description: desc } : {}),
    }),
    ldScript({
      "@context": "https://schema.org",
      "@type": "WebSite",
      "@id": origin + "/#website",
      name,
      url: origin + "/",
      inLanguage: "en",
      publisher: { "@id": orgId },
    }),
  ];
}

/** Breadcrumb trail (Home > Projects > Category > Project, etc.) so search results can show the page's place in the site. */
function breadcrumbJsonLd(d: Json, path: string, origin: string): string {
  const segs = normPath(path).split("/").filter(Boolean).map(safeDecode);
  const [a, b, c] = segs;
  const trail: [string, string][] = [["Home", "/"]];
  if (a === "newsflash" && segs.length === 2) {
    const art = (d.arts || []).find((x: Json) => x && x.pub && x.slug === b);
    if (!art) return "";
    trail.push(["Newsflash", "/newsflash"], [String(art.title), "/newsflash/" + b]);
  } else if (a === "projects" && segs.length >= 2) {
    const cat = projectCategories(d).find((x) => x.slug === b);
    if (!cat) return "";
    trail.push(["Projects", "/projects"], [cat.name, "/projects/" + cat.slug]);
    if (segs.length === 3) {
      const pj = publishedProjects(d).find((x: Json) => x.slug === c);
      if (!pj) return "";
      trail.push([String(pj.title), "/projects/" + b + "/" + c]);
    }
  } else if (a === "videos" && segs.length === 2) {
    const v = (d.vids || []).find((x: Json) => x && x.pub && x.slug === b);
    if (!v) return "";
    trail.push(["Videos", "/videos"], [String(v.title), "/videos/" + b]);
  } else if (a === "faqs" && segs.length === 2) {
    const q = (d.faqs || []).find((x: Json) => x && x.hide === true && x.pub !== false && x.slug === b);
    if (!q) return "";
    trail.push(["FAQs", "/faqs"], [String(q.q), "/faqs/" + b]);
  } else return "";
  return ldScript({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map(([name, p], i) => ({ "@type": "ListItem", position: i + 1, name, item: origin + encodeURI(p) })),
  });
}

/** Newsflash articles: NewsArticle schema (same fields the admin preview shows). */
function articleJsonLd(d: Json, path: string, origin: string): string {
  const segs = normPath(path).split("/").filter(Boolean).map(safeDecode);
  if (segs[0] !== "newsflash" || segs.length !== 2) return "";
  const a = (d.arts || []).find((x: Json) => x && x.pub && x.slug === segs[1]);
  if (!a) return "";
  const img = absImg(a.img, origin) || absImg(d.seo?.og, origin);
  const published = isoDate(a.date);
  return ldScript({
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: String(a.title || ""),
    description: String(a.sum || ""),
    mainEntityOfPage: origin + "/newsflash/" + encodeURI(segs[1]!),
    articleSection: String(a.cat || ""),
    inLanguage: "en-PK",
    ...(img ? { image: [img] } : {}),
    ...(published ? { datePublished: published } : {}),
    publisher: { "@type": "Organization", name: String(d.title || "Maskan Estates"), url: origin + "/" },
  });
}

/**
 * Plain links to the main pages, placed in <noscript>. The website draws its own menu with
 * JavaScript, so crawlers and link-preview bots that do not run scripts still find every page.
 */
function crawlNav(d: Json): string {
  const links: [string, string][] = [["Home", "/"], ["Newsflash", "/newsflash"], ["Projects", "/projects"]];
  for (const c of projectCategories(d)) links.push([c.name, "/projects/" + c.slug]);
  links.push(["Documents", "/doc"]);
  if ((d.vids || []).some((v: Json) => v && v.pub && v.url)) links.push(["Videos", "/videos"]);
  if ((d.gal || []).some((g: Json) => g && g.pub && g.img)) links.push(["Gallery", "/gallery"]);
  if ((d.faqs || []).some((f: Json) => f && f.pub !== false && f.hide !== true && String(f.q || "").trim() && faqText(f.a))) links.push(["FAQs", "/faqs"]);
  for (const p of d.pages || []) if (p && p.pub && p.kind !== "link" && p.slug) links.push([String(p.title || p.slug), "/" + p.slug]);
  for (const p of publishedProjects(d)) links.push([String(p.title), projectPath(d, p)]);
  for (const a of (d.arts || []).filter((x: Json) => x && x.pub && x.slug).slice(0, 25)) links.push([String(a.title), "/newsflash/" + a.slug]);
  const li = links.slice(0, 120).map(([t, u]) => `<li><a href="${esc(encodeURI(u))}">${esc(t)}</a></li>`);
  return `<noscript><nav aria-label="Site pages"><ul>${li.join("")}</ul></nav></noscript>`;
}

function seoHead(d: Json, path: string, origin: string, known = true): string {
  const m = pageMeta(d, path, origin);
  const seo = (d.seo || {}) as Json;
  // One address per page: "/projects/" and "/projects" share the same canonical.
  const cpath = normPath(path);
  const url = origin + (cpath === "/" ? "/" : encodeURI(cpath));
  const isAdmin = m.robots === "noindex,nofollow" || !known;
  const out = [
    `<meta name="robots" content="${!known ? "noindex,follow" : m.robots || "index,follow,max-image-preview:large"}">`,
    `<meta property="og:site_name" content="${esc(d.title)}">`,
    `<meta property="og:type" content="${m.type || "website"}">`,
    `<meta property="og:title" content="${esc(m.title)}">`,
    `<meta property="og:description" content="${esc(m.desc)}">`,
    `<meta property="og:url" content="${esc(url)}">`,
    // Pages without their own picture still get one in WhatsApp / Facebook previews: the site logo.
    `<meta property="og:image" content="${esc(m.img || absImg(d.logoImg, origin) || origin + "/logo.png")}">`,
    `<meta name="twitter:card" content="${m.img ? "summary_large_image" : "summary"}">`,
  ];
  if (!isAdmin) {
    out.push(`<link rel="canonical" href="${esc(url)}">`);
    if (/^ca-pub-\d{10,20}$/.test(String(seo.ads || ""))) {
      out.push(
        `<script id="adsbygoogle-js" async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(seo.ads)}" crossorigin="anonymous"></script>`,
      );
    }
    if (typeof seo.head === "string" && seo.head.trim()) out.push(seo.head);
    const fp = cpath;
    if (fp === "/") out.push(...siteJsonLd(d, origin));
    out.push(breadcrumbJsonLd(d, fp, origin), articleJsonLd(d, fp, origin));
    if (fp === "/faqs" || fp.startsWith("/faqs/")) {
      const ld = faqJsonLd(d, fp === "/faqs" ? undefined : safeDecode(fp.slice(6)));
      if (ld) out.push(`<script type="application/ld+json">${ld}</script>`);
    }
  }
  return out.filter(Boolean).join("\n");
}

const DEFAULT_TAGS =
  '<meta name="robots" content="index,follow,max-image-preview:large">\n<meta property="og:type" content="website">\n<meta property="og:title" content="Maskan Estates">\n<meta property="og:description" content="Property listings, calculators and Newsflash updates for plot owners and buyers in Pakistan.">\n<meta name="twitter:card" content="summary">';

/**
 * Optional: set the CANONICAL_HOST variable in Cloudflare (for example www.dhamultan.online) and every
 * request on any other host (such as the bare dhamultan.online) is redirected there with a 301, so Google
 * only ever sees one version of each page. Leave it unset to turn this off.
 */
export function hostRedirect(request: Request): Response | null {
  const want = String(globalThis.process?.env?.CANONICAL_HOST || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!want || !/^[a-z0-9.-]+(:\d+)?$/.test(want)) return null;
  const url = new URL(request.url);
  if (url.host.toLowerCase() === want || url.hostname === "localhost") return null;
  url.protocol = "https:";
  url.host = want;
  return Response.redirect(url.toString(), 301);
}

export async function renderSite(request: Request): Promise<Response> {
  const moved = hostRedirect(request);
  if (moved) return moved;
  const url = new URL(request.url);
  const origin = url.origin;
  const path = url.pathname;
  let html = siteHtml;
  let site: Awaited<ReturnType<typeof readSite>> = null;
  try {
    site = await readSite();
  } catch (e) {
    console.error("could not read site data", e);
  }
  const isAdmin = path === "/admin" || path.startsWith("/admin/");
  // Unknown addresses get a real 404 status (only when the site data could be read, so a database hiccup never 404s real pages).
  const known = !site?.data || isKnownPath(site.data, path);

  html = html.replace(
    "</title>",
    '</title>\n<link rel="icon" href="/favicon.ico" sizes="any">\n<link rel="icon" type="image/png" sizes="192x192" href="/favicon.png">\n<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
  );
  if (site?.data) {
    const m: Meta = known ? pageMeta(site.data, path, origin) : { title: "Page not found | " + String(site.data.title || "Maskan Estates"), desc: "", robots: "noindex,follow" };
    html = html
      .replace(/<title>[^<]*<\/title>/, () => `<title>${esc(m.title)}</title>`)
      .replace(/<meta name="description" content="[^"]*">/, () => `<meta name="description" content="${esc(m.desc)}">`)
      .replace("<!--SEO-HEAD-->", () => seoHead(site!.data, path, origin, known))
      .replace("<body>", () => "<body>" + (known && !isAdmin ? crawlNav(site!.data) : ""));
    const boot = JSON.stringify({ data: site.data, savedAt: site.savedAt })
      .replace(/</g, "\\u003c")
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
    html = html.replace("<!--SITE-DATA-->", () => `<script id="site-boot" type="application/json">${boot}</script>`);
  } else {
    html = html.replace("<!--SEO-HEAD-->", isAdmin ? '<meta name="robots" content="noindex,nofollow">' : DEFAULT_TAGS);
  }

  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    // Blocks clickjacking (the admin panel cannot be framed by other sites) and <base>/<object>/form
    // hijacking. Scripts and styles are intentionally not restricted: the site relies on inline code,
    // Google Fonts, AdSense and video embeds.
    "content-security-policy": "base-uri 'self'; object-src 'none'; form-action 'self'; frame-ancestors 'self'",
    "x-frame-options": "SAMEORIGIN",
  };
  if (isAdmin) headers["x-robots-tag"] = "noindex, nofollow";
  else if (!known) headers["x-robots-tag"] = "noindex";
  return new Response(request.method === "HEAD" ? null : html, { status: known ? 200 : 404, headers });
}

export async function renderSitemap(request: Request): Promise<Response> {
  const moved = hostRedirect(request);
  if (moved) return moved;
  const origin = new URL(request.url).origin;
  const site = await readSite().catch(() => null);
  const d = (site?.data || {}) as Json;
  // path -> last-modified date (only where the site really records one)
  const paths = new Map<string, string | undefined>();
  const add = (p: string, lastmod?: string) => {
    if (!paths.has(p)) paths.set(p, lastmod);
  };
  for (const p of ["/", "/newsflash", "/doc"]) add(p);
  // Empty listing pages stay out of the sitemap (they would be thin pages).
  if ((d.vids || []).some((v: Json) => v && v.pub && v.url)) add("/videos");
  if ((d.gal || []).some((g: Json) => g && g.pub && g.img)) add("/gallery");
  for (const p of d.pages || []) if (p.pub && p.kind !== "link" && p.slug) add("/" + p.slug);
  for (const b of d.boxes || []) if (b.title) add("/tools/" + slugify(String(b.title)));
  for (const a of d.arts || []) if (a.pub && a.slug) add("/newsflash/" + a.slug, isoDate(a.date));
  for (const v of d.vids || []) if (v.pub && v.slug) add("/videos/" + v.slug, isoDate(v.date));
  for (const p of projectSitemapPaths(d)) add(p);
  if ((d.faqs || []).some((f: Json) => f && f.pub !== false && f.hide !== true && String(f.q || "").trim() && faqText(f.a))) add("/faqs");
  for (const f of d.faqs || []) if (f && f.pub !== false && f.hide === true && f.slug && String(f.q || "").trim() && faqText(f.a)) add("/faqs/" + f.slug);
  for (const f of d.slides || []) if ((f.lk || "page") === "page" && f.slug) add("/featured/" + f.slug);
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    [...paths]
      .map(([p, lm]) => `  <url><loc>${esc(origin + encodeURI(p))}</loc>${lm ? `<lastmod>${lm}</lastmod>` : ""}</url>`)
      .join("\n") +
    "\n</urlset>\n";
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=600" } });
}

/** robots.txt is built per request so the Sitemap line always carries the live domain. */
export function renderRobots(request: Request): Response {
  const moved = hostRedirect(request);
  if (moved) return moved;
  const origin = new URL(request.url).origin;
  const body = ["User-agent: *", "Allow: /", "Disallow: /admin", "", `Sitemap: ${origin}/sitemap.xml`, ""].join("\n");
  return new Response(request.method === "HEAD" ? null : body, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}
