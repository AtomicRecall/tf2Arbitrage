const api=typeof browser!=="undefined"?browser:chrome;
// Opened as the browser sidebar (manifest sidebar_action) the page uses the
// panel's width instead of the popup's fixed one.
if(new URLSearchParams(location.search).get("mode")==="sidebar")document.documentElement.classList.add("sidebar");
const $=id=>document.getElementById(id);
const scan=$("scan"),rate=$("keyRate"),volume=$("volume"),volumeValue=$("volumeValue"),tradeStatus=$("tradeStatus"),steamApiSettings=$("steamApiSettings"),steamApiKey=$("steamApiKey"),saveSteamApiKey=$("saveSteamApiKey"),clearSteamApiKey=$("clearSteamApiKey"),steamApiKeyStatus=$("steamApiKeyStatus"),status=$("status"),results=$("results"),unverifiedResults=$("unverifiedResults"),tradersView=$("tradersView"),total=$("total"),checked=$("checked"),deals=$("deals");
const scanSaved=$("scanSaved"),savedList=$("savedList"),savedCount=$("savedCount"),clearSaved=$("clearSaved");
const boughtView=$("boughtView"),tabBought=$("tabBought");
const checkedView=$("checkedView"),tabChecked=$("tabChecked");
const scanNoSell=$("scanNoSell"),scanOffline=$("scanOffline"),tabReverse=$("tabReverse");
const tabs=[...document.querySelectorAll(".tab")];
const tabAll=$("tabAll"),tabFound=$("tabFound"),tabDeals=$("tabDeals"),tabUnverified=$("tabUnverified"),tabNotFound=$("tabNotFound"),tabDismissed=$("tabDismissed"),tabTraders=$("tabTraders");
let activeFilter="all";
let dismissedItems=new Set();
let traderHistory={};
let purchaseLog=[];
let checkedItems={};
let steamApiKeyConfigured=false;

const DEFAULT_VOLUME=0.4;

// The saved volume is reset to the 40% default once, so a previously saved
// louder value does not keep the sounds too loud.
api.storage.local.get({keyRate:63,dismissedItems:[],notificationVolume:DEFAULT_VOLUME,volumeDefaultApplied:false,tf2ArbTraderHistory:{},steamWebApiKey:""},v=>{
  rate.value=v.keyRate;
  let savedVolume=Number(v.notificationVolume);
  if(!v.volumeDefaultApplied||!Number.isFinite(savedVolume)){
    savedVolume=DEFAULT_VOLUME;
    api.storage.local.set({notificationVolume:DEFAULT_VOLUME,volumeDefaultApplied:true});
  }
  volume.value=Math.round(Math.max(0,Math.min(1,savedVolume))*100);
  volumeValue.textContent=`${volume.value}%`;
  send({type:"SET_VOLUME",volume:Number(volume.value)/100});
  dismissedItems=new Set(Array.isArray(v.dismissedItems)?v.dismissedItems:[]);
  traderHistory=v.tf2ArbTraderHistory&&typeof v.tf2ArbTraderHistory==="object"?v.tf2ArbTraderHistory:{};
  renderSteamApiKeyStatus(Boolean(String(v.steamWebApiKey||"").trim()));
  renderTraders();
});
function renderTradeAutomation(state){
  if(!state)return;
  const queued=Number(state.queued)||0;
  const lines=[];
  if(state.active){
    lines.push(`ACTIVE ITEM: ${state.active.name}`);
    lines.push(`WORKFLOW: ${String(state.active.step||"working").replace(/-/g," ")}`);
    if(Number.isFinite(Number(state.active.quantity)))lines.push(`VERIFIED TARGET: ${Number(state.active.quantity)} item${Number(state.active.quantity)===1?"":"s"} across ${Number(state.active.offerCount)||0} offer${Number(state.active.offerCount)===1?"":"s"}`);
    const siteName=state.active.source==="scrap.tf"?"scrap.tf":"STN";
    const siteUpper=siteName.toUpperCase();
    lines.push(`BUYING FROM: ${siteName}`);
    if(state.active.skipPurchase)lines.push(`PURCHASE MODE: ${siteName} skipped; using existing TF2 inventory`);
    if(Number(state.active.purchasedQuantity)>0)lines.push(`${siteUpper} ITEMS ACCEPTED: ${Number(state.active.purchasedQuantity)}/${Number(state.active.quantity)||0}`);
    if(state.active.purchaseOfferId)lines.push(`${siteUpper} STEAM OFFER: #${state.active.purchaseOfferId}`);
    const progress=state.active.purchaseProgress;
    if(progress){
      const phaseLabels={
        "steam-api-polling":"Waiting for Steam Web API state 3 (Accepted)",
        "steam-api-retrying":"Retrying Steam Web API request",
        "steam-api-offer-not-found":"Waiting for Steam Web API to return this offer",
        "steam-api-active":"State 2 — Active",
        "steam-api-mobile-confirmation-pending":"State 9 — CreatedNeedsConfirmation",
        "steam-api-in-escrow":"State 11 — InEscrow (not complete)",
        "steam-api-accepted":"State 3 — Accepted",
        "steam-api-state":"Steam Web API returned another trade state",
        "offer-page-loaded":"Offer opened; waiting for Steam controls",
        "waiting-for-contents-control":"Waiting for Confirm Trade Contents",
        "contents-confirmed":"Trade contents confirmed",
        "accept-control-ready":"Steam accept control is ready",
        "accept-clicked":"Accept clicked; waiting for Steam's update",
        "waiting-for-steam-status":"Waiting for Steam's offer status",
        "mobile-confirmation-pending":"Offer page suggests Steam Mobile confirmation is pending",
        "steam-accepted-observed":"Offer page indicates accepted; not yet API-verified",
        "steam-accepted":"Offer page says accepted; not yet API-verified",
        "acceptance-failed":"Offer page could not verify acceptance"
      };
      lines.push(`STEAM STATUS: ${phaseLabels[progress.phase]||progress.phase}`);
      if(progress.steamOfferState!==null&&progress.steamOfferState!==undefined){
        lines.push(`NUMERIC STATE: ${progress.steamOfferState}${progress.steamOfferStateName?` — ${progress.steamOfferStateName}`:""}`);
      }
      if(progress.evidence)lines.push(`EVIDENCE: ${progress.evidence}`);
      if(progress.source||progress.evidenceSource)lines.push(`SOURCE: ${progress.source||progress.evidenceSource}`);
      if(progress.updatedAt)lines.push(`UPDATED: ${new Date(progress.updatedAt).toLocaleTimeString()}`);
      const history=Array.isArray(progress.history)?progress.history.slice(-6):[];
      if(history.length){
        lines.push("STEAM TIMELINE:");
        for(const entry of history){
          const time=entry.updatedAt?new Date(entry.updatedAt).toLocaleTimeString():"";
          lines.push(`${time} ${phaseLabels[entry.phase]||entry.phase}`);
        }
      }
    }
    if(state.active.purchasePageProgress){
      const pageProgress=state.active.purchasePageProgress;
      const pageLabel=pageProgress.phase==="steam-accepted-observed"
        ?"Offer page reports accepted (secondary signal only)"
        :pageProgress.phase==="acceptance-failed"
          ?"Offer page could not verify acceptance (secondary signal only)"
          :String(pageProgress.phase||"page activity").replace(/-/g," ");
      lines.push(`OFFER PAGE SIGNAL: ${pageLabel}`);
    }
  }
  // The scan queue card shows what a running scan is doing; this box is only for trades (and for notices
  // while no scan runs), so it stays hidden when there is nothing to say.
  const message=state.message&&state.message!==state.active?.purchaseProgress?.message?state.message:"";
  if(state.active||queued>0){lines.push(`${queued} queued`);if(message)lines.push(message)}
  else if(!scanQueueRunning&&message)lines.push(message);
  tradeStatus.textContent=lines.join("\n");
  tradeStatus.hidden=!lines.length;
}
function renderSteamApiKeyStatus(configured,message){
  steamApiKeyConfigured=Boolean(configured);
  steamApiSettings.open=!steamApiKeyConfigured;
  clearSteamApiKey.disabled=!steamApiKeyConfigured;
  steamApiKeyStatus.className=`api-key-status ${steamApiKeyConfigured?"saved":""}`;
  steamApiKeyStatus.textContent=message||(
    steamApiKeyConfigured
      ?"A Steam Web API key is saved locally (hidden)."
      :"No key is saved. STN purchases require a key before QuickBuy."
  );
}
function setTradeAutomation(enabled){
  return send({type:"SET_TRADE_AUTOMATION",enabled}).then(response=>{
    if(response?.state)renderTradeAutomation(response.state);
    return response;
  });
}
function send(m){return new Promise(r=>api.runtime.sendMessage(m,r))}
function storageSetLocal(value){
  if(typeof browser!=="undefined")return browser.storage.local.set(value);
  return new Promise((resolve,reject)=>{
    try{
      api.storage.local.set(value,()=>{
        const error=api.runtime.lastError;
        if(error)reject(new Error(error.message));
        else resolve();
      });
    }catch(error){reject(error)}
  });
}
function storageRemoveLocal(key){
  if(typeof browser!=="undefined")return browser.storage.local.remove(key);
  return new Promise((resolve,reject)=>{
    try{
      api.storage.local.remove(key,()=>{
        const error=api.runtime.lastError;
        if(error)reject(new Error(error.message));
        else resolve();
      });
    }catch(error){reject(error)}
  });
}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
function itemKey(name){return String(name||"").trim().replace(/^the\s+/i,"").replace(/\s+/g," ").toLowerCase()}
function isDismissed(name){return dismissedItems.has(itemKey(name))}
async function saveDismissed(){await new Promise(r=>api.storage.local.set({dismissedItems:[...dismissedItems]},r))}

