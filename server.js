require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { fetchMatchesForDate } = require("./dataSource");
const { getCached, setCached, isExpired } = require("./cache");

const app = express();
app.use(cors()); // el frontend puede vivir en otro origen (Vercel, file://, etc.)

// GET /api/matches?date=2026-08-16
// Trae de cache si está fresco; si no, le pide a la API externa UNA vez
// para esa fecha y lo guarda. Así cuidamos la cuota diaria del plan free.
app.get("/api/matches", async (req, res) => {
  const { date } = req.query;

  if (!date) {
    return res
      .status(400)
      .json({ error: "Falta el parámetro ?date=YYYY-MM-DD" });
  }

  try {
    if (isExpired(date)) {
      console.log(`[api] pidiendo ${date} a la API externa...`);
      const matches = await fetchMatchesForDate(date);
      setCached(date, matches);
    } else {
      console.log(`[api] sirviendo ${date} desde cache`);
    }

    const cached = getCached(date);
    res.json({
      updatedAt: new Date(cached.updatedAt).toISOString(),
      matches: cached.matches,
    });
  } catch (err) {
    console.error("[api] error:", err.message);

    // Si falló pero YA teníamos un dato viejo en cache, mejor devolver eso
    // (aunque esté vencido) que dejar al usuario sin nada.
    const stale = getCached(date);
    if (stale) {
      return res.json({
        updatedAt: new Date(stale.updatedAt).toISOString(),
        matches: stale.matches,
        stale: true,
      });
    }

    res.status(502).json({ error: "No se pudo obtener partidos de la API externa" });
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`[server] escuchando en http://localhost:${PORT}`);
});
