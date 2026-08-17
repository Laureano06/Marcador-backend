require("dotenv").config();
const express = require("express");
const cors = require("cors");
const {
  fetchMatchesForDate,
  buildTeamIndex,
  fetchTeamProfile,
  fetchLeagueStandings,
  fetchLeagueMatches,
  LEAGUES,
} = require("./dataSource");
const { getCached, getCachedMeta, setCached, isExpired } = require("./cache");

const app = express();
app.use(cors());

const MATCHES_TTL_MS = Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000); // 5 min
const TEAM_INDEX_TTL_MS = 24 * 60 * 60 * 1000; // 24 hs
const TEAM_PROFILE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hs
const STANDINGS_TTL_MS = 30 * 60 * 1000; // 30 min
const LEAGUE_MATCHES_TTL_MS = 10 * 60 * 1000; // 10 min

const TEAM_INDEX_KEY = "team-index";

// Se asegura de que el índice de equipos esté fresco, y lo devuelve.
// Un solo lugar que arma el índice, lo usan tanto /api/search como
// /api/teams/:id (para saber en qué liga buscar el plantel).
async function getFreshTeamIndex() {
  if (isExpired(TEAM_INDEX_KEY)) {
    console.log("[api] reconstruyendo índice de equipos...");
    const index = await buildTeamIndex();
    setCached(TEAM_INDEX_KEY, index, TEAM_INDEX_TTL_MS);
  }
  return getCached(TEAM_INDEX_KEY);
}

// GET /api/matches?date=2026-08-16
app.get("/api/matches", async (req, res) => {
  const { date } = req.query;
  if (!date) {
    return res
      .status(400)
      .json({ error: "Falta el parámetro ?date=YYYY-MM-DD" });
  }

  const key = `matches:${date}`;

  try {
    if (isExpired(key)) {
      console.log(`[api] pidiendo partidos de ${date} a ESPN...`);
      const matches = await fetchMatchesForDate(date);
      setCached(key, matches, MATCHES_TTL_MS);
    } else {
      console.log(`[api] sirviendo partidos de ${date} desde cache`);
    }

    const meta = getCachedMeta(key);
    res.json({
      updatedAt: new Date(meta.updatedAt).toISOString(),
      matches: meta.data,
    });
  } catch (err) {
    console.error("[api] error matches:", err.message);
    const stale = getCachedMeta(key);
    if (stale) {
      return res.json({
        updatedAt: new Date(stale.updatedAt).toISOString(),
        matches: stale.data,
        stale: true,
      });
    }
    res.status(502).json({ error: "No se pudo obtener partidos de ESPN" });
  }
});

// GET /api/search?q=boca
// Filtra sobre el índice de equipos ya cacheado (no gasta requests nuevas
// contra ESPN en cada búsqueda) + la lista fija de ligas.
app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").trim().toLowerCase();

  if (q.length < 3) {
    return res
      .status(400)
      .json({ error: "La búsqueda necesita al menos 3 caracteres" });
  }

  try {
    const index = await getFreshTeamIndex();

    const teams = index
      .filter((t) => t.name.toLowerCase().includes(q))
      .slice(0, 15)
      .map((t) => ({
        id: t.id,
        name: t.name,
        country: t.leagueName,
        crest: t.crest,
      }));

    const leagues = LEAGUES.filter((l) =>
      l.name.toLowerCase().includes(q)
    ).map((l) => ({ id: l.slug, name: l.name, country: null, logo: null }));

    res.json({ teams, leagues });
  } catch (err) {
    console.error("[api] error search:", err.message);
    res.status(502).json({ error: "No se pudo buscar (falló ESPN)" });
  }
});

// GET /api/teams/:id -> ficha del equipo.
app.get("/api/teams/:id", async (req, res) => {
  const { id } = req.params;
  const key = `team:${id}`;

  try {
    if (isExpired(key)) {
      const index = await getFreshTeamIndex();
      const entry = index.find((t) => String(t.id) === String(id));
      if (!entry) {
        return res.status(404).json({ error: "Equipo no encontrado" });
      }

      console.log(`[api] pidiendo ficha del equipo ${id} a ESPN...`);
      const profile = await fetchTeamProfile(id, entry.leagueSlug);
      setCached(key, profile, TEAM_PROFILE_TTL_MS);
    } else {
      console.log(`[api] sirviendo ficha del equipo ${id} desde cache`);
    }

    res.json(getCached(key));
  } catch (err) {
    console.error("[api] error team profile:", err.message);
    const stale = getCached(key);
    if (stale) return res.json({ ...stale, stale: true });
    res.status(502).json({ error: "No se pudo obtener el equipo de ESPN" });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// GET /api/leagues -> lista fija de ligas (para el panel de navegación).
// No pega contra ESPN, es la lista que configuramos en dataSource.js.
app.get("/api/leagues", (_req, res) => {
  res.json(LEAGUES);
});

// GET /api/leagues/:slug/standings -> tabla de posiciones completa.
app.get("/api/leagues/:slug/standings", async (req, res) => {
  const { slug } = req.params;
  const key = `standings:${slug}`;

  try {
    if (isExpired(key)) {
      console.log(`[api] pidiendo tabla de ${slug} a ESPN...`);
      const table = await fetchLeagueStandings(slug);
      setCached(key, table, STANDINGS_TTL_MS);
    } else {
      console.log(`[api] sirviendo tabla de ${slug} desde cache`);
    }

    const table = getCached(key);
    // table puede ser null legítimamente (competencia sin fase de tabla,
    // ej. una copa eliminatoria) — no es un error, se lo avisamos así al
    // frontend para que no muestre un cartel de error por las dudas.
    res.json({ standings: table });
  } catch (err) {
    console.error("[api] error standings:", err.message);
    res.status(502).json({ error: "No se pudo obtener la tabla de ESPN" });
  }
});

// GET /api/leagues/:slug/matches -> partidos de esa liga (una ventana de
// ~3 semanas alrededor de hoy), independiente del día seleccionado en el
// feed principal.
app.get("/api/leagues/:slug/matches", async (req, res) => {
  const { slug } = req.params;
  const league = LEAGUES.find((l) => l.slug === slug);
  if (!league) {
    return res.status(404).json({ error: "Liga no encontrada" });
  }

  const key = `league-matches:${slug}`;

  try {
    if (isExpired(key)) {
      console.log(`[api] pidiendo partidos de ${slug} a ESPN...`);
      const matches = await fetchLeagueMatches(slug, league.name);
      setCached(key, matches, LEAGUE_MATCHES_TTL_MS);
    } else {
      console.log(`[api] sirviendo partidos de ${slug} desde cache`);
    }

    const meta = getCachedMeta(key);
    res.json({
      updatedAt: new Date(meta.updatedAt).toISOString(),
      matches: meta.data,
    });
  } catch (err) {
    console.error("[api] error league matches:", err.message);
    const stale = getCachedMeta(key);
    if (stale) {
      return res.json({
        updatedAt: new Date(stale.updatedAt).toISOString(),
        matches: stale.data,
        stale: true,
      });
    }
    res.status(502).json({ error: "No se pudo obtener partidos de ESPN" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[server] escuchando en http://localhost:${PORT}`);
});
