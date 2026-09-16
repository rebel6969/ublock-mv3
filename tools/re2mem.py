"""Validate DNR regexFilter patterns against Chromium's 2KB compiled-memory budget.

Chromium compiles each regexFilter with RE2 configured as max_mem = 2KB, and skips
any rule whose pattern exceeds it ("the regexFilter value exceeded the 2KB memory
limit when compiled"). Mere compilability is not enough: `[a-z]{5,13}` compiles
fine but expands hugely in RE2's compiled program.

The node `re2` package does not expose max_mem, so the Python google-re2 binding
is used, which does. This script is the authority the build consults.

Modes:
  --selftest   compare predictions against the rule ids Chrome actually reported
  --audit      list every over-budget pattern in the built extension
  --json PATH  write over-budget ids per ruleset for the build to consume
"""
import argparse
import json
import os
import sys

import re2

# Chromium: kRegexFilterMemoryLimit. The error text states 2KB explicitly.
MAX_MEM = 2 * 1024

DIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'extension')


def over_budget(pattern, case_sensitive=True):
    """Return None if Chrome would accept the pattern, else the reason."""
    opts = re2.Options()
    opts.max_mem = MAX_MEM
    opts.case_sensitive = case_sensitive
    opts.log_errors = False
    try:
        re2.compile(pattern, options=opts)
        return None
    except re2.error as exc:
        return str(exc).replace('\n', ' ')[:160]


BUILD = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'build')


def ruleset_paths():
    """(label, absolute path) for every static ruleset.

    Prefers build/rule_resources.json, which the emitter writes, so pruning can
    run immediately after emission rather than waiting for assemble to produce
    the manifest. Falls back to the manifest when auditing an assembled build.
    """
    resources = os.path.join(BUILD, 'rule_resources.json')
    if os.path.exists(resources):
        with open(resources, encoding='utf-8') as fh:
            entries = json.load(fh)
    else:
        with open(os.path.join(DIST, 'manifest.json'), encoding='utf-8') as fh:
            entries = json.load(fh)['declarative_net_request']['rule_resources']
    for entry in entries:
        yield entry['id'], os.path.join(DIST, entry['path'])


def load_rulesets():
    for label, path in ruleset_paths():
        with open(path, encoding='utf-8') as fh:
            yield label, json.load(fh)


SEED_PATH = os.path.join(DIST, 'rulesets', 'dynamic-seed.json')


def prune():
    """Remove over-budget rules from the static rulesets and the dynamic seed.

    Chrome silently skips these rules at install; removing them means the shipped
    rule counts describe what is actually enforced, and the extensions page stays
    free of warnings that would mask a real problem later.
    """
    total_removed = 0
    per_file = []

    for label, path in ruleset_paths():
        with open(path, encoding='utf-8') as fh:
            rules = json.load(fh)
        kept = []
        removed = 0
        for rule in rules:
            pattern = rule.get('condition', {}).get('regexFilter')
            if pattern is not None:
                cs = rule['condition'].get('isUrlFilterCaseSensitive', True)
                if over_budget(pattern, cs) is not None:
                    removed += 1
                    continue
            kept.append(rule)
        if removed:
            with open(path, 'w', encoding='utf-8') as fh:
                json.dump(kept, fh, separators=(',', ':'))
            per_file.append((label, removed, len(kept)))
            total_removed += removed

    seed_removed = 0
    if os.path.exists(SEED_PATH):
        with open(SEED_PATH, encoding='utf-8') as fh:
            seed = json.load(fh)
        for entry in seed:
            kept = []
            for rule in entry.get('rules', []):
                pattern = rule.get('condition', {}).get('regexFilter')
                if pattern is not None:
                    cs = rule['condition'].get('isUrlFilterCaseSensitive', True)
                    if over_budget(pattern, cs) is not None:
                        seed_removed += 1
                        continue
                kept.append(rule)
            entry['rules'] = kept
        if seed_removed:
            with open(SEED_PATH, 'w', encoding='utf-8') as fh:
                json.dump(seed, fh, separators=(',', ':'))

    # The list catalog is written before pruning, so its per-list rule counts are
    # stale by exactly what was removed here. The dashboard renders those numbers,
    # and a count that does not describe what is actually enforced is worse than
    # no count at all.
    catalog_path = os.path.join(DIST, 'data', 'list-catalog.json')
    catalog_fixed = 0
    if os.path.exists(catalog_path):
        with open(catalog_path, encoding='utf-8') as fh:
            catalog = json.load(fh)
        removed_by_label = {label: n for label, n, _ in per_file}
        # Static entries are keyed by ruleset id; dynamic ones by list token.
        actual = {}
        for label, path in ruleset_paths():
            with open(path, encoding='utf-8') as fh:
                actual[label] = len(json.load(fh))
        seed_counts = {}
        if os.path.exists(SEED_PATH):
            with open(SEED_PATH, encoding='utf-8') as fh:
                for entry in json.load(fh):
                    seed_counts[entry['token']] = len(entry.get('rules', []))
        for entry in catalog:
            if entry.get('kind') == 'static' and entry.get('id') in actual:
                if entry.get('rules') != actual[entry['id']]:
                    entry['rules'] = actual[entry['id']]
                    catalog_fixed += 1
            elif entry.get('token') in seed_counts:
                if entry.get('rules') != seed_counts[entry['token']]:
                    entry['rules'] = seed_counts[entry['token']]
                    catalog_fixed += 1
        with open(catalog_path, 'w', encoding='utf-8') as fh:
            json.dump(catalog, fh, indent=2)

    print('PRUNE over-budget regex rules')
    print('=' * 70)
    for label, removed, remaining in sorted(per_file, key=lambda r: -r[1]):
        print(f'  -{removed:<4} {label} ({remaining:,} rules remain)')
    print(f'\n  static rules removed: {total_removed}')
    print(f'  dynamic seed rules removed: {seed_removed}')
    print(f'  list-catalog.json entries corrected: {catalog_fixed}')
    return total_removed + seed_removed


