export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/.well-known/nostr.json") {
      const domain = url.hostname.replace(/^www\./, "");
      const requestedName = url.searchParams.get("name") || "_";
      const directory = env.NIP05_DIRECTORY ? JSON.parse(env.NIP05_DIRECTORY) : {};
      const domainMap = directory[domain] || {};
      const pubkey = domainMap[requestedName] || domainMap["_"];

      if (!pubkey) {
        return new Response(JSON.stringify({ names: {} }), {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }

      const payload = {
        names: {
          [requestedName]: pubkey,
          "_": pubkey
        },
        relays: {
          [pubkey]: (env.NOSTR_RELAYS || "wss://relay.damus.io,wss://nos.lol")
            .split(",").map(relay => relay.trim())
        }
      };

      return new Response(JSON.stringify(payload, null, 2), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=3600"
        }
      });
    }

    return fetch(request);
  }
};
