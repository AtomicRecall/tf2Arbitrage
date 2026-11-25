// blacklist.js: traders matched by Steam64 id, by the shorter partner id, and by name only when a
// listing exposes no account id. Run: node tests/test_blacklist.js
const path = require("path");
require(path.join(__dirname, "..", "tf2_trade_arbitrage_prototype", "blacklist.js"));
const B = globalThis.TraderBlacklist;

let fails = 0;
const ok = (cond, label) => { if (!cond) { fails++; console.log("FAIL", label); } else console.log("ok", label); };

const first = B.entries[0];
const partner = (BigInt(first.steamId) - BigInt("76561197960265728")).toString();

ok(B.isBlacklisted({ listingAccountId: first.steamId }), "matched by Steam64 id");
ok(B.isBlacklisted({ listingAccountId: partner }), "matched by partner id");
ok(B.isBlacklisted({ tradeUrl: `https://steamcommunity.com/tradeoffer/new/?partner=${partner}&token=x` }), "matched by trade-offer link");
ok(B.isBlacklisted({ listingName: first.name }), "matched by name when there is no account id");
ok(!B.isBlacklisted({ listingAccountId: "1", listingName: first.name }), "name is NOT used when an account id is present");
ok(!B.isBlacklisted({ listingAccountId: "123456789", listingName: "Someone else" }), "other traders pass");
ok(B.filterOut([{ listingAccountId: partner }, { listingAccountId: "42" }]).length === 1, "filterOut drops only the blacklisted one");

console.log(fails ? "FAILURES " + fails : "ALL PASS");
process.exit(fails ? 1 : 0);
