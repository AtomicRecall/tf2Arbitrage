# TF2 Arbitrage Bot

A set of Firefox add-ons (plus a small Mac helper) that finds Team Fortress 2 hats
that can be **bought cheaply on STN Trading or scrap.tf and sold for more to
Backpack.tf buy-order bots**, and can carry out the whole trade for you.

> **Use at your own risk.** With automatic trading on, this spends real items and
> sends real Steam trade offers from your account. Read "Safety" below first, start
> with automatic trading **off**, and try one cheap hat before trusting it.
> Automating third-party sites may break their rules; that is your responsibility.

---

## What it does

1. **Reads a marketplace.** It reads every hat on the STN hats listing
   (`stntrading.eu`) and on scrap.tf's Buy Hats page (`scrap.tf/buy/hats`), with
   the price and how many are in stock.
2. **Looks up the sell side.** For each hat it opens the Backpack.tf stats and
   classifieds pages and collects the **buy orders placed by bots** (listings with
   the "Please only offer the buyout" button). It ignores listings that want a
   special version of the hat: parts attached, spells, paint, and similar.
3. **Finds profit.** A hat is a *price-profitable* hit when the best bot buy order
   pays more than the marketplace price (by at least 0.05 ref), using the key rate
   you set.
4. **Checks the trade is real.** It opens each profitable bot's Steam trade-offer
   page and, with the **TF2 Metal Trader** add-on, tests that the bot really has
   enough metal to pay. Offers that pass are *verified*; the result becomes a
   **Good Trade** and you get a notification and sound.
5. **Optionally does the trade for you** (automatic trading):
   - buys the hat from STN (QuickBuy) or scrap.tf (selects it and presses the cart),
   - accepts the Steam offer the site sends,
   - asks the Mac to approve the Steam mobile confirmation,
   - waits until the Steam Web API says the purchase is *Accepted*,
   - then sends your hats to the Backpack.tf buyers as trade offers, and keeps
     watching them, re-sending any that Steam cancels.

STN and scrap.tf are scanned together; an item listed on both is checked once, at the
cheaper price. Each result card shows which site it came from, and a **Bought** tab
counts how many hats were bought from each.

---

## What is in this repository

| Folder | What it is |
| --- | --- |
| `tf2_trade_arbitrage_prototype/` | **The analyzer / scanner add-on** (the main bot). Popup and sidebar UI, scanning, verification, trade queue. |
| `automaticMetal/` | **TF2 Metal Trader** add-on. Works on Steam trade-offer pages: stages the right metal, sends the bot offers, accepts incoming offers. The analyzer drives it. |
| `macConfirmer/` | A small server for a Mac that accepts **Steam mobile confirmations** by clicking in the Steam app through iPhone Mirroring. |
| `browserShell/` | A launcher that starts a dedicated Firefox with both add-ons preinstalled, the analyzer in the sidebar, and the confirm server running. (Mac.) |

Both add-ons are needed: the analyzer finds and queues trades, TF2 Metal Trader does
the work on Steam's pages.

---

## Requirements

