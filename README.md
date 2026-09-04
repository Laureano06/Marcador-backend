# Marcador — backend (BSD, sports.bzzoiro.com)

Usamos **BSD (Bzzoiro Sports Data)** — plan free de fútbol con 7.500
requests/día y 25/seg de ráfaga por IP. Migrado desde API-Football el
3/9/2026: esa cuenta terminó suspendida, y su plan free bloqueaba
standings y "últimos partidos" de temporada actual sin arreglo posible.

```
dataSource.js  →  habla con BSD (sports.bzzoiro.com)
quotaGuard.js  →  cuenta requests del día, corta antes de llegar al límite
cache.js       →  cache en memoria + SQLite (db.js), por clave y TTL
db.js          →  conexión SQLite compartida (data/store.db, modo WAL)
server.js      →  la API que consume el frontend (gzip, rate limit, Cache-Control)
```

## Por qué se dejó API-Football (contexto, no acción pendiente)

Dos restricciones reales del plan free de API-Football que tiraron abajo
funciones enteras y no tenían arreglo posible sin pagar un plan superior:
`/standings` y cualquier `/fixtures?league=X` con rango de fechas o
`season` solo daban acceso a temporadas 2022–2024 (nunca la actual), y el
parámetro `last` (para "últimos partidos" de un equipo) estaba
directamente prohibido. BSD **no tiene ninguna de las dos
restricciones** — de hecho da standings de temporada actual en su plan
free (confirmado: `Liga Profesional de Fútbol` de Argentina, temporada
2026, `is_current: true`). Por ahora la migración mantiene el mismo
alcance que ya tenía el sitio (sin standings ni "últimos partidos" en la
ficha de equipo, ver nota al final) — agregarlos es un paso aparte, no
bloqueado por la API.

## Cómo habla con BSD

- **Auth**: header `Authorization: Token BSD_API_KEY` (no es Bearer, no
  es query param).
- **El feed de partidos por día** usa `/api/v2/events/?date_from=X&date_to=X`,
  paginado si hace falta (BSD cubre 30+ ligas, normalmente entra en una
  sola página de 200). Cada evento solo trae `league_id` — el nombre y
  país de cada liga salen de un directorio completo (`/api/v2/leagues/`)
  cacheado 24hs en memoria (`getLeagueDirectory` en `dataSource.js`), así
  que enriquecer 50+ ligas distintas en un día no cuesta 50+ requests.
- **Escudos y fotos** salen directo de la Image API por id
  (`sports.bzzoiro.com/img/team/{id}/`, `/img/player/{id}/`) — no hace
  falta pedir una URL de logo, se arma sola, sin request extra.
- **Búsqueda de ligas** reusa ese mismo directorio de ligas — normalmente
  no gasta una request nueva, salvo la primera búsqueda del día.
