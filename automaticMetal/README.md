# TF2 Metal Trader v0.9.125

Firefox extension for automating TF2 trades from Backpack.tf/STN through Steam trade offers.

## v0.9.125 — the trader metal check combines refined, reclaimed and scrap

- The price is now covered by all three denominations together. 1.77 ref (16 scrap) is met by 1 refined + 2 reclaimed + 1 scrap; the trader does not need enough of any single kind.
- Pass 1 stages whole items that fit the remaining price, largest first (refined, then reclaimed, then scrap). Pass 2 tops up any gap with the smallest whole item that closes it (reclaimed, then refined), for example when the trader has no scrap.
- Fix: the trader's metal items were matched by their full image URL (CDN host and size included), so a different host or size made metal that Steam's search had found look absent. They are now matched by image path, like the rest of the metal code.
- The console logs how much of the price is staged after each denomination, and when a search listed items that did not match.
- A problem with one denomination (a Steam hiccup, nothing found) no longer ends the check: what was staged is kept and the other denominations are still tried. The check only fails if the combined total is still short.

## v0.9.124 — key prices are paid with physical keys only when the payer has enough

- Before paying a price that includes keys, the add-on searches the paying side's inventory (the trader's for a buy order, yours for a sell order) for `Mann Co. Supply Crate Key` and counts the copies (any keys already placed in the trade count as held).
- If that side holds every key the price needs, it pays the keys and the metal part as before.
- If it holds fewer, no keys are used: the whole price is paid in metal, keys converted at the key rate (for example 2 keys = 120 ref at 60 ref per key, plus any ref in the price). If the keys then turn out not to be there while adding them, the keys already added are removed and the metal price is used.
- The key rate comes from the arbitrage scanner (`tmt_key_rate` in the offer link) and is remembered, so later manual trades can use the last known rate. With no known rate and too few keys the trade stops with a clear message instead of guessing.
- Prices without keys are not affected and do no key check.

## v0.9.123 — incoming offers are accepted only after their items have loaded

- Steam renders an incoming offer's items after the rest of the page and, when they finish loading, resets the trade confirmation that was already made. The add-on used to confirm and accept before that, so the acceptance was wiped.
- Now nothing is clicked until the offer's items are on screen, their images have loaded and the list has stopped changing for 1.5 seconds. If images never load (or no items are recognized), it proceeds after 12 seconds instead of waiting forever.
- After confirming the contents it waits a moment, and if Steam drops the confirmation (the "Confirm Trade Contents" control comes back) it confirms again (up to 5 times) before clicking Accept. A reset after an Accept click that Steam never received is handled the same way.
- New progress phases: `waiting-for-items` and `contents-reset`.

## v0.9.122 — an explicit listing intent is no longer overridden by the description

