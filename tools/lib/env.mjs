// The filter-list preprocessor environment for this blocker.
//
// Filter lists gate sections with `!#if <token>` / `!#endif`. ubo-core maps each
// directive token to an env value (see preparserTokens in
// node_modules/@gorhill/ubo-core/js/static-filtering-parser.js). A token whose
// env value is absent evaluates false and the WHOLE gated block is dropped --
// silently. Getting this list wrong does not error, it just quietly produces a
// weaker blocker (KOR-1 lost all 3,987 of its filters to a missing `ublock`).
//
// Each entry below is a deliberate capability claim about this extension.
export const ENV = [
    // ext_ublock -- we consume uBO filter syntax.
    'ublock',
    // ext_ubol -- we are the MV3/declarativeNetRequest flavour, like uBO Lite.
    'ubol',
    // env_chromium -- target is Chrome.
    'chromium',
    // env_mv3 -- manifest v3.
    'mv3',
    // cap_user_stylesheet -- we inject cosmetic CSS via
    // chrome.scripting.insertCSS({ origin: 'USER' }).
    'user_stylesheet',

    // DELIBERATELY ABSENT:
    //   html_filtering -- MV3 cannot rewrite response bodies. This is the same
    //     limitation that makes `$replace=` filters unrepresentable in DNR, so
    //     claiming it would enable filters we cannot honour. Leaving it false
    //     also activates the `!#if !cap_html_filtering` fallback blocks that
    //     list maintainers provide for exactly this case.
    //   ipaddress    -- DNR has no IP-address matching condition.
    //   firefox / safari / edge / mobile / legacy / devbuild / adguard
    //                -- not this platform.
];

// Options object shared by every call into ubo-core, so no tool can drift.
export const DNR_OPTIONS = { env: ENV };
