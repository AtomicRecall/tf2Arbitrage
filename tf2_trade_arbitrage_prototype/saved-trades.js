// A small local database of items that have been Good Trades.
//
// It lives in the extension's local storage (key "savedTrades", an object keyed
// by the lower-case item name) and never leaves the browser. The "Check saved
// items" button re-scans exactly these items. This file only holds the pure
// bookkeeping; background.js loads and stores the object.
(function(root){
  const STORAGE_KEY="savedTrades";
  const MAX_ENTRIES=500;

  function keyFor(name){
    return String(name||"").trim().replace(/\s+/g," ").toLowerCase();
  }

  // Records that `result` (a scan result) was a Good Trade. Returns the map.
  function recordGoodTrade(map,result,now=Date.now()){
    const name=String(result?.name||"").trim();
    const key=keyFor(name);
    if(!key||!result?.deal)return map;
    const previous=map[key];
    const buy=result.buyPrice?.display||result.sourceItem?.price||previous?.buyPrice||"";
    const scrap=result.source==="scrap.tf";
    map[key]={
      name,
      // Where it was found: a saved scrap.tf item is re-checked on scrap.tf.
      source:scrap?"scrap.tf":"stn",
      sourceHref:scrap?String(result.sourceItem?.href||""):"",
      scrapValue:scrap?(Number(result.sourceItem?.scrapValue)||null):null,
      buyPrice:String(buy),
      sellPrice:String(result.sellPrice?.display||previous?.sellPrice||""),
      profitRef:Number.isFinite(result.profitRef)?result.profitRef:(previous?.profitRef??null),
      stock:result.sourceItem?.stock??previous?.stock??null,
      savedAt:previous?.savedAt||now,
      lastGoodAt:now,
      goodCount:(previous?.goodCount||0)+1,
      lastCheckedAt:result.savedCheck?now:(previous?.lastCheckedAt||null),
      lastStatus:"good",
      lastNote:"",
      boughtCount:previous?.boughtCount||0,
      lastBoughtAt:previous?.lastBoughtAt||null
    };
    return trim(map);
  }

  // Hats the bot bought belong in the saved list too: they are the items that
  // proved to be worth trading. `log` is the purchase log (the Bought tab). The
  // bought count is recomputed from the log, so running this twice changes
  // nothing. `onlyKeys` (a Set of keys) limits it to those items.
  function syncBought(map,log,onlyKeys,now=Date.now()){
    const byKey=new Map();
    for(const entry of Array.isArray(log)?log:[]){
      const key=keyFor(entry?.name);
      const quantity=Math.floor(Number(entry?.quantity));
      if(!key||!(quantity>0)||(onlyKeys&&!onlyKeys.has(key)))continue;
      const row=byKey.get(key)||{count:0,last:null};
      row.count+=quantity;
      if(!row.last||(Number(entry.at)||0)>=(Number(row.last.at)||0))row.last=entry;
      byKey.set(key,row);
    }
    for(const [key,row] of byKey){
      const last=row.last;
      const at=Number(last.at)||now;
      const previous=map[key];
      const scrap=last.source==="scrap.tf";
      map[key]={
        name:previous?.name||String(last.name).trim(),
        source:scrap?"scrap.tf":"stn",
        sourceHref:scrap?String(last.href||previous?.sourceHref||""):"",
        scrapValue:scrap?(Number(last.scrapValue)||previous?.scrapValue||null):null,
        buyPrice:String(last.price||previous?.buyPrice||""),
        sellPrice:String(previous?.sellPrice||last.sellPrice||""),
        profitRef:Number.isFinite(previous?.profitRef)?previous.profitRef:(Number.isFinite(last.profitRef)?last.profitRef:null),
        stock:previous?.stock??null,
        savedAt:previous?.savedAt||at,
        lastGoodAt:previous?.lastGoodAt||at,
        goodCount:previous?.goodCount||0,
        lastCheckedAt:previous?.lastCheckedAt||null,
        lastStatus:previous?.lastStatus||"good",
        lastNote:previous?.lastNote||"",
        boughtCount:row.count,
        lastBoughtAt:at
      };
    }
    return trim(map);
  }

  // Records the outcome of re-checking a saved item that is no longer a Good
  // Trade (or could not be checked). Items that are not saved are ignored.
  function recordCheck(map,result,now=Date.now()){
    const key=keyFor(result?.name);
    const entry=map[key];
    if(!entry||!result?.savedCheck||result.deal)return map;
    const buy=result.buyPrice?.display||result.sourceItem?.price;
    map[key]={
      ...entry,
      buyPrice:buy?String(buy):entry.buyPrice,
      stock:result.sourceItem?.stock??entry.stock??null,
      lastCheckedAt:now,
      lastStatus:result.skipped?"skipped":"not-good",
      lastNote:String(result.reason||"").slice(0,200)
    };
    return map;
  }

  function remove(map,name){
    delete map[keyFor(name)];
    return map;
  }

  // Newest first, ready for the scan queue or the list in the popup.
  function list(map){
    return Object.values(map&&typeof map==="object"?map:{})
      .filter(entry=>entry&&entry.name)
      .sort((a,b)=>Math.max(b.lastGoodAt||0,b.lastBoughtAt||0)-Math.max(a.lastGoodAt||0,a.lastBoughtAt||0));
  }

  function trim(map){
    const entries=list(map);
    if(entries.length<=MAX_ENTRIES)return map;
    const kept={};
    for(const entry of entries.slice(0,MAX_ENTRIES))kept[keyFor(entry.name)]=entry;
    return kept;
  }

  const exported={STORAGE_KEY,MAX_ENTRIES,keyFor,recordGoodTrade,recordCheck,syncBought,remove,list};
  if(typeof module!=="undefined"&&module.exports)module.exports=exported;
  else root.TF2SavedTrades=exported;
})(typeof self!=="undefined"?self:this);
