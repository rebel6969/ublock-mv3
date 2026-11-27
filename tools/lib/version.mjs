// Local builds, CI artifacts and releases share package.json's version.
export function releaseVersion(version, override) {
    if ( typeof version !== 'string' || /^\d+(\.\d+){0,3}$/.test(version) === false ||
         version.split('.').some(part => Number(part) > 65535) ) {
        throw new Error(`package.json version "${version}" is not a valid Chrome version`);
    }
    if ( override !== undefined && override !== version ) {
        throw new Error(`EXT_VERSION "${override}" does not match package.json version "${version}"`);
    }
    return version;
}
