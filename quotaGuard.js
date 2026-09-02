// El plan free de API-Football permite 100 requests/día. Este módulo
// cuenta cuántas llamadas hicimos HOY (se resetea solo al cambiar de
// fecha) y corta antes de llegar al límite, dejando un margen de
// seguridad — así nunca mandamos la request #101 y arriesgamos la cuenta
// de nuevo.
//
// El contador se persiste en SQLite (ver db.js), no en un JSON plano.
// Sigue siendo crítico por la misma razón de siempre: Render free duerme
// el servicio tras inactividad y lo reinicia en la próxima visita, y si
// el contador viviera solo en memoria, cada reinicio lo resetearía a 0
// aunque el día siguiera siendo el mismo — eso podría hacernos mandar de
// verdad más de 100 requests reales en un día. El contador sobrevive a
// los reinicios del mismo contenedor (no a un redeploy nuevo, que sí pisa
// el disco — para eso hace falta un disco persistente de Render o migrar
// a un servicio externo).

const db = require("./db");
const { isExpired: isCacheExpired, setCached, getCached } = require("./cache");

const DAILY_LIMIT = Number(process.env.API_DAILY_LIMIT || 100);
const SAFETY_MARGIN = 5; // dejamos de pedir un poco antes del límite real

// Cuánto tiempo cortamos SIN reintentar cuando la API contesta un error de
// cuenta (suspendida, key inválida, etc — cualquier cosa que NO sea "se
// acabó la cuota del día", que ya tiene su propio corte en canMakeRequest).
// Reintentar cada 20 min (el TTL de "hoy") contra una cuenta suspendida no
// la va a arreglar, solo sigue gastando el contador local y golpeando una
// cuenta que ya está marcada — 1 hora es un back-off razonable sin dejar
// el sitio roto por más tiempo del necesario si alguien soluciona el
// problema del lado de API-Football mientras tanto.
const ACCOUNT_BLOCK_COOLDOWN_MS = 60 * 60 * 1000;
const BLOCK_CACHE_KEY = "quotaGuard:accountBlocked";

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

const stmtGet = db.prepare("SELECT date, count FROM quota WHERE id = 1");
const stmtUpsert = db.prepare(`
  INSERT INTO quota (id, date, count) VALUES (1, @date, @count)
  ON CONFLICT(id) DO UPDATE SET date = excluded.date, count = excluded.count
`);

// Lee el estado actual, reseteando en memoria (sin escribir todavía) si
// cambió el día — mismo comportamiento que el resetIfNewDay() de antes,
// pero sin necesidad de una variable de módulo separada: SQLite es la
// única fuente de verdad.
function readState() {
  const row = stmtGet.get();
  const today = todayKey();
  if (!row || row.date !== today) return { date: today, count: 0 };
  return row;
}

function writeState(state) {
  stmtUpsert.run(state);
}

function canMakeRequest() {
  return readState().count < DAILY_LIMIT - SAFETY_MARGIN;
}

function recordRequest() {
  const state = readState();
  state.count++;
  writeState(state);
  if (state.count === DAILY_LIMIT - SAFETY_MARGIN) {
    console.warn(
      `[quota] llegamos a ${state.count}/${DAILY_LIMIT} requests hoy — a partir de acá se corta para no pasarnos.`
    );
  }
}

function getUsage() {
  const state = readState();
  return { used: state.count, limit: DAILY_LIMIT, date: state.date };
}

// El contador local solo sabe lo que ESTE proceso pidió — si la cuenta
// real ya se agotó por otra vía (otro proceso con la misma key, un
// redeploy que reinició el contador a 0 mientras la cuenta seguía gastada
// del lado de API-Football), nuestro margen de seguridad no alcanza a
// verlo venir. dataSource.js llama a esto cuando la propia API contesta
// "reached the request limit for the day", para que el resto del día
// este proceso corte de una en vez de seguir gastando llamadas reales que
// van a fallar igual.
function markExhausted() {
  const state = readState();
  state.count = DAILY_LIMIT;
  writeState(state);
  console.warn("[quota] la API reportó cuota diaria agotada — cortando por hoy.");
}

class QuotaExceededError extends Error {
  constructor() {
    super(
      "Se alcanzó el límite diario de requests a la API externa (plan free). Probá de nuevo más tarde, o mirá datos ya cacheados mientras tanto."
    );
    this.name = "QuotaExceededError";
  }
}

// Distinto de QuotaExceededError: esto es un problema DE LA CUENTA (ej.
// suspendida, key inválida), no de haber gastado el cupo del día. La API
// lo reporta como data.errors.access (u otra clave que no sea "requests").
function isAccountBlocked() {
  return !isCacheExpired(BLOCK_CACHE_KEY);
}

function markAccountBlocked(reason) {
  setCached(BLOCK_CACHE_KEY, { reason, blockedAt: Date.now() }, ACCOUNT_BLOCK_COOLDOWN_MS);
  console.warn(
    `[quota] la API reportó un problema de cuenta ("${reason}") — cortando reintentos por ${
      ACCOUNT_BLOCK_COOLDOWN_MS / 60000
    } min en vez de seguir golpeándola en cada cache-miss.`
  );
}

function accountBlockedInfo() {
  return isAccountBlocked() ? getCached(BLOCK_CACHE_KEY) : null;
}

class AccountBlockedError extends Error {
  constructor(reason) {
    super(
      reason
        ? `La cuenta de API-Football tiene un problema: "${reason}". Revisá https://dashboard.api-football.com — esto no se arregla con reintentos.`
        : "La cuenta de API-Football tiene un problema de acceso. Revisá https://dashboard.api-football.com."
    );
    this.name = "AccountBlockedError";
  }
}

module.exports = {
  canMakeRequest,
  recordRequest,
  getUsage,
  markExhausted,
  QuotaExceededError,
  isAccountBlocked,
  markAccountBlocked,
  accountBlockedInfo,
  AccountBlockedError,
};
