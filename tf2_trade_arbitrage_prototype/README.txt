TF2 Trade Arbitrage Prototype - Firefox MV2
Current version 0.7.121

Workflow:
- Reads all TF2 marketplace items from the current page.
- Reads the Backpack.tf stats Buy Orders page and then combines those results with the matching Classifieds pages.
- Closes the stats page before opening Classifieds to avoid overlapping scanner tabs.
- Classifieds uses the full generic filter set: tradable=1, craftable=1, australium=-1, killstreak_tier=0, spell=None, offers=1, paint=None. Buy Orders are sorted from the highest price down, so it keeps paging only while every price on the page is still profitable and stops at the first page that reaches a price below buy price + 0.05 ref.
- Initial, paginated, and reopened Classifieds links consistently retain `offers=1&paint=None`.
- Keeps the conservative specialized Buy Order filters, quality/craftability matching, dismissal, persistence, and hit notifications.
- Uses TF2 Metal Trader to temporarily test adding the required metal to each price-profitable offer, then removes the test items without submitting.
- Runs slowly and conservatively to reduce Backpack.tf rate-limit problems.
- Optional automatic execution buys the distinct-copy count on STN, waits for Steam to confirm the purchase, then submits one separate offer to each qualifying bot.
- Trade jobs are serialized independently from scanning and run in the original Firefox window; automatic execution is opt-in.

V0.7.121 changes:
- Gray-out fix: an item that was checked while it was the highlighted "currently checking" item could leave its gray veil spreading over the whole page once the highlight moved on, graying every item except the one being checked. The veil is now always anchored to its own item.
- The hit sound (hit.mp3, "you got a Good Trade") no longer plays for a report-only "Sell to STN" hit. Those still show a notification and the Sell to STN tab.
- Check saved items: a saved item that is checked again and is no longer a Good Trade (its price rose, or Backpack.tf has no buyer) is removed from the saved list automatically. Checks that failed to load keep the item.
- The Remove button in the saved list no longer stretches across the row.

V0.7.120 changes:
- scrap.tf purchases are paced: the next scrap.tf trade is only requested after the previous scrap.tf offer was accepted (Steam Web API state 3), and then only after a 6-9 second pause. This applies to the batches of one item and between two different items.

V0.7.119 changes:
- "Scan STN + scrap.tf pages" now checks every STN hat in both directions: buy on STN and sell on Backpack.tf (as before), and buy on Backpack.tf and sell to STN (the reverse scan). scrap.tf hats keep their one direction. New buttons "Scan STN only" and "Scan scrap.tf only" run the same scan on a single site.
- The 60-minute checked table now remembers each direction separately (old rows count as forward checks). On the STN and scrap.tf pages an item checked in every direction is grayed out fully; an STN hat checked only one way is grayed out slightly and labelled "Half checked". The Checked tab lists both directions. The stand-alone "Scan STN buy prices" scan now uses and fills the same table.

V0.7.118 changes:
- scrap.tf buying now finds the hat with the page's own "Search for items" box (input.inventory-search): the name is typed in, the list filters, and the visible copies are the ones selected. The box is cleared if the hat is no longer listed.

V0.7.117 changes:
- New reverse scan, "Scan STN buy prices (buy on Backpack.tf, sell to STN)". It reads the stntrading.eu hats page open in the window, then for every hat opens its STN item page and reads the "Sell it for" box (what STN pays, and "We can buy N more"). Hats STN will not buy more of are skipped without touching Backpack.tf. For the rest it opens the Backpack.tf stats page, reads the sell listings (cheapest first, flagged bot / trader) and reports the hat when the cheapest bot listing costs at least 0.05 ref less than STN pays. A cheaper non-bot seller is mentioned but never counted as the deal.
- Hits show in a new "Sell to STN" tab (and the hit counter), with a notification and the hit sound; the cards list the cheapest sell listings with their offer links. Nothing is bought automatically on this side, and these results are not written to the 60-minute checked table.
- Backpack.tf reader: the listing reader can now read sell listings too (intent "sell"); Buy Order reading is unchanged.

V0.7.116 changes:
- Hats the bot bought are part of the saved list ("Check saved items"): every purchase saves the item (again, if it had been removed) with a green "Bought xN" badge, the site it was bought on and its price, and Check saved items re-checks it on that site (STN page or scrap.tf Buy Hats page) and Backpack.tf. Purchases made before this version are added once, the first time the add-on starts.

V0.7.115 changes:
- Checked items are grayed out on the stntrading.eu and scrap.tf listings themselves: a gray veil over the item and a small "Checked - next in M:SS" countdown on top of it, for as long as the item is inside its 60 minutes at the price it was checked at. The marks appear as soon as the check is stored, follow the page when it re-renders, and disappear when the timer runs out or the price changes. The items stay clickable.

