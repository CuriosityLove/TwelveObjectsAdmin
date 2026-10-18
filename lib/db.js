const { Pool } = require("pg");

const COLLECTIONS = new Set(["pieces", "artists"]);
const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,120}$/;

function makePool(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is not set");
  const local = /localhost|127\.0\.0\.1|\/var\/run|host=\//.test(url);
  return new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 5 });
}

async function migrate(pool) {
  await pool.query(`
    create table if not exists docs (
      collection text not null,
      id text not null,
      data jsonb not null,
      updated_at timestamptz not null default now(),
      updated_by text,
      primary key (collection, id)
    );
    create table if not exists photos (
      id text primary key,
      mime text not null,
      bytes bytea not null,
      created_at timestamptz not null default now(),
      created_by text
    );
  `);
}

async function list(pool, collection) {
  const { rows } = await pool.query("select id, data from docs where collection = $1 order by id", [collection]);
  return rows.map((r) => ({ id: r.id, ...r.data }));
}

async function put(pool, collection, id, data, by) {
  await pool.query(
    `insert into docs (collection, id, data, updated_at, updated_by) values ($1, $2, $3, now(), $4)
     on conflict (collection, id) do update set data = excluded.data, updated_at = now(), updated_by = excluded.updated_by`,
    [collection, id, data, by || null]
  );
}

async function remove(pool, collection, id) {
  await pool.query("delete from docs where collection = $1 and id = $2", [collection, id]);
}

async function count(pool) {
  const { rows } = await pool.query("select count(*)::int as n from docs");
  return rows[0].n;
}

module.exports = { COLLECTIONS, ID_RE, makePool, migrate, list, put, remove, count };
