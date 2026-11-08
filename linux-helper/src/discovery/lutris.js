import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stableGameId } from "./stableId.js";

const execFileAsync = promisify(execFile);

/**
 * Discover installed Lutris games via `lutris --list-games --installed
 * --json`, which Lutris itself maintains against its own game database --
 * this helper never parses Lutris's SQLite/YAML configuration directly.
 * Each discovered game is launched through Lutris's own `lutris:rungame/
 * <slug>` URI handler, never via a raw executable path.
 *
 * @param {{listGames?: () => Promise<string>, exec?: typeof execFileAsync}} [options]
 *   `listGames` lets tests substitute a fake Lutris CLI output without
 *   requiring Lutris to be installed.
 * @returns {Promise<{games: {gameId: string, name: string, source: "lutris"}[], launchers: Map<string, (game: object) => Promise<void>>}>}
 */
export async function discoverLutrisGames(options = {}) {
    const exec = options.exec ?? execFileAsync;
    const listGames = options.listGames ?? (async () => {
        const { stdout } = await exec("lutris", ["--list-games", "--installed", "--json"]);
        return stdout;
    });

    let entries;
    try {
        const stdout = await listGames();
        entries = JSON.parse(stdout);
    } catch {
        // Lutris not installed, not on PATH, or returned something we can't
        // parse -- treat as "no Lutris games found" rather than failing
        // discovery for every other source.
        return { games: [], launchers: new Map() };
    }

    const games = [];
    const launchers = new Map();

    for (const entry of entries) {
        if (!entry || typeof entry.slug !== "string" || typeof entry.name !== "string") {
            continue;
        }

        const gameId = stableGameId(`lutris:${entry.slug}`);
        games.push({ gameId, name: entry.name, source: "lutris" });
        launchers.set(gameId, async () => {
            await exec("lutris", [`lutris:rungame/${entry.slug}`]);
        });
    }

    return { games, launchers };
}