V0.7.114 changes:
- New "already checked" table (storage key checkedItems, next to savedTrades). Every conclusive check stores the item, the price it was checked at, the site (STN or scrap.tf) and a 60-minute timer. Failed checks (Backpack.tf did not load, a price could not be read) are not stored, so they are tried again.
- A normal scan skips every item that is still inside its 60 minutes and whose price on that site has not changed. A changed price or the other site's listing is checked again. "Check saved items" and the card's "Retry this item" button always check.
- Skipped items still appear in the results with an "Already checked" badge, the age of the check and the minutes left, and they count towards the scan's progress. A new "Checked" tab lists the whole table with a countdown per item and a button to forget it.
- Good Trades found on scrap.tf are now saved like STN ones (with the site and its page), shown with a source badge in the saved list, and "Check saved items" re-reads their price on the scrap.tf Buy Hats page instead of STN. They follow the same 60-minute rule.
- The sidebar's trade queue summary (ACTIVE ITEM / WORKFLOW / ...) named STN for every purchase. It now shows "BUYING FROM: scrap.tf" or "STN" and uses that site in its labels (items accepted, Steam offer, purchase step) and in the status/timeout messages.

V0.7.113 changes:
- scrap.tf purchases use the same accept / Mac-confirm / sound steps as STN purchases: the Steam offer scrap.tf creates is accepted by TF2 Metal Trader, the Mac confirmer is asked to approve the mobile confirmation, middle1.wav plays when the accept goes through and more of the purchase is still to come, middle2.wav when it was the last (and again after the last Backpack.tf offer is sent), hit.mp3 announces the deal and the end sound closes the scan.
- The Mac is now asked as soon as the offer page reports it is waiting for the mobile confirmation (either its "accepted, needs confirmation" report or the earlier "mobile confirmation pending" step), instead of only when the final report arrives or the Steam Web API shows state 9. Both STN and scrap.tf purchases benefit.
- The status line says which purchase the Mac was asked about ("the scrap.tf purchase" / "the STN purchase").

V0.7.112 changes:
- The STN and scrap.tf items of one scan are now checked alternately (STN, scrap.tf, STN, scrap.tf, ...) instead of all of one site first. The Backpack.tf checks still run one item at a time (the scanner window is shared and Backpack.tf rate-limits), so this interleaves the two sites rather than running two checks at the exact same moment.
- scrap.tf pages: the launcher opens https://scrap.tf/buy/hats, and scrap.tf purchases always go through that page.

V0.7.111 changes:
- STN and scrap.tf are scanned together. "Scan STN + scrap.tf pages" reads every stntrading.eu and scrap.tf page open in the window (the active tab first), not only the active tab. An item listed on both is checked once, at the cheaper price, and each result card shows which site it is from (STN / scrap.tf badge). The scan status says how many items came from each site.
- New "Bought" tab: every accepted purchase is logged (browser storage, key purchaseLog, last 1000) with the site it came from. The tab shows the total number of hats bought, the split between STN and scrap.tf (hats and trades), a by-item breakdown and the latest purchases with their Steam offer numbers. "Clear bought history" resets it.
- The page highlight for the item being checked now goes to the tab of the site the item came from.

