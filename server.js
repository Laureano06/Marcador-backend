require("dotenv").config();
const express = require("express");
const cors = require("cors");
const {
  fetchMatchesForDate,
  searchTeams,
  searchLeagues,
  fetchTeamProfile,
  fetchMatchDetail,
} = require("./dataSource");
const { getCached, getCachedMeta, setCached, isExpired } = require("./cache");
const { getUsage, QuotaExceededError } = require("./quotaGuard");

const app = express();
app.use(cors());

// TTLs pensados para el límite de 100 requests/día. Cuanto más caro es un
// dato de conseguir (o más lento cambia), más tiempo lo reutilizamos.
const MATCHES_TTL_MS = 20 * 60 * 1000; // 20 min — HOY: hay partidos en vivo, cambia rápido
const PAST_MATCHES_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días — un día ya jugado no cambia más
const FUTURE_MATCHES_TTL_MS = 6 * 60 * 60 * 1000; // 6 hs — fixture programado, rara vez se mueve
const SEARCH_TTL_MS = 60 * 60 * 1000; // 1 hora
const TEAM_PROFILE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hs
const MATCH_DETAIL_TTL_MS = 2 * 60 * 1000; // 2 min — EN VIVO cambia rápido
const MATCH_DETAIL_FINAL_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días — FINAL no cambia nunca más

// Un partido ya finalizado (resultado, estadísticas, alineación) no
// cambia nunca más — se cachea casi para siempre, la misma idea que
// matchesTtlFor() para el feed del día. Uno en vivo o todavía no
// arrancado sigue con el TTL corto: puede pasar a otro estado en
// cualquier momento.
function matchDetailTtlFor(status) {
  return status === "final" ? MATCH_DETAIL_FINAL_TTL_MS : MATCH_DETAIL_TTL_MS;
}

const TIMEZONE = process.env.API_FOOTBALL_TIMEZONE || "America/Argentina/Buenos_Aires";

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

function handleError(res, err, fallback) {
  if (err instanceof QuotaExceededError) {
    console.warn("[api] cuota agotada:", err.message);
    return res.status(503).json({ error: err.message, quotaExceeded: true });
  }
  console.error("[api] error:", err.message);
  if (fallback) return res.json(fallback);
  res.status(502).json({ error: "No se pudo obtener datos de API-Football" });
}

// GET /api/matches?date=2026-08-16
app.get("/api/matches", async (req, res) => {
  const { date } = req.query;
  if (!date) {
    return res.status(400).json({ error: "Falta el parámetro ?date=YYYY-MM-DD" });
  }

  const key = `matches:${date}`;
  try {
    if (isExpired(key)) {
      console.log(`[api] pidiendo partidos de ${date} a API-Football...`);
      const matches = await fetchMatchesForDate(date);
      setCached(key, matches, matchesTtlFor(date));
    } else {
      console.log(`[api] sirviendo partidos de ${date} desde cache`);
    }
    const meta = getCachedMeta(key);
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
    if (isExpired(key)) {
      console.log(`[api] buscando "${q}" en API-Football...`);
      const teams = await searchTeams(q);
      const leagues = searchLeagues(q); // no gasta requests
      setCached(key, { teams, leagues }, SEARCH_TTL_MS);
    } else {
      console.log(`[api] sirviendo búsqueda "${q}" desde cache`);
    }
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
    if (isExpired(key)) {
      console.log(`[api] pidiendo ficha del equipo ${id} a API-Football...`);
      const profile = await fetchTeamProfile(id);
      setCached(key, profile, TEAM_PROFILE_TTL_MS);
    } else {
      console.log(`[api] sirviendo ficha del equipo ${id} desde cache`);
    }
    res.json(getCached(key));
  } catch (err) {
    const stale = getCached(key);
    handleError(res, err, stale && { ...stale, stale: true });
  }
});

// GET /api/matches/:id -> detalle de un partido puntual (API-Football
// resuelve todo por el ID del partido, no hace falta pasar la liga).
app.get("/api/matches/:id", async (req, res) => {
  const { id } = req.params;
  const key = `match-detail:${id}`;
  try {
    if (isExpired(key)) {
      console.log(`[api] pidiendo detalle del partido ${id} a API-Football...`);
      const detail = await fetchMatchDetail(id);
      setCached(key, detail, matchDetailTtlFor(detail.status));
    } else {
      console.log(`[api] sirviendo detalle del partido ${id} desde cache`);
    }
    res.json(getCached(key));
  } catch (err) {
    const stale = getCached(key);
    handleError(res, err, stale && { ...stale, stale: true });
  }
});

// GET /api/quota -> transparencia sobre cuánto llevamos gastado hoy.
app.get("/api/quota", (_req, res) => {
  res.json(getUsage());
});

app.get("/health", (_req, res) => res.json({ ok: true }));

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
    const matches = await fetchMatchesForDate(today);
    setCached(key, matches, matchesTtlFor(today));
    console.log(`[warmup] listo — ${matches.length} partidos cacheados`);
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      console.warn("[warmup] cuota agotada, no se pudo precargar el feed de hoy");
    } else {
      console.warn("[warmup] no se pudo precargar el feed de hoy:", err.message);
    }
  }
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[server] escuchando en http://localhost:${PORT}`);
  warmCache();
});
