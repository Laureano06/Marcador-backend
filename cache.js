// Cache en memoria, indexado por fecha ("YYYY-MM-DD"), con vencimiento
// (TTL). El plan free de API-Football permite 100 requests/día — por eso
// acá NO hay un worker en loop pidiendo todo el tiempo: cada fecha se pide
// una sola vez a la API externa y se reutiliza hasta que vence el TTL.
//
// En producción esto se reemplaza por Redis (con el mismo concepto de TTL,
// pero persistente entre reinicios).

const store = {}; // { "2026-08-16": { updatedAt, matches } }

const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000); // 5 min

function getCached(dateKey) {
  return store[dateKey] || null;
}

function setCached(dateKey, matches) {
  store[dateKey] = { updatedAt: Date.now(), matches };
}

function isExpired(dateKey) {
  const entry = store[dateKey];
  if (!entry) return true;
  return Date.now() - entry.updatedAt > CACHE_TTL_MS;
}

module.exports = { getCached, setCached, isExpired };