function renderUnverifiedOffers(r){
  const entries=(Array.isArray(r?.offerChecks)?r.offerChecks:[])
    .filter(entry=>(entry.verification?.status||"unverified")==="unverified");
  for(const entry of entries){
    const d=document.createElement("div");
    const key=itemKey(r.name);
    d.className="result unverified";
    d.dataset.category="unverified";
    d.dataset.key=key;
    const offerUrl=safeSteamTradeUrl(entry.verification?.url||entry.tradeUrl);
    const required=Number(entry.verification?.requiredRef);
    const unitPrice=Number(entry.verification?.unitPriceRef);
    const quantity=Number(entry.verification?.quantity??entry.quantity)||1;
    const listedPrice=entry.price&&typeof entry.price==="object"?entry.price.display:entry.price;
    const requiredLine=Number.isFinite(required)
      ?`<div class="line">${Number.isFinite(unitPrice)&&quantity>1?`Unit price: ${unitPrice.toFixed(2)} ref × ${quantity} = ${required.toFixed(2)} ref`:`Required metal: ${required.toFixed(2)} ref`}</div>`
      :(listedPrice?`<div class="line">Listed price: ${esc(listedPrice)}</div>`:"");
    d.innerHTML=`<div class="name">${esc(r.name)} — ${esc(entry.listingName||"Unknown trader")}</div>${requiredLine}<div class="line reason">${esc(entry.verification?.reason||"This profitable offer could not be verified.")}</div>${offerUrl?`<a class="offer-check-link" href="${esc(offerUrl)}" target="_blank" rel="noopener">Open exact offer</a>`:"<div class=\"small\">No usable Steam offer URL was found.</div>"}`;
    unverifiedResults.appendChild(d);
  }
}