- `resolveListingIntent` now trusts the intent passed with the listing (from Backpack.tf's own marker or from the arbitrage scanner) before the free-text description. The description ("I'm buying…", "I am selling…") is only used when no intent was given.

## v0.9.121 — bad-trader limit includes the stock in the description

- The `tmt_wanted` value now means the number of copies at which a trader counts as bad: the copies the description already counts as stock plus the copies it wants (for example "Stock: 4/5" and 1 wanted gives 5). The status text says "bad trader at N".

## v0.9.120 — Quality and Cosmetic filters when searching for the item

- When the offer page searches an inventory for the listed item (your inventory for a buy order, theirs for a sell order), it first applies Steam's advanced filters: Quality (Unique by default) plus Type: Cosmetic for hats, then searches the name. Keys, tickets, crates and similar skip the Cosmetic filter.
- The arbitrage add-on passes the item's real quality and whether it is a cosmetic (`tmt_quality`, `tmt_cosmetic` in the offer link). Without them the add-on assumes Unique and decides "cosmetic" from the item name.
- If the filtered search finds nothing, the search is repeated once without the advanced filters, so an item in another category is still found. If Steam does not offer a filter, the search continues without it.

## v0.9.119 — reports the id of each sent offer

- When an arbitrage bot offer is sent, the offer id from Steam's send response is passed to the arbitrage add-on (`tradeOfferId` in `tf2mt-arbitrage-listing-sent`). The add-on uses it to watch the offer and send it again if Steam cancels it with "Items Now Unavailable For Trade".

## v0.9.118 — real "accepted" check for incoming offers and a bad-trader pre-check

- Accepting an incoming offer (for example the Steam offer opened from STN) is now confirmed only from Steam's own response to `POST /tradeoffer/<id>/accept`. Words such as "accepted" in the page text no longer count unless the Accept button is gone and at least 4 seconds have passed since the click.
- The Accept button is only clicked once the offer's "Ready to Accept" step is done. A click that Steam ignores is retried, and a refused request (for example error 28) is retried up to 4 times before a clear failure that includes Steam's message.
- Bad-trader pre-check (runs before the metal check when the arbitrage add-on asks for it through `tmt_item`, `tmt_wanted`, `tmt_quality`, `tmt_cosmetic` in the offer link): their inventory is filtered to Quality: Unique (plus Type: Cosmetic for hats), searched for the item name, and every result that matches the name exactly is counted (up to 8 result pages). If the count reaches the amount the trader wants (the stock in their description, 1 if none), the trader is reported as bad (`badTrader`) and the metal check is skipped. Otherwise the trader is good and the metal check continues as before.
- If counting fails for any reason the trader is not rejected; the metal check still runs.

## v0.9.117 — every offer uses different copies of the item

- Arbitrage bot offers pass the asset ids already used by earlier offers in the same run (`tmt_exclude_assets` in the offer link). The offer page skips those copies when it picks an item, so several pending offers never contain the same item and you can accept them all.
- Copies inside one offer are also distinct (each is reserved as soon as it is added). If every visible copy is reserved, the next result page is checked; if none is left, the offer stops with "No unused <item> is left…" instead of reusing a reserved item.
- When the offer is sent, the exact asset ids in it are reported back (`tf2mt-arbitrage-listing-sent`). A copy removed because the trader could only pay for fewer items is not reported, so a later offer can use it.

## v0.9.116 — Fish Cake is never used as the half-scrap weapon

- The Primary/Secondary half-scrap weapon picker now skips any item named "Fish Cake" (also "Fishcake") in addition to the existing blocked image list, which already contains the Fish Cake image. The name is read from Steam's own item data for the inventory element (`rgItem` / the user's `rgInventory`) and from the image `alt`/`title`, so it works even if Steam serves a different image for the item.
- If the only eligible secondaries are Fish Cakes, no weapon is found and the existing Scrap-only change fallback runs.

## v0.9.115 — faster accept, Steam send errors refresh the page, metal already in the trade

- Removed the pause between the last payment item and accepting the trade. The payment no longer restores Steam's inventory search box or switches back to the payment inventory afterwards; both were cosmetic and could take several seconds.
- Steam's own "send trade offer" request is now observed, so the add-on knows whether the offer was really sent. A Steam error such as `Make Offer – There was an error sending your trade offer. Please try again later. (26)` (shown in Steam's `newmodal` dialog), or any other failure while accepting or confirming, refreshes the trade page and rebuilds the trade. It retries up to 3 times with a short back-off, then reports the Steam error.
- The offer is reported as sent only when Steam returns its offer id. The old 1-second "button went away" guess could miss errors that arrive a moment later. If no request is seen, the add-on falls back to the page after about 4 seconds.
- After a refresh retry, any draft Steam restored on both sides is cleared before the trade is rebuilt, so items are not duplicated.
- The metal already in the trade is re-read before each lower-value fallback step (Reclaimed, Scrap, change), so metal that is already placed can complete the payment without searching again. A payment already covered by the trade skips the shortfall search entirely, and a Steam metal-availability check counts the total staged metal the same way.

## v0.9.114 — reliable item adds and staged-metal reuse

- Item and key adds are retried (up to three attempts, with a fresh inventory-side selection) instead of aborting on the first transient Steam error. If Steam placed the item despite reporting an error, it is counted rather than duplicated.
- The trade now waits for Steam's trade slots to load instead of failing immediately, and a listing whose quantity parses as 0 still attempts one item.
- Payment and change logic count metal already in the trade and search only for the missing value. Excess staged metal is trimmed locally instead of being rebuilt.
- When a grouped BUY order is reduced because the trader is short on metal, the metal and keys already staged are kept and reused for the smaller quantity, so no new inventory searches are needed.

## v0.9.113 — reduce grouped buy orders to available metal

- If the trader cannot pay for every item in a grouped Backpack.tf BUY order, remove one offered item at a time, recalculate the total, and retry. Any keys staged for the failed quantity are removed before retrying.
- Stop without submitting if the trader cannot pay for even one item; unrelated Steam or inventory errors still fail immediately.

