import { LocalCatalog } from "../catalog.js";
import { discoverSteamGames } from "./steam.js";
import { discoverLutrisGames } from "./lutris.js";

/**
 * Run every supported discovery source and merge the results into a single
 * LocalCatalog. Each source is isolated: a failure or empty result from one
 * (e.g. Lutris not installed) never prevents the others from contributing
 * games. gameIds are derived deterministically (see stableId.js) so the same
 * installed game keeps the same id across rescans and helper restarts.
 *
 * @param {{steam?: Parameters<typeof discoverSteamGames>[0], lutris?: Parameters<typeof discoverLutrisGames>[0]}} [options]
 * @returns {Promise<LocalCatalog>}
 */
export async function discoverCatalog(options = {}) {
    const sources = await Promise.all([
        discoverSteamGames(options.steam),
        discoverLutrisGames(options.lutris)
    ]);

    const games = [];
    const launchers = new Map();
    for (const source of sources) {
        games.push(...source.games);
        for (const [gameId, launcher] of source.launchers) {
            launchers.set(gameId, launcher);
        }
    }

    return new LocalCatalog(games, launchers);
}
