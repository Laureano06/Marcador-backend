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

// Mismo patrón que crestUrl pero para jugadores — "sor=true&bg=transparent"
// pide el recorte SIN fondo (lo más parecido a una foto "cutout") en vez
// del retrato de perfil común, que es lo que BSD tiene para ofrecer acá.
function playerPhotoUrl(playerId) {
  return playerId ? `${IMG_BASE}/player/${playerId}/?sor=true&bg=transparent` : null;
}

function normalizeIncident(raw) {
  if (raw.type === "goal") {
    return {
      type: "goal",
      minute: raw.minute,
      addedTime: raw.added_time ?? null,
      isHome: raw.is_home,
      playerId: raw.player_id ?? null,
      player: raw.player,
      assistPlayerId: null, // BSD no manda el id del asistente, solo el nombre
      assist: raw.assist || null,
      goalType: raw.goal_type || null, // "regular" | "penalty" | "own_goal" (valores vistos en producción)
      score: { home: raw.home_score, away: raw.away_score },
    };
  }
  if (raw.type === "card") {
    return {
      type: "card",
      minute: raw.minute,
      addedTime: raw.added_time ?? null,
      isHome: raw.is_home,
      playerId: raw.player_id ?? null,
      player: raw.player,
      cardType: raw.card_type, // "yellow" | "red"
      reason: raw.reason || null,
    };
  }
  if (raw.type === "substitution") {
    return {
      type: "substitution",
      minute: raw.minute,
      addedTime: raw.added_time ?? null,
      isHome: raw.is_home,
      playerInId: raw.player_in_id ?? null,
      playerIn: raw.player_in,
      playerOutId: raw.player_out_id ?? null,
      playerOut: raw.player_out,
    };
  }
  if (raw.type === "period") {
    // "HT"/"FT" ya son abreviaturas universales, se muestran tal cual.
    // "FIRST HALF"/"SECOND HALF" (fase en curso, no un corte de tiempo)
    // vienen en inglés sin abreviar — se traducen para no desentonar con
    // el resto de la pantalla, que está toda en español.
    const PERIOD_LABEL_ES = { "FIRST HALF": "1ER TIEMPO", "SECOND HALF": "2DO TIEMPO" };
    return {
      type: "period",
      minute: raw.minute,
      label: PERIOD_LABEL_ES[raw.text] || raw.text,
      score: { home: raw.home_score, away: raw.away_score },
    };
  }
  return null; // "injuryTime" y cualquier tipo nuevo no documentado: no aportan nada al usuario, se descartan acá en vez de en el frontend
}

