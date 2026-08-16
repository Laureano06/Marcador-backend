# Marcador — backend (API-Football)

Migrado de football-data.org a **API-Football** (dashboard.api-football.com,
plan free), para tener cobertura de fútbol argentino además de las ligas
europeas de siempre.

```
dataSource.js  →  habla con API-Football, filtra por país, normaliza
cache.js       →  cache en memoria por fecha, con vencimiento (TTL)
server.js      →  la API que el frontend consume
```

## Diferencia clave con la versión anterior

La versión de football-data.org tenía un **worker** en loop, pidiendo
datos todo el tiempo en segundo plano. Esta versión **no tiene worker**:
cada fecha se pide a la API externa solo cuando alguien la visita, y se
reutiliza el resultado durante `CACHE_TTL_MS` (5 minutos por default).

Es a propósito: el plan free de API-Football permite solo **100 requests
por día**. Un worker en loop cada 60s se comería la cuota en minutos. Con
este esquema, la cuota se gasta según cuánta gente visita el sitio, no
según el reloj.

## Ligas incluidas

En vez de una lista de IDs de liga (fácil de escribir mal y que un país
falte sin que te enteres), se filtra por el campo **país** que manda la
propia API — mucho más difícil de arruinar. Están incluidos:

```
Argentina, World (Mundial/competencias internacionales), England, Spain,
Italy, Germany, France, Brazil, Portugal, Netherlands
```

Para agregar o sacar países, editá el array `INCLUDE_COUNTRIES` en
`dataSource.js`. Ojo: esto trae TODAS las competencias de esos países que
haya ese día (primera, copas locales, segunda división, etc.) — si querés
filtrar más fino por competencia específica, se puede sumar un filtro por
`league.name` además del de país, pero hay que confirmar el nombre exacto
que usa la API para cada torneo (podés verlo pegándole a
`GET /fixtures?date=X` y mirando el campo `league.name` de la respuesta).

## Cómo correrlo

1. Tu API key ya la tenés (la de la captura, en "My Access" del dashboard
   de api-football.com — NO es la de RapidAPI).
2. `cp .env.example .env` y pegá la key en `API_FOOTBALL_KEY`.
3. `npm install && npm start`
4. Probar: `curl "http://localhost:3001/api/matches?date=2026-08-16"`

## Endpoints

- `GET /api/matches?date=YYYY-MM-DD` → todos los partidos de ese día,
  todas las ligas incluidas, con `homeId`/`awayId` en cada uno (para
  favoritos y para linkear a la ficha de equipo).
- `GET /api/search?q=boca` → `{ teams: [...], leagues: [...] }`. Mínimo 3
  caracteres. Cacheado 30 min por texto de búsqueda.
- `GET /api/teams/:id` → ficha del equipo: info básica, cancha, plantel
  agrupado por posición, y últimos 5 partidos jugados (como indicador de
  forma reciente — la estadística de temporada completa de API-Football
  pide liga+temporada específica, así que no la usamos acá). Cacheado 24hs
  por equipo.
- `GET /health` → chequeo simple.

## Qué se borró de la versión anterior

- `worker.js` — ya no hace falta, ver arriba.
- `footballService.js` — era un segundo intento de hablar con la API que
  quedó a medio conectar; toda esa lógica ahora vive en `dataSource.js`.

## Qué falta para producción real

- **Persistencia**: el cache se pierde al reiniciar el proceso. No es tan
  grave acá como en la versión anterior (no hay worker que tarde en
  "repoblar" — el primer pedido de cada fecha simplemente vuelve a pedirla).
- **Cuidado con la cuota en producción**: si el sitio tiene tráfico real,
  100 req/día se puede quedar corto. Sumar Redis con el mismo TTL (para
  compartir cache entre reinicios) ayuda, pero eventualmente hay que
  evaluar un plan pago de API-Football si el uso crece.
