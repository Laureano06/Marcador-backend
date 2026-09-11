// Todo lo que sepa sobre "cómo habla la API externa" vive acá adentro.
// Usamos BSD (Bzzoiro Sports Data, sports.bzzoiro.com) — header
// "Authorization: Token TU_KEY". Migrado desde API-Football el 3/9/2026:
// esa cuenta terminó suspendida y su plan free bloqueaba standings y
// "últimos partidos" de temporada actual sin arreglo posible. BSD da
// 7.500 requests/día (vs 100) y SÍ incluye standings de temporada actual
// en el plan free de fútbol.
//
// - El feed de partidos por día usa /events/?date_from=X&date_to=X, que
//   trae TODAS las ligas cubiertas en una sola llamada (paginado si hace
//   falta). Cada evento solo trae league_id (no nombre/país) — por eso
//   mantenemos un directorio de ligas (getLeagueDirectory) cacheado 24hs
//   en memoria, para no resolver cada liga por separado.
// - La búsqueda de ligas usa ese mismo directorio (ya cacheado, no gasta
//   una request nueva salvo la primera vez del día).
// - Los escudos y fotos salen directo de la Image API por id
//   (sports.bzzoiro.com/img/...), sin request extra: no hace falta pedir
//   una URL de logo, se arma sola.
// - Cada llamada pasa por el "quota guard" (quotaGuard.js), que corta
//   antes de llegar al límite diario y detecta cuenta bloqueada.

const {
  canMakeRequest,
  recordRequest,
  markExhausted,
  QuotaExceededError,
  accountBlockedInfo,
  markAccountBlocked,
  AccountBlockedError,
} = require("./quotaGuard");

const BASE_URL = "https://sports.bzzoiro.com/api/v2";
const IMG_BASE = "https://sports.bzzoiro.com/img";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Los endpoints de lista de BSD a veces devuelven un array plano y a veces
// el sobre paginado {count, next, previous, results} (confirmado
// inconsistente entre lo que documenta la guía y el schema OpenAPI) —
// manejamos los dos casos acá en un solo lugar en vez de repetir el
// chequeo en cada función.
function listItems(json) {
  if (Array.isArray(json)) return json;
  return json?.results || [];
}

