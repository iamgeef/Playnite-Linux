/**
 * A local game catalog is the helper's own source of truth for which games
 * exist and how to launch them. A launch.request only ever carries a gameId;
 * the helper -- never the service -- decides what command that id runs.
 */
export class LocalCatalog {
    #games;
    #launchers;

    /**
     * @param {{gameId: string, name: string, source: string}[]} games
     * @param {Map<string, (game: object) => Promise<void>>} launchers gameId -> launch function
     */
    constructor(games, launchers) {
        this.#games = games;
        this.#launchers = launchers;
    }

    list() {
        return this.#games;
    }

    find(gameId) {
        return this.#games.find((game) => game.gameId === gameId) ?? null;
    }

    async launch(gameId) {
        const game = this.find(gameId);
        if (!game) {
            return { ok: false, errorCode: "game_not_found" };
        }

        const launcher = this.#launchers.get(gameId);
        if (!launcher) {
            return { ok: false, errorCode: "unsupported_launch_type" };
        }

        try {
            await launcher(game);
            return { ok: true };
        } catch {
            return { ok: false, errorCode: "launch_failed" };
        }
    }
}
