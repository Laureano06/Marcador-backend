// Todo lo que sepa sobre "cómo habla la API externa" vive acá adentro.
// Usamos API-Football (dashboard.api-football.com) directo — header
// "x-apisports-key" (NO es vía RapidAPI).
//
// Diseño pensado para el plan free (100 requests/día):
// - El feed de partidos por día usa /fixtures?date=X, que trae TODAS las
//   ligas del mundo en UNA sola llamada. Filtramos por país acá adentro,
//   no le pedimos a la API liga por liga.
// - La búsqueda de ligas es local (no gasta requests): filtramos nuestra
//   propia lista fija.
// - Lo único que necesita el ID numérico de liga de API-Football (tabla
//   de posiciones, partidos de una liga puntual) lo resuelve una vez y
//   lo cachea casi para siempre (90 días) — no lo volvemos a pedir.
// - Cada llamada pasa por el "quota guard" (quotaGuard.js), que corta
//   antes de llegar al límite diario.

const { canMakeRequest, recordRequest, QuotaExceededError } = require("./quotaGuard");

const BASE_URL = "https://v3.football.api-sports.io";

// Temporada "actual" para los endpoints que la piden (standings,
// fixtures por liga). API-Football nombra la temporada por el año en que
// arrancó (la 2026-27 europea es "2026"). Como el año calendario no
// siempre coincide prolijamente con el arranque de cada torneo, dejamos
// esto configurable por variable de entorno para no tener que tocar
// código si hay que ajustarlo.
const SEASON = Number(process.env.API_FOOTBALL_SEASON || new Date().getFullYear());

// API-Football corta los "días" en UTC por default cuando filtrás por
// fecha (?date=X, ?from=X&to=Y) — un partido a las 21hs en Argentina
// (UTC-3) cae después de medianoche UTC, así que sin esto aparecía
// agrupado en el día siguiente. Este parámetro le dice a la API con qué
// zona horaria cortar los días.
const TIMEZONE = process.env.API_FOOTBALL_TIMEZONE || "America/Argentina/Buenos_Aires";

// País por país, en vez de ID de liga por ID de liga — mucho más difícil
// de arruinar (ver charla anterior sobre por qué). Cubre lo que se ve en
// el feed principal de "todas las ligas".
const INCLUDE_COUNTRIES = [
  "Argentina",
  "World",
  "England",
  "Spain",
  "Italy",
  "Germany",
  "France",
  "Brazil",
  "Portugal",
  "Netherlands",
  "Uruguay",
  "Chile",
];

// Ligas para el panel lateral / página de liga (tabla + partidos propios).
// Estas SÍ necesitan un ID numérico de API-Football, que se resuelve la
// primera vez que se pide cada una (ver resolveLeagueId) y se cachea
// larguísimo desde server.js.
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

  return response
    .filter((raw) => INCLUDE_COUNTRIES.includes(raw.league.country))
    .map(normalizeMatch)
    .sort((a, b) => a.start.localeCompare(b.start));
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

// Búsqueda de ligas: NO gasta requests — filtra nuestra propia lista fija.
function searchLeagues(query) {
  const q = query.toLowerCase();
  return LEAGUES.filter((l) => l.name.toLowerCase().includes(q)).map((l) => ({
    id: l.slug,
    name: l.name,
    country: l.country,
    logo: null,
  }));
}

// Resuelve el ID numérico de API-Football para una de nuestras ligas
// configuradas (por nombre + país). Se llama UNA vez por liga — el
// resultado se cachea larguísimo desde server.js, así que en la práctica
// esto se paga una sola vez por liga, para siempre.
async function resolveLeagueId(league) {
  const response = await apiGet(
    `/leagues?country=${encodeURIComponent(league.country === "World" ? "" : league.country)}&search=${encodeURIComponent(league.name)}`
  );

  if (response.length === 0) {
    console.error(
      `[dataSource] no se encontró la liga "${league.name}" (${league.country}) en API-Football`
    );
    return null;
  }

  // Preferimos una coincidencia de nombre exacta (insensible a mayúsculas);
  // si no hay, nos quedamos con el primer resultado.
  const exact = response.find(
    (r) => r.league.name.toLowerCase() === league.name.toLowerCase()
  );
  const chosen = exact || response[0];

  return chosen.league.id;
}

