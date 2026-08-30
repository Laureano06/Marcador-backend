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

const DAILY_LIMIT = Number(process.env.API_DAILY_LIMIT || 100);
const SAFETY_MARGIN = 5; // dejamos de pedir un poco antes del límite real

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

module.exports = { canMakeRequest, recordRequest, getUsage, markExhausted, QuotaExceededError };
