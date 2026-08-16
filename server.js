require("dotenv").config();
const express = require("express");
const cors = require("cors");
const {
  fetchMatchesForDate,
  searchTeams,
  searchLeagues,
  fetchTeamProfile,
} = require("./dataSource");
const { getCached, getCachedMeta, setCached, isExpired } = require("./cache");

const app = express();
app.use(cors()); // el frontend puede vivir en otro origen (Vercel, file://, etc.)

// TTLs pensados para cuidar la cuota del plan free (100 requests/día):
// los partidos de un día cambian seguido, los planteles y búsquedas casi
// nunca, así que se cachean mucho más tiempo.
const MATCHES_TTL_MS = Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000); // 5 min
const SEARCH_TTL_MS = 30 * 60 * 1000; // 30 min
const TEAM_PROFILE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hs

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
      console.log(`[api] pidiendo partidos de ${date} a la API externa...`);
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
    res
      .status(502)
      .json({ error: "No se pudo obtener partidos de la API externa" });
  }
});

// GET /api/search?q=boca
// Busca equipos y ligas a la vez. Se cachea por texto de búsqueda para no
// gastar cuota si mucha gente busca lo mismo (o la misma persona repite
// la búsqueda).
app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").trim();

  if (q.length < 3) {
    return res
      .status(400)
      .json({ error: "La búsqueda necesita al menos 3 caracteres" });
  }

  const key = `search:${q.toLowerCase()}`;

  try {
    if (isExpired(key)) {
      console.log(`[api] buscando "${q}" en la API externa...`);
      const [teams, leagues] = await Promise.all([
        searchTeams(q),
        searchLeagues(q),
      ]);
      setCached(key, { teams, leagues }, SEARCH_TTL_MS);
    } else {
      console.log(`[api] sirviendo búsqueda "${q}" desde cache`);
    }

    res.json(getCached(key));
  } catch (err) {
    console.error("[api] error search:", err.message);
    res.status(502).json({ error: "No se pudo buscar en la API externa" });
  }
});

// GET /api/teams/:id -> ficha del equipo: info, plantel, últimos partidos.
app.get("/api/teams/:id", async (req, res) => {
  const { id } = req.params;
  const key = `team:${id}`;

  try {
    if (isExpired(key)) {
      console.log(`[api] pidiendo ficha del equipo ${id} a la API externa...`);
      const profile = await fetchTeamProfile(id);
      setCached(key, profile, TEAM_PROFILE_TTL_MS);
    } else {
      console.log(`[api] sirviendo ficha del equipo ${id} desde cache`);
    }

    res.json(getCached(key));
  } catch (err) {
    console.error("[api] error team profile:", err.message);
    const stale = getCached(key);
    if (stale) {
      return res.json({ ...stale, stale: true });
    }
    res
      .status(502)
      .json({ error: "No se pudo obtener el equipo de la API externa" });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[server] escuchando en http://localhost:${PORT}`);
});
