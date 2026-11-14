# TF2 Trader browser (Firefox with the bot built in)

A dedicated Firefox profile that opens on the STN hats listing and on scrap.tf's
Buy Hats page (two tabs), has the bot's analyzer permanently in the sidebar, preinstalls both add-ons, and starts the
Mac confirmation server alongside it.

## One-time setup (Mac)

1. Install **Firefox Developer Edition** (release Firefox refuses unsigned add-ons).
2. Install `cliclick` (`brew install cliclick`) and allow your terminal (or the app, see below)
   under System Settings > Privacy & Security > **Accessibility** and **Input Monitoring**.
3. Open iPhone Mirroring and place its window where the click coordinates in
   `macConfirmer/confirm_trades.py` expect it (see that file's header).
4. First run, with the server in dry-run mode so nothing is clicked:

   ```bash
   python3 browserShell/launch.py --server-dry-run
   ```

5. In the browser, sign in to Steam, backpack.tf, stntrading.eu and scrap.tf (the browser keeps you signed in
   after restarts), and enter your Steam Web API key and key rate in the sidebar. The **Mac confirmer**
   settings are filled in for you: the launcher creates the server's token, hands it to the add-on, and
   enables it. Open the Mac confirmer section and press **Test connection** to check it. You can switch
   it off with its checkbox and the choice is kept.
6. When everything checks out, start it without `--server-dry-run`.

## Starting it without typing a command

- **`browserShell/TF2 Trader.command`**: double-click it in Finder. It opens a Terminal window that runs the launcher.
  (If macOS blocks it the first time: right-click > Open. If it does not run, `chmod +x "browserShell/TF2 Trader.command"` once.)
- **`TF2 Trader.app`**: run `browserShell/make_app.sh` once to build it in the project folder, then double-click it or drag it to the Dock.
  It also opens Terminal, so the clicks use Terminal's Accessibility / Input Monitoring permissions and the server output stays visible.
  The first time, macOS asks whether the app may control Terminal: allow it.

Both start the real server (clicks on). For the dry run in step 4, use `python3 browserShell/launch.py --server-dry-run`.
Close Firefox to stop everything.

## Scanning and buying on scrap.tf

Everything that works on Windows works the same here: the add-on is the same code, only the browser
and the confirmer are different. To use scrap.tf, select its tab (`https://scrap.tf/hats`, signed in to
Steam) and press **Scan current page** in the sidebar. With "Automatically buy items and send bot offers"
on, a Good Trade is bought on scrap.tf (item selected, cart button pressed, the Steam offer scrap.tf
sends is accepted), and the Mac confirmer then approves the mobile confirmation like it does for STN.
The Craft Hats section is skipped by default (checkbox in the sidebar).

## What the sidebar does

- It is the same page as the toolbar popup (`popup.html?mode=sidebar`), so it stays
  alive while you browse and shows scan progress, trades and the confirmer status live.
- `userChrome.css` hides the sidebar's header and close button. If it does get
  closed, **Alt+Shift+T** toggles it.

## Known limits (where Electron would take over)

- The sidebar is hidden with CSS tweaks on Firefox's classic sidebar. A Firefox
  update can change the sidebar's structure and bring the close button back.
- Only Firefox Developer Edition, Nightly or ESR run unsigned add-ons.
- The add-ons still run as extensions: tabs and the scanner window are Firefox's.
  Nothing here can make the sidebar truly unclosable or give you one window of your own.
- Add-on settings from your old (temporary) install do not carry over; the new
  add-on ID means a fresh storage area.
- `userChrome.css` and `user.js` are applied from the profile on each start, but the
  sidebar must have been shown once; if it does not appear on first launch, press Alt+Shift+T.

## Files

- `launch.py`: builds the add-on packages into the profile, starts the server and Firefox.
- `profile/user.js`: preferences (home page, unsigned add-ons, quiet browser).
- `profile/chrome/userChrome.css`: always-visible sidebar styling.
- `make_app.sh`: optional macOS app wrapper.
