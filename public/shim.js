// Connects the inventory screens to this app's server. It offers the same small
// interface the screens were written against (db, assets, user, downloads).
(() => {
  const H = { "X-Requested-With": "twelve-objects" };
  const err = (code, message) => Object.assign(new Error(message || code), { code });

  async function call(method, url, body, headers = {}) {
    let r;
    try { r = await fetch(url, { method, body, headers: { ...H, ...headers }, credentials: "same-origin" }); }
    catch (e) { throw err("unavailable", "No connection to the server"); }
    if (r.status === 401) {
      // A read can go straight to sign-in; a save keeps the open form so nothing typed is lost.
      if (method === "GET") location.href = "/login";
      throw err("unavailable", "Your sign-in expired. Open the app in a new tab to sign in again, then save here");
    }
    if (r.status === 415) throw err("unsupported_type");
    if (r.status === 413) throw err("unavailable", "That is too large to save");
    if (!r.ok) {
      let why = ""; try { why = (await r.json()).error || ""; } catch (e) {}
      if (r.status >= 500) throw err("unavailable", `The server couldn't save it just now (${r.status}). Try again in a moment`);
      throw err("unavailable", `The server refused the save (${r.status}${why ? ", " + why : ""})`);
    }
    return r.json();
  }

  // ---- live collections ----
  const subs = {}; // collection -> Set of callbacks
  const snap = (rows) => {
    const docs = rows.map((r) => { const { id, ...d } = r; return { id, exists: true, data: () => d, metadata: {} }; });
    return { docs, size: docs.length, empty: !docs.length, metadata: {} };
  };
  async function refresh(col) {
    if (!subs[col] || !subs[col].size) return;
    try { const rows = await call("GET", "/api/" + col); for (const fn of subs[col]) fn(snap(rows)); }
    catch (e) { /* the next event or focus retries */ }
  }
  let es;
  function listen() {
    if (es) return;
    es = new EventSource("/api/events");
    es.onmessage = (m) => { try { refresh(JSON.parse(m.data).collection); } catch (e) {} };
    es.onopen = () => Object.keys(subs).forEach(refresh); // catch up after a reconnect
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) Object.keys(subs).forEach(refresh); });

  const docRef = (path) => {
    const [col, id] = path.split("/");
    return {
      id, path,
      set: async (data) => { await call("PUT", `/api/${col}/${encodeURIComponent(id)}`, JSON.stringify(data), { "Content-Type": "application/json" }); await refresh(col); },
      delete: async () => { await call("DELETE", `/api/${col}/${encodeURIComponent(id)}`); await refresh(col); },
    };
  };
  const db = {
    doc: docRef,
    collection: (col) => ({
      doc: (id) => docRef(col + "/" + id),
      onSnapshot(next) { (subs[col] ||= new Set()).add(next); listen(); refresh(col); return () => subs[col].delete(next); },
    }),
  };

  // ---- photos: shrink large phone photos before upload ----
  async function shrink(file) {
    if (file.type === "image/gif") return file;
    try {
      const bmp = await createImageBitmap(file);
      const max = 2400, k = Math.min(1, max / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      return await new Promise((ok) => c.toBlob((b) => ok(b || file), "image/jpeg", 0.86));
    } catch (e) { return file; }
  }
  const assets = {
    upload: async (file) => { const b = await shrink(file); return call("POST", "/api/photos", b, { "Content-Type": b.type || "application/octet-stream" }); },
  };

  // ---- people and files ----
  let me = null;
  const user = {
    can: async () => true,
    me: async () => (me ||= await call("GET", "/api/me")),
  };
  const downloads = {
    save: async ({ filename, data }) => {
      const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type: "text/csv" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: filename });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      return { status: "saved" };
    },
  };

  const caps = { db, assets, user, downloads };
  window.claude = { use: async (name) => caps[name] || null };

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
})();
