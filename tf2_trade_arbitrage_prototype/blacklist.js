// Trader blacklist, shared by the page scanner (content.js) and the background
// script (background.js). To block another trader, add one line to TRADERS with
// their 64-bit Steam ID (the number in their backpack.tf profile link:
// https://backpack.tf/u/<steamId>). The name is only a label, plus a fallback
// for listings that expose no account id at all.
(function(root){
  "use strict";

  const TRADERS=Object.freeze([
    {name:"ZeBro 🦓",steamId:"76561199389742592"},
    {name:"Duck 🦆",steamId:"76561199104298973"},
    {name:"Testing! :D",steamId:"76561199125269570"},
    {name:"XmaS Bot",steamId:"76561199220022021"},
    {name:"bluebus",steamId:"76561198356389238"},
    {name:"BuzzyBee 🌻🐝",steamId:"76561199389459475"},
    {name:"TEAM FORTRESS 2 ITEMS", steamId:"76561199119559575"},
    {name:"Infinite1808 Bot 24/7", steamId:"76561198776643746"}
  ]);

  const STEAM64_BASE=BigInt("76561197960265728");

  // Backpack.tf listings expose the trader either as a Steam64 ID or as the
  // shorter Steam "partner" ID (the number in a trade-offer link), so every
  // blacklisted account is matched in both forms.
  function partnerIdFromSteam64(steamId){
    try{return (BigInt(steamId)-STEAM64_BASE).toString()}
    catch(error){return ""}
  }

  function normalizeName(value){
    return String(value||"")
      .normalize("NFKC")
      .replace(/[\u200B-\u200D\uFEFF\uFE0F]/g,"")
      .replace(/\s+/g," ")
      .trim()
      .toLowerCase();
  }

  const idToEntry=new Map();
  const nameToEntry=new Map();
  for(const entry of TRADERS){
    idToEntry.set(entry.steamId,entry);
    const partnerId=partnerIdFromSteam64(entry.steamId);
    if(partnerId)idToEntry.set(partnerId,entry);
    nameToEntry.set(normalizeName(entry.name),entry);
  }

  function partnerFromTradeUrl(tradeUrl){
    try{
      const value=new URL(String(tradeUrl||"")).searchParams.get("partner");
      return /^\d+$/.test(String(value||""))?String(value):"";
    }catch(error){return ""}
  }

  // Returns the blacklist entry for a listing, or null. Accepts anything that
  // carries the usual listing fields: listingAccountId / accountId, tradeUrl,
  // listingName / name.
  function findBlacklistedTrader(listing){
    if(!listing)return null;
    const ids=[
      listing.listingAccountId,
      listing.accountId,
      listing.traderId,
      partnerFromTradeUrl(listing.tradeUrl)
    ].map(value=>String(value||"").trim()).filter(value=>/^\d+$/.test(value));

    for(const id of ids){
      const entry=idToEntry.get(id);
      if(entry)return entry;
    }

    // Names are not unique, so they are only trusted when the listing exposes
    // no account id to compare.
    if(!ids.length){
      const entry=nameToEntry.get(normalizeName(listing.listingName||listing.traderName||listing.name));
      if(entry)return entry;
    }
    return null;
  }

  root.TraderBlacklist=Object.freeze({
    entries:TRADERS,
    find:findBlacklistedTrader,
    isBlacklisted:listing=>findBlacklistedTrader(listing)!==null,
    filterOut:listings=>(Array.isArray(listings)?listings:[]).filter(listing=>!findBlacklistedTrader(listing))
  });
})(typeof globalThis!=="undefined"?globalThis:self);
