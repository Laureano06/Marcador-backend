// Cache en memoria genérico: cualquier módulo puede guardar algo bajo una
// clave, con su propio tiempo de vencimiento (TTL). Se usa para partidos
// por día, resultados de búsqueda, y fichas de equipo — cada uno con un
// TTL distinto, porque no todos cambian con la misma frecuencia.
//
// Además se persiste a disco (data/cache.json). Con solo 100 requests/día,
// perder el cache en cada reinicio (Render free duerme el servicio tras
// ~15 min de inactividad y lo revive en la siguiente visita) significaba
// re-pedir todo en frío y gastar cuota de nuevo aunque el dato ya estuviera
// fresco un minuto antes. Para un uso pago/con más tráfico, esto se
// reemplaza por Redis (mismo concepto de TTL, pero persistente de verdad
// entre despliegues, no solo entre reinicios del mismo contenedor).

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const CACHE_FILE = path.join(DATA_DIR, "cache.json");

let store = {}; // { key: { updatedAt, ttlMs, data } }

function loadFromDisk() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, "utf8");
    store = JSON.parse(raw);
    console.log(`[cache] restaurado desde disco (${Object.keys(store).length} claves)`);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn("[cache] no se pudo leer cache.json, arranco vacío:", err.message);
    }
    store = {};
  }
}

function saveToDisk() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(store));
  } catch (err) {
    console.warn("[cache] no se pudo persistir a disco:", err.message);
  }
}

loadFromDisk();

function getCached(key) {
  const entry = store[key];
  return entry ? entry.data : null;
}

function getCachedMeta(key) {
  return store[key] || null; // incluye updatedAt, útil para mostrar "actualizado hace..."
}

function setCached(key, data, ttlMs) {
  store[key] = { updatedAt: Date.now(), ttlMs, data };
  saveToDisk();
}

function isExpired(key) {
  const entry = store[key];
  if (!entry) return true;
  return Date.now() - entry.updatedAt > entry.ttlMs;
}

module.exports = { getCached, getCachedMeta, setCached, isExpired };
