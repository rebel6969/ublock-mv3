// Strip ubo-core's internal bookkeeping from emitted DNR rules.
//
// dnrRulesetFromRawLists attaches properties Chrome does not know about:
//   _warning            (161x)  salvage notes, e.g. "ignored 1 unsupported domain="
//   __modifierAction    (1151x) internal modifier metadata
//   __modifierType      (1151x)
//   __modifierValue     (1151x)
//
// Static rulesets tolerate unknown keys, but chrome.declarativeNetRequest's
// updateDynamicRules validates strictly and rejects the ENTIRE batch:
//   "Error at index 1508: Unexpected property: '_warning'"
// That single unknown key cost 11,950 dynamic rules -- everything but the
// whitelist -- so rules are reduced to the four keys the API actually defines.
const VALID_TOP_LEVEL = [ 'id', 'priority', 'action', 'condition' ];

export function sanitizeRule(rule) {
    const out = {};
    for ( const key of VALID_TOP_LEVEL ) {
        if ( rule[key] !== undefined ) { out[key] = rule[key]; }
    }
    return out;
}

// Returns the cleaned rules plus a tally of which foreign keys were removed, so
// stripping stays visible rather than becoming invisible magic.
export function sanitizeRules(rules) {
    const stripped = new Map();
    const cleaned = rules.map(rule => {
        for ( const key of Object.keys(rule) ) {
            if ( VALID_TOP_LEVEL.includes(key) ) { continue; }
            stripped.set(key, (stripped.get(key) ?? 0) + 1);
        }
        return sanitizeRule(rule);
    });
    return { rules: cleaned, stripped };
}

export { VALID_TOP_LEVEL };
