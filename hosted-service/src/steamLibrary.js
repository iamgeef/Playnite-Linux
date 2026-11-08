import { isSteamTool } from "../../linux-helper/src/discovery/steamTools.js";
import { stableGameId } from "../../linux-helper/src/discovery/stableId.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const STEAM_OWNED_GAMES_URL = "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/";

export class SteamLibrary {
    #apiKey;
    #steamId64;
    #fetch;
    #cache = null;
    #cacheExpiresAt = 0;

    constructor({
        apiKey = process.env.STEAM_WEB_API_KEY,
        steamId64 = process.env.STEAM_ID64,
        fetchImpl = globalThis.fetch
    } = {}) {
        this.#apiKey = apiKey;
        this.#steamId64 = steamId64;
        this.#fetch = fetchImpl;
    }

    get configured() {
        return Boolean(this.#apiKey && /^\d{17}$/.test(this.#steamId64 ?? ""));
    }

    async getOwnedGames({ refresh = false } = {}) {
        if (!this.configured) {
            return { configured: false, games: [] };
        }

        if (!refresh && this.#cache && Date.now() < this.#cacheExpiresAt) {
            return { configured: true, games: this.#cache };
        }

        const url = new URL(STEAM_OWNED_GAMES_URL);
        url.searchParams.set("key", this.#apiKey);
        url.searchParams.set("steamid", this.#steamId64);
        url.searchParams.set("include_appinfo", "1");
        url.searchParams.set("include_played_free_games", "1");
        url.searchParams.set("format", "json");

        let response;
        try {
            response = await this.#fetch(url, { signal: AbortSignal.timeout(10_000) });
        } catch {
            throw new Error("Steam Web API request failed");
        }
        if (!response.ok) {
            throw new Error(`Steam Web API returned HTTP ${response.status}`);
        }

        let payload;
        try {
            payload = await response.json();
        } catch {
            throw new Error("Steam Web API returned invalid JSON");
        }

        const steamGames = payload?.response?.games;
        if (!Array.isArray(steamGames)) {
            throw new Error("Steam did not return an owned-games list. Check the SteamID64 and that Game details are public.");
        }

        const games = steamGames
            .filter((game) => Number.isInteger(game.appid) && game.appid > 0 && typeof game.name === "string" && game.name.length > 0 && !isSteamTool(game.appid, game.name))
            .map((game) => ({
                gameId: stableGameId(`steam:${game.appid}`),
                appId: game.appid,
                name: game.name,
                source: "steam",
                playtimeMinutes: Number.isFinite(game.playtime_forever) ? game.playtime_forever : 0,
                coverUrl: `https://cdn.akamai.steamstatic.com/steam/apps/${game.appid}/library_600x900.jpg`,
                headerUrl: `https://cdn.akamai.steamstatic.com/steam/apps/${game.appid}/header.jpg`
            }))
            .sort((left, right) => left.name.localeCompare(right.name));

        this.#cache = games;
        this.#cacheExpiresAt = Date.now() + CACHE_TTL_MS;
        return { configured: true, games };
    }
}
