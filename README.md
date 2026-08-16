# Marcador — backend (API pública de ESPN)

Migrado de API-Football a la API pública de ESPN
(https://github.com/pseudo-r/Public-ESPN-API). **No requiere cuenta ni API
key** — se terminó el problema de cuentas suspendidas.

⚠️ **Importante**: es una API no oficial, no documentada por ESPN (la
comunidad la reversineó investigando el sitio). Puede cambiar de formato o
dejar de funcionar sin aviso en cualquier momento. No hay SLA ni soporte.
Para un proyecto personal/hobby está perfecta; para algo con usuarios
reales y necesidad de estabilidad garantizada, en algún momento conviene
evaluar un proveedor pago con contrato.

```
dataSource.js  →  habla con ESPN, normaliza partidos/equipos/planteles
cache.js       →  cache en memoria genérico, por clave y TTL
server.js      →  la API que consume el frontend
```

## Diferencia clave con las versiones anteriores

- **Sin API key**: no hay `.env` con secretos que configurar.
- **Sin límite de cuota documentado**: no hay "100 requests/día" que
  cuidar. Igual seguimos cacheando (5 min partidos, 24hs equipos/búsqueda)
  para no abusar de un servicio que no es nuestro.
- **Búsqueda sin gastar requests por letra**: en vez de pedirle a la API
  externa en cada búsqueda, arma un índice de todos los equipos de las
  ligas configuradas UNA vez por día (`buildTeamIndex`) y busca sobre eso
  en memoria. Rápido y no le pega a ESPN por cada tecla que el usuario
  aprieta.

## Ligas incluidas

Editables en el array `LEAGUES` de `dataSource.js` — agregar o sacar una
liga es agregar/sacar una línea, no hace falta tocar nada más. Lista
completa de slugs disponibles (300+ ligas de todo el mundo) en la
documentación de Public-ESPN-API linkeada arriba.

Por default: Liga Profesional Argentina, Copa Argentina, Copa
Libertadores, Copa Sudamericana, Mundial, Champions League, Premier
League, La Liga, Serie A, Bundesliga, Ligue 1, Primeira Liga, Eredivisie,
Brasileirão.

## Cómo correrlo

```
npm install
npm start
```

No hace falta `.env` para que funcione (no hay API key), aunque podés
copiar `.env.example` a `.env` si querés ajustar `CACHE_TTL_MS` o `PORT`.

Probar: `curl "http://localhost:3001/api/matches?date=2026-08-16"`

## Endpoints

- `GET /api/matches?date=YYYY-MM-DD`
- `GET /api/search?q=boca` → busca sobre el índice de equipos cacheado
- `GET /api/teams/:id` → ficha del equipo (info, cancha, plantel, últimos
  5 partidos jugados)
- `GET /health`

## Si ESPN cambia el formato y algo deja de andar

Los tres puntos más frágiles (por ser API no oficial) están todos en
`dataSource.js`, en las funciones `normalizeEvent`, `buildTeamIndex` y
`fetchTeamProfile` — son las que asumen la forma exacta del JSON que
devuelve ESPN. Si un día algo rompe, seguramente sea ahí.
