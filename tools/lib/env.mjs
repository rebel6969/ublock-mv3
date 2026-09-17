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
    // The same tokens uBlock Origin MV2 sets on Chrome (uBlock0.chromium
    // js/vapi-common.js, webextFlavor.soup). This extension runs uBO's own
    // scriptlets and procedural engine in the page, like MV2, so lists must
    // resolve to MV2's branches. Claiming `ubol`/`mv3` selected uBO Lite's
    // branches instead (e.g. quick-fixes `!#if !env_mv3` YouTube blocks),
    // which is a different filter set from what the user's MV2 build runs.
    'ublock',
    'webext',
    'chromium',
    // Chrome supports :has() natively; MV2 adds this after CSS.supports().
    'native_css_has',

    // DELIBERATELY ABSENT (differs from MV2 or not this platform):
    //   ipaddress    -- MV2 sets it, but DNR has no IP-address matching, so
    //     the `!#else` fallbacks list maintainers provide are the usable ones.
    //   html_filtering -- MV2 on Chrome does not set it either.
    //   ubol / mv3   -- uBO Lite branches, see above.
    //   firefox / safari / mobile / devbuild / brave / adguard -- not this build.
];

// Options object shared by every call into ubo-core, so no tool can drift.
export const DNR_OPTIONS = { env: ENV };
