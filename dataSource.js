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
    leagueCountry: raw.league.country,
    status: statusFromApi(raw.fixture.status.short),
    home: raw.teams.home.name,
    homeAb: abbreviate(raw.teams.home.name),
    homeCrest: raw.teams.home.logo || null,
    away: raw.teams.away.name,
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

module.exports = { fetchMatchesForDate, INCLUDE_COUNTRIES };
