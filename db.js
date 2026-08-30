// Conexión SQLite compartida por cache.js y quotaGuard.js. Antes esto eran
// dos archivos JSON planos (data/cache.json, data/quota.json) reescritos
// ENTEROS en cada set (fs.writeFileSync con todo el store serializado) —
// con SQLite pasamos a escrituras atómicas por fila (WAL), sin riesgo de
// corromper el archivo entero si el proceso muere a mitad de una escritura,
// y con la puerta abierta a consultas más finas (ej. cuántas claves vencen
// en la próxima hora) si hace falta más adelante.
//
// OJO — esto NO resuelve por sí solo la persistencia entre REDEPLOYS de
// Render free: el filesystem del contenedor se pisa igual en cada deploy
// nuevo, sea JSON o SQLite. Para eso hace falta un Persistent Disk de
// Render (montado en esta misma carpeta `data/`) o migrar a un servicio
// externo (Turso/LibSQL, Redis). Lo que SÍ gana este cambio es integridad
// de datos entre REINICIOS del MISMO contenedor (que es el caso real que
// cuidaba el JSON — Render duerme el servicio y lo revive) y mejor
// comportamiento si dos requests escriben al mismo tiempo.

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "store.db");
const OLD_CACHE_FILE = path.join(DATA_DIR, "cache.json");
const OLD_QUOTA_FILE = path.join(DATA_DIR, "quota.json");

fs.mkdirSync(DATA_DIR, { recursive: true });

const dbIsNew = !fs.existsSync(DB_FILE);

const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS cache (
    key TEXT PRIMARY KEY,
    updatedAt INTEGER NOT NULL,
    ttlMs INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS quota (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    date TEXT NOT NULL,
    count INTEGER NOT NULL
  );
`);

// Migración única desde los archivos JSON viejos, solo la primera vez que
// corre esta versión (cuando store.db todavía no existía). Después de
// migrar, cache.json/quota.json quedan sin uso — se pueden borrar a mano.
if (dbIsNew) {
  try {
    if (fs.existsSync(OLD_CACHE_FILE)) {
      const oldCache = JSON.parse(fs.readFileSync(OLD_CACHE_FILE, "utf8"));
      const insert = db.prepare(
        "INSERT OR REPLACE INTO cache (key, updatedAt, ttlMs, data) VALUES (?, ?, ?, ?)"
      );
      const insertMany = db.transaction((entries) => {
        for (const [key, entry] of entries) {
          insert.run(key, entry.updatedAt, entry.ttlMs, JSON.stringify(entry.data));
        }
      });
      const entries = Object.entries(oldCache);
      insertMany(entries);
      console.log(`[db] migrado cache.json a SQLite (${entries.length} claves)`);
    }
  } catch (err) {
    console.warn("[db] no se pudo migrar cache.json:", err.message);
  }

  try {
    if (fs.existsSync(OLD_QUOTA_FILE)) {
      const oldQuota = JSON.parse(fs.readFileSync(OLD_QUOTA_FILE, "utf8"));
      db.prepare("INSERT OR REPLACE INTO quota (id, date, count) VALUES (1, ?, ?)").run(
        oldQuota.date,
        oldQuota.count || 0
      );
      console.log(`[db] migrado quota.json a SQLite (${oldQuota.count}/día ${oldQuota.date})`);
    }
  } catch (err) {
    console.warn("[db] no se pudo migrar quota.json:", err.message);
  }
}

module.exports = db;
