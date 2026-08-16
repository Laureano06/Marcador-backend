// Todo lo que sepa sobre "cómo habla la API externa" vive acá adentro.
// Usamos la API pública de ESPN (site.api.espn.com) — NO requiere cuenta
// ni API key. A cambio, no es oficial ni documentada por ESPN (la
// comunidad la reversineó), así que puede cambiar sin aviso. Referencia:
// https://github.com/pseudo-r/Public-ESPN-API

const SITE_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";

// Ligas que mostramos, en el orden en que queremos que aparezcan. El slug
// es el identificador que usa ESPN; el nombre es el que ve el usuario.
// Para agregar/sacar una liga, agregá/sacá una línea acá — no hay que
// tocar nada más del código.
const LEAGUES = [
  { slug: "arg.1", name: "Liga Profesional Argentina" },
  { slug: "arg.copa", name: "Copa Argentina" },
  { slug: "conmebol.libertadores", name: "Copa Libertadores" },
  { slug: "conmebol.sudamericana", name: "Copa Sudamericana" },
  { slug: "fifa.world", name: "Mundial" },
  { slug: "uefa.champions", name: "UEFA Champions League" },
  { slug: "eng.1", name: "Premier League" },
  { slug: "esp.1", name: "La Liga" },
  { slug: "ita.1", name: "Serie A" },
  { slug: "ger.1", name: "Bundesliga" },
  { slug: "fra.1", name: "Ligue 1" },
  { slug: "por.1", name: "Primeira Liga" },
  { slug: "ned.1", name: "Eredivisie" },
  { slug: "bra.1", name: "Brasileirão" },
];

function statusFromApi(state) {
  // ESPN usa status.type.state: "pre" | "in" | "post"
  if (state === "in") return "live";
  if (state === "post") return "final";
  return "scheduled";
}

function abbreviate(name) {
  return name
    .replace(/FC|CF|AFC|United|City|Club/gi, "")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 3)
    .toUpperCase();
}

