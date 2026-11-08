import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SteamLibrary } from "../src/steamLibrary.js";
import { stableGameId } from "../../linux-helper/src/discovery/stableId.js";
import { createHostedService } from "../src/server.js";

const API_KEY = "0123456789abcdef0123456789abcdef";
const STEAM_ID64 = "76561198000000000";

describe("SteamLibrary", () => {
    it("loads owned games, stable ids, playtime, and Steam artwork without exposing credentials", async () => {
        let requestedUrl;
        const library = new SteamLibrary({
            apiKey: API_KEY,
            steamId64: STEAM_ID64,
            fetchImpl: async (url) => {
                requestedUrl = new URL(url);
                return {
                    ok: true,
                    json: async () => ({
                        response: {
                            games: [
                                { appid: 440, name: "Team Fortress 2", playtime_forever: 95 },
                                { appid: 730, name: "Counter-Strike 2", playtime_forever: 0 },
                                { appid: "bad", name: "Invalid" },
                                { appid: 10, name: "" }
                            ]
                        }
                    })
                };
            }
        });

        const result = await library.getOwnedGames();
        assert.equal(result.configured, true);
        assert.equal(result.games.length, 2);
        assert.equal(result.games[0].name, "Counter-Strike 2");
        assert.equal(result.games[1].gameId, stableGameId("steam:440"));
        assert.equal(result.games[1].playtimeMinutes, 95);
        assert.match(result.games[1].coverUrl, /440\/library_600x900\.jpg$/);
        assert.equal(requestedUrl.searchParams.get("key"), API_KEY);
        assert.equal(requestedUrl.searchParams.get("steamid"), STEAM_ID64);
        assert.equal(JSON.stringify(result).includes(API_KEY), false);
    });

    it("does not call Steam when key or a valid SteamID64 is missing", async () => {
        let called = false;
        const library = new SteamLibrary({
            apiKey: API_KEY,
            steamId64: "not-a-steamid",
            fetchImpl: async () => { called = true; }
        });

        assert.deepEqual(await library.getOwnedGames(), { configured: false, games: [] });
        assert.equal(called, false);
    });

    it("caches successful responses and propagates Steam API errors safely", async () => {
        let calls = 0;
        const library = new SteamLibrary({
            apiKey: API_KEY,
            steamId64: STEAM_ID64,
            fetchImpl: async () => {
                calls += 1;
                return { ok: true, json: async () => ({ response: { games: [] } }) };
            }
        });

        await library.getOwnedGames();
        await library.getOwnedGames();
        assert.equal(calls, 1);
        await library.getOwnedGames({ refresh: true });
        assert.equal(calls, 2);

        const failed = new SteamLibrary({
            apiKey: API_KEY,
            steamId64: STEAM_ID64,
            fetchImpl: async () => ({ ok: false, status: 403 })
        });
        await assert.rejects(failed.getOwnedGames(), /HTTP 403/);
    });

    it("serves configured status and games from the library endpoint", async () => {
        const service = createHostedService({
            steam: {
                apiKey: API_KEY,
                steamId64: STEAM_ID64,
                fetchImpl: async () => ({
                    ok: true,
                    json: async () => ({ response: { games: [{ appid: 440, name: "Team Fortress 2", playtime_forever: 1 }] } })
                })
            }
        });
        const port = await service.listen(0);
        try {
            const response = await fetch(`http://127.0.0.1:${port}/api/library/steam`);
            const body = await response.json();
            assert.equal(response.status, 200);
            assert.equal(body.configured, true);
            assert.equal(body.games[0].gameId, stableGameId("steam:440"));
            assert.equal(JSON.stringify(body).includes(API_KEY), false);
        } finally {
            await service.close();
        }
    });
});
