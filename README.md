# Marcador — backend (API-Football, cuidando el límite de 100/día)

Usamos API-Football (dashboard.api-football.com) directo, con una
arquitectura pensada específicamente para el plan free (100 requests/día,
10/minuto).

```
dataSource.js  →  habla con API-Football
quotaGuard.js  →  cuenta requests del día, corta antes de llegar a 100
cache.js       →  cache en memoria + SQLite (db.js), por clave y TTL
db.js          →  conexión SQLite compartida (data/store.db, modo WAL)
server.js      →  la API que consume el frontend (gzip, rate limit, Cache-Control)
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
3. **TTL variable según el estado, no un número fijo para todo**: el feed
   de partidos por fecha usa 20 min si es HOY (hay partidos en vivo), 6hs
   si es una fecha futura (el fixture rara vez se reprograma), 7 días si
   ya se jugó (el resultado final no cambia más). El detalle de un
   partido puntual sigue la misma idea: 2 min si está EN VIVO o todavía
   no arrancó (puede cambiar de estado en cualquier momento), pero **7
   días si ya terminó** — un resultado, estadísticas y alineación de un
   partido FINAL no cambian nunca más, así que una vez pedido no se
   vuelve a pedir en toda la semana. 1 hora para búsquedas, 24hs para
   fichas de equipo.
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
6. **Cache y contador de cuota persistidos en SQLite** (`data/store.db`,
   modo WAL, ver `db.js`). Antes eran dos archivos JSON reescritos
   enteros en cada escritura (`data/cache.json`, `data/quota.json`) — se
   migran solos a la base la primera vez que corre esta versión, no hace
   falta tocar nada a mano. Sigue siendo necesario por lo mismo de
   siempre: Render free duerme el servicio tras inactividad y lo reinicia
   en la próxima visita — sin persistencia, cada reinicio resetearía el
   contador a 0 (riesgo real de mandar más de 100 requests reales en un
   día) y vaciaría el cache. SQLite sobrevive a reinicios del mismo
   contenedor igual que el JSON viejo, con escrituras atómicas por fila
   en vez de reescribir todo el archivo — pero **tampoco sobrevive a un
   redeploy nuevo** (Render pisa el filesystem igual). Para eso hace
   falta un disco persistente de Render (montado en `data/`) o migrar a
   un servicio externo (Turso/LibSQL, Redis).
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

10. **Respuestas comprimidas (gzip)** — el feed de partidos de un día
    con muchas ligas puede pesar varios KB de JSON; con `compression`
    baja bastante en el aire, se nota sobre todo en 3G/4G.
11. **Rate limiting por IP** (`express-rate-limit`, 60 req/min en
    `/api/*`) — no protege la cuota en sí (eso lo hace quotaGuard, y
    pegarle a un endpoint cacheado no gasta requests reales), pero evita
    que un cliente en loop o un bot generen carga innecesaria.
12. **`Cache-Control` en las respuestas**, con el tiempo de vida restante
    real del dato cacheado (no el TTL completo) — el browser (y
    cualquier CDN en el medio) puede reusar la respuesta sin volver a
    pegarle al backend, bajando también la carga ahí.

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

## Cache de borde con un Cloudflare Worker (backend se queda en Render)

Este backend manda `Cache-Control` con el tiempo de vida real que le
queda a cada dato cacheado (ver `setCacheHeaders` en `server.js`), pero
Render enruta *todos* sus dominios custom a través de la propia red de
Cloudflare por atrás (confirmable con `nslookup tu-app.onrender.com` —
resuelve a `*.origin.onrender.com.cdn.cloudflare.net`). Eso descarta la
forma "normal" de poner Cloudflare delante (un simple DNS proxeado): una
zona Cloudflare no puede proxear directo sobre un origen que ya está
detrás de Cloudflare — tira **Error 1000 "DNS points to prohibited
IP"**, una regla anti-loop de la plataforma, no algo que se arregle
reconfigurando DNS.

La salida: un **Cloudflare Worker** (gratis hasta 100k requests/día, sin
tarjeta) que actúa de proxy-cache. No es "otra zona proxeando sobre
Render" — es código de Cloudflare haciendo un `fetch()` normal hacia
Render, exactamente igual que lo haría cualquier cliente de internet, así
que no dispara el Error 1000. El Worker vive en
`cloudflare-worker/worker.js` de este repo.

### Cómo funciona

1. Request a `api.tu-dominio.com/api/matches?date=...` le pega al Worker.
2. El Worker busca en `caches.default` (la Cache API de Cloudflare) por
   esa URL exacta (query string incluido — cada `?date=` es una key
   distinta, igual que nuestro cache por key de `cache.js`).
3. **HIT**: devuelve la respuesta cacheada. Render y API-Football nunca
   se enteran de esta visita.
4. **MISS**: el Worker le pega a Render de verdad (reenviando
   `CF-Connecting-IP`, para que el rate limiter de `server.js` siga
   viendo la IP real del visitante y no la del Worker), y guarda la
   respuesta en `caches.default` — la Cache API de Cloudflare respeta el
   `Cache-Control` que ya manda este backend automáticamente (incluido
   `no-store` en `/api/quota` y `/health`, que por eso nunca se cachean
   sin que el Worker tenga que saber nada especial de esas dos rutas).

### Deploy

```bash
cd cloudflare-worker
npx wrangler login          # tu cuenta Cloudflare, la del dominio
npx wrangler deploy
```

`wrangler.toml` ya trae la ruta (`api.tu-dominio.com/*`) — solo hay que
ajustar `ORIGIN` ahí si tu servicio de Render tiene otro hostname que
`marcador-backend.onrender.com`.

### DNS y SSL en Cloudflare

Un **Worker Route** no necesita (ni debe) un CNAME real al origen —
usá un registro placeholder, proxeado, que el Worker intercepta antes de
que Cloudflare intente resolverlo de verdad:

1. DNS → `api.tu-dominio.com` como registro **A** apuntando a `192.0.2.1`
   (IP no ruteable, reservada para esto — nunca se usa de verdad, el
   Worker responde antes), con el proxy naranja/"Proxied" activado.
2. SSL/TLS → modo **Full** alcanza (Render ya sirve HTTPS propio del
   otro lado del `fetch()` del Worker).
3. El registro del frontend en Vercel no cambia — ese no tiene el
   problema del Error 1000 (Vercel no usa la red de Cloudflare por
   atrás).

Con esto activo, cualquier corte de reintentos por cuota agotada o cuenta
bloqueada (ver `quotaGuard.js`) sigue funcionando igual del lado de
Render — el Worker solo decide si la request llega o no hasta ahí.

## Si algún día hay que ajustar el límite diario

Si contratás un plan pago con más cuota, cambiá `API_DAILY_LIMIT` en el
`.env` (en Render: Environment → esa variable). Si el plan pago también
da acceso a la temporada actual, ahí sí valdría la pena reintroducir
standings y "últimos partidos" — hoy no es posible con la cuenta free.
