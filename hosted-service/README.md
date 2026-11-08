# Hosted service prototype

This local Node.js prototype serves the web library, its REST API, and the
helper WebSocket endpoint on the same origin.

## Run locally

From the repository root:

```sh
cd hosted-service
npm install
STEAM_WEB_API_KEY=your_32_character_key STEAM_ID64=76561198000000000 node bin.js 8787
```

Open <http://127.0.0.1:8787/>. Set `STEAM_WEB_API_KEY` and `STEAM_ID64` in the
service process environment to display the full owned Steam library, including
games that are not installed on the helper machine. The API key is sent only
from the service to Steam and is never returned by the service API or sent to
the browser. Do not put it in the web UI or commit it to the repository.

Create a Steam Web API key at <https://steamcommunity.com/dev/apikey>. The
account's Steam Game details privacy must allow the API to see its owned games.
`STEAM_ID64` is the account's 17-digit SteamID64, not its custom profile name.

For a helper on the same machine, first-run pairing can be automatic:

```sh
cd linux-helper
node src/cli.js run-local
```

`run-local` creates and redeems a short-lived pairing code locally when no
helper credentials exist, saves the token with the device state, discovers
games, then connects. Later runs reuse the saved credentials. It accepts only
`http://localhost`, `http://127.0.0.1`, or `http://[::1]`; it will not send
automatic pairing requests to a remote host. For a helper on another machine
or any hosted service, use the explicit pairing-code flow shown in the web UI.
The prototype keeps device registrations in memory, so restarting the hosted
service invalidates prior helper tokens. When `run-local` detects a stale or
revoked token, explicitly re-pair with:

```sh
node src/cli.js run-local --re-pair
```

Steam-owned library results are cached in memory for five minutes. The
**Refresh** button bypasses that cache. Steam cover and header artwork is
loaded directly from Steam's public CDN; if a cover is unavailable, the page
tries the header image and then displays a title fallback.

The web UI's device menu shows paired-helper status. A game can be launched
only when a connected helper has that game in its local catalog. Steam games
from the Web API are joined to locally discovered Steam installations using
the same stable appid-derived game ID.

Without Steam API configuration, the service still shows games discovered by
paired helpers, but cannot know about games that are owned and not installed.

This prototype is bound to loopback and has no user-account authentication,
persistent storage, rate limiting, or production secret management. Do not
expose it to the public internet.

## Cover art

Cover art for locally discovered Steam games needs no API key: the helper reports each game's Steam app ID and the browser loads artwork from Steam's public CDN. The API key and SteamID64 are only needed to list games you own but have not installed, and for playtime.