function removeExistingCard(key){
  results.querySelectorAll(`.result[data-key="${CSS.escape(key)}"]`).forEach(x=>x.remove());
}
// A reverse-scan result: what STN pays for the item against the cheapest sell
// listings on Backpack.tf (buy there, sell to STN).
function reverseCardHtml(r){
  if(r.skipped)return `<div class="line reason">${esc(r.reason)}</div>`;
  const profit=Number(r.profitRef)||0;
  if(r.scrapToStn){
    const scrapLink=safeWebUrl(r.sourceItem?.href);
    return `<div class="line">Buy on scrap.tf: ${esc(r.scrapPrice?.display||r.sourceItem?.price||"?")}</div>`+
      `<div class="line">STN pays: ${esc(r.stnPrice?.display||"?")} · STN will buy ${Number(r.stnCapacity)||0} more</div>`+
      `<div class="line ${r.reverseDeal?"profit":"lossText"}">${profit>=0?"+":""}${profit.toFixed(2)} ref${r.reverseDeal?" (buy on scrap.tf, sell to STN)":" (not profitable)"}</div>`+
      (scrapLink?`<div class="market-actions"><a class="market-link" href="${esc(scrapLink)}" target="_blank" rel="noopener">Open scrap.tf</a></div>`:"");
  }
  const note=r.reverseDeal?" (buy on Backpack.tf, sell to STN)":(r.humanOnly?" (only non-bot sellers listed)":" (not profitable)");
  let html=`<div class="line">Buy on Backpack.tf: ${esc(r.bpPrice?.display||"?")}${r.bestListing?.listingName?` — ${esc(r.bestListing.listingName)}`:""}</div>`+
    `<div class="line">STN pays: ${esc(r.stnPrice?.display||"?")} · STN will buy ${Number(r.stnCapacity)||0} more</div>`+
    `<div class="line ${r.reverseDeal?"profit":"lossText"}">${profit>=0?"+":""}${profit.toFixed(2)} ref${note}</div>`+
    `<div class="line listing-count">Sell listings seen: <strong>${Number(r.sellListingCount)||0}</strong> · from bots: ${Number(r.botSellListingCount)||0}</div>`;
  if(r.cheaperHumanPrice)html+=`<div class="small">A non-bot seller lists it for ${esc(r.cheaperHumanPrice)} (would need negotiating by hand).</div>`;
  const rows=(Array.isArray(r.sellListings)?r.sellListings:[]).map(entry=>{
    const link=safeSteamTradeUrl(entry.tradeUrl);
    return `<div class="small">${esc(entry.price)} — ${esc(entry.listingName||"unknown")} (${entry.botLike?"bot":"trader"})${link?` <a class="offer-check-link" href="${esc(link)}" target="_blank" rel="noopener">Open offer</a>`:""}</div>`;
  }).join("");
  if(rows)html+=`<div class="debug-title">Cheapest sell listings:</div>${rows}`;
  const backpack=safeWebUrl(r.backpackUrl);
  if(backpack)html+=`<div class="market-actions"><a class="market-link" href="${esc(backpack)}" target="_blank" rel="noopener">Open Backpack.tf listings</a></div>`;
  return html;
}
function categoryOf(r){
  if(r.alreadyChecked)return "checked";
  if(r.reverse)return r.reverseDeal?"reverse":(r.skipped?"notfound":"found");
  return r.skipped?"notfound":(r.deal?"deal":"found");
}
function renderResult(r,prepend=true){
  if(!r)return;
  const key=itemKey(r.name);
  const resultId=String(r.resultId||`${key}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`);
  const d=document.createElement("div");
  const dismissed=isDismissed(r.name);
  const category=dismissed?"dismissed":categoryOf(r);
  d.className="result "+(dismissed?"dismissed":(r.alreadyChecked?"skip already-checked":(r.skipped?"skip":((r.deal||r.reverseDeal)?"deal":"loss"))));
  d.dataset.category=category;
  d.dataset.key=key;
  d.dataset.resultId=resultId;
  const source=r.sourceItem||{};
  const attempts=Array.isArray(r.attempts)?r.attempts:[];
  const offerChecks=Array.isArray(r.offerChecks)?r.offerChecks:[];
  const verifiedOfferCount=offerChecks.filter(entry=>entry.verification?.status==="sufficient").length;
  let html=`<div class="result-top"><div class="name">${esc(r.name)}${sourceBadge(r.source||r.sourceItem?.source)}${r.alreadyChecked?' <span class="checked-badge" title="Checked recently; scans skip this item for 60 minutes after a check unless its price changes">Already checked</span>':""}</div><button class="dismiss-item" title="Dismiss this item">${dismissed?"Restore":"Dismiss"}</button></div>`;
  if(r.reverse){
    html+=reverseCardHtml(r);
  }else if(r.skipped){
    html+=`<div class="line reason">${esc(r.reason)}</div>`;
  }else{
    const displaySell=r.deal?r.sellPrice:(r.pricePotentialSellPrice||r.sellPrice);
    const displayProfit=r.deal?r.profitRef:Number(r.pricePotentialProfitRef??r.profitRef);
    const dealLabel=r.verificationOverride
      ?"(multiple price-profitable listings; verification override)"
      :(r.deal?"(metal verified)":(r.unverifiedDeal?"(profitable listing; inventory not verified)":""));
    html+=`<div class="line">Buy: ${esc(r.buyPrice.display)}</div><div class="line">Backpack.tf: ${esc(displaySell.display)}</div><div class="line ${r.deal?"profit":(r.unverifiedDeal?"reason":"lossText")}">${displayProfit>=0?"+":""}${displayProfit.toFixed(2)} ref ${dealLabel}</div><div class="line listing-count">Price-profitable bot listings: <strong>${Number(r.profitableListingCount||0)}</strong> · verified: ${Number(r.verifiedProfitableListingCount||0)} · unverified: ${Number(r.unverifiedListingCount||0)} · insufficient: ${Number(r.insufficientListingCount||0)}${Number(r.badTraderListingCount||0)?` · bad traders: ${Number(r.badTraderListingCount)}`:""}${Number(r.alreadyTradingListingCount||0)?` · already trading: ${Number(r.alreadyTradingListingCount)}`:""} · item capacity: ${Number(r.priceProfitableItemCount||0)} · verified item capacity: ${Number(r.verifiedProfitableItemCount||0)}</div><div class="small">Best buyer: ${esc(r.bestListing?.listingName||"unknown")}</div>`;
    if(offerChecks.length){
      html+=`<div class="offer-checks"><div class="debug-title">Checked profitable offers:</div>`;
      offerChecks.forEach(entry=>{
        const state=entry.verification?.status||"unverified";
        const label=state==="sufficient"?"Verified — enough metal":state==="insufficient"?"Checked — insufficient metal":state==="bad-trader"?`Bad trader — already holds ${Number(entry.verification?.ownedCopies)||0} (limit ${Number(entry.verification?.wantedCopies)||1})`:state==="already-trading"?`Already trading — ${Number(entry.verification?.alreadyTradingQuantity)||0} of ${Number(entry.verification?.requestedQuantity)||1} already in offers`:"Not verified";
        const quantity=Number(entry.verification?.quantity??entry.quantity)||1;
        const unitPrice=Number(entry.verification?.unitPriceRef);
        const offerUrl=safeSteamTradeUrl(entry.verification?.url||entry.tradeUrl);
        const metalLine=entry.verification?.offeredRef!==undefined
          ?` (${Number(entry.verification.offeredRef).toFixed(2)} ref / ${Number(entry.verification.requiredRef).toFixed(2)} ref required${quantity>1&&Number.isFinite(unitPrice)?` for ${quantity}× at ${unitPrice.toFixed(2)} each`:""})`
          :"";
        html+=`<div class="offer-check ${esc(state)}"><strong>${esc(entry.listingName||"Unknown trader")}</strong> — ${esc(label)}${metalLine}${entry.verification?.reason?`<div class="small">${esc(entry.verification.reason)}</div>`:""}${offerUrl?`<a class="offer-check-link" href="${esc(offerUrl)}" target="_blank" rel="noopener">Open exact offer</a>`:""}</div>`;
      });
      if(Number(r.skippedListingCount||0)){
        html+=`<div class="small">Stopped after ${verifiedOfferCount} verified trade${verifiedOfferCount===1?"":"s"} (STN stock plus one spare); ${Number(r.skippedListingCount)} lower-priced offer${Number(r.skippedListingCount)===1?"":"s"} not checked.</div>`;
      }
      html+=`</div>`;
    }
  }
  if(source.href)html+=`<div class="market-actions"><a class="market-link" href="${esc(source.href)}" target="_blank" rel="noopener">${source.source==="scrap.tf"?"Open scrap.tf (buy hats)":"Open STN marketplace"}</a></div>`;
  if(r.deal){
    html+=`<div class="market-actions trade-actions"><button class="market-action-button open-backpack-verified"${verifiedOfferCount?"":' disabled'}>Backpack.tf — highlight ${verifiedOfferCount} verified</button><button class="market-action-button force-auto-trade"${verifiedOfferCount?"":' disabled title="No offer was verified to have enough metal"'}>Auto trade (skip STN)</button></div>`;
  }
  if(attempts.length){
    html+=`<div class="debug-title">Backpack.tf:</div>`;
    attempts.forEach((a)=>{
      html+=`<div class="debug-link"><a class="open-link" href="${esc(a.url)}" target="_blank" rel="noopener">Open link</a><span class="debug-status">${esc(a.source)} — ${esc(a.status||"checked")}</span></div>`;
    });
  }
  if(source.name)html+=`<button class="retry-item" data-item="${esc(JSON.stringify(source))}">Retry this item</button>`;
  d.innerHTML=html;

  const dismiss=d.querySelector(".dismiss-item");
  dismiss.onclick=async()=>{
    if(isDismissed(r.name)){
      dismissedItems.delete(key);
      await saveDismissed();
      dismiss.textContent="Dismiss";
      d.classList.remove("dismissed");
      d.dataset.category=categoryOf(r);
    }else{
      dismissedItems.add(key);
      await saveDismissed();
      dismiss.textContent="Restore";
      d.classList.add("dismissed");
      d.dataset.category="dismissed";
    }
    updateTabCounts();
    applyFilter();
  };

  const retry=d.querySelector(".retry-item");
  if(retry)retry.onclick=async()=>{
    let item;try{item=JSON.parse(retry.dataset.item)}catch(e){return}
    const response=await send({type:"RETRY_ITEM",item});
    retry.textContent=response?.ok?"Queued!":"Retry failed";
    if(response?.ok)retry.disabled=true;
  };
  const backpackButton=d.querySelector(".open-backpack-verified");
  if(backpackButton)backpackButton.onclick=async()=>{
    backpackButton.disabled=true;
    backpackButton.textContent="Opening verified Backpack.tf pages…";
    const response=await send({type:"OPEN_VERIFIED_BACKPACK_PAGES",result:r});
    if(response?.ok){
      backpackButton.textContent=`Opened ${response.pages} page${response.pages===1?"":"s"} · highlighted ${response.highlighted}/${verifiedOfferCount}`;
      const issues=[...(response.missing||[]),...(response.errors||[])];
      if(issues.length)backpackButton.title=`Some verified listings need attention: ${issues.join("; ")}`;
    }else{
      backpackButton.disabled=false;
      backpackButton.textContent="Backpack.tf — highlight verified";
      backpackButton.title=response?.error||"Could not open the verified Backpack.tf listings.";
    }
  };
  const forceTradeButton=d.querySelector(".force-auto-trade");
  if(forceTradeButton)forceTradeButton.onclick=async()=>{
    forceTradeButton.disabled=true;
    forceTradeButton.textContent="Queuing skip-STN trade…";
    const response=await send({type:"FORCE_VERIFIED_AUTO_TRADE",result:r});
    if(response?.ok){
      forceTradeButton.textContent=`Queued ${response.offerCount} offers / ${response.quantity} existing items`;
    }else{
      forceTradeButton.disabled=false;
      forceTradeButton.textContent="Auto trade (skip STN)";
      forceTradeButton.title=response?.reason||"Could not queue an auto trade from verified offers.";
    }
  };
  if(prepend)results.prepend(d); else results.appendChild(d);
  renderUnverifiedOffers(r);
  updateTabCounts();
  applyFilter();
}
function updateTabCounts(){
  const cards=[...results.querySelectorAll(".result")];
  const found=cards.filter(x=>x.dataset.category==="found"||x.dataset.category==="deal").length;
  const good=cards.filter(x=>x.dataset.category==="deal").length;
  const notfound=cards.filter(x=>x.dataset.category==="notfound").length;
  const dismissed=cards.filter(x=>x.dataset.category==="dismissed").length;
  tabReverse.textContent=String(cards.filter(x=>x.dataset.category==="reverse").length);
  tabAll.textContent=cards.length-dismissed;
  tabFound.textContent=found;
  tabDeals.textContent=good;
  tabUnverified.textContent=[...unverifiedResults.querySelectorAll(".result")].filter(x=>!isDismissed(x.dataset.key)).length;
  tabNotFound.textContent=notfound;
  tabDismissed.textContent=dismissed;
  tabTraders.textContent=String(Object.values(traderHistory).filter(entry=>Number(entry?.count)>0).length);
  tabBought.textContent=String(boughtTotals().total);
  tabChecked.textContent=String(checkedEntries().length);
}
function applyFilter(){
  const showTraders=activeFilter==="traders";
  const showUnverified=activeFilter==="unverified";
  const showBought=activeFilter==="bought";
  const showChecked=activeFilter==="checked";
  results.hidden=showTraders||showUnverified||showBought||showChecked;
  unverifiedResults.hidden=showTraders||showBought||showChecked||!showUnverified;
  tradersView.hidden=!showTraders;
  boughtView.hidden=!showBought;
  checkedView.hidden=!showChecked;
  if(showTraders||showUnverified||showBought||showChecked){
    unverifiedResults.querySelectorAll(".result").forEach(card=>{
      card.style.display=isDismissed(card.dataset.key)?"none":"";
    });
    return;
  }
  results.querySelectorAll(".result").forEach(card=>{
    const c=card.dataset.category;
    const visible=activeFilter==="all"
      ? c!=="dismissed"
      : activeFilter==="found" ? (c==="found"||c==="deal")
      : activeFilter==="dismissed" ? c==="dismissed"
      : c===activeFilter;
    card.style.display=visible?"":"none";
  });
}
tabs.forEach(tab=>tab.onclick=()=>{
  activeFilter=tab.dataset.filter;
  tabs.forEach(x=>x.classList.toggle("active",x===tab));
  applyFilter();
});

