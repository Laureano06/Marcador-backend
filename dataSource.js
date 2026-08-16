// Todo lo que sepa sobre "cómo habla la API externa" vive acá adentro.
// Usamos API-Football (dashboard.api-football.com), NO vía RapidAPI —
// por eso el header es "x-apisports-key" y no hace falta "x-rapidapi-host".

const BASE_URL = "https://v3.football.api-sports.io";

// En vez de armar una lista de IDs de liga a mano (fácil de equivocarse,
// y si te equivocás un partido simplemente no aparece sin ningún error
// que te avise), filtramos por PAÍS — es un campo de texto que la API
// siempre manda tal cual, mucho más difícil de arruinar que adivinar
// números de ID.
//
// Agregá o sacá países acá según lo que quieras ver. "World" incluye
// competencias internacionales como el Mundial.
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
];

function statusFromApi(shortCode) {
  // Códigos reales de API-Football (texto, no números):
  // https://www.api-football.com/documentation-v3#operation/get-fixtures
  const LIVE = ["1H", "HT", "2H", "ET", "BT", "P", "LIVE"];
  const FINISHED = ["FT", "AET", "PEN"];
  const OFF = ["PST", "CANC", "ABD", "SUSP", "AWD", "WO"];

  if (LIVE.includes(shortCode)) return "live";
  if (FINISHED.includes(shortCode)) return "final";
  if (OFF.includes(shortCode)) return "postponed";
  return "scheduled"; // NS y cualquier otro caso
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

// Convierte un partido crudo de API-Football al shape que usa el frontend.
function normalizeMatch(raw) {
  return {
    id: raw.fixture.id,
    league: raw.league.name,
    leagueId: raw.league.id,
    leagueCountry: raw.league.country,
    status: statusFromApi(raw.fixture.status.short),
    home: raw.teams.home.name,
    homeId: raw.teams.home.id,
    homeAb: abbreviate(raw.teams.home.name),
    homeCrest: raw.teams.home.logo || null,
    away: raw.teams.away.name,
    awayId: raw.teams.away.id,
    awayAb: abbreviate(raw.teams.away.name),
    awayCrest: raw.teams.away.logo || null,
    scoreHome: raw.goals.home ?? null,
    scoreAway: raw.goals.away ?? null,
    start: raw.fixture.date,
    // El plan free de API-Football no incluye probabilidades en este
    // endpoint (existe /odds aparte, pero consume cuota extra).
    prob: null,
  };
}

// Trae TODOS los partidos de TODAS las ligas para UN día puntual.
// Ojo: /fixtures?date=X devuelve fixtures de TODO el mundo (miles),
// por eso filtramos por país acá mismo antes de devolver.
async function fetchMatchesForDate(dateStr) {
  const url = `${BASE_URL}/fixtures?date=${dateStr}`;

  const res = await fetch(url, {
    headers: { "x-apisports-key": process.env.API_FOOTBALL_KEY },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API-Football respondió ${res.status}: ${body}`);
  }

  const data = await res.json();

  // API-Football devuelve errores propios con status 200 igual, hay que
  // revisar el campo "errors" del body (ej: key inválida, cuota agotada).
  if (data.errors && Object.keys(data.errors).length > 0) {
    throw new Error(`API-Football error: ${JSON.stringify(data.errors)}`);
  }

  const matches = (data.response || [])
    .filter((raw) => INCLUDE_COUNTRIES.includes(raw.league.country))
    .map(normalizeMatch)
    .sort((a, b) => a.start.localeCompare(b.start));

  return matches;
}

module.exports = {
  fetchMatchesForDate,
  searchTeams,
  searchLeagues,
  fetchTeamProfile,
  INCLUDE_COUNTRIES,
};

async function apiGet(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "x-apisports-key": process.env.API_FOOTBALL_KEY },
  });

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

// Busca equipos por nombre. Devuelve solo lo necesario para mostrar en un
// resultado de búsqueda (id, nombre, escudo, país) — la ficha completa se
// pide aparte, cuando el usuario entra al equipo.
async function searchTeams(query) {
  const response = await apiGet(`/teams?search=${encodeURIComponent(query)}`);
  return response.map((item) => ({
    id: item.team.id,
    name: item.team.name,
    country: item.team.country,
    crest: item.team.logo || null,
  }));
}

// Busca ligas/competencias por nombre.
async function searchLeagues(query) {
  const response = await apiGet(
    `/leagues?search=${encodeURIComponent(query)}`
  );
  return response.map((item) => ({
    id: item.league.id,
    name: item.league.name,
    country: item.country?.name || null,
    logo: item.league.logo || null,
  }));
}

function statusIsFinished(shortCode) {
  return ["FT", "AET", "PEN"].includes(shortCode);
}

// Ficha de equipo: info básica + plantel + últimos partidos jugados.
// Nota: la "estadística de temporada" completa de API-Football (goles,
// posesión, etc.) pide liga+temporada específica por partido, así que acá
// mostramos la forma reciente (últimos 5 resultados) como indicador de
// rendimiento, que no necesita adivinar en qué liga/temporada mirar.
async function fetchTeamProfile(teamId) {
  const [teamInfoRes, squadRes, recentFixturesRes] = await Promise.all([
    apiGet(`/teams?id=${teamId}`),
    apiGet(`/players/squads?team=${teamId}`),
    apiGet(`/fixtures?team=${teamId}&last=5`),
  ]);

  const info = teamInfoRes[0];
  if (!info) {
    throw new Error("Equipo no encontrado");
  }

  const squad = (squadRes[0]?.players || []).map((p) => ({
    id: p.id,
    name: p.name,
    number: p.number,
    position: p.position,
    age: p.age,
    photo: p.photo || null,
  }));

  const recentForm = recentFixturesRes
    .filter((f) => statusIsFinished(f.fixture.status.short))
    .map((f) => {
      const isHome = f.teams.home.id === Number(teamId);
      const goalsFor = isHome ? f.goals.home : f.goals.away;
      const goalsAgainst = isHome ? f.goals.away : f.goals.home;
      const opponent = isHome ? f.teams.away.name : f.teams.home.name;

      let result = "E"; // Empate
      if (goalsFor > goalsAgainst) result = "G"; // Ganó
      if (goalsFor < goalsAgainst) result = "P"; // Perdió

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
    recentForm,
  };
}