## v0.9.112 — scrap-only half-scrap fallback and faster acceptance

- When no half-scrap weapon is available, retry only Scrap to reach the next whole-scrap amount; do not substitute Refined or Reclaimed.
- Start incoming-offer acceptance as soon as the Steam page bridge is ready. The bridge itself waits for Steam's controls, so the fixed 2.5-second pause is removed.

## v0.9.111 — partial metal search completion

- If Steam cannot settle a later search for the current denomination after some metal has already been added, keep the confirmed amount and continue with lower denominations instead of aborting the whole payment.
- Retry an unsettled denomination once when nothing was found; after the bounded retry, allow the payment fallback to try Reclaimed and Scrap.

## v0.9.110 — denomination fallthrough

- If a requested Refined amount is short, continue with Reclaimed and then Scrap to fill the remaining value without repeating the exhausted denomination.

## v0.9.109 — no-weapon scrap fallback and faster submission handoff

- Clear stale per-side Advanced Filters before searching for metal, allowing the no-weapon fallback to find the extra Scrap after Primary/Secondary weapon searches.
- Automated Backpack.tf offers report progress while waiting for Make Offer and stop waiting after 20 seconds; manual flows keep their longer wait.
- A disabled Make Offer button after clicking is recognized as Steam processing the submission, after the normal handoff delay.

## v0.9.108 — clear advanced filters before metal and faster offer handoff

- Metal and item searches clear stale Steam Advanced Filters on the selected inventory first, so a leftover Primary/Secondary filter cannot hide the Scrap needed by a no-weapon fallback.
- The Make Offer wait now reports progress and is bounded to 20 seconds for automated Backpack.tf listings (manual flows retain the longer wait).
- Steam's disabled Make Offer control is treated as an accepted submission handoff after the normal minimum wait.

## v0.9.107 — carry partial denominations into metal fallback

- If a payment cannot be made entirely with the requested denomination, retain the metal already staged and fill the remaining scrap value with Refined, Reclaimed, and Scrap.
- For example, 2 Refined plus 3 Reclaimed now directly completes a 3 Refined payment.
- Half-scrap weapon fallback removes only a weapon added during the failed attempt, preserving staged payment metal.

## v0.9.106 — recoverable inventory searches and item lookup

- If Steam switches inventory sides during a metal or item search, the addon reselects the requested side and reapplies the search, with a bounded retry count.
- Primary/Secondary weapon filters wait for the filtered inventory to settle and retry once after a transient side change instead of treating it as an empty weapon category.
- Exact item searches are scoped to the intended inventory, wait for filtered results to settle, retry once when no item appears, and prefer the listing's asset ID when available.

## v0.9.36 — Native Steam search only

Item selection now uses Steam's native **Search Within Listings** as the sole inventory-finding mechanism.

For a requested item:
1. Select the correct Steam inventory side.
2. Search for the item name using Steam's native inventory search.
3. Wait for Steam to apply the search.
4. Take the first visible inventory result.
5. Move that exact result into the trade and verify it was added.

The addon no longer performs manual inventory-page walking, metadata/name sifting, image matching, advanced weapon filters, duplicate-copy reservations, or secondary inventory fallback searches. If the native search produces no usable result, the trade algorithm stops with an error instead of trying another inventory-finding method.

Keys therefore simply use:
`Mann Co. Supply Crate Key` → native Steam search → first result.

Tour of Duty Tickets now follow the same native-search-first-result rule.

Half-scrap weapon payment uses only Steam native name searches over the existing ordinary-weapon name list and takes the first result from the first successful search.

Metal payment also uses Steam native searches for Refined Metal, Reclaimed Metal, and Scrap Metal and only uses the currently displayed filtered results; it never walks additional inventory pages.

## Trade tab closing

- Outgoing trades close after Steam confirms the offer was sent (it returns an offer id), without waiting for mobile confirmation.
- Incoming offers at `/tradeoffer/<id>/` are automatically accepted; tagged arbitrage purchases wait for Steam's positive acceptance confirmation before reporting completion.
- `/tradeoffer/new/` is never treated as an incoming offer.

## v0.9.89 — confirmed purchase handoff

