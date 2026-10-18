const test = require("node:test");
const assert = require("node:assert");
const { build } = require("../scripts/digest");
const auth = require("../lib/auth");

test("only gallery accounts and listed guests are allowed", () => {
  const cfg = { domain: "twelveobjects.com", extra: ["guest@example.com"] };
  assert.ok(auth.allowed("am@twelveobjects.com", cfg));
  assert.ok(auth.allowed("Guest@Example.com", cfg));
  assert.ok(!auth.allowed("am@twelveobjects.com.evil.com", cfg));
  assert.ok(!auth.allowed("someone@gmail.com", cfg));
});

test("digest lists open payments, follow-ups, arrivals and missing agreements in the window", () => {
  const artists = [{ id: "a", name: "Studio" }];
  const pieces = [
    { id: "1", title: "Table", artistId: "a", status: "Sold", payments: [{ amount: 450, due: "2026-10-20", paid: false }, { amount: 99, due: "2026-10-10", paid: true }] },
    { id: "2", title: "Lamp", artistId: "a", status: "Incoming", expectedDate: "2026-10-15", followUpDate: "2026-12-01", price: 500 },
    { id: "3", title: "Vase", artistId: "a", status: "In gallery", agreementDate: "2026-09-01", price: 300 },
  ];
  const { sections, totals } = build(pieces, artists, "2026-10-18");
  const get = (name) => sections.find(([h]) => h === name)[1];
  assert.strictEqual(get("Payments").length, 1);
  assert.strictEqual(get("Follow-ups").length, 0);
  assert.ok(get("Arrivals")[0].late);
  assert.deepStrictEqual(get("Missing signed agreement").map((i) => i.text), ["Lamp, Studio"]);
  assert.deepStrictEqual(totals, { onHand: 2, retail: 800, unpaid: 450 });
});
