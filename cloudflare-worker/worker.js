// Proxy-cache delante del backend en Render. Existe porque Render enruta
// sus dominios custom a través de la propia red de Cloudflare por atrás
// (ver README de marcador-backend, sección "Cache de borde con un
// Cloudflare Worker") — un DNS proxeado normal encima de eso dispara el
// Error 1000 de Cloudflare. Un Worker no tiene ese problema: acá adentro
// es solo un fetch() común hacia Render, como el de cualquier cliente.
//
// La API entera es GET-only (server.js no define ninguna ruta POST/PUT/
// etc.), así que no hace falta lógica para otros métodos.

const ORIGIN = "https://marcador-backend-kof7.onrender.com";

// edgeCache: "HIT" | "MISS" | "BYPASS" — visible desde afuera con
// curl -I para confirmar que el cache de borde está funcionando de
// verdad, sin tener que adivinar mirando CF-Cache-Status (que es la capa
// de cache clásica de Cloudflare, no tiene idea de lo que hacemos acá con
// la Cache API a mano).
function withDebugHeader(response, edgeCache) {
  const headers = new Headers(response.headers);
  headers.set("X-Edge-Cache", edgeCache);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, _env, ctx) {
    const url = new URL(request.url);

    if (request.method !== "GET") {
      return fetch(ORIGIN + url.pathname + url.search, request);
    }

    // caches.default usa la URL completa (query string incluida) como
    // key — cada ?date=YYYY-MM-DD, ?q=texto, o /:id distinto ya es una
    // entrada de cache separada, igual que las keys de cache.js del lado
    // de Render. No hace falta reimplementar esa lógica acá.
    const cache = caches.default;
    const cached = await cache.match(request);
    if (cached) return withDebugHeader(cached, "HIT");

    const originRequest = new Request(ORIGIN + url.pathname + url.search, {
      method: "GET",
      headers: {
        // El rate limiter de server.js lee este header para no confundir
        // a TODOS los visitantes con la IP del Worker — sin reenviarlo
        // explícitamente, fetch() no lo copia solo.
        "CF-Connecting-IP": request.headers.get("CF-Connecting-IP") || "",
      },
    });

    const response = await fetch(originRequest);

    // Guardamos en cache SOLO cuando Render mandó explícitamente un
    // Cache-Control cacheable (setCacheHeaders en server.js) — nunca
    // confiamos en el heurístico default de Cloudflare para respuestas
    // sin ese header. Los errores (502/503) y los fallbacks "stale"
    // actuales no mandan Cache-Control, así que nunca se cachean acá:
    // correcto, no queremos que un error o un dato viejo se sirva desde
    // el borde más tiempo del necesario.
    const cacheControl = response.headers.get("Cache-Control") || "";
    const isCacheable =
      response.ok &&
      /max-age=\d+/.test(cacheControl) &&
      !/no-store|private/.test(cacheControl);

    if (isCacheable) {
      ctx.waitUntil(cache.put(request, response.clone()));
    }

    return withDebugHeader(response, isCacheable ? "MISS" : "BYPASS");
  },
};