V0.7.110 changes:
- scrap.tf purchases. With "Automatically buy items and send bot offers" on, a Good Trade found on scrap.tf is bought there instead of on STN: the scrap.tf tab is opened, the item is clicked once per copy wanted, the cart button (#trade-btn, ScrapTF.Hats.BuyWithMetal) is pressed and the add-on waits for scrap.tf's "Your trade is ready!" panel. The Steam offer it names (ScrapTF.NewQueue.TradeOfferID, what "Open Trade Offer" would open) is then opened in the scanner window and accepted by TF2 Metal Trader, the Steam Web API must report it Accepted (state 3), the Mac confirmer handles the mobile confirmation, and only then are the bot offers sent to the Backpack.tf buyers, exactly as for STN.
- scrap.tf sometimes only lets part of a quantity be bought at once (one bot must hold every copy). The add-on buys what scrap.tf allows, finishes that trade, reloads the page and repeats until the full quantity is bought.
- Safety checks before pressing the cart button: the scrap.tf price must not be higher than when it was scanned, nothing else may be selected, and the selected item must be the exact item. If scrap.tf then shows an error, or never prepares the trade, the queue entry is cancelled and no bot offers are sent.
- macOS: the browser launcher (browserShell/launch.py) opens scrap.tf next to STN, and the login cookies of scrap.tf are kept across restarts like the other sites. The extension itself is identical on Windows and macOS.

V0.7.109 changes:
- Buy Orders for a special version of an item are ignored. A listing is skipped when Backpack.tf marks it "Parts Attached" (the small badge next to the title, or the part data on the item), or shows spells or paint. Before, a bot paying for a hat with strange parts could be mistaken for a plain buyer. This applies to every scan (STN and scrap.tf).

V0.7.108 changes:
- scrap.tf support: open https://scrap.tf/buy/hats (signed in) and press "Scan current page". The hats scrap.tf sells are read from the page (name, price in keys/ref, how many are for sale) and checked against Backpack.tf Buy Orders exactly like STN items, including the Steam offer check. A Good Trade shows the normal notification, titled "SCRAP.TF ARBITRAGE HIT", and the result links back to the scrap.tf page.
- The Craft Hats section is skipped by default (hundreds of 1.77 ref hats); untick the new popup checkbox to include it. Unusual hats are skipped because scrap.tf does not name their effect. Genuine/Vintage/Haunted/Collector's hats get their quality added to the name.
- scrap.tf finds are only reported for now: they are not bought automatically and are not added to the saved Good Trades list.

V0.7.107 changes:
- Every item found to be a Good Trade is saved to a local database (browser storage, key savedTrades; nothing is sent anywhere): name, buy and sell price, profit, when it was last good.
- New "Check saved items" button and a "Saved Good Trades" list (with Remove buttons) in the popup/sidebar. The button opens each saved item's STN page (https://stntrading.eu/item/tf2/<name>) to read the current price and stock, then runs the normal Backpack.tf check and metal verification. Items STN no longer stocks are skipped; the list shows whether each item is still a Good Trade.
- Results from a saved check go through the same path as a normal scan, so with automatic trading on, a Good Trade is bought and offered as usual.

V0.7.106 changes:
- The Mac confirmer is now also asked to confirm the STN purchase offer. Before, it was only asked for sent bot offers, so accepting the STN offer waited for a manual phone confirmation. It is asked as soon as the offer page says Steam needs the confirmation, or when the Web API reports state 9.
- A failed click run on the Mac (for example cliclick missing or no permission) is now reported in the status line instead of leaving the offer silently waiting.
- The scanner window no longer shows the sidebar in the TF2 Trader browser (browserShell/profile/chrome/userChrome.css).

V0.7.105 changes:
- The Mac confirmer needs no manual setup when the browser is started by browserShell/launch.py. The launcher creates the confirm server's token, packs it with the local address into the add-on (mac-confirmer.json), and mac-confirmer-seed.js fills in the Mac confirmer settings from it on start-up (enabled by default; later changes to the checkbox are kept). Only http://127.0.0.1 / localhost addresses are accepted this way. The launcher also checks that the server came up, warns if cliclick is missing, and opens iPhone Mirroring.

V0.7.104 changes:
- Logins and settings survive browser restarts. cookie-keeper.js (new, needs the cookies permission) turns the session cookies of steamcommunity.com, steampowered.com, stntrading.eu and backpack.tf into 30-day cookies, because Firefox drops session cookies on quit. Logging out on a site is not undone. A checkbox in the popup/sidebar switches it off. The Steam Web API key and other add-on settings were already stored persistently in the profile. browserShell/profile/user.js now also states that nothing is cleared on exit.

V0.7.103 changes:
- The analyzer can live in Firefox's sidebar (sidebar_action, same page as the popup opened as popup.html?mode=sidebar) so it stays visible while browsing. It has its own add-on ID (tf2-arbitrage@example.local) so it can be preinstalled by browserShell/launch.py, which also starts the Mac confirm server and opens the STN hats page. Shortcut: Alt+Shift+T toggles the sidebar. Because the add-on ID is new, settings saved by an earlier install (Steam Web API key, key rate, Mac confirmer) must be entered again.
- Sent bot offers waiting for Steam Mobile confirmation (state 9) can be accepted automatically by the Mac confirmer (macConfirmer/confirm_server.py), configured in the popup/sidebar.
- The STN purchase wait now ends when the offer page reports Steam's accept request succeeded (no mobile confirmation needed) instead of waiting for the Web API; the Web API poll runs every 2 seconds as a fallback.

V0.7.102 changes:
- Bot offer links now include the key rate set in the popup (tmt_key_rate). TF2 Metal Trader 0.9.124 uses it for key prices: if the trader (buy order) or you (sell order) hold enough physical Mann Co. Supply Crate Keys the keys are traded as before, otherwise the whole price is paid in metal at that key rate. The metal-availability check that runs while scanning is unchanged (it already measures the price in metal).

V0.7.101 changes:
- Human traders are ignored. The description check now rejects listings that talk about being a person rather than a bot: any mention of "human"/"humans", "real/actual/live person|trader|player", "not a bot"/"I'm not a bot", "no bots", and "manual trader/trading/offers". A description that says it is NOT human ("not a human", "no humans") is left alone. Rejected listings show the reason "human trader".
- The default volume is now 40% (it was 75%): slider, popup and background. The saved volume is reset to 40% once on the first start of this version (you can raise it again with the slider afterwards).

V0.7.100 changes:
- While checking an item, trades you already have for it are taken into account. For every trader, the copies already in offers to that same trader (queued, being sent, cancelled and waiting to be re-sent, or sent and still waiting for Steam to accept) are subtracted from what that trader wants. If that covers or exceeds the amount they want, the listing is shown as "Already trading", its Steam offer is not opened again, and it does not make the item a Good Trade. If only part is covered (for example 2 of 5), only the remaining 3 are checked and traded. Other traders for the same item, and the same trader for other items, are not affected. Once Steam reports an offer Accepted it stops counting. Price checking of every item is unchanged; the popup shows an "already trading" counter and label.

V0.7.99 changes:
- The STN sounds now play when the accept goes through, not later. middle1.wav (more STN trades coming) or middle2.wav (that was the last STN trade) plays as soon as the Steam offer page proves the accept succeeded, i.e. when you can confirm it, instead of waiting for the Steam Web API (which lagged until about when Backpack.tf opened). If the page never reports it (for example you accepted it by hand) the sound plays when the Web API confirms. Nothing plays if the accept fails. The Backpack.tf end sound is unchanged.
- The volume slider now affects middle1.wav and middle2.wav: they read the saved slider value every time they play, and the background script also loads it at startup (before, it stayed at 75% until the popup was opened).

V0.7.98 changes:
- Fewer Steam offer checks per item. Offers are still checked from the highest price down, but checking stops once enough of them are verified to have the metal: STN stock plus one spare (stock 1 -> 2 verified trades, stock 2 -> 3, and so on). Traders that are insufficient, bad or unverified do not count toward that number, so checking continues until enough good ones are found or the offers run out. If the STN stock is not known, every offer is still checked. The popup notes how many lower-priced offers were not checked.

V0.7.97 changes:
- Fixes Steam purchase offers (from STN) whose acceptance got wiped: Steam loads the offer's items after the page and resets the confirmation, so the click was lost. TF2 Metal Trader 0.9.123 now waits for the items to load and settle before confirming and accepting, and confirms again if Steam resets it. The popup's offer progress also shows the new "waiting for items" and "confirmation reset" steps.

V0.7.96 changes:
- The listing freshness limit is now 10 hours (was 24): a buy listing is ignored when its last bump (or listing time) is more than 10 hours old.

V0.7.95 changes:
- Sounds reworked around "when do I accept offers". hit.mp3 is unchanged (a deal was found and the offers are being sent). middle1.wav plays after each STN trade only when more STN bot trades are still coming. middle2.wav plays when the offers are finished: after the last STN trade, and again after the last Backpack.tf offer has been sent. A purchase from a single STN bot therefore plays middle2.wav only. Jobs that skip STN play only the Backpack.tf middle2.wav, and re-sent offers are silent. This replaces the earlier middle1/middle2/middle2.5/middle3 .mp3 sounds.

V0.7.94 changes:
- Sell orders are no longer mistaken for Buy Orders. The scanner used to let the trader's description decide first, so a sell order whose text said "I'm buying ..." was read as a buy order. Backpack.tf's own listing marker (data-listing_intent: buy or sell) now decides, and the description is only a fallback when the page gives no marker. The same fix is in TF2 Metal Trader 0.9.122 so an explicit buy intent from the scanner is never flipped by the description.

V0.7.93 changes:
- A bot offer cancelled with "Items Now Unavailable For Trade" now has top priority. Its re-send goes ahead of every other queued trade, and a trade that is already running re-sends it at the next safe point (after the current STN batch or the current bot offer) instead of finishing everything first.
- A cancelled or still-pending offer is no longer mistaken for a new Good Trade. Prices are still checked every time an item shows up (nothing is skipped), but a listing (same item and same bot) that is already queued, being sent, waiting for Steam, or waiting to be re-sent is not bought and offered a second time. Other listings of the same item still queue. The manual Auto trade button is not affected. Once an offer is accepted (or declined/expired) the listing can trade again.
- The Backpack.tf pages opened for an automatic trade now open in the scanner window instead of your main window, so your own tab is not switched. (The popup's manual "open verified pages" button still opens them in your window.)
- If Firefox does not accept the "open unfocused" option for the scanner window, the new window now hands focus straight back to your main window.

V0.7.92 changes:
- middle3.mp3 plays once after the last Backpack.tf bot offer of an item has been sent (only the Backpack.tf trades; the STN sounds are unchanged, and re-sent offers are silent).

V0.7.91 changes:
- Corrected the trade sounds so they only follow the STN buying sequence (the batches bought from several STN bots, each with its own Steam offer): middle1.mp3 plays when the first STN "Open Trade Offer" Steam page is opened, middle2.5.mp3 plays after each STN trade is accepted while more STN trades are still coming, and middle2.mp3 plays after the final STN trade is accepted (the end of STN trading). Nothing plays for the offers sent to Backpack.tf traders, and jobs that skip STN are silent. This replaces the V0.7.88 and V0.7.90 sound behavior.

V0.7.90 changes:
- Trade sound sequence (all at the notification volume): middle1.mp3 when the STN purchase sequence starts, middle2.5.mp3 after every bot offer that still has more offers coming after it, middle2.mp3 when the last bot offer has been sent, and middle1.mp3 again at the complete end of the trade (after the "all offers sent" sound finishes). Jobs that skip STN (existing inventory) have no start sound, and re-sent offers are silent. This replaces the V0.7.88 sounds.

V0.7.89 changes:
- The listing freshness limit is now 24 hours instead of 2: a buy listing is only ignored when its last bump (or listing time) is more than one day old.

V0.7.88 changes:
- Two new sounds during automatic trades (played at the notification volume): middle1.mp3 when an STN purchase offer has been accepted (confirmed by the Steam Web API, once per STN batch), and middle2.mp3 when every bot offer for the item has been sent.

V0.7.87 changes:
- The bad-trader check now counts the stock written in the description. A bot saying "Stock: 4/5" already holds 4 of that item, so the 4 it owns are expected: with 1 wanted it is only a bad trader if it holds 5 or more (stock + wanted). Descriptions without a current/maximum stock behave as before (bad when it holds as many as it wants, 1 by default). The popup shows the limit used.

V0.7.86 changes:
- Bot offer links now include the item's quality and whether it is a cosmetic, so TF2 Metal Trader 0.9.120 searches the inventory with Steam's Quality (Unique for normal hats) and Type: Cosmetic filters. Keys, tickets and other non-cosmetics skip the Cosmetic filter.

V0.7.85 changes:
- Backpack.tf server errors (HTTP 500, 502, 503, 504, 429 or a Cloudflare 52x page) no longer make an item get skipped or read as empty. The Backpack.tf stats page and every Classifieds page of the scan are checked after loading; if the site returned an error the tab is reloaded after a short pause (about 2-3.5s, then 3.5-5s, 5-6.5s and 6.5-8s) and checked again, up to 4 reloads. Normal pages are not delayed at all.

V0.7.84 changes:
- An explicit count in a trader's description ("I CAN BUY 5", "Selling 2") now always sets the number of items for that listing. It is read from the description on its own first, and no longer loses to a stock fraction, "stock"/"have" wording or "up to N" found elsewhere in the listing's text. Example: "Buying for 1.5 ref I CAN BUY 5 ..." is a 5-item listing (7.5 ref); if the trader's metal only covers 4, 4 items are queued.

V0.7.83 changes:
- Sent bot offers are tracked through the Steam Web API (IEconService/GetTradeOffers, sent offers, polled about every 12 seconds, using the saved Steam Web API key). If Steam reports an offer as state 8 (InvalidItems, "Items Now Unavailable For Trade"), whether before or after you confirmed it on mobile, the same offer is built and sent again to the same bot. The re-send is queued ahead of other work, still runs if automatic trading was switched off afterwards, skips the copies used by other offers that are still pending, and re-checks the bot's metal like any new offer.
- Tracking of an offer ends when Steam reports Accepted (state 3, or 11 for accepted into escrow). Declined, expired, cancelled, countered or mobile-cancelled offers are not sent again. An offer is re-sent at most 3 times, and tracking stops after 3 hours or if the Web API key is denied.
- Needs TF2 Metal Trader 0.9.119, which reports the new offer's id. If the id is missing the offer is found through its item asset ids. Tracking lives in memory, so reloading the add-on forgets the offers being watched.

V0.7.82 changes:
- STN purchase offers are only treated as accepted when Steam's accept request succeeds (TF2 Metal Trader 0.9.118). Ignored clicks and refused requests are retried; text on the page alone is no longer trusted.
- Purchase-acceptance watchdog: if the Steam offer page shows no sign of acceptance (or reports a failure), or 90 seconds pass, the offer tab is reloaded (at most twice) while the Steam Web API keeps being polled as the final check.
- Bad-trader check before the metal check: the bot's inventory is filtered to Unique (and Cosmetic for hats; keys, tickets, crates, tags, killstreak items, paints, taunts and similar skip the Cosmetic filter), searched for the exact item name and counted. If the bot already holds as many as it wants (stock in its listing description, 1 by default) it is marked "Bad trader" and its metal is not checked; otherwise it continues to the metal check. A failed count never rejects a trader.
- Bad traders never count as verified, are never picked as the best listing, and if every profitable trader is bad the item is not a Good Trade. The popup shows "Bad trader" on the offer and a "bad traders" counter.

V0.7.81 changes:
- STN purchases now run in the scanner window. The single transaction tab (STN item page, each incoming purchase offer that follows it, and each bot offer after that) is opened in the "TF2 Arbitrage Scanner" window instead of your main window. If a separate window cannot be opened it falls back to the main window, as before.
- Scan and trade take turns in that window so they never fight over its active tab (Steam and STN only work in a visible page): scanning pauses while a trade is running ("Scanning is paused while a trade runs..."), and a trade that starts in the middle of a scan item waits for that item to finish.
- The scanner window now closes only when neither a scan nor a trade is using it: a scan that ends (or is stopped) while a trade is running leaves the window open, and the trade worker closes it when the last trade is done. A trade that runs with no scan (for example the manual Auto trade button) opens the window on demand.
- STN and Steam pages in the scanner window use the same "raise only if hidden" check as the offer checks: if the window is minimized or fully covered it is brought forward for the trade and focus returns to your main window when the trade ends.
- The Backpack.tf pages that are highlighted for you still open in your main window.

V0.7.80 changes:
- Trader blacklist (blacklist.js, loaded by both the page scanner and the background script). Listings from these traders are ignored everywhere: they never count as profitable, are never verified, never receive an offer and are never highlighted: ZeBro 🦓 (76561199389742592), Duck 🦆 (76561199104298973), Testing! :D (76561199125269570), XmaS Bot (76561199220022021), plus the existing bluebus (76561198356389238).
- Matching is by account, not just name: the Steam64 ID, the shorter partner ID Backpack.tf often shows, and the partner ID inside the trade-offer link are all checked. A name is only used when the listing exposes no account id, so a different trader who merely copies a name is not blocked.
- If every Buy Order for an item is from blacklisted traders, the result says "Only blacklisted traders have Buy Orders for this item (N ignored)".
- To block another trader, add a line to TRADERS in blacklist.js with their Steam64 ID (the number in their backpack.tf profile link, https://backpack.tf/u/<id>).

V0.7.79 changes:
- Steam Web API: a response with no "trade_offers_received" list (Steam sends `{"response":{}}` when it has nothing to list) is no longer a fatal error ("Steam Web API response did not include the received trade-offers list"). It means "offer not listed yet". When the offer is not in the list, the exact offer is also looked up with IEconService/GetTradeOffer, which is how an offer that the list omits is detected as Accepted (state 3). If Steam still does not know the offer after several checks, the status line says the saved key must belong to the Steam account that receives the STN offers.
- Every bot offer now uses different copies of the item. Each offer link carries the asset ids already used by earlier offers of the run; Metal Trader skips them and reports back the copies it used, which are remembered for the next offer. Status lines show the asset id(s) used by each offer.

V0.7.78 changes (STN purchases made in several batches / from several STN bots):
- The single reused transaction tab is now navigated deterministically. After `tabs.update` the tab keeps reporting "complete" for the previous page for a moment, so the add-on used to act on the previous document: batch 2's STN QuickBuy request could reach the old Steam offer page ("This is not an STN item page") or click on the page that was about to be replaced, and the new bot's Steam offer never opened. The tab is now only treated as loaded after it has gone through a complete load that began after the navigation was requested (the same page is force-reloaded if the URL would not change).
- Each purchase offer id is remembered. STN keeps showing the previous batch's "Your trade has been sent / Open Trade Offer" link until the new request replaces it, so that already-accepted offer is skipped instead of being returned (which previously counted a batch as bought without ever opening the new offer).
- STN's failure alerts ("Some items in your selection were reserved by other users", "We failed to process your trade request", "We were unable to process your request", "Trade Error", "An error occured sending your trade", "Your trade has expired", "We are overstocked on this item") are now reported immediately with STN's own text instead of waiting out the 3-minute timeout. A failure must be seen twice in a row so a stale alert is not mistaken for a real one.
- Temporary STN refusals (reserved by other users / unable to process / failed to process) reload the STN page and try the batch again, up to 2 retries; nothing is retried once STN has created an offer.
- The status line now names the Steam offer id STN created for each batch.

V0.7.77 changes:
- Works with TF2 Metal Trader 0.9.115: a bot offer that Steam refuses (for example "There was an error sending your trade offer. (26)") is retried by refreshing the trade page up to 3 times. The wait for one bot offer is extended to 7 minutes so those retries can finish.

V0.7.76 changes:
- Classifieds paging stops as soon as a page contains a Buy Order priced below the profit threshold (marketplace price + 0.05 ref). Buy Orders are ordered from highest to lowest price, so later pages cannot hold more profitable orders. A fully profitable page still continues to the next one, so every profitable listing is still counted. The Backpack.tf debug line reports how many pages were read.
- All scanning tabs (stats page, Classifieds pages) and the Steam offer metal checks open in one dedicated "TF2 Arbitrage Scanner" window that opens unfocused and closes when the scan ends or is stopped. The main window is no longer switched between tabs. If the scanner window is hidden (minimized or fully covered), it is raised only for the Steam check and focus then returns to the main window. If a scanner window cannot be opened, scanning falls back to the main window.
- Trade execution (STN purchase, Backpack.tf highlighting, bot offers) and the manual Backpack.tf / Auto trade buttons are unchanged and still use the main window.

V0.7.75 changes:
- If a bot cannot cover the total metal for a grouped listing, reduce the supported item quantity one at a time and only count/buy the quantity its inventory can afford.

V0.7.74 changes:
- Ignores buy listings whose most recent parsed bump (or Listed time when no bump is available) is too old (the limit is MAX_LISTING_ACTIVITY_AGE_MS in background.js; it was two hours here, later 24 hours in V0.7.89 and 10 hours since V0.7.96).
- Uses a recent bump time in preference to the original Listed time and reports stale listings excluded from results.

V0.7.26 REQUEST / BOT-ONLY LISTING GATE
=========================================
User request:
"Amazing product we have made here seriously. However, there is literally one more thing that we need to do and it would be amazing! Something we can automate infinitely! That thing is distinguishing from real player trade offers vs bot offers. This is easily done with checking the "listing-buttons" of each listing. If that listing has that class name "listing-buttons" check if that divider has a divider with the class name of "btn btn-bottom btn-xs btn-success" and you want to check that title, if the title has "Please only offer the buyout." written in it, then we can GUARENTEE that it is a bot! so we can accept this input/offer, please ignore all inputs/offers that have a title with the text "Negotiation is allowed." included in it. Thanks :)"

Implemented in v0.7.26:
- Inspect each listing's `.listing-buttons` container.
- Require the green `.btn.btn-bottom.btn-xs.btn-success[title]` button.
- Require its title to contain `Please only offer the buyout.`.
- Explicitly reject any listing whose title contains `Negotiation is allowed.`.
- Listings without the exact bot buyout signal are ignored.
- Removed the previous broader lightning-icon / negotiation-based bot detection for this decision.


v0.7.29 changes:
- Rejects any Buy Order containing "foot prints".
- Plays Item_metal_pot_drop.wav when a scan naturally reaches the end.
- Backpack.tf results use button-only links; raw Backpack.tf URLs are hidden.
- Default key rate is 63 ref/key.
- Includes robust scanner-owned tab cleanup/retry.


v0.7.35: Based on v0.7.30 behavior. Confirmed arbitrage hits automatically open the STN marketplace page and the exact Backpack.tf stats/classifieds page that supplied the profitable Buy Order.


v0.7.35 changes: ignores Backpack.tf account 76561198356389238 ([bluebus]); [BOT] Deer's Stuff ✨ uses QuickBuy quantity 2; waits 10 seconds after STN QuickBuy before opening the exact trade URL captured from the profitable Backpack.tf listing.


V0.7.49 changes:
- Adds a Traders popup tab with persisted avatar, name, and marked-trade count. Counts are based on the manual “Mark traded” controls; they are not automatically confirmed Steam completions.


V0.7.50 changes:
- Deal classification uses listing-price comparison only; offer-metal verification is deferred.
- A profitable listing opens that exact listing's Steam trade-offer URL in an inactive tab in the scan's original Firefox window.
- Result cards include a direct link to the selected listing's offer. If no usable offer URL exists, the extension logs that fact instead of opening an unrelated page.


V0.7.51 changes:
- Offer checking is restored and runs sequentially for every price-profitable bot listing; each opened offer is closed after inspection.
- Good Trades contains offers whose staged metal meets the listed price. Profitable candidates whose offer cannot be located/read appear in the separate Unverified tab; insufficient offers are excluded from both.
- A minimum margin of 0.05 ref now qualifies as price-profitable.
- Trade URL discovery now scans all listing attributes and extracts Steam trade-offer URLs from direct or encoded values.

V0.7.52 changes:
- Unverified Trades lists each profitable offer that could not be verified, including its trader, reason, listed price, and exact offer link when available. These entries remain visible even if another offer for the same item verifies successfully.

V0.7.53 changes:
- Classifieds fallback now follows all consecutive result pages, deduplicates repeated listings, and reports page-read failures or the 50-page safety limit instead of silently treating page one as the complete result.

V0.7.54 changes:
- Combines stats-page Buy Orders with all scanned Classifieds pages so finding a stats-page offer no longer skips other profitable traders.

V0.7.55 changes:
- Steam trade-offer tabs invoke TF2 Metal Trader's metal availability test; test items are removed and the offer is never submitted.
- Any item with more than one price-profitable bot listing is counted as a Good Trade, including cases where the inventory check is insufficient or unavailable.

V0.7.56 changes:
- Adds an explicit opt-in for queued STN purchases and sequential one-item bot offers while scans continue.
- Waits for Steam to confirm the incoming STN purchase was accepted before opening bot offers; failures stop that item workflow.
- Shows active/queued trade status and keeps transaction tabs in the original Firefox window.

V0.7.57 changes:
- Activates each Steam offer tab during metal verification, then restores the previously active tab. TF2 Metal Trader temporarily stages the required metal, removes those test items, and never submits the offer.

V0.7.58 changes:
- Deduplicates candidate buy orders by stable trader account or trade URL across stats and paginated Classifieds results, keeping only the highest price for a repeated trader.
- Activates the STN item tab for QuickBuy, invokes the exact adjacent QuickBuy button, then restores the previously active tab.

V0.7.59 changes:
- Metal verification now asks TF2 Metal Trader to stage exactly the needed metal denominations on the trader side, then removes all temporary test items; it no longer checks keys or scans inventory counts.
- Steam inventory verification matches the selected user's TF2 inventory container ID, avoiding false failures from a stale inventory-side class.

V0.7.60 changes:
- Waits for the trader inventory switch/recovery to finish before starting another recovery, and gives Steam's selected TF2 inventory page time to render before reporting a failure.

V0.7.61 changes:
- Leaves enough time for Steam's trade-page controls to initialize before the automated offer check switches to the trader's inventory.

V0.7.62 changes:
- Uses the installed extension version in arbitrage status and notification UI.
- Opens STN's incoming purchase offer in the foreground for Steam's accept controls, then restores the prior tab if the user has not switched away.
- Preserves the STN purchase-acceptance job handshake with TF2 Metal Trader.

V0.7.63 changes:
- Opens the STN incoming purchase offer without adding custom URL fragments, matching the ordinary offer acceptance flow.
- Correlates the acceptance event to the active purchase tab instead of a URL job marker.

V0.7.64 changes:
- Keeps the queued item workflow paused until the incoming STN offer is confirmed in Steam, including after the user completes mobile confirmation.

V0.7.65 changes:
- Waits for the no-fragment incoming offer to complete Steam Mobile confirmation before opening Backpack.tf or sending bot offers.

V0.7.66 changes:
- Opens Backpack.tf visibly after mobile confirmation and highlights each profitable listing before sending any bot offers.
- Brings each Steam offer tab to the foreground while Metal Trader builds and submits the one-item offer, then restores the prior tab if you have not switched away.

V0.7.67 changes:
- Correlates the Steam Mobile-confirmed purchase with the exact STN trade-offer ID as well as its browser tab.

V0.7.68 changes:
- Shows the STN offer ID, acceptance phase, Steam page evidence, and update time in the arbitrage popup.
- Distinguishes “accept clicked,” “mobile confirmation pending,” and “Steam page reports accepted”; outgoing bot offer recipient acceptance is not tracked.

V0.7.69 changes:
- Automatic arbitrage executes only price-profitable offers verified to contain enough metal; 13 profitable listings with 12 sufficient verifications queues 12 items/offers.
- Uses the parsed Classifieds stock fraction (for example, Stock 0/5) to verify payment for and offer the available number of copies to that trader.
- Reads the currently available STN QuickBuy quantities and repeats the largest supported batch that does not exceed the remaining target, accepting each incoming batch before buying more.
- Steam offer-verification tabs are brought to the foreground during each check and the previous active tab is restored afterward.
- Waits for the STN QuickBuy selector/button to finish initializing and for the selected batch quantity to enable before clicking.
- Result cards offer a Backpack.tf action that opens the source pages and highlights all visible sufficient offers, plus a manual Auto trade action that skips STN and uses existing inventory.

V0.7.70 changes:
- Correctly converts Classifieds stock fractions (Stock 0/5 = 5 available; Stock 2/5 = 3 available) and filters out sold-out offers.
- Checks the trader's total required metal for each listing quantity rather than only the one-item price.
- Sends the parsed quantity to Metal Trader and displays order count separately from total item capacity.