- Tagged STN purchase offers report completion only after Steam shows a positive accepted-offer confirmation.
- If Steam does not confirm acceptance, the arbitrage workflow receives an error and does not proceed to bot offers.
- Tagged one-item Backpack.tf offers continue to report only after Steam's submission flow begins.


## v0.9.36
Restored the Advanced Filter bridge helper required exclusively by the half-scrap random weapon path. Native Steam inventory search remains the only item-finding method for normal items.


### v0.9.43 changes
- Half-scrap weapon selection uses the first rendered `.itemHolder` asset produced by Steam Advanced Filters, skipping the specifically excluded weapon image.
- Stock quantity parsing checks every numeric slash/backslash fraction, avoiding unrelated text such as `24/7`.
- Supports `up to N` quantity wording.


## v0.9.43
Weapon Advanced Filter flow now explicitly clears Steam's native inventory search input before applying the weapon filters, preventing a previous item search from narrowing the filtered weapon pool.


## v0.9.44
- Restored the missing `findNormalWeaponOnCurrentPage` content-side bridge helper used by the Advanced Filter weapon search.


## v0.9.45
- Added two additional excluded TF2 weapon image URLs to the half-scrap weapon safety check.
- Weapon selection now tries Unique + Not Marketable Primary Weapon first, then Secondary Weapon, then Melee Weapon as a final fallback.
- Each category still uses the first rendered `.itemHolder` candidate that does not match any excluded weapon image.


## v0.9.46
- Added explicit quantity parsing for buy-order text such as `I CAN BUY 2`, so the addon adds exactly 2 item copies.
- Reworked Advanced Weapon Filter switching so Steam clears the previous weapon type before selecting the requested type and verifies that only the requested Primary, Secondary, or Melee filter remains active.
- Scrap Metal selection now requires the exact known Scrap Metal image URL on the rendered inventory item; a native `Scrap Metal` search result with a different image is ignored.


## v0.9.47
- Automatically handles TF2 metal change when the exact denomination breakdown is unavailable.
- If the payment side can only overpay (for example 6 ref for a 5.66 ref item), the addon adds the required change from the opposite inventory.
- Uses Refined/Reclaimed/Scrap values of 9/3/1 scrap and falls through to smaller denominations when an exact change denomination is unavailable.


## v0.9.48 — deterministic change rebuild + weapon fallback

- If an exact metal denomination plan cannot be completed, all partially added payment metal is removed before rebuilding the payment from available denominations.
- The rebuilt payment can overpay and automatically adds the exact difference from the opposite side.
- Primary, Secondary, and Melee weapon filter failures/timeouts now fall through to the next category instead of aborting the half-scrap weapon search.


## v0.9.50 — clear entire trade side before change rebuild
- Fixed change rebuilding so it uses Steam's native `MoveItemToInventory(item)` function to remove items from a trade side.
- The change rebuild now snapshots and removes every item from the selected side, then verifies the entire side is empty before rebuilding.
- It no longer attempts to remove a trade item by calling `MoveItemToTrade`, which was the source of the previous asset-removal error.


## v0.9.72
- Inventory switching now has bounded waits and stops treating a failed switch as an empty weapon category.
- If no eligible normal weapon exists on the change side, half-scrap change falls back to 1 full scrap from that side plus a normal weapon from your inventory.
- The v0.9.71 inventory-side recovery and settling delays are preserved.

- v0.9.78: restored the exact three blocked weapon image identifiers from the known-good v0.9.65 implementation while retaining the candidate-skip logic.


## v0.9.83 changes
- Reclaimed Metal is now verified against the exact Steam economy image before it can be moved into the trade.
- Metal payment fallback now reasons in scrap value, so combinations such as 3 reclaimed + 5 scrap (14 scrap total) correctly satisfy a 1.55 ref price (13.5 scrap), with the normal half-scrap change handling.


## v0.9.86 changes
- Buy/sell direction now uses explicit listing-description wording when present, falls back to the listing's intent metadata, and stops safely if neither identifies the direction.
- Repeated-decimal unit prices use upward whole-scrap rounding for the multiplied metal total instead of adding a normal weapon.
- Inventory-side readiness no longer depends on a hard-coded Steam account ID; change handling restores and verifies the original payment side before continuing.
- Half-scrap weapon searches now check Unique + Not Marketable Primary, Secondary, then Melee weapons, skipping the excluded weapon images in every category.