async function apiGet(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ESPN respondió ${res.status} para ${url}`);
  }
  return res.json();
}

function pickCompetitor(competitors, side) {
  return competitors.find((c) => c.homeAway === side);
}

// Convierte UN evento crudo del scoreboard de ESPN al shape que usa el
// frontend.
function normalizeEvent(event, leagueName, leagueSlug) {
  const competition = event.competitions?.[0];
  if (!competition) return null;

  const home = pickCompetitor(competition.competitors, "home");
  const away = pickCompetitor(competition.competitors, "away");
  if (!home || !away) return null;

  const state = competition.status?.type?.state;
  const status = statusFromApi(state);
  const hasScore = status !== "scheduled";

  return {
    id: event.id,
    league: leagueName,
    leagueId: leagueSlug,
    status,
    home: home.team.displayName,
    homeId: home.team.id,
    homeAb: home.team.abbreviation || abbreviate(home.team.displayName),
    homeCrest: home.team.logo || null,
    away: away.team.displayName,
    awayId: away.team.id,
    awayAb: away.team.abbreviation || abbreviate(away.team.displayName),
    awayCrest: away.team.logo || null,
    scoreHome: hasScore ? Number(home.score) : null,
    scoreAway: hasScore ? Number(away.score) : null,
    start: event.date,
    // ESPN no da probabilidades en el scoreboard (existe un endpoint de
    // "probabilities" por partido individual, pero pedirlo para cada
    // partido de la lista sería carísimo en requests).
    prob: null,
  };
}

// YYYY-MM-DD -> YYYYMMDD (formato que espera ESPN)
function toEspnDate(dateKey) {
  return dateKey.replace(/-/g, "");
}

// Trae los partidos de TODAS las ligas configuradas, para un día puntual.
// Una request por liga, todas en paralelo.
async function fetchMatchesForDate(dateKey) {
  const espnDate = toEspnDate(dateKey);

  const results = await Promise.allSettled(
    LEAGUES.map(async ({ slug, name }) => {
      const data = await apiGet(
        `${SITE_BASE}/${slug}/scoreboard?dates=${espnDate}`
      );
      return (data.events || [])
        .map((event) => normalizeEvent(event, name, slug))
        .filter(Boolean);
    })
  );

  const matches = [];
  for (const r of results) {
    // Si una liga puntual falla (por ej. ESPN no tiene datos para esa
    // liga ese día), no tiramos abajo toda la respuesta — mostramos las
    // demás ligas igual.
    if (r.status === "fulfilled") matches.push(...r.value);
    else console.error("[dataSource] falló una liga:", r.reason?.message);
  }

  return matches.sort((a, b) => a.start.localeCompare(b.start));
}

// Trae la lista de equipos de TODAS las ligas configuradas, para armar el
// índice de búsqueda. Se cachea 24hs desde server.js — los planteles de
// equipos no cambian de un día para el otro.
async function buildTeamIndex() {
  const results = await Promise.allSettled(
    LEAGUES.map(async ({ slug, name }) => {
      const data = await apiGet(`${SITE_BASE}/${slug}/teams`);
      const teams = data.sports?.[0]?.leagues?.[0]?.teams || [];
      return teams.map((t) => ({
        id: t.team.id,
        name: t.team.displayName,
        crest: t.team.logos?.[0]?.href || null,
        leagueSlug: slug,
        leagueName: name,
      }));
    })
  );

  const index = [];
  for (const r of results) {
    if (r.status === "fulfilled") index.push(...r.value);
    else console.error("[dataSource] falló índice de una liga:", r.reason?.message);
  }
  return index;
}

function statusIsFinished(state) {
  return state === "post";
}

function statusIsLive(state) {
  return state === "in";
}

// Busca las estadísticas de tabla del equipo (posición, PJ, PG, PE, PP,
// goles a favor/en contra, puntos) en la tabla de posiciones de su liga.
// ESPN no documenta oficialmente el nombre exacto de cada stat, así que
// buscamos por una lista de nombres candidatos por métrica — si algún día
// ESPN cambia el nombre de un campo, esto sigue funcionando mientras el
// nuevo nombre esté en la lista (o se agrega acá, es el único lugar que
// hay que tocar).
const STAT_ALIASES = {
  played: ["gamesplayed", "gp"],
  wins: ["wins", "w"],
  draws: ["ties", "draws", "d"],
  losses: ["losses", "l"],
  goalsFor: ["pointsfor", "goalsfor", "gf"],
  goalsAgainst: ["pointsagainst", "goalsagainst", "ga"],
  points: ["points", "pts"],
  rank: ["rank"],
};

function findStat(statsArray, aliases) {
  if (!Array.isArray(statsArray)) return null;
  const stat = statsArray.find((s) =>
    aliases.includes((s.name || s.abbreviation || "").toLowerCase())
  );
  return stat ? Number(stat.value) : null;
}

async function fetchTeamStats(teamId, leagueSlug) {
  try {
    const data = await apiGet(
      `https://site.api.espn.com/apis/v2/sports/soccer/${leagueSlug}/standings`
    );

    // La tabla puede venir plana (entries) o agrupada (children/groups),
    // según la competencia. Buscamos en ambos lugares.
    const groups = data.children || data.groups || [data];
    let entry = null;
    for (const g of groups) {
      const found = (g.standings?.entries || []).find(
        (e) => String(e.team?.id) === String(teamId)
      );
      if (found) {
        entry = found;
        break;
      }
    }
    if (!entry) return null;

    const stats = entry.stats;
    return {
      rank: findStat(stats, STAT_ALIASES.rank),
      played: findStat(stats, STAT_ALIASES.played),
      wins: findStat(stats, STAT_ALIASES.wins),
      draws: findStat(stats, STAT_ALIASES.draws),
      losses: findStat(stats, STAT_ALIASES.losses),
      goalsFor: findStat(stats, STAT_ALIASES.goalsFor),
      goalsAgainst: findStat(stats, STAT_ALIASES.goalsAgainst),
      points: findStat(stats, STAT_ALIASES.points),
    };
  } catch (err) {
    // La tabla de posiciones no está disponible para todas las
    // competencias (ej: copas eliminatorias sin fase de grupos). No es un
    // error real, simplemente no hay estadísticas de tabla para mostrar.
    console.error("[dataSource] no se pudo obtener stats de tabla:", err.message);
    return null;
  }
}

