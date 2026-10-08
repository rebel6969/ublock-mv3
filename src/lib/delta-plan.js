// Which static lists get their latest diff applied.
//
// A patched list is updated WHOLE or not at all: its dropped rules are switched
// off only together with all of its new rules. Applying the switches-off of a
// list whose additions did not fit made blocking weaker than the build itself
// (see applyStaticDeltas in background.js). Pure, so tools/verify.mjs can test
// it without a browser.
//
//   diffs     [{ token, rulesetId, additions, disableRuleIds }] fetched this run
//   applied   { token: { rulesetId, additions, disableRuleIds } } now in force
//   limits    { additions, unsafe, disabled } available to static deltas
//   countUnsafe(rules) -> how many of `rules` count against the unsafe quota
//
// Returns { next, mode }: `next` is the state to put in force, `mode` says per
// list whether it was 'updated', kept its 'previous update', or is at its
// 'baseline'. Lists not refreshed in this run keep what they have while it
// still fits; refreshed lists are admitted smallest change first, so one list
// that changed a lot cannot crowd out the others.
export function planStaticDeltas(diffs, applied, limits, countUnsafe) {
    let room = limits.additions;
    let unsafeRoom = limits.unsafe;
    let quota = limits.disabled;
    const next = {};
    const mode = {};
    const fits = d => d !== undefined &&
        d.additions.length <= room &&
        countUnsafe(d.additions) <= unsafeRoom &&
        d.disableRuleIds.length <= quota;
    const take = (token, d) => {
        next[token] = d;
        room -= d.additions.length;
        unsafeRoom -= countUnsafe(d.additions);
        quota -= d.disableRuleIds.length;
    };
    const fresh = new Set(diffs.map(d => d.token));
    for ( const [ token, d ] of Object.entries(applied) ) {
        if ( fresh.has(token) ) { continue; }
        if ( fits(d) ) { take(token, d); mode[token] = 'previous update'; }
        else { mode[token] = 'baseline'; }
    }
    const cost = d => d.additions.length + d.disableRuleIds.length;
    for ( const d of diffs.slice().sort((a, b) => cost(a) - cost(b)) ) {
        const candidate = { rulesetId: d.rulesetId, additions: d.additions, disableRuleIds: d.disableRuleIds };
        if ( fits(candidate) ) {
            take(d.token, candidate);
            mode[d.token] = 'updated';
        } else if ( fits(applied[d.token]) ) {
            take(d.token, applied[d.token]);
            mode[d.token] = 'previous update';
        } else {
            mode[d.token] = 'baseline';
        }
    }
    return { next, mode };
}

// What is wrong with a plan, if anything: every list in it must hold an intact
// pair (exactly this run's diff, or exactly the update already in force), and
// the totals must fit the limits.
export function planProblems(next, diffs, applied, limits, countUnsafe) {
    const problems = [];
    const byToken = new Map(diffs.map(d => [ d.token, d ]));
    let additions = 0, unsafe = 0, disabled = 0;
    for ( const [ token, d ] of Object.entries(next) ) {
        const fresh = byToken.get(token);
        const intact = x => x !== undefined && x.additions === d.additions && x.disableRuleIds === d.disableRuleIds;
        if ( intact(fresh) === false && intact(applied[token]) === false ) {
            problems.push(`${token}: switched-off rules and new rules are not one list's pair`);
        }
        additions += d.additions.length;
        unsafe += countUnsafe(d.additions);
        disabled += d.disableRuleIds.length;
    }
    if ( additions > limits.additions ) { problems.push(`${additions} new rules > ${limits.additions}`); }
    if ( unsafe > limits.unsafe ) { problems.push(`${unsafe} unsafe new rules > ${limits.unsafe}`); }
    if ( disabled > limits.disabled ) { problems.push(`${disabled} switched-off rules > ${limits.disabled}`); }
    return problems;
}
