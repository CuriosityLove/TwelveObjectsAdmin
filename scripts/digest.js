// Monday email: what needs action in the next two weeks. Run by the Render cron job.
const nodemailer = require("nodemailer");
const db = require("../lib/db");

const TZ = "America/Los_Angeles";
const HORIZON_DAYS = 14;
const ON_HAND = ["Incoming", "In gallery", "On hold"];

const todayLA = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date()); // YYYY-MM-DD
const addDays = (s, k) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + k); return d.toISOString().slice(0, 10); };
const fdate = (s) => new Date(s + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const usd = (v) => "$" + Math.round(Number(v) || 0).toLocaleString("en-US");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function build(pieces, artists, today) {
  const horizon = addDays(today, HORIZON_DAYS);
  const who = (p) => (artists.find((a) => a.id === p.artistId) || {}).name || "Unassigned artist";
  const title = (p) => (p.title || "Untitled") + (p.sample ? " (sample)" : "");
  const payments = [], follow = [], arrive = [], paperwork = [];
  let unpaidTotal = 0;
  for (const p of pieces) {
    for (const x of p.payments || []) {
      if (x.paid) continue;
      unpaidTotal += Number(x.amount) || 0;
      if (x.due && x.due <= horizon) payments.push({ date: x.due, late: x.due < today, text: `${x.label || "Payment"} to ${who(p)}, ${title(p)}`, amt: usd(x.amount) });
    }
    if (p.followUpDate && !p.followUpDone && p.followUpDate <= horizon) follow.push({ date: p.followUpDate, late: p.followUpDate < today, text: `${p.followUpNote || "Follow up with " + who(p)}, ${title(p)}` });
    if (p.status === "Incoming" && p.expectedDate && p.expectedDate <= horizon) arrive.push({ date: p.expectedDate, late: p.expectedDate < today, text: `${title(p)} from ${who(p)}` });
    if (ON_HAND.includes(p.status) && !p.agreementDate) paperwork.push({ text: `${title(p)}, ${who(p)}` });
  }
  const byDate = (a, b) => a.date.localeCompare(b.date);
  [payments, follow, arrive].forEach((l) => l.sort(byDate));
  const hand = pieces.filter((p) => ON_HAND.includes(p.status));
  const totals = { onHand: hand.length, retail: hand.reduce((s, p) => s + (Number(p.price) || 0), 0), unpaid: unpaidTotal };
  return { sections: [["Payments", payments], ["Follow-ups", follow], ["Arrivals", arrive], ["Missing signed agreement", paperwork]], totals };
}

function render({ sections, totals }, today, appUrl) {
  const filled = sections.filter(([, l]) => l.length);
  const totalLine = `${totals.onHand} ${totals.onHand === 1 ? "piece" : "pieces"} on hand, ${usd(totals.retail)} retail. ${usd(totals.unpaid)} owed to artists.`;
  const subject = `Twelve Objects: this week's inventory, ${fdate(today)}`;

  const text = [
    `Twelve Objects inventory, week of ${fdate(today)}`, "",
    ...(filled.length ? [] : ["Nothing is due in the next two weeks.", ""]),
    ...filled.flatMap(([h, l]) => [h.toUpperCase(), ...l.map((i) => `- ${i.date ? fdate(i.date) + (i.late ? " (overdue)" : "") + ": " : ""}${i.text}${i.amt ? ", " + i.amt : ""}`), ""]),
    totalLine, "", appUrl,
  ].join("\n");

  const row = (i) => `<tr><td style="padding:7px 12px 7px 0;border-top:1px solid #e2e2da;white-space:nowrap;vertical-align:top;font-variant-numeric:tabular-nums">${i.date ? (i.late ? `<span style="background:#dde78a;padding:1px 4px">${fdate(i.date)}, overdue</span>` : fdate(i.date)) : ""}</td><td style="padding:7px 12px 7px 0;border-top:1px solid #e2e2da">${esc(i.text)}</td><td style="padding:7px 0;border-top:1px solid #e2e2da;text-align:right;white-space:nowrap">${i.amt || ""}</td></tr>`;
  const html = `<div style="font-family:Helvetica,Arial,sans-serif;color:#161616;font-size:14px;line-height:1.5;max-width:620px">
  <div style="border-bottom:1px solid #161616;padding-bottom:10px;margin-bottom:18px"><span style="letter-spacing:0.3em;font-weight:300">XIIO</span>&nbsp;&nbsp;<span style="font-family:Georgia,serif">Twelve Objects <i>Inventory</i></span></div>
  <h1 style="font-family:Georgia,serif;font-weight:normal;font-size:28px;margin:0 0 6px;color:#17893f">Week of ${fdate(today)}</h1>
  <p style="margin:0 0 20px;color:#5f5f58">${esc(totalLine)}</p>
  ${filled.length ? filled.map(([h, l]) => `<h2 style="font-family:Georgia,serif;font-weight:normal;font-size:19px;margin:22px 0 4px">${h}</h2><table style="width:100%;border-collapse:collapse;font-size:13.5px">${l.map(row).join("")}</table>`).join("") : `<p>Nothing is due in the next two weeks.</p>`}
  <p style="margin-top:26px"><a href="${esc(appUrl)}" style="color:#161616;background:#dde78a;padding:7px 14px;border-radius:999px;text-decoration:none">Open the inventory</a></p>
</div>`;
  return { subject, text, html };
}

async function main() {
  const pool = db.makePool();
  await db.migrate(pool);
  const [pieces, artists] = await Promise.all([db.list(pool, "pieces"), db.list(pool, "artists")]);
  await pool.end();
  const today = todayLA();
  const mail = render(build(pieces, artists, today), today, process.env.APP_URL || "https://admin.twelveobjects.com");
  const to = process.env.DIGEST_TO || "am@twelveobjects.com";
  if (!process.env.SMTP_HOST) { console.log(`SMTP_HOST not set; would send to ${to}:\n\n${mail.text}`); return; }
  const tx = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 465), secure: Number(process.env.SMTP_PORT || 465) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await tx.sendMail({ from: process.env.DIGEST_FROM || `Twelve Objects Inventory <${process.env.SMTP_USER}>`, to, ...mail });
  console.log(`Sent digest to ${to}`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { build, render };