// Si el equipo tiene un partido jugándose AHORA MISMO, trae la alineación
// titular de ambos equipos para ese partido. Si no hay partido en vivo,
// devuelve null (el frontend simplemente no muestra esa sección).
async function fetchLiveLineup(teamId, leagueSlug) {
  try {
    const schedule = await apiGet(
      `${SITE_BASE}/${leagueSlug}/teams/${teamId}/schedule`
    );

    const liveEvent = (schedule.events || []).find((event) => {
      const state = event.competitions?.[0]?.status?.type?.state;
      return statusIsLive(state);
    });

    if (!liveEvent) return null;

    const summary = await apiGet(
      `${SITE_BASE}/${leagueSlug}/summary?event=${liveEvent.id}`
    );

    const rosters = summary.rosters;
    if (!Array.isArray(rosters)) return null;

    const buildSide = (rosterEntry) => {
      if (!rosterEntry) return null;
      const starters = (rosterEntry.roster || [])
        .filter((p) => p.starter)
        .map((p) => ({
          id: p.athlete?.id,
          name: p.athlete?.displayName || p.athlete?.shortName,
          number: p.jersey ? Number(p.jersey) : null,
          position: p.position?.abbreviation || null,
        }));
      return {
        teamId: rosterEntry.team?.id,
        teamName: rosterEntry.team?.displayName,
        formation: rosterEntry.formation?.name || null,
        starters,
      };
    };

    const home = buildSide(rosters.find((r) => r.homeAway === "home"));
    const away = buildSide(rosters.find((r) => r.homeAway === "away"));

    if (!home?.starters?.length && !away?.starters?.length) return null;

    return { matchId: liveEvent.id, home, away };
  } catch (err) {
    console.error("[dataSource] no se pudo obtener alineación en vivo:", err.message);
    return null;
  }
}

// Ficha de equipo: info básica + estadísticas de tabla + plantel + últimos
// partidos jugados + alineación en vivo (si aplica).
async function fetchTeamProfile(teamId, leagueSlug) {
  const [infoRes, rosterRes, scheduleRes, stats, liveLineup] = await Promise.all([
    apiGet(`${SITE_BASE}/${leagueSlug}/teams/${teamId}`),
    apiGet(`${SITE_BASE}/${leagueSlug}/teams/${teamId}/roster`),
    apiGet(`${SITE_BASE}/${leagueSlug}/teams/${teamId}/schedule`),
    fetchTeamStats(teamId, leagueSlug),
    fetchLiveLineup(teamId, leagueSlug),
  ]);

  const team = infoRes.team;
  if (!team) {
    throw new Error("Equipo no encontrado");
  }

  const squad = [];
  for (const group of rosterRes.athletes || []) {
    const positionLabel = group.position || "Otros";
    for (const p of group.items || []) {
      squad.push({
        id: p.id,
        name: p.displayName,
        number: p.jersey ? Number(p.jersey) : null,
        position: positionLabel,
        age: p.age ?? null,
        photo: p.headshot?.href || null,
      });
    }
  }

  const recentForm = (scheduleRes.events || [])
    .map((event) => {
      const competition = event.competitions?.[0];
      const state = competition?.status?.type?.state;
      if (!statusIsFinished(state)) return null;

      const home = pickCompetitor(competition.competitors, "home");
      const away = pickCompetitor(competition.competitors, "away");
      if (!home || !away) return null;

      const isHome = home.team.id === String(teamId);
      const mine = isHome ? home : away;
      const rival = isHome ? away : home;
      const goalsFor = Number(mine.score);
      const goalsAgainst = Number(rival.score);

      let result = "E";
      if (goalsFor > goalsAgainst) result = "G";
      if (goalsFor < goalsAgainst) result = "P";

      return {
        opponent: rival.team.displayName,
        goalsFor,
        goalsAgainst,
        result,
        date: event.date,
        league: event.season?.slug || null,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5);

  return {
    id: team.id,
    name: team.displayName,
    country: null, // ESPN no siempre lo da a nivel equipo; el país ya se infiere de la liga
    founded: null,
    crest: team.logos?.[0]?.href || null,
    venue: team.venue
      ? {
          name: team.venue.fullName || null,
          city: team.venue.address?.city || null,
          capacity: team.venue.capacity || null,
          image: null,
        }
      : null,
    stats,
    squad,
    recentForm,
    liveLineup,
  };
}

module.exports = {
  fetchMatchesForDate,
  buildTeamIndex,
  fetchTeamProfile,
  LEAGUES,
};
