require("dotenv").config();
const express = require("express");
const cors = require("cors");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = rateLimit;
const {
  fetchMatchesForDate,
  searchTeams,
  searchLeagues,
  fetchTeamProfile,
  fetchMatchDetail,
} = require("./dataSource");
const { getCached, getCachedMeta, isExpired } = require("./cache");
const { getOrFetch } = require("./withCache");
const { getUsage, QuotaExceededError, AccountBlockedError } = require("./quotaGuard");

const app = express();
app.use(cors());
app.use(compression()); // gzip de las respuestas — el feed de partidos por día puede ser varios KB de JSON con muchas ligas; en 3G/4G esto se nota

// Render ya mete su propio proxy entre el visitante y este proceso —
// sin esto, req.ip siempre da la IP interna de ese proxy, no la del
// visitante real, y con Cloudflare delante se suma un hop más.
app.set("trust proxy", 1);

// Rate limit liviano por IP. No cuida la cuota de la API externa directamente
// (eso lo hace quotaGuard — pegarle en loop a un endpoint cacheado no gasta
// requests reales), pero evita que un cliente en loop o un bot generen
// carga innecesaria en el servidor.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  // Cloudflare siempre manda la IP real del visitante en este header, sin
  // importar cuántos proxies haya en el medio (el de Render incluido) —
  // más confiable que reconstruir la cadena de X-Forwarded-For a mano. Sin
  // esto, con Cloudflare delante, TODO el tráfico del sitio compartiría el
  // mismo límite de 60/min (la IP del borde de Cloudflare), en vez de un
  // límite por visitante real. Sin Cloudflare (dev local, o pegándole al
  // .onrender.com directo) el header no está y cae a req.ip como antes.
  // ipKeyGenerator normaliza IPv6 a su /56 (en vez de la dirección exacta):
  // un solo visitante IPv6 puede rotar entre miles de direcciones dentro de
  // su propio /56 y esquivar el límite si se compara la IP exacta — la
  // librería lo marca como error de validación si no se envuelve así.
  keyGenerator: (req) => ipKeyGenerator(req.headers["cf-connecting-ip"] || req.ip),
  message: { error: "Demasiadas requests, esperá un momento." },
});
app.use("/api/", apiLimiter);

// TTLs pensados para cuidar la cuota diaria. Los de datos EN VIVO (feed de
// hoy, detalle en vivo) quedaron heredados de la migración de API-Football
// (100 req/día): 20 min y 2 min respectivamente, calibrados para gastar lo
// mínimo posible contra un presupuesto que ya no existe — el frontend hacía
// polling cada 60s (Layout.jsx, POLL_MS) contra un cache de 20 min, así que
// 19 de cada 20 minutos ese polling no traía nada nuevo. Con 7.500 req/día
// de BSD (75x más) esos dos TTLs bajan a la frecuencia que el frontend
// realmente pide, no a la mínima que la cuota vieja toleraba. Lo que NO
// cambia con más cuota es la frecuencia REAL con la que cambian los datos
// que no son "en vivo" — un fixture futuro o un resultado ya jugado no
// cambian más seguido solo porque haya más presupuesto, así que esos TTLs
// quedan igual.
const MATCHES_TTL_MS = 60 * 1000; // 1 min — HOY: alineado con el polling del frontend (antes 20 min)
const PAST_MATCHES_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días — un día ya jugado no cambia más
const FUTURE_MATCHES_TTL_MS = 6 * 60 * 60 * 1000; // 6 hs — fixture programado, rara vez se mueve
const SEARCH_TTL_MS = 60 * 60 * 1000; // 1 hora
const TEAM_PROFILE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hs
const MATCH_DETAIL_TTL_MS = 30 * 1000; // 30 s — EN VIVO, alineado con el nuevo polling de MatchDetail.jsx (antes 2 min)
const MATCH_DETAIL_FINAL_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días — FINAL no cambia nunca más

// Un partido ya finalizado (resultado, estadísticas, alineación) no
// cambia nunca más — se cachea casi para siempre, la misma idea que
// matchesTtlFor() para el feed del día. Uno en vivo o todavía no
// arrancado sigue con el TTL corto: puede pasar a otro estado en
// cualquier momento.
function matchDetailTtlFor(status) {
  return status === "final" ? MATCH_DETAIL_FINAL_TTL_MS : MATCH_DETAIL_TTL_MS;
}

// Nombre nuevo (ya no es específico de API-Football); se mantiene el
// nombre viejo como fallback para no obligar a renombrar la variable en
// Render el mismo día de la migración.
const TIMEZONE =
  process.env.APP_TIMEZONE || process.env.API_FOOTBALL_TIMEZONE || "America/Argentina/Buenos_Aires";