## v0.9.87 changes
- Metal and normal-weapon searches now verify that the requested Steam inventory side is active before filtering, reading candidates, and moving items.
- Steam's page-world bridge rejects item moves when the candidate is not inside the active inventory for the requested side.
- Weapon fallback paths explicitly reselect and validate Your inventory before adding a normal weapon.

## v0.9.88 changes
- Earlier arbitrage verification searched inventory read-only. Current metal availability checks temporarily stage the required metal and remove it without submitting the offer.

## v0.9.90 changes
- The former read-only check searched only the metal denominations needed to cover the requested price and stopped once sufficient value was found. The v0.9.91 metal availability test supersedes this by exercising Steam's add/remove flow directly.

## v0.9.91 changes
- Arbitrage verification tests the real metal-add path by temporarily staging the required metal on the trader side, then removes those exact temporary trade items.
- Verification excludes keys and normal weapons, refuses to touch a trade side that already has items, and reports whether the required metal could be added.
- Steam side readiness prefers the selected trader's account-specific inventory container when Steam's active-side CSS class is stale.

## v0.9.92 changes
- Trader inventory switching waits long enough for Steam's native selection and tab-recovery attempts to finish before starting another recovery.
- Inventory readiness polls for the selected TF2 page instead of failing after a single 500 ms check while Steam is still rendering it.

## v0.9.93 changes
- Waits for Steam's trade controls and the trader's account identity to initialize before attempting to switch inventories.
- Extends the selection watchdog to cover Steam initialization plus the complete native and tab-recovery sequence.

## v0.9.94 changes
- Recognizes incoming STN purchase offers marked with an arbitrage job ID and lets the existing automatic accept flow process them.

## v0.9.95 changes
- Runs the incoming-offer acceptance flow for STN offers carrying only the `tmt_arb_job` marker.
- Clicks Steam's visible accept button without requiring a separate ready toggle, and skips inventory prewarming on incoming offers to avoid racing acceptance.

## v0.9.96 changes
- Waits up to 45 seconds for Steam's selected TF2 inventory page and for the trader's item list to settle before searching for metal.
- Requires a stable trader item list before searching; gives a possibly empty inventory longer to finish loading.
- Waits for exact metal-filter results or a settled empty result instead of trusting stale pagination controls.
- Keeps the metal-verification status visible while the offer page, trader inventory, and metal search are loading.

## v0.9.97 changes
- Uses the trader's selected inventory page when waiting for metal-filter results.
- Requires exact denomination matches or a settled empty-filter state before counting a metal type, so incomplete Steam searches do not get reported as insufficient.

## v0.9.98 changes
- Accepts automated STN purchase offers through the same no-fragment flow as ordinary incoming offers.
- Reports acceptance to the arbitrage controller by trade-tab identity instead of adding a job marker to Steam's URL.

## v0.9.99 changes
- Waits for Steam to finish the incoming offer's confirmation, including Steam Mobile, before reporting the purchase accepted.
- Keeps the trade tab and queued workflow open while mobile confirmation is pending, with progress shown in the Metal Trader panel.

## v0.9.100 changes
- Uses the full Steam Mobile confirmation wait for STN purchases without adding a marker to the Steam offer URL.
- Leaves the queued arbitrage workflow paused until the offer page reports acceptance after mobile confirmation.

## v0.9.101 changes
- Removes fixed 15–20 second inventory settling delays; the checker now proceeds as soon as exact metal results arrive.
- Confirms an empty metal denomination only after Steam displays a settled empty-filter result, and reports a search timeout as unverified rather than insufficient.

## v0.9.102 changes
- Reports each incoming-offer stage with the exact Steam offer ID and visible status evidence.
- Waits for Steam's accepted state to remain stable and for any mobile-confirmation-pending message to clear before marking acceptance confirmed.

## v0.9.103 changes
- A single 1.50-ref price stays at 13.5 scrap and uses the half-scrap weapon path; clean-price rounding up is limited to multi-item payments.
- Half-scrap overpayment no longer adds a second weapon after making change. If the change-side weapon is unavailable, the fallback adjusts both sides and uses a payment-side inventory weapon.
- Failed metal/change construction removes only items added during that payment attempt, preserving the item and key assets already in the offer.
- A 2-ref payment for a 1.50-ref item returns 1 reclaimed + 1 scrap plus a half-scrap weapon when available; if not, it returns 1 reclaimed + 2 scrap and adds a normal weapon on the paying side.
