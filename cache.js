// Cache genérico: cualquier módulo puede guardar algo bajo una clave, con
// su propio tiempo de vencimiento (TTL). Se usa para partidos por día,
// resultados de búsqueda, y fichas de equipo — cada uno con un TTL
// distinto, porque no todos cambian con la misma frecuencia.
//
// Respaldado por SQLite (ver db.js) en vez de un JSON plano reescrito
// entero en cada set. Mismo concepto (clave -> {data, updatedAt, ttlMs}) y
// misma interfaz pública — server.js y dataSource.js no necesitan tocarse.

const db = require("./db");

const stmtGet = db.prepare("SELECT updatedAt, ttlMs, data FROM cache WHERE key = ?");
const stmtSet = db.prepare(`
  INSERT INTO cache (key, updatedAt, ttlMs, data) VALUES (@key, @updatedAt, @ttlMs, @data)
  ON CONFLICT(key) DO UPDATE SET
    updatedAt = excluded.updatedAt,
    ttlMs = excluded.ttlMs,
    data = excluded.data
`);

function getCached(key) {
  const row = stmtGet.get(key);
  return row ? JSON.parse(row.data) : null;
}

function getCachedMeta(key) {
  const row = stmtGet.get(key);
  if (!row) return null;
  return { updatedAt: row.updatedAt, ttlMs: row.ttlMs, data: JSON.parse(row.data) }; // incluye updatedAt, útil para mostrar "actualizado hace..." y para Cache-Control
}

function setCached(key, data, ttlMs) {
  stmtSet.run({ key, updatedAt: Date.now(), ttlMs, data: JSON.stringify(data) });
}

function isExpired(key) {
  const row = stmtGet.get(key);
  if (!row) return true;
  return Date.now() - row.updatedAt > row.ttlMs;
}

module.exports = { getCached, getCachedMeta, setCached, isExpired };