def scan():
    """ruleset id -> {rule id: reason} for every over-budget pattern."""
    result = {}
    total = 0
    for name, rules in load_rulesets():
        bad = {}
        for rule in rules:
            pattern = rule.get('condition', {}).get('regexFilter')
            if pattern is None:
                continue
            total += 1
            cs = rule['condition'].get('isUrlFilterCaseSensitive', True)
            reason = over_budget(pattern, cs)
            if reason is not None:
                bad[rule['id']] = {'regexFilter': pattern, 'reason': reason}
        if bad:
            result[name] = bad
    return result, total


# Rule ids Chrome reported as skipped, transcribed from the extensions error page.
# Chrome truncates each ruleset at 5 ("Too many rule parse failures"), so this is a
# subset: every id here must be predicted over-budget, but predicting MORE is
# expected and correct.
CHROME_REPORTED = {
    'easyprivacy': [8154],
    'adguard-generic': [280, 1479, 2088, 3622, 3903],
    'CHN-0': [387, 5520],
    'RUS-0': [3863, 4951, 5088],
    'FRA-0': [3228, 3229],
    'easylist': [526, 527, 528, 529, 530],
    'ublock-filters': [1175, 1178, 1305, 1342, 1348],
    'UKR-0': [1010, 1029, 1030, 1031, 1083],
    'TUR-0': [322, 603],
    'ublock-badware': [378, 380, 381, 427, 521],
    'KOR-1': [598, 676, 725],
    'ITA-0': [938],
    'ublock-privacy': [751, 784],
    'POL-0': [170, 171, 496, 516, 570],
    'spa-0': [502, 529],
    'adguard-mobile': [5, 6],
    'adguard-other-annoyances': [55],
}


def selftest(found):
    print('SELF-TEST: do predictions match what Chrome reported?')
    print('=' * 70)
    misses = []
    hits = 0
    for name, ids in CHROME_REPORTED.items():
        predicted = found.get(name, {})
        for rid in ids:
            if rid in predicted:
                hits += 1
            else:
                misses.append((name, rid))
    expected = sum(len(v) for v in CHROME_REPORTED.values())
    print(f'  Chrome-reported ids: {expected}')
    print(f'  predicted over-budget: {hits}')
    if misses:
        print(f'  MISSED {len(misses)} (emulation is too lenient):')
        for name, rid in misses[:20]:
            print(f'      {name} id={rid}')
        return False
    print('  all Chrome-reported ids correctly predicted')
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--selftest', action='store_true')
    ap.add_argument('--audit', action='store_true')
    ap.add_argument('--prune', action='store_true',
                    help='rewrite rulesets with over-budget rules removed')
    ap.add_argument('--json')
    args = ap.parse_args()

    if args.prune:
        removed = prune()
        # Re-scan to prove the output is now clean.
        found, total = scan()
        n = sum(len(v) for v in found.values())
        print(f'\n  re-scan: {total} patterns, {n} over budget')
        sys.exit(0 if n == 0 else 1)

    found, total = scan()
    n_bad = sum(len(v) for v in found.values())
    print(f'regexFilter patterns scanned: {total}')
    print(f'over the {MAX_MEM}-byte budget: {n_bad}')
    print()

    ok = True
    if args.selftest:
        ok = selftest(found)
        print()

    if args.audit:
        print('OVER-BUDGET BY RULESET')
        print('=' * 70)
        for name in sorted(found, key=lambda k: -len(found[k])):
            print(f'  {len(found[name]):4d}  {name}')
        print()
        print('SAMPLES')
        for name in sorted(found, key=lambda k: -len(found[k]))[:6]:
            print(f'\n  --- {name} ---')
            for rid, info in list(found[name].items())[:3]:
                print(f'    id={rid} {info["regexFilter"][:110]}')

    if args.json:
        payload = {
            'maxMem': MAX_MEM,
            'scanned': total,
            'overBudget': n_bad,
            'byRuleset': {k: sorted(v.keys()) for k, v in found.items()},
            'details': found,
        }
        with open(args.json, 'w', encoding='utf-8') as fh:
            json.dump(payload, fh, indent=2)
        print(f'wrote {args.json}')

    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
