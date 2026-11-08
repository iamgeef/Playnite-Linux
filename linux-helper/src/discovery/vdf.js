/**
 * Minimal reader for Valve's KeyValues ("VDF") text format, as used by
 * libraryfolders.vdf and appmanifest_*.acf. Steam's own format has arbitrary
 * nesting, but every field this helper needs (library paths, appid, name,
 * StateFlags) appears as a simple "key" "value" pair, so a tolerant
 * flattening parser is sufficient and far simpler than a full VDF grammar.
 *
 * Returns a plain object of the *first* value seen for each top-level-ish
 * key, plus a `repeated(key)` style list via `allValues`, so callers can
 * handle both the single-record shape (appmanifest) and the repeated-path
 * shape (libraryfolders, old and new formats) with the same parser.
 */
export function parseKeyValues(text) {
    const pairs = [];
    const pattern = /"((?:[^"\\]|\\.)*)"\s*"((?:[^"\\]|\\.)*)"/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        pairs.push([unescapeVdf(match[1]), unescapeVdf(match[2])]);
    }

    const flat = {};
    for (const [key, value] of pairs) {
        if (!(key in flat)) {
            flat[key] = value;
        }
    }

    return {
        get(key) {
            return flat[key];
        },
        allValues(key) {
            return pairs.filter(([pairKey]) => pairKey === key).map(([, value]) => value);
        }
    };
}

function unescapeVdf(value) {
    return value.replace(/\\(.)/g, "$1");
}
