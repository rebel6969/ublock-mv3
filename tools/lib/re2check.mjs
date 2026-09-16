// Validate DNR regexFilter patterns the way Chrome actually validates them.
//
// Chrome compiles regexFilter with RE2, which deliberately omits constructs that
// cannot be matched in linear time -- backreferences and lookaround chief among
// them. A pattern RE2 rejects makes Chrome refuse the ENTIRE ruleset with a terse
// "specifies an incorrect value for the regexFilter key", so one bad pattern out
// of 112,790 rules blocks the whole extension from loading.
//
// Heuristics are not good enough here: the only authority is RE2 itself, so the
// real library is used. Validation happens at build time so a bad pattern can
// never reach the browser.
import RE2 from 're2';

// Chrome also caps the compiled size of each regex. The documented budget is
// expressed in "regex memory units"; patterns anywhere near it are rare, but a
// generous length guard keeps a pathological pattern from being emitted.
const MAX_PATTERN_LENGTH = 2000;

export function checkRegex(pattern, { caseSensitive = true } = {}) {
    if ( typeof pattern !== 'string' || pattern === '' ) {
        return { ok: false, reason: 'not a non-empty string' };
    }
    if ( pattern.length > MAX_PATTERN_LENGTH ) {
        return { ok: false, reason: `pattern too long (${pattern.length} > ${MAX_PATTERN_LENGTH})` };
    }
    try {
        // RE2 throws on any construct it cannot compile.
        new RE2(pattern, caseSensitive ? '' : 'i');
        return { ok: true };
    } catch ( reason ) {
        return { ok: false, reason: reason.message.replace(/\s+/g, ' ').slice(0, 160) };
    }
}

// Partition a DNR ruleset into rules Chrome will accept and rules it will not.
export function filterValidRegexRules(rules) {
    const kept = [];
    const dropped = [];
    for ( const rule of rules ) {
        const pattern = rule.condition?.regexFilter;
        if ( pattern === undefined ) {
            kept.push(rule);
            continue;
        }
        const verdict = checkRegex(pattern, {
            caseSensitive: rule.condition.isUrlFilterCaseSensitive !== false,
        });
        if ( verdict.ok ) {
            kept.push(rule);
        } else {
            dropped.push({ id: rule.id, regexFilter: pattern, reason: verdict.reason });
        }
    }
    return { kept, dropped };
}
