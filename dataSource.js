// Todo lo que sepa sobre "cómo habla la API externa" vive acá adentro.
// Usamos API-Football (dashboard.api-football.com) directo — header
// "x-apisports-key" (NO es vía RapidAPI).
//
// Diseño pensado para el plan free (100 requests/día):
// - El feed de partidos por día usa /fixtures?date=X, que trae TODAS las
//   ligas del mundo en UNA sola llamada — ya no filtramos por país acá
//   adentro, el frontend agrupa por continente/juvenil/femenino con lo
//   que llega.
// - La búsqueda de ligas es local (no gasta requests): filtramos nuestra
//   propia lista fija.
// - Cada llamada pasa por el "quota guard" (quotaGuard.js), que corta
//   antes de llegar al límite diario.
//
// IMPORTANTE — qué NO se puede hacer en este plan: tabla de posiciones
// (/standings) y partidos de una liga por temporada (/fixtures?league=X
// &season=Y) están bloqueados para la temporada actual en el plan free
// ("Free plans do not have access to this season, try from 2022 to
// 2024" — error real de la API, no un bug nuestro). Por eso esas
// funciones no existen acá: no hay forma de arreglarlas con código,
// hace falta un plan pago de API-Football.

const { canMakeRequest, recordRequest, QuotaExceededError } = require("./quotaGuard");

const BASE_URL = "https://v3.football.api-sports.io";

// API-Football corta los "días" en UTC por default cuando filtrás por
// fecha (?date=X, ?from=X&to=Y) — un partido a las 21hs en Argentina
// (UTC-3) cae después de medianoche UTC, así que sin esto aparecía
// agrupado en el día siguiente. Este parámetro le dice a la API con qué
// zona horaria cortar los días.
const TIMEZONE = process.env.API_FOOTBALL_TIMEZONE || "America/Argentina/Buenos_Aires";

// Ligas conocidas para la búsqueda local (searchLeagues, más abajo) — no
// gasta requests, solo filtra este listado fijo.
const LEAGUES = [
  // --- Sudamérica ---
  {
    slug: "arg-liga-profesional",
    name: "Liga Profesional Argentina",
    country: "Argentina",
    region: "Sudamérica",
    aliases: ["Liga Profesional Argentina", "Liga Profesional", "Primera División"],
  },
  { slug: "arg-copa", name: "Copa Argentina", country: "Argentina", region: "Sudamérica", aliases: ["Copa Argentina"] },
  { slug: "bra-serieA", name: "Brasileirão", country: "Brazil", region: "Sudamérica", aliases: ["Serie A", "Brasileirão", "Brasileiro"] },
  {
    slug: "uru-primera",
    name: "Primera División",
    country: "Uruguay",
    region: "Sudamérica",
    aliases: ["Primera División", "Liga AUF Uruguaya", "Campeonato Uruguayo"],
  },
  {
    slug: "chi-primera",
    // Ojo: esta liga se rebrandeó de "Primera División" a "Liga de
    // Primera" hace unas temporadas — por eso el nombre de display y los
    // alias de búsqueda son distintos. Si en el futuro cambia de nuevo,
    // acá es donde hay que sumar el nombre nuevo.
    name: "Liga de Primera",
    country: "Chile",
    region: "Sudamérica",
    aliases: ["Liga de Primera", "Primera División", "Campeonato Nacional"],
  },
  // --- Europa ---
  { slug: "eng-premier", name: "Premier League", country: "England", region: "Europa", aliases: ["Premier League"] },
  { slug: "esp-laliga", name: "La Liga", country: "Spain", region: "Europa", aliases: ["La Liga", "Primera División", "LaLiga"] },
  { slug: "ita-seriea", name: "Serie A", country: "Italy", region: "Europa", aliases: ["Serie A"] },
  { slug: "ger-bundesliga", name: "Bundesliga", country: "Germany", region: "Europa", aliases: ["Bundesliga"] },
  { slug: "fra-ligue1", name: "Ligue 1", country: "France", region: "Europa", aliases: ["Ligue 1"] },
  { slug: "por-primeira", name: "Primeira Liga", country: "Portugal", region: "Europa", aliases: ["Primeira Liga", "Liga Portugal"] },
  { slug: "ned-eredivisie", name: "Eredivisie", country: "Netherlands", region: "Europa", aliases: ["Eredivisie"] },
  // --- Internacional (competencias continentales/globales, no de un solo país) ---
  { slug: "world-cup", name: "Mundial", country: "World", region: "Internacional", aliases: ["World Cup"] },
  { slug: "uefa-champions", name: "UEFA Champions League", country: "World", region: "Internacional", aliases: ["UEFA Champions League", "Champions League"] },
  { slug: "conmebol-libertadores", name: "Copa Libertadores", country: "World", region: "Internacional", aliases: ["Copa Libertadores", "CONMEBOL Libertadores"] },
  { slug: "conmebol-sudamericana", name: "Copa Sudamericana", country: "World", region: "Internacional", aliases: ["Copa Sudamericana", "CONMEBOL Sudamericana"] },
];