- **Países**: BSD usa nombres con espacios ("Saudi Arabia", "South
  Korea") y para copas internacionales/continentales el país YA es
  directamente el continente ("Africa", "Europe", "South America",
  "International") — `leagueCategories.js` del frontend está mapeado
  contra esto específicamente, verificado contra el directorio real de
  ligas, no adivinado.
- **Dos límites de 429, distintos**: `rate_limited` es la ráfaga por IP
  (25/seg) — pasajera, se reintenta después de `Retry-After`.
  `taster_exhausted` es la cuota DIARIA real agotada — no tiene sentido
  reintentar, se sincroniza `quotaGuard` y se corta por el resto del día
  (ver `markExhausted`, mismo mecanismo que ya existía).
- **401** (token inválido o revocado) marca la cuenta como bloqueada
  (`markAccountBlocked`) — no se reintenta contra una cuenta que ya
  sabemos que va a rechazar todo, mismo criterio que antes con "access"/
  "token" de API-Football.

## Cómo se cuida la cuota

1. **El feed de partidos por día es 1 sola request** (paginada si hace
   falta) y trae **todas las ligas cubiertas por BSD** — no se filtra por
   país acá adentro. El frontend agrupa lo que llega por continente,
   juveniles y femenino (`leagueCategories.js`), así que "más ligas" no
   cuesta una request extra, es el mismo dato de siempre mostrado
   distinto.
2. **La búsqueda de ligas casi no gasta nada** — reusa el mismo
   directorio de ligas que ya se cacheó para el feed del día (24hs).
3. **TTL variable según el estado, no un número fijo para todo**: el feed
   de partidos por fecha usa **1 min si es HOY** (hay partidos en vivo,
   alineado con el polling de 60s del frontend — antes 20 min, heredado
   del presupuesto de 100 req/día de API-Football, un TTL 20x más largo
   que el propio polling que lo consumía), 6hs si es una fecha futura (el
   fixture rara vez se reprograma), 7 días si ya se jugó (el resultado
   final no cambia más). El detalle de un partido puntual sigue la misma
   idea: **30s si está EN VIVO** (antes 2 min; el frontend ahora hace
   polling en esa misma ventana mientras el partido sigue en vivo, ver
   `MatchDetail.jsx`) o 2 min si todavía no arrancó, pero **7 días si ya
   terminó** — un resultado, estadísticas y alineación de un partido
   FINAL no cambian nunca más, así que una vez pedido no se vuelve a
   pedir en toda la semana. 1 hora para búsquedas, 24hs para fichas de
   equipo — estos dos no se achicaron: una ficha de equipo o un resultado
   de búsqueda no cambian más seguido solo porque haya más cuota
   disponible, achicar su TTL solo gastaría requests sin mejorar nada
   real.
4. **`quotaGuard.js` corta antes de las 7.500** (con margen de seguridad
   de 50), pase lo que pase. Si se llega al límite, la API devuelve un
   503 con `quotaExceeded: true` en vez de intentar la request igual.
5. **Ráfaga por IP, aparte del diario**: BSD permite 25 req/seg (ráfaga
   110) — mucho más laxo que el límite por minuto de API-Football, así
   que ya no hace falta espaciar cada request de forma artificial. Las
   llamadas de un mismo endpoint (ej. estadísticas + alineación +
   pronóstico de un partido) salen en paralelo (`Promise.all`), y un 429
   de código `rate_limited` (la ráfaga, no la cuota diaria) se reintenta
   después del `Retry-After` que manda la API.
6. **Cache y contador de cuota persistidos en SQLite** (`data/store.db`,
   modo WAL, ver `db.js`). Antes eran dos archivos JSON reescritos
   enteros en cada escritura (`data/cache.json`, `data/quota.json`) — se
   migran solos a la base la primera vez que corre esta versión, no hace
   falta tocar nada a mano. Sigue siendo necesario por lo mismo de
   siempre: Render free duerme el servicio tras inactividad y lo reinicia
   en la próxima visita — sin persistencia, cada reinicio resetearía el
   contador a 0 (con 7.500/día el margen es mucho más amplio que con las
   100 de API-Football, pero el riesgo de mandar de más contra una cuenta
   que ya gastó su cuota real sigue siendo real) y vaciaría el cache.
   SQLite sobrevive a reinicios del mismo
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
9. **Refresh en background del feed de hoy** (`scheduleTodayRefresh()`
   en `server.js`), cada `MATCHES_TTL_MS` (1 min) mientras el proceso
   sigue despierto — con 100 req/día esto hubiera sido impagable (72
   requests/día solo en refrescos, sin un solo visitante), pero con
   7.500/día cuesta como mucho 1.440/día (menos del 20% del total) y a
   cambio ningún visitante paga la latencia de la primera llamada en frío
   a BSD, ni el score en vivo se queda pegado en una franja sin tráfico.
   Usa el mismo `getOrFetch`, así que nunca duplica una request que ya
   hizo un usuario real por su cuenta.
10. **El contador local se sincroniza si la API dice que la cuota REAL ya
    se agotó** (`markExhausted()` en `quotaGuard.js`, disparado desde
    `apiGet` en `dataSource.js` cuando un 429 trae `"code":
    "taster_exhausted"`). El contador de este proceso solo sabe lo que ÉL
    pidió — si la cuenta se quedó sin cuota por otra vía (otro proceso con
    la misma key, o un redeploy que reinició el contador a 0 mientras la
    cuenta seguía gastada del lado de BSD), sin esto seguiríamos mandando
    requests reales que fallan igual, una por una, hasta que el margen de
    seguridad las corte solo. Con esto, en cuanto la API contesta ese
    error una vez, el proceso entero corta para el resto del día.

11. **Respuestas comprimidas (gzip)** — el feed de partidos de un día
    con muchas ligas puede pesar varios KB de JSON; con `compression`
    baja bastante en el aire, se nota sobre todo en 3G/4G.
12. **Rate limiting por IP** (`express-rate-limit`, 60 req/min en
    `/api/*`) — no protege la cuota en sí (eso lo hace quotaGuard, y
    pegarle a un endpoint cacheado no gasta requests reales), pero evita
    que un cliente en loop o un bot generen carga innecesaria.
13. **`Cache-Control` en las respuestas**, con el tiempo de vida restante
    real del dato cacheado (no el TTL completo) — el browser (y
    cualquier CDN en el medio) puede reusar la respuesta sin volver a
    pegarle al backend, bajando también la carga ahí.

**Nota histórica**: la cuenta de API-Football (proveedor anterior) llegó
a suspenderse por acumular pruebas de desarrollo + varios redeploys
seguidos, cada uno reiniciando el contador local a 0 mientras la cuenta
real seguía gastada — es el escenario que el punto 9 arriba ahora
detecta y corta de una. Con 7.500 req/día de margen en BSD (75x más que
las 100 de API-Football) es mucho más difícil que un desarrollo normal
vuelva a chocar con esto, pero el mecanismo de sincronización queda
igual de necesario.

## Cómo correrlo

1. `cp .env.example .env` y pegá tu `BSD_API_KEY` — sacala registrándote
   gratis en [sports.bzzoiro.com/register/](https://sports.bzzoiro.com/register/)
   (Cuenta → API key). El fútbol es gratis en su plan free, no pide
   tarjeta.
2. `npm install && npm start`
3. Probar: `curl "http://localhost:3001/api/matches?date=2026-09-05"`
4. Ver cuánta cuota llevás gastada hoy: `curl "http://localhost:3001/api/quota"`

## Endpoints

- `GET /api/matches?date=YYYY-MM-DD` — 1 request (paginada si hace
  falta). TTL variable (ver arriba). Devuelve todas las ligas cubiertas
  por BSD con partidos ese día.
- `GET /api/search?q=boca` — 1 request de equipos + búsqueda contra el
  directorio de ligas ya cacheado (1h)
- `GET /api/teams/:id` — 2 requests en paralelo (info + plantel) + 1 más
  si el equipo tiene estadio asociado (`venue_id`) — cacheado 24hs. No
  incluye "últimos partidos" (mismo alcance que ya tenía el sitio antes
  de esta migración, ver nota más abajo).
- `GET /api/matches/:id` — hasta 3 requests en paralelo (estadísticas si
  ya arrancó + alineación + pronóstico si todavía no arrancó, más la
  info base). Cacheado 30s si EN VIVO, 2 min si todavía no arrancó, 7
  días si el partido ya es FINAL.
- `GET /api/quota` — cuánto se gastó hoy, sin costo
- `GET /health`

## Si en algún momento se quiere sumar standings o "últimos partidos"

A diferencia de API-Football, BSD **sí** da standings de temporada
actual (`GET /api/v2/leagues/{id}/standings/?season_id=X`, confirmado con
Argentina) y "últimos partidos" de un equipo
(`GET /api/v2/teams/{id}/fixtures/?status=finished&limit=5`) en su plan
free. No se agregaron en esta migración porque el pedido era migrar el
alcance existente, no ampliarlo — pero técnicamente ya no hay ningún
bloqueo de la API para hacerlo.

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
3. **HIT**: devuelve la respuesta cacheada. Render y BSD nunca
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

Si contratás "Football Unlimited" (BSD, sin límite diario) u otro plan
con más cuota, cambiá `API_DAILY_LIMIT` en el `.env` (en Render:
Environment → esa variable).
