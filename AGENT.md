# AGENT.md — guide for AI agents working on tf2Arbitrage

Read this file fully before changing anything. It explains what the code does, how the parts talk to each other, the conventions the code relies on, and step-by-step recipes for the most common changes. Where something was **not fully mapped**, it is marked `[unverified]`; read the code before trusting it.

---

## 0. Safety rules (read first)

This project spends **real Steam items** and sends **real trade offers** from the user's account.

1. **Never enable automatic trading** (`tradeAutomationEnabled`) in any test, script or default. It defaults to `false`; keep it that way.
2. **Use Offline mode when testing scans.** `offlineScan=true` (the "Scan Offline" button) saves Good Trades but buys nothing and sends nothing. See `enqueueTradeJob()`.
3. **Use dry-run for the Mac helper.** `confirm_server.py --dry-run`, `confirm_trades.py N --dry-run`, `launch.py --server-dry-run`. Never run the real clicker in tests.
4. **Never commit or print secrets:** `.env.local` (Steam API key, session secret), `macConfirmer/server_config.json` (token + ntfy topic), the Steam Web API key kept in extension storage (`steamWebApiKey`). Do not paste their values into code, docs or logs. If you see them, leave them alone.
5. **Do not make requests faster or more aggressive.** Delays (`BETWEEN_ITEMS_*`, `BETWEEN_CLASSIFIED_PAGES_*`, `waitForScrapRequestGap`) exist because Backpack.tf rate-limits and STN/scrap.tf have bot checks. Do not lower them without being asked.
6. **Do not remove safety checks** (price re-check before scrap.tf cart, craftability check on purchase offers, raw-key budget, "only accept when Web API says state 3", blacklist). Changes must keep them working.

---

## 1. What the project is

A bot that finds TF2 hats that can be bought cheaply on **STN Trading** (`stntrading.eu`) or **scrap.tf** and sold for more to **Backpack.tf buy-order bots**. It then (optionally) performs the trade end-to-end.

```
 STN / scrap.tf price  --(profit >= 0.05 ref)-->  Backpack.tf bot buy order
        buy side                                         sell side
```

Pipeline for one item:

1. **Read** the marketplace price/stock from the open STN or scrap.tf tab.
2. **Look up** bot buy orders on Backpack.tf (stats page, then classifieds pages).
3. **Analyze**: keep fresh, non-blacklisted, generic orders; compute profit (`analyze()`).
4. **Verify** each profitable bot can really pay: open its Steam trade-offer page, let TF2 Metal Trader try to stage the metal (`inspectListingTradeOffer()`, `verifyProfitableListings()`).
5. **Good Trade** → notification + sound; saved to storage.
6. **Execute** (only if auto trading is on): buy → accept Steam offer → mobile-confirm → send offers to bots → track and re-send cancelled ones.

Secondary features: reverse scan (buy on Backpack.tf, sell to STN; report-only), scrap.tf→STN check (report-only), saved-trade re-check, 60-minute "already checked" memory, STN auto-rescan loop.

---

## 2. Repository map

| Path | Role | Manifest |
| --- | --- | --- |
| `tf2_trade_arbitrage_prototype/` | **Scanner / analyzer add-on** (the main bot). Popup + sidebar UI, scan loop, verification, trade queue. | **MV2**, persistent background page |
| `automaticMetal/` | **TF2 Metal Trader** add-on ("TMT"). Operates Steam trade-offer pages: stages metal, sends bot offers, accepts incoming offers, tests trader metal. Driven by the scanner through URL hash parameters and DOM events. | **MV3** |
| `macConfirmer/` | Python HTTP server on a Mac that approves Steam mobile confirmations by clicking in iPhone Mirroring (`cliclick`). | n/a |
| `browserShell/` | `launch.py`: launches a dedicated Firefox profile with both add-ons, the sidebar, and the confirm server. | n/a |
| `README.md` | User-facing documentation. Keep it accurate when behavior changes. | |
| `tf2_trade_arbitrage_prototype/README.txt`, `automaticMetal/README.md` | **Changelogs** (newest first). | |

### Scanner add-on files (`tf2_trade_arbitrage_prototype/`)

| File | Role |
| --- | --- |
| `background.js` (~4.3k lines) | **All orchestration.** Scan loop (`next`/`nextInner`), `analyze`, verification, trade queue (`runTradeQueue`, `executeTradeJob`), purchases (STN/scrap.tf), Steam Web API polling, bot-offer tracking and re-sending, Mac confirmer client, sounds, notifications, window/tab management, message router. |
| `content.js` (runs on `<all_urls>`) | Page readers and actors: STN/scrap.tf listing reader + buy actions, Backpack.tf stats/classifieds readers + highlighter, Steam offer page relay to TMT, STN purchase-offer detection, PageDown. |
| `popup.js`, `popup.html`, `popup.css` | UI (toolbar popup and sidebar `popup.html?mode=sidebar`). All tabs/cards rendering, settings, scan buttons. |
| `blacklist.js` | `TraderBlacklist` — Steam IDs of traders to ignore. Shared by `background.js` and `content.js`. |
| `checked-items.js` | `TF2CheckedItems` — 60-minute memory of checked items (per direction: `forward`/`reverse`). Storage key `checkedItems`. |
| `saved-trades.js` | `TF2SavedTrades` — saved Good Trades / bought items. Storage key `savedTrades`. Max 500 entries. |
| `mac-confirmer-seed.js` | `TF2MacConfirmerSeed` — fills the `macConfirmer` setting from a launcher-packed `mac-confirmer.json`. |
| `cookie-keeper.js` | Makes session cookies of Steam/STN/scrap.tf/Backpack.tf persistent for 30 days. Setting `keepLogins`. |
| `scanner.html` | Tiny page used for the "TF2 Arbitrage Scanner" window. |

### TF2 Metal Trader files (`automaticMetal/`)

