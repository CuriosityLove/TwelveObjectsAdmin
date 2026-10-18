const test = require("node:test");
const assert = require("node:assert");
const auth = require("../lib/auth");

test("only gallery accounts and listed guests are allowed", () => {
  const cfg = { domain: "twelveobjects.com", extra: ["guest@example.com"] };
  assert.ok(auth.allowed("am@twelveobjects.com", cfg));
  assert.ok(auth.allowed("Guest@Example.com", cfg));
  assert.ok(!auth.allowed("am@twelveobjects.com.evil.com", cfg));
  assert.ok(!auth.allowed("someone@gmail.com", cfg));
});