function safeWebUrl(value){
  try{
    const url=new URL(String(value||""));
    return url.protocol==="https:"||url.protocol==="http:"?url.href:"";
  }catch(e){return ""}
}
function safeSteamTradeUrl(value){
  try{
    const url=new URL(String(value||""));
    return url.protocol==="https:"&&url.hostname==="steamcommunity.com"&&/^\/tradeoffer\/new\/?$/i.test(url.pathname)
      ?url.href
      :"";
  }catch(e){return ""}
}
function renderTraders(){
  if(!tradersView)return;
  const entries=Object.entries(traderHistory||{})
    .map(([id,entry])=>({id,...entry,count:Number(entry?.count)||0}))
    .filter(entry=>entry.count>0)
    .sort((a,b)=>b.count-a.count||String(a.traderName||"").localeCompare(String(b.traderName||"")));
  if(!entries.length){
    tradersView.innerHTML='<div class="trader-empty">No traders marked yet. Use “Mark traded” on a Backpack.tf Buy Order to start a history.</div>';
    updateTabCounts();
    return;
  }
  tradersView.innerHTML=entries.map(entry=>{
    const avatar=safeWebUrl(entry.avatarUrl);
    const profile=safeWebUrl(entry.profileUrl);
    const name=esc(entry.traderName||"Unknown trader");
    const picture=avatar
      ? `<img class="trader-avatar" src="${esc(avatar)}" alt="" loading="lazy">`
      : `<div class="trader-avatar trader-avatar-fallback">${esc(String(entry.traderName||"?").trim().slice(0,1).toUpperCase())}</div>`;
    const linkedName=profile
      ? `<a href="${esc(profile)}" target="_blank" rel="noopener">${name}</a>`
      : `<span>${name}</span>`;
    const last=Number(entry.lastTradedAt);
    const when=Number.isFinite(last)&&last>0?new Date(last).toLocaleDateString():"";
    return `<div class="trader-card">${picture}<div class="trader-details"><strong>${linkedName}</strong><span>${entry.count} marked ${entry.count===1?"trade":"trades"}</span>${when?`<small>Last marked: ${esc(when)}</small>`:""}</div></div>`;
  }).join("");
  updateTabCounts();
}

function hydrate(state){
  results.innerHTML=""; unverifiedResults.innerHTML=""; checked.textContent=String(state?.checked||0); total.textContent=String(state?.total||0);
  let dealCount=0;
  const history=Array.isArray(state?.results)?state.results:[];
  for(const r of history){renderResult(r,false);if((r.deal||r.reverseDeal)&&!isDismissed(r.name))dealCount++;}
  deals.textContent=String(dealCount);
  updateTabCounts();
  applyFilter();
  if(state?.running) status.textContent=`Checking ${state.checked||0} / ${state.total||0} items...`;
  else if(state?.finished) status.textContent=`Finished: ${state.checked||0} / ${state.total||0} items checked — ${dealCount} hits found.`;
  else if(state?.checked) status.textContent=`Paused/stopped: ${state.checked} / ${state.total} checked — ${dealCount} hits found.`;
  else status.textContent="Open stntrading.eu and/or scrap.tf/buy/hats first (both are scanned together).";
}