- **Firefox Developer Edition, Nightly or ESR** (regular Firefox refuses unsigned add-ons).
- A Steam account signed in to **Steam, backpack.tf, stntrading.eu and scrap.tf** in that browser.
- A **Steam Web API key** (https://steamcommunity.com/dev/apikey), needed for automatic trading.
  It stays in the add-on's local storage.
- For hands-free trading: a **Mac** with **iPhone Mirroring**, the Steam app on the iPhone with
  mobile confirmations enabled, and `cliclick` (`brew install cliclick`).
- Python 3 (only for the Mac helper and launcher).

---

## Install

### Windows (or any computer, temporary add-ons)

1. Open Firefox Developer Edition and go to `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on...** and pick `automaticMetal/manifest.json`.
3. Load Temporary Add-on again and pick `tf2_trade_arbitrage_prototype/manifest.json`.
4. The analyzer opens in the sidebar (toggle it with **Alt+Shift+T**) or from the toolbar button.

Temporary add-ons disappear when Firefox closes, so repeat this each time. They also lose
their settings, which is why the Mac launcher below is nicer for daily use.

### Mac (recommended: dedicated browser plus confirmer)

```bash
brew install cliclick
python3 browserShell/launch.py --server-dry-run   # first run: nothing is clicked
python3 browserShell/launch.py                    # real run
```

The launcher packs both add-ons into their own Firefox profile (logins and settings are
kept between runs), opens STN and scrap.tf as tabs, starts the confirm server and fills in the
Mac confirmer settings for you. You can also double-click `browserShell/TF2 Trader.command`.
Full details: [`browserShell/SETUP.md`](browserShell/SETUP.md).

---

## First-time setup in the sidebar

1. Set **1 key = ... ref** to the current key price.
2. Paste your **Steam Web API key** and press *Save key*.
3. Leave **Automatically buy items and send bot offers** *off* until you have watched a few scans.
4. Optional: set the sound volume, and decide whether to **skip scrap.tf's Craft Hats**
   section (on by default; it is hundreds of cheap hats that are almost never profitable).

---

## Using it

### Scan

1. Open **`stntrading.eu`** (the hats listing) and/or **`scrap.tf/buy/hats`** in the same window
   (scrap.tf needs you signed in).
2. Press **Scan Pages**. Every STN and scrap.tf page open in the window is read, and
   the two sites are checked alternately. Every STN hat is checked **both ways**: buy on STN and sell
   on Backpack.tf, and buy on Backpack.tf and sell to STN (see the reverse scan below). scrap.tf hats are
   checked buying on scrap.tf. Under each scan button are two checkboxes,
   stntrading.eu and scrap.tf (both ticked by default), choosing which site's page(s) that button reads.
   **Scan No Sell** is the same scan without the "sell to STN" direction: it only checks buying from the
   marketplace and selling to a bot on Backpack.tf. **Scan Offline** does that too, but only checks: Good
   Trades are saved (see *Saved Good Trades*), and nothing is bought and no offer is sent, whatever the
   automatic-trading checkbox says. A separate **TF2 Arbitrage Scanner** window opens for the
   Backpack.tf and Steam pages and closes when the work is done. Keep it open and visible.
3. Watch the result tabs:

| Tab | Meaning |
| --- | --- |
| All / Found | Everything checked / items with a Backpack.tf price |
| **Good Trades** | Profitable and the bot was verified to have the metal |
| Unverified Trades | Profitable but the bot's metal could not be verified |
| Not Found | No usable Backpack.tf bot buy order |
| Dismissed | Items you hid (use *Dismiss* on a card; *Restore* brings it back) |
| Traders | Traders you marked with *Mark traded* on Backpack.tf pages |
| **Bought** | Hats bought, in total and per site (STN / scrap.tf), with the Steam offer numbers |
| **Sell to STN** | Reverse scan hits: a hat Backpack.tf sells for less than STN pays for it |
| **Checked** | Items checked in the last 60 minutes, at the price they were checked at, with a countdown. The next scan skips them. |

A hit also shows a notification and plays `hit.mp3`. Card buttons: *Backpack.tf, highlight verified*
opens the exact buy-order listings, *Retry this item* rechecks it, and *Auto trade (skip STN)*
sends offers using hats you already own.

### Reverse scan: buy on Backpack.tf, sell to STN

The "sell to STN" direction of **Scan Pages** (left out by Scan No Sell and Scan Offline) goes the other way. For each hat on the open STN hats page it reads what STN pays
(the "Sell it for" box on the hat's own STN page, plus how many more STN will buy) and compares it with the
cheapest bot sell listing on Backpack.tf. Hats where Backpack.tf is at least 0.05 ref cheaper land in the
**Sell to STN** tab with a notification. This side is report-only: nothing is bought automatically.
It is slow (two pages per hat), though hats STN will not buy more of are skipped quickly. scrap.tf hats never get this
check; they get their own sell-to-STN check instead: **buy on scrap.tf, sell to STN**. For every scrap.tf hat the add-on
reads STN's "Sell it for" price on the hat's STN page and compares it with the scrap.tf price (at least 0.05 ref
cheaper on scrap.tf is a hit in the **Sell to STN** tab, report-only like the check above; hats STN does not buy are
remembered for 60 minutes). Only **Scan Pages** does these two sell-to-STN checks. The STN page and
the Backpack.tf stats page are read once per hat and shared by its checks: STN's page first (what STN pays), then
Backpack.tf (buy orders and sell listings from one page), then the scrap.tf price is compared with both. Each hat's two
directions are checked back to back (forward check, then this one), so a hat is fully checked before the next one starts.

### Automatic trading

Tick **Automatically buy items and send bot offers** (a Steam Web API key is required). For each
Good Trade the bot then:

1. buys the hat on the cheaper site (STN or scrap.tf),
2. accepts the Steam offer and waits for the Steam Web API to report *Accepted*
   (it asks the Mac to do the mobile confirmation),
3. sends the verified Backpack.tf offers, one hat set per buyer, using different copies each time,
4. tracks them and re-sends any Steam cancelled.

**Craftable or not.** STN names an uncraftable item "Non-Craftable <name>", and those are scanned against
Backpack.tf's Non-Craftable page and buy orders like any other item; every other item is assumed craftable.
STN's pages say nothing more, so before an STN or scrap.tf offer is accepted its items are read through the
Steam Web API: an offer holding items marked "( Not Usable in Crafting )" for a craftable job (or craftable
ones for a Non-Craftable job) is not accepted, and Metal Trader only puts a copy of the right kind into the
bot offers.

**Raw keys only.** STN and scrap.tf build their own Steam offers and convert metal into keys at their
own rate when your inventory does not hold what a price asks for, and that cannot be changed from here.
So before every purchase of a key-priced hat (a price like *5 keys, 53 ref*) the add-on reads how many
Mann Co. Supply Crate Keys your signed-in Steam account holds and buys only as many hats as those keys
pay for. If the keys cover the whole quantity nothing changes (buy all, then sell all). If they do not,
it works as *buy, sell, buy, sell*: it buys what the keys cover, sends the bot offers for those hats,
waits until accepted offers have brought keys back (checked every 20 seconds, up to 45 minutes), then
buys and sells the next part. This also holds between different hats in the queue. If no pending sale
could bring more keys, or your key count cannot be read, the rest is not bought and the status box
says why. Hats priced only in metal are not affected. Metal is not budgeted, only keys.

If scrap.tf only allows part of a quantity at once, it buys in batches. The status box in the sidebar
shows the current step. Sounds follow the same pattern for both sites: `middle1.wav` when a
purchase is accepted and more is coming, `middle2.wav` when it was the last and again after the last
offer is sent, `Item_metal_pot_drop.wav` when a scan ends.

### Closing the browser

Closing the Firefox window ends everything: the scan stops (results, the 60-minute memory and saved
trades are already stored locally), queued trades are dropped and the scanner window closes (a trade that
is already running finishes first). On a Mac a closed window does not quit Firefox, so the add-on also
asks the confirm server on the same computer to shut down (`POST /shutdown`), which makes the launcher
quit Firefox and exit. Closing the Terminal or killing the launcher quits Firefox and the server too.
Closing only the scanner window by hand stops a running scan.

Only one scan runs at a time: while one is running (or waiting for its next STN rescan round) its button is lit up with
"running…" and the other scan buttons are switched off until you press Stop or the scan ends.

Anything to do with trade offers (the Steam offer checks while scanning, the STN purchase, the offers sent to bots)
happens in the main window, as an active tab; the tab you were on comes back afterwards. When a scan of an STN
page finishes, the add-on refreshes that STN tab, presses PageDown 3 times and scans again until you press Stop
(checkbox in the popup to turn it off). After 3 such rounds the next one loads the first page of the STN hats listing
(`https://stntrading.eu/tf2/hats?products_price_desc%5BsortBy%5D=products_time_desc&products_price_desc%5Bpage%5D=1`)
instead of refreshing, presses PageDown 3 times and scans that, then the count of 3 starts again.

When the scanner window opens it comes up on top of iPhone Mirroring, so the add-on then asks the confirm server
(`POST /focus`) to bring iPhone Mirroring back to the front. This only happens when the Mac confirmer is set up
in the popup, and nothing is clicked.

### Already checked items (60-minute memory)

Every item the bot checks is remembered for **60 minutes**, together with the price it was checked at
and the site it was on. A scan skips these items: they still show up as cards marked **Already checked**
(with how long ago and how many minutes are left), and the **Checked** tab lists them all. Each direction of an STN hat
is remembered separately. On the STN and scrap.tf pages themselves a checked item is grayed out with a small
countdown on top until it is due again: an STN hat checked **both ways** (and a scrap.tf hat, which only has
one way) is grayed out fully, an STN hat checked **one way only** is grayed out slightly and labelled
*Half checked* (hover the label for what is missing). An item is
checked again as soon as its 60 minutes are up or its price on that site changes. Checks that failed
(Backpack.tf did not load, a price could not be read) are not remembered, so they are retried.
*Retry this item* and *Check saved items* always check, and *Forget checked items* clears the memory.

### Check saved items

Every Good Trade, from STN or scrap.tf, and every hat the bot bought is saved in the browser (bought ones carry a **Bought ×N** badge). **Check saved items** reopens each one
on the site it was found on and on Backpack.tf and runs
the normal check again. Saved scrap.tf items are all answered from one read of the scrap.tf Buy Hats page (one tab, no waiting per item); saved STN items open their own STN page. A saved item that is checked again and is no longer a Good Trade (its price rose, or nobody buys it) is removed from the list automatically; checks that failed to load keep the item.
While it runs the status box names the item being checked and why one could not be read (a page that did not load is tried twice, and after three in a row the check pauses for 45 seconds), and when it ends it summarises how many saved items are still good, were removed, or could not be checked.

### Mac confirmer

Steam asks for a mobile confirmation when you give items away. The Mac helper accepts these by
clicking in the Steam app through iPhone Mirroring. Notes:

- Open iPhone Mirroring on the Steam app's **Confirmations** screen and do not move or resize it.
  The click positions in `macConfirmer/confirm_trades.py` (`TRADE_OFFER`, `CONFIRM_BUTTON`,
  `TIMEOUT_RETRY_BUTTON`) were measured on one screen. Re-measure them with `cliclick p` on yours.
- It accepts the *top* confirmation in the app, matched by count, not by trade. Do not leave
  unrelated confirmations pending while it runs.
- It pauses after any failure instead of clicking again. Check the server output, fix it, then resume.
- Use `--server-dry-run` (launcher) or `--dry-run` (scripts) to test without clicking.

Run the server by hand with `macConfirmer/run_server.sh` (add `--dry-run` to test). In the sidebar's
*Mac confirmer* section enter its address and token and press *Test connection*.

**Phone notification.** iPhone Mirroring only works while the phone is locked and not in use, so before
every confirmation run the server sends a push notification, "Lock your iPhone", and then waits 20 seconds
(`--notify-lead`) before it clicks. It also notifies you when a run failed and the server paused. It uses
[ntfy](https://ntfy.sh): install the free ntfy app on the iPhone and subscribe to the topic the server prints
at start (a random name kept in the git-ignored `macConfirmer/server_config.json`; anyone who knows it can send
you messages, so keep it private). Try it with `python3 confirm_server.py --test-notification`. The messages
only contain the number of trades and, for a failure, the error text, never item names, offer ids or
account details. `--no-notify` switches it off, `--ntfy-topic` / `--ntfy-server` change where it goes
(for example a self-hosted ntfy). In `--dry-run` nothing is sent.

**Only when the phone is not ready, and a "you can use your phone" message.** The server can check one spot
of the screen. With iPhone Mirroring showing the Steam confirmations page, that spot has a certain colour; you save
it once. Before a run the server takes a tiny screenshot of the spot: if it has the saved colour, the phone is
already on the confirmations page, so no "Lock your iPhone" message is sent and the clicks start. If it has another
colour, the message is sent and the Mac waits `--notify-lead` seconds for you to lock the phone. When
the confirmations are done and nothing else is waiting, a second message, "You can use your phone", is sent (only if
the first one was).

The phone check also drives the connection retry clicks. The loop for every batch of trades is:
trade to accept -> check whether the phone is on the confirmations page -> if not, do the three retry clicks
(`TIMEOUT_RETRY_BUTTON`, `SECOND_RETRY_BUTTON`, `THIRD_RETRY_BUTTON`, a short random pause between them) and wait
9-11 s for the iPhone to reconnect -> check again -> if still not, do the three clicks again, and so on until the
check says the phone is on the confirmations page; only then the list is refreshed and the trades are accepted.
When the page is already showing at the first check, no retry click is made. At most `--retry-rounds` rounds
(default 10) are done; after that the run fails, the server pauses and sends the "failed" notification instead of
clicking for ever. Without a saved spot (or when the screen cannot be read) the check cannot be done, so the three
retry clicks are made once per run.

**Moving the mouse.** Before every click the confirmer reads where the pointer is. You may nudge the mouse a
little: only a pointer more than 60 screen points away from where the script put it counts as "you grabbed the
mouse", and even then the script puts it back and looks again (3 tries) before stopping, so a stray bump or a
one-off shift by macOS / iPhone Mirroring no longer ends the run. `--pointer-tolerance N` changes the 60.

```bash
python3 macConfirmer/confirm_server.py --pick-phone-spot        # put the mouse on the spot within 5 s; the phone must show the confirmations page
python3 macConfirmer/confirm_server.py --phone-spot 1308,578    # or give the position yourself (add --phone-color R,G,B to give the colour too)
python3 macConfirmer/confirm_server.py --check-phone            # prints what the spot looks like now
```

Positions are screen points, the numbers `cliclick p` prints (the same as the click positions in
`confirm_trades.py`). Choose a spot of the page that is always the same colour, such as the page background, not
text or a trade. The first time, macOS asks Terminal (or TF2 Trader) for Screen Recording permission (System Settings
> Privacy & Security). The spot is saved in `server_config.json`; do it again if you move the mirroring window. If
the screen cannot be read, the message is sent every time. `--phone-tolerance` changes how far each of R, G and B
may differ (24), `--no-phone-check` ignores the saved spot.

---

## Safety and limits

- **It moves real items.** Automatic trading is off by default and only acts on trades whose
  buyer was verified to have enough metal and whose purchase the Steam Web API reported *Accepted*.
- Before pressing scrap.tf's cart button it checks the price has not risen since the scan, that nothing
  else is selected, and that the item is exactly the one wanted.
- Mobile confirmation is the final safety net: without the Mac helper you approve on your phone.
- The scan is slow and serial on purpose (Backpack.tf rate-limits), so two items are never checked at
  the exact same moment; the two sites just take turns.
- Unusual hats are skipped on scrap.tf (it does not name the effect).
- Listings from the traders in `tf2_trade_arbitrage_prototype/blacklist.js` are ignored. Add a Steam ID
  there to block another trader.
- The Mac server token is stored in `macConfirmer/server_config.json` (git-ignored). Never publish it,
  and do not commit your Steam Web API key.
- STN uses a bot check that only runs in a visible page; keep the scanner window visible, not minimized.

---

## Troubleshooting

| Symptom | Try |
| --- | --- |
| "No TF2 marketplace items found" | Open the STN hats listing or `scrap.tf/buy/hats` (signed in), let it finish loading, scan again. |
| Auto trading will not switch on | Save a Steam Web API key first. |
| scrap.tf purchase says the item list is missing | You are not signed in to scrap.tf in that browser. |
| Offer accepted but the Mac does nothing | Check the status line for "Asked the Mac to confirm" and the confirm server output; use *Test connection*; make sure the server is not in dry-run mode. |
| Confirm clicks land in the wrong place | Re-measure the coordinates in `macConfirmer/confirm_trades.py` with `cliclick p`. |
| Logins vanish after restarting | Use the Mac launcher, or keep "Stay signed in" ticked; temporary add-ons lose their settings on restart. |

---

## More documentation

- [`tf2_trade_arbitrage_prototype/README.txt`](tf2_trade_arbitrage_prototype/README.txt): detailed change log of the analyzer.
- [`automaticMetal/README.md`](automaticMetal/README.md): change log of TF2 Metal Trader.
- [`browserShell/SETUP.md`](browserShell/SETUP.md): Mac browser and launcher setup.
- Header comments in `macConfirmer/confirm_server.py` and `confirm_trades.py` describe the Mac helper's endpoints and options.
