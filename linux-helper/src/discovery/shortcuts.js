// Parser for Steam's binary shortcuts.vdf (non-Steam games).
export function parseShortcuts(buffer) {
    let pos = 0;
    const readCString = () => {
        const end = buffer.indexOf(0, pos);
        if (end < 0) throw new Error("unterminated string");
        const text = buffer.toString("utf8", pos, end);
        pos = end + 1;
        return text;
    };
    const readObject = () => {
        const obj = {};
        while (pos < buffer.length) {
            const type = buffer[pos++];
            if (type === 0x08) return obj;
            const key = readCString();
            if (type === 0x00) obj[key] = readObject();
            else if (type === 0x01) obj[key] = readCString();
            else if (type === 0x02) {
                obj[key] = buffer.readUInt32LE(pos);
                pos += 4;
            } else throw new Error(`unsupported type ${type}`);
        }
        return obj;
    };

    const root = readObject();
    const entries = root.shortcuts ?? root.Shortcuts ?? {};
    return Object.values(entries)
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => ({
            appid: entry.appid ?? entry.appId,
            name: entry.AppName ?? entry.appname,
            hidden: Boolean(entry.IsHidden)
        }))
        .filter((entry) => Number.isInteger(entry.appid) && entry.name);
}

// Steam addresses non-Steam shortcuts by a 64-bit id: (appid << 32) | 0x02000000.
export function shortcutLaunchId(appid) {
    return ((BigInt(appid) << 32n) | 0x02000000n).toString();
}