(async()=>{
  const r=await send({type:"GET_STATE"});
  if(r?.version) $("version").textContent=`v${r.version}`;
  if(r?.state) hydrate(r.state);
  if(r?.tradeAutomation)renderTradeAutomation(r.tradeAutomation);
  renderScanQueue(r?.scanQueue);
  applyScanMode(r?.scanMode||null);
})();

saveSteamApiKey.onclick=async()=>{
  const key=steamApiKey.value.trim();
  if(!/^[0-9a-f]{32}$/i.test(key)){
    steamApiKeyStatus.className="api-key-status error";
    steamApiKeyStatus.textContent="Enter a valid 32-character hexadecimal Steam Web API key.";
    steamApiKey.focus();
    return;
  }
  saveSteamApiKey.disabled=true;
  try{
    await storageSetLocal({steamWebApiKey:key});
    steamApiKey.value="";
    renderSteamApiKeyStatus(true,"Steam Web API key saved locally (hidden). It will be used only for direct Steam offer-state checks.");
    steamApiSettings.open=true;
  }catch(error){
    steamApiKeyStatus.className="api-key-status error";
    steamApiKeyStatus.textContent=`Could not save the Steam Web API key: ${error?.message||error}`;
  }finally{
    saveSteamApiKey.disabled=false;
  }
};

clearSteamApiKey.onclick=async()=>{
  clearSteamApiKey.disabled=true;
  try{
    await storageRemoveLocal("steamWebApiKey");
    steamApiKey.value="";
    renderSteamApiKeyStatus(false,"Saved key removed. STN purchase verification requires a key before QuickBuy.");
  }catch(error){
    steamApiKeyStatus.className="api-key-status error";
    steamApiKeyStatus.textContent=`Could not remove the saved Steam Web API key: ${error?.message||error}`;
    clearSteamApiKey.disabled=!steamApiKeyConfigured;
  }
};

// ---- Stay signed in (cookie-keeper.js reads this setting) ----------------
const scrapSkipCraft=$("scrapSkipCraft");
api.storage.local.get({scrapSkipCraft:true},v=>{scrapSkipCraft.checked=v.scrapSkipCraft!==false});
scrapSkipCraft.onchange=()=>{storageSetLocal({scrapSkipCraft:scrapSkipCraft.checked}).catch(()=>{})};
const stnAutoRescan=$("stnAutoRescan");
api.storage.local.get({stnAutoRescan:true},v=>{stnAutoRescan.checked=v.stnAutoRescan!==false});
stnAutoRescan.onchange=()=>{storageSetLocal({stnAutoRescan:stnAutoRescan.checked}).catch(()=>{})};
const keepLogins=$("keepLogins");
api.storage.local.get({keepLogins:true},v=>{keepLogins.checked=v.keepLogins!==false});
keepLogins.onchange=()=>{storageSetLocal({keepLogins:keepLogins.checked}).catch(()=>{})};

// ---- Mac confirmer settings ---------------------------------------------
const macUrl=$("macUrl"),macToken=$("macToken"),macEnabled=$("macEnabled"),saveMac=$("saveMac"),testMac=$("testMac"),macStatus=$("macStatus"),macSettings=$("macSettings");
let macTokenSaved=false;
function showMacStatus(message,kind=""){
  macStatus.className=`api-key-status ${kind}`;
  macStatus.textContent=message;
}
function normalizedMacUrl(){
  return macUrl.value.trim().replace(/\/+$/,"");
}
function loadMacSettings(){api.storage.local.get({macConfirmer:{}},v=>{
  const saved=v.macConfirmer||{};
  macUrl.value=saved.url||"";
  macEnabled.checked=Boolean(saved.enabled);
  macTokenSaved=Boolean(saved.token);
  macToken.placeholder=macTokenSaved?"Saved (hidden). Type to replace.":"";
  if(saved.url&&macTokenSaved)showMacStatus(saved.enabled?"Enabled.":"Saved but switched off.","saved");
})}
loadMacSettings();
// The launcher fills these in shortly after the browser starts.
api.storage.onChanged.addListener((changes,area)=>{if(area==="local"&&changes.macConfirmer)loadMacSettings()});
saveMac.onclick=async()=>{
  const url=normalizedMacUrl();
  const token=macToken.value.trim()||(macTokenSaved?(await new Promise(r=>api.storage.local.get({macConfirmer:{}},v=>r(v.macConfirmer?.token||"")))):"");
  if(!/^https?:\/\/[^\s/]+(:\d+)?$/i.test(url)){
    showMacStatus("Enter the address like http://192.168.1.50:8765","error");
    macUrl.focus();
    return;
  }
  if(!token){
    showMacStatus("Enter the token the Mac server printed when it started.","error");
    macToken.focus();
    return;
  }
  try{
    await storageSetLocal({macConfirmer:{enabled:macEnabled.checked,url,token}});
    macToken.value="";
    macTokenSaved=true;
    macToken.placeholder="Saved (hidden). Type to replace.";
    showMacStatus(macEnabled.checked?"Saved. Bot offers waiting for confirmation will be sent to the Mac.":"Saved, but switched off.","saved");
  }catch(error){
    showMacStatus(`Could not save: ${error?.message||error}`,"error");
  }
};
testMac.onclick=async()=>{
  const url=normalizedMacUrl();
  const token=macToken.value.trim()||(macTokenSaved?(await new Promise(r=>api.storage.local.get({macConfirmer:{}},v=>r(v.macConfirmer?.token||"")))):"");
  if(!url){showMacStatus("Enter the Mac server address first.","error");return}
  testMac.disabled=true;
  showMacStatus("Connecting…");
  const call=async path=>{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),6000);
    try{
      const response=await fetch(`${url}${path}`,{headers:{"X-Confirm-Token":token},cache:"no-store",credentials:"omit",signal:controller.signal});
      return {status:response.status,payload:await response.json().catch(()=>({}))};
    }finally{clearTimeout(timer)}
  };
  try{
    const ping=await call("/ping");
    if(ping.status!==200)throw new Error(`the server answered HTTP ${ping.status}`);
    const state=await call("/status");
    if(state.status===401)return showMacStatus("The Mac server is reachable, but it rejected the token.","error");
    if(state.status!==200)throw new Error(state.payload?.error||`HTTP ${state.status}`);
    const s=state.payload;
    showMacStatus(
      `Connected${s.dryRun?" (dry run: no clicks)":""}. ${s.paused?`PAUSED: ${s.paused}`:s.busy?"Busy accepting a trade.":"Idle."} `+
      `${s.waiting} waiting, ${s.confirmedLastHour}/${s.hourlyLimit} confirmed in the last hour.`,
      s.paused?"error":"saved"
    );
  }catch(error){
    showMacStatus(
      error?.name==="AbortError"
        ?"No answer within 6 seconds. Check the Mac's IP address, that the server is running, and the Mac firewall."
        :`Could not reach the Mac server: ${error?.message||error}`,
      "error"
    );
  }finally{
    testMac.disabled=false;
  }
};

