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