// "Hoy" en la misma zona horaria que usa dataSource.js para cortar los
// días — si no, un partido cerca de medianoche podía clasificarse como
// "pasado" o "futuro" mal y quedar con el TTL equivocado.
function todayKeyInTz() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// Un día ya jugado tiene resultados finales que no cambian más — se
// cachea casi para siempre. Un día futuro puede tener su fixture
// reprogramado, pero no pasa a cada rato — cache media jornada. Solo HOY
// necesita el TTL corto, porque hay partidos en vivo cambiando de minuto
// a minuto.
function matchesTtlFor(dateStr) {
  const today = todayKeyInTz();
  if (dateStr < today) return PAST_MATCHES_TTL_MS;
  if (dateStr > today) return FUTURE_MATCHES_TTL_MS;
  return MATCHES_TTL_MS;
}

// Le dice al browser (y a cualquier CDN/proxy en el medio) cuánto puede
// reusar esta respuesta sin volver a pedirla — la misma ventana que ya
// usa nuestro cache interno, para no mentirle al cliente. "remaining" es
// lo que le queda de vida al dato cacheado AHORA, no el TTL completo: si
// el dato tiene 15 de sus 20 min ya gastados, el cliente solo debería
// guardarlo 5 min más.
function setCacheHeaders(res, meta) {
  if (!meta) return;
  const remainingMs = meta.ttlMs - (Date.now() - meta.updatedAt);
  const maxAge = Math.max(0, Math.floor(remainingMs / 1000));
  res.set("Cache-Control", `public, max-age=${maxAge}`);
}

// Antes, un error de cuota/cuenta cortaba directo con un 503 SIN probar el
// fallback stale — al revés de lo que promete el resto del sistema (mostrar
// datos viejos en vez de romper la pantalla). Ahora los tres casos intentan
// el fallback primero; el error solo se devuelve cuando no hay nada
// cacheado para mostrar en su lugar.
function handleError(res, err, fallback) {
  if (err instanceof QuotaExceededError) {
    console.warn("[api] cuota agotada:", err.message);
    if (fallback) return res.json(fallback);
    return res.status(503).json({ error: err.message, quotaExceeded: true });
  }
  if (err instanceof AccountBlockedError) {
    console.warn("[api] cuenta bloqueada:", err.message);
    if (fallback) return res.json(fallback);
    return res.status(503).json({ error: err.message, accountBlocked: true });
  }
  console.error("[api] error:", err.message);
  if (fallback) return res.json(fallback);
  // 500, no 502: Cloudflare reemplaza el body de CUALQUIER respuesta 502
  // (o 504, 520-527 — su familia de "errores de gateway") por su propia
  // página genérica de error, incluso cuando ese 502 lo generamos nosotros
  // y viaja a través de nuestro propio Worker de cache — confirmado
  // reproduciéndolo: el body que llega al cliente deja de ser el nuestro.
  // 500 y 503 no están en esa lista, pasan intactos.
  res.status(500).json({ error: "No se pudo obtener datos de la API externa" });
}

// GET /api/matches?date=2026-08-16
app.get("/api/matches", async (req, res) => {
  const { date } = req.query;
  if (!date) {
    return res.status(400).json({ error: "Falta el parámetro ?date=YYYY-MM-DD" });
  }

  const key = `matches:${date}`;
  try {
    await getOrFetch(
      key,
      () => {
        console.log(`[api] pidiendo partidos de ${date} a BSD...`);
        return fetchMatchesForDate(date);
      },
      matchesTtlFor(date)
    );
    const meta = getCachedMeta(key);
    setCacheHeaders(res, meta);
    res.json({ updatedAt: new Date(meta.updatedAt).toISOString(), matches: meta.data });
  } catch (err) {
    const stale = getCachedMeta(key);
    handleError(
      res,
      err,
      stale && {
        updatedAt: new Date(stale.updatedAt).toISOString(),
        matches: stale.data,
        stale: true,
      }
    );
  }
});

// GET /api/search?q=boca
app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (q.length < 3) {
    return res.status(400).json({ error: "La búsqueda necesita al menos 3 caracteres" });
  }

  const key = `search:${q.toLowerCase()}`;
  try {
    await getOrFetch(
      key,
      async () => {
        console.log(`[api] buscando "${q}" en BSD...`);
        const [teams, leagues] = await Promise.all([searchTeams(q), searchLeagues(q)]);
        return { teams, leagues };
      },
      SEARCH_TTL_MS
    );
    setCacheHeaders(res, getCachedMeta(key));
    res.json(getCached(key));
  } catch (err) {
    const stale = getCached(key);
    handleError(res, err, stale && { ...stale, stale: true });
  }
});

