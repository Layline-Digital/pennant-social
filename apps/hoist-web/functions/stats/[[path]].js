const UMAMI_ORIGIN = "https://analytics.alanwoodyard.com";

function edgeHeaders(request) {
  const headers = {
    "X-Telemetry-Mode": "sovereign-first-party",
  };
  const cf = request && request.cf ? request.cf : {};
  if (cf.colo) headers["X-Edge-Colo"] = cf.colo;
  if (cf.httpProtocol) headers["X-Edge-Protocol"] = cf.httpProtocol;
  return headers;
}

export async function onRequestGet(context) {
  const pathname = new URL(context.request.url).pathname;
  if (pathname !== "/stats/script.js") {
    return new Response("Not found", { status: 404 });
  }
  const upstream = await fetch(`${UMAMI_ORIGIN}/script.js`, {
    method: "GET",
    headers: { Accept: "application/javascript, text/javascript, */*" },
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": upstream.ok ? "public, max-age=3600" : "no-store",
      ...edgeHeaders(context.request),
    },
  });
}

export async function onRequestPost(context) {
  const pathname = new URL(context.request.url).pathname;
  if (pathname !== "/stats/api/send" && pathname !== "/stats/send") {
    return new Response("Not found", { status: 404 });
  }
  const req = context.request;
  const forwardHeaders = new Headers({
    "Content-Type": req.headers.get("Content-Type") || "application/json",
  });
  for (const name of [
    "User-Agent",
    "Accept-Language",
    "CF-IPCountry",
    "x-umami-website-id",
    "x-umami-hostname",
    "x-umami-cache",
  ]) {
    const val = req.headers.get(name);
    if (val) forwardHeaders.set(name, val);
  }
  const clientIp = req.headers.get("CF-Connecting-IP") || req.headers.get("X-Forwarded-For");
  if (clientIp) forwardHeaders.set("X-Forwarded-For", clientIp);

  const body = await req.text();
  const upstream = await fetch(`${UMAMI_ORIGIN}/api/send`, {
    method: "POST",
    headers: forwardHeaders,
    body,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") || "application/json",
      "Cache-Control": "no-store",
      ...edgeHeaders(req),
    },
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, x-umami-website-id, x-umami-hostname, x-umami-cache",
    },
  });
}
