const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const express = require("express");
const db = require("./lib/db");
const auth = require("./lib/auth");

const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

async function main() {
  const pool = db.makePool();
  // On a fresh deploy the database can still be starting; wait for it rather than exit.
  for (let i = 1; ; i++) {
    try { await db.migrate(pool); break; }
    catch (e) {
      if (i >= 20 || !["ECONNREFUSED", "ENOTFOUND", "57P03"].includes(e.code)) throw e;
      console.log(`Database not ready (${e.code}), retrying in 3s`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  await importIfEmpty(pool);

  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });

  const pub = path.join(__dirname, "public");
  app.get("/healthz", (req, res) => res.send("ok"));
  // Files the sign-in page and the phone install need before anyone is signed in.
  for (const f of ["login.html", "login.js", "manifest.webmanifest", "sw.js"]) app.get("/" + f, (req, res) => res.sendFile(path.join(pub, f)));
  app.use("/icons", express.static(path.join(pub, "icons"), { maxAge: "7d" }));
  app.get("/login", (req, res) => res.sendFile(path.join(pub, "login.html")));

  const requireUser = auth.routes(app);
  app.use(requireUser);

  // Live updates: each open page listens here and refetches a collection when it changes.
  const listeners = new Set();
  const broadcast = (collection) => { for (const res of listeners) res.write(`data: ${JSON.stringify({ collection })}\n\n`); };
  app.get("/api/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();
    res.write("retry: 3000\n\n");
    listeners.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => { clearInterval(ping); listeners.delete(res); });
  });

  // Writes must come from the app's own scripts.
  const sameOrigin = (req, res, next) => (req.get("X-Requested-With") === "twelve-objects" ? next() : res.status(403).json({ error: "forbidden" }));
  const validCol = (req, res, next) => (db.COLLECTIONS.has(req.params.col) ? next() : res.status(404).json({ error: "not_found" }));
  const validId = (req, res, next) => (db.ID_RE.test(req.params.id) ? next() : res.status(400).json({ error: "bad_id" }));

  app.get("/api/me", (req, res) => res.json(req.user));
  app.get("/api/:col", validCol, async (req, res, next) => {
    try { res.set("Cache-Control", "no-store").json(await db.list(pool, req.params.col)); } catch (e) { next(e); }
  });
  app.put("/api/:col/:id", sameOrigin, validCol, validId, express.json({ limit: "512kb" }), async (req, res, next) => {
    try {
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) return res.status(400).json({ error: "bad_body" });
      delete body.id;
      body.updatedBy = req.user.email;
      await db.put(pool, req.params.col, req.params.id, body, req.user.email);
      broadcast(req.params.col);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  app.delete("/api/:col/:id", sameOrigin, validCol, validId, async (req, res, next) => {
    try { await db.remove(pool, req.params.col, req.params.id); broadcast(req.params.col); res.json({ ok: true }); } catch (e) { next(e); }
  });

  app.post("/api/photos", sameOrigin, express.raw({ type: () => true, limit: "15mb" }), async (req, res, next) => {
    try {
      const mime = String(req.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
      if (!PHOTO_TYPES.has(mime)) return res.status(415).json({ error: "unsupported_type" });
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "empty" });
      const id = crypto.randomBytes(16).toString("hex");
      await pool.query("insert into photos (id, mime, bytes, created_by) values ($1, $2, $3, $4)", [id, mime, req.body, req.user.email]);
      res.json({ id, url: "/_blob/" + id });
    } catch (e) { next(e); }
  });
  app.get("/_blob/:id", async (req, res, next) => {
    try {
      if (!/^[0-9a-f]{32}$/.test(req.params.id)) return res.status(404).end();
      const { rows } = await pool.query("select mime, bytes from photos where id = $1", [req.params.id]);
      if (!rows.length) return res.status(404).end();
      res.set({ "Content-Type": rows[0].mime, "Cache-Control": "private, max-age=31536000, immutable" }).send(rows[0].bytes);
    } catch (e) { next(e); }
  });

  app.get("/vendor/jspdf.umd.min.js", (req, res) => res.sendFile(require.resolve("jspdf/dist/jspdf.umd.min.js")));
  app.use(express.static(pub, { index: "index.html", maxAge: 0 }));
  app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: "server_error" }); });

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Twelve Objects admin on :${port}`));
}

// First boot on a new database: load the data moved over from the old inventory page.
async function importIfEmpty(pool) {
  const file = path.join(__dirname, "data", "initial.json");
  if (!fs.existsSync(file) || (await db.count(pool)) > 0) return;
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  let n = 0;
  for (const col of db.COLLECTIONS) for (const doc of data[col] || []) {
    const { id, ...rest } = doc;
    await db.put(pool, col, id, rest, "import"); n++;
  }
  console.log(`Imported ${n} records from data/initial.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