volume.oninput=()=>{
  const v=Math.max(0,Math.min(100,Number(volume.value)||0));
  volumeValue.textContent=`${v}%`;
  api.storage.local.set({notificationVolume:v/100});
  send({type:"SET_VOLUME",volume:v/100});
};

// The three scan buttons each have their own pair of site checkboxes (both ticked by default); the
// choice is remembered.
const SCAN_SITE_BOXES={
  scan:{stn:$("scanPagesStn"),scrap:$("scanPagesScrap")},
  scanNoSell:{stn:$("noSellStn"),scrap:$("noSellScrap")},
  scanOffline:{stn:$("offlineStn"),scrap:$("offlineScrap")}
};
api.storage.local.get({scanSiteChoices:{}},v=>{
  const saved=v.scanSiteChoices||{};
  for(const [mode,boxes] of Object.entries(SCAN_SITE_BOXES)){
    if(saved[mode]){boxes.stn.checked=saved[mode].stn!==false;boxes.scrap.checked=saved[mode].scrap!==false}
  }
});
for(const boxes of Object.values(SCAN_SITE_BOXES)){
  for(const box of [boxes.stn,boxes.scrap]){
    box.onchange=()=>{
      const choices={};
      for(const [mode,pair] of Object.entries(SCAN_SITE_BOXES))choices[mode]={stn:pair.stn.checked,scrap:pair.scrap.checked};
      storageSetLocal({scanSiteChoices:choices}).catch(()=>{});
    };
  }
}
function sitesFor(mode){
  const {stn,scrap}=SCAN_SITE_BOXES[mode];
  return stn.checked&&scrap.checked?"all":stn.checked?"stn":scrap.checked?"scrap.tf":null;
}
function scanClicked(button,mode,extra={}){
  const scanMode={scan:"pages",scanNoSell:"noSell",scanOffline:"offline"}[mode];
  // The running scan's own button is its Stop button: clicking it again ends the scan.
  if(activeScanMode){
    if(activeScanMode===scanMode)clickFeedback(button,stopScanClicked());
    return;
  }
  const sites=sitesFor(mode);
  if(!sites){status.textContent="Tick at least one website (stntrading.eu or scrap.tf) next to this button.";return}
  clickFeedback(button,startScan("START_SCAN",{...extra,sites},scanMode));
}
scan.onclick=()=>scanClicked(scan,"scan");
scanNoSell.onclick=()=>scanClicked(scanNoSell,"scanNoSell",{noSell:true});
scanOffline.onclick=()=>scanClicked(scanOffline,"scanOffline",{offline:true});

// Which scan is running: its button is highlighted and says so (clicking it again stops the scan), every
// other scan button (and the site boxes) is switched off until the scan is stopped or ends, so only one
// scan runs at a time.
// background.js is the source of truth (it also rejects a second scan).
let activeScanMode=null;
let savedEntryCount=0;
const SCAN_BUTTONS=[
  {mode:"pages",button:scan,label:()=>"Scan Pages"},
  {mode:"noSell",button:scanNoSell,label:()=>"Scan No Sell"},
  {mode:"offline",button:scanOffline,label:()=>"Scan Offline"},
  {mode:"saved",button:scanSaved,label:()=>`Check saved items (${savedEntryCount})`}
];
function refreshScanButtons(){
  for(const entry of SCAN_BUTTONS){
    const active=activeScanMode===entry.mode;
    entry.button.classList.toggle("scan-active",active);
    entry.button.disabled=!active&&(activeScanMode!==null||(entry.mode==="saved"&&!savedEntryCount));
    entry.button.textContent=active?`${entry.label()} — running… (click to stop)`:entry.label();
    entry.button.title=entry.button.title.replace(/^RUNNING NOW \(click to stop\) — /,"");
    if(active)entry.button.title=`RUNNING NOW (click to stop) — ${entry.button.title}`;
  }
  for(const boxes of Object.values(SCAN_SITE_BOXES)){boxes.stn.disabled=boxes.scrap.disabled=activeScanMode!==null}
}
function applyScanMode(mode){activeScanMode=mode||null;refreshScanButtons()}
let scanModeSyncTimer=0;
function syncScanMode(){
  clearTimeout(scanModeSyncTimer);
  scanModeSyncTimer=setTimeout(()=>send({type:"GET_SCAN_MODE"}).then(r=>applyScanMode(r?.mode||null)).catch(()=>{}),250);
}
// Click feedback done in the popup itself: a pulse ring right after the click and, while the
// request is being answered, a light sweep across the button.
function clickFeedback(button,work){
  button.classList.remove("btn-pulse");
  void button.offsetWidth;
  button.classList.add("btn-pulse");
  setTimeout(()=>button.classList.remove("btn-pulse"),700);
  if(!work)return;
  button.classList.add("btn-busy");
  Promise.resolve(work).catch(()=>{}).finally(()=>setTimeout(()=>button.classList.remove("btn-busy"),350));
}
scanSaved.onclick=()=>{
  if(activeScanMode){
    if(activeScanMode==="saved")clickFeedback(scanSaved,stopScanClicked());
    return;
  }
  clickFeedback(scanSaved,startScan("START_SAVED_SCAN",{},"saved"));
};
async function startScan(type,extra={},mode=null){
  api.storage.local.set({keyRate:+rate.value||63});
  // There is no on/off checkbox any more: scans trade automatically once a Steam Web API key is saved
  // (Scan Offline never trades, whatever is sent here). Without a key a scan only finds and saves Good Trades.
  const r=await send({...extra,type,keyRate:+rate.value||63,notificationVolume:(Number(volume.value)||0)/100,autoTradesEnabled:steamApiKeyConfigured});
  if(!r?.ok){status.textContent=r?.error||"Could not start scan.";syncScanMode();return}
  if(!steamApiKeyConfigured&&mode!=="offline"){
    tradeStatus.textContent="No Steam Web API key is saved, so this scan only finds and saves Good Trades. Nothing is bought until you save a key (Steam Web API key section).";
    tradeStatus.hidden=false;
  }
  if(mode)applyScanMode(mode);
  results.innerHTML="";
  unverifiedResults.innerHTML="";
  activeFilter="all"; tabs.forEach(x=>x.classList.toggle("active",x.dataset.filter==="all"));
  applyFilter();
  updateTabCounts();
  checked.textContent=String(r.alreadyChecked||0);
  deals.textContent="0";
  total.textContent=r.total;
  const sourceText=Object.entries(r.sources||{}).map(([name,count])=>name==="stn-reverse"?`${count} STN buy-price checks`:`${count} from ${name==="scrap.tf"?"scrap.tf":"STN"}`).join(", ");
  status.textContent=`Checking ${r.alreadyChecked||0} / ${r.total} items${sourceText?` (${sourceText})`:""}${r.alreadyChecked?`, ${r.alreadyChecked} already checked in the last 60 minutes and skipped`:""}...`;
}
async function stopScanClicked(){await send({type:"STOP_SCAN"});applyScanMode(null);renderScanQueue(null);status.textContent=`Stopped at ${checked.textContent} / ${total.textContent}. Progress saved.`}