async function apiGet(path, retriesLeft = 3) {
  if (!canMakeRequest()) {
    throw new QuotaExceededError();
  }
  // Cuenta marcada como bloqueada (token inválido/revocado, etc) — no
  // reintentamos: eso no se arregla solo, y seguir pegándole solo gasta
  // contador contra una cuenta que ya sabemos que va a rechazar todo.
  const blocked = accountBlockedInfo();
  if (blocked) {
    throw new AccountBlockedError(blocked.reason);
  }

  // Fallback a API_FOOTBALL_KEY: nombre viejo de la variable, por si
  // alguien pegó la key nueva de BSD ahí en vez de crear BSD_API_KEY.
  const apiKey = process.env.BSD_API_KEY || process.env.API_FOOTBALL_KEY;
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Token ${apiKey}` },
  });
  recordRequest();

  // BSD separa DOS límites de 429 por "code", y quieren reacciones
  // opuestas (ver docs/conventions): "rate_limited" es la ráfaga por IP
  // (25/seg) — pasajera, un reintento corto alcanza. "taster_exhausted"
  // es la cuota DIARIA real de la cuenta agotada — reintentar no sirve de
  // nada hasta medianoche UTC, hay que sincronizar el guard y cortar.
  if (res.status === 429) {
    let body = {};
    try {
      body = await res.json();
    } catch {
      // sin body parseable, tratamos como ráfaga (el caso más común)
    }
    if (body.code === "taster_exhausted") {
      markExhausted();
      throw new QuotaExceededError();
    }
    if (retriesLeft > 0) {
      const retryAfter = Number(res.headers.get("retry-after")) || 1;
      await sleep((retryAfter + 0.2) * 1000);
      return apiGet(path, retriesLeft - 1);
    }
    throw new Error("BSD: límite de ráfaga por IP superado, reintentos agotados");
  }

  // Token faltante o inválido — afecta CUALQUIER llamada por igual, tiene
  // sentido cortar todo por un rato en vez de romper endpoint por
  // endpoint (mismo criterio que "access"/"token" tenía con API-Football).
  if (res.status === 401) {
    markAccountBlocked("Token inválido o faltante (401) — revisá BSD_API_KEY en el .env");
    throw new AccountBlockedError("Token inválido o faltante");
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body.detail || JSON.stringify(body);
    } catch {
      detail = await res.text().catch(() => "");
    }
    throw new Error(`BSD respondió ${res.status}${detail ? `: ${detail}` : ""}`);
  }

  return res.json();
}

// Directorio completo de ligas (id -> {name, country, ...}), cacheado en
// memoria 24hs. Los eventos solo traen league_id — sin esto habría que
// resolver cada liga por separado, y un día con 50+ ligas activas
// costaría 50+ requests extra en vez de una sola carga diaria.
let leagueDirectory = null;
let leagueDirectoryAt = 0;
const LEAGUE_DIRECTORY_TTL_MS = 24 * 60 * 60 * 1000;

async function getLeagueDirectory() {
  if (leagueDirectory && Date.now() - leagueDirectoryAt < LEAGUE_DIRECTORY_TTL_MS) {
    return leagueDirectory;
  }

  const all = [];
  let offset = 0;
  // Tope de 10 páginas (2000 ligas) como red de seguridad — "30+ leagues"
  // según la doc, en la práctica esto entra en una sola página.
  for (let page = 0; page < 10; page++) {
    const json = await apiGet(`/leagues/?limit=200&offset=${offset}`);
    const items = listItems(json);
    all.push(...items);
    if (items.length < 200) break;
    offset += 200;
  }

  leagueDirectory = new Map(all.map((l) => [l.id, l]));
  leagueDirectoryAt = Date.now();
  return leagueDirectory;
}

function statusFromBsd(status) {
  const LIVE = new Set(["inprogress", "1st_half", "halftime", "2nd_half", "extra_time", "penalties", "live"]);
  const FINISHED = new Set(["finished", "aet", "pen"]);
  const OFF = new Set(["postponed", "cancelled", "unresolved", "abandoned"]);

  if (LIVE.has(status)) return "live";
  if (FINISHED.has(status)) return "final";
  if (OFF.has(status)) return "postponed";
  return "scheduled"; // notstarted
}

// Traduce el período de BSD al mismo código corto que ya entendía el
// frontend (utils.js: liveMinuteLabel, pensado en su momento para los
// códigos de API-Football) — así esa lógica no tuvo que tocarse.
const PERIOD_TO_SHORT = {
  "1st_half": "1H",
  halftime: "HT",
  "2nd_half": "2H",
  extra_time: "ET",
  penalties: "P",
};
function periodToShortCode(period) {
  return PERIOD_TO_SHORT[period] || null;
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

function crestUrl(teamId) {
  return teamId ? `${IMG_BASE}/team/${teamId}/?bg=transparent` : null;
}

function normalizeMatch(raw, leagues) {
  const status = statusFromBsd(raw.status);
  const hasScore = status !== "scheduled";
  const isLive = status === "live";
  const league = leagues.get(raw.league_id);

  return {
    id: raw.id,
    league: league?.name || "Otras competencias",
    leagueId: raw.league_id,
    leagueCountry: league?.country || "World",
    status,
    elapsed: isLive ? raw.current_minute ?? null : null,
    // raw.period trae la fase en texto localizado de BSD ("1T", "2T" —
    // no encaja con PERIOD_TO_SHORT, pensado para los valores en inglés
    // de raw.status). raw.status SÍ usa exactamente esos códigos
    // ("1st_half", "halftime", "2nd_half", etc. — confirmado contra una
    // respuesta real), así que es la fuente correcta acá. Con el period
    // como primera opción, "DESC" (halftime) y "PENALES" no aparecían
    // nunca: la key nunca calzaba con ningún valor de PERIOD_TO_SHORT.
    statusShort: isLive ? periodToShortCode(raw.status) : null,
    home: raw.home_team,
    homeId: raw.home_team_id,
    homeAb: abbreviate(raw.home_team),
    homeCrest: crestUrl(raw.home_team_id),
    away: raw.away_team,
    awayId: raw.away_team_id,
    awayAb: abbreviate(raw.away_team),
    awayCrest: crestUrl(raw.away_team_id),
    scoreHome: hasScore ? raw.home_score ?? null : null,
    scoreAway: hasScore ? raw.away_score ?? null : null,
    start: raw.event_date,
    prob: null,
  };
}

// Mismo valor que TIMEZONE en server.js (duplicado a propósito: server.js
// requiere este archivo, no al revés — importarlo de vuelta crearía una
// dependencia circular por un solo string). Si se cambia acá, cambiar
// también allá.
const APP_TIMEZONE =
  process.env.APP_TIMEZONE || process.env.API_FOOTBALL_TIMEZONE || "America/Argentina/Buenos_Aires";
const ARG_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: APP_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function addUtcDay(dateStr, delta = 1) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

// BSD filtra date_from/date_to por el día CALENDARIO UTC del evento, no
// por el día calendario de Argentina — confirmado en producción el
// 11/9/2026: un partido de las 21:30 hora Argentina (Independiente del
// Valle 0-2 Flamengo, Libertadores) tiene event_date en UTC ya del día
// SIGUIENTE (Argentina es UTC-3, así que desde las 21hs todo lo que pasa
// ya cayó en el día UTC de mañana) y aparecía bajo "HOY" en vez de bajo
// el día en que Argentina lo vivió como "anoche". Por eso NO se puede
// pedirle a BSD directamente "los partidos del día X de Argentina": hay
// que traer el día UTC X Y el día UTC X+1 (el rango que puede contener
// partidos de la noche argentina de X) y quedarse solo con los que,
// convertidos a hora de Argentina, caen realmente en X.
let rawEventsByUtcDate = new Map(); // utcDateStr -> { data, at }
const RAW_EVENTS_TTL_MS = 60 * 1000; // igual al TTL de "hoy" en server.js

async function fetchRawEventsForUtcDate(utcDateStr) {
  const cached = rawEventsByUtcDate.get(utcDateStr);
  if (cached && Date.now() - cached.at < RAW_EVENTS_TTL_MS) return cached.data;

  const all = [];
  let offset = 0;
  for (let page = 0; page < 10; page++) {
    const json = await apiGet(
      `/events/?date_from=${utcDateStr}&date_to=${utcDateStr}&limit=200&offset=${offset}`
    );
    const items = listItems(json);
    all.push(...items);
    if (items.length < 200) break;
    offset += 200;
  }

  rawEventsByUtcDate.set(utcDateStr, { data: all, at: Date.now() });
  return all;
}

// TODOS los partidos de TODAS las ligas cubiertas para un día puntual DE
// ARGENTINA (dateStr). Ver el comentario de fetchRawEventsForUtcDate para
// el porqué de pedir dos días UTC en vez de uno.
async function fetchMatchesForDate(dateStr) {
  const leagues = await getLeagueDirectory();
  const nextUtcDate = addUtcDay(dateStr);

  const [dayEvents, nextDayEvents] = await Promise.all([
    fetchRawEventsForUtcDate(dateStr),
    fetchRawEventsForUtcDate(nextUtcDate),
  ]);

  const byId = new Map();
  for (const raw of [...dayEvents, ...nextDayEvents]) {
    if (ARG_DATE_FMT.format(new Date(raw.event_date)) === dateStr) {
      byId.set(raw.id, raw);
    }
  }

  return [...byId.values()]
    .map((raw) => normalizeMatch(raw, leagues))
    .sort((a, b) => a.start.localeCompare(b.start));
}

// Busca equipos por nombre. 1 request por texto de búsqueda (se cachea
// por texto desde server.js).
async function searchTeams(query) {
  const json = await apiGet(`/teams/?name=${encodeURIComponent(query)}&limit=10`);
  return listItems(json).map((t) => ({
    id: t.id,
    name: t.name,
    country: t.country || "",
    crest: crestUrl(t.id),
  }));
}

// Búsqueda de ligas: usa el mismo directorio cacheado que el feed del
// día (getLeagueDirectory) — normalmente no gasta una request nueva,
// salvo la primera búsqueda del día si el feed todavía no lo cargó.
async function searchLeagues(query) {
  const leagues = await getLeagueDirectory();
  const q = query.toLowerCase();
  return [...leagues.values()]
    .filter((l) => l.name.toLowerCase().includes(q))
    .slice(0, 10)
    .map((l) => ({ id: l.id, name: l.name, country: l.country, logo: `${IMG_BASE}/league/${l.id}/` }));
}

const POSITION_EXPAND = { G: "Goalkeepers", D: "Defenders", M: "Midfielders", F: "Forwards" };

function ageFromDob(dob) {
  const birth = new Date(dob);
  if (Number.isNaN(birth.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const monthDiff = now.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birth.getDate())) age--;
  return age;
}

// Ficha de equipo: info + plantel (2 requests en paralelo) + estadio si
// tiene venue_id (1 request más). BSD no da founded ni "últimos
// partidos" en esta ficha — se mantiene el mismo contrato que ya tenía
// esta función con API-Football (sin recentForm), la migración no agrega
// alcance nuevo.
async function fetchTeamProfile(teamId) {
  const [info, squadRes] = await Promise.all([
    apiGet(`/teams/${teamId}/`),
    apiGet(`/teams/${teamId}/squad/`),
  ]);

  let venue = null;
  if (info.venue_id) {
    try {
      const v = await apiGet(`/venues/${info.venue_id}/`);
      venue = {
        name: v.name || null,
        city: v.city || null,
        capacity: v.capacity || null,
        image: null,
      };
    } catch (err) {
      console.error(`[dataSource] no se pudo obtener el estadio ${info.venue_id}:`, err.message);
    }
  }

  const squad = (squadRes.players || []).map((p) => ({
    id: p.id,
    name: p.name,
    number: p.jersey_number,
    position: POSITION_EXPAND[p.position] || p.position || "Otros",
    age: p.date_of_birth ? ageFromDob(p.date_of_birth) : null,
    photo: `${IMG_BASE}/player/${p.id}/?sor=true&bg=transparent`,
  }));

  return {
    id: info.id,
    name: info.name,
    country: info.country || null,
    founded: null,
    crest: crestUrl(info.id),
    venue,
    squad,
  };
}

// Detalle de UN partido: info base + estadísticas (si ya arrancó) +
// alineación + pronóstico (si todavía no arrancó), estadísticas/alineación
// y pronóstico en paralelo.
//
// El mapeo de /stats/ y /prediction/ está verificado contra respuestas
// reales de BSD (no solo la documentación) al migrar el 3/9/2026.
async function fetchMatchDetail(matchId) {
  const info = await apiGet(`/events/${matchId}/`);
  const status = statusFromBsd(info.status);
  const hasScore = status !== "scheduled";
  const isLive = status === "live";

  const wantStats = status !== "scheduled";
  const wantPrediction = status === "scheduled";

  const [statsRes, lineupsRes, predictionRes] = await Promise.all([
    wantStats
      ? apiGet(`/events/${matchId}/stats/`).catch((err) => {
          console.error(`[dataSource] no se pudo obtener estadísticas del partido ${matchId}:`, err.message);
          return null;
        })
      : Promise.resolve(null),
    apiGet(`/events/${matchId}/lineups/`).catch((err) => {
      console.error(`[dataSource] no se pudo obtener alineación del partido ${matchId}:`, err.message);
      return null;
    }),
    wantPrediction
      ? apiGet(`/events/${matchId}/prediction/`).catch((err) => {
          console.error(`[dataSource] no se pudo obtener pronóstico del partido ${matchId}:`, err.message);
          return null;
        })
      : Promise.resolve(null),
  ]);

  let statistics = null;
  if (statsRes?.stats?.home && statsRes?.stats?.away) {
    const LABELS = {
      ball_possession: "Posesión (%)",
      total_shots: "Remates",
      shots_on_target: "Remates al arco",
      shots_off_target: "Remates desviados",
      blocked_shots: "Remates bloqueados",
      corners: "Córners",
      fouls: "Faltas",
      yellow_cards: "Amarillas",
      red_cards: "Rojas",
      offsides: "Offsides",
    };
    const h = statsRes.stats.home;
    const a = statsRes.stats.away;
    statistics = Object.entries(LABELS)
      .map(([key, label]) => ({ label, home: h[key] ?? null, away: a[key] ?? null }))
      .filter((row) => row.home !== null || row.away !== null);
  }

  let lineups = null;
  if (lineupsRes && lineupsRes.lineup_status !== "unavailable" && lineupsRes.lineups) {
    const buildSide = (side) =>
      side && {
        teamId: null,
        teamName: side.team_name,
        formation: side.formation || null,
        starters: (side.players || []).map((p) => ({
          id: p.id,
          name: p.short_name || p.name,
          number: p.jersey_number,
          position: p.position,
          grid: null, // BSD no manda grid — el frontend arma filas desde "formation"
        })),
      };
    const home = buildSide(lineupsRes.lineups.home);
    const away = buildSide(lineupsRes.lineups.away);
    if (home?.starters?.length || away?.starters?.length) {
      lineups = { home, away };
    }
  }

  let predictions = null;
  const matchResult = predictionRes?.markets?.match_result;
  if (matchResult) {
    const FAVORITE_LABEL = { H: "Gana el local", D: "Empatan", A: "Gana el visitante" };
    const favorite = predictionRes.recommendations?.favorite;
    predictions = {
      home: matchResult.prob_home,
      draw: matchResult.prob_draw,
      away: matchResult.prob_away,
      advice: favorite ? `Favorito: ${FAVORITE_LABEL[favorite] || favorite}` : null,
    };
  }

  return {
    id: Number(matchId),
    status,
    elapsed: isLive ? info.current_minute ?? null : null,
    statusShort: isLive ? periodToShortCode(info.status) : null, // ver comentario en normalizeMatch
    home: {
      id: info.home_team_id,
      name: info.home_team,
      crest: crestUrl(info.home_team_id),
      score: hasScore ? info.home_score : null,
    },
    away: {
      id: info.away_team_id,
      name: info.away_team,
      crest: crestUrl(info.away_team_id),
      score: hasScore ? info.away_score : null,
    },
    start: info.event_date,
    statistics,
    lineups,
    lineupsAreProbable: lineupsRes?.lineup_status === "predicted",
    predictions,
  };
}

module.exports = {
  fetchMatchesForDate,
  searchTeams,
  searchLeagues,
  fetchTeamProfile,
  fetchMatchDetail,
};