| File | Role |
| --- | --- |
| `content.js` (~3.8k lines) | Runs on `steamcommunity.com/tradeoffer/*`. Reads `tmt_*` URL hash params, builds/sends/accepts offers, verifies trader metal, panel UI (`#tf2-metal-trader`, `#tmt-status`). Isolated content-script world. |
| `page-bridge.js` | Injected into the **page world** (web-accessible resource). Touches Steam's own JS objects (inventory/`rgItem`, trade functions) and observes Steam's `POST /tradeoffer/new/send` and `/tradeoffer/<id>/accept`. Talks to `content.js` via `tmt-*` CustomEvents. |
| `backpack.js` | Content script for `backpack.tf` and `stntrading.eu/item/*` pages (adds trade-button URL building). `[unverified]` in detail. |
| `background.js` | Small: opens validated Steam offer URLs, closes its own tab on request. |

### Mac helper (`macConfirmer/`)

`confirm_server.py` (HTTP API + worker queue, ntfy notifications), `confirm_trades.py` (clicks; **screen coordinates are hardcoded constants**), `phone_state.py` (pixel-colour check of "is the phone on the confirmations page"), `refresh_swipe.py` (pull-to-refresh via CoreGraphics wheel events).

---

## 3. Conventions you must follow

### 3.1 No build system, no bundler (checks and tests are plain scripts, see §11)
- Plain JavaScript loaded directly by Firefox. **No imports, no TypeScript, no npm.** Files in a manifest `scripts` array share one global scope, in listed order: `blacklist.js, cookie-keeper.js, saved-trades.js, checked-items.js, mac-confirmer-seed.js, background.js`. A new helper file must be added to the manifest **before** `background.js`.
- `background.js` is one big global scope. Top-level `let` state is shared across all functions.
- Helper modules use this UMD-ish pattern (copy it for new ones; it also makes them testable in Node):

```js
(function(root){
  "use strict";
  const STORAGE_KEY="myThing";
  function keyFor(name){return String(name||"").trim().toLowerCase()}
  // ...pure functions that take and return plain objects...
  const exported={STORAGE_KEY,keyFor /* ... */};
  if(typeof module!=="undefined"&&module.exports)module.exports=exported;
  else root.TF2MyThing=exported;
})(typeof self!=="undefined"?self:this);
```

### 3.2 Browser API alias
Every file starts with:
```js
const api=typeof browser!=="undefined"?browser:chrome;
```
Firefox `browser.*` returns Promises; `chrome.*` uses callbacks. `background.js` has Promise wrappers (`qTabs`, `createTab`, `updateTab`, `removeTab`, `msgTab`, `storageGet`, `storageSet`, …) — **use them**; do not mix callback and Promise styles (the comment near `isFirefoxBrowserApi` explains a real hang this causes).

### 3.3 File format quirks — preserve them
- `background.js`, `blacklist.js`, `confirm_trades.py`, TMT `content.js`/`page-bridge.js`, and the manifests use **CRLF** line endings. Other JS files use LF. **Do not convert line endings** and do not rewrite whole files; make targeted edits so diffs stay small.
- Both `manifest.json` files start with a **UTF-8 BOM**. Keep it. Edit them with exact string replacement.
- The code is written in a **compact style** (no spaces around `=`/`,`, long lines). Match the surrounding style in each file. Do not reformat.
- Typographic quirk: a few UI strings use `—` and `…`; that is fine.

### 3.4 Duplicate function names in `background.js`
JavaScript hoists function declarations; **the last definition wins**. Currently duplicated:
- `waitForTabComplete` — defined near line 86 `(id,timeout=20000)` **and** near line 3464 `(tabId,timeout=PAGE_SETTLE_TIMEOUT,pollMs=LISTING_POLL_MS)`. The later one is the effective one.
- `closeCurrentTab` — defined twice near lines 3674 and 3692. The later one wins.

Before editing a function, `grep -n "function NAME" background.js` and confirm there is only one. Do not "clean up" duplicates without being asked; behavior may depend on which wins.

### 3.5 Async message handlers must `return true`
In `runtime.onMessage` listeners, if you call `sendResponse` asynchronously you **must `return true`** synchronously, or the channel closes. Pattern used throughout:

```js
if(m.type==="MY_MESSAGE"){
  (async()=>{
    // ...work...
    sendResponse({ok:true});
  })().catch(error=>sendResponse({ok:false,error:error?.message||String(error)}));
  return true;
}
```

### 3.6 Version bumps and docs (the repo's habit)
Each change ships with a version bump. Update **all** of:
1. `version` in the add-on's `manifest.json` (check the manifests for the current numbers; `python tools/check.py` verifies that they agree with the changelogs).
2. `browser_action.default_title` (scanner) / `action.default_title` (TMT): keep the version in them in sync (`tools/check.py` warns when they drift).
3. A new top entry in the changelog: scanner → `README.txt` (line "Current version …" + entry), TMT → `automaticMetal/README.md` (`## v0.9.x — summary` entry at top).
4. `README.md` (root) if user-visible behavior changed.

Note: `popup.html` hardcodes `v0.7.102` in `#version`, but `popup.js` overwrites it from the manifest at runtime (`$("version").textContent`). Ignore the stale HTML text.

---

## 4. Architecture

### 4.1 Runtime picture

```
  ┌────────────────────────────── Firefox ──────────────────────────────┐
  │  popup.js / sidebar  ──runtime.sendMessage──►  background.js (MV2)   │
  │        ▲  SCAN_RESULT, SCAN_FINISHED,              │  tabs/windows   │
  │        │  TRADE_AUTOMATION_STATUS, ...             │  Steam Web API  │
  │        └───────────────────────────────────────────┤  fetch → Mac    │
  │                                                    ▼                 │
  │  content.js (scanner, <all_urls>)   ◄── msgTab({type}) ──           │
  │   ├ STN / scrap.tf: read listings, QuickBuy, cart                    │
  │   ├ backpack.tf: read buy orders/classifieds, highlight listings     │
  │   └ steamcommunity offer page: window CustomEvents ──► TMT content.js│
  │                                         ▲                            │
  │  TMT content.js ◄── tmt-* events ──► page-bridge.js (page world)     │
  └──────────────────────────────────────────────────────────────────────┘
                        background.js ── HTTP ──► macConfirmer (Mac)
```

