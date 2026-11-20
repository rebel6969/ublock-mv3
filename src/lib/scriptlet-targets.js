// uBO 1.76.6 splits advanced scriptlet targets into hostname and pathname
// expressions. Shared by packaged lookups, My filters and exception matching.
// https://github.com/gorhill/uBlock/commit/a23b117141
export function compileScriptletTarget(target) {
    const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if ( target.startsWith('/') && target.endsWith('/') && target.length > 2 ) {
        const pathPos = target.indexOf('\\/');
        if ( pathPos !== -1 ) {
            return { hn: `${target.slice(1, pathPos)}$`, pn: `^${target.slice(pathPos, -1)}` };
        }
        return { hn: target.slice(1, -1) };
    }
    const pathPos = target.indexOf('/');
    if ( pathPos <= 0 ) { return null; }
    return {
        hn: `(?:^|\\.)${escape(target.slice(0, pathPos))}$`,
        pn: `^${escape(target.slice(pathPos))}`,
    };
}

export function matchesScriptletTarget(target, hostnames, pathname) {
    try {
        if ( target.pn !== undefined && new RegExp(target.pn).test(pathname) === false ) {
            return false;
        }
        const re = new RegExp(target.hn);
        return hostnames.some(hostname => re.test(hostname)) || re.test('*');
    } catch (reason) {
        if ( reason instanceof SyntaxError ) { return false; }
        throw reason;
    }
}
