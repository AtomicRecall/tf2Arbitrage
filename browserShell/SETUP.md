# TF2 Trader browser (Firefox with the bot built in)

A dedicated Firefox profile that opens on the STN hats listing, has the bot's
analyzer permanently in the sidebar, preinstalls both add-ons, and starts the
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

5. In the browser, sign in to Steam, backpack.tf and stntrading.eu. In the
   sidebar, enter your Steam Web API key and key rate, then open
   **Mac confirmer**, set the address to `http://127.0.0.1:8765`, paste the token the
   server printed (also in `macConfirmer/server_config.json`), tick the box, **Save**,
   and **Test connection**. These settings live in the profile and persist.
6. When everything checks out, start it without `--server-dry-run`.

Optional: `browserShell/make_app.sh` builds a double-clickable `TF2 Trader.app`.

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
