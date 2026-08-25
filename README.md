# Marcador — backend (de vuelta a API-Football, cuidando el límite de 100/día)

Volvimos de ESPN a API-Football (dashboard.api-football.com), esta vez con
una arquitectura pensada específicamente para el plan free (100
requests/día).

```
dataSource.js  →  habla con API-Football
quotaGuard.js  →  cuenta requests del día, corta antes de llegar a 100
cache.js       →  cache en memoria genérico, por clave y TTL
server.js      →  la API que consume el frontend
```

## Cómo se cuida la cuota

1. **El feed de partidos por día es 1 sola request**, no una por liga.
   `/fixtures?date=X` trae TODAS las ligas del mundo de una — filtramos
   por país acá adentro (`INCLUDE_COUNTRIES` en `dataSource.js`).
2. **La búsqueda de ligas no gasta nada** — filtra una lista fija propia,
   no le pregunta nada a la API externa.
3. **El ID numérico de cada liga se resuelve una sola vez**, y se cachea
   90 días. Es lo único que necesita saber el ID exacto de API-Football
   (para tabla de posiciones y partidos de una liga puntual) — en vez de
   adivinar/hardcodear números que pueden estar mal, se busca por
   nombre+país la primera vez y después se reutiliza casi para siempre.
4. **TTLs largos en todo**: 1 hora para búsquedas, 24hs para fichas de
   equipo, 2hs para tablas de posiciones. El feed de partidos por fecha
   tiene TTL variable según qué tan lejos está esa fecha de hoy: 20 min
   si es HOY (hay partidos en vivo), 6hs si es una fecha futura (el
   fixture rara vez se reprograma), y 7 días si ya se jugó (el resultado
   final no cambia más — no tiene sentido re-pedirlo cada 20 min).
5. **`quotaGuard.js` corta antes de las 100** (con margen de seguridad de
   5), pase lo que pase. Si se llega al límite, la API devuelve un 503
   con `quotaExceeded: true` en vez de intentar la request igual — así la
   cuenta nunca se pasa del límite real y no corre riesgo de que
   api-football.com la suspenda de nuevo.
6. **Límite por minuto, aparte del diario**: el plan free también limita
   cuántas requests podés mandar por MINUTO (no solo por día). Todas las
   requests salen espaciadas al menos 6.5s entre sí (`throttledFetch` en
   `dataSource.js`), y si igual llega a pasar un 429 (límite por minuto
   superado), se reintenta solo después de una pausa — en vez de fallar
   directo. **El costo de esto**: la primera vez que alguien ve algo con
   varias requests (una ficha de equipo, por ejemplo, hace 3), puede
   tardar 15-20 segundos en cargar en frío. Una vez cacheado, vuelve a
   ser instantáneo.
7. **Cache y contador de cuota persistidos a disco** (`data/cache.json`,
   `data/quota.json`). Render free duerme el servicio tras inactividad y
   lo reinicia en la próxima visita — sin esto, cada reinicio resetearía
   el contador a 0 (riesgo real de mandar más de 100 requests reales en
   un día) y vaciaría el cache (recarga en frío innecesaria). El disco
   sobrevive a reinicios del mismo contenedor, pero no a un redeploy
   nuevo (Render pisa el filesystem). Si en algún momento hay deploys muy
   seguidos o se quiere que sobreviva también a eso, el siguiente paso es
   un disco persistente de Render o Redis (Upstash tiene un free tier que
   alcanza de sobra para este volumen).
8. **Fallback a datos viejos ("stale") en todos los endpoints que pegan a
   la API externa**: si falla la llamada (cuota agotada, API caída, error
   de red) y hay algo cacheado de antes aunque esté vencido, se devuelve
   eso con `stale: true` en vez de romper la pantalla. Antes esto solo
   pasaba en `/api/matches`, `/api/teams/:id` y `/api/matches/:id` — ahora
   también en `/api/search` y las rutas de liga (`standings`, `matches`).
9. **Warm-up del feed de hoy al arrancar** (`warmCache()` en
   `server.js`): apenas levanta el servidor, si el feed de partidos de
   HOY no está en cache (o ya venció), lo precarga en background sin
   bloquear que el server empiece a escuchar. Como el cache ahora
   sobrevive a los reinicios (punto 7), en el caso normal esto no gasta
   nada — solo actúa cuando de verdad hace falta, evitando que la primera
   visita después de que Render duerma el servicio tenga que esperar la
   carga en frío.

## Cómo correrlo

1. `cp .env.example .env` y pegá tu `API_FOOTBALL_KEY`.
2. `npm install && npm start`
3. Probar: `curl "http://localhost:3001/api/matches?date=2026-08-20"`
4. Ver cuánta cuota llevás gastada hoy: `curl "http://localhost:3001/api/quota"`

## Endpoints

- `GET /api/matches?date=YYYY-MM-DD` — 1 request (cacheado 20 min)
- `GET /api/search?q=boca` — 1 request de equipos + búsqueda local de
  ligas (cacheado 1h)
- `GET /api/teams/:id` — 3 requests (info, plantel, últimos partidos —
  cacheado 24hs)
- `GET /api/leagues` — no gasta requests (lista fija)
- `GET /api/leagues/:slug/standings` — hasta 2 requests la primera vez
  (resolver ID + tabla), 1 las siguientes veces (ID ya cacheado 90 días).
  Cacheado 2hs.
- `GET /api/leagues/:slug/matches` — igual que standings, cacheado 30 min
- `GET /api/matches/:id` — hasta 3 requests (info + estadísticas si ya
  arrancó + alineación). Cacheado 2 min.
- `GET /api/quota` — cuánto se gastó hoy, sin costo
- `GET /health`

## Si algún día hay que ajustar el límite

Si contratás un plan pago con más cuota, solo hay que cambiar
`API_DAILY_LIMIT` en el `.env` (en Render: Environment → esa variable) —
no hace falta tocar código.

## Nota sobre la liga de un equipo

Un club puede jugar más de una competencia a la vez (liga local + copa
internacional). Como API-Football no dice "esta es SU liga principal",
la inferimos a partir del partido más reciente del equipo (sin gastar
ninguna request extra, ya la tenemos de la ficha del equipo). Puede fallar
si el último partido que jugó fue justo de una copa — en ese caso, la
sección de tabla de posiciones simplemente no aparece en la ficha, en vez
de mostrar algo incorrecto.
