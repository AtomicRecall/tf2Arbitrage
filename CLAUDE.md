# tf2Arbitrage — notes for Claude

@AGENT.md

The file above is the full guide (safety rules, architecture, message protocols, storage keys, recipes). Read it before changing anything. The short version:

## Before you change anything
- This bot spends real Steam items. Keep automatic trading **off** by default, test scans with **Scan Offline**, test the Mac helper with `--dry-run`, never print secrets (`.env.local`, `macConfirmer/server_config.json`, the Steam Web API key), and never make requests faster than the existing delays.
- Don't commit, push or enable anything trade-affecting unless the user asks.

## How we work here
- **Environment:** Windows 11, PowerShell/Git Bash. Use `python`, not `python3`. Put throwaway scripts in the session scratchpad, not in the repo.
- **Edit with `tools/patch.py`** (exact-match replacements that keep each file's CRLF/LF and BOM). Make small targeted edits; do not reformat or rewrite whole files. The code style is compact on purpose.
- **Every change ships with:** a version bump in the add-on's `manifest.json` (and its `default_title`), a new top entry in the add-on's changelog (scanner `README.txt`, Metal Trader `README.md`), and a root `README.md` update when user-visible behaviour changes.
- **Before saying "done":** run `python tests/run_all.py` (all tests + `tools/check.py`). If you changed a safety rule on purpose, update its guard in `tests/test_source_guards.js` in the same change.
- **Be honest about verification.** Nothing involving live Steam, STN, scrap.tf, Backpack.tf or the Mac can be tested from here. Say what you ran (mocks, syntax checks, tests) and what you could not.

## Where things are
- Scan loop, verification, trade queue: `tf2_trade_arbitrage_prototype/background.js`. Page readers/actors: `content.js`. UI: `popup.js` / `popup.html`.
- Steam trade-offer automation (metal, bot offers): `automaticMetal/` (`content.js`, `page-bridge.js`), driven through `tmt_*` URL-hash parameters and DOM events (AGENT.md §6).
- Mac confirmations: `macConfirmer/`. Launcher: `browserShell/`.
- Decisions that look odd but are deliberate (exact bot-title rule, stock-first, metal capped to stock, click-to-stop, …): AGENT.md §14.

## How the owner likes answers
Plain language; summaries say what was added, without version numbers; point out what is unverified and any risk (real trades), and offer the next step instead of asking many questions.