// Tabla de posiciones completa de una liga (ya resuelto su ID numérico).
async function fetchLeagueStandings(leagueId) {
  try {
    const response = await apiGet(
      `/standings?league=${leagueId}&season=${SEASON}`
    );
    const table = response[0]?.league?.standings?.[0];
    if (!table) return null;

    return table.map((row) => ({
      teamId: row.team.id,
      teamName: row.team.name,
      crest: row.team.logo || null,
      rank: row.rank,
      played: row.all.played,
      wins: row.all.win,
      draws: row.all.draw,
      losses: row.all.lose,
      goalsFor: row.all.goals.for,
      goalsAgainst: row.all.goals.against,
      points: row.points,
    }));
  } catch (err) {
    // Copas eliminatorias u otras competencias sin tabla de posiciones
    // devuelven una respuesta vacía — no es un error real.
    console.error(`[dataSource] no se pudo obtener tabla de liga ${leagueId}:`, err.message);
    return null;
  }
}

// Partidos de UNA liga en una ventana de fechas (para la pestaña
// "Partidos" de la página de liga).
async function fetchLeagueMatches(leagueId, daysPast = 7, daysFuture = 14) {
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - daysPast);
  const to = new Date(today);
  to.setDate(to.getDate() + daysFuture);

  const iso = (d) => d.toISOString().slice(0, 10);

  const response = await apiGet(
    `/fixtures?league=${leagueId}&season=${SEASON}&from=${iso(from)}&to=${iso(to)}&timezone=${encodeURIComponent(TIMEZONE)}`
  );

  return response.map(normalizeMatch).sort((a, b) => a.start.localeCompare(b.start));
}

// Ficha de equipo: info + plantel + últimos 5 partidos jugados.
// 3 requests (info, plantel, últimos partidos) — cacheado 24hs desde
// server.js, así que es barato en la práctica.
async function fetchTeamProfile(teamId) {
  const [infoRes, squadRes, recentFixturesRes] = await Promise.all([
    apiGet(`/teams?id=${teamId}`),
    apiGet(`/players/squads?team=${teamId}`),
    apiGet(`/fixtures?team=${teamId}&last=5`),
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

  const recentForm = recentFixturesRes
    .filter((f) => ["FT", "AET", "PEN"].includes(f.fixture.status.short))
    .map((f) => {
      const isHome = f.teams.home.id === Number(teamId);
      const goalsFor = isHome ? f.goals.home : f.goals.away;
      const goalsAgainst = isHome ? f.goals.away : f.goals.home;
      const opponent = isHome ? f.teams.away.name : f.teams.home.name;

      let result = "E";
      if (goalsFor > goalsAgainst) result = "G";
      if (goalsFor < goalsAgainst) result = "P";

      return {
        opponent,
        goalsFor,
        goalsAgainst,
        result,
        date: f.fixture.date,
        league: f.league.name,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  // No hay un endpoint que diga "la liga principal de este equipo" —
  // un club puede jugar varias competencias a la vez (liga local + copa
  // internacional, por ejemplo). Usamos el partido más reciente como
  // mejor estimación de su liga "de todos los días", matcheando el
  // nombre contra nuestra lista configurada. No cuesta ninguna request
  // extra: ya tenemos recentForm de arriba.
  const guessedLeagueName = recentForm[0]?.league;
  const matchedLeague = guessedLeagueName
    ? LEAGUES.find((l) => l.name.toLowerCase() === guessedLeagueName.toLowerCase())
    : null;

  return {
    id: info.team.id,
    name: info.team.name,
    country: info.team.country,
    founded: info.team.founded || null,
    crest: info.team.logo || null,
    leagueSlug: matchedLeague?.slug || null,
    leagueName: matchedLeague?.name || null,
    venue: info.venue
      ? {
          name: info.venue.name || null,
          city: info.venue.city || null,
          capacity: info.venue.capacity || null,
          image: info.venue.image || null,
        }
      : null,
    squad,
    recentForm,
  };
}

// Detalle de UN partido: info base (1 request) + estadísticas (1, solo si
// ya arrancó) + alineación (1, real o probable según el momento). Hasta
// 3 requests, cacheado 2 min desde server.js.
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
      const buildSide = (side) => ({
        teamId: side.team.id,
        teamName: side.team.name,
        formation: side.formation || null,
        starters: (side.startXI || []).map((p) => ({
          id: p.player.id,
          name: p.player.name,
          number: p.player.number,
          position: p.player.pos,
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
  };
}

module.exports = {
  fetchMatchesForDate,
  searchTeams,
  searchLeagues,
  resolveLeagueId,
  fetchLeagueStandings,
  fetchLeagueMatches,
  fetchTeamProfile,
  fetchMatchDetail,
  LEAGUES,
};
