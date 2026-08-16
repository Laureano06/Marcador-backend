// Cache en memoria genérico: cualquier módulo puede guardar algo bajo una
// clave, con su propio tiempo de vencimiento (TTL). Se usa para partidos
// por día, resultados de búsqueda, y fichas de equipo — cada uno con un
// TTL distinto, porque no todos cambian con la misma frecuencia.
//
// En producción esto se reemplaza por Redis (mismo concepto de TTL, pero
// persistente entre reinicios).

const store = {}; // { key: { updatedAt, ttlMs, data } }

function getCached(key) {
  const entry = store[key];
  return entry ? entry.data : null;
}

function getCachedMeta(key) {
  return store[key] || null; // incluye updatedAt, útil para mostrar "actualizado hace..."
}

function setCached(key, data, ttlMs) {
  store[key] = { updatedAt: Date.now(), ttlMs, data };
}

function isExpired(key) {
  const entry = store[key];
  if (!entry) return true;
  return Date.now() - entry.updatedAt > entry.ttlMs;
}

module.exports = { getCached, getCachedMeta, setCached, isExpired };
