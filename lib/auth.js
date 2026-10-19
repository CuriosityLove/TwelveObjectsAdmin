// Google sign-in limited to the gallery's domain, with a signed cookie session.
const crypto = require("crypto");

const COOKIE = "to_session";
const STATE_COOKIE = "to_oauth_state";
const MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sign = (payload, secret) => crypto.createHmac("sha256", secret).update(payload).digest("base64url");

function config() {
  const secret = process.env.SESSION_SECRET || "";
  const clientId = (process.env.GOOGLE_CLIENT_ID || "").trim().replace(/^["']|["']$/g, "");
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET || "").trim().replace(/^["']|["']$/g, "");
  const domain = (process.env.ALLOWED_DOMAIN || "twelveobjects.com").toLowerCase();
  const extra = (process.env.ALLOWED_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const devUser = process.env.NODE_ENV !== "production" && !clientId ? process.env.DEV_USER || "dev@twelveobjects.com" : null;
  return { secret, clientId, clientSecret, domain, extra, devUser };
}

function allowed(email, cfg) {
  const e = String(email || "").toLowerCase();
  return cfg.extra.includes(e) || e.endsWith("@" + cfg.domain);
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, maxAge, secure) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function issue(res, user, cfg, secure) {
  const payload = b64u(JSON.stringify({ e: user.email, n: user.name || "", x: Math.floor(Date.now() / 1000) + MAX_AGE_S }));
  res.append("Set-Cookie", cookie(COOKIE, payload + "." + sign(payload, cfg.secret), MAX_AGE_S, secure));
}

function read(req, cfg) {
  const raw = parseCookies(req)[COOKIE];
  if (!raw || !cfg.secret) return null;
  const [payload, mac] = raw.split(".");
  if (!payload || !mac) return null;
  const expect = sign(payload, cfg.secret);
  if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (p.x < Date.now() / 1000 || !allowed(p.e, cfg)) return null;
    return { email: p.e, name: p.n };
  } catch { return null; }
}

function routes(app) {
  const cfg = config();
  const prod = process.env.NODE_ENV === "production";
  if (prod && (!cfg.clientId || !cfg.clientSecret || cfg.secret.length < 32)) {
    throw new Error("Production needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and a SESSION_SECRET of 32+ characters.");
  }
  const base = () => (process.env.APP_URL || "").replace(/\/$/, "");
  const redirectUri = (req) => (base() || `${req.protocol}://${req.get("host")}`) + "/auth/callback";

  app.get("/auth/google", (req, res) => {
    const state = crypto.randomBytes(16).toString("hex");
    res.append("Set-Cookie", cookie(STATE_COOKIE, state, 600, prod));
    const q = new URLSearchParams({
      client_id: cfg.clientId, redirect_uri: redirectUri(req), response_type: "code",
      scope: "openid email profile", state, prompt: "select_account", hd: cfg.domain,
    });
    res.redirect("https://accounts.google.com/o/oauth2/v2/auth?" + q);
  });

  app.get("/auth/callback", async (req, res) => {
    const fail = (why) => res.redirect("/login?error=" + encodeURIComponent(why));
    const state = parseCookies(req)[STATE_COOKIE];
    res.append("Set-Cookie", cookie(STATE_COOKIE, "", 0, prod));
    if (!req.query.code || !state || state !== req.query.state) return fail("expired");
    try {
      const tr = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code: String(req.query.code), client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: redirectUri(req), grant_type: "authorization_code" }),
      });
      const tok = await tr.json();
      if (!tok.access_token) return fail("google");
      const ur = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: "Bearer " + tok.access_token } });
      const u = await ur.json();
      if (!u.email || u.email_verified === false) return fail("google");
      if (!allowed(u.email, cfg)) return fail("domain");
      issue(res, { email: u.email, name: u.name }, cfg, prod);
      res.redirect("/");
    } catch (e) {
      console.error("oauth", e);
      fail("google");
    }
  });

  app.post("/auth/logout", (req, res) => {
    res.append("Set-Cookie", cookie(COOKIE, "", 0, prod));
    res.redirect(303, "/login");
  });

  // Gate everything after this point.
  return function requireUser(req, res, next) {
    let user = read(req, cfg);
    if (!user && cfg.devUser) user = { email: cfg.devUser, name: "Dev" };
    if (user) { req.user = user; return next(); }
    if (req.path.startsWith("/api/") || req.path.startsWith("/_blob/")) return res.status(401).json({ error: "signed_out" });
    res.redirect("/login");
  };
}

module.exports = { routes, allowed, config };