### 4.2 Windows and tabs (important, easy to break)
- All scanning happens in a **dedicated "TF2 Arbitrage Scanner" window** (`ensureAutomationWindow`, `automationWindowId`). The user's main window is not flipped between tabs.
- **Exception:** anything with Steam trade offers (offer verification, STN/scrap.tf purchase offer, bot offers) runs as the **active tab of the main window** (`createOfferTab`, `createTransactionTab`, `restoreAfterOfferTab`). Steam does not reliably load the other trader's inventory in a background tab. The previously active tab is restored afterwards.
- The scan and the trade worker share the scanner window and **take turns** (`scanItemBusy`, `isTradeWorkBusy`, `waitForScanIdle`, `waitForTradeIdle`). Don't open tabs from new code without going through these helpers, or tabs get orphaned. Track tabs in `ownedTabIds` / `transactionTabIds`; `closeAllOwnedTabs()` cleans up.
- The scanner window must stay **visible** (STN's bot check only runs in a visible page).

### 4.3 Scan loop
`startItemScan(m,sendResponse)` (for START_SCAN) → builds `queue` via `planScanQueue()` (skips items in the 60-minute memory, interleaves STN/scrap.tf with `interleaveBySource`) → `next()` → `nextInner()` processes one item at a time:

`marketplaceUrl / refreshItemFromStn|Scrap` → `readStatsBuyOrders` / `openAndReadClassifieds` → `analyze()` → `verifyProfitableListings()` → `finish(result)` (stores, notifies, `enqueueTradeJob` when auto trading). Reverse flows: `processReverseItem`, `processScrapToStnItem`.

Before Backpack.tf is opened for an STN item, `nextInner()` opens that item's own STN page (`refreshItemFromStn`) to read its stock and current price. No stock → the item is skipped ("STN has none in stock right now", not remembered in the 60-minute table). A page that does not load is retried once; 3 misses in a row pause the scan 45 s (`SAVED_BACKOFF_MS`). With `prefetchStn` the same visit also reads STN's buy price so the reverse check does not open the page again.

`next()` wraps `nextInner()`: errors are caught, recorded as a skipped result, and the scan stops after `SCAN_MAX_STEP_ERRORS` (5) consecutive failures. New scan-step code must throw rather than swallow errors so this net works.

Scan modes (variable `scanMode`): `pages`, `noSell`, `offline`, `saved`, `reverse`. **Only one scan runs at a time** — new scan entry points must call `scanBusyError()` first and set `scanMode`.

### 4.4 Trade pipeline
`finish(result)` → `enqueueTradeJob(result)` → pushes a **job** onto `tradeAutomationQueue` → `runTradeQueue()` → `executeTradeJob(job)`:

```
executeTradeJob(job)
  ├─ loadSteamWebApiKey(); fetchSteamReceivedOffers()      // proves API access
  ├─ loop while purchasedQuantity < quantity
  │    ├─ planKeyPurchase(job, remaining)                  // raw-key budget
  │    ├─ openStnPurchaseBatch | openScrapPurchaseBatch    // site creates a Steam offer
  │    ├─ acceptStnPurchaseBatch                           // accept + (Mac) confirm + wait state 3
  │    │     └─ waitForSteamOfferAccepted → Steam Web API poll
  │    ├─ recordPurchase()                                 // purchaseLog, Bought tab
  │    └─ if keyLimited: sellUnsold(job)                   // buy-sell-buy-sell
  └─ sellUnsold(job, all)
       └─ sellListings → sendBotOffer per verified listing // TMT does the clicking
            └─ trackSentBotOffer → runBotOfferTracker      // poll, re-send on state 8
```

Job shape (from `enqueueTradeJob`):
```js
{ id:"arb-<ts>-<rand>", name, quantity, offerCount, purchasedQuantity:0,
  listings:[/*verified bot listings*/], backpackUrl, windowId, forceManual, skipPurchase,
  source:"stn"|"scrap.tf", scrapUrl, maxScrapValue, buyPriceText, sellPriceText,
  profitRef, status:"queued" }
```
Runtime fields added later: `purchaseOfferIds`, `usedAssetIds`, `pendingListings`, `soldQuantity`, `sendSeq`, `keyLimited`, `keyShortage`, `step`, `transactionTabId`, `purchaseTabId`, …

### 4.5 Raw-key budget (do not bypass)
STN/scrap.tf convert metal to keys at their own rate when your inventory lacks keys. `planKeyPurchase` reads the account's raw key count (`fetchRawKeyCount`) and buys only what keys cover (`keysPerItem` = ceil of the key part of the price). It returns one of `{amount,limited}`, `{sellFirst:true}`, `{stop:"reason"}`. Metal is **not** budgeted. Constants: `KEY_POLL_MS=20000`, `KEY_WAIT_MAX_MS=45min`.

---

## 5. Key data shapes

### 5.1 Item (queue entry)
```js
{ name, price, stock, href, source:"stn"|"scrap.tf",
  scrapValue?, reverse?:true, scrapToStn?:true, fromSaved?:true }
```
`TF2CheckedItems.keyFor(name)` / `TF2SavedTrades.keyFor(name)` normalise names (lower-case trim) for map keys.

### 5.2 Parsed price
`parsePrice(text)` returns an object with at least `refValue` (everything in ref), `keys`, and `display`. All profit math uses `refValue`. Key rate is `keyRate` (default **63**, set from the popup; saved as `keyRate`).

### 5.3 Analysis result (`analyze()` output, then mutated by verification/finish)
```js
{ name, buyPrice, sellPrice, bestListing, tradeOfferUrl, profitRef, deal,
  profitableListingCount, profitableListings:[listing...], totalBotListings,
  staleListingsIgnored, blacklistedIgnored,
  // after verifyProfitableListings():
  priceProfitableListingCount, priceProfitableItemCount, offerChecks:[listing+{verification}],
  verifiedProfitableListingCount, verifiedProfitableItemCount, insufficientListingCount,
  badTraderListingCount, unverifiedListingCount, verificationOverride, unverifiedDeal,
  // or a skipped result:
  skipped:true, reason }
```
`verification.status` is one of `sufficient`, `insufficient`, `unverified`, `bad-trader`, `already-trading`. `result.deal = verified.length>0 || usableChecks.length>1`. **Only `sufficient` listings are ever traded** (`sufficientOfferListings(result)`).

### 5.4 Backpack.tf listing (as read by `content.js`)
Fields used by the background: `price`, `tradeUrl` (Steam `/tradeoffer/new/?partner=…&token=…`), `listingName`, `comment`, `description`, `quantity` / `listedQuantity`, `bumpedAt`, `listedAt`, trader id fields (matched by `TraderBlacklist`). Quantity helpers: `listingItemQuantity`, `limitListingsToQuantity`, `splitListings`, `deduplicateListings`.

### 5.5 Steam trade offer states (Web API)
```
1 Invalid  2 Active  3 Accepted  4 Countered  5 Expired  6 Canceled
7 Declined  8 InvalidItems  9 CreatedNeedsConfirmation  10 CanceledBySecondFactor  11 InEscrow
```
- Terminal for purchases: `STEAM_TRADE_OFFER_TERMINAL_STATES = {1,4,5,6,7,8,10}`.
- A purchase counts as done **only at state 3**.
- Sent bot offers: state 9 → ask the Mac to confirm; **state 8 → re-send** (up to `BOT_OFFER_MAX_RESENDS`=3); state 3 or 11 → done.

---

## 6. Message and event protocols

### 6.1 popup → background (`runtime.sendMessage`, `type` field)
`GET_STATE`, `GET_SCAN_MODE`, `START_SCAN`, `START_REVERSE_SCAN`, `START_SAVED_SCAN`, `STOP_SCAN`, `RETRY_ITEM`, `SET_TRADE_AUTOMATION {enabled}`, `SET_VOLUME`, `FORCE_VERIFIED_AUTO_TRADE`, `OPEN_VERIFIED_BACKPACK_PAGES`.
All handled in the single `api.runtime.onMessage.addListener((m,s,sendResponse)=>…)` in `background.js` (near line 4334). The popup uses its own `send(...)` helper.

### 6.2 background → popup (broadcast via `popup(m)`)
`TRADE_AUTOMATION_STATUS {state}`, `OFFER_CHECK_PROGRESS`, `SCAN_RESULT {result,checked,total}`, `SCAN_FINISHED {checked,total}`. Handled by the listener at the top of the "onMessage" block in `popup.js` (~line 691). `emitTradeAutomationStatus(text)` is the standard way to show a status line.

### 6.3 background → scanner content.js (`msgTab(tabId,{type,...})`)
Reading: `READ_BUY_PAGE`, `READ_STATS_BUY_ORDERS`, `READ_STATS_SELL_LISTINGS`, `READ_CLASSIFIEDS_PAGE`, `READ_CLASSIFIEDS_LINK`, `CHECK_CLASSIFIEDS_READY`, `CHECK_BACKPACK_ERROR`, `READ_STN_ITEM_PAGE`, `READ_STN_SELL_PAGE`, `GET_PAGE_VISIBILITY`.
Acting: `PAGE_DOWN`, `HIGHLIGHT_LISTING(S)`, `HIGHLIGHT_MARKET_ITEM`, `GET_STN_QUICKBUY_OPTIONS`, `QUICK_BUY_AMOUNT`, `AUTOMATED_QUICK_BUY`, `GET_STN_PURCHASE_OFFER`, `SCRAP_BUY`, `SCRAP_QUEUE_STATE`, `SCRAP_CANCEL_QUEUE`, `READ_TRADE_OFFER_METAL {requiredRef}`, `GET_TMT_AUTOMATION_STATUS`.
Handler lives in the `api.runtime.onMessage.addListener((msg,sender,sendResponse)=>…)` at the bottom of scanner `content.js` (~line 1808).

### 6.4 scanner content.js → background (relayed from TMT)
`TRADE_PURCHASE_PROGRESS`, `TRADE_PURCHASE_ACCEPTED`, `TRADE_PURCHASE_FAILED`, `TRADE_LISTING_SENT`, `TRADE_LISTING_RETRYING`, `TRADE_LISTING_RETRY_FAILED`. Background turns them into awaitable events with `waitForTradeEvent(jobId,eventName,timeout)` / `settleTradeEvent(key,value,error)` keyed `"EVENT_NAME:operationId"`.

### 6.5 Scanner ↔ TMT (same Steam page, DOM `window` CustomEvents)
| Direction | Event |
| --- | --- |
| scanner → TMT | `tf2mt-verify-trader-metal` (request) |
| TMT → scanner | `tf2mt-verify-trader-metal-started`, `tf2mt-verify-trader-metal-result` |
| TMT → scanner | `tf2mt-arbitrage-purchase-progress` / `-accepted` / `-failed` |
| TMT → scanner | `tf2mt-arbitrage-listing-sent` / `-retrying` / `-retry-failed` |

Inside TMT, `content.js` ↔ `page-bridge.js` use `tmt-*` request/`-result` pairs (e.g. `tmt-select-inventory` → `tmt-select-inventory-result`, `tmt-move-item`, `tmt-remove-item`, `tmt-set-filter`, `tmt-count-inventory-items`, `tmt-classify-craftability`, `tmt-confirm-trade`, `tmt-accept-incoming`…). `page-bridge.js` events carry `detail` as a **JSON string** (`emit(name,detail)` stringifies). Check each listener before assuming an object vs. a string `[unverified for every event]`.

### 6.6 Scanner → TMT via the offer URL hash
The scanner never calls TMT functions; it **opens a Steam offer URL with a hash** that TMT reads. Build it with `URLSearchParams` and assign to `url.hash`.

| Param | Meaning |
| --- | --- |
| `tmt_verify=1` | Verify-only mode: test staging metal, then remove (never sends). |
| `tmt_required_ref` | Metal (ref) the trader must be able to pay. |
| `tmt_item`, `tmt_wanted`, `tmt_quality`, `tmt_cosmetic` | "Bad trader" check: does the trader already hold ≥ wanted copies? |
| `tmt_keys`, `tmt_key_rate` | Key part of the price; trader pays with physical keys first, metal for the rest. |
| `tmt_listing=1` | Send-offer mode for a bot listing. |
| `tmt_name`, `tmt_price`, `tmt_intent` (`buy`/`sell`), `tmt_comment`, `tmt_description`, `tmt_quantity` | The listing being fulfilled. |
| `tmt_quality`, `tmt_craftable` (`1`/`0`), `tmt_cosmetic` (`1`/`0`) | Inventory filters / craftability match. |
| `tmt_exclude_assets` | Comma-separated asset ids already used in earlier offers of this job. |
| `tmt_arb_job` | Operation id; echoed back in `TRADE_LISTING_*` events so the background can match them. |
| `tmt_asset` | Exact asset for sell orders. |

Reference implementations: `buildBotOfferUrl()` (send) and `inspectListingTradeOffer()` (verify) in scanner `background.js`; param parsing at the top of TMT `content.js` (search `tmt_`).

### 6.7 Mac confirmer HTTP API
Header `X-Confirm-Token: <token>` required (except `GET /ping`). Loopback / allowed clients only.

| Route | Purpose |
| --- | --- |
| `GET /ping` | Liveness (no token). |
| `GET /status` | Queue state; `paused` holds a failure reason. |
| `POST /confirm {offerIds:[…numeric strings], retry?:bool}` | Queue confirmations (202/200). Returns `duplicate` if already queued. |
| `POST /resume` / `POST /cancel` | Resume after pause / clear queue. |
| `POST /focus` | Bring iPhone Mirroring to the front (never clicks). |
| `POST /shutdown` | Stop the server (sent when the browser window closes). |

Client side: `macConfirmerFetch(settings,path,body)` (8 s timeout), `requestMacConfirmations(entries)`. Retry policy constants: `MAC_CONFIRM_RETRY_AFTER_MS=120000`, `MAC_CONFIRM_MAX_REQUESTS=3`, `MAC_CONFIRM_MAX_ERRORS=5`, `MAC_CONFIRM_ERROR_BACKOFF_MS=30000`. The Mac accepts the **top** confirmation by count, not by offer id.

---

## 7. Storage (`api.storage.local`) keys

| Key | Owner | Meaning |
| --- | --- | --- |
| `tradeAutomationEnabled` (bool, default false) | bg | Auto trading switch. |
| `keyRate` (default 63) | popup | Ref per key. |
| `notificationVolume`, `volumeDefaultApplied` | both | Sound volume. |
| `steamWebApiKey` | popup/bg | **Secret.** |
| `macConfirmer` `{url,token,enabled}` | popup/seed | Mac helper connection. **Secret token.** |
| `scanState` | bg | Persisted progress (`saveState`). |
| `checkedItems` | `TF2CheckedItems` | 60-min memory; ≤2000 entries. |
| `savedTrades` | `TF2SavedTrades` | Good/bought items; ≤500. |
| `purchaseLog` (array), `boughtSavedBackfill` | bg | Bought tab data. |
| `dismissedItems` (array), `tf2ArbTraderHistory` | popup | Dismissed cards, marked traders. |
| `scanSiteChoices`, `scrapSkipCraft` (default true), `stnAutoRescan` (default true), `keepLogins` (default true) | popup | UI options. |

To add a setting: read with a default (`storageGet({myKey:default})` in bg, `storage.local.get({myKey:default},…)` in popup), write with `storageSet`, and add a row here.

---

## 8. Constants worth knowing (all in `background.js`)

```js
const MIN_PROFIT_REF=0.05;                       // minimum profit to be a hit
const MAX_LISTING_ACTIVITY_AGE_MS=10*60*60*1000; // ignore buy orders not listed/bumped in 10h
const BETWEEN_ITEMS_MIN=5500, BETWEEN_ITEMS_MAX=8500;
const BETWEEN_CLASSIFIED_PAGES_MIN=4500, BETWEEN_CLASSIFIED_PAGES_MAX=7000;
const MAX_CLASSIFIEDS_PAGES=50, PAGE_SETTLE_TIMEOUT=15000, LISTING_POLL_MS=1000;
const BOT_OFFER_TIMEOUT_MS=420000, STEAM_TRADE_OFFER_TIMEOUT_MS=660000, STEAM_TRADE_OFFER_POLL_MS=2000;
const BOT_OFFER_TRACK_POLL_MS=12000, BOT_OFFER_TRACK_MAX_MS=3*60*60*1000, BOT_OFFER_MAX_RESENDS=3;
const SCAN_MAX_STEP_ERRORS=5;
const SCRAP_BUY_URL="https://scrap.tf/buy/hats";
```
60-minute memory TTL: `TTL_MS` in `checked-items.js`. Blacklist: `TRADERS` array in `blacklist.js` (matches Steam64 and the shorter partner id).

---

## 9. Recipes

### 9.1 Add a trader to the blacklist
Edit `blacklist.js` → add one line to `TRADERS` (keep the CRLF endings):
```js
{name:"Label only",steamId:"7656119XXXXXXXXXX"},
```
No other file changes; both `background.js` and `content.js` load it.

### 9.2 Change the minimum profit / freshness window
Change `MIN_PROFIT_REF` or `MAX_LISTING_ACTIVITY_AGE_MS`. Also update the README.md text that says "0.05 ref" and the reverse-scan thresholds if they use the same constant (grep for `MIN_PROFIT_REF` and for `0.05` in popup/README).

### 9.3 Add a new popup → background feature
1. `popup.js`: add a button/handler that calls `send({type:"MY_TYPE", ...})`.
2. `background.js`: add the handler in the main `onMessage` listener (use the async pattern in §3.5, `return true`).
3. If it starts a scan: guard with `scanBusyError()`, set `scanMode`, add a name in `SCAN_MODE_NAMES`, make the popup disable the other buttons via `applyScanMode` / `syncScanMode`.
4. If it must show progress: use `emitTradeAutomationStatus(text)` or `popup({type:"MY_PROGRESS",...})` plus a case in the popup listener.

### 9.4 Add a new content-script action (read or click something on a page)
1. `content.js`: implement the function, then add a branch to the bottom `runtime.onMessage` listener:
```js
if(msg.type==="READ_MY_THING"){
  Promise.resolve(readMyThing(msg.arg))
    .then(sendResponse)
    .catch(error=>sendResponse({ok:false,reason:error?.message||String(error)}));
  return true;
}
```
2. `background.js`: call it with retry for freshly-loaded pages:
```js
const data=await getTabMessageWithRetry(tabId,{type:"READ_MY_THING",arg},15000);
```
or `msgTab(tabId,{...})` for one-shot.
3. Always return structured `{status|ok, reason}` objects; the callers treat missing responses as "page not ready".

### 9.5 Add a new marketplace source (like scrap.tf was added)
1. **Reader** in `content.js`: extend `readBuyPage()` so entries carry `source:"newsite"` plus `name`, `price`, `stock`, `href`. Make sure `isXxx()` host detection mirrors `isScrapTf()`.
2. **Scan queue:** `startItemScan` / `planScanQueue` / `interleaveBySource` — add the new source key; `TF2CheckedItems` stores a `source` per entry (see `normalizeSource` in `checked-items.js`).
3. **Price refresh:** add a `refreshItemFromXxx()` like `refreshItemFromScrap`/`refreshItemFromStn`.
4. **Purchase:** add `openXxxPurchaseBatch(job,batchNumber,remaining,apiKey)` and branch on `job.source` in `executeTradeJob` (the `job.source==="scrap.tf"?…:…` ternaries). The site-created Steam offer must go through `acceptStnPurchaseBatch` (or a clone) so the **state-3 check, craftability check, and Mac confirmation** stay intact.
5. **Seller label:** `sellerLabel` strings in `enqueueTradeJob` / `executeTradeJob`; `enqueueTradeJob` sets `job.source`.
6. **Popup:** source badges, Bought tab counts (`purchaseLog` entries include the site), checkbox next to the scan buttons (`scanSiteChoices`).
7. Update `manifest.json` permissions only if a new host is needed (`<all_urls>` is already granted to the scanner).
8. Docs + version bump (§3.6).

### 9.6 Add a new `tmt_*` parameter that TMT should honour
1. Scanner: `url.searchParams`-style building in `buildBotOfferUrl` / `inspectListingTradeOffer`:
```js
payload.set("tmt_my_option",String(value));   // buildBotOfferUrl
verifyParams.set("tmt_my_option",String(value)); // inspectListingTradeOffer
```
2. TMT `content.js`: read it with the same `URLSearchParams(location.hash.slice(1))` code that reads other `tmt_*` params (search `tmt_craftable` for a model) and use it.
3. Validate numeric/ID values with regexes (see `tmt_exclude_assets` handling: `/^\d{1,20}$/`).
4. Both manifests' versions + changelogs.

### 9.7 Add a saved/remembered data structure
Copy `saved-trades.js` (pure functions taking and returning a map). Add it to the manifest `background.scripts` before `background.js`. In `background.js` load/save through `storageGet`/`storageSet`; in `popup.js` listen to `api.storage.onChanged` (see `tf2ArbTraderHistory` handler) to re-render.

### 9.8 Add a notification / sound
`notifyHit(result)`, `playHitSound()`, `playTradeMilestoneSound(file)`, `playEndSound()`. Audio files live in the scanner folder (`hit.mp3`, `middle1.wav`, `middle2.wav`, `Item_metal_pot_drop.wav`); add the file name to the package and, if the manifest ever lists `web_accessible_resources`, there.

### 9.9 Adjust Mac click coordinates
Edit the tuple constants at the top of `macConfirmer/confirm_trades.py` (`TRADE_OFFER`, `CONFIRM_BUTTON`, `TIMEOUT_RETRY_BUTTON`, `SECOND_RETRY_BUTTON`, `THIRD_RETRY_BUTTON`). They are screen points as printed by `cliclick p`, measured for one screen layout. Don't change them from guesses; the user must re-measure.

---

## 10. Gotchas that cause real bugs

1. **Async `sendResponse` without `return true`** → "message channel closed". See §3.5.
2. **Mixing callback and Promise APIs** (`chrome.*` vs `browser.*`) → promises that never resolve. Use the wrappers.
3. **Unawaited tab operations / orphaned tabs.** Every tab you open must be closed in a `finally` (see `inspectListingTradeOffer`): `closeTabRobust(tab.id); restoreAfterOfferTab(tab.id)`.
4. **Timeouts are deliberately long** (Steam is slow). Don't shrink `STEAM_TRADE_OFFER_TIMEOUT_MS` / `BOT_OFFER_TIMEOUT_MS`.
5. **A purchase is not done until Steam state 3.** Never mark purchased/sold from the page UI alone. `recordPurchase` is called after `acceptStnPurchaseBatch` resolves with the accepted offer id.
6. **Re-selling the same copies.** Each bot offer must use different asset copies (`usedAssetIds` → `tmt_exclude_assets`). Don't drop that when refactoring.
7. **Duplicate in-flight trades.** `inFlightTradeQuantities()` + `tradeListingKey(name,listing)` prevent queuing the same bot demand twice; `verifyProfitableListings` and `enqueueTradeJob` both depend on it.
8. **Craftable vs Non-Craftable.** STN names uncraftable items `Non-Craftable <n>`; others are assumed craftable. Craftability is validated from Steam descriptions (`descriptionIsUncraftable`: line "( Not Usable in Crafting )"), and passed to TMT as `tmt_craftable`.
9. **Unusuals** are skipped on scrap.tf (no effect shown). Backpack.tf lookups use `getBackpackSpec(name)` / `bpUrl(name)` to derive quality, craftability, effect.
10. **The STN page counts as "checked both ways".** `TF2CheckedItems` tracks `forward` and `reverse` separately; a change affecting only one direction must not clear the other.
11. **Closing the browser** triggers `stopScanningBecauseClosed` and `shutDownLocalHelper` (`POST /shutdown`). Don't add long-running timers that survive window close.
12. **iPhone Mirroring needs focus.** The scanner window opening steals focus; `refocusIPhoneMirroring()` calls `/focus`. New code that opens windows should not break this.
13. **`.pyc` files and `__pycache__`** are in the folder tree; ignore them. `*.xpi` and `TF2 Trader.app/` are git-ignored.
14. **Git may show every file as modified** after extracting from an archive because of CRLF/LF normalization. Don't "fix" it by rewriting files.

---

## 11. How to verify a change

**Quick path (Windows or Mac):** `python tests/run_all.py` runs every test in `tests/` plus `tools/check.py` (syntax of all scripts, manifests, version/changelog agreement, mixed line endings). The tests are plain Node/Python scripts with no dependencies. They cover craftability checks, the pointer tolerance of the Mac confirmer, the 60-minute memory, the blacklist, and "source guards" that fail when a safety rule (auto trading off by default, state-3 purchase check, delays, exact bot-title rule) is edited away. If a rule is changed on purpose, change its guard in the same commit. Use `python` (not `python3`) on Windows.

**Editing files that mix CRLF/LF/BOM:** `tools/patch.py` does exact-match replacements and keeps each file's line endings and BOM (`from patch import edit`; each `old` must match exactly once). Prefer it to rewriting files.

The longer manual/static recipe follows.

Static checks — run all of them before reporting a change as done:

```bash
cd tf2Arbitrage
# Syntax of every extension script
for f in tf2_trade_arbitrage_prototype/*.js automaticMetal/*.js; do node --check "$f" || echo "FAIL $f"; done
# Python helpers
python3 -m py_compile macConfirmer/*.py browserShell/launch.py
# Manifests parse (BOM is fine for Firefox; strip it for this check)
node -e 'for (const f of ["tf2_trade_arbitrage_prototype/manifest.json","automaticMetal/manifest.json"]) JSON.parse(require("fs").readFileSync(f,"utf8").replace(/^\uFEFF/,""))'
```

Unit-testing pure helpers with plain Node (they export via `module.exports`):

```js
// node test-checked.js
const C=require("./tf2_trade_arbitrage_prototype/checked-items.js");
const map={};
C.record(map,{name:"Team Captain",price:"1 key",source:"stn",direction:"forward"} /* check record() signature in the file */);
console.log(C.keyFor("Team Captain"), Object.keys(map));
```
(`record`, `skipEntry`, `fresh`, `status`, `prune`, `list` are exported; read the function signature in `checked-items.js` before calling. `saved-trades.js` exports `recordGoodTrade`, `recordCheck`, `syncBought`, `remove`, `list`.)

`background.js` and the content scripts need the WebExtension API and cannot be `require`d. To test their pure functions (e.g. `analyze`, `parsePrice`, `splitListings`), copy the function into a throwaway Node script along with the constants it uses, or extract it to a new UMD helper module (see §3.1) if the user asks for refactoring.

Manual check (needs the user; never run against live trades):
1. Firefox Developer Edition → `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → `automaticMetal/manifest.json`, then `tf2_trade_arbitrage_prototype/manifest.json`.
2. Open STN hats and/or `scrap.tf/buy/hats`, set key rate, leave **auto trading off**, press **Scan Offline**.
3. Watch the browser console of the background page (`about:debugging` → Inspect) and the status line.
4. For the Mac helper: `python3 browserShell/launch.py --server-dry-run`.

---

## 12. Where to look for common tasks

| Task | Start here (grep the function name; line numbers drift) |
| --- | --- |
| Change profit logic / filters on buy orders | `analyze`, `deduplicateListings`, `TraderBlacklist.filterOut` |
| Change how bots are verified | `inspectListingTradeOffer`, `verifyProfitableListings`, `verificationTradeLimit`, TMT `tmt_verify` handling |
| Change how a Backpack.tf page is read | scanner `content.js`: `readStatsBuyOrders`, `readClassifiedsPage`, `readClassifiedsLink`; bg: `openAndReadClassifieds`, `classifiedsUrl` |
| Change STN purchase | `openStnPurchaseBatch`, `chooseStnQuickBuyAmount`, `waitForStnPurchaseOffer`, `acceptStnPurchaseBatch`; content: `quickBuyAmount` |
| Change scrap.tf purchase | `openScrapPurchaseBatch`, `waitForScrapRequestGap`, `cancelScrapQueue`; content: `scrapBuy`, `scrapQueueState` |
| Steam Web API usage | `steamApiRequest`, `fetchSteamReceivedOffers`, `fetchSteamSentOffers`, `fetchSteamTradeOffer(WithDescriptions)`, `waitForSteamOfferAccepted` |
| Bot-offer sending / retry | `sendBotOffer`, `buildBotOfferUrl`, `trackSentBotOffer`, `runBotOfferTracker`, `requestBotOfferResend`, `runPendingResends` |
| Key budgeting | `fetchRawKeyCount`, `keysPerItem`, `planKeyPurchase`, `sellUnsold` |
| Trade queue / job lifecycle | `enqueueTradeJob`, `runTradeQueue`, `executeTradeJob`, `recordPurchase` |
| Scan queue / modes / rescan | `startItemScan`, `planScanQueue`, `startAutoRescan`, `autoRescanWait`, `scanBusyError` |
| Windows & tabs | `ensureAutomationWindow`, `createScanTab`, `createOfferTab`, `openJobTransactionPage`, `closeAllOwnedTabs` |
| Reverse / sell-to-STN checks | `processReverseItem`, `processScrapToStnItem`, `readStnBuyPrice`, `notifyReverseHit` |
| Memory of checked / saved items | `checked-items.js`, `saved-trades.js`, `recordCheckedItem`, `updateSavedTrades`, `syncBoughtIntoSaved` |
| UI rendering | `popup.js` `renderResult`, `renderSaved`, `renderChecked`, `renderTradeAutomation` |
| Metal staging / Steam offer UI | TMT `content.js` (search `tmt-move-item`, `tmt_verify`, `tf2mt-arbitrage-`), `page-bridge.js` |
| Mac confirmations | `macConfirmer/confirm_server.py`, `confirm_trades.py`, bg `requestMacConfirmations` |

---

## 13. Working agreement for agents

- Make the **smallest targeted edit** that solves the task; keep CRLF/BOM and compact style.
- Before editing a function: `grep` its definition (watch for duplicates, §3.4) and its call sites.
- If you change a message type, event name, or `tmt_*` parameter, change **both sides** and update §6 of this file.
- If you change a storage key, add migration/default handling; users have data in `api.storage.local`.
- Run the §11 static checks and report which ones you ran. If you could not test something (everything involving live Steam/STN/scrap.tf/Backpack.tf), say so plainly rather than claiming it works.
- Update the changelog, version, root `README.md`, and this file when behavior or architecture changes.
- Ask the user before doing anything that could send real offers, spend items, or hit the sites faster.

---

## 14. Behaviour decided together with the user (do not "fix" these)

These came out of working sessions with the owner. They look odd in isolation but are deliberate. Everything below was checked with mocks, stubs and syntax checks only, **never against live Steam / STN / scrap.tf / Backpack.tf / the Mac**; say so when reporting.

**What counts as a bot buy order** (`getMatchingListings`, scanner `content.js`)
- The green button's whole `title` must equal: `This listing is managed by a user agent. Click to open a Trade Offer. Please only offer the buyout.` (extra spaces ignored). A title that only *contains* the last sentence does not count.
- `Negotiation is allowed.` in the title rules a listing out. A listing with an "Add this user" button, or a profile link with "friend", is a human and is skipped first.
- Then: blacklist (Steam64 + partner id; names only when there is no id), special-order keywords (parts, paint, spells, level, CC/Spec…), words saying the trader is human, quality/craftability match, paint/spell fields, bump age (`MAX_LISTING_ACTIVITY_AGE_MS`, 10 h).
- Known weak spot: every filter drops silently (`rejectedTerms` is always `[]`), and "no usable Buy Order" is remembered for 60 minutes. An idea the owner has not asked for yet: count what each filter removes and show it on the result card; shorten the memory for "not found" results.

**Stock first.** An STN item's own page is read before Backpack.tf (see §4.3).

**Metal check for traders who want many items** (`verifyProfitableListings` + TMT `inspectTraderMetalInventory`)
- Metal is only checked for as many copies as can be bought (STN/scrap.tf stock), not for everything the trader asks. A trader whose metal covers only some of them counts for that many (`affordableQuantity`); a shortfall is an answer, not an error. The "already holds enough copies" test still uses the full wanted number.
- TMT returns `partial:true` when adding stopped part-way; it only throws when nothing at all could be staged.

**Craftable / Non-Craftable.** STN names uncraftable items `Non-Craftable <name>` (searched on Backpack.tf as craftable `-1`). STN pages say nothing else, so before an STN/scrap.tf purchase offer is accepted its items are read through the Steam Web API (`get_descriptions`) and checked for "( Not Usable in Crafting )" (`verifyPurchaseOfferCraftability`); a mismatch is refused. The bot offer carries `tmt_craftable` so TMT puts a copy of the right kind in the trade. Killstreak and Australium variants are **not** covered (Backpack.tf lookups filter `killstreak_tier=0`, `australium=-1`).

**TMT picking metal / the half-scrap weapon.** Metal is taken from the END of the shown results page (the first items are the busiest and cause "Items Now Unavailable For Trade"). The "normal weapon" for half a scrap skips anything mentioning Killstreak/Killstreaker/Sheen. Known limitation: parallel offers can still collide on the same metal (an idea: reserve metal asset ids across offers through `tmt_exclude_assets`, as named items already do).

**Scan buttons.** There is no Stop button: the running scan's own button says "running… (click to stop)" and stops the scan; the other scan buttons stay disabled. STN items are queued in on-screen order (row by row, left to right; `inVisualOrder` in `content.js`); with both sites ticked the queue alternates STN and scrap.tf; items checked in the last 60 minutes at the same price are skipped.

**Mac confirmer pointer check.** `POINTER_TOLERANCE=60` points and `POINTER_RECHECKS=3` (`confirm_trades.py`, `--pointer-tolerance`): a small nudge of the mouse is fine, the run only stops if the pointer is still far away after 3 re-moves.

**How the owner likes answers.** Summaries list *what was added*, without update/version numbers. Explain in plain language, say what was and was not verified, and do not commit unless asked.