// El plan free de API-Football tiene, ADEMÁS del límite de 100/día, un
// límite de requests POR MINUTO (típicamente 10). El quotaGuard cuida el
// límite diario, pero no alcanza para evitar ráfagas cortas — por eso acá
// espaciamos cada request saliente con un mínimo de tiempo entre una y la
// siguiente, en una cola. Con 6.5s de espaciado como mínimo, el máximo
// posible es ~9 requests/minuto, por debajo del límite típico de 10.
const MIN_REQUEST_INTERVAL_MS = 6500;
let requestQueue = Promise.resolve();
let lastRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function throttledFetch(url, options) {
  const run = requestQueue.then(async () => {
    const wait = Math.max(0, lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now());
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return fetch(url, options);
  });
  // Encadenamos aunque falle, para que un error no trabe la cola entera.
  requestQueue = run.catch(() => {});
  return run;
}

async function apiGet(path, retriesLeft = 2) {
  if (!canMakeRequest()) {
    throw new QuotaExceededError();
  }

  const res = await throttledFetch(`${BASE_URL}${path}`, {
    headers: { "x-apisports-key": process.env.API_FOOTBALL_KEY },
  });
  recordRequest();

  // 429 = nos pasamos del límite por minuto, a pesar del espaciado (puede
  // pasar si hay ráfagas de varios usuarios a la vez). Esperamos un poco
  // y reintentamos, en vez de fallar directo — lo más probable es que la
  // siguiente vuelta ya funcione.
  if (res.status === 429 && retriesLeft > 0) {
    console.warn(`[dataSource] 429 (límite por minuto) en ${path}, reintentando...`);
    await sleep(8000);
    return apiGet(path, retriesLeft - 1);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API-Football respondió ${res.status}: ${body}`);
  }

  const data = await res.json();

  if (data.errors && Object.keys(data.errors).length > 0) {
    throw new Error(`API-Football error: ${JSON.stringify(data.errors)}`);
  }

  return data.response || [];
}

function statusFromApi(shortCode) {
  const LIVE = ["1H", "HT", "2H", "ET", "BT", "P", "LIVE"];
  const FINISHED = ["FT", "AET", "PEN"];
  const OFF = ["PST", "CANC", "ABD", "SUSP", "AWD", "WO"];

  if (LIVE.includes(shortCode)) return "live";
  if (FINISHED.includes(shortCode)) return "final";
  if (OFF.includes(shortCode)) return "postponed";
  return "scheduled";
}

function abbreviate(name) {
  return name
    .replace(/FC|CF|AFC|United|City|Club|Atlético|Atletico/gi, "")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 3)
    .toUpperCase();
}

function normalizeMatch(raw) {
  const status = statusFromApi(raw.fixture.status.short);
  const hasScore = status !== "scheduled";

  return {
    id: raw.fixture.id,
    league: raw.league.name,
    leagueId: raw.league.id,
    leagueCountry: raw.league.country,
    status,
    home: raw.teams.home.name,
    homeId: raw.teams.home.id,
    homeAb: abbreviate(raw.teams.home.name),
    homeCrest: raw.teams.home.logo || null,
    away: raw.teams.away.name,
    awayId: raw.teams.away.id,
    awayAb: abbreviate(raw.teams.away.name),
    awayCrest: raw.teams.away.logo || null,
    scoreHome: hasScore ? raw.goals.home ?? null : null,
    scoreAway: hasScore ? raw.goals.away ?? null : null,
    start: raw.fixture.date,
    prob: null,
  };
}

// TODOS los partidos de TODAS las ligas para un día puntual, en UNA sola
// llamada a la API. Es la joya de la corona de esta versión: el feed de
// "todas las ligas disponibles" cuesta 1 request, no 14.
async function fetchMatchesForDate(dateStr) {
  const response = await apiGet(
    `/fixtures?date=${dateStr}&timezone=${encodeURIComponent(TIMEZONE)}`
  );

  return response.map(normalizeMatch).sort((a, b) => a.start.localeCompare(b.start));
}

// Busca equipos por nombre. 1 request por texto de búsqueda (se cachea
// por texto desde server.js).
async function searchTeams(query) {
  const response = await apiGet(`/teams?search=${encodeURIComponent(query)}`);
  return response.map((item) => ({
    id: item.team.id,
    name: item.team.name,
    country: item.team.country,
    crest: item.team.logo || null,
  }));
}

// Búsqueda de ligas: NO gasta requests — filtra nuestra propia lista fija,
// por nombre de display o por cualquiera de sus alias.
function searchLeagues(query) {
  const q = query.toLowerCase();
  return LEAGUES.filter(
    (l) =>
      l.name.toLowerCase().includes(q) ||
      (l.aliases || []).some((a) => a.toLowerCase().includes(q))
  ).map((l) => ({
    id: l.slug,
    name: l.name,
    country: l.country,
    logo: null,
  }));
}

// Ficha de equipo: info + plantel. 2 requests, cacheado 24hs desde
// server.js.
//
// IMPORTANTE: "últimos partidos" (recentForm) YA NO EXISTE ACÁ. Usaba
// /fixtures?team=X&last=5, y el plan free bloqueó el parámetro "last"
// ("Free plans do not have access to the Last parameter") — y no hay
// vuelta: CUALQUIER /fixtures?team=X sin un "date" o "id" puntual pide
// season, y season de la temporada actual también está bloqueada en
// este plan (mismo problema que standings). No es un bug, es el límite
// real de la cuenta gratuita.
async function fetchTeamProfile(teamId) {
  const [infoRes, squadRes] = await Promise.all([
    apiGet(`/teams?id=${teamId}`),
    apiGet(`/players/squads?team=${teamId}`),
  ]);

  const info = infoRes[0];
  if (!info) throw new Error("Equipo no encontrado");

  const squad = (squadRes[0]?.players || []).map((p) => ({
    id: p.id,
    name: p.name,
    number: p.number,
    position: p.position,
    age: p.age,
    photo: p.photo || null,
  }));

  return {
    id: info.team.id,
    name: info.team.name,
    country: info.team.country,
    founded: info.team.founded || null,
    crest: info.team.logo || null,
    venue: info.venue
      ? {
          name: info.venue.name || null,
          city: info.venue.city || null,
          capacity: info.venue.capacity || null,
          image: info.venue.image || null,
        }
      : null,
    squad,
  };
}

// Pronóstico (% local/empate/visitante) para un partido puntual. Solo
// tiene sentido antes de que arranque — confirmado que el plan free SÍ
// da acceso a este endpoint (a diferencia de standings).
async function fetchPredictions(matchId) {
  try {
    const response = await apiGet(`/predictions?fixture=${matchId}`);
    const pred = response[0]?.predictions;
    if (!pred?.percent) return null;

    const toNumber = (s) => (s ? parseFloat(s.replace("%", "")) : null);
    const home = toNumber(pred.percent.home);
    const draw = toNumber(pred.percent.draw);
    const away = toNumber(pred.percent.away);
    if (home == null || draw == null || away == null) return null;

    return { home, draw, away, advice: pred.advice || null };
  } catch (err) {
    console.error(`[dataSource] no se pudo obtener pronóstico del partido ${matchId}:`, err.message);
    return null;
  }
}

// Detalle de UN partido: info base (1 request) + estadísticas (1, solo si
// ya arrancó) + alineación (1, real o probable según el momento) +
// pronóstico (1, solo si todavía no arrancó). Hasta 4 requests, cacheado
// 2 min desde server.js.
async function fetchMatchDetail(matchId) {
  const infoRes = await apiGet(`/fixtures?id=${matchId}`);
  const info = infoRes[0];
  if (!info) throw new Error("Partido no encontrado");

  const status = statusFromApi(info.fixture.status.short);
  const hasScore = status !== "scheduled";

  let statistics = null;
  if (status !== "scheduled") {
    const statsRes = await apiGet(`/fixtures/statistics?fixture=${matchId}`);
    if (statsRes.length === 2) {
      const [homeStats, awayStats] = statsRes;
      statistics = homeStats.statistics
        .map((s, i) => ({
          label: s.type,
          home: s.value,
          away: awayStats.statistics[i]?.value ?? null,
        }))
        .filter((row) => row.home !== null || row.away !== null);
    }
  }

  let lineups = null;
  try {
    const lineupsRes = await apiGet(`/fixtures/lineups?fixture=${matchId}`);
    if (lineupsRes.length === 2) {
      // "grid" viene como "fila:columna" (fila 1 = arquero, crece hacia
      // adelante) — es lo que el frontend usa para dibujar la cancha con
      // cada titular en su posición real. No todas las ligas la tienen
      // cargada; cuando falta, el frontend arma las filas a partir de la
      // formación ("4-4-2") como respaldo.
      const buildSide = (side) => ({
        teamId: side.team.id,
        teamName: side.team.name,
        formation: side.formation || null,
        starters: (side.startXI || []).map((p) => ({
          id: p.player.id,
          name: p.player.name,
          number: p.player.number,
          position: p.player.pos,
          grid: p.player.grid || null,
        })),
      });
      const home = lineupsRes.find((s) => s.team.id === info.teams.home.id);
      const away = lineupsRes.find((s) => s.team.id === info.teams.away.id);
      if (home?.startXI?.length || away?.startXI?.length) {
        lineups = { home: buildSide(home), away: buildSide(away) };
      }
    }
  } catch (err) {
    console.error(`[dataSource] no se pudo obtener alineación del partido ${matchId}:`, err.message);
  }

  const predictions = status === "scheduled" ? await fetchPredictions(matchId) : null;

  return {
    id: matchId,
    status,
    home: {
      id: info.teams.home.id,
      name: info.teams.home.name,
      crest: info.teams.home.logo || null,
      score: hasScore ? info.goals.home : null,
    },
    away: {
      id: info.teams.away.id,
      name: info.teams.away.name,
      crest: info.teams.away.logo || null,
      score: hasScore ? info.goals.away : null,
    },
    start: info.fixture.date,
    statistics,
    lineups,
    lineupsAreProbable: status === "scheduled",
    predictions,
  };
}

module.exports = {
  fetchMatchesForDate,
  searchTeams,
  searchLeagues,
  fetchTeamProfile,
  fetchMatchDetail,
  LEAGUES,
};