// GET /api/teams/:id
app.get("/api/teams/:id", async (req, res) => {
  const { id } = req.params;
  const key = `team:${id}`;
  try {
    await getOrFetch(
      key,
      () => {
        console.log(`[api] pidiendo ficha del equipo ${id} a BSD...`);
        return fetchTeamProfile(id);
      },
      TEAM_PROFILE_TTL_MS
    );
    setCacheHeaders(res, getCachedMeta(key));
    res.json(getCached(key));
  } catch (err) {
    const stale = getCached(key);
    handleError(res, err, stale && { ...stale, stale: true });
  }
});

// GET /api/matches/:id -> detalle de un partido puntual (BSD
// resuelve todo por el ID del partido, no hace falta pasar la liga).
app.get("/api/matches/:id", async (req, res) => {
  const { id } = req.params;
  const key = `match-detail:${id}`;
  try {
    await getOrFetch(
      key,
      () => {
        console.log(`[api] pidiendo detalle del partido ${id} a BSD...`);
        return fetchMatchDetail(id);
      },
      (detail) => matchDetailTtlFor(detail.status)
    );
    setCacheHeaders(res, getCachedMeta(key));
    res.json(getCached(key));
  } catch (err) {
    const stale = getCached(key);
    handleError(res, err, stale && { ...stale, stale: true });
  }
});

// GET /api/quota -> transparencia sobre cuánto llevamos gastado hoy.
app.get("/api/quota", (_req, res) => {
  res.set("Cache-Control", "no-store"); // siempre fresco: no cuesta nada, es solo un contador local
  res.json(getUsage());
});

app.get("/health", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true });
});

// Precarga el feed de partidos de HOY al arrancar, en background, sin
// bloquear que el servidor empiece a escuchar. Render duerme el servicio
// tras inactividad y lo revive recién cuando llega la próxima visita —
// sin esto, esa primera visita disparaba la request en frío y esperaba
// varios segundos. Con el warmup, cuando el cache ya sobrevivió el
// reinicio (ver cache.js) esto no hace nada (isExpired da false); solo
// gasta una request cuando de verdad hace falta.
async function warmCache() {
  const today = todayKeyInTz();
  const key = `matches:${today}`;
  if (!isExpired(key)) {
    console.log(`[warmup] partidos de hoy (${today}) ya en cache, no hace falta precargar`);
    return;
  }
  try {
    console.log(`[warmup] precargando partidos de hoy (${today})...`);
    // getOrFetch (no fetchMatchesForDate+setCached directo): si la primera
    // visita del día llega justo mientras el warmup todavía está en el
    // aire, comparte esta misma llamada en vez de disparar una segunda.
    const matches = await getOrFetch(key, () => fetchMatchesForDate(today), matchesTtlFor(today));
    console.log(`[warmup] listo — ${matches.length} partidos cacheados`);
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      console.warn("[warmup] cuota agotada, no se pudo precargar el feed de hoy");
    } else {
      console.warn("[warmup] no se pudo precargar el feed de hoy:", err.message);
    }
  }
}

// Mantiene el feed de HOY tibio en cache aunque no entre ninguna visita,
// en vez de depender pura y exclusivamente de que un usuario dispare el
// refetch al pedir una key ya vencida (el único modelo que el presupuesto
// de 100 req/día podía pagarse). Con 7.500/día, refrescar cada
// MATCHES_TTL_MS cuesta como mucho 1440 requests/día (86400s / 60s) — ni
// el 20% del total — y a cambio ningún visitante paga la latencia de la
// primera llamada en frío a BSD, ni el score en vivo se queda pegado en
// una franja horaria sin tráfico (partidos de madrugada, por ejemplo).
// getOrFetch ya resuelve el no-op cuando el cache sigue vigente, así que
// este intervalo nunca duplica una request que ya se hizo por otra vía
// (un usuario real, u otro tick de este mismo intervalo).
function scheduleTodayRefresh() {
  setInterval(async () => {
    const today = todayKeyInTz();
    const key = `matches:${today}`;
    try {
      await getOrFetch(key, () => fetchMatchesForDate(today), matchesTtlFor(today));
    } catch (err) {
      if (err instanceof QuotaExceededError || err instanceof AccountBlockedError) {
        console.warn(`[refresh] ${err.name} — se salta este ciclo de refresh en background`);
      } else {
        console.warn("[refresh] no se pudo refrescar el feed de hoy en background:", err.message);
      }
    }
  }, MATCHES_TTL_MS);
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[server] escuchando en http://localhost:${PORT}`);
  warmCache();
  scheduleTodayRefresh();
});
