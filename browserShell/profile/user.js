// Preferences for the TF2 Trader browser profile. Firefox applies this file on
// every start. __HOME_URL__ is filled in by launch.py.

// ---- Home page: opens on the STN hats listing, newest first ----------------
user_pref("browser.startup.homepage", "__HOME_URL__");
user_pref("browser.startup.page", 1);
user_pref("browser.newtabpage.enabled", false);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("startup.homepage_welcome_url", "");
user_pref("startup.homepage_welcome_url.additional", "");
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("trailhead.firstrun.didSeeAboutWelcome", true);

// ---- Add-ons: the two bundled, unsigned extensions load from extensions/ ----
// Needs Firefox Developer Edition, Nightly or ESR; release Firefox ignores
// this pref and refuses unsigned add-ons.
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("extensions.update.enabled", false);
user_pref("extensions.postDownloadThirdPartyPrompt", false);

// ---- Interface: let userChrome.css keep the sidebar permanently visible ----
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);
user_pref("sidebar.revamp", false);
user_pref("sidebar.verticalTabs", false);
user_pref("sidebar.position_start", true);

// ---- Logins and saved settings survive restarts ----------------------------
// Nothing is cleared on exit. (Session-only login cookies are made persistent
// by the add-on's cookie keeper, since Firefox drops them on quit.)
user_pref("network.cookie.lifetimePolicy", 0);
user_pref("privacy.sanitize.sanitizeOnShutdown", false);
user_pref("privacy.clearOnShutdown.cookies", false);
user_pref("privacy.clearOnShutdown.cache", false);
user_pref("privacy.clearOnShutdown.sessions", false);
user_pref("privacy.clearOnShutdown.offlineApps", false);
user_pref("privacy.clearOnShutdown_v2.cookiesAndStorage", false);
user_pref("privacy.clearOnShutdown_v2.cache", false);
user_pref("signon.rememberSignons", true);

// ---- Quieter browser: no background noise during a long-running bot --------
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("app.shield.optoutstudies.enabled", false);
user_pref("browser.tabs.warnOnClose", false);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.download.useDownloadDir", true);
