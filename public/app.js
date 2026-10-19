(() => {
  const CATEGORIES = ["Furniture", "Lighting", "Seating", "Tables", "Ceramics", "Glass", "Sculpture", "Textiles", "Objects", "Wall works"];
  const STATUSES = [
    { id: "Incoming", cls: "st-incoming" },
    { id: "In gallery", cls: "st-gallery" },
    { id: "On hold", cls: "st-hold" },
    { id: "Sold", cls: "st-sold" },
    { id: "Returned", cls: "st-returned" },
  ];
  const ON_HAND = ["Incoming", "In gallery", "On hold"];

  const S = {
    db: null, assets: null, downloads: null, canWrite: true,
    pieces: [], artists: [], invoices: [], clients: [], settings: {}, loaded: { pieces: false, artists: false, invoices: false, clients: false }, offline: false, clientQ: "", invTab: "invoices", outFormOpen: false,
    invDraft: null, invPayOpen: false,
    view: "overview",
    f: { q: "", cat: "All", status: "On hand", agreement: "All", sort: "recent" },
    layout: "grid",
    panel: null, // {type:'piece'|'artist', id, mode:'view'|'edit'}
    photoIdx: 0,
    confirmDelete: false,
  };
  try { const v = localStorage.getItem("to-layout"); if (v) S.layout = v; } catch (e) {}

  // ---------- helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const n = (v) => { const x = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, "")); return isFinite(x) ? x : 0; };
  const has = (v) => v !== undefined && v !== null && String(v).trim() !== "";
  const usd = (v, opt = {}) => has(v) || opt.zero ? "$" + Math.round(n(v)).toLocaleString("en-US") : "";
  const money = (v) => has(v) ? "$" + Math.round(n(v)).toLocaleString("en-US") : "<span style='color:var(--faint)'>Not set</span>";
  const pad = (x) => String(x).padStart(2, "0");
  const iso = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const today = () => iso(new Date());
  const parse = (s) => { if (!s) return null; const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (s, k) => { const d = parse(s); d.setDate(d.getDate() + k); return iso(d); };
  const addMonths = (s, k) => { const d = parse(s); d.setMonth(d.getMonth() + k); return iso(d); };
  const daysFrom = (s) => Math.round((parse(s) - parse(today())) / 86400000);
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const fdate = (s) => { if (!s) return ""; const d = parse(s); return MON[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear(); };
  const rel = (s) => { const k = daysFrom(s); if (k === 0) return "Today"; if (k === 1) return "Tomorrow"; if (k === -1) return "Yesterday"; return k < 0 ? Math.abs(k) + " days overdue" : "In " + k + " days"; };
  const uid = () => Math.random().toString(36).slice(2, 10);
  const hash = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
  const artistOf = (p) => S.artists.find((a) => a.id === p.artistId);
  const artistName = (p) => artistOf(p)?.name || p.artistName || "Unassigned artist";
  const statusCls = (s) => (STATUSES.find((x) => x.id === s) || STATUSES[1]).cls;
  const pill = (s) => `<span class="pill ${statusCls(s)}">${esc(s || "In gallery")}</span>`;
  const sampleTag = (o) => (o.sample ? `<span class="sample">Sample</span>` : "");

  function toast(msg) {
    const r = $("#toastRoot");
    r.innerHTML = `<div class="toast" role="status">${esc(msg)}</div>`;
    clearTimeout(toast.t); toast.t = setTimeout(() => (r.innerHTML = ""), 2600);
  }

  // ---------- money logic ----------
  // Consignment: artist share = (sale - shipping) x split. Acquisition: gallery owns it; margin = sale - cost.
  function calc(p) {
    const sale = n(p.salePrice), ship = n(p.shipping), split = has(p.artistSplit) ? n(p.artistSplit) : 50;
    const out = { artistShare: 0, galleryNet: 0 };
    if (p.agreement === "Acquisition") {
      out.galleryNet = has(p.salePrice) ? sale - n(p.cost) : 0;
    } else {
      const base = Math.max(0, sale - ship);
      out.artistShare = has(p.salePrice) ? Math.round(base * split / 100) : 0;
      out.galleryNet = has(p.salePrice) ? sale - out.artistShare - ship : 0;
    }
    return out;
  }
  const unpaid = (p) => (p.payments || []).filter((x) => !x.paid);

  function upcoming() {
    const t = today(), horizon = addDays(t, 90), items = [];
    for (const p of S.pieces) {
      for (const pay of unpaid(p)) if (pay.due && pay.due <= horizon) items.push({ kind: "pay", date: pay.due, p, pay });
      if (p.followUpDate && p.followUpDate <= horizon && !p.followUpDone) items.push({ kind: "follow", date: p.followUpDate, p });
      if (p.status === "Incoming" && p.expectedDate && p.expectedDate <= horizon) items.push({ kind: "arrive", date: p.expectedDate, p });
      if (ON_HAND.includes(p.status) && p.agreement !== "Acquisition" && p.consignEnd && p.consignEnd <= horizon) items.push({ kind: "consign", date: p.consignEnd, p });
      if (isOut(p) && p.out.due && p.out.due <= horizon) items.push({ kind: "out", date: p.out.due, p });
    }
    for (const inv of openInvoices()) if (inv.dueDate && inv.dueDate <= horizon) items.push({ kind: "invoice", date: inv.dueDate, inv });
    return items.sort((a, b) => a.date.localeCompare(b.date));
  }

  // ---------- capabilities ----------
  async function boot() {
    const c = window.claude;
    if (!c || !c.use) { S.offline = true; render(); return; }
    const [db, assets, user, downloads] = await Promise.all([c.use("db"), c.use("assets"), c.use("user"), c.use("downloads")].map((p) => p.catch(() => null)));
    S.db = db; S.assets = assets; S.downloads = downloads;
    if (user) { try { const w = await user.can("data.write"); if (w === false) S.canWrite = false; } catch (e) {}
      user.me().then((u) => { const el = $("#who"); if (el && u) el.textContent = u.email; }).catch(() => {}); }
    if (!db) { S.offline = true; render(); return; }
    db.collection("pieces").onSnapshot((snap) => {
      S.pieces = snap.docs.filter((d) => d.exists).map((d) => ({ id: d.id, ...d.data() }));
      S.loaded.pieces = true; render(); renderPanel(true);
    }, (e) => { toast("The inventory stopped syncing. Reload the page to reconnect."); });
    db.collection("invoices").onSnapshot((snap) => {
      S.invoices = snap.docs.filter((d) => d.exists).map((d) => ({ id: d.id, ...d.data() }));
      S.loaded.invoices = true; render(); renderPanel(true);
    }, () => {});
    db.collection("clients").onSnapshot((snap) => {
      S.clients = snap.docs.filter((d) => d.exists).map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
      S.loaded.clients = true; render(); renderPanel(true);
    }, () => {});
    db.collection("settings").onSnapshot((snap) => {
      const g = snap.docs.find((d) => d.id === "gallery" && d.exists); S.settings = g ? g.data() : {};
    }, () => {});
    db.collection("artists").onSnapshot((snap) => {
      S.artists = snap.docs.filter((d) => d.exists).map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
      S.loaded.artists = true; render(); renderPanel(true);
    }, () => {});
  }

  async function write(path, data, msg) {
    try { await S.db.doc(path).set(data); if (msg) toast(msg); return true; }
    catch (e) {
      if (e && e.code === "invalid_argument") { S.canWrite = false; toast("You can view this inventory but not change it. Check that you are signed in."); }
      else if (e && e.code === "quota_exceeded") toast("Storage is full. Remove old pieces before adding more.");
      else toast("That change did not save. Check your connection and try again.");
      return false;
    }
  }

  // ---------- views ----------
  function render() {
    document.querySelectorAll("[data-go]").forEach((b) => b.tagName === "BUTTON" && b.setAttribute("aria-current", b.dataset.go === S.view ? "page" : "false"));
    $("#addPieceTop").hidden = !S.canWrite || S.offline;
    const m = $("#main");
    if (S.offline) {
      m.innerHTML = `<div class="empty"><h2>Inventory <em class="s">offline</em></h2><div><p>The app can't reach the server right now. Check your connection and reload the page.</p></div></div>`;
      return;
    }
    if (!S.loaded.pieces || !S.loaded.artists || !S.loaded.invoices || !S.loaded.clients) return;
    const sampleCount = S.pieces.filter((p) => p.sample).length + S.artists.filter((a) => a.sample).length + S.invoices.filter((i) => i.sample).length + S.clients.filter((c) => c.sample).length;
    const note = sampleCount && S.canWrite ? `<div class="notice"><span><b>Sample entries.</b> Pieces, artists, clients and invoices marked Sample are examples to show how the inventory works.</span><button class="btn small ghost" data-act="clear-samples">Remove samples</button></div>` : "";
    m.innerHTML = note + (S.view === "inventory" ? viewInventory() : S.view === "artists" ? viewArtists() : S.view === "invoices" ? viewInvoices() : S.view === "clients" ? viewClients() : viewOverview());
  }

  function photoUrl(p, i = 0) { const ph = (p.photos || [])[i]; return ph ? "/_blob/" + ph : ""; }
  function tile(p, i = 0) {
    const u = photoUrl(p, i);
    if (u) return `<div class="ph"><img src="${esc(u)}" alt="${esc(p.title)}" loading="lazy"></div>`;
    const g = "g" + (hash(p.category || p.title) % 4);
    const letter = (p.title || "?").trim().charAt(0).toUpperCase();
    return `<div class="ph"><div class="ini ${g}"><span class="lbl">${esc(p.category || "Object")}</span><span class="glyph">${esc(letter)}</span></div></div>`;
  }
  function card(p) {
    const price = p.status === "Sold" && has(p.salePrice) ? "Sold " + usd(p.salePrice) : has(p.price) ? usd(p.price) : "Price on request";
    return `<button class="card" data-open-piece="${esc(p.id)}">
      <div style="position:relative">${tile(p)}<span class="pill-wrap" style="position:absolute;top:9px;right:9px">${isOut(p) ? `<span class="pill st-out">${esc(p.out.type)}</span>` : pill(p.status)}</span></div>
      <div class="t">${esc(p.title || "Untitled")}${sampleTag(p)}</div>
      <div class="a">${esc(artistName(p))}${p.year ? ", " + esc(p.year) : ""}</div>
      <div class="row"><span>${esc(p.category || "Uncategorized")}</span><span>${esc(price)}</span></div>
    </button>`;
  }

  function viewOverview() {
    const onHand = S.pieces.filter((p) => ON_HAND.includes(p.status));
    const retail = onHand.reduce((s, p) => s + n(p.price), 0);
    const owed = S.pieces.reduce((s, p) => s + unpaid(p).reduce((a, x) => a + n(x.amount), 0), 0);
    const owedCount = S.pieces.reduce((s, p) => s + unpaid(p).length, 0);
    const yr = String(new Date().getFullYear());
    const soldYr = S.pieces.filter((p) => p.status === "Sold" && (p.soldDate || "").startsWith(yr));
    const net = soldYr.reduce((s, p) => s + calc(p).galleryNet, 0);
    const consign = onHand.filter((p) => p.agreement !== "Acquisition").length;
    const incoming = onHand.filter((p) => p.status === "Incoming").length;

    if (!S.pieces.length && !S.artists.length) return emptyState();

    const up = upcoming();
    const agenda = up.length ? `<ul class="agenda">${up.slice(0, 9).map(agendaItem).join("")}</ul>` :
      `<div class="empty-line">Nothing due in the next 90 days. Payments, follow-ups and arrivals appear here as you add them to pieces.</div>`;
    const recent = [...S.pieces].sort((a, b) => String(b.receivedDate || b.createdAt || "").localeCompare(String(a.receivedDate || a.createdAt || ""))).filter((p) => ON_HAND.includes(p.status)).slice(0, 6);

    return `
      <div class="head"><h1>The <em class="s">collection</em> today</h1><p>${onHand.length} ${onHand.length === 1 ? "piece" : "pieces"} on hand from ${new Set(onHand.map((p) => p.artistId)).size} artists. ${consign} on consignment, ${onHand.length - consign} owned outright${incoming ? ", " + incoming + " still incoming" : ""}.</p></div>
      <div class="figures">
        <div><span class="k">On hand</span><div class="v num">${onHand.length}</div><div class="sub">pieces incoming, shown or on hold</div></div>
        <div><span class="k">Retail value</span><div class="v num">${usd(retail, { zero: 1 })}</div><div class="sub">list prices of pieces on hand</div></div>
        <div class="owed"><span class="k">Owed to artists</span><div class="v num">${usd(owed, { zero: 1 })}</div><div class="sub">${owedCount} open ${owedCount === 1 ? "payment" : "payments"}</div></div>
        <div><span class="k">Gallery net ${yr}</span><div class="v num">${usd(net, { zero: 1 })}</div><div class="sub">${soldYr.length} sold this year, after artist share</div></div>
      </div>
      <div class="over">
        <section><div class="block-title"><h3>Coming up</h3><span class="k">Next 90 days</span></div>${agenda}</section>
        <section><div class="block-title"><h3>Recently in</h3><button class="linkish" data-go="inventory">View all inventory</button></div>
          ${recent.length ? `<div class="grid">${recent.map(card).join("")}</div>` : `<div class="empty-line">No pieces on hand yet.</div>`}
        </section>
      </div>`;
  }

  function agendaItem(it) {
    const d = parse(it.date), late = it.date < today();
    if (it.kind === "invoice") {
      const inv = it.inv, t = invTotals(inv);
      return `<li class="${late ? "over-due" : ""}">
        <div class="d"><b>${d.getDate()}</b><span>${MON[d.getMonth()]}</span></div>
        <div class="what"><div><span class="tag ${late ? "late" : "arrive"}">Invoice</span><button class="t" data-open-invoice="${esc(inv.id)}">${esc(clientName(inv))}</button></div><div class="m">${esc(inv.number)} balance due · ${rel(it.date)}</div></div>
        <div class="amt"><span class="num">${usd2(t.balance)}</span>${S.canWrite ? `<button class="btn small ghost" data-open-invoice="${esc(inv.id)}">Open</button>` : ""}</div></li>`;
    }
    const p = it.p;
    let tag, line, amt = "";
    if (it.kind === "pay") {
      tag = late ? `<span class="tag late">Overdue</span>` : `<span class="tag pay">Payment</span>`;
      line = `${esc(it.pay.label || "Payment")} to ${esc(artistName(p))}`;
      amt = `<span class="num">${usd(it.pay.amount, { zero: 1 })}</span>` + (S.canWrite ? `<button class="btn small ghost" data-mark-paid="${esc(p.id)}|${esc(it.pay.id)}">Mark paid</button>` : "");
    } else if (it.kind === "follow") {
      tag = late ? `<span class="tag late">Follow up</span>` : `<span class="tag follow">Follow up</span>`;
      line = esc(p.followUpNote || "Follow up with " + artistName(p));
      amt = S.canWrite ? `<button class="btn small ghost" data-follow-done="${esc(p.id)}">Done</button>` : "";
    } else if (it.kind === "consign") {
      tag = `<span class="tag ${late ? "late" : "follow"}">Consignment ends</span>`;
      line = `Renew with ${esc(artistName(p))} or return the piece`;
    } else if (it.kind === "out") {
      tag = `<span class="tag ${late ? "late" : "arrive"}">Due back</span>`;
      line = `${esc(p.out.type)} with ${esc(p.out.with)}`;
    } else {
      tag = late ? `<span class="tag late">Arrival</span>` : `<span class="tag arrive">Arriving</span>`;
      line = `Expected from ${esc(artistName(p))}`;
    }
    return `<li class="${late ? "over-due" : ""}">
      <div class="d"><b>${d.getDate()}</b><span>${MON[d.getMonth()]}</span></div>
      <div class="what"><div>${tag}<button class="t" data-open-piece="${esc(p.id)}">${esc(p.title || "Untitled")}</button></div><div class="m">${line} · ${rel(it.date)}</div></div>
      <div class="amt">${amt}</div></li>`;
  }

  function emptyState() {
    return `<div class="empty"><h2>An empty <em class="s">room,</em> for now</h2><div>
      <p>Every piece that comes through the gallery lives here: who made it, what we paid or owe, the agreement terms, its price, and the next payment or follow-up date.</p>
      <p>Start with an artist, then add their pieces.</p>
      ${S.canWrite ? `<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" data-act="new-piece">Add the first piece</button><button class="btn ghost" data-act="new-artist">Add an artist</button></div>` : ""}
    </div></div>`;
  }

  function filtered() {
    const f = S.f, q = f.q.trim().toLowerCase();
    let list = S.pieces.filter((p) => {
      if (f.cat !== "All" && (p.category || "Uncategorized") !== f.cat) return false;
      if (f.status === "On hand" && !ON_HAND.includes(p.status)) return false;
      if (f.status === "Out" ? !isOut(p) : f.status !== "On hand" && f.status !== "All" && p.status !== f.status) return false;
      if (f.agreement !== "All" && (p.agreement || "Consignment") !== f.agreement) return false;
      if (q) { const hay = [p.title, artistName(p), p.materials, p.sku, p.category, p.notes].join(" ").toLowerCase(); if (!hay.includes(q)) return false; }
      return true;
    });
    const by = {
      recent: (a, b) => String(b.receivedDate || b.createdAt || "").localeCompare(String(a.receivedDate || a.createdAt || "")),
      priceHi: (a, b) => n(b.price) - n(a.price),
      priceLo: (a, b) => n(a.price) - n(b.price),
      title: (a, b) => String(a.title).localeCompare(String(b.title)),
      artist: (a, b) => artistName(a).localeCompare(artistName(b)),
    }[f.sort];
    return list.sort(by);
  }

  function viewInventory() {
    const cats = {};
    S.pieces.forEach((p) => { const c = p.category || "Uncategorized"; cats[c] = (cats[c] || 0) + 1; });
    const catList = ["All", ...Object.keys(cats).sort()];
    const list = filtered();
    const chips = catList.map((c) => `<button class="chip" aria-pressed="${S.f.cat === c}" data-cat="${esc(c)}">${esc(c)}<span class="c">${c === "All" ? S.pieces.length : cats[c]}</span></button>`).join("");
    const opt = (arr, cur) => arr.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(l)}</option>`).join("");
    const body = !list.length ? `<div class="empty-line">No pieces match these filters.</div>` :
      S.layout === "grid" ? `<div class="grid">${list.map(card).join("")}</div>` : table(list);
    return `
      <div class="head"><h1>In<em class="s">ventory</em></h1>
        <div class="tools">${S.downloads ? `<button class="btn ghost" data-act="export">Export CSV</button>` : ""}${S.canWrite ? `<button class="btn" data-act="new-piece">Add piece</button>` : ""}</div></div>
      <div class="filters">
        <div class="chips" role="group" aria-label="Category">${chips}</div>
      </div>
      <div class="filters" style="border-top:0;margin-top:-24px">
        <input class="search" id="q" type="search" placeholder="Search title, artist, material, SKU" value="${esc(S.f.q)}" aria-label="Search">
        <select id="fStatus" aria-label="Status">${opt([["On hand", "On hand"], ["All", "All statuses"], ...STATUSES.map((s) => [s.id, s.id]), ["Out", "Out of the gallery"]], S.f.status)}</select>
        <select id="fAgreement" aria-label="Agreement">${opt([["All", "All agreements"], ["Consignment", "Consignment"], ["Acquisition", "Acquisition"]], S.f.agreement)}</select>
        <select id="fSort" aria-label="Sort">${opt([["recent", "Newest first"], ["priceHi", "Price, high to low"], ["priceLo", "Price, low to high"], ["title", "Title A to Z"], ["artist", "Artist A to Z"]], S.f.sort)}</select>
        <div class="seg" role="group" aria-label="Layout"><button aria-pressed="${S.layout === "grid"}" data-layout="grid">Gallery</button><button aria-pressed="${S.layout === "table"}" data-layout="table">Ledger</button></div>
      </div>
      ${body}`;
  }

  function nextDate(p) {
    const ds = [...unpaid(p).map((x) => x.due), !p.followUpDone && p.followUpDate, p.status === "Incoming" && p.expectedDate].filter(Boolean).sort();
    return ds[0] || "";
  }
  function table(list) {
    let tc = 0, tp = 0, to = 0;
    const rows = list.map((p) => {
      const owe = unpaid(p).reduce((s, x) => s + n(x.amount), 0);
      tc += n(p.cost); tp += n(p.price); to += owe;
      const nd = nextDate(p);
      return `<tr class="click" data-open-piece="${esc(p.id)}" tabindex="0">
        <td><div class="thumb">${tile(p)}</div></td>
        <td class="num" style="color:var(--soft)">${esc(p.sku || "")}</td>
        <td><span class="tt">${esc(p.title || "Untitled")}</span>${sampleTag(p)}</td>
        <td>${esc(artistName(p))}</td>
        <td>${esc(p.category || "")}</td>
        <td>${esc(p.agreement || "Consignment")}${p.agreement !== "Acquisition" ? ` <span style="color:var(--soft)">${has(p.artistSplit) ? n(p.artistSplit) : 50}%</span>` : ""}</td>
        <td class="r">${has(p.cost) ? usd(p.cost) : ""}</td>
        <td class="r">${has(p.price) ? usd(p.price) : ""}</td>
        <td class="r" style="${owe ? "color:var(--orange)" : ""}">${owe ? usd(owe) : ""}</td>
        <td class="num" style="${nd && nd < today() ? "color:var(--red)" : ""}">${nd ? fdate(nd) : ""}</td>
        <td>${pill(p.status)}</td></tr>`;
    }).join("");
    return `<div class="tbl-wrap"><table class="tbl"><thead><tr><th></th><th>SKU</th><th>Piece</th><th>Artist</th><th>Category</th><th>Agreement</th><th class="r">Paid</th><th class="r">Price</th><th class="r">Owed</th><th>Next date</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody><tfoot><tr><td></td><td colspan="5">${list.length} pieces</td><td class="r">${usd(tc, { zero: 1 })}</td><td class="r">${usd(tp, { zero: 1 })}</td><td class="r">${usd(to, { zero: 1 })}</td><td colspan="2"></td></tr></tfoot></table></div>`;
  }

  function viewArtists() {
    if (!S.artists.length) return `<div class="head"><h1><em class="s">Artists</em></h1><div class="tools">${S.canWrite ? `<button class="btn" data-act="new-artist">Add artist</button>` : ""}</div></div><div class="empty-line">No artists yet. Add an artist to keep their contact details, agreement and files link in one place.</div>`;
    const cards = S.artists.map((a) => {
      const ps = S.pieces.filter((p) => p.artistId === a.id);
      const hand = ps.filter((p) => ON_HAND.includes(p.status));
      const owed = ps.reduce((s, p) => s + unpaid(p).reduce((x, y) => x + n(y.amount), 0), 0);
      return `<div class="artist">
        <button style="border:0;background:none;padding:0;text-align:left" data-open-artist="${esc(a.id)}"><div class="nm">${esc(a.name)}${sampleTag(a)}</div></button>
        <div class="loc">${esc([a.studio, a.location].filter(Boolean).join(", ") || "Location not set")}</div>
        <div class="stats"><span><b>${hand.length}</b> on hand</span><span><b>${ps.filter((p) => p.status === "Sold").length}</b> sold</span><span style="${owed ? "color:var(--orange)" : ""}"><b>${usd(owed, { zero: 1 })}</b> owed</span></div>
        <div class="ft"><button class="btn small ghost" data-open-artist="${esc(a.id)}">Details</button>${a.filesUrl ? `<a class="btn small lime" href="${esc(safeUrl(a.filesUrl))}" target="_blank" rel="noopener">Open files</a>` : ""}</div>
      </div>`;
    }).join("");
    return `<div class="head"><h1><em class="s">Artists</em></h1><div class="tools">${S.canWrite ? `<button class="btn" data-act="new-artist">Add artist</button>` : ""}</div></div><div class="artists">${cards}</div>`;
  }

  function safeUrl(u) { const s = String(u || "").trim(); if (!s) return ""; return /^https?:\/\//i.test(s) ? s : "https://" + s.replace(/^\/+/, ""); }

  // ---------- panel ----------
  function openPanel(type, id, mode = "view") { S.panel = { type, id, mode }; S.photoIdx = 0; S.confirmDelete = false; S.outFormOpen = false; renderPanel(); }
  function closePanel() { S.panel = null; $("#panelRoot").innerHTML = ""; document.body.style.overflow = ""; }

  function renderPanel(fromSync) {
    const P = S.panel, root = $("#panelRoot");
    if (!P) return;
    if (fromSync && P.mode === "edit") return; // don't clobber an open form
    document.body.style.overflow = "hidden";
    let html = "";
    if (P.type === "piece") {
      const p = P.id ? S.pieces.find((x) => x.id === P.id) : null;
      if (P.id && !p) { if (Date.now() - (P.saved || 0) > 5000) closePanel(); return; }
      html = P.mode === "edit" ? pieceForm(p) : pieceDetail(p);
    } else if (P.type === "invoice") {
      const inv = P.id ? S.invoices.find((x) => x.id === P.id) : null;
      if (P.id && !inv) { if (Date.now() - (P.saved || 0) > 5000) closePanel(); return; }
      html = P.mode === "edit" ? invoiceForm(inv || P.seed) : invoiceDetail(inv);
    } else if (P.type === "client") {
      const c = P.id ? S.clients.find((x) => x.id === P.id) : null;
      if (P.id && !c) { if (Date.now() - (P.saved || 0) > 5000) closePanel(); return; }
      html = P.mode === "edit" ? clientForm(c) : clientDetail(c);
    } else if (P.type === "settings") {
      html = settingsForm();
    } else {
      const a = P.id ? S.artists.find((x) => x.id === P.id) : null;
      if (P.id && !a) { if (Date.now() - (P.saved || 0) > 5000) closePanel(); return; }
      html = P.mode === "edit" ? artistForm(a) : artistDetail(a);
    }
    const scroll = root.querySelector(".panel")?.scrollTop || 0;
    root.innerHTML = `<div class="scrim" data-act="close"></div><aside class="panel" role="dialog" aria-modal="true">${html}</aside>`;
    if (fromSync) root.querySelector(".panel").scrollTop = scroll;
  }

  function pieceDetail(p) {
    const a = artistOf(p), c = calc(p), cons = p.agreement !== "Acquisition";
    const split = has(p.artistSplit) ? n(p.artistSplit) : 50;
    const photos = p.photos || [];
    const i = Math.min(S.photoIdx, Math.max(0, photos.length - 1));
    const facts = [
      ["SKU", p.sku], ["Category", p.category], ["Year", p.year], ["Materials", p.materials], ["Dimensions", p.dimensions],
      ["Edition", p.edition], ["Location", p.location], ["Received", fdate(p.receivedDate)],
      [p.status === "Incoming" ? "Expected" : "", p.status === "Incoming" ? fdate(p.expectedDate) : ""],
      ["Sold", fdate(p.soldDate)], ["Buyer", p.buyer],
      ["Insured for", has(p.insuranceValue) ? usd(p.insuranceValue) : ""],
      ["Condition", [p.condition, p.conditionDate && "checked " + fdate(p.conditionDate)].filter(Boolean).join(", ")],
      ["Condition notes", p.conditionNotes],
    ].filter(([k, v]) => k && has(v));
    const terms = cons
      ? `Consignment. Artist receives <mark>${split}%</mark> of the sale price net of shipping, paid within <mark>30 days</mark> of sale. Artist ships in; gallery covers return shipping.${p.consignEnd ? ` Consignment runs to <mark>${fdate(p.consignEnd)}</mark>.` : ""}`
      : `Acquisition. Purchased outright for <mark>${has(p.cost) ? usd(p.cost) : "an unrecorded amount"}</mark>. The gallery sets the resale price and owes the artist nothing further after payment.`;
    const pays = (p.payments || []).slice().sort((x, y) => String(x.due).localeCompare(String(y.due)));
    const payRows = pays.length ? `<table class="pays">${pays.map((x) => `<tr>
        <td>${esc(x.label || "Payment")}</td>
        <td class="num" style="${!x.paid && x.due && x.due < today() ? "color:var(--red)" : "color:var(--soft)"}">${x.paid ? "Paid " + fdate(x.paidDate || x.due) : x.due ? "Due " + fdate(x.due) : "No date"}</td>
        <td class="r">${usd(x.amount, { zero: 1 })}</td>
        <td class="r">${isPayout(x) && p.status === "Sold" && x.id ? `<button class="btn small ghost" data-statement="${esc(p.id)}|${esc(x.id)}">Statement</button>` : ""}</td>
        <td class="r">${x.paid ? `<span class="pill st-gallery">Paid</span>` : S.canWrite ? `<button class="btn small ghost" data-mark-paid="${esc(p.id)}|${esc(x.id)}">Mark paid</button>` : `<span class="pill st-incoming">Open</span>`}</td></tr>`).join("")}</table>`
      : `<div class="empty-line" style="padding:12px 0">No payments recorded.</div>`;
    const fileRow = (label, url) => url ? `<div class="files-link"><div style="min-width:0"><div>${label}</div><div class="u">${esc(url)}</div></div><a class="btn small lime" href="${esc(safeUrl(url))}" target="_blank" rel="noopener">Open</a></div>` : "";
    return `
      <div class="bar"><span class="k">${esc(p.sku || "Piece")} · ${esc(p.agreement || "Consignment")}</span>
        <div class="acts">${S.canWrite ? `<button class="btn small" data-act="edit">Edit</button>` : ""}<button class="btn small ghost" data-act="close">Close</button></div></div>
      <div class="detail-top">
        <div>${tile(p, i)}${photos.length > 1 ? `<div class="thumbs">${photos.map((ph, k) => `<button aria-pressed="${k === i}" data-photo="${k}" aria-label="Photo ${k + 1}"><img src="/_blob/${esc(ph)}" alt=""></button>`).join("")}</div>` : ""}</div>
        <div style="min-width:0">
          <div style="margin-bottom:10px">${pill(p.status)}${isOut(p) ? ` <span class="pill st-out">${esc(p.out.type)}</span>` : ""}${sampleTag(p)}</div>
          <h2>${esc(p.title || "Untitled")}</h2>
          <div class="by">${a ? `<button class="linkish" style="font-size:14px" data-open-artist="${esc(a.id)}">${esc(a.name)}</button>` : esc(artistName(p))}</div>
          <dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
        </div>
      </div>
      ${outSection(p)}
      <div class="sec"><span class="k">Agreement and money</span>
        <div class="terms">${terms}</div>
        <div class="files-link"><div style="min-width:0"><div>${p.agreementDate ? "Signed " + fdate(p.agreementDate) : `<span style="color:var(--orange)">Signed agreement not recorded</span>`}</div>${p.agreementUrl ? `<div class="u">${esc(p.agreementUrl)}</div>` : ""}</div>${p.agreementUrl ? `<a class="btn small lime" href="${esc(safeUrl(p.agreementUrl))}" target="_blank" rel="noopener">Open agreement</a>` : ""}</div>
        <div class="money">
          <div><span class="k">${cons ? "Paid" : "Paid"}</span><div class="v">${cons ? (has(p.cost) ? usd(p.cost) : "$0") : money(p.cost)}</div><div class="sub">${cons ? "consigned, nothing upfront" : "acquisition cost"}</div></div>
          <div><span class="k">List price</span><div class="v">${money(p.price)}</div><div class="sub">retail</div></div>
          <div><span class="k">Sold for</span><div class="v">${money(p.salePrice)}</div><div class="sub">${has(p.shipping) ? usd(p.shipping) + " shipping" : "shipping not set"}</div></div>
          <div><span class="k">${cons ? "Artist share" : "Gallery margin"}</span><div class="v">${has(p.salePrice) ? usd(cons ? c.artistShare : c.galleryNet, { zero: 1 }) : "<span style='color:var(--faint)'>After sale</span>"}</div><div class="sub">${cons ? (has(p.salePrice) ? "gallery keeps " + usd(c.galleryNet, { zero: 1 }) : split + "% net of shipping") : "sale minus cost"}</div></div>
        </div>
      </div>
      <div class="sec"><span class="k">Payments</span>${payRows}</div>
      ${(() => { const iv = invoiceForPiece(p.id);
        if (iv) return `<div class="sec"><span class="k">Invoice</span><div class="files-link"><div><div>${esc(iv.number)}, ${esc(clientName(iv))}</div><div class="u">${invStatus(iv)} · ${usd2(invTotals(iv).total)}</div></div><button class="btn small ghost" data-open-invoice="${esc(iv.id)}">Open invoice</button></div></div>`;
        return S.canWrite && !["Sold", "Returned"].includes(p.status) ? `<div class="sec"><span class="k">Invoice</span><div class="files-link"><div>Selling this piece?</div><button class="btn small lime" data-act="new-invoice-for" data-piece="${esc(p.id)}">Create invoice</button></div></div>` : ""; })()}
      ${p.followUpDate && !p.followUpDone ? `<div class="sec"><span class="k">Next follow-up</span><div class="files-link"><div><div>${esc(p.followUpNote || "Follow up")}</div><div class="u">${fdate(p.followUpDate)} · ${rel(p.followUpDate)}</div></div>${S.canWrite ? `<button class="btn small ghost" data-follow-done="${esc(p.id)}">Done</button>` : ""}</div></div>` : ""}
      ${p.filesUrl || a?.filesUrl ? `<div class="sec"><span class="k">Files</span>${fileRow("Piece files", p.filesUrl)}${fileRow((a ? a.name : "Artist") + " folder", a?.filesUrl)}</div>` : ""}
      ${p.notes ? `<div class="sec"><span class="k">Notes</span><div class="notes">${esc(p.notes)}</div></div>` : ""}
      ${a ? `<div class="sec"><span class="k">Artist contact</span><dl class="facts">${[["Email", a.email], ["Phone", a.phone], ["Website", a.website], ["Instagram", a.instagram]].filter(([, v]) => has(v)).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("") || `<dt>Contact</dt><dd>Not recorded</dd>`}</dl></div>` : ""}`;
  }

  function field(name, label, val, opts = {}) {
    const type = opts.type || "text", cls = opts.full ? " full" : "";
    if (opts.options) return `<label class="f${cls}">${label}<select id="f-${name}" name="${name}">${opts.options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}"${String(val ?? "") === String(v) ? " selected" : ""}>${esc(l)}</option>`; }).join("")}</select></label>`;
    if (type === "textarea") return `<label class="f${cls}">${label}<textarea id="f-${name}" name="${name}" placeholder="${esc(opts.ph || "")}">${esc(val)}</textarea></label>`;
    return `<label class="f${cls}">${label}<input id="f-${name}" name="${name}" type="${type}" value="${esc(val)}"${opts.ph ? ` placeholder="${esc(opts.ph)}"` : ""}${opts.list ? ` list="${opts.list}"` : ""}${type === "number" ? ' step="any" inputmode="decimal"' : ""}${opts.req ? " required" : ""}></label>`;
  }

  function payRow(x = {}) {
    return `<div class="pay-row" data-pay="${esc(x.id || uid())}">
      <label class="f">What<input name="pl" value="${esc(x.label || "")}" placeholder="Artist payout"></label>
      <label class="f">Amount<input name="pa" type="number" step="any" inputmode="decimal" value="${esc(x.amount ?? "")}"></label>
      <label class="f">Due<input name="pd" type="date" value="${esc(x.due || "")}"></label>
      <label class="chk"><input type="checkbox" name="pp"${x.paid ? " checked" : ""}> Paid</label>
      <input type="hidden" name="ppd" value="${esc(x.paidDate || "")}">
      <button type="button" class="x" data-act="rm-pay" aria-label="Remove payment">×</button></div>`;
  }

  function nextSku() {
    const yr = String(new Date().getFullYear()).slice(2);
    const max = S.pieces.reduce((m, p) => { const k = /TO-\d+-(\d+)/.exec(p.sku || ""); return k ? Math.max(m, +k[1]) : m; }, 0);
    return `TO-${yr}-${String(max + 1).padStart(3, "0")}`;
  }

  function pieceForm(p) {
    const isNew = !p; p = p || { status: "Incoming", agreement: "Consignment", artistSplit: 50, sku: nextSku(), receivedDate: "", category: "" };
    S.formPhotos = [...(p.photos || [])];
    const artistOpts = [["", "Choose an artist"], ...S.artists.map((a) => [a.id, a.name]), ["__new", "New artist..."]];
    return `
      <div class="bar"><span class="k">${isNew ? "New piece" : "Editing " + esc(p.sku || "")}</span><div class="acts"><button class="btn small ghost" data-act="${isNew ? "close" : "cancel-edit"}">Cancel</button></div></div>
      <h2>${isNew ? "Add a <em class='s'>piece</em>" : esc(p.title)}</h2>
      <form id="pieceForm" autocomplete="off" novalidate>
        <div class="sec"><span class="k">The piece</span><div class="grid2">
          ${field("title", "Title", p.title, { full: true, req: true, ph: "e.g. Low Table in Travertine" })}
          ${field("artistId", "Artist", p.artistId || "", { options: artistOpts })}
          <label class="f" id="newArtistWrap" hidden>New artist name<input id="f-newArtist" name="newArtist"></label>
          ${field("category", "Category", p.category, { list: "cats", ph: "Furniture, Lighting..." })}
          ${field("status", "Status", p.status, { options: STATUSES.map((s) => s.id) })}
          ${field("sku", "SKU", p.sku)}
          ${field("year", "Year", p.year)}
          ${field("edition", "Edition", p.edition, { ph: "Unique, 1 of 8, AP..." })}
          ${field("materials", "Materials", p.materials, { full: true })}
          ${field("dimensions", "Dimensions", p.dimensions, { ph: "H x W x D in" })}
          ${field("location", "Location", p.location, { ph: "Gallery floor, storage..." })}
        </div><datalist id="cats">${CATEGORIES.map((c) => `<option value="${c}">`).join("")}</datalist></div>

        <div class="sec"><span class="k">Photos</span>
          <div class="photo-edit" id="photoEdit">${photoTiles()}</div>
          ${S.assets ? "" : `<div class="hint">Photo uploads are available to people who can edit this inventory.</div>`}
        </div>

        <div class="sec"><span class="k">Agreement and money</span><div class="grid3">
          ${field("agreement", "Agreement", p.agreement, { options: ["Consignment", "Acquisition"] })}
          ${field("artistSplit", "Artist share %", p.artistSplit ?? 50, { type: "number" })}
          ${field("cost", "Amount we paid", p.cost, { type: "number", ph: "Acquisition cost" })}
          ${field("price", "List price", p.price, { type: "number" })}
          ${field("salePrice", "Sold for", p.salePrice, { type: "number" })}
          ${field("shipping", "Shipping on sale", p.shipping, { type: "number" })}
          ${field("soldDate", "Date sold", p.soldDate, { type: "date" })}
          ${field("buyer", "Buyer", p.buyer, { full: false })}
          ${field("agreementDate", "Agreement signed", p.agreementDate, { type: "date" })}
          ${field("agreementUrl", "Signed agreement link (PDF)", p.agreementUrl, { ph: "https://www.dropbox.com/..." })}
          ${field("consignEnd", "Consignment ends", p.consignEnd, { type: "date" })}
        </div><div class="hint">Consignment pays the artist their share of the sale net of shipping within 30 days. Acquisition is paid upfront; record that payment below.</div></div>

        <div class="sec"><span class="k">Care and insurance</span><div class="grid3">
          ${field("insuranceValue", "Insured value", p.insuranceValue, { type: "number" })}
          ${field("condition", "Condition", p.condition || "", { options: [["", "Not checked"], "Excellent", "Good", "Fair", "Needs attention"] })}
          ${field("conditionDate", "Condition checked", p.conditionDate, { type: "date" })}
          ${field("conditionNotes", "Condition notes", p.conditionNotes, { full: true, ph: "Marks, repairs, handling notes" })}
        </div></div>

        <div class="sec"><span class="k">Payments</span>
          <div class="pay-rows" id="payRows">${(p.payments || []).map(payRow).join("")}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;padding-top:10px"><button type="button" class="btn small ghost" data-act="add-pay">Add payment</button><button type="button" class="btn small lime" data-act="calc-pay">Add artist payout from sale</button></div>
        </div>

        <div class="sec"><span class="k">Dates</span><div class="grid3">
          ${field("receivedDate", "Received", p.receivedDate, { type: "date" })}
          ${field("expectedDate", "Expected arrival", p.expectedDate, { type: "date" })}
          ${field("followUpDate", "Follow up on", p.followUpDate, { type: "date" })}
          ${field("followUpNote", "Follow-up note", p.followUpNote, { full: true, ph: "e.g. Ask for care sheet and high-res images" })}
        </div></div>

        <div class="sec"><span class="k">Files and notes</span><div class="grid2">
          ${field("filesUrl", "Files link (Dropbox, Drive)", p.filesUrl, { full: true, ph: "https://www.dropbox.com/..." })}
          ${field("notes", "Notes", p.notes, { type: "textarea", full: true })}
        </div></div>

        <div class="form-acts">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${isNew ? "" : S.confirmDelete ? `<span class="err">Delete this piece for everyone?</span><button type="button" class="btn small danger" data-act="delete-piece">Delete</button><button type="button" class="btn small ghost" data-act="keep">Keep</button>` : `<button type="button" class="btn small danger" data-act="ask-delete">Delete piece</button>`}</div>
          <div style="display:flex;gap:8px;align-items:center"><span class="err" id="formErr"></span><button type="submit" class="btn">${isNew ? "Add piece" : "Save changes"}</button></div>
        </div>
      </form>`;
  }

  function photoTiles() {
    const tiles = (S.formPhotos || []).map((id, k) => `<div class="tile"><img src="/_blob/${esc(id)}" alt="">${k === 0 ? `<span class="cv">Cover</span>` : ""}<button type="button" class="x" data-rm-photo="${k}" aria-label="Remove photo">×</button></div>`).join("");
    const up = S.assets ? `<label class="upl" id="uplLabel">Add photos<input type="file" id="photoInput" accept="image/*" multiple></label>` : "";
    return tiles + up;
  }

  function artistDetail(a) {
    const ps = S.pieces.filter((p) => p.artistId === a.id);
    const facts = [["Studio", a.studio], ["Location", a.location], ["Email", a.email], ["Phone", a.phone], ["Website", a.website], ["Instagram", a.instagram], ["Usual agreement", a.agreement]].filter(([, v]) => has(v));
    return `
      <div class="bar"><span class="k">Artist</span><div class="acts"><button class="btn small lime" data-act="artist-statement">Statement PDF</button>${S.canWrite ? `<button class="btn small" data-act="edit">Edit</button>` : ""}<button class="btn small ghost" data-act="close">Close</button></div></div>
      <h2>${esc(a.name)}${sampleTag(a)}</h2>
      <div class="by">${esc([a.studio, a.location].filter(Boolean).join(", "))}</div>
      ${a.filesUrl ? `<div class="sec"><span class="k">Files</span><div class="files-link"><div style="min-width:0"><div>Artist folder</div><div class="u">${esc(a.filesUrl)}</div></div><a class="btn small lime" href="${esc(safeUrl(a.filesUrl))}" target="_blank" rel="noopener">Open files</a></div></div>` : ""}
      <div class="sec"><span class="k">Details</span><dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("") || "<dt>Details</dt><dd>Not recorded yet</dd>"}</dl></div>
      ${a.bio ? `<div class="sec"><span class="k">Bio</span><div class="notes">${esc(a.bio)}</div></div>` : ""}
      ${a.notes ? `<div class="sec"><span class="k">Notes</span><div class="notes">${esc(a.notes)}</div></div>` : ""}
      <div class="sec"><span class="k">Pieces (${ps.length})</span>
        ${ps.length ? `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:18px 14px;margin-top:14px">${ps.map(card).join("")}</div>` : `<div class="empty-line">No pieces yet.</div>`}
        ${S.canWrite ? `<div style="padding-top:14px"><button class="btn small ghost" data-act="new-piece-for" data-artist="${esc(a.id)}">Add a piece by ${esc(a.name)}</button></div>` : ""}
      </div>`;
  }

  function artistForm(a) {
    const isNew = !a; a = a || { agreement: "Consignment" };
    return `
      <div class="bar"><span class="k">${isNew ? "New artist" : "Editing artist"}</span><div class="acts"><button class="btn small ghost" data-act="${isNew ? "close" : "cancel-edit"}">Cancel</button></div></div>
      <h2>${isNew ? "Add an <em class='s'>artist</em>" : esc(a.name)}</h2>
      <form id="artistForm" autocomplete="off" novalidate>
        <div class="sec"><span class="k">Who</span><div class="grid2">
          ${field("name", "Name", a.name, { req: true })}
          ${field("studio", "Studio", a.studio)}
          ${field("location", "Based in", a.location)}
          ${field("agreement", "Usual agreement", a.agreement, { options: ["Consignment", "Acquisition", "Both"] })}
        </div></div>
        <div class="sec"><span class="k">Contact</span><div class="grid2">
          ${field("email", "Email", a.email, { type: "email" })}
          ${field("phone", "Phone", a.phone, { type: "tel" })}
          ${field("website", "Website", a.website)}
          ${field("instagram", "Instagram", a.instagram, { ph: "@handle" })}
        </div></div>
        <div class="sec"><span class="k">Files</span><div class="grid2">
          ${field("filesUrl", "Artist folder link (Dropbox, Drive)", a.filesUrl, { full: true, ph: "https://www.dropbox.com/..." })}
        </div><div class="hint">Keep bios, images, signed agreements and care sheets in this folder.</div></div>
        <div class="sec"><span class="k">Bio and notes</span><div class="grid2">
          ${field("bio", "Bio", a.bio, { type: "textarea", full: true })}
          ${field("notes", "Notes", a.notes, { type: "textarea", full: true })}
        </div></div>
        <div class="form-acts">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${isNew ? "" : S.confirmDelete ? `<span class="err">Delete this artist? Their pieces stay.</span><button type="button" class="btn small danger" data-act="delete-artist">Delete</button><button type="button" class="btn small ghost" data-act="keep">Keep</button>` : `<button type="button" class="btn small danger" data-act="ask-delete">Delete artist</button>`}</div>
          <div style="display:flex;gap:8px;align-items:center"><span class="err" id="formErr"></span><button type="submit" class="btn">${isNew ? "Add artist" : "Save changes"}</button></div>
        </div>
      </form>`;
  }

  // ---------- saving ----------
  const clean = (o) => { const r = {}; for (const [k, v] of Object.entries(o)) if (v !== undefined) r[k] = v; return r; };

  async function savePiece(form) {
    const P = S.panel, old = P.id ? S.pieces.find((x) => x.id === P.id) : null;
    const fd = new FormData(form), g = (k) => String(fd.get(k) ?? "").trim();
    if (!g("title")) { $("#formErr").textContent = "Add a title to save."; $("#f-title").focus(); return; }
    let artistId = g("artistId");
    if (artistId === "__new") {
      const nm = g("newArtist");
      if (!nm) { $("#formErr").textContent = "Name the new artist."; return; }
      artistId = "a-" + uid();
      if (!(await write("artists/" + artistId, { name: nm, agreement: g("agreement"), createdAt: new Date().toISOString() }))) return;
    }
    const numOrNull = (k) => (g(k) === "" ? null : n(g(k)));
    const payments = [...form.querySelectorAll("[data-pay]")].map((row) => {
      const v = (s) => row.querySelector(`[name="${s}"]`);
      const paid = v("pp").checked;
      return { id: row.dataset.pay, label: v("pl").value.trim(), amount: v("pa").value === "" ? 0 : n(v("pa").value), due: v("pd").value, paid, paidDate: paid ? v("ppd").value || today() : "" };
    }).filter((x) => x.label || x.amount || x.due);
    const data = {
      ...(old || {}),
      title: g("title"), artistId, category: g("category"), status: g("status"), sku: g("sku"), year: g("year"), edition: g("edition"),
      materials: g("materials"), dimensions: g("dimensions"), location: g("location"),
      agreement: g("agreement"), artistSplit: numOrNull("artistSplit"), cost: numOrNull("cost"), price: numOrNull("price"),
      salePrice: numOrNull("salePrice"), shipping: numOrNull("shipping"), soldDate: g("soldDate"), buyer: g("buyer"),
      receivedDate: g("receivedDate"), expectedDate: g("expectedDate"), followUpDate: g("followUpDate"), followUpNote: g("followUpNote"),
      followUpDone: old && old.followUpDate === g("followUpDate") ? !!old.followUpDone : false,
      agreementDate: g("agreementDate"), agreementUrl: g("agreementUrl"),
      consignEnd: g("consignEnd") || (g("agreement") !== "Acquisition" && (g("agreementDate") || g("receivedDate")) ? addMonths(g("agreementDate") || g("receivedDate"), n(setting("consignMonths"))) : ""),
      insuranceValue: numOrNull("insuranceValue"), condition: g("condition"), conditionDate: g("conditionDate"), conditionNotes: g("conditionNotes"),
      filesUrl: g("filesUrl"), notes: g("notes"), payments, photos: S.formPhotos || [],
      updatedAt: new Date().toISOString(),
    };
    delete data.id;
    if (!old) data.createdAt = data.updatedAt;
    const id = P.id || "p-" + uid();
    const btn = form.querySelector('[type="submit"]'); btn.disabled = true;
    if (await write("pieces/" + id, clean(data), old ? "Saved" : "Piece added")) { S.panel = { type: "piece", id, mode: "view", saved: Date.now() }; renderPanel(); }
    else btn.disabled = false;
  }

  async function saveArtist(form) {
    const P = S.panel, old = P.id ? S.artists.find((x) => x.id === P.id) : null;
    const fd = new FormData(form), g = (k) => String(fd.get(k) ?? "").trim();
    if (!g("name")) { $("#formErr").textContent = "Add a name to save."; return; }
    const data = { ...(old || {}) };
    for (const k of ["name", "studio", "location", "agreement", "email", "phone", "website", "instagram", "filesUrl", "bio", "notes"]) data[k] = g(k);
    delete data.id; data.updatedAt = new Date().toISOString(); if (!old) data.createdAt = data.updatedAt;
    const id = P.id || "a-" + uid();
    if (await write("artists/" + id, data, old ? "Saved" : "Artist added")) { S.panel = { type: "artist", id, mode: "view", saved: Date.now() }; renderPanel(); }
  }

  async function markPaid(pid, payId) {
    const p = S.pieces.find((x) => x.id === pid); if (!p) return;
    const data = { ...p }; delete data.id;
    data.payments = (p.payments || []).map((x) => (x.id === payId ? { ...x, paid: true, paidDate: today() } : x));
    await write("pieces/" + pid, data, "Marked paid");
  }
  async function followDone(pid) {
    const p = S.pieces.find((x) => x.id === pid); if (!p) return;
    const data = { ...p, followUpDone: true }; delete data.id;
    await write("pieces/" + pid, data, "Follow-up cleared");
  }

  async function uploadPhotos(files) {
    if (!S.assets || !files.length) return;
    const lab = $("#uplLabel"); if (lab) lab.firstChild.textContent = "Uploading...";
    for (const f of files) {
      try { const r = await S.assets.upload(f); S.formPhotos.push(r.id); }
      catch (e) { toast(e && e.code === "unsupported_type" ? "That file type can't be stored. Use JPG, PNG or WebP." : "A photo didn't upload. Try a smaller image."); }
    }
    $("#photoEdit").innerHTML = photoTiles();
  }

  async function exportCsv() {
    const cols = ["sku", "title", "artist", "category", "status", "agreement", "artistSplit", "cost", "price", "salePrice", "shipping", "soldDate", "materials", "dimensions", "year", "edition", "receivedDate", "agreementDate", "agreementUrl", "insuranceValue", "condition", "conditionNotes", "owed", "nextDate", "filesUrl"];
    const q = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const rows = filtered().map((p) => cols.map((c) => q(c === "artist" ? artistName(p) : c === "owed" ? unpaid(p).reduce((s, x) => s + n(x.amount), 0) : c === "nextDate" ? nextDate(p) : p[c])).join(","));
    try { await S.downloads.save({ filename: `twelve-objects-inventory-${today()}.csv`, data: [cols.join(","), ...rows].join("\n") }); }
    catch (e) { if (e && e.code !== "cancelled") toast("The export didn't save."); }
  }

  async function clearSamples() {
    const ps = S.pieces.filter((p) => p.sample), as = S.artists.filter((a) => a.sample);
    try {
      for (const p of ps) await S.db.doc("pieces/" + p.id).delete();
      for (const a of as) await S.db.doc("artists/" + a.id).delete();
      for (const i of S.invoices.filter((x) => x.sample)) await S.db.doc("invoices/" + i.id).delete();
      for (const c of S.clients.filter((x) => x.sample)) await S.db.doc("clients/" + c.id).delete();
      toast("Samples removed");
    } catch (e) { toast("Couldn't remove the samples. Try again."); }
  }

  // ---------- invoices ----------
  const INV_DEFAULTS = {
    taxRate: 9.75,
    payment: "Payment by wire transfer or check payable to XIIO, LLC. Wire details are provided on request.",
    terms: "Title passes to the buyer on receipt of full payment. Pieces are released for delivery once payment clears.",
    dueDays: 14,
    consignMonths: 12,
  };
  const setting = (k) => (has(S.settings[k]) ? S.settings[k] : INV_DEFAULTS[k]);
  const usd2 = (v) => "$" + n(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const cents = (v) => Math.round(v * 100) / 100;

  function invTotals(inv) {
    const sub = cents((inv.items || []).reduce((s, i) => s + n(i.price), 0));
    const disc = Math.min(sub, cents(n(inv.discount) + sub * n(inv.discountPct) / 100));
    const ship = n(inv.shipping);
    const taxable = inv.taxExempt ? 0 : sub - disc + (inv.taxShipping ? ship : 0);
    const tax = Math.round(taxable * n(inv.taxRate)) / 100;
    const total = cents(sub - disc + ship + tax);
    const paid = cents((inv.received || []).reduce((s, r) => s + n(r.amount), 0));
    const deposit = inv.terms === "deposit" ? Math.round(total * n(inv.depositPct || 50)) / 100 : total;
    return { sub, disc, ship, tax, total, paid, balance: Math.max(0, cents(total - paid)), deposit };
  }
  function invStatus(inv) {
    const t = invTotals(inv);
    if (inv.voided) return "Void";
    if (isQuote(inv)) return inv.convertedTo ? "Accepted" : inv.sent && inv.dueDate && inv.dueDate < today() ? "Expired" : inv.sent ? "Sent" : "Draft";
    if (t.total > 0 && t.paid >= t.total) return "Paid";
    if (t.paid > 0) return "Partially paid";
    return inv.sent ? "Sent" : "Draft";
  }
  const INV_CLS = { Draft: "st-hold", Sent: "st-incoming", "Partially paid": "st-incoming", Paid: "st-gallery", Void: "st-returned", Accepted: "st-gallery", Expired: "st-returned" };
  const invPill = (inv) => { const s = invStatus(inv); return `<span class="pill ${INV_CLS[s]}">${esc(s)}</span>`; };
  const clientName = (inv) => inv.client?.company || inv.client?.name || "No client";
  const openInvoices = () => S.invoices.filter((i) => !isQuote(i) && ["Sent", "Partially paid"].includes(invStatus(i)));
  const discLabel = (inv) => (n(inv.discountPct) ? `Discount (${n(inv.discountPct)}% trade${n(inv.discount) ? " plus " + usd2(inv.discount) : ""})` : "Discount");
  const invoiceForPiece = (pid) => S.invoices.find((i) => !i.voided && !isQuote(i) && (i.items || []).some((x) => x.pieceId === pid));

  function nextInvNumber(type = "invoice") {
    const yr = new Date().getFullYear(), pre = type === "quote" ? "TO-Q-" : "TO-INV-";
    const max = S.invoices.reduce((m, i) => { const k = new RegExp(pre + yr + "-(\\d+)").exec(i.number || ""); return k ? Math.max(m, +k[1]) : m; }, 0);
    return `${pre}${yr}-${String(max + 1).padStart(3, "0")}`;
  }

  function itemFromPiece(p) {
    const details = [p.year, p.materials, p.dimensions, p.edition].filter(Boolean).join(", ");
    return { pieceId: p.id, title: p.title || "Untitled", artist: artistName(p), details, sku: p.sku || "", price: n(p.price) };
  }

  function viewInvoices() {
    const yr = String(new Date().getFullYear());
    const quotes = S.invTab === "quotes";
    const list = S.invoices.filter((i) => quotes === isQuote(i)).sort((a, b) => String(b.number).localeCompare(String(a.number)));
    const outstanding = openInvoices().reduce((s, i) => s + invTotals(i).balance, 0);
    const paidYr = S.invoices.filter((i) => !i.voided).reduce((s, i) => s + (i.received || []).filter((r) => (r.date || "").startsWith(yr)).reduce((a, r) => a + n(r.amount), 0), 0);
    const drafts = S.invoices.filter((i) => !isQuote(i) && invStatus(i) === "Draft").length;
    const rows = list.map((i) => {
      const t = invTotals(i), st = invStatus(i), late = ["Sent", "Partially paid"].includes(st) && i.dueDate && i.dueDate < today();
      return `<tr class="click" data-open-invoice="${esc(i.id)}" tabindex="0">
        <td class="num">${esc(i.number)}</td><td><span class="tt">${esc(clientName(i))}</span>${i.sample ? `<span class="sample">Sample</span>` : ""}</td>
        <td>${(i.items || []).map((x) => esc(x.title)).join(", ")}</td>
        <td class="num">${fdate(i.date)}</td><td class="num" style="${late ? "color:var(--red)" : ""}">${["Sent", "Partially paid"].includes(st) ? fdate(i.dueDate) : ""}</td>
        <td class="r">${usd2(t.total)}</td><td class="r" style="${t.balance && !isQuote(i) && st !== "Void" && st !== "Draft" ? "color:var(--orange)" : ""}">${st === "Void" || isQuote(i) ? "" : usd2(t.balance)}</td><td>${invPill(i)}</td></tr>`;
    }).join("");
    return `
      <div class="head"><h1><em class="s">Invoices</em></h1>
        <div class="tools">${S.downloads ? `<button class="btn ghost" data-act="export-invoices">Export CSV</button>` : ""}${S.canWrite ? `<button class="btn ghost" data-act="inv-settings">Settings</button><button class="btn ghost" data-act="new-quote">New quote</button><button class="btn" data-act="new-invoice">New invoice</button>` : ""}</div></div>
      <div class="figures" style="grid-template-columns:repeat(3,minmax(0,1fr))">
        <div class="owed"><span class="k">Outstanding</span><div class="v num">${usd(outstanding, { zero: 1 })}</div><div class="sub">${openInvoices().length} open ${openInvoices().length === 1 ? "invoice" : "invoices"}</div></div>
        <div><span class="k">Received ${yr}</span><div class="v num">${usd(paidYr, { zero: 1 })}</div><div class="sub">payments recorded this year</div></div>
        <div><span class="k">Drafts</span><div class="v num">${drafts}</div><div class="sub">not yet sent</div></div>
      </div>
      <div class="filters"><div class="seg" style="margin-left:0" role="group" aria-label="Invoices or quotes"><button aria-pressed="${!quotes}" data-inv-tab="invoices">Invoices</button><button aria-pressed="${quotes}" data-inv-tab="quotes">Quotes</button></div></div>
      ${list.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Number</th><th>Client</th><th>Pieces</th><th>Date</th><th>${quotes ? "Valid until" : "Due"}</th><th class="r">Total</th><th class="r">Balance</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<div class="empty-line">${quotes ? "No quotes yet. A quote turns into an invoice in one tap once the client agrees." : "No invoices yet. Start one here, or from any piece with Create invoice."}</div>`}`;
  }

  // ----- invoice detail: an on-screen copy of the document -----
  function invoiceDoc(inv) {
    const t = invTotals(inv), c = inv.client || {};
    const line = (k, v, cls = "") => `<div class="iv-row ${cls}"><span>${k}</span><span class="num">${v}</span></div>`;
    return `<div class="iv-doc">
      <div class="iv-top">${LOGO}<span class="serif">Twelve Objects</span></div>
      <div class="iv-head"><h3><em class="s">${isQuote(inv) ? "Quote" : "Invoice"}</em></h3><dl><dt>No.</dt><dd>${esc(inv.number)}</dd><dt>Date</dt><dd>${fdate(inv.date)}</dd><dt>${isQuote(inv) ? "Valid until" : "Due"}</dt><dd>${fdate(inv.dueDate)}</dd></dl></div>
      <div class="iv-parties"><div><span class="k">Billed to</span>${[c.name, c.company, ...(c.address || "").split("\n"), c.email, c.phone].filter(Boolean).map((x) => `<div>${esc(x)}</div>`).join("") || "<div>Client not set</div>"}</div>
        <div><span class="k">From</span><div>XIIO, LLC, doing business as Twelve Objects</div><div>8906 Olympic Blvd</div><div>Beverly Hills, CA 90211</div><div>cs@twelveobjects.com · 424.279.5683</div></div></div>
      <div class="iv-items">${(inv.items || []).map((x) => { const p = S.pieces.find((q) => q.id === x.pieceId);
        return `<div class="iv-item">${p ? `<div class="iv-th">${tile(p)}</div>` : `<div></div>`}<div style="min-width:0"><div class="serif" style="font-size:16px">${esc(x.title)}</div><div class="iv-sm">${esc(x.artist)}</div><div class="iv-sm">${esc([x.details, x.sku].filter(Boolean).join(" · "))}</div></div><div class="num">${usd2(x.price)}</div></div>`; }).join("") || `<div class="empty-line">No pieces on this invoice.</div>`}</div>
      <div class="iv-totals">
        ${line("Subtotal", usd2(t.sub))}${t.disc ? line(discLabel(inv), "−" + usd2(t.disc)) : ""}${t.ship ? line("Shipping and crating", usd2(t.ship)) : ""}
        ${inv.taxExempt ? line("Sales tax", "Exempt" + (inv.taxNote ? ", " + esc(inv.taxNote) : "")) : line(`Sales tax (${n(inv.taxRate)}%)`, usd2(t.tax))}
        ${line("Total", usd2(t.total), "big")}${t.paid ? line("Paid to date", "−" + usd2(t.paid)) : ""}
        ${inv.terms === "deposit" && !t.paid ? line(`Deposit due now (${n(inv.depositPct || 50)}%)`, usd2(t.deposit)) : ""}
        ${isQuote(inv) ? "" : line("Balance due", usd2(t.balance), "due")}
      </div>
      <div class="iv-foot"><div><span class="k">Payment</span><p>${esc(inv.paymentNote || setting("payment"))}</p></div><div><span class="k">Terms</span><p>${esc(inv.termsNote || setting("terms"))}</p>${inv.notes ? `<p>${esc(inv.notes)}</p>` : ""}</div></div>
    </div>`;
  }

  function invoiceDetail(inv) {
    const t = invTotals(inv), st = invStatus(inv);
    const recv = (inv.received || []).map((r) => `<tr><td>${fdate(r.date)}</td><td>${esc(r.method || "")}</td><td class="r">${usd2(r.amount)}</td></tr>`).join("");
    const payForm = S.invPayOpen ? `<form id="invPayForm" class="grid3" style="padding-top:12px" novalidate>
        ${field("payAmount", "Amount received", inv.terms === "deposit" && !t.paid ? t.deposit : t.balance, { type: "number" })}
        ${field("payDate", "Date", today(), { type: "date" })}
        ${field("payMethod", "Method", "Wire", { options: ["Wire", "Check", "Card", "ACH", "Cash", "Other"] })}
        <div class="full" style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn small ghost" data-act="inv-pay-cancel">Cancel</button><button type="submit" class="btn small">Save payment</button></div></form>` : "";
    const can = S.canWrite && st !== "Void";
    return `
      <div class="bar"><span class="k">${esc(inv.number)} · ${invPill(inv)}</span>
        <div class="acts">${can && st !== "Paid" && st !== "Accepted" ? `<button class="btn small" data-act="edit">Edit</button>` : ""}<button class="btn small lime" data-act="inv-pdf">Download PDF</button><button class="btn small ghost" data-act="close">Close</button></div></div>
      ${(() => { const cl = S.clients.find((x) => x.id === inv.clientId); return cl ? `<div class="by">For <button class="linkish" style="font-size:14px" data-open-client="${esc(cl.id)}">${esc(clientLabel(cl))}</button></div>` : ""; })()}
      ${inv.convertedTo ? `<div class="by">Accepted. <button class="linkish" style="font-size:14px" data-open-invoice="${esc(inv.convertedTo)}">Open the invoice</button></div>` : ""}
      ${inv.fromQuote ? `<div class="by">Made from <button class="linkish" style="font-size:14px" data-open-invoice="${esc(inv.fromQuote)}">${esc((S.invoices.find((x) => x.id === inv.fromQuote) || {}).number || "a quote")}</button></div>` : ""}
      ${invoiceDoc(inv)}
      ${can ? `<div class="iv-actions">
        ${st === "Draft" ? `<button class="btn small" data-act="inv-sent">Mark as sent</button>` : ""}
        ${isQuote(inv) && !inv.convertedTo ? `<button class="btn small lime" data-act="quote-convert">Convert to invoice</button>` : ""}
        ${!isQuote(inv) && st !== "Paid" ? `<button class="btn small ghost" data-act="inv-pay-open">Record payment</button>` : ""}
        ${!isQuote(inv) && st !== "Paid" && t.balance > 0 ? `<button class="btn small ghost" data-act="inv-paid-full">Paid in full</button>` : ""}
        ${st !== "Paid" && st !== "Accepted" ? (S.confirmDelete ? `<span class="err">${isQuote(inv) ? "Void this quote?" : "Void this invoice and release its pieces?"}</span><button class="btn small danger" data-act="inv-void">Void</button><button class="btn small ghost" data-act="keep-inv">Keep</button>` : `<button class="btn small danger" data-act="inv-ask-void">Void</button>`) : ""}
      </div>` : ""}
      ${payForm}
      ${recv ? `<div class="sec" style="margin-top:18px"><span class="k">Payments received</span><table class="pays">${recv}</table></div>` : ""}
      ${st === "Paid" ? `<div class="hint">Paid in full. Its pieces are marked Sold, and payouts for consigned pieces are scheduled 30 days out.</div>` : ""}`;
  }

  // ----- invoice editor -----
  function invoiceForm(inv) {
    const isNew = !inv?.id;
    inv = inv || {};
    const quote = isQuote(inv), noun = quote ? "quote" : "invoice";
    if (!S.invDraft) S.invDraft = (inv.items || []).map((x) => ({ ...x }));
    const c = inv.client || {};
    const busy = new Set(S.invoices.filter((i) => !i.voided && !isQuote(i) && i.id !== inv.id).flatMap((i) => (i.items || []).map((x) => x.pieceId)));
    const avail = S.pieces.filter((p) => !["Sold", "Returned"].includes(p.status) && !busy.has(p.id) && !S.invDraft.some((x) => x.pieceId === p.id));
    return `
      <div class="bar"><span class="k">${isNew ? "New " + noun : "Editing " + esc(inv.number)}</span><div class="acts"><button class="btn small ghost" data-act="${isNew ? "close" : "cancel-edit"}">Cancel</button></div></div>
      <h2>${isNew ? `New <em class='s'>${noun}</em>` : esc(inv.number)}</h2>
      <form id="invoiceForm" autocomplete="off" novalidate>
        <div class="sec"><span class="k">Client</span><div class="grid2">
          ${field("clientId", "Saved client", inv.clientId || "", { full: true, options: [["", "New client, fill in below"], ...S.clients.map((x) => [x.id, clientLabel(x)])] })}
          ${field("clientName", "Name", c.name, { req: true })}
          ${field("clientCompany", "Company", c.company)}
          ${field("clientEmail", "Email", c.email, { type: "email" })}
          ${field("clientPhone", "Phone", c.phone, { type: "tel" })}
          ${field("clientAddress", "Billing and delivery address", c.address, { type: "textarea", full: true })}
        </div><div class="hint">New clients are saved to Clients when you save the invoice.</div></div>

        <div class="sec"><span class="k">Pieces</span>
          <div id="invItems">${invItemsHtml()}</div>
          <div class="grid2" style="align-items:end">
            <label class="f">Add a piece<select id="invAddPiece"><option value="">Choose from inventory</option>${avail.map((p) => `<option value="${esc(p.id)}">${esc(p.title)}, ${esc(artistName(p))}${has(p.price) ? ", " + usd(p.price) : ""}</option>`).join("")}</select></label>
            <div><button type="button" class="btn small ghost" data-act="inv-add-piece">Add to invoice</button></div>
          </div>
        </div>

        <div class="sec"><span class="k">Charges</span><div class="grid3">
          ${field("discountPct", "Trade discount %", inv.discountPct, { type: "number" })}
          ${field("discount", "Extra discount ($)", inv.discount, { type: "number" })}
          ${field("shipping", "Shipping and crating", inv.shipping, { type: "number" })}
          ${field("taxRate", "Sales tax %", has(inv.taxRate) ? inv.taxRate : setting("taxRate"), { type: "number" })}
          <label class="chk-row"><input type="checkbox" id="f-taxExempt" name="taxExempt"${inv.taxExempt ? " checked" : ""}> Tax exempt</label>
          ${field("taxNote", "Exemption reason", inv.taxNote, { ph: "Resale certificate, out-of-state delivery" })}
          <label class="chk-row"><input type="checkbox" id="f-taxShipping" name="taxShipping"${inv.taxShipping ? " checked" : ""}> Tax shipping too</label>
        </div></div>

        <div class="sec"><span class="k">Dates and terms</span><div class="grid3">
          ${field("number", quote ? "Quote number" : "Invoice number", inv.number || nextInvNumber(noun))}<input type="hidden" name="docType" value="${noun}">
          ${field("date", "Invoice date", inv.date || today(), { type: "date" })}
          ${field("dueDate", quote ? "Valid until" : "Due date", inv.dueDate || addDays(today(), quote ? 30 : n(setting("dueDays"))), { type: "date" })}
          ${field("terms", "Payment", inv.terms || "full", { options: [["full", "Paid in full"], ["deposit", "Deposit, then balance"]] })}
          ${field("depositPct", "Deposit %", inv.depositPct ?? 50, { type: "number" })}
        </div></div>

        <div class="sec"><span class="k">Notes on the invoice</span><div class="grid2">
          ${field("paymentNote", "Payment instructions", inv.paymentNote || setting("payment"), { type: "textarea", full: true })}
          ${field("termsNote", "Terms", inv.termsNote || setting("terms"), { type: "textarea", full: true })}
          ${field("notes", "Note to client (optional)", inv.notes, { type: "textarea", full: true })}
        </div></div>

        <div class="iv-live" id="invLive">${invLiveHtml(inv)}</div>

        <div class="form-acts">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${!isNew && invStatus(inv) === "Draft" ? (S.confirmDelete ? `<span class="err">Delete this draft?</span><button type="button" class="btn small danger" data-act="inv-delete">Delete</button><button type="button" class="btn small ghost" data-act="keep-inv">Keep</button>` : `<button type="button" class="btn small danger" data-act="inv-ask-delete">Delete draft</button>`) : ""}</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="err" id="formErr"></span><button type="submit" class="btn">${isNew ? "Create " + noun : "Save " + noun}</button></div>
        </div>
      </form>`;
  }
  function invItemsHtml() {
    if (!S.invDraft.length) return `<div class="empty-line" style="padding:12px 0">No pieces yet. Add one below.</div>`;
    return S.invDraft.map((x, k) => `<div class="iv-edit-row"><div style="min-width:0"><div class="serif" style="font-size:15px">${esc(x.title)}</div><div class="iv-sm">${esc(x.artist)}${x.sku ? " · " + esc(x.sku) : ""}</div></div>
      <label class="f">Price<input type="number" step="any" inputmode="decimal" data-inv-price="${k}" value="${esc(x.price)}"></label>
      <button type="button" class="x" data-inv-rm="${k}" aria-label="Remove ${esc(x.title)}">×</button></div>`).join("");
  }
  function readInvForm(form) {
    const fd = new FormData(form), g = (k) => String(fd.get(k) ?? "").trim();
    return {
      clientId: g("clientId"), docType: g("docType") || "invoice", discountPct: n(g("discountPct")),
      client: { name: g("clientName"), company: g("clientCompany"), email: g("clientEmail"), phone: g("clientPhone"), address: g("clientAddress") },
      items: S.invDraft.map((x) => ({ ...x, price: n(x.price) })),
      discount: n(g("discount")), shipping: n(g("shipping")), taxRate: n(g("taxRate")),
      taxExempt: fd.get("taxExempt") === "on", taxNote: g("taxNote"), taxShipping: fd.get("taxShipping") === "on",
      number: g("number"), date: g("date"), dueDate: g("dueDate"), terms: g("terms"), depositPct: n(g("depositPct")) || 50,
      paymentNote: g("paymentNote"), termsNote: g("termsNote"), notes: g("notes"),
    };
  }
  function invLiveHtml(inv) {
    const t = invTotals(inv);
    return `<div class="iv-row"><span>Subtotal</span><span class="num">${usd2(t.sub)}</span></div>
      ${t.disc ? `<div class="iv-row"><span>${discLabel(inv)}</span><span class="num">−${usd2(t.disc)}</span></div>` : ""}
      ${t.ship ? `<div class="iv-row"><span>Shipping and crating</span><span class="num">${usd2(t.ship)}</span></div>` : ""}
      <div class="iv-row"><span>Sales tax${inv.taxExempt ? ", exempt" : ` (${n(inv.taxRate)}%)`}</span><span class="num">${usd2(t.tax)}</span></div>
      <div class="iv-row big"><span>Total</span><span class="num">${usd2(t.total)}</span></div>
      ${inv.terms === "deposit" ? `<div class="iv-row"><span>Deposit (${n(inv.depositPct || 50)}%)</span><span class="num">${usd2(t.deposit)}</span></div>` : ""}`;
  }
  function refreshInvLive() { const f = $("#invoiceForm"); if (f) $("#invLive").innerHTML = invLiveHtml(readInvForm(f)); }

  async function saveInvoice(form) {
    const P = S.panel, old = P.id ? S.invoices.find((x) => x.id === P.id) : null;
    const data = readInvForm(form);
    if (!data.client.name) { $("#formErr").textContent = "Add the client's name."; $("#f-clientName").focus(); return; }
    if (!data.items.length) { $("#formErr").textContent = "Add at least one piece."; return; }
    const btn0 = form.querySelector('[type="submit"]'); btn0.disabled = true;
    data.clientId = await ensureClient(data);
    btn0.disabled = false;
    const full = { ...(old || {}), ...data, updatedAt: new Date().toISOString() };
    delete full.id;
    if (!old) { full.createdAt = full.updatedAt; full.received = []; full.sent = false; }
    const id = P.id || "inv-" + uid();
    const btn = form.querySelector('[type="submit"]'); btn.disabled = true;
    if (await write("invoices/" + id, clean(full), (isQuote(full) ? "Quote" : "Invoice") + (old ? " saved" : " created"))) {
      S.invDraft = null; S.panel = { type: "invoice", id, mode: "view", saved: Date.now() }; renderPanel();
      if (full.sent && !isQuote(full)) await holdPieces({ ...full, id });
    } else btn.disabled = false;
  }

  async function savePiece2(p) { const d = { ...p, updatedAt: new Date().toISOString() }; delete d.id; return write("pieces/" + p.id, clean(d)); }

  // Sent: reserve the pieces. Void: release them.
  async function holdPieces(inv) {
    for (const x of inv.items || []) {
      const p = S.pieces.find((q) => q.id === x.pieceId);
      if (p && p.status === "In gallery") await savePiece2({ ...p, status: "On hold", holdInvoice: inv.id });
    }
  }
  async function releasePieces(inv) {
    for (const x of inv.items || []) {
      const p = S.pieces.find((q) => q.id === x.pieceId);
      if (p && p.status === "On hold" && p.holdInvoice === inv.id) await savePiece2({ ...p, status: "In gallery", holdInvoice: "" });
    }
  }
  // Paid in full: each piece is sold at its share of the invoice (after discount), and consigned pieces get their artist payout.
  async function completeSale(inv) {
    const t = invTotals(inv), soldDate = (inv.received || []).map((r) => r.date).sort().pop() || today();
    for (const x of inv.items || []) {
      const p = S.pieces.find((q) => q.id === x.pieceId);
      if (!p || p.status === "Sold") continue;
      const sale = cents(n(x.price) - (t.sub ? t.disc * n(x.price) / t.sub : 0));
      const next = { ...p, status: "Sold", salePrice: sale, soldDate, buyer: inv.client?.company || inv.client?.name || "", invoiceId: inv.id, holdInvoice: "" };
      if (next.agreement !== "Acquisition" && !(next.payments || []).some((y) => y.auto === "payout")) {
        const split = has(next.artistSplit) ? n(next.artistSplit) : 50;
        next.payments = [...(next.payments || []), { id: uid(), auto: "payout", label: `Artist payout, ${split}% of sale`, amount: calc(next).artistShare, due: addDays(soldDate, 30), paid: false, paidDate: "" }];
      }
      await savePiece2(next);
    }
  }

  async function invUpdate(inv, patch, msg) {
    const next = { ...inv, ...patch, updatedAt: new Date().toISOString() }; delete next.id;
    const ok = await write("invoices/" + inv.id, clean(next), msg);
    return ok ? { ...next, id: inv.id } : null;
  }
  async function recordPayment(inv, amount, date, method) {
    if (!(amount > 0)) { toast("Enter the amount received."); return; }
    const before = invStatus(inv);
    const next = await invUpdate(inv, { sent: true, received: [...(inv.received || []), { id: uid(), amount: cents(amount), date, method }] }, "Payment recorded");
    if (!next) return;
    S.invPayOpen = false;
    if (before === "Draft") await holdPieces(next);
    if (invStatus(next) === "Paid") { await completeSale(next); toast("Paid in full. Pieces marked sold."); }
    renderPanel();
  }

  function settingsForm() {
    return `
      <div class="bar"><span class="k">Invoice settings</span><div class="acts"><button class="btn small ghost" data-act="close">Cancel</button></div></div>
      <h2>Invoice <em class="s">settings</em></h2>
      <form id="settingsForm" novalidate><div class="sec"><span class="k">Defaults for new invoices</span><div class="grid2">
        ${field("taxRate", "Sales tax %", setting("taxRate"), { type: "number" })}
        ${field("dueDays", "Days until an invoice is due", setting("dueDays"), { type: "number" })}
        ${field("consignMonths", "Consignment term (months)", setting("consignMonths"), { type: "number" })}
        ${field("payment", "Payment instructions", setting("payment"), { type: "textarea", full: true })}
        ${field("terms", "Terms", setting("terms"), { type: "textarea", full: true })}
      </div><div class="hint">Confirm the sales tax rate with your accountant. Existing invoices keep the rate they were made with.</div></div>
      <div class="form-acts"><span></span><button type="submit" class="btn">Save settings</button></div></form>`;
  }
  async function saveSettings(form) {
    const fd = new FormData(form), g = (k) => String(fd.get(k) ?? "").trim();
    const data = { ...S.settings, taxRate: n(g("taxRate")), dueDays: n(g("dueDays")) || 14, consignMonths: n(g("consignMonths")) || 12, payment: g("payment"), terms: g("terms") };
    if (await write("settings/gallery", data, "Settings saved")) closePanel();
  }

  // ----- PDF -----
  async function thumbData(id) {
    try {
      const r = await fetch("/_blob/" + id); if (!r.ok) return null;
      const bmp = await createImageBitmap(await r.blob());
      const k = Math.min(1, 360 / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); x.drawImage(bmp, 0, 0, c.width, c.height);
      return { url: c.toDataURL("image/jpeg", 0.85), w: c.width, h: c.height };
    } catch (e) { return null; }
  }

  // The XIIO mark, from the gallery's logo file. LOGO is for screens; pdfLogo draws the same shapes in a PDF.
  const LOGO = `<svg class="logo" viewBox="0 17.2 545.4 154.2" role="img" aria-label="XIIO"><polygon points=".45 163.69 65.86 96.03 0 27.93 6.3 21.18 72.38 89.52 142.43 17.21 148.73 23.95 78.67 96.03 144.31 163.69 138.01 170.43 72.38 102.78 6.74 170.43 .45 163.69"/><rect x="217.99" y="19.76" width="9.45" height="149.1"/><rect x="308.59" y="19.76" width="9.46" height="149.1"/><path d="M467.54,171.42c-43.92,0-78.39-34.27-78.39-77.01s34.47-77.21,78.39-77.21,77.8,32.7,77.8,77.8c0,42.55-35.25,76.43-77.8,76.43M467.54,26.06c-38.21,0-68.54,28.56-68.54,67.56,0,36.83,29.74,69.13,67.17,69.13,39.39,0,69.33-29.35,69.33-67.96s-30.73-68.74-67.95-68.74"/></svg>`;
  function pdfLogo(d, x, top, h, rgb = [22, 22, 22]) {
    const k = h / 154.2, P = (px, py) => [x + px * k, top + (py - 17.2) * k];
    d.setFillColor(...rgb); d.setDrawColor(...rgb);
    const pts = [[0.45, 163.69], [65.86, 96.03], [0, 27.93], [6.3, 21.18], [72.38, 89.52], [142.43, 17.21], [148.73, 23.95], [78.67, 96.03], [144.31, 163.69], [138.01, 170.43], [72.38, 102.78], [6.74, 170.43]].map(([a, b]) => P(a, b));
    d.lines(pts.slice(1).map((p, i) => [p[0] - pts[i][0], p[1] - pts[i][1]]), pts[0][0], pts[0][1], [1, 1], "F", true);
    d.rect(...P(217.99, 19.76), 9.45 * k, 149.1 * k, "F");
    d.rect(...P(308.59, 19.76), 9.46 * k, 149.1 * k, "F");
    d.setLineWidth(9.5 * k); d.circle(...P(467.35, 94.3), 73.2 * k, "S");
    return 545.4 * k;
  }
  async function invoicePdf(inv) {
    if (!window.jspdf) { toast("The PDF maker didn't load. Check your connection and try again."); return; }
    const d = new window.jspdf.jsPDF({ unit: "pt", format: "letter" });
    const L = 54, R = 558, INK = [22, 22, 22], SOFT = [95, 95, 88], GREEN = [23, 137, 63], LIME = [221, 231, 138], LINE = [226, 226, 218];
    const t = invTotals(inv), c = inv.client || {}, st = invStatus(inv);
    const txt = (s, x, y, o = {}) => { d.setFont(o.font || "helvetica", o.style || "normal"); d.setFontSize(o.size || 9.5); d.setTextColor(...(o.color || INK)); d.text(String(s), x, y, o.align ? { align: o.align } : undefined); };
    const rule = (y, color = INK, w = 0.75) => { d.setDrawColor(...color); d.setLineWidth(w); d.line(L, y, R, y); };
    const masthead = () => {
      const lw = pdfLogo(d, L, 42.5, 9.5);
      txt("Twelve Objects", L + lw + 14, 52, { font: "times", size: 11.5 });
      txt("Collectible Design  ·  Art + Objects", R, 52, { size: 8, color: SOFT, align: "right" });
      rule(62);
    };
    const footer = (i, total) => {
      rule(742);
      txt("XIIO, LLC dba Twelve Objects", L, 756, { size: 7.5 });
      txt("8906 Olympic Blvd, Beverly Hills, CA 90211", L + 150, 756, { size: 7.5, color: SOFT });
      const right = "cs@twelveobjects.com  ·  twelveobjects.com";
      txt(total > 1 ? `${right}  ·  ${i} of ${total}` : right, R, 756, { size: 7.5, color: SOFT, align: "right" });
    };
    masthead();
    txt(isQuote(inv) ? "Quote" : "Invoice", L, 120, { font: "times", style: "italic", size: 40, color: GREEN });
    const meta = [[isQuote(inv) ? "Quote no." : "Invoice no.", inv.number], ["Date", fdate(inv.date)], [isQuote(inv) ? "Valid until" : "Due", fdate(inv.dueDate)]];
    meta.forEach(([k, v], i) => { txt(k.toUpperCase(), 400, 92 + i * 16, { size: 7, color: SOFT }); txt(v, R, 92 + i * 16, { size: 9.5, align: "right" }); });
    if (st === "Paid" || st === "Void") { d.setFillColor(...(st === "Paid" ? LIME : [247, 205, 210])); d.rect(L + 160, 96, 64, 22, "F"); txt(st.toUpperCase(), L + 192, 111, { size: 10, style: "bold", align: "center", color: st === "Paid" ? GREEN : [216, 27, 55] }); }

    let y = 160;
    txt("BILLED TO", L, y, { size: 7, color: SOFT }); txt("FROM", 320, y, { size: 7, color: SOFT });
    const billed = [c.name, c.company, ...(c.address || "").split("\n"), c.email, c.phone].filter(Boolean);
    const from = ["XIIO, LLC, doing business as Twelve Objects", "8906 Olympic Blvd", "Beverly Hills, CA 90211", "cs@twelveobjects.com", "424.279.5683"];
    billed.forEach((s, i) => txt(s, L, y + 15 + i * 13, { size: 9.5, style: i === 0 ? "bold" : "normal" }));
    from.forEach((s, i) => txt(s, 320, y + 15 + i * 13, { size: 9.5, color: i ? SOFT : INK }));
    y += 22 + Math.max(billed.length, from.length) * 13 + 10;

    const tableHead = () => { rule(y); txt("PIECE", L, y + 14, { size: 7, color: SOFT }); txt("AMOUNT", R, y + 14, { size: 7, color: SOFT, align: "right" }); y += 24; };
    tableHead();
    const pages = [1];
    for (const x of inv.items || []) {
      const p = S.pieces.find((q) => q.id === x.pieceId);
      const img = p && (p.photos || [])[0] ? await thumbData(p.photos[0]) : null;
      const tx = img ? L + 62 : L;
      const det = d.setFont("helvetica", "normal").setFontSize(8.5).splitTextToSize([x.details, x.sku].filter(Boolean).join("  ·  "), 330);
      const h = Math.max(img ? 66 : 0, 34 + det.length * 11);
      if (y + h > 700) { d.addPage(); masthead(); y = 90; tableHead(); }
      if (img) { const k = Math.min(52 / img.w, 64 / img.h); d.addImage(img.url, "JPEG", L, y - 2, img.w * k, img.h * k); }
      txt(x.title, tx, y + 10, { font: "times", size: 13 });
      txt(x.artist, tx, y + 24, { size: 9, color: SOFT });
      d.setTextColor(...SOFT); d.text(det, tx, y + 36);
      txt(usd2(x.price), R, y + 10, { size: 10, align: "right" });
      y += h; rule(y - 6, LINE, 0.5);
    }

    const rows = [["Subtotal", usd2(t.sub)]];
    if (t.disc) rows.push([discLabel(inv), "-" + usd2(t.disc)]);
    if (t.ship) rows.push(["Shipping and crating", usd2(t.ship)]);
    rows.push(inv.taxExempt ? ["Sales tax", "Exempt" + (inv.taxNote ? ", " + inv.taxNote : "")] : [`Sales tax (${n(inv.taxRate)}%)`, usd2(t.tax)]);
    const after = [];
    if (t.paid) after.push(["Paid to date", "-" + usd2(t.paid)]);
    if (inv.terms === "deposit" && !t.paid) after.push([`Deposit due now (${n(inv.depositPct || 50)}%)`, usd2(t.deposit)]);
    const need = (rows.length + after.length) * 17 + 70 + 120;
    if (y + need > 720) { d.addPage(); masthead(); y = 90; }
    y += 8;
    const TX = 340;
    rows.forEach(([k, v]) => { txt(k, TX, y, { size: 9.5, color: SOFT }); txt(v, R, y, { size: 9.5, align: "right" }); y += 17; });
    d.setDrawColor(...INK); d.setLineWidth(0.75); d.line(TX, y - 8, R, y - 8);
    txt("Total", TX, y + 8, { font: "times", size: 15 }); txt(usd2(t.total), R, y + 8, { font: "times", size: 15, align: "right" }); y += 26;
    after.forEach(([k, v]) => { txt(k, TX, y, { size: 9.5, color: SOFT }); txt(v, R, y, { size: 9.5, align: "right" }); y += 17; });
    if (!isQuote(inv)) {
      d.setFillColor(...LIME); d.rect(TX - 6, y - 12, R - TX + 12, 20, "F");
      txt("Balance due", TX, y + 2, { size: 10, style: "bold" }); txt(usd2(t.balance), R, y + 2, { size: 10, style: "bold", align: "right" });
    }
    y += 36;

    const block = (label, body) => {
      if (!body) return;
      const lines = d.setFont("helvetica", "normal").setFontSize(9).splitTextToSize(body, R - L);
      if (y + 16 + lines.length * 12 > 730) { d.addPage(); masthead(); y = 90; }
      rule(y, LINE, 0.5); txt(label.toUpperCase(), L, y + 14, { size: 7, color: SOFT });
      d.setTextColor(...INK); d.text(lines, L, y + 28); y += 36 + lines.length * 12;
    };
    block("Payment", inv.paymentNote || setting("payment"));
    block("Terms", inv.termsNote || setting("terms"));
    block("Note", inv.notes);

    const total = d.getNumberOfPages();
    for (let i = 1; i <= total; i++) { d.setPage(i); footer(i, total); }
    const name = `${inv.number}_${(clientName(inv)).replace(/[^A-Za-z0-9]+/g, "-")}.pdf`;
    const blob = d.output("blob");
    if (!S.downloads) { toast("Downloads aren't available in this view."); return; }
    try { await S.downloads.save({ filename: name, data: blob }); }
    catch (e) { if (e && e.code !== "cancelled") toast("The PDF didn't save."); }
  }

  // ---------- clients ----------
  const CLIENT_TYPES = ["Collector", "Designer or trade", "Institution", "Other"];
  const sameName = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
  const forClient = (c) => S.invoices.filter((i) => i.clientId === c.id || (!i.clientId && sameName(i.client?.name, c.name)));
  const invoicesFor = (c) => S.invoices.filter((i) => !isQuote(i) && (i.clientId === c.id || (!i.clientId && sameName(i.client?.name, c.name))));
  const clientLabel = (c) => c.company ? `${c.name}, ${c.company}` : c.name;
  // Purchases count paid and partly paid invoices; voids and drafts don't.
  function clientStats(c) {
    const invs = invoicesFor(c).filter((i) => !i.voided);
    const live = invs.filter((i) => ["Paid", "Partially paid", "Sent"].includes(invStatus(i)));
    const bought = invs.filter((i) => invStatus(i) === "Paid");
    return {
      invs, count: invs.length,
      spent: bought.reduce((s, i) => s + invTotals(i).total, 0),
      paid: invs.reduce((s, i) => s + invTotals(i).paid, 0),
      open: live.reduce((s, i) => s + (invStatus(i) === "Paid" ? 0 : invTotals(i).balance), 0),
      pieces: bought.flatMap((i) => (i.items || []).map((x) => x.pieceId)).map((id) => S.pieces.find((p) => p.id === id)).filter(Boolean),
      last: invs.map((i) => i.date).filter(Boolean).sort().pop() || "",
    };
  }

  function viewClients() {
    const q = (S.clientQ || "").trim().toLowerCase();
    const list = S.clients.filter((c) => !q || [c.name, c.company, c.email, c.phone, c.address, c.type, c.interests].join(" ").toLowerCase().includes(q));
    const tools = (S.downloads && S.clients.length ? `<button class="btn ghost" data-act="export-clients">Export CSV</button>` : "") + (S.canWrite ? `<button class="btn" data-act="new-client">Add client</button>` : "");
    if (!S.clients.length) return `<div class="head"><h1><em class="s">Clients</em></h1><div class="tools">${tools}</div></div><div class="empty-line">No clients yet. Add someone you've met, or they're saved automatically the first time you invoice them.</div>`;
    const cards = list.map((c) => {
      const st = clientStats(c);
      return `<div class="artist">
        <button style="border:0;background:none;padding:0;text-align:left" data-open-client="${esc(c.id)}"><div class="nm">${esc(c.name)}${sampleTag(c)}</div></button>
        <div class="loc">${esc([c.company, c.type].filter(Boolean).join(" · ") || "Client")}</div>
        <div class="stats"><span><b>${usd(st.spent, { zero: 1 })}</b> purchased</span><span><b>${st.count}</b> ${st.count === 1 ? "invoice" : "invoices"}</span>${st.open ? `<span style="color:var(--orange)"><b>${usd(st.open)}</b> open</span>` : ""}</div>
        <div class="loc">${st.last ? "Last invoice " + fdate(st.last) : c.metDate ? "Met " + fdate(c.metDate) : esc(c.email || "")}</div>
        <div class="ft"><button class="btn small ghost" data-open-client="${esc(c.id)}">Details</button>${S.canWrite ? `<button class="btn small lime" data-act="new-invoice-client" data-client="${esc(c.id)}">New invoice</button>` : ""}</div>
      </div>`;
    }).join("");
    return `<div class="head"><h1><em class="s">Clients</em></h1><div class="tools">${tools}</div></div>
      <div class="filters"><input class="search" id="clientQ" type="search" placeholder="Search name, company, email, interests" value="${esc(S.clientQ || "")}" aria-label="Search clients"></div>
      ${list.length ? `<div class="artists">${cards}</div>` : `<div class="empty-line">No clients match that search.</div>`}`;
  }

  function clientDetail(c) {
    const st = clientStats(c);
    const facts = [["Type", c.type], ["Email", c.email], ["Phone", c.phone], ["Address", c.address], ["Instagram", c.instagram], ["Met", [fdate(c.metDate), c.source].filter(Boolean).join(", ")], ["Interests", c.interests],
      ["Trade discount", c.tradeDiscount ? c.tradeDiscount + "%" : ""], ["Resale certificate", [c.resaleCert, c.resaleExpiry && "expires " + fdate(c.resaleExpiry)].filter(Boolean).join(", ")]].filter(([, v]) => has(v));
    const rows = st.invs.sort((a, b) => String(b.date).localeCompare(String(a.date))).map((i) => `<tr class="click" data-open-invoice="${esc(i.id)}" tabindex="0"><td class="num">${esc(i.number)}</td><td class="num">${fdate(i.date)}</td><td>${(i.items || []).map((x) => esc(x.title)).join(", ")}</td><td class="r">${usd2(invTotals(i).total)}</td><td>${invPill(i)}</td></tr>`).join("");
    return `
      <div class="bar"><span class="k">Client</span><div class="acts">${S.canWrite ? `<button class="btn small ghost" data-act="new-quote-client" data-client="${esc(c.id)}">New quote</button><button class="btn small lime" data-act="new-invoice-client" data-client="${esc(c.id)}">New invoice</button><button class="btn small" data-act="edit">Edit</button>` : ""}<button class="btn small ghost" data-act="close">Close</button></div></div>
      <h2>${esc(c.name)}${sampleTag(c)}</h2>
      <div class="by">${esc([c.company, c.type].filter(Boolean).join(" · "))}</div>
      <div class="sec"><div class="money" style="grid-template-columns:repeat(3,minmax(0,1fr));border-top:1px solid var(--rule)">
        <div><span class="k">Purchased</span><div class="v">${usd(st.spent, { zero: 1 })}</div><div class="sub">paid invoices, with tax and shipping</div></div>
        <div><span class="k">Received</span><div class="v">${usd(st.paid, { zero: 1 })}</div><div class="sub">all payments to date</div></div>
        <div><span class="k">Open balance</span><div class="v" style="${st.open ? "color:var(--orange)" : ""}">${usd(st.open, { zero: 1 })}</div><div class="sub">on sent invoices</div></div>
      </div></div>
      <div class="sec"><span class="k">Details</span><dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd style="white-space:pre-line">${esc(v)}</dd>`).join("") || "<dt>Details</dt><dd>Not recorded yet</dd>"}</dl></div>
      ${c.notes ? `<div class="sec"><span class="k">Notes</span><div class="notes">${esc(c.notes)}</div></div>` : ""}
      <div class="sec"><span class="k">Invoices (${st.invs.length})</span>${rows ? `<div class="tbl-wrap" style="border-top:0"><table class="tbl" style="min-width:520px"><tbody>${rows}</tbody></table></div>` : `<div class="empty-line">No invoices yet.</div>`}</div>
      ${(() => { const qs = forClient(c).filter(isQuote); return qs.length ? `<div class="sec"><span class="k">Quotes (${qs.length})</span><div class="tbl-wrap" style="border-top:0"><table class="tbl" style="min-width:520px"><tbody>${qs.map((i) => `<tr class="click" data-open-invoice="${esc(i.id)}" tabindex="0"><td class="num">${esc(i.number)}</td><td class="num">${fdate(i.date)}</td><td>${(i.items || []).map((x) => esc(x.title)).join(", ")}</td><td class="r">${usd2(invTotals(i).total)}</td><td>${invPill(i)}</td></tr>`).join("")}</tbody></table></div></div>` : ""; })()}
      <div class="sec"><span class="k">Pieces bought (${st.pieces.length})</span>${st.pieces.length ? `<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:18px 14px;margin-top:14px">${st.pieces.map(card).join("")}</div>` : `<div class="empty-line">Nothing bought yet.</div>`}</div>`;
  }

  function clientForm(c) {
    const isNew = !c; c = c || { type: "Collector" };
    return `
      <div class="bar"><span class="k">${isNew ? "New client" : "Editing client"}</span><div class="acts"><button class="btn small ghost" data-act="${isNew ? "close" : "cancel-edit"}">Cancel</button></div></div>
      <h2>${isNew ? "Add a <em class='s'>client</em>" : esc(c.name)}</h2>
      <form id="clientForm" autocomplete="off" novalidate>
        <div class="sec"><span class="k">Who</span><div class="grid2">
          ${field("name", "Name", c.name, { req: true })}
          ${field("company", "Company or studio", c.company)}
          ${field("type", "Type", c.type, { options: CLIENT_TYPES })}
          ${field("instagram", "Instagram", c.instagram, { ph: "@handle" })}
        </div></div>
        <div class="sec"><span class="k">Contact</span><div class="grid2">
          ${field("email", "Email", c.email, { type: "email" })}
          ${field("phone", "Phone", c.phone, { type: "tel" })}
          ${field("address", "Billing and delivery address", c.address, { type: "textarea", full: true })}
        </div></div>
        <div class="sec"><span class="k">How we met</span><div class="grid2">
          ${field("metDate", "Date met", c.metDate, { type: "date" })}
          ${field("source", "Where or through whom", c.source, { ph: "Gallery visit, Design Miami, referral from..." })}
          ${field("interests", "Interests", c.interests, { full: true, ph: "Artists, categories, sizes, budget" })}
        </div></div>
        <div class="sec"><span class="k">Trade and tax</span><div class="grid2">
          ${field("resaleCert", "Resale certificate number", c.resaleCert)}
          ${field("resaleExpiry", "Certificate expires", c.resaleExpiry, { type: "date" })}
          ${field("tradeDiscount", "Trade discount %", c.tradeDiscount, { type: "number", ph: "e.g. 10 or 15" })}
        </div><div class="hint">New invoices and quotes for this client start with their trade discount, and as tax exempt while their resale certificate is valid.</div></div>
        <div class="sec"><span class="k">Notes</span><div class="grid2">${field("notes", "Notes", c.notes, { type: "textarea", full: true })}</div></div>
        <div class="form-acts">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${isNew ? "" : S.confirmDelete ? `<span class="err">Delete this client? Their invoices stay.</span><button type="button" class="btn small danger" data-act="delete-client">Delete</button><button type="button" class="btn small ghost" data-act="keep-client">Keep</button>` : `<button type="button" class="btn small danger" data-act="ask-delete-client">Delete client</button>`}</div>
          <div style="display:flex;gap:8px;align-items:center"><span class="err" id="formErr"></span><button type="submit" class="btn">${isNew ? "Add client" : "Save changes"}</button></div>
        </div>
      </form>`;
  }

  async function saveClient(form) {
    const P = S.panel, old = P.id ? S.clients.find((x) => x.id === P.id) : null;
    const fd = new FormData(form), g = (k) => String(fd.get(k) ?? "").trim();
    if (!g("name")) { $("#formErr").textContent = "Add a name to save."; return; }
    const data = { ...(old || {}) };
    for (const k of ["name", "company", "type", "instagram", "email", "phone", "address", "metDate", "source", "interests", "resaleCert", "resaleExpiry", "tradeDiscount", "notes"]) data[k] = g(k);
    delete data.id; data.updatedAt = new Date().toISOString(); if (!old) data.createdAt = data.updatedAt;
    const id = P.id || "cl-" + uid();
    if (await write("clients/" + id, data, old ? "Saved" : "Client added")) { S.panel = { type: "client", id, mode: "view", saved: Date.now() }; renderPanel(); }
  }

  // What a new invoice starts with for a saved client.
  function invoiceSeedFor(c) {
    const exempt = !!c.resaleCert && !(c.resaleExpiry && c.resaleExpiry < today());
    return { clientId: c.id, client: { name: c.name, company: c.company, email: c.email, phone: c.phone, address: c.address }, taxExempt: exempt, taxNote: exempt ? "Resale certificate " + c.resaleCert : "", discountPct: n(c.tradeDiscount) || 0 };
  }
  function fillInvoiceClient(c) {
    const f = $("#invoiceForm"); if (!f) return;
    const s = invoiceSeedFor(c), el = f.elements;
    el.clientId.value = c.id;
    el.clientName.value = c.name || ""; el.clientCompany.value = c.company || ""; el.clientEmail.value = c.email || ""; el.clientPhone.value = c.phone || ""; el.clientAddress.value = c.address || "";
    if (s.taxExempt) { el.taxExempt.checked = true; el.taxNote.value = s.taxNote; }
    if (s.discountPct) el.discountPct.value = s.discountPct;
    refreshInvLive();
  }
  // An invoice always ends up tied to a client record: the chosen one, one with the same name, or a new one.
  async function ensureClient(data) {
    if (data.clientId && S.clients.some((c) => c.id === data.clientId)) {
      const c = S.clients.find((x) => x.id === data.clientId), cl = data.client, patch = {};
      for (const k of ["company", "email", "phone", "address"]) if (cl[k] && !c[k]) patch[k] = cl[k];
      if (Object.keys(patch).length) { const d = { ...c, ...patch }; delete d.id; await write("clients/" + c.id, d); }
      return c.id;
    }
    const match = S.clients.find((c) => sameName(c.name, data.client.name));
    if (match) return match.id;
    const id = "cl-" + uid(), now = new Date().toISOString();
    await write("clients/" + id, { ...data.client, type: "Collector", createdAt: now, updatedAt: now });
    return id;
  }

  // ---------- pieces out on approval or loan ----------
  const OUT_TYPES = ["On approval", "Loan", "Fair or exhibition", "Photo shoot", "Conservation"];
  const isOut = (p) => !!(p.out && p.out.active);
  function outSection(p) {
    if (isOut(p)) {
      const o = p.out, late = o.due && o.due < today();
      return `<div class="sec"><span class="k">Out of the gallery</span><div class="files-link"><div style="min-width:0">
        <div>${esc(o.type)} with ${o.clientId ? `<button class="linkish" style="font-size:13.5px" data-open-client="${esc(o.clientId)}">${esc(o.with)}</button>` : esc(o.with)}</div>
        <div class="u" style="${late ? "color:var(--red)" : ""}">Since ${fdate(o.since)}${o.due ? ` · due back ${fdate(o.due)} (${rel(o.due)})` : ""}${o.notes ? " · " + esc(o.notes) : ""}</div></div>
        ${S.canWrite ? `<button class="btn small lime" data-act="out-return">Mark returned</button>` : ""}</div></div>`;
    }
    const hist = (p.outHistory || []).slice(-3).reverse().map((o) => `<div class="u">${esc(o.type)} with ${esc(o.with)}, ${fdate(o.since)} to ${fdate(o.returned)}</div>`).join("");
    if (!S.canWrite || ["Sold", "Returned"].includes(p.status)) return hist ? `<div class="sec"><span class="k">Out of the gallery</span><div class="files-link"><div>${hist}</div></div></div>` : "";
    if (!S.outFormOpen) return `<div class="sec"><span class="k">Out of the gallery</span><div class="files-link"><div style="min-width:0"><div>In the gallery's care</div>${hist}</div><button class="btn small ghost" data-act="out-open">Send out</button></div></div>`;
    return `<div class="sec"><span class="k">Send out</span><form id="outForm" class="grid2" style="padding-top:12px" novalidate>
      ${field("outType", "Reason", "On approval", { options: OUT_TYPES })}
      ${field("outWith", "With whom or where", "", { list: "outClients", req: true, ph: "Client, designer, fair or studio" })}
      ${field("outSince", "Left the gallery", today(), { type: "date" })}
      ${field("outDue", "Due back", addDays(today(), 14), { type: "date" })}
      ${field("outNotes", "Notes", "", { full: true, ph: "Address, insurance, who signed for it" })}
      <datalist id="outClients">${S.clients.map((c) => `<option value="${esc(c.name)}">`).join("")}</datalist>
      <div class="full" style="display:flex;gap:8px;justify-content:flex-end"><button type="button" class="btn small ghost" data-act="out-cancel">Cancel</button><button type="submit" class="btn small">Send out</button></div>
    </form></div>`;
  }
  async function sendOut(form) {
    const p = S.pieces.find((x) => x.id === S.panel.id); if (!p) return;
    const f = form.elements, withWho = f.outWith.value.trim();
    if (!withWho) { toast("Add who has the piece."); return; }
    const c = S.clients.find((x) => sameName(x.name, withWho));
    S.outFormOpen = false;
    await savePiece2({ ...p, out: { active: true, type: f.outType.value, with: withWho, clientId: c ? c.id : "", since: f.outSince.value || today(), due: f.outDue.value, notes: f.outNotes.value.trim() } });
    toast("Marked as out");
  }
  async function returnIn() {
    const p = S.pieces.find((x) => x.id === S.panel.id); if (!p || !isOut(p)) return;
    const { active, ...o } = p.out;
    await savePiece2({ ...p, out: { active: false }, outHistory: [...(p.outHistory || []), { ...o, returned: today() }] });
    toast("Back in the gallery");
  }

  // ---------- quotes ----------
  const isQuote = (inv) => inv.docType === "quote";
  async function convertQuote(q) {
    const now = new Date().toISOString(), id = "inv-" + uid();
    const inv = { ...q, docType: "invoice", number: nextInvNumber("invoice"), date: today(), dueDate: addDays(today(), n(setting("dueDays"))), sent: false, received: [], voided: false, fromQuote: q.id, createdAt: now, updatedAt: now };
    delete inv.id; delete inv.convertedTo; delete inv.sentDate; delete inv.sample;
    if (!(await write("invoices/" + id, clean(inv)))) return;
    const qd = { ...q, convertedTo: id, updatedAt: now }; delete qd.id;
    await write("invoices/" + q.id, clean(qd), "Invoice created from quote");
    S.panel = { type: "invoice", id, mode: "view", saved: Date.now() }; renderPanel();
  }

  // ---------- exports ----------
  const csvCell = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  async function saveCsv(name, header, rows) {
    if (!S.downloads) { toast("Downloads aren't available in this view."); return; }
    try { await S.downloads.save({ filename: `${name}-${today()}.csv`, data: [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n") }); }
    catch (e) { if (e && e.code !== "cancelled") toast("The export didn't save."); }
  }
  function exportInvoicesCsv() {
    const rows = [...S.invoices].sort((a, b) => String(a.number).localeCompare(String(b.number))).map((i) => {
      const t = invTotals(i);
      return [i.number, isQuote(i) ? "Quote" : "Invoice", invStatus(i), i.date, i.dueDate, i.client?.name, i.client?.company, i.client?.email, (i.items || []).map((x) => x.title).join("; "),
        t.sub, t.disc, t.ship, i.taxExempt ? "Exempt" : n(i.taxRate) + "%", t.tax, t.total, isQuote(i) ? "" : t.paid, isQuote(i) ? "" : t.balance, (i.received || []).map((r) => `${r.date} ${r.method} ${r.amount}`).join("; ")];
    });
    return saveCsv("twelve-objects-invoices", ["Number", "Type", "Status", "Date", "Due or valid until", "Client", "Company", "Email", "Pieces", "Subtotal", "Discount", "Shipping", "Tax rate", "Tax", "Total", "Paid", "Balance", "Payments"], rows);
  }
  function exportClientsCsv() {
    const rows = S.clients.map((c) => { const st = clientStats(c); return [c.name, c.company, c.type, c.email, c.phone, c.address, c.instagram, c.metDate, c.source, c.interests, c.tradeDiscount, c.resaleCert, c.resaleExpiry, st.count, st.spent, st.paid, st.open, st.last, c.notes]; });
    return saveCsv("twelve-objects-clients", ["Name", "Company", "Type", "Email", "Phone", "Address", "Instagram", "Met", "Source", "Interests", "Trade discount %", "Resale certificate", "Certificate expires", "Invoices", "Purchased", "Received", "Open balance", "Last invoice", "Notes"], rows);
  }

  // ---------- artist statements (PDF) ----------
  // Shared letterhead for the gallery's documents.
  function pdfDoc(title) {
    const d = new window.jspdf.jsPDF({ unit: "pt", format: "letter" });
    const K = { L: 54, R: 558, INK: [22, 22, 22], SOFT: [95, 95, 88], GREEN: [23, 137, 63], LIME: [221, 231, 138], LINE: [226, 226, 218] };
    const txt = (s, x, y, o = {}) => { d.setFont(o.font || "helvetica", o.style || "normal"); d.setFontSize(o.size || 9.5); d.setTextColor(...(o.color || K.INK)); d.text(String(s), x, y, o.align ? { align: o.align } : undefined); };
    const rule = (y, color = K.INK, w = 0.75, x1 = K.L) => { d.setDrawColor(...color); d.setLineWidth(w); d.line(x1, y, K.R, y); };
    const masthead = () => { const lw = pdfLogo(d, K.L, 42.5, 9.5); txt("Twelve Objects", K.L + lw + 14, 52, { font: "times", size: 11.5 }); txt("Collectible Design  ·  Art + Objects", K.R, 52, { size: 8, color: K.SOFT, align: "right" }); rule(62); };
    const finish = () => {
      const total = d.getNumberOfPages();
      for (let i = 1; i <= total; i++) {
        d.setPage(i); rule(742);
        txt("XIIO, LLC dba Twelve Objects", K.L, 756, { size: 7.5 });
        txt("8906 Olympic Blvd, Beverly Hills, CA 90211", K.L + 150, 756, { size: 7.5, color: K.SOFT });
        const right = "cs@twelveobjects.com  ·  twelveobjects.com";
        txt(total > 1 ? `${right}  ·  ${i} of ${total}` : right, K.R, 756, { size: 7.5, color: K.SOFT, align: "right" });
      }
      return d.output("blob");
    };
    masthead();
    txt(title, K.L, 120, { font: "times", style: "italic", size: 34, color: K.GREEN });
    const page = { y: 160 };
    const room = (h) => { if (page.y + h > 720) { d.addPage(); masthead(); page.y = 90; } };
    return { d, K, txt, rule, finish, page, room };
  }
  async function savePdf(name, blob) {
    if (!S.downloads) { toast("Downloads aren't available in this view."); return; }
    try { await S.downloads.save({ filename: name.replace(/[^A-Za-z0-9._-]+/g, "-"), data: blob }); }
    catch (e) { if (e && e.code !== "cancelled") toast("The PDF didn't save."); }
  }
  const isPayout = (x) => x.auto === "payout" || /payout/i.test(x.label || "");

  async function payoutPdf(p, pay) {
    if (!window.jspdf) { toast("The PDF maker didn't load. Check your connection and try again."); return; }
    const a = artistOf(p) || { name: artistName(p) };
    const { d, K, txt, rule, finish, page } = pdfDoc("Payout statement");
    const split = has(p.artistSplit) ? n(p.artistSplit) : 50, sale = n(p.salePrice), ship = n(p.shipping);
    [["Statement date", fdate(today())], ["Piece", p.sku || ""], [pay.paid ? "Paid" : "Due", fdate(pay.paid ? pay.paidDate : pay.due)]].forEach(([k, v], i) => { txt(k.toUpperCase(), 400, 92 + i * 16, { size: 7, color: K.SOFT }); txt(v, K.R, 92 + i * 16, { align: "right" }); });
    let y = page.y;
    txt("ARTIST", K.L, y, { size: 7, color: K.SOFT }); txt("FROM", 320, y, { size: 7, color: K.SOFT });
    [a.name, a.studio, a.email].filter(Boolean).forEach((s, i) => txt(s, K.L, y + 15 + i * 13, { style: i ? "normal" : "bold" }));
    ["XIIO, LLC, doing business as Twelve Objects", "8906 Olympic Blvd, Beverly Hills, CA 90211", "cs@twelveobjects.com"].forEach((s, i) => txt(s, 320, y + 15 + i * 13, { color: i ? K.SOFT : K.INK }));
    y += 70; rule(y);
    txt(p.title || "Untitled", K.L, y + 22, { font: "times", size: 15 });
    txt([p.year, p.materials, p.dimensions, p.edition].filter(Boolean).join(", "), K.L, y + 37, { size: 9, color: K.SOFT });
    txt(`Sold ${fdate(p.soldDate)}${p.agreementDate ? ` · consignment agreement dated ${fdate(p.agreementDate)}` : ""}`, K.L, y + 50, { size: 9, color: K.SOFT });
    y += 78;
    const TX = 300, line = (k, v, o = {}) => { txt(k, TX, y, { color: o.strong ? K.INK : K.SOFT, style: o.strong ? "bold" : "normal" }); txt(v, K.R, y, { align: "right", style: o.strong ? "bold" : "normal" }); y += 18; };
    line("Sale price", usd2(sale));
    line("Less shipping", "-" + usd2(ship));
    line("Net sale", usd2(Math.max(0, sale - ship)));
    line(`Artist share (${split}%)`, usd2(calc(p).artistShare));
    rule(y - 8, K.INK, 0.75, TX);
    y += 6; d.setFillColor(...K.LIME); d.rect(TX - 6, y - 12, K.R - TX + 12, 20, "F");
    line(pay.paid ? `Paid ${fdate(pay.paidDate)}` : `Amount due by ${fdate(pay.due)}`, usd2(pay.amount), { strong: true });
    y += 20;
    const note = d.setFont("helvetica", "normal").setFontSize(9).splitTextToSize("Per the consignment agreement, the artist receives the agreed share of the sale price net of shipping, paid within 30 days of the sale. Questions about this statement: cs@twelveobjects.com.", K.R - K.L);
    rule(y, K.LINE, 0.5); d.setTextColor(...K.SOFT); d.text(note, K.L, y + 16);
    await savePdf(`Payout_${p.sku || p.id}_${a.name}.pdf`, finish());
  }

  async function artistStatementPdf(a) {
    if (!window.jspdf) { toast("The PDF maker didn't load. Check your connection and try again."); return; }
    const { d, K, txt, rule, finish, page, room } = pdfDoc("Artist statement");
    const ps = S.pieces.filter((p) => p.artistId === a.id);
    const sold = ps.filter((p) => p.status === "Sold"), hand = ps.filter((p) => ON_HAND.includes(p.status));
    const pays = ps.flatMap((p) => (p.payments || []).filter(isPayout));
    const paid = pays.filter((x) => x.paid).reduce((s, x) => s + n(x.amount), 0), owed = pays.filter((x) => !x.paid).reduce((s, x) => s + n(x.amount), 0);
    [["Statement date", fdate(today())], ["Pieces", String(ps.length)]].forEach(([k, v], i) => { txt(k.toUpperCase(), 400, 92 + i * 16, { size: 7, color: K.SOFT }); txt(v, K.R, 92 + i * 16, { align: "right" }); });
    txt("ARTIST", K.L, page.y, { size: 7, color: K.SOFT });
    [a.name, a.studio, a.location, a.email].filter(Boolean).forEach((s, i) => txt(s, K.L, page.y + 15 + i * 13, { style: i ? "normal" : "bold" }));
    const sums = [["Paid to artist", usd2(paid)], ["Owed to artist", usd2(owed)], ["Sold", String(sold.length)], ["On hand", String(hand.length)]];
    sums.forEach(([k, v], i) => { txt(k.toUpperCase(), 320 + (i % 2) * 120, page.y + (i > 1 ? 40 : 0), { size: 7, color: K.SOFT }); txt(v, 320 + (i % 2) * 120, page.y + 15 + (i > 1 ? 40 : 0), { font: "times", size: 14 }); });
    page.y += 90;
    const table = (title, cols, rows) => {
      if (!rows.length) return;
      room(60); rule(page.y); txt(title, K.L, page.y + 18, { font: "times", size: 14 }); page.y += 34;
      cols.forEach(([h, x, al]) => txt(h.toUpperCase(), x, page.y, { size: 7, color: K.SOFT, align: al }));
      page.y += 14;
      rows.forEach((r) => { room(20); r.forEach((v, i) => txt(v, cols[i][1], page.y, { size: 9, align: cols[i][2] })); rule(page.y + 6, K.LINE, 0.5); page.y += 20; });
      page.y += 12;
    };
    const clip = (s, w) => { const l = d.setFont("helvetica", "normal").setFontSize(9).splitTextToSize(String(s || ""), w); return l.length > 1 ? l[0].replace(/\s*\S*$/, "") + "..." : l[0] || ""; };
    table("Sold", [["Piece", K.L], ["Sold", 230], ["Sale", 330, "right"], ["Shipping", 395, "right"], ["Share", 460, "right"], ["Payout", K.R, "right"]],
      sold.map((p) => { const po = (p.payments || []).find(isPayout); return [clip(p.title, 170), fdate(p.soldDate), usd(p.salePrice), usd(p.shipping, { zero: 1 }), p.agreement === "Acquisition" ? "Acquired" : (has(p.artistSplit) ? n(p.artistSplit) : 50) + "%", po ? (po.paid ? "Paid " + fdate(po.paidDate) : "Due " + fdate(po.due)) : p.agreement === "Acquisition" ? "" : "Not set"]; }));
    table("On hand", [["Piece", K.L], ["Agreement", 230], ["Received", 330], ["List price", 460, "right"], ["Consignment ends", K.R, "right"]],
      hand.map((p) => [clip(p.title, 170), p.agreement || "Consignment", fdate(p.receivedDate), has(p.price) ? usd(p.price) : "", p.agreement === "Acquisition" ? "" : fdate(p.consignEnd)]));
    await savePdf(`Statement_${a.name}_${today()}.pdf`, finish());
  }

  // ---------- events ----------
  document.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-go],[data-act],[data-open-piece],[data-open-artist],[data-open-invoice],[data-open-client],[data-inv-rm],[data-inv-tab],[data-statement],[data-cat],[data-layout],[data-mark-paid],[data-follow-done],[data-photo],[data-rm-photo]");
    if (!t) return;
    const d = t.dataset;
    if (d.go) { e.preventDefault(); S.view = d.go; closePanel(); render(); window.scrollTo(0, 0); return; }
    if (d.openPiece) { e.stopPropagation(); return openPanel("piece", d.openPiece); }
    if (d.openArtist) return openPanel("artist", d.openArtist);
    if (d.invTab) { S.invTab = d.invTab; return render(); }
    if (d.statement) { const [pid, pay] = d.statement.split("|"), p = S.pieces.find((x) => x.id === pid), x = p && (p.payments || []).find((y) => y.id === pay); if (x) { t.disabled = true; await payoutPdf(p, x); t.disabled = false; } return; }
    if (d.openClient) { e.stopPropagation(); return openPanel("client", d.openClient); }
    if (d.openInvoice) { e.stopPropagation(); S.invPayOpen = false; return openPanel("invoice", d.openInvoice); }
    if (d.invRm) { S.invDraft.splice(+d.invRm, 1); return rerenderInvForm(); }
    if (d.cat) { S.f.cat = d.cat; return render(); }
    if (d.layout) { S.layout = d.layout; try { localStorage.setItem("to-layout", d.layout); } catch (x) {} return render(); }
    if (d.markPaid) { const [pid, pay] = d.markPaid.split("|"); t.disabled = true; return markPaid(pid, pay); }
    if (d.followDone) { t.disabled = true; return followDone(d.followDone); }
    if (d.photo) { S.photoIdx = +d.photo; return renderPanel(); }
    if (d.rmPhoto) { S.formPhotos.splice(+d.rmPhoto, 1); $("#photoEdit").innerHTML = photoTiles(); return; }
    switch (d.act) {
      case "close": return closePanel();
      case "new-piece": return openPanel("piece", null, "edit");
      case "new-artist": return openPanel("artist", null, "edit");
      case "new-piece-for": openPanel("piece", null, "edit"); $("#f-artistId").value = d.artist; return;
      case "edit": S.panel.mode = "edit"; S.confirmDelete = false; S.invDraft = null; return renderPanel();
      case "cancel-edit": S.panel.mode = "view"; S.invDraft = null; return renderPanel();
      case "ask-delete": S.confirmDelete = true; return rerenderActs();
      case "keep": S.confirmDelete = false; return rerenderActs();
      case "delete-piece": try { await S.db.doc("pieces/" + S.panel.id).delete(); toast("Piece deleted"); closePanel(); } catch (x) { toast("Couldn't delete. Try again."); } return;
      case "delete-artist": try { await S.db.doc("artists/" + S.panel.id).delete(); toast("Artist deleted"); closePanel(); } catch (x) { toast("Couldn't delete. Try again."); } return;
      case "add-pay": $("#payRows").insertAdjacentHTML("beforeend", payRow({ due: today() })); return;
      case "rm-pay": t.closest(".pay-row").remove(); return;
      case "calc-pay": {
        const f = $("#pieceForm"), v = (k) => f.elements[k].value;
        if (!v("salePrice")) { $("#formErr").textContent = "Enter what it sold for first."; return; }
        const acq = v("agreement") === "Acquisition";
        if (acq) { $("#formErr").textContent = "Acquisitions owe the artist nothing after sale."; return; }
        const amt = calc({ agreement: "Consignment", salePrice: v("salePrice"), shipping: v("shipping"), artistSplit: v("artistSplit") }).artistShare;
        const sold = v("soldDate") || today();
        $("#payRows").insertAdjacentHTML("beforeend", payRow({ label: "Artist payout, " + (v("artistSplit") || 50) + "% of sale", amount: amt, due: addDays(sold, 30) }));
        $("#formErr").textContent = ""; return;
      }
      case "export": return exportCsv();
      case "new-invoice": S.invDraft = null; return openPanel("invoice", null, "edit");
      case "new-client": return openPanel("client", null, "edit");
      case "new-quote": S.invDraft = null; S.confirmDelete = false; S.panel = { type: "invoice", id: null, mode: "edit", seed: { docType: "quote" } }; return renderPanel();
      case "new-quote-client": { const c = S.clients.find((x) => x.id === d.client); if (!c) return; S.invDraft = null; S.confirmDelete = false; S.panel = { type: "invoice", id: null, mode: "edit", seed: { ...invoiceSeedFor(c), docType: "quote" } }; return renderPanel(); }
      case "quote-convert": { const q = S.invoices.find((x) => x.id === S.panel.id); t.disabled = true; return convertQuote(q); }
      case "export-invoices": return exportInvoicesCsv();
      case "export-clients": return exportClientsCsv();
      case "out-open": S.outFormOpen = true; return renderPanel();
      case "out-cancel": S.outFormOpen = false; return renderPanel();
      case "out-return": t.disabled = true; return returnIn();
      case "artist-statement": { const a = S.artists.find((x) => x.id === S.panel.id); t.disabled = true; await artistStatementPdf(a); t.disabled = false; return; }
      case "new-invoice-client": { const c = S.clients.find((x) => x.id === d.client); if (!c) return; S.invDraft = null; S.confirmDelete = false; S.panel = { type: "invoice", id: null, mode: "edit", seed: invoiceSeedFor(c) }; return renderPanel(); }
      case "ask-delete-client": S.confirmDelete = true; return renderPanelKeep();
      case "keep-client": S.confirmDelete = false; return renderPanelKeep();
      case "delete-client": try { await S.db.doc("clients/" + S.panel.id).delete(); toast("Client deleted"); closePanel(); } catch (x) { toast("Couldn't delete. Try again."); } return;
      case "new-invoice-for": { const p = S.pieces.find((x) => x.id === d.piece); S.invDraft = p ? [itemFromPiece(p)] : null; S.panel = { type: "invoice", id: null, mode: "edit" }; S.confirmDelete = false; return renderPanel(); }
      case "inv-add-piece": { const v = $("#invAddPiece").value, p = S.pieces.find((x) => x.id === v); if (!p) { $("#formErr").textContent = "Choose a piece first."; return; } S.invDraft.push(itemFromPiece(p)); return rerenderInvForm(); }
      case "inv-settings": S.panel = { type: "settings", mode: "edit" }; return renderPanel();
      case "inv-pdf": { const inv = S.invoices.find((x) => x.id === S.panel.id); t.disabled = true; await invoicePdf(inv); t.disabled = false; return; }
      case "inv-sent": { const inv = S.invoices.find((x) => x.id === S.panel.id); const nx = await invUpdate(inv, { sent: true, sentDate: today() }, "Marked as sent"); if (nx && !isQuote(nx)) await holdPieces(nx); return; }
      case "inv-pay-open": S.invPayOpen = true; return renderPanel();
      case "inv-pay-cancel": S.invPayOpen = false; return renderPanel();
      case "inv-paid-full": { const inv = S.invoices.find((x) => x.id === S.panel.id); t.disabled = true; return recordPayment(inv, invTotals(inv).balance, today(), "Wire"); }
      case "inv-ask-void": case "inv-ask-delete": S.confirmDelete = true; return S.panel.mode === "edit" ? rerenderInvForm() : renderPanel();
      case "keep-inv": S.confirmDelete = false; return S.panel.mode === "edit" ? rerenderInvForm() : renderPanel();
      case "inv-void": { const inv = S.invoices.find((x) => x.id === S.panel.id); S.confirmDelete = false; const nx = await invUpdate(inv, { voided: true }, "Invoice voided"); if (nx) await releasePieces(nx); return; }
      case "inv-delete": { const id = S.panel.id; try { await S.db.doc("invoices/" + id).delete(); S.invDraft = null; toast("Draft deleted"); closePanel(); } catch (x) { toast("Couldn't delete. Try again."); } return; }
      case "clear-samples": t.disabled = true; return clearSamples();
    }
  });
  function renderPanelKeep() {
    // rebuild only the delete area so typed values stay
    const area = $("#clientForm .form-acts > div"); if (!area) return renderPanel();
    area.innerHTML = S.confirmDelete ? `<span class="err">Delete this client? Their invoices stay.</span><button type="button" class="btn small danger" data-act="delete-client">Delete</button><button type="button" class="btn small ghost" data-act="keep-client">Keep</button>` : `<button type="button" class="btn small danger" data-act="ask-delete-client">Delete client</button>`;
  }
  function rerenderInvForm() {
    // keep typed values while the item list or delete prompt changes
    const f = $("#invoiceForm"); if (!f) return;
    const snapshot = { ...readInvForm(f), id: S.panel.id };
    const old = S.panel.id ? S.invoices.find((x) => x.id === S.panel.id) : null;
    const panel = $("#panelRoot .panel"), top = panel.scrollTop;
    panel.innerHTML = invoiceForm({ ...(old || {}), ...snapshot, id: S.panel.id || undefined });
    panel.scrollTop = top; refreshInvLive();
  }
  function rerenderActs() {
    // keep typed values: rebuild only the delete area
    const form = $("#pieceForm") || $("#artistForm"); if (!form) return;
    const area = form.querySelector(".form-acts > div");
    const what = form.id === "pieceForm" ? "piece" : "artist";
    area.innerHTML = S.confirmDelete
      ? `<span class="err">${what === "piece" ? "Delete this piece for everyone?" : "Delete this artist? Their pieces stay."}</span><button type="button" class="btn small danger" data-act="delete-${what}">Delete</button><button type="button" class="btn small ghost" data-act="keep">Keep</button>`
      : `<button type="button" class="btn small danger" data-act="ask-delete">Delete ${what}</button>`;
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && S.panel) closePanel();
    if (e.key === "Enter" && e.target.matches("tr[data-open-piece]")) openPanel("piece", e.target.dataset.openPiece);
  });
  document.addEventListener("submit", (e) => {
    e.preventDefault();
    if (e.target.id === "pieceForm") savePiece(e.target);
    if (e.target.id === "artistForm") saveArtist(e.target);
    if (e.target.id === "invoiceForm") saveInvoice(e.target);
    if (e.target.id === "settingsForm") saveSettings(e.target);
    if (e.target.id === "clientForm") saveClient(e.target);
    if (e.target.id === "outForm") sendOut(e.target);
    if (e.target.id === "invPayForm") { const f = e.target.elements; recordPayment(S.invoices.find((x) => x.id === S.panel.id), n(f.payAmount.value), f.payDate.value || today(), f.payMethod.value); }
  });
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "fStatus") { S.f.status = t.value; render(); }
    if (t.id === "fAgreement") { S.f.agreement = t.value; render(); }
    if (t.id === "fSort") { S.f.sort = t.value; render(); }
    if (t.closest && t.closest("#invoiceForm")) refreshInvLive();
    if (t.id === "f-clientId" && t.value) { const c = S.clients.find((x) => x.id === t.value); if (c) fillInvoiceClient(c); }
    if (t.id === "f-clientName" && $("#invoiceForm") && !$("#f-clientId").value) { const c = S.clients.find((x) => sameName(x.name, t.value)); if (c) fillInvoiceClient(c); }
    if (t.id === "photoInput") uploadPhotos([...t.files]);
    if (t.id === "f-artistId") { $("#newArtistWrap").hidden = t.value !== "__new"; if (t.value !== "__new") { const a = S.artists.find((x) => x.id === t.value); if (a && (a.agreement === "Consignment" || a.agreement === "Acquisition") && $("#pieceForm") && !S.panel.id) $("#f-agreement").value = a.agreement; } }
    if (t.name === "pp") { const h = t.closest(".pay-row").querySelector('[name="ppd"]'); h.value = t.checked ? today() : ""; }
  });
  let qt;
  document.addEventListener("input", (e) => {
    if (e.target.dataset && e.target.dataset.invPrice !== undefined) S.invDraft[+e.target.dataset.invPrice].price = n(e.target.value);
    if (e.target.closest && e.target.closest("#invoiceForm")) refreshInvLive();
    if (e.target.id === "clientQ") {
      clearTimeout(qt);
      qt = setTimeout(() => { S.clientQ = e.target.value; const pos = e.target.selectionStart; render(); const q = $("#clientQ"); if (q) { q.focus(); q.setSelectionRange(pos, pos); } }, 160);
    }
    if (e.target.id === "q") {
      clearTimeout(qt);
      qt = setTimeout(() => { S.f.q = e.target.value; const pos = e.target.selectionStart; render(); const q = $("#q"); if (q) { q.focus(); q.setSelectionRange(pos, pos); } }, 160);
    }
  });

  if (/^#(inventory|artists|clients|invoices|overview)$/.test(location.hash)) S.view = location.hash.slice(1);
  render();
  boot();
})();
