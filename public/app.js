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
    pieces: [], artists: [], loaded: { pieces: false, artists: false }, offline: false,
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
    }
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
    if (!S.loaded.pieces || !S.loaded.artists) return;
    const sampleCount = S.pieces.filter((p) => p.sample).length + S.artists.filter((a) => a.sample).length;
    const note = sampleCount && S.canWrite ? `<div class="notice"><span><b>Sample entries.</b> Pieces and artists marked Sample are examples to show how the inventory works.</span><button class="btn small ghost" data-act="clear-samples">Remove samples</button></div>` : "";
    m.innerHTML = note + (S.view === "inventory" ? viewInventory() : S.view === "artists" ? viewArtists() : viewOverview());
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
      <div style="position:relative">${tile(p)}<span class="pill-wrap" style="position:absolute;top:9px;right:9px">${pill(p.status)}</span></div>
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
      <div class="head"><h1>The <em class="s">collection</em> today</h1><p>${onHand.length} ${onHand.length === 1 ? "piece" : "pieces"} on hand from ${(() => { const k = new Set(onHand.map((p) => p.artistId)).size; return k + (k === 1 ? " artist" : " artists"); })()}. ${consign} on consignment, ${onHand.length - consign} owned outright${incoming ? ", " + incoming + " still incoming" : ""}.</p></div>
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
      if (f.status !== "On hand" && f.status !== "All" && p.status !== f.status) return false;
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
        <select id="fStatus" aria-label="Status">${opt([["On hand", "On hand"], ["All", "All statuses"], ...STATUSES.map((s) => [s.id, s.id])], S.f.status)}</select>
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
  function openPanel(type, id, mode = "view") { S.panel = { type, id, mode }; S.photoIdx = 0; S.confirmDelete = false; renderPanel(); }
  function closePanel() { S.panel = null; $("#panelRoot").innerHTML = ""; document.body.style.overflow = ""; }

  function renderPanel(fromSync) {
    const P = S.panel, root = $("#panelRoot");
    if (!P) return;
    if (fromSync && P.mode === "edit") return; // don't clobber an open form
    document.body.style.overflow = "hidden";
    let html = "";
    if (P.type === "piece") {
      const p = P.id ? S.pieces.find((x) => x.id === P.id) : null;
      if (P.id && !p) { closePanel(); return; }
      html = P.mode === "edit" ? pieceForm(p) : pieceDetail(p);
    } else {
      const a = P.id ? S.artists.find((x) => x.id === P.id) : null;
      if (P.id && !a) { closePanel(); return; }
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
      ? `Consignment. Artist receives <mark>${split}%</mark> of the sale price net of shipping, paid within <mark>30 days</mark> of sale. Artist ships in; gallery covers return shipping.`
      : `Acquisition. Purchased outright for <mark>${has(p.cost) ? usd(p.cost) : "an unrecorded amount"}</mark>. The gallery sets the resale price and owes the artist nothing further after payment.`;
    const pays = (p.payments || []).slice().sort((x, y) => String(x.due).localeCompare(String(y.due)));
    const payRows = pays.length ? `<table class="pays">${pays.map((x) => `<tr>
        <td>${esc(x.label || "Payment")}</td>
        <td class="num" style="${!x.paid && x.due && x.due < today() ? "color:var(--red)" : "color:var(--soft)"}">${x.paid ? "Paid " + fdate(x.paidDate || x.due) : x.due ? "Due " + fdate(x.due) : "No date"}</td>
        <td class="r">${usd(x.amount, { zero: 1 })}</td>
        <td class="r">${x.paid ? `<span class="pill st-gallery">Paid</span>` : S.canWrite ? `<button class="btn small ghost" data-mark-paid="${esc(p.id)}|${esc(x.id)}">Mark paid</button>` : `<span class="pill st-incoming">Open</span>`}</td></tr>`).join("")}</table>`
      : `<div class="empty-line" style="padding:12px 0">No payments recorded.</div>`;
    const fileRow = (label, url) => url ? `<div class="files-link"><div style="min-width:0"><div>${label}</div><div class="u">${esc(url)}</div></div><a class="btn small lime" href="${esc(safeUrl(url))}" target="_blank" rel="noopener">Open</a></div>` : "";
    return `
      <div class="bar"><span class="k">${esc(p.sku || "Piece")} · ${esc(p.agreement || "Consignment")}</span>
        <div class="acts">${S.canWrite ? `<button class="btn small" data-act="edit">Edit</button>` : ""}<button class="btn small ghost" data-act="close">Close</button></div></div>
      <div class="detail-top">
        <div>${tile(p, i)}${photos.length > 1 ? `<div class="thumbs">${photos.map((ph, k) => `<button aria-pressed="${k === i}" data-photo="${k}" aria-label="Photo ${k + 1}"><img src="/_blob/${esc(ph)}" alt=""></button>`).join("")}</div>` : ""}</div>
        <div style="min-width:0">
          <div style="margin-bottom:10px">${pill(p.status)}${sampleTag(p)}</div>
          <h2>${esc(p.title || "Untitled")}</h2>
          <div class="by">${a ? `<button class="linkish" style="font-size:14px" data-open-artist="${esc(a.id)}">${esc(a.name)}</button>` : esc(artistName(p))}</div>
          <dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
        </div>
      </div>
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
      <div class="bar"><span class="k">Artist</span><div class="acts">${S.canWrite ? `<button class="btn small" data-act="edit">Edit</button>` : ""}<button class="btn small ghost" data-act="close">Close</button></div></div>
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
      insuranceValue: numOrNull("insuranceValue"), condition: g("condition"), conditionDate: g("conditionDate"), conditionNotes: g("conditionNotes"),
      filesUrl: g("filesUrl"), notes: g("notes"), payments, photos: S.formPhotos || [],
      updatedAt: new Date().toISOString(),
    };
    delete data.id;
    if (!old) data.createdAt = data.updatedAt;
    const id = P.id || "p-" + uid();
    const btn = form.querySelector('[type="submit"]'); btn.disabled = true;
    if (await write("pieces/" + id, clean(data), old ? "Saved" : "Piece added")) { S.panel = { type: "piece", id, mode: "view" }; renderPanel(); }
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
    if (await write("artists/" + id, data, old ? "Saved" : "Artist added")) { S.panel = { type: "artist", id, mode: "view" }; renderPanel(); }
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
      toast("Samples removed");
    } catch (e) { toast("Couldn't remove the samples. Try again."); }
  }

  // ---------- events ----------
  document.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-go],[data-act],[data-open-piece],[data-open-artist],[data-cat],[data-layout],[data-mark-paid],[data-follow-done],[data-photo],[data-rm-photo]");
    if (!t) return;
    const d = t.dataset;
    if (d.go) { e.preventDefault(); S.view = d.go; closePanel(); render(); window.scrollTo(0, 0); return; }
    if (d.openPiece) { e.stopPropagation(); return openPanel("piece", d.openPiece); }
    if (d.openArtist) return openPanel("artist", d.openArtist);
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
      case "edit": S.panel.mode = "edit"; S.confirmDelete = false; return renderPanel();
      case "cancel-edit": S.panel.mode = "view"; return renderPanel();
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
      case "clear-samples": t.disabled = true; return clearSamples();
    }
  });
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
  });
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "fStatus") { S.f.status = t.value; render(); }
    if (t.id === "fAgreement") { S.f.agreement = t.value; render(); }
    if (t.id === "fSort") { S.f.sort = t.value; render(); }
    if (t.id === "photoInput") uploadPhotos([...t.files]);
    if (t.id === "f-artistId") { $("#newArtistWrap").hidden = t.value !== "__new"; if (t.value !== "__new") { const a = S.artists.find((x) => x.id === t.value); if (a && (a.agreement === "Consignment" || a.agreement === "Acquisition") && $("#pieceForm") && !S.panel.id) $("#f-agreement").value = a.agreement; } }
    if (t.name === "pp") { const h = t.closest(".pay-row").querySelector('[name="ppd"]'); h.value = t.checked ? today() : ""; }
  });
  let qt;
  document.addEventListener("input", (e) => {
    if (e.target.id === "q") {
      clearTimeout(qt);
      qt = setTimeout(() => { S.f.q = e.target.value; const pos = e.target.selectionStart; render(); const q = $("#q"); if (q) { q.focus(); q.setSelectionRange(pos, pos); } }, 160);
    }
  });

  if (/^#(inventory|artists|overview)$/.test(location.hash)) S.view = location.hash.slice(1);
  render();
  boot();
})();