api.runtime.onMessage.addListener(async m=>{
  if(m.type==="TRADE_AUTOMATION_STATUS"){
    renderTradeAutomation(m.state);
    syncScanMode();
  }
  if(m.type==="OFFER_CHECK_PROGRESS"){
    status.textContent=`Checking profitable offer ${m.checked} / ${m.total} for ${m.itemName} — ${m.traderName}`;
  }
  if(m.type==="SCAN_RESULT"){
    checked.textContent=m.checked;
    renderResult(m.result,true);
    if((m.result.deal||m.result.reverseDeal)&&!isDismissed(m.result.name)) deals.textContent=+deals.textContent+1;
    status.textContent=`${m.checked} / ${m.total} checked`;
  }
  if(m.type==="SCAN_QUEUE")renderScanQueue(m.queue);
  if(m.type==="SCAN_FINISHED"){
    renderScanQueue(null);
    status.textContent=`Finished: ${m.checked} / ${m.total} items checked.`;
    syncScanMode();
  }
});

api.storage.onChanged?.addListener((changes,area)=>{
  if(area!=="local"||!changes.tf2ArbTraderHistory)return;
  const value=changes.tf2ArbTraderHistory.newValue;
  traderHistory=value&&typeof value==="object"?value:{};
  renderTraders();
});

// ---- Saved Good Trades (the local database kept by background.js) -----------
const SAVED_KEY="savedTrades";
let savedTrades={};
function stnItemUrl(name){return `https://stntrading.eu/item/tf2/${encodeURIComponent(String(name||"").trim()).replace(/%20/g,"+")}`}
function savedStatusText(entry){
  const when=entry.lastCheckedAt?new Date(entry.lastCheckedAt).toLocaleString():"";
  if(entry.lastStatus==="good")return entry.lastCheckedAt?`Still a Good Trade (${when})`:"Good Trade when saved";
  if(entry.lastStatus==="not-good")return `Not a Good Trade when checked ${when}`;
  if(entry.lastStatus==="skipped")return `Could not check (${when}): ${entry.lastNote||"skipped"}`;
  return "";
}
function renderSaved(){
  const entries=Object.values(savedTrades).filter(entry=>entry&&entry.name).sort((a,b)=>Math.max(b.lastGoodAt||0,b.lastBoughtAt||0)-Math.max(a.lastGoodAt||0,a.lastBoughtAt||0));
  savedCount.textContent=String(entries.length);
  savedEntryCount=entries.length;
  refreshScanButtons();
  clearSaved.disabled=!entries.length;
  savedList.innerHTML=entries.length?"":`<div class="hint">Nothing saved yet.</div>`;
  for(const entry of entries){
    const row=document.createElement("div");
    row.className="saved-row";
    const profit=Number.isFinite(entry.profitRef)?` · +${entry.profitRef.toFixed(2)} ref`:"";
    const savedLink=entry.source==="scrap.tf"?(safeWebUrl(entry.sourceHref)||"https://scrap.tf/buy/hats"):stnItemUrl(entry.name);
    row.innerHTML=`<div class="saved-name"><span><a href="${esc(savedLink)}" target="_blank" rel="noopener">${esc(entry.name)}</a>${sourceBadge(entry.source==="scrap.tf"?"scrap.tf":"stn")}${Number(entry.boughtCount)>0?` <span class="bought-badge" title="Hats the bot bought of this item">Bought ×${Math.floor(Number(entry.boughtCount))}</span>`:""}</span><button class="secondary saved-remove" type="button" title="Remove from the saved items">Remove</button></div>`+
      `<div class="line">Buy ${esc(entry.buyPrice||"?")} → sell ${esc(entry.sellPrice||"?")}${esc(profit)}</div>`+
      `<div class="line reason">${esc(savedStatusText(entry))}</div>`;
    row.querySelector(".saved-remove").onclick=()=>{
      delete savedTrades[String(entry.name).trim().replace(/\s+/g," ").toLowerCase()];
      renderSaved();
      api.storage.local.set({[SAVED_KEY]:savedTrades});
    };
    savedList.appendChild(row);
  }
}
clearSaved.onclick=()=>{
  if(!window.confirm("Remove every saved item?"))return;
  savedTrades={};
  renderSaved();
  api.storage.local.set({[SAVED_KEY]:savedTrades});
};
api.storage.local.get({[SAVED_KEY]:{}},v=>{savedTrades=v[SAVED_KEY]&&typeof v[SAVED_KEY]==="object"?v[SAVED_KEY]:{};renderSaved()});
api.storage.onChanged?.addListener((changes,area)=>{
  if(area!=="local"||!changes[SAVED_KEY])return;
  const value=changes[SAVED_KEY].newValue;
  savedTrades=value&&typeof value==="object"?value:{};
  renderSaved();
});

