// El plan free de API-Football permite 100 requests/día. Este módulo
// cuenta cuántas llamadas hicimos HOY (se resetea solo al cambiar de
// fecha) y corta antes de llegar al límite, dejando un margen de
// seguridad — así nunca mandamos la request #101 y arriesgamos la cuenta
// de nuevo.
//
// El contador se persiste a disco (data/quota.json). Es crítico: Render
// free duerme el servicio tras inactividad y lo reinicia en la próxima
// visita, y si el contador viviera solo en memoria, cada reinicio lo
// resetearía a 0 aunque el día siguiera siendo el mismo — eso podría
// hacernos mandar de verdad más de 100 requests reales en un día y
// arriesgar que api-football.com suspenda la cuenta otra vez. Con el
// contador en disco, sobrevive a los reinicios del mismo contenedor
// (no a un redeploy nuevo, que sí pisa el disco — para eso hace falta
// un disco persistente de Render o migrar a Redis).

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const QUOTA_FILE = path.join(DATA_DIR, "quota.json");

const DAILY_LIMIT = Number(process.env.API_DAILY_LIMIT || 100);
const SAFETY_MARGIN = 5; // dejamos de pedir un poco antes del límite real

let count = 0;
let countDate = todayKey();

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function loadFromDisk() {
  try {
    const raw = fs.readFileSync(QUOTA_FILE, "utf8");
    const saved = JSON.parse(raw);
    if (saved.date === todayKey()) {
      count = saved.count || 0;
      countDate = saved.date;
      console.log(`[quota] restaurado desde disco: ${count}/${DAILY_LIMIT} usados hoy`);
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn("[quota] no se pudo leer quota.json, arranco en 0:", err.message);
    }
  }
}

function saveToDisk() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(QUOTA_FILE, JSON.stringify({ date: countDate, count }));
  } catch (err) {
    console.warn("[quota] no se pudo persistir a disco:", err.message);
  }
}

loadFromDisk();

function resetIfNewDay() {
  const today = todayKey();
  if (today !== countDate) {
    countDate = today;
    count = 0;
    saveToDisk();
  }
}

function canMakeRequest() {
  resetIfNewDay();
  return count < DAILY_LIMIT - SAFETY_MARGIN;
}

function recordRequest() {
  resetIfNewDay();
  count++;
  saveToDisk();
  if (count === DAILY_LIMIT - SAFETY_MARGIN) {
    console.warn(
      `[quota] llegamos a ${count}/${DAILY_LIMIT} requests hoy — a partir de acá se corta para no pasarnos.`
    );
  }
}

function getUsage() {
  resetIfNewDay();
  return { used: count, limit: DAILY_LIMIT, date: countDate };
}

// El contador local solo sabe lo que ESTE proceso pidió — si la cuenta
// real ya se agotó por otra vía (otro proceso con la misma key, un
// redeploy que reinició el contador a 0 mientras la cuenta seguía
// gastada del lado de API-Football), nuestro margen de seguridad no
// alcanza a verlo venir. dataSource.js llama a esto cuando la propia API
// contesta "reached the request limit for the day", para que el resto
// del día este proceso corte de una en vez de seguir gastando llamadas
// reales que van a fallar igual.
function markExhausted() {
  resetIfNewDay();
  count = DAILY_LIMIT;
  saveToDisk();
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
