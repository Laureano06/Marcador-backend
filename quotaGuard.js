// El plan free de API-Football permite 100 requests/día. Este módulo
// cuenta cuántas llamadas hicimos HOY (se resetea solo al cambiar de
// fecha) y corta antes de llegar al límite, dejando un margen de
// seguridad — así nunca mandamos la request #101 y arriesgamos la cuenta
// de nuevo.
//
// Nota: el contador vive en memoria. Si el proceso se reinicia (deploy,
// que Render lo duerma, etc.), se resetea a 0 aunque no sea medianoche
// todavía. Para un uso normal de un proyecto personal esto es aceptable
// — en el peor caso, subestimamos cuánto gastamos, nunca lo sobreestimamos
// de forma peligrosa.

const DAILY_LIMIT = Number(process.env.API_DAILY_LIMIT || 100);
const SAFETY_MARGIN = 5; // dejamos de pedir un poco antes del límite real

let count = 0;
let countDate = todayKey();

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function resetIfNewDay() {
  const today = todayKey();
  if (today !== countDate) {
    countDate = today;
    count = 0;
  }
}

function canMakeRequest() {
  resetIfNewDay();
  return count < DAILY_LIMIT - SAFETY_MARGIN;
}

function recordRequest() {
  resetIfNewDay();
  count++;
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

class QuotaExceededError extends Error {
  constructor() {
    super(
      "Se alcanzó el límite diario de requests a la API externa (plan free). Probá de nuevo más tarde, o mirá datos ya cacheados mientras tanto."
    );
    this.name = "QuotaExceededError";
  }
}

module.exports = { canMakeRequest, recordRequest, getUsage, QuotaExceededError };
