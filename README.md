# Marcador — backend (API-Football, cuidando el límite de 100/día)

Usamos API-Football (dashboard.api-football.com) directo, con una
arquitectura pensada específicamente para el plan free (100 requests/día,
10/minuto).

```
dataSource.js  →  habla con API-Football
quotaGuard.js  →  cuenta requests del día, corta antes de llegar a 100
cache.js       →  cache en memoria + disco, por clave y TTL
server.js      →  la API que consume el frontend
```

## Lo que el plan free NO permite (no es un bug, es el límite de la cuenta)

Antes de tocar código acá, dos restricciones reales de API-Football que
tiraron abajo funciones enteras y no tienen arreglo posible sin pagar un
plan superior:

- **`/standings` y cualquier `/fixtures?league=X` con rango de fechas o
  `season`**: el plan free solo da acceso a temporadas **2022 a 2024**,
  nunca a la actual. Por eso no hay tabla de posiciones ni "partidos de
  una liga por temporada" en esta versión — se sacaron enteros, no tiene
  sentido mostrar un dato que la API nunca va a devolver bien.
- **`/fixtures?team=X` sin un `date` o `id` puntual** también pide
  `season` (y cae en el mismo bloqueo), y el parámetro `last` está
  directamente prohibido en el plan free ("Free plans do not have access
  to the Last parameter"). Por esto **no existe** "últimos partidos" de
  un equipo en la ficha — literalmente no hay forma de pedirle eso a la
  API con esta cuenta.

Lo que SÍ funciona y es la base de todo lo demás: `/fixtures?date=X`
(un día puntual, sin season), `/fixtures?id=X` (un partido puntual),
`/fixtures/statistics`, `/fixtures/lineups`, `/predictions?fixture=X`,
`/teams`, `/players/squads`.

## Cómo se cuida la cuota

1. **El feed de partidos por día es 1 sola request** y trae **todas las
   ligas del mundo** — no se filtra por país acá adentro. El frontend
   agrupa lo que llega por continente, juveniles y femenino
   (`leagueCategories.js`), así que "más ligas" no cuesta una request
   extra, es el mismo dato de siempre mostrado distinto.
2. **La búsqueda de ligas no gasta nada** — filtra una lista fija propia
   (nombre + alias), no le pregunta nada a la API externa.
3. **TTL variable en el feed de partidos según la fecha**: 20 min si es
   HOY (hay partidos en vivo), 6hs si es una fecha futura (el fixture
   rara vez se reprograma), 7 días si ya se jugó (el resultado final no
   cambia más). 1 hora para búsquedas, 24hs para fichas de equipo, 2 min
   para detalle de partido.
4. **`quotaGuard.js` corta antes de las 100** (con margen de seguridad de
   5), pase lo que pase. Si se llega al límite, la API devuelve un 503
   con `quotaExceeded: true` en vez de intentar la request igual.
5. **Límite por minuto, aparte del diario**: todas las requests salen
   espaciadas al menos 6.5s entre sí (`throttledFetch` en
   `dataSource.js`), y un 429 se reintenta después de una pausa en vez de
   fallar directo. **Costo de esto**: la primera vez que alguien ve algo
   con varias requests (un partido con pronóstico + alineación, por
   ejemplo) puede tardar 15-20 segundos en cargar en frío. Una vez
   cacheado, vuelve a ser instantáneo.
6. **Cache y contador de cuota persistidos a disco** (`data/cache.json`,
   `data/quota.json`). Render free duerme el servicio tras inactividad y
   lo reinicia en la próxima visita — sin esto, cada reinicio resetearía
   el contador a 0 (riesgo real de mandar más de 100 requests reales en
   un día) y vaciaría el cache. Sobrevive a reinicios del mismo
   contenedor, pero no a un redeploy nuevo (Render pisa el filesystem) —
   para eso hace falta un disco persistente de Render o Redis.
7. **Fallback a datos viejos ("stale") en todos los endpoints que pegan a
   la API externa**: si falla la llamada (cuota agotada, API caída, error
   de red) y hay algo cacheado de antes aunque esté vencido, se devuelve
   eso con `stale: true` en vez de romper la pantalla.
8. **Warm-up del feed de hoy al arrancar** (`warmCache()` en
   `server.js`): si el feed de HOY no está en cache, lo precarga en
   background sin bloquear que el server empiece a escuchar. Con el
   cache persistido (punto 6), en el caso normal esto no gasta nada.
9. **El contador local se sincroniza si la API dice que la cuota REAL ya
   se agotó** (`markExhausted()` en `quotaGuard.js`, disparado desde
   `apiGet` en `dataSource.js` cuando la respuesta trae
   `errors.requests`). El contador de este proceso solo sabe lo que ÉL
   pidió — si la cuenta se quedó sin cuota por otra vía (otro proceso con
   la misma key, o un redeploy que reinició el contador a 0 mientras la
   cuenta seguía gastada del lado de API-Football), sin esto seguiríamos
   mandando requests reales que fallan igual, una por una, hasta que el
   margen de seguridad las corte solo. Con esto, en cuanto la API
   contesta ese error una vez, el proceso entero corta para el resto del
   día.

   **Nota real de esta build**: hoy el límite diario real se agotó en
   medio del desarrollo — no por tráfico de usuarios, sino por las
   pruebas directas contra la API (afuera del cache) más varios
   redeploys seguidos, cada uno reiniciando este contador local a 0
   mientras la cuenta real seguía gastada. Es exactamente el escenario
   que el punto 9 ahora detecta mejor. En uso normal (sin desarrollo
   activo en el mismo día) esto no debería repetirse.

## Cómo correrlo

1. `cp .env.example .env` y pegá tu `API_FOOTBALL_KEY`.
2. `npm install && npm start`
3. Probar: `curl "http://localhost:3001/api/matches?date=2026-08-20"`
4. Ver cuánta cuota llevás gastada hoy: `curl "http://localhost:3001/api/quota"`

## Endpoints

- `GET /api/matches?date=YYYY-MM-DD` — 1 request. TTL variable (ver
  arriba). Devuelve TODAS las ligas del mundo con partidos ese día.
- `GET /api/search?q=boca` — 1 request de equipos + búsqueda local de
  ligas (cacheado 1h)
- `GET /api/teams/:id` — 2 requests (info + plantel — cacheado 24hs). No
  incluye "últimos partidos" (ver restricciones arriba).
- `GET /api/matches/:id` — hasta 4 requests (info + estadísticas si ya
  arrancó + alineación + pronóstico si todavía no arrancó). Cacheado 2 min.
- `GET /api/quota` — cuánto se gastó hoy, sin costo
- `GET /health`

## Si algún día hay que ajustar el límite diario

Si contratás un plan pago con más cuota, cambiá `API_DAILY_LIMIT` en el
`.env` (en Render: Environment → esa variable). Si el plan pago también
da acceso a la temporada actual, ahí sí valdría la pena reintroducir
standings y "últimos partidos" — hoy no es posible con la cuenta free.
