// Load records from a JSON file shaped { "pieces": [...], "artists": [...] }.
// Usage: node scripts/import.js data/initial.json   (existing records with the same id are replaced)
const fs = require("fs");
const db = require("../lib/db");

async function main() {
  const file = process.argv[2] || "data/initial.json";
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const pool = db.makePool();
  await db.migrate(pool);
  let n = 0;
  for (const col of db.COLLECTIONS) for (const doc of data[col] || []) {
    const { id, ...rest } = doc;
    if (!db.ID_RE.test(id)) { console.warn(`Skipped ${col} record with bad id: ${id}`); continue; }
    await db.put(pool, col, id, rest, "import"); n++;
  }
  await pool.end();
  console.log(`Imported ${n} records from ${file}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
