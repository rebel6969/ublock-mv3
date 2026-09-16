# uBlock MV3

A Manifest V3 content blocker for current Chrome, built on uBlock Origin's own
static filtering engine.

Chrome no longer runs Manifest V2 extensions, and MV2 uBlock Origin has been
unpublished from the Web Store. This project compiles uBO filter lists into
Chrome's `declarativeNetRequest` format and ships uBO's real cosmetic-filtering
and scriptlet implementations, so you keep as much of uBO's behaviour as MV3
permits.

Derived from [uBlock Origin](https://github.com/gorhill/uBlock) by Raymond Hill.
GPL-3.0-or-later.

---

## Install

**You do not need Node, and there is no build step.**

1. Download `ublock-mv3.zip` from [Releases](../../releases) and unzip it.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the unzipped folder.

Requires Chrome 121 or newer.

### Bring your uBlock Origin settings across

Dashboard → **Backup** → **Import from file**, and pick a backup exported from
uBO (uBO Dashboard → Settings → *Back up to file*). Configuration is stored in
uBO's own format, so backups move in both directions.

---

## What it does

| | |
|---|---|
| Network blocking | ~124,000 declarativeNetRequest rules |
| Cosmetic filtering | 175,848 site-specific + 47,541 generic selectors |
| Scriptlets | uBO's own library, 99.99% of filters covered |
| Filter lists | Updated in the browser — no rebuild |
| Import / export | uBlock Origin backup format, both directions |

### Updating

Click **Update all lists**. Every list refreshes in the browser; nothing needs a
rebuild.

Lists update one of two ways, because Chrome caps how many rules an extension
may rewrite at runtime (30,000) far below the size of a full filter set:

- **full** — the list is refetched and recompiled outright, as uBO does.
- **patched** — the list ships as a fixed baseline Chrome will not let an
  extension rewrite, so only the *differences* are applied: new rules are added
  and rules dropped upstream are switched off via `updateStaticRules`.

Patching draws on a 6,000-rule reserve. Differences accumulate over months as
lists drift from the baseline they were built against; when the reserve fills,
installing a newer release resets it. The dashboard warns well before that.

---

## What MV3 costs you

Honest accounting. These are browser limitations, not implementation gaps — uBO
Lite has the same ones.

**5,024 filters (4.2%) cannot be expressed in MV3 at all:**

| Count | Reason |
|---|---|
| 2,850 | Unpatchable redirect filters |
| 591 | `$replace=` — rewriting response bodies is impossible in MV3 |
| 570 | Otherwise incompatible with declarativeNetRequest |
| 413 | `domain=` entity wildcards (`example.*`) |
| 117 | Regex filters RE2 cannot compile |
| ~483 | `removeparam`/`csp` exceptions, `strict1p`/`strict3p`, `header=`, `ipaddress=` |

Also missing, and not fixable:

- **No request logger.** `onRuleMatchedDebug` only fires for unpacked extensions.
- **No dynamic filtering matrix.** It needs per-request rule evaluation, which
  MV3 removed.
- **`no-large-media`, `no-strict-blocking`, `no-scripting` switches** have no DNR
  equivalent. The dashboard marks each unsupported rather than ignoring it.

---

## Build it yourself

Only needed to customise the list selection or bake in your own configuration.

```bash
npm install
pip install google-re2      # validates regex against Chromium's 2KB budget
npm run vendor              # fetch uBO's scriptlet library
npm run build:all           # -> extension/
```

Then load `extension/` unpacked.

### Using your own uBlock Origin configuration

```bash
cp ~/Downloads/my-ublock-backup_2026-09-16.txt config/my-config.json
npm run build:all
```

> **Privacy.** A uBO backup lists every site you have disabled blocking on —
> effectively a slice of browsing history — plus any personal filters. It is
> baked into the built extension. `config/my-config.json` and
> `my-ublock-backup_*.txt` are git-ignored, the build prints a loud warning when
> it uses one, and CI refuses to publish such a build. **Do not share a build
> made from your own config.**

Without a personal config the build uses `config/default.json`, which mirrors
uBO's default list selection and contains no personal data.

### Useful commands

```bash
npm run verify              # 11 structural checks on the built extension
npm run check:regex         # every regexFilter against real RE2
npm run check:regexmem      # against Chromium's 2KB compiled-memory budget
node tools/measure-split.mjs        # per-list rule cost
node tools/inspect-list.mjs KOR-1   # explain one list's compilation
```

---

## How it works

```
filter lists ──> @gorhill/ubo-core ──> declarativeNetRequest rules
                                   ├─> cosmetic filters ──> sharded by hostname
                                   └─> scriptlets ──> uBO's library, per world
```

**Network rules.** Compiled by uBO's own engine, not a homegrown converter.
Split between static rulesets (large lists, patched at runtime) and dynamic rules
(everything else, replaced outright).

**Cosmetic filters.** The corpus is ~29 MB, and an MV3 service worker is evicted
constantly, so it is sharded by hostname (FNV-1a, 64 shards). A page load touches
one shard — 472 KiB worst case instead of 29 MB. Generic selectors ship as one
declarative stylesheet.

**Scriptlets.** Must run before the page's own scripts, which rules out a message
round-trip, so they are registered as `document_start` content scripts scoped to
the hostnames that need them — 130 registrations, 49,616 match patterns, in both
MAIN and ISOLATED worlds. uBO hostnames that cannot be Chrome match patterns
(entity patterns like `imgtown.*`, regex hostnames) are matched in-page instead.

### Invariants the build enforces

Each of these fails silently if broken, so each is checked mechanically:

1. **Preprocessor env** (`tools/lib/env.mjs` → `src/lib/env-runtime.js`) — a
   missing token makes `!#if` blocks evaluate false and whole sections vanish
   with no error. This once cost list `KOR-1` all 3,987 of its filters.
2. **Hostname sharding** (`shardOf`) — build and runtime must agree or cosmetic
   lookups miss. Asserted across 20,000 hostnames.
3. **Regex validity** — one pattern RE2 cannot compile makes Chrome reject the
   entire ruleset and refuse to load the extension.
4. **Regex memory** — a pattern can be valid RE2 and still exceed Chromium's 2KB
   compiled budget, in which case Chrome silently skips the rule.
5. **Rule properties** — ubo-core attaches internal keys (`_warning`,
   `__modifier*`); `updateDynamicRules` rejects the entire batch on any unknown
   property.
6. **Match patterns** — one invalid pattern makes `registerContentScripts()`
   reject every script, disabling all scriptlets while the extension still looks
   healthy.

---

## Chrome's declarativeNetRequest limits

Read from the live API on Chrome 152, and matching the values compiled into
`chrome.dll`:

```
GUARANTEED_MINIMUM_STATIC_RULES         30,000
MAX_NUMBER_OF_DYNAMIC_RULES             30,000
MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES       5,000
MAX_NUMBER_OF_SESSION_RULES              5,000
MAX_NUMBER_OF_REGEX_RULES                1,000
MAX_NUMBER_OF_STATIC_RULESETS              100
MAX_NUMBER_OF_ENABLED_STATIC_RULESETS       50
```

`MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES` (5,000) is **deprecated** — the schema
states "There is no longer a combined limit". The widely-repeated 5,000 dynamic
limit is out of date.

---

## Credits

[uBlock Origin](https://github.com/gorhill/uBlock) by Raymond Hill and
contributors. The filtering engine (`@gorhill/ubo-core`), the scriptlet library
and the redirect resources are uBO's work, used under GPL-3.0.

Filter lists belong to their respective maintainers.
