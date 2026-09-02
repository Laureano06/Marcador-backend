// Los cuatro endpoints cacheados de server.js (y el warmup) seguían todos
// el mismo patrón "isExpired(key) ? fetch+setCached : leer cache" escrito
// a mano en cada uno. Eso tiene un agujero real con el límite de 100
// requests/día: si dos requests le pegan al mismo endpoint con la misma
// key vencida casi al mismo tiempo (dos usuarios pidiendo el feed de hoy
// justo cuando expiró el TTL, o el warmup corriendo justo cuando entra la
// primera visita), cada una ve isExpired()===true y dispara SU PROPIA
// llamada a la API externa — un cache stampede que gasta cuota de más sin
// necesidad, ninguna de las dos llamadas trae un dato distinto.
//
// getOrFetch() centraliza el patrón y agrega de-duplicación: si ya hay una
// búsqueda en curso para una key, cualquier otro pedido de esa misma key
// espera esa misma promesa en vez de arrancar la suya. Vive solo en
// memoria (por proceso) — no hace falta persistirlo, solo cubre la ventana
// en que la llamada real está en el aire.

const { getCached, isExpired, setCached } = require("./cache");

const inFlight = new Map();

// ttl puede ser un número fijo, o una función (data) => number cuando el
// TTL depende de lo que trajo la respuesta (ej. el detalle de un partido:
// FINAL cachea 7 días, en vivo/programado cachea 2 min).
async function getOrFetch(key, fetcher, ttl) {
  if (!isExpired(key)) return getCached(key);

  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const data = await fetcher();
      const ttlMs = typeof ttl === "function" ? ttl(data) : ttl;
      setCached(key, data, ttlMs);
      return data;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

module.exports = { getOrFetch };