// Estadísticas EXTRA más allá de las 10 básicas de siempre — todas salen
// de la MISMA respuesta de /stats/ que ya se pedía (sin costo extra de
// cuota), BSD simplemente manda muchos más campos de los que se leían.
// Selección deliberadamente acotada: las más entendibles para alguien
// que no vive mirando estadísticas avanzadas de fútbol.
const EXTENDED_STAT_LABELS = [
  ["big_chances_scored", "Grandes ocasiones convertidas"],
  ["big_chances_missed", "Grandes ocasiones falladas"],
  ["accurate_passes", "Pases precisos"],
  ["pass_accuracy_pct", "Precisión de pase (%)"],
  ["duels", "Duelos ganados"],
  ["aerial_duels_pct", "Duelos aéreos ganados (%)"],
  ["total_saves", "Atajadas"],
];
// Un par de campos vienen como {value,total,pct} en vez de un número
// suelto (ver aerial_duels en la respuesta real de /stats/) — se
// extraen a su propia clave plana acá para que el resto del mapeo no
// tenga que saber cuáles son "raros".
function flattenStatsSide(side) {
  return { ...side, aerial_duels_pct: side.aerial_duels?.pct ?? null };
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

// Búsqueda de jugadores — /players/?name= hace match parcial e
// insensible a tildes ("messi" encuentra "Messidoro") del lado de BSD,
// no hace falta reimplementar ningún fuzzy-match acá.
async function searchPlayers(query) {
  const json = await apiGet(`/players/?name=${encodeURIComponent(query)}&limit=10`);
  return listItems(json).map((p) => ({
    id: p.id,
    name: p.name,
    teamId: p.current_team_id ?? null,
    teamName: p.current_team?.name || null,
    photo: playerPhotoUrl(p.id),
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
// Mismas 4 posiciones que POSITION_EXPAND, pero en singular y en
// español — POSITION_EXPAND nombra GRUPOS para el plantel (TeamDetail.jsx
// las vuelve a traducir para el título de cada grupo), no sirve para
// mostrar la posición de UN jugador puntual en su propia ficha.
const POSITION_SINGULAR = { G: "Arquero", D: "Defensor", M: "Mediocampista", F: "Delantero" };

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
    photo: playerPhotoUrl(p.id),
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

// Últimos resultados de un equipo ANTES de una fecha dada (para mostrar
// la forma reciente en la ficha del partido: quién llega mejor). Pide
// una ventana amplia (300 días) para no quedarse corto con equipos de
// competencias que juegan poco seguido, y filtra/ordena/recorta a 5 acá
// — BSD no tiene un parámetro "dame los últimos N finalizados".
async function fetchRecentForm(teamId, beforeIso) {
  try {
    const from = new Date(new Date(beforeIso).getTime() - 300 * 24 * 60 * 60 * 1000).toISOString();
    const json = await apiGet(
      `/teams/${teamId}/fixtures/?status=finished&limit=20&date_from=${encodeURIComponent(from)}&date_to=${encodeURIComponent(beforeIso)}`
    );
    const events = listItems(json).filter((e) => e.home_score != null && e.away_score != null);
    events.sort((a, b) => b.event_date.localeCompare(a.event_date));
    return events.slice(0, 5).map((e) => {
      const isHome = e.home_team_id === Number(teamId);
      const gf = isHome ? e.home_score : e.away_score;
      const ga = isHome ? e.away_score : e.home_score;
      return {
        result: gf > ga ? "W" : gf < ga ? "L" : "D",
        goalsFor: gf,
        goalsAgainst: ga,
        opponent: isHome ? e.away_team : e.home_team,
        isHome,
        date: e.event_date,
      };
    });
  } catch (err) {
    console.error(`[dataSource] no se pudo obtener la forma reciente del equipo ${teamId}:`, err.message);
    return null;
  }
}

// Detalle de UN partido: info base + estadísticas/eventos (si ya arrancó)
// + alineación + pronóstico (si todavía no arrancó) — todo en paralelo.
// info YA trae mucho más de lo que se leía antes (stage/round, clima,
// asistencia, H2H, highlights) sin ningún pedido extra; lo único
// GENUINAMENTE nuevo acá es /incidents/ (eventos del partido).
//
// El mapeo de /stats/, /incidents/ y /prediction/ está verificado contra
// respuestas reales de BSD (no solo la documentación).
async function fetchMatchDetail(matchId) {
  const info = await apiGet(`/events/${matchId}/`);
  const status = statusFromBsd(info.status);
  const hasScore = status !== "scheduled";
  const isLive = status === "live";

  const wantStats = status !== "scheduled";
  const wantPrediction = status === "scheduled";

  const [
    statsRes,
    lineupsRes,
    predictionRes,
    incidentsRes,
    playerStatsRes,
    homeForm,
    awayForm,
    refereeRes,
    venueRes,
    homeCoachRes,
    awayCoachRes,
  ] = await Promise.all([
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
      wantStats
        ? apiGet(`/events/${matchId}/incidents/`).catch((err) => {
            console.error(`[dataSource] no se pudo obtener eventos del partido ${matchId}:`, err.message);
            return null;
          })
        : Promise.resolve(null),
      wantStats
        ? apiGet(`/events/${matchId}/player-stats/`).catch((err) => {
            console.error(`[dataSource] no se pudieron obtener estadísticas de jugadores del partido ${matchId}:`, err.message);
            return null;
          })
        : Promise.resolve(null),
      info.home_team_id ? fetchRecentForm(info.home_team_id, info.event_date) : Promise.resolve(null),
      info.away_team_id ? fetchRecentForm(info.away_team_id, info.event_date) : Promise.resolve(null),
      info.referee_id
        ? apiGet(`/referees/${info.referee_id}/`).catch(() => null)
        : Promise.resolve(null),
      info.venue_id ? apiGet(`/venues/${info.venue_id}/`).catch(() => null) : Promise.resolve(null),
      info.home_coach_id
        ? apiGet(`/managers/${info.home_coach_id}/`).catch(() => null)
        : Promise.resolve(null),
      info.away_coach_id
        ? apiGet(`/managers/${info.away_coach_id}/`).catch(() => null)
        : Promise.resolve(null),
    ]);

  let statistics = null;
  let shotmap = null;
  let xg = null;
  if (statsRes?.stats?.home && statsRes?.stats?.away) {
    const BASE_LABELS = [
      ["ball_possession", "Posesión (%)"],
      ["total_shots", "Remates"],
      ["shots_on_target", "Remates al arco"],
      ["shots_off_target", "Remates desviados"],
      ["blocked_shots", "Remates bloqueados"],
      ["corners", "Córners"],
      ["fouls", "Faltas"],
      ["yellow_cards", "Amarillas"],
      ["red_cards", "Rojas"],
      ["offsides", "Offsides"],
    ];
    const h = flattenStatsSide(statsRes.stats.home);
    const a = flattenStatsSide(statsRes.stats.away);
    const rows = [...BASE_LABELS, ...EXTENDED_STAT_LABELS]
      .map(([key, label]) => ({ label, home: h[key] ?? null, away: a[key] ?? null }))
      .filter((row) => row.home !== null || row.away !== null);
    // BSD puede mandar un objeto stats "vacío" (todos los campos en
    // null) para un partido recién arrancado o con poca cobertura — sin
    // esto, statistics quedaba en `[]` (verdadero en JS) en vez de null,
    // y el frontend mostraba el título "Estadísticas" sin ninguna fila
    // debajo en vez de ocultar la sección entera (RULE 1: no secciones
    // vacías).
    statistics = rows.length > 0 ? rows : null;

    if (Array.isArray(statsRes.shotmap) && statsRes.shotmap.length > 0) {
      shotmap = statsRes.shotmap.map((s) => ({
        playerId: s.player_id ?? null,
        isHome: !!s.home,
        minute: s.min,
        addedTime: s.added ?? null,
        x: s.pos?.x ?? null,
        y: s.pos?.y ?? null,
        xg: s.xg ?? null,
        xgot: s.xgot ?? null,
        result: s.type, // "goal" | "miss" | "save" | "block" (valores vistos en producción)
        bodyPart: s.body || null,
        situation: s.sit || null,
        estimated: !!s.xg_estimated,
      }));
    }

    const homeXg = statsRes.stats.home.xg;
    const awayXg = statsRes.stats.away.xg;
    if (homeXg && awayXg) {
      xg = {
        home: homeXg.actual,
        away: awayXg.actual,
        estimated: !!statsRes.xg_estimated,
        perMinute: Array.isArray(statsRes.xg_per_minute) ? statsRes.xg_per_minute : null,
      };
    }
  }

  let lineups = null;
  if (lineupsRes && lineupsRes.lineup_status !== "unavailable" && lineupsRes.lineups) {
    const buildPlayer = (p) => ({
      id: p.id,
      name: p.short_name || p.name,
      number: p.jersey_number,
      position: p.position,
      photo: playerPhotoUrl(p.id),
      grid: null, // BSD no manda grid — el frontend arma filas desde "formation"
    });
    const buildSide = (side) =>
      side && {
        teamId: side.team_id ?? null,
        teamName: side.team_name,
        formation: side.formation || null,
        starters: (side.players || []).map(buildPlayer),
        substitutes: (side.substitutes || []).map(buildPlayer),
      };
    const home = buildSide(lineupsRes.lineups.home);
    const away = buildSide(lineupsRes.lineups.away);
    if (home?.starters?.length || away?.starters?.length) {
      lineups = { home, away };
    }
  }

  // "Bajas" (lesionados/suspendidos/dudosos) viene en la MISMA respuesta
  // de lineups, así que sale gratis en cuanto lineupsRes existe — no
  // depende de que la alineación en sí esté confirmada.
  let unavailablePlayers = null;
  const buildUnavailable = (list) =>
    (list || []).map((p) => ({
      id: p.id,
      name: p.short_name || p.name,
      status: p.status, // "injured" | "suspended" | "doubtful"
      reason: p.reason || null,
    }));
  if (lineupsRes?.unavailable_players?.home?.length || lineupsRes?.unavailable_players?.away?.length) {
    unavailablePlayers = {
      home: buildUnavailable(lineupsRes.unavailable_players.home),
      away: buildUnavailable(lineupsRes.unavailable_players.away),
    };
  }

  const normalizedEvents = (incidentsRes?.incidents || []).map(normalizeIncident).filter(Boolean);
  const events = normalizedEvents.length > 0 ? normalizedEvents : null;

  // Estadísticas individuales de cada jugador que participó — no trae
  // nombre, solo player_id (se resuelve del lado del frontend contra la
  // alineación, que ya viaja en la misma respuesta).
  const playerStats = playerStatsRes?.player_stats?.length
    ? playerStatsRes.player_stats.map((p) => ({
        playerId: p.player_id,
        teamId: p.team_id,
        minutesPlayed: p.minutes_played,
        rating: p.rating ?? null,
        goals: p.goals,
        assists: p.goal_assist,
        xg: p.expected_goals ?? null,
        xa: p.expected_assists ?? null,
        shots: p.total_shots,
        shotsOnTarget: p.shots_on_target,
        passes: p.total_pass,
        accuratePasses: p.accurate_pass,
        duelsWon: p.duel_won,
        yellowCards: p.yellow_card,
        redCards: p.red_card,
        saves: p.saves,
      }))
    : null;

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

  const h2h = info.head_to_head
    ? {
        totalMatches: info.head_to_head.total_matches,
        homeWins: info.head_to_head.home_wins,
        draws: info.head_to_head.draws,
        awayWins: info.head_to_head.away_wins,
        homeGoals: info.head_to_head.home_goals,
        awayGoals: info.head_to_head.away_goals,
        recentMatches: (info.head_to_head.recent_matches || []).slice(0, 10),
      }
    : null;

  const weather =
    info.weather && (info.weather.temperature_c != null || info.weather.description)
      ? {
          description: info.weather.description || null,
          temperatureC: info.weather.temperature_c ?? null,
          windSpeed: info.weather.wind_speed ?? null,
        }
      : null;

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
      coach: homeCoachRes ? { id: homeCoachRes.id, name: homeCoachRes.name } : null,
    },
    away: {
      id: info.away_team_id,
      name: info.away_team,
      crest: crestUrl(info.away_team_id),
      score: hasScore ? info.away_score : null,
      coach: awayCoachRes ? { id: awayCoachRes.id, name: awayCoachRes.name } : null,
    },
    start: info.event_date,
    stageName: info.stage_name || null,
    roundLabel: info.round_label || null,
    isDerby: !!info.is_local_derby,
    attendance: info.attendance ?? null,
    weather,
    referee: refereeRes ? { id: refereeRes.id, name: refereeRes.name } : null,
    venue: venueRes ? { id: venueRes.id, name: venueRes.name, city: venueRes.city } : null,
    h2h,
    form: homeForm?.length || awayForm?.length ? { home: homeForm, away: awayForm } : null,
    highlights: info.highlights?.length ? info.highlights : null,
    statistics,
    shotmap,
    xg,
    events,
    playerStats,
    lineups,
    lineupsAreProbable: lineupsRes?.lineup_status === "predicted",
    unavailablePlayers,
    predictions,
  };
}

// Ficha de UN jugador: perfil + una página de sus estadísticas por
// partido (BSD las pagina de a 50, sin filtro de temporada disponible
// acá — se muestra como "últimos partidos registrados", no como
// "temporada actual", para no afirmar algo que no se puede verificar
// sin cruzar fecha por fecha cada evento).
async function fetchPlayerDetail(playerId) {
  const [info, statsRes] = await Promise.all([
    apiGet(`/players/${playerId}/`),
    apiGet(`/players/${playerId}/stats/`).catch((err) => {
      console.error(`[dataSource] no se pudieron obtener estadísticas del jugador ${playerId}:`, err.message);
      return null;
    }),
  ]);

  const records = statsRes?.results || [];
  const totals = records.reduce(
    (acc, r) => ({
      appearances: acc.appearances + 1,
      minutes: acc.minutes + (r.minutes_played || 0),
      goals: acc.goals + (r.goals || 0),
      assists: acc.assists + (r.goal_assist || 0),
      shots: acc.shots + (r.total_shots || 0),
      shotsOnTarget: acc.shotsOnTarget + (r.shots_on_target || 0),
      yellowCards: acc.yellowCards + (r.yellow_card || 0),
      redCards: acc.redCards + (r.red_card || 0),
      ratingSum: acc.ratingSum + (r.rating || 0),
      ratedMatches: acc.ratedMatches + (r.rating ? 1 : 0),
    }),
    {
      appearances: 0,
      minutes: 0,
      goals: 0,
      assists: 0,
      shots: 0,
      shotsOnTarget: 0,
      yellowCards: 0,
      redCards: 0,
      ratingSum: 0,
      ratedMatches: 0,
    }
  );

  return {
    id: info.id,
    name: info.name,
    shortName: info.short_name || info.name,
    position: POSITION_SINGULAR[info.position] || info.position || null,
    number: info.jersey_number,
    photo: playerPhotoUrl(info.id),
    age: info.date_of_birth ? ageFromDob(info.date_of_birth) : null,
    heightCm: info.height_cm ?? null,
    preferredFoot: info.preferred_foot === "R" ? "Derecho" : info.preferred_foot === "L" ? "Izquierdo" : null,
    nationality: info.nationality || null,
    teamId: info.current_team_id ?? null,
    teamName: info.current_team?.name || null,
    marketValueEur: info.market_value_eur ?? null,
    contractUntil: info.contract_until || null,
    availability: info.availability || null,
    injuryType: info.injury_type || null,
    stats:
      records.length > 0
        ? {
            sampleSize: records.length,
            appearances: totals.appearances,
            minutes: totals.minutes,
            goals: totals.goals,
            assists: totals.assists,
            shots: totals.shots,
            shotsOnTarget: totals.shotsOnTarget,
            yellowCards: totals.yellowCards,
            redCards: totals.redCards,
            averageRating: totals.ratedMatches > 0 ? totals.ratingSum / totals.ratedMatches : null,
          }
        : null,
  };
}

function leagueLogoUrl(leagueId) {
  return leagueId ? `${IMG_BASE}/league/${leagueId}/` : null;
}

function normalizeStandingRow(row) {
  return {
    position: row.position,
    teamId: row.team_id,
    teamName: row.team_name,
    teamCrest: crestUrl(row.team_id),
    played: row.played,
    won: row.won,
    drawn: row.drawn,
    lost: row.lost,
    goalsFor: row.gf,
    goalsAgainst: row.ga,
    goalDiff: row.gd,
    points: row.pts,
    xgFor: row.xgf ?? null,
    xgAgainst: row.xga ?? null,
    form: row.form || null,
    zone: row.zone ? { label: row.zone.label, type: row.zone.type } : null,
  };
}

function normalizeLeaderboard(res) {
  if (!res?.leaders?.length) return null;
  return res.leaders.map((l) => ({
    rank: l.rank,
    playerId: l.player_id,
    playerName: l.player_name,
    photo: playerPhotoUrl(l.player_id),
    position: l.position || null,
    teamId: l.team_id,
    teamName: l.team_name,
    value: l.value,
    matches: l.matches,
  }));
}

// Ficha de UNA competencia: info + tabla de posiciones + goleadores +
// asistencias, para la temporada dada (por default, la temporada actual
// de la liga). La tabla puede venir plana (ligas) o agrupada (copas con
// fase de grupos) — se normaliza a la MISMA forma en los dos casos
// (lista de tablas, cada una con su nombre de grupo o null) para que el
// frontend no tenga que saber cuál de las dos formas le llegó.
async function fetchCompetitionDetail(leagueId, seasonId) {
  const league = await apiGet(`/leagues/${leagueId}/`);
  const resolvedSeasonId = seasonId || league.current_season?.id;

  const seasonQuery = resolvedSeasonId ? `?season_id=${resolvedSeasonId}` : "";
  const [standingsRes, scorersRes, assistsRes, seasonsRes] = await Promise.all([
    apiGet(`/leagues/${leagueId}/standings/${seasonQuery}`).catch((err) => {
      console.error(`[dataSource] no se pudo obtener la tabla de la liga ${leagueId}:`, err.message);
      return null;
    }),
    resolvedSeasonId
      ? apiGet(`/leagues/${leagueId}/top/scorers/?season_id=${resolvedSeasonId}&limit=20`).catch((err) => {
          console.error(`[dataSource] no se pudieron obtener los goleadores de la liga ${leagueId}:`, err.message);
          return null;
        })
      : Promise.resolve(null),
    resolvedSeasonId
      ? apiGet(`/leagues/${leagueId}/top/assists/?season_id=${resolvedSeasonId}&limit=20`).catch((err) => {
          console.error(`[dataSource] no se pudieron obtener las asistencias de la liga ${leagueId}:`, err.message);
          return null;
        })
      : Promise.resolve(null),
    // Historial de temporadas — punto 27 del plan. Un solo pedido extra
    // (cacheado junto con el resto de la ficha), no una request por
    // temporada: BSD ya devuelve la lista completa de una.
    apiGet(`/leagues/${leagueId}/seasons/`).catch((err) => {
      console.error(`[dataSource] no se pudieron obtener las temporadas de la liga ${leagueId}:`, err.message);
      return null;
    }),
  ]);

  let standings = null;
  if (standingsRes?.grouped && standingsRes.groups) {
    const tables = Object.entries(standingsRes.groups).map(([groupName, rows]) => ({
      groupName,
      rows: rows.map(normalizeStandingRow),
    }));
    if (tables.length) standings = tables;
  } else if (standingsRes?.standings?.length) {
    standings = [{ groupName: null, rows: standingsRes.standings.map(normalizeStandingRow) }];
  }

  const currentSeasonInfo = league.current_season
    ? { id: league.current_season.id, name: league.current_season.name, year: league.current_season.year }
    : null;
  // Si se pidió una temporada puntual, mostramos ESA como "temporada
  // actual de la pantalla" (para que el selector abajo marque la
  // correcta) — currentSeasonInfo sigue siendo la de verdad, por si
  // hace falta distinguir "estás viendo una vieja" en el frontend.
  const viewingSeason =
    seasonId && seasonsRes?.seasons?.find((s) => s.id === Number(seasonId))
      ? seasonsRes.seasons.find((s) => s.id === Number(seasonId))
      : league.current_season;

  return {
    id: league.id,
    name: league.name,
    country: league.country || null,
    logo: leagueLogoUrl(league.id),
    isWomen: !!league.is_women,
    season: viewingSeason ? { id: viewingSeason.id, name: viewingSeason.name, year: viewingSeason.year } : null,
    isCurrentSeason: !seasonId || seasonId === String(currentSeasonInfo?.id),
    seasons: seasonsRes?.seasons?.length
      ? seasonsRes.seasons.map((s) => ({ id: s.id, name: s.name, year: s.year }))
      : null,
    standings,
    topScorers: normalizeLeaderboard(scorersRes),
    topAssists: normalizeLeaderboard(assistsRes),
  };
}

// Ficha de UN árbitro: perfil + promedios de tarjetas/goles/faltas por
// partido (ya calculados por BSD, no se derivan acá) + sus últimos
// partidos dirigidos.
async function fetchRefereeDetail(refereeId) {
  const [info, matchesRes] = await Promise.all([
    apiGet(`/referees/${refereeId}/`),
    apiGet(`/referees/${refereeId}/matches/?limit=5`).catch((err) => {
      console.error(`[dataSource] no se pudieron obtener partidos del árbitro ${refereeId}:`, err.message);
      return null;
    }),
  ]);

  const recentMatches = listItems(matchesRes).map((m) => ({
    id: m.id,
    home: m.home_team,
    away: m.away_team,
    homeScore: m.home_score,
    awayScore: m.away_score,
    date: m.event_date,
  }));

  return {
    id: info.id,
    name: info.name,
    country: info.country || null,
    matches: info.matches,
    totalYellowCards: info.total_yellow_cards,
    totalRedCards: info.total_red_cards,
    avgYellowPerMatch: info.avg_yellow_per_match ?? null,
    avgRedPerMatch: info.avg_red_per_match ?? null,
    avgGoalsPerMatch: info.avg_goals_per_match ?? null,
    avgFoulsPerMatch: info.avg_fouls_per_match ?? null,
    careerGames: info.career_games ?? null,
    recentMatches: recentMatches.length ? recentMatches : null,
  };
}

// Ficha de UN entrenador: perfil + estadísticas agregadas (ya calculadas
// por BSD) + trayectoria (equipos dirigidos, con fecha y rendimiento en
// cada uno).
async function fetchManagerDetail(managerId) {
  const [info, careerRes] = await Promise.all([
    apiGet(`/managers/${managerId}/`),
    apiGet(`/managers/${managerId}/career/`).catch((err) => {
      console.error(`[dataSource] no se pudo obtener la trayectoria del entrenador ${managerId}:`, err.message);
      return null;
    }),
  ]);

  const career = (careerRes?.tenures || []).map((t) => ({
    teamId: t.team_id,
    teamName: t.team_name,
    dateFrom: t.date_from,
    dateTo: t.date_to,
    matches: t.matches,
    wins: t.wins,
    draws: t.draws,
    losses: t.losses,
    winPct: t.win_pct ?? null,
  }));

  return {
    id: info.id,
    name: info.name,
    shortName: info.short_name || info.name,
    country: info.country || null,
    tacticalProfile: info.tactical_profile || null,
    preferredFormation: info.preferred_formation || null,
    currentTeamId: info.current_team_id ?? null,
    matchesTotal: info.matches_total,
    wins: info.wins,
    draws: info.draws,
    losses: info.losses,
    winPct: info.win_pct ?? null,
    avgGoalsScored: info.avg_goals_scored ?? null,
    avgGoalsConceded: info.avg_goals_conceded ?? null,
    avgPossession: info.avg_possession ?? null,
    cleanSheetPct: info.clean_sheet_pct ?? null,
    bttsPct: info.btts_pct ?? null,
    over25Pct: info.over_25_pct ?? null,
    career: career.length ? career : null,
  };
}

// Ficha de UN estadio: datos básicos + equipo local (si tiene uno fijo).
async function fetchVenueDetail(venueId) {
  const info = await apiGet(`/venues/${venueId}/`);
  return {
    id: info.id,
    name: info.name,
    city: info.city || null,
    country: info.country || null,
    capacity: info.capacity ?? null,
    pitchLengthM: info.pitch_length_m ?? null,
    pitchWidthM: info.pitch_width_m ?? null,
    builtYear: info.built_year ?? null,
    homeTeamId: info.home_team_id ?? null,
  };
}

// Solo estos filtros pasan tal cual a BSD — /transfers/ rechaza con 400
// cualquier query param que no reconozca, así que un filtro mal escrito
// del lado del frontend tiene que fallar accá con un error claro, no
// llegar crudo a BSD y romper todo el pedido.
const TRANSFER_FILTERS = [
  "date_from",
  "date_to",
  "from_team_id",
  "to_team_id",
  "team_id",
  "league_id",
  "player_id",
  "has_fee",
  "min_fee",
  "ordering",
  "offset",
];

// Mercado de pases — punto 19 del plan. `filters` es un objeto plano ya
// validado por el caller (server.js), se arma la query string acá.
async function fetchTransfers(filters = {}, limit = 25) {
  const params = new URLSearchParams();
  for (const key of TRANSFER_FILTERS) {
    if (filters[key] != null && filters[key] !== "") params.set(key, filters[key]);
  }
  params.set("limit", Math.min(Number(limit) || 25, 50));

  const json = await apiGet(`/transfers/?${params.toString()}`);
  const results = listItems(json);

  return {
    count: json.count ?? results.length,
    transfers: results.map((t) => ({
      id: t.id,
      date: t.transfer_date,
      playerId: t.player?.id ?? null,
      playerName: t.player?.name ?? null,
      playerPhoto: playerPhotoUrl(t.player?.id),
      fromTeamId: t.from_team_id,
      fromTeamName: t.from_team_name,
      toTeamId: t.to_team_id,
      toTeamName: t.to_team_name,
      feeEur: t.fee_eur ?? null,
      feeDescription: t.fee_description || null,
    })),
  };
}

module.exports = {
  fetchMatchesForDate,
  searchTeams,
  searchPlayers,
  searchLeagues,
  fetchTeamProfile,
  fetchMatchDetail,
  fetchPlayerDetail,
  fetchCompetitionDetail,
  fetchRefereeDetail,
  fetchManagerDetail,
  fetchVenueDetail,
  fetchTransfers,
};