// ---- Source badge and the Bought tab -----------------------------------------
function sourceLabel(source){return source==="scrap.tf"?"scrap.tf":"STN"}
function sourceSite(source){return source==="scrap.tf"?"scrap.tf":"stntrading.eu"}
// The queue card: which hat is being checked, from which website, where it is in the queue, and what comes next.
const scanQueueBox=$("scanQueue");
let scanQueueRunning=false;
function renderScanQueue(q){
  scanQueueRunning=Boolean(q&&q.running);
  if(!scanQueueRunning){scanQueueBox.hidden=true;scanQueueBox.textContent="";return}
  const done=Number(q.checked)||0,all=Number(q.total)||0,percent=all?Math.min(100,Math.round(done/all*100)):0;
  const cur=q.current;
  let html=`<div class="queue-head"><b>Scan queue</b><span>${done} of ${all} checked</span></div><div class="queue-bar"><i style="width:${percent}%"></i></div>`;
  if(cur){
    html+=`<div class="queue-now"><div class="queue-label">Now checking</div><div class="queue-name">${esc(cur.name)}${sourceBadge(cur.source)}</div>`+
      `<div class="queue-line">From <b>${esc(sourceSite(cur.source))}</b> · place <b>${cur.position}</b> of ${all} in the queue</div>`+
      `<div class="queue-line">${esc(cur.kind)}${cur.price?` · ${esc(cur.price)}`:""}</div>`+
      `<div class="queue-step">${esc(q.step||"Starting…")}</div></div>`;
  }else{
    html+=`<div class="queue-now idle"><div class="queue-label">Between items</div><div class="queue-step">Waiting a few seconds before the next item (this keeps the sites from blocking the scanner).</div></div>`;
  }
  const upcoming=Array.isArray(q.upcoming)?q.upcoming:[];
  if(upcoming.length){
    html+=`<div class="queue-label">Up next</div><ol class="queue-list">`+upcoming.map(item=>
      `<li><span class="queue-pos">${item.position}</span><span class="queue-item"><span class="queue-item-name">${esc(item.name)}</span>${sourceBadge(item.source)}<small>${esc(item.kind)}</small></span></li>`).join("")+`</ol>`;
    if(q.more>0)html+=`<div class="queue-more">+ ${q.more} more after these</div>`;
  }else if(cur)html+=`<div class="queue-more">This is the last item in the queue.</div>`;
  scanQueueBox.innerHTML=html;
  scanQueueBox.hidden=false;
}
function sourceBadge(source){
  if(!source)return "";
  return ` <span class="source-badge ${source==="scrap.tf"?"scrap":"stn"}">${esc(sourceLabel(source))}</span>`;
}
function boughtEntries(){
  return (Array.isArray(purchaseLog)?purchaseLog:[]).filter(entry=>entry&&entry.name&&Number(entry.quantity)>0);
}
function boughtTotals(){
  const totals={total:0,stn:{hats:0,trades:0},scrap:{hats:0,trades:0}};
  for(const entry of boughtEntries()){
    const bucket=entry.source==="scrap.tf"?totals.scrap:totals.stn;
    bucket.hats+=Math.floor(Number(entry.quantity));
    bucket.trades++;
  }
  totals.total=totals.stn.hats+totals.scrap.hats;
  return totals;
}
function renderBought(){
  if(!boughtView)return;
  const entries=boughtEntries();
  const totals=boughtTotals();
  tabBought.textContent=String(totals.total);
  if(!entries.length){
    boughtView.innerHTML='<div class="trader-empty">Nothing bought yet. Every hat the bot buys is counted here, with the site it came from (STN or scrap.tf).</div>';
    return;
  }
  const items=new Map();
  for(const entry of entries){
    const key=itemKey(entry.name);
    const row=items.get(key)||{name:entry.name,stn:0,scrap:0,last:0};
    row[entry.source==="scrap.tf"?"scrap":"stn"]+=Math.floor(Number(entry.quantity));
    row.last=Math.max(row.last,Number(entry.at)||0);
    items.set(key,row);
  }
  const itemRows=[...items.values()].sort((a,b)=>b.last-a.last).map(row=>
    `<div class="bought-row"><div class="bought-name">${esc(row.name)}</div><div class="bought-split">${row.stn?`<span class="source-badge stn">STN ×${row.stn}</span>`:""}${row.scrap?`<span class="source-badge scrap">scrap.tf ×${row.scrap}</span>`:""}</div></div>`
  ).join("");
  const recentRows=entries.slice(-30).reverse().map(entry=>{
    const when=Number(entry.at)>0?new Date(Number(entry.at)).toLocaleString():"";
    return `<div class="bought-recent"><span>${esc(when)}</span><span>${esc(entry.name)} ×${Math.floor(Number(entry.quantity))}</span>${sourceBadge(entry.source==="scrap.tf"?"scrap.tf":"stn").trim()}${entry.offerId?`<small>#${esc(entry.offerId)}</small>`:""}</div>`;
  }).join("");
  boughtView.innerHTML=
    `<div class="bought-summary">`+
      `<div><b>${totals.total}</b><span>hats bought</span></div>`+
      `<div class="from-stn"><b>${totals.stn.hats}</b><span>from STN · ${totals.stn.trades} trade${totals.stn.trades===1?"":"s"}</span></div>`+
      `<div class="from-scrap"><b>${totals.scrap.hats}</b><span>from scrap.tf · ${totals.scrap.trades} trade${totals.scrap.trades===1?"":"s"}</span></div>`+
    `</div>`+
    `<div class="debug-title">By item</div>${itemRows}`+
    `<div class="debug-title">Latest purchases</div>${recentRows}`+
    `<button id="clearBought" class="secondary" type="button">Clear bought history</button>`;
  boughtView.querySelector("#clearBought").onclick=()=>{
    if(!window.confirm("Clear the bought history? This only resets these counters."))return;
    purchaseLog=[];
    renderBought();
    api.storage.local.set({purchaseLog:[]});
  };
}
api.storage.local.get({purchaseLog:[]},v=>{purchaseLog=Array.isArray(v.purchaseLog)?v.purchaseLog:[];renderBought()});

// ---- Already checked items (the 60-minute table kept by background.js) ------------
const CHECKED_KEY="checkedItems";
// One row per item with its fresh directions (see checked-items.js).
function checkedEntries(){
  return TF2CheckedItems.list(checkedItems&&typeof checkedItems==="object"?checkedItems:{});
}
function minutesLeft(entry){return Math.max(1,Math.ceil((Number(entry.expiresAt)-Date.now())/60000))}
function checkedOutcomeText(entry){
  if(entry.outcome==="good")return "Good Trade"+(Number.isFinite(entry.profitRef)?` (+${entry.profitRef.toFixed(2)} ref)`:"");
  if(entry.outcome==="not-found")return "No usable Buy Order";
  return "Not profitable";
}
function renderChecked(){
  if(!checkedView)return;
  const entries=checkedEntries();
  tabChecked.textContent=String(entries.length);
  if(!entries.length){
    checkedView.innerHTML='<div class="trader-empty">Nothing checked in the last 60 minutes. Every item the bot checks is remembered here at the price it was checked at, and skipped by the next scan until its 60 minutes are up (or its price changes).</div>';
    return;
  }
  const rows=entries.map(entry=>{
    const scrap=entry.source==="scrap.tf";
    const full=Boolean(entry.forward&&entry.reverse);
    const lines=["forward","reverse"].filter(direction=>entry[direction]).map(direction=>{
      const block=entry[direction];
      const label=direction==="forward"?`Buy on ${scrap?"scrap.tf":"STN"}, sell on Backpack.tf`:(block.via==="scrap.tf"?"Buy on scrap.tf, sell to STN":"Buy on Backpack.tf, sell to STN");
      return `<div class="line">${esc(label)}: at ${esc(block.price||"?")} · ${esc(checkedOutcomeText(block))} · ${esc(new Date(Number(block.checkedAt)).toLocaleTimeString())} · ${Math.max(1,Math.ceil((block.expiresAt-Date.now())/60000))} min left</div>`;
    }).join("");
    const missing=full?"":`<div class="small">${entry.forward?(scrap?"Not yet checked: buy on scrap.tf, sell to STN.":"Not yet checked: buy on Backpack.tf, sell to STN."):`Not yet checked: buy on ${scrap?"scrap.tf":"STN"}, sell on Backpack.tf.`}</div>`;
    return `<div class="checked-row ${esc(entry.outcome||"")}"><div class="checked-top"><span class="checked-name">${esc(entry.name)}</span>${sourceBadge(scrap?"scrap.tf":"stn").trim()}<span class="checked-timer">${full?"Fully checked":"Half checked"} · ${minutesLeft(entry)} min left</span></div>`+lines+missing+`</div>`;
  }).join("");
  checkedView.innerHTML=
    `<div class="hint">Skipped by scans for 60 minutes after a check, unless the price changes. "Retry this item" on a card checks it again right away.</div>`+
    rows+
    `<button id="clearChecked" class="secondary" type="button">Forget checked items</button>`;
  checkedView.querySelector("#clearChecked").onclick=()=>{
    if(!window.confirm("Forget every checked item? The next scan will check them all again."))return;
    checkedItems={};
    renderChecked();
    api.storage.local.set({[CHECKED_KEY]:{}});
  };
}
api.storage.local.get({[CHECKED_KEY]:{}},v=>{checkedItems=v[CHECKED_KEY]&&typeof v[CHECKED_KEY]==="object"?v[CHECKED_KEY]:{};renderChecked()});
api.storage.onChanged?.addListener((changes,area)=>{
  if(area!=="local"||!changes[CHECKED_KEY])return;
  const value=changes[CHECKED_KEY].newValue;
  checkedItems=value&&typeof value==="object"?value:{};
  renderChecked();
});
// The countdowns and the tab count move on without any storage change.
setInterval(renderChecked,30000);
api.storage.onChanged?.addListener((changes,area)=>{
  if(area!=="local"||!changes.purchaseLog)return;
  purchaseLog=Array.isArray(changes.purchaseLog.newValue)?changes.purchaseLog.newValue:[];
  renderBought();
});
