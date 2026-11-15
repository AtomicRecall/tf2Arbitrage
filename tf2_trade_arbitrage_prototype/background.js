const api=typeof browser!=="undefined"?browser:chrome;
const EXTENSION_VERSION=api.runtime.getManifest().version;
let queue=[],checked=0,total=0,keyRate=63,running=false,currentTabId=null,sourceTabId=null,sourceWindowId=null;
const ownedTabIds=new Set();
const ownedTabUrls=new Map();
let notifiedDeals=new Set();
const notificationTargets=new Map();
let tradeAutomationEnabled=false;
let tradeAutomationQueue=[];
let activeTradeJob=null;
let tradeWorkerRunning=false;
// True while the scan is processing an item. The scan and the trade worker share
// the scanner window, so they take turns instead of fighting over its active tab.
let scanItemBusy=false;
let tradeAutomationMessage="";
const tradeEventWaiters=new Map();
const transactionTabIds=new Set();
// STN auto rescan: when a scan of the STN page finishes, the page is refreshed, PageDown
// is pressed 3 times and the scan starts again by itself (see startAutoRescan).
let autoRescanContext=null,autoRescanToken=0,scanQueuedCount=0;
let hitAudio=null;
let endAudio=null;
let endSoundPlayed=false;
let notificationVolume=0.4;

// All scanning and Steam-offer checking happens in one dedicated Firefox
// window so the user's main window is never flipped between tabs.
let automationWindowId=null;
let automationWindowPromise=null;
let automationWindowRaised=false;
const SCANNER_WINDOW_TITLE_PREFACE="TF2 Arbitrage Scanner — ";

// Backpack.tf is intentionally accessed conservatively.
const PAGE_SETTLE_TIMEOUT=15000;
const LISTING_POLL_MS=1000;
const BETWEEN_ITEMS_MIN=5500;
const BETWEEN_ITEMS_MAX=8500;
const BETWEEN_CLASSIFIED_PAGES_MIN=4500;
const BETWEEN_CLASSIFIED_PAGES_MAX=7000;
const MAX_CLASSIFIEDS_PAGES=50;
const CHECKPOINT_MS=5000;
const MIN_PROFIT_REF=0.05;
const MAX_LISTING_ACTIVITY_AGE_MS=10*60*60*1000;
// One bot offer may be rebuilt after up to three page-refresh retries, so allow
// enough time for several full attempts.
const BOT_OFFER_TIMEOUT_MS=420000;
const STEAM_TRADE_OFFER_POLL_MS=2000;
const STEAM_TRADE_OFFER_TIMEOUT_MS=660000;
const STEAM_TRADE_OFFER_HISTORY_WINDOW_SECONDS=24*60*60;
const STEAM_TRADE_OFFER_STATE_NAMES=new Map([
  [1,"Invalid"],
  [2,"Active"],
  [3,"Accepted"],
  [4,"Countered"],
  [5,"Expired"],
  [6,"Canceled"],
  [7,"Declined"],
  [8,"InvalidItems"],
  [9,"CreatedNeedsConfirmation"],
  [10,"CanceledBySecondFactor"],
  [11,"InEscrow"]
]);
const STEAM_TRADE_OFFER_TERMINAL_STATES=new Set([1,4,5,6,7,8,10]);
// Sent bot offers are watched through the Web API. State 8 (InvalidItems,
// "Items Now Unavailable For Trade") makes the offer be sent again; state 3
// (Accepted) or 11 (accepted into escrow) ends the tracking.
const BOT_OFFER_TRACK_POLL_MS=12000;
const BOT_OFFER_TRACK_MAX_MS=3*60*60*1000;
const BOT_OFFER_MAX_RESENDS=3;
const trackedBotOffers=new Map();
let botOfferTrackerRunning=false;
let botOfferTrackerSeq=0;

async function waitForTabComplete(id,timeout=20000){
  const started=Date.now();
  while(Date.now()-started<timeout){
    try{
      const tabs=await qTabs({});
      const tab=tabs.find(t=>t.id===id);
      if(!tab)return false;
      if(tab.status==="complete")return true;
    }catch(e){}
    await sleep(300);
  }

  return false;
}

// Size and place of the scanner window: a smaller window in the bottom right
// corner of the screen's usable area (so it stays out of the way, but is still
// large enough for Steam and STN to treat its pages as visible). The position is
// worked out from the screen size, so no coordinates have to be configured.
function automationWindowSize(){
  const availableWidth=Number(globalThis.screen?.availWidth)||0;
  const availableHeight=Number(globalThis.screen?.availHeight)||0;
  const width=Math.max(700,Math.min(1000,availableWidth?Math.floor(availableWidth*0.5):1000));
  const height=Math.max(600,Math.min(800,availableHeight?Math.floor(availableHeight*0.65):800));
  const size={width,height};
  if(availableWidth&&availableHeight){
    const originLeft=Number(globalThis.screen?.availLeft)||0;
    const originTop=Number(globalThis.screen?.availTop)||0;
    size.left=Math.max(originLeft,originLeft+availableWidth-width);
    size.top=Math.max(originTop,originTop+availableHeight-height);
  }
  return size;
}

async function getWindowIfOpen(id){
  if(!Number.isInteger(id))return null;
  try{return await getWindow(id)}catch(error){return null}
}

// Returns the id of the single scanner window, opening it on first use. The
// window opens unfocused so the user's current window keeps focus.
function ensureAutomationWindow(){
  if(automationWindowPromise)return automationWindowPromise;
  automationWindowPromise=(async()=>{
    if(await getWindowIfOpen(automationWindowId))return automationWindowId;
    automationWindowId=null;
    automationWindowRaised=false;

    const base={
      url:api.runtime.getURL("scanner.html"),
      type:"normal",
      titlePreface:SCANNER_WINDOW_TITLE_PREFACE,
      ...automationWindowSize()
    };
    let created=null;
    let openedUnfocused=false;
    const attempts=[{...base,focused:false},base,{url:base.url}];
    let lastError=null;
    for(const options of attempts){
      try{created=await createWindow(options);openedUnfocused=options.focused===false;break}
      catch(error){lastError=error}
    }
    if(!Number.isInteger(created?.id)){
      throw lastError||new Error("Firefox did not return a scanner window.");
    }
    automationWindowId=created.id;
    // Some Firefox versions reject the "focused" option, so the new window can
    // come up in front. Hand focus straight back to the user's window.
    if(!openedUnfocused&&Number.isInteger(sourceWindowId)&&sourceWindowId!==created.id){
      try{await updateWindow(sourceWindowId,{focused:true})}catch(error){}
    }
    // The new window may have covered iPhone Mirroring on the Mac; bring that
    // app back to the front (it does not wait for the answer).
    refocusIPhoneMirroring();
    return automationWindowId;
  })().finally(()=>{automationWindowPromise=null});
  return automationWindowPromise;
}

// Falls back to the user's own window only if the scanner window cannot be
// opened, so a window-API problem never stops scanning.
async function scanWindowId(){
  try{return await ensureAutomationWindow()}
  catch(error){
    console.warn("Could not open the scanner window; using the current window instead.",error);
    return Number.isInteger(sourceWindowId)?sourceWindowId:null;
  }
}

// Tabs are active inside the scanner window (nothing else lives there). In the
// main-window fallback they stay in the background unless the caller needs the
// page in the foreground, as Steam offer checks do.
async function createScanTab(url,foregroundInMainWindow=false){
  let windowId=await scanWindowId();
  for(let attempt=0;;attempt++){
    const inScannerWindow=Number.isInteger(automationWindowId)&&windowId===automationWindowId;
    const options={url,active:inScannerWindow||foregroundInMainWindow};
    if(Number.isInteger(windowId))options.windowId=windowId;
    try{return await createTab(options)}
    catch(error){
      // The user may have closed the scanner window since it was last checked.
      if(attempt>0||!inScannerWindow)throw error;
      automationWindowId=null;
      windowId=await scanWindowId();
    }
  }
}

async function raiseAutomationWindow(){
  if(!Number.isInteger(automationWindowId))return;
  try{
    await updateWindow(automationWindowId,{focused:true,state:"normal"});
    automationWindowRaised=true;
  }catch(error){console.warn("Could not raise the scanner window:",error)}
}

// Hands focus back to the user's window after the scanner window had to be
// brought forward so Steam would initialize.
async function restoreMainWindowFocus(){
  if(!automationWindowRaised)return;
  automationWindowRaised=false;
  if(!Number.isInteger(sourceWindowId)||!await getWindowIfOpen(sourceWindowId))return;
  try{await updateWindow(sourceWindowId,{focused:true})}catch(error){}
}

// Steam and STN only work properly in a visible page (Steam initializes the
// trader's inventory, STN runs its Turnstile check). The scanner window is
// normally visible, but a window fully covered by another one (or minimized)
// reports its pages as hidden; raise it only in that case. Trade jobs keep
// working after a scan ends, so they pass ignoreScanState.
async function ensureScanTabVisible(tabId,timeoutMs=8000,ignoreScanState=false){
  const tab=await qTabs({}).then(tabs=>tabs.find(t=>t.id===tabId)).catch(()=>null);
  if(!tab||tab.windowId!==automationWindowId)return;
  const deadline=Date.now()+timeoutMs;
  let raised=false;
  while((ignoreScanState||running)&&Date.now()<deadline){
    let state=null;
    try{state=await msgTab(tabId,{type:"GET_PAGE_VISIBILITY"})}
    catch(error){await sleep(250);continue}
    if(!state?.hidden)return;
    if(!raised){raised=true;await raiseAutomationWindow()}
    await sleep(250);
  }
}

async function closeAutomationWindow(){
  const id=automationWindowId;
  automationWindowId=null;
  await restoreMainWindowFocus();
  if(!Number.isInteger(id)||!await getWindowIfOpen(id))return;
  selfClosedWindowIds.add(id);
  try{await removeWindow(id)}catch(error){
    selfClosedWindowIds.delete(id);
    console.warn("Could not close the scanner window:",error);
  }
}

function isTradeWorkBusy(){
  return tradeWorkerRunning||activeTradeJob!==null;
}

// Closes the scanner window only when neither a scan nor a trade is using it.
async function closeAutomationWindowIfIdle(){
  if(running||scanItemBusy||isTradeWorkBusy())return;
  await closeAutomationWindow();
}

// The scan waits here while a trade job is using the scanner window.
async function waitForTradeIdle(){
  while(running&&isTradeWorkBusy())await sleep(1000);
}

// A trade job that starts in the middle of a scan item waits for that item to
// finish. The wait is bounded so a stuck flag can never block trading.
async function waitForScanIdle(maxWaitMs=10*60*1000){
  const deadline=Date.now()+maxWaitMs;
  while(scanItemBusy&&Date.now()<deadline)await sleep(500);
}

function createTransactionTab(url,active=false,windowId=sourceWindowId){
  const options={url,active};
  if(Number.isInteger(windowId))options.windowId=windowId;
  return createTab(options);
}

// Everything to do with trade offers (STN purchases, Steam offers, the metal and
// bad-trader checks of an offer) happens in the user's MAIN window, as an active
// tab. The tab that was active before is brought back when the offer tab closes.
// Only if no main window is known does it fall back to the scanner window.
const offerTabPreviousActive=new Map();

async function mainWindowIdIfOpen(){
  return Number.isInteger(sourceWindowId)&&await getWindowIfOpen(sourceWindowId)?sourceWindowId:null;
}

async function createOfferTab(url){
  const windowId=await mainWindowIdIfOpen();
  if(!Number.isInteger(windowId))return createScanTab(url,true);
  let previous=null;
  try{previous=(await qTabs({active:true,windowId}))[0]||null}catch(error){}
  const tab=await createTab({url,active:true,windowId});
  if(Number.isInteger(tab?.id)&&Number.isInteger(previous?.id))offerTabPreviousActive.set(tab.id,previous.id);
  return tab;
}

// Call after the offer tab was closed.
async function restoreAfterOfferTab(tabId){
  const previousId=offerTabPreviousActive.get(tabId);
  offerTabPreviousActive.delete(tabId);
  if(!Number.isInteger(previousId)||!await tabStillExists(previousId))return;
  try{await updateTab(previousId,{active:true})}
  catch(error){console.warn("Could not restore the original active tab after the offer tab closed:",error)}
}

// Reuse one transaction tab for the entire queued trade. STN, each purchase
// offer and each bot offer replace one another in this dedicated tab, which
// lives in the main window (see createOfferTab).
async function getJobTransactionTab(job,url){
  let tab=null;
  if(Number.isInteger(job?.transactionTabId)){
    const tabs=await qTabs({});
    tab=tabs.find(candidate=>candidate.id===job.transactionTabId)||null;
  }
  if(tab){
    tab=await updateTab(tab.id,{url,active:true});
  }else{
    tab=await createOfferTab(url);
    if(!Number.isInteger(tab?.id))throw new Error("Browser did not return the trade transaction tab ID.");
    job.transactionTabId=tab.id;
    transactionTabIds.add(tab.id);
  }
  return tab;
}

function urlWithoutHash(value){
  try{const url=new URL(String(value||""));url.hash="";return url.href}
  catch{return String(value||"")}
}

function getTabInfo(id){
  if(!Number.isInteger(id))return Promise.resolve(null);
  if(isFirefoxBrowserApi)return api.tabs.get(id).catch(()=>null);
  return new Promise(resolve=>api.tabs.get(id,tab=>{
    resolve(api.runtime.lastError?null:tab);
  }));
}

function reloadTab(id){
  if(isFirefoxBrowserApi)return api.tabs.reload(id,{bypassCache:true});
  return new Promise((resolve,reject)=>api.tabs.reload(id,{bypassCache:true},()=>{
    const error=api.runtime.lastError;
    if(error)reject(new Error(error.message));else resolve();
  }));
}

// Records whether a tab has started and finished a navigation. A tab that is
// reused for a new page still reports status "complete" for the PREVIOUS page
// for a moment after tabs.update(), so "complete" alone cannot be trusted.
function watchTabNavigation(tabId){
  const state={started:false,complete:false,stop(){}};
  if(!api.tabs?.onUpdated)return state;
  const listener=(id,changeInfo)=>{
    if(id!==tabId)return;
    if(changeInfo.status==="loading"||typeof changeInfo.url==="string")state.started=true;
    if(changeInfo.status==="complete"&&state.started)state.complete=true;
  };
  api.tabs.onUpdated.addListener(listener);
  state.stop=()=>{try{api.tabs.onUpdated.removeListener(listener)}catch(error){}};
  return state;
}

async function waitForTabNavigation(tabId,targetUrl,watch,previousUrl="",timeoutMs=30000){
  let target=null;
  try{target=new URL(targetUrl)}catch(error){}
  const targetNoHash=urlWithoutHash(targetUrl);
  const previousNoHash=previousUrl?urlWithoutHash(previousUrl):"";
  const startedAt=Date.now();
  while(Date.now()-startedAt<timeoutMs){
    const tab=await getTabInfo(tabId);
    if(!tab)return false;
    if(tab.status==="complete"){
      // The tab went through a full loading cycle that began after we asked it
      // to navigate, so this is the new page, not the previous one.
      if(watch?.started)return true;
      // No navigation events were seen (very fast load, or the listener could
      // not attach). Accept only a document that is clearly the target.
      const current=String(tab.url||"");
      const currentNoHash=urlWithoutHash(current);
      let currentHost="";
      try{currentHost=new URL(current).hostname}catch(error){}
      const onTarget=currentNoHash===targetNoHash||
        (target&&currentHost===target.hostname&&currentNoHash!==previousNoHash);
      if(onTarget&&Date.now()-startedAt>=1500)return true;
    }
    await sleep(100);
  }
  return false;
}

// Navigates the job's single transaction tab (creating it if needed) and waits
// until the NEW page has loaded. Returns {tab,loaded}.
async function openJobTransactionPage(job,url,timeoutMs=30000){
  let existing=null;
  if(Number.isInteger(job?.transactionTabId))existing=await getTabInfo(job.transactionTabId);
  const previousUrl=existing?String(existing.url||""):"";
  const watch=existing?watchTabNavigation(existing.id):null;
  try{
    const tab=await getJobTransactionTab(job,url);
    if(!Number.isInteger(tab?.id))throw new Error("Browser did not return the trade transaction tab ID.");
    const tabWatch=watch||watchTabNavigation(tab.id);
    try{
      // Setting a tab to the URL it already shows (or that differs only by its
      // hash) does not reload, so force a fresh load of the new page.
      if(existing&&previousUrl&&urlWithoutHash(previousUrl)===urlWithoutHash(url)){
        await reloadTab(tab.id).catch(()=>{});
      }
      const loaded=await waitForTabNavigation(tab.id,url,tabWatch,previousUrl,timeoutMs);
      // Make sure the scanner window is actually showing the page before the
      // STN purchase or Steam offer logic starts working in it.
      if(loaded)await ensureScanTabVisible(tab.id,6000,true);
      return {tab,loaded};
    }finally{
      if(!watch)tabWatch.stop();
    }
  }finally{
    watch?.stop();
  }
}

function validSteamNewTradeUrl(value){
  try{
    const url=new URL(String(value||""));
    return url.protocol==="https:"&&url.hostname==="steamcommunity.com"&&/^\/tradeoffer\/new\/?$/i.test(url.pathname)?url:null;
  }catch{return null}
}

function validSteamIncomingTradeUrl(value){
  try{
    const url=new URL(String(value||""));
    return url.protocol==="https:"&&url.hostname==="steamcommunity.com"&&/^\/tradeoffer\/\d+\/?$/i.test(url.pathname)?url:null;
  }catch{return null}
}

function validBackpackPageUrl(value){
  try{
    const url=new URL(String(value||""));
    return url.protocol==="https:"&&/^(?:www\.)?backpack\.tf$/i.test(url.hostname)&&/^\/(?:classifieds|stats)\b/i.test(url.pathname)?url:null;
  }catch{return null}
}

function filteredClassifiedsPageUrl(value){
  const url=validBackpackPageUrl(value);
  if(!url||!/^\/classifieds\b/i.test(url.pathname))return null;
  url.searchParams.set("offers","1");
  url.searchParams.set("paint","None");
  return url;
}

function emitTradeAutomationStatus(message){
  tradeAutomationMessage=String(message||"");
  const state=getTradeAutomationState();
  popup({type:"TRADE_AUTOMATION_STATUS",state});
  saveState({tradeAutomation:state});
}

function getTradeAutomationState(){
  return {
    enabled:tradeAutomationEnabled,
    queued:tradeAutomationQueue.length,
    active:activeTradeJob?{
      id:activeTradeJob.id,
      name:activeTradeJob.name,
      step:activeTradeJob.step,
      quantity:activeTradeJob.quantity,
      offerCount:activeTradeJob.offerCount||activeTradeJob.listings?.length||0,
      purchasedQuantity:activeTradeJob.purchasedQuantity||0,
      skipPurchase:Boolean(activeTradeJob.skipPurchase),
      source:activeTradeJob.source==="scrap.tf"?"scrap.tf":"stn",
      purchaseOfferId:activeTradeJob.purchaseOfferId||"",
      purchaseProgress:activeTradeJob.purchaseProgress||null,
      purchasePageProgress:activeTradeJob.purchasePageProgress||null
    }:null,
    message:tradeAutomationMessage
  };
}

function settleTradeEvent(key,value,error=null){
  const waiter=tradeEventWaiters.get(key);
  if(!waiter)return false;
  tradeEventWaiters.delete(key);
  clearTimeout(waiter.timeout);
  if(error)waiter.reject(error);
  else waiter.resolve(value);
  return true;
}

function waitForTradeEvent(jobId,eventName,timeoutMs,sellerLabel="STN"){
  const key=`${eventName}:${jobId}`;
  return new Promise((resolve,reject)=>{
    const existing=tradeEventWaiters.get(key);
    if(existing)clearTimeout(existing.timeout);
    const timeout=setTimeout(()=>{
      tradeEventWaiters.delete(key);
      reject(new Error(`Timed out waiting for ${eventName==="TRADE_PURCHASE_ACCEPTED"?`the ${sellerLabel} purchase offer to be accepted`:"the bot trade offer to be sent"}.`));
    },timeoutMs);
    tradeEventWaiters.set(key,{resolve,reject,timeout});
  });
}

async function getTabMessageWithRetry(tabId,message,timeoutMs=15000){
  const deadline=Date.now()+timeoutMs;
  let lastError=null;
  while(Date.now()<deadline){
    try{return await msgTab(tabId,message)}
    catch(error){lastError=error;await sleep(300)}
  }
  throw new Error(`Could not communicate with the trade tab: ${lastError?.message||"content script unavailable"}`);
}

async function waitForAutomationEvent(tabId,eventPromise,timeoutMs=BOT_OFFER_TIMEOUT_MS){
  const deadline=Date.now()+timeoutMs;
  let missingSince=0;
  while(Date.now()<deadline){
    const event=await Promise.race([eventPromise,sleep(500).then(()=>null)]);
    if(event)return event;
    if(await tabStillExists(tabId)){
      missingSince=0;
      let status;
      try{status=await msgTab(tabId,{type:"GET_TMT_AUTOMATION_STATUS"})}catch{}
      if(status?.status==="failed")throw new Error(status.message||"TF2 Metal Trader reported that this offer could not be completed.");
    }else{
      if(!missingSince)missingSince=Date.now();
      if(Date.now()-missingSince>=10000)throw new Error("The TF2 Metal Trader tab closed without reporting a completed offer.");
    }
  }
  throw new Error("Timed out waiting for TF2 Metal Trader to complete this offer.");
}

function stnOfferIdFromUrl(value){
  return String(value||"").match(/\/tradeoffer\/(\d+)\/?(?:[?#].*)?$/i)?.[1]||"";
}

// STN failures that happen before any offer exists, so asking again is safe.
function isRetryableStnFailure(reason){
  return /reserved by other users|unable to process your request|failed to process your trade request|game's item server|item server/i
    .test(String(reason||""));
}

async function waitForStnPurchaseOffer(tabId,timeoutMs=180000,excludedOfferIds=[]){
  const deadline=Date.now()+timeoutMs;
  const excluded=new Set((Array.isArray(excludedOfferIds)?excludedOfferIds:[]).map(String));
  let lastReason="";
  let pendingFailure="";
  while(Date.now()<deadline){
    if(!await tabStillExists(tabId))throw new Error("The STN purchase tab closed before reporting its trade offer.");
    const response=await getTabMessageWithRetry(tabId,{type:"GET_STN_PURCHASE_OFFER"},5000);
    if(response?.status==="sent"){
      const offerUrl=validSteamIncomingTradeUrl(response.url);
      const offerId=stnOfferIdFromUrl(offerUrl?.href||response.url);
      if(offerUrl&&!excluded.has(offerId))return offerUrl;
      // STN keeps showing the previous purchase's link until the new request
      // replaces it. That offer was already accepted, so it is never reused.
      lastReason=`STN is still showing the previous batch's offer${offerId?` #${offerId}`:""}; waiting for the new batch's offer.`;
      pendingFailure="";
    }else if(response?.status==="failed"){
      // Require the same failure twice in a row so a stale alert that is about
      // to be replaced by the new request is not mistaken for a real failure.
      const reason=response.reason||"STN reported that the purchase failed.";
      if(pendingFailure===reason){
        const error=new Error(reason);
        error.stnRetryable=isRetryableStnFailure(reason);
        throw error;
      }
      pendingFailure=reason;
      lastReason=reason;
    }else{
      pendingFailure="";
      lastReason=response?.reason||lastReason;
    }
    await sleep(1000);
  }
  throw new Error(lastReason||"STN did not produce a purchase trade offer before timeout.");
}

function steamApiError(message,retryable=false){
  const error=new Error(message);
  error.retryable=retryable;
  return error;
}

async function loadSteamWebApiKey(){
  let settings;
  try{
    if(isFirefoxBrowserApi){
      settings=await api.storage.local.get({steamWebApiKey:""});
    }else{
      settings=await new Promise((resolve,reject)=>{
        try{
          api.storage.local.get({steamWebApiKey:""},value=>{
            const error=api.runtime.lastError;
            if(error)reject(new Error(error.message));
            else resolve(value);
          });
        }catch(error){reject(error)}
      });
    }
  }catch(error){
    throw new Error(`Could not read the saved Steam Web API key from extension storage: ${error?.message||error}`);
  }

  const key=String(settings?.steamWebApiKey||"").trim();
  if(!key)throw new Error("A Steam Web API key is required before STN purchases. Save one in the Steam Web API settings in this add-on.");
  if(!/^[0-9a-f]{32}$/i.test(key))throw new Error("The saved Steam Web API key must be 32 hexadecimal characters. Replace it in the Steam Web API settings.");
  return key;
}

// Shared GET to the Steam Web API with timeout, HTTP and JSON error handling.
async function steamApiRequest(url,label){
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),15000);
  let response;
  try{
    response=await fetch(url.href,{
      method:"GET",
      credentials:"omit",
      cache:"no-store",
      referrerPolicy:"no-referrer",
      signal:controller.signal
    });
  }catch(error){
    const reason=error?.name==="AbortError"
      ?"request timed out after 15 seconds"
      :`network request failed: ${error?.message||error}`;
    throw steamApiError(`Could not reach Steam Web API (${reason}).`,true);
  }finally{
    clearTimeout(timeout);
  }

  if(!response.ok){
    const retryable=response.status===408||response.status===429||response.status>=500;
    const message=response.status===401||response.status===403
      ?`Steam denied the ${label} request (HTTP ${response.status}). Check that the saved key is a valid Steam Web API key.`
      :`Steam Web API returned HTTP ${response.status}${response.statusText?` ${response.statusText}`:""}.`;
    throw steamApiError(message,retryable);
  }

  let payload;
  try{payload=await response.json()}
  catch{throw steamApiError("Steam Web API returned an invalid JSON response.",true)}

  const serviceError=payload?.response?.error||payload?.error;
  if(serviceError)throw steamApiError(`Steam Web API rejected the ${label} request: ${String(serviceError).slice(0,240)}`);
  return payload;
}

async function fetchSteamReceivedOffers(apiKey){
  const url=new URL("https://api.steampowered.com/IEconService/GetTradeOffers/v1/");
  const historicalCutoff=Math.max(0,Math.floor(Date.now()/1000)-STEAM_TRADE_OFFER_HISTORY_WINDOW_SECONDS);
  url.searchParams.set("key",apiKey);
  url.searchParams.set("get_sent_offers","false");
  url.searchParams.set("get_received_offers","true");
  url.searchParams.set("get_descriptions","false");
  url.searchParams.set("language","en");
  url.searchParams.set("active_only","false");
  url.searchParams.set("historical_only","false");
  url.searchParams.set("time_historical_cutoff",String(historicalCutoff));

  const payload=await steamApiRequest(url,"GetTradeOffers");
  const offers=payload?.response?.trade_offers_received;
  if(Array.isArray(offers))return offers;
  // Steam leaves the list out of its response entirely when the account has no
  // received offers to report ({"response":{}}). That is a valid answer, not a
  // failure: the caller simply does not find its offer in it yet.
  if(payload&&typeof payload.response==="object"&&payload.response!==null)return [];
  throw steamApiError("Steam Web API returned an unexpected response (no \"response\" object) for the received trade-offers list.",true);
}

async function fetchSteamSentOffers(apiKey){
  const url=new URL("https://api.steampowered.com/IEconService/GetTradeOffers/v1/");
  const historicalCutoff=Math.max(0,Math.floor(Date.now()/1000)-STEAM_TRADE_OFFER_HISTORY_WINDOW_SECONDS);
  url.searchParams.set("key",apiKey);
  url.searchParams.set("get_sent_offers","true");
  url.searchParams.set("get_received_offers","false");
  url.searchParams.set("get_descriptions","false");
  url.searchParams.set("language","en");
  url.searchParams.set("active_only","false");
  url.searchParams.set("historical_only","false");
  url.searchParams.set("time_historical_cutoff",String(historicalCutoff));

  const payload=await steamApiRequest(url,"GetTradeOffers");
  const offers=payload?.response?.trade_offers_sent;
  if(Array.isArray(offers))return offers;
  if(payload&&typeof payload.response==="object"&&payload.response!==null)return [];
  throw steamApiError("Steam Web API returned an unexpected response (no \"response\" object) for the sent trade-offers list.",true);
}

// Looks up one offer by id (IEconService/GetTradeOffer). Used when the offer
// is not in the received-offers list, for example while Steam's list is empty
// or lagging. Returns null when Steam does not know the offer for this key.
async function fetchSteamTradeOffer(apiKey,offerId){
  const url=new URL("https://api.steampowered.com/IEconService/GetTradeOffer/v1/");
  url.searchParams.set("key",apiKey);
  url.searchParams.set("tradeofferid",String(offerId));
  url.searchParams.set("language","en");
  const payload=await steamApiRequest(url,"GetTradeOffer");
  const offer=payload?.response?.offer;
  return offer&&typeof offer==="object"&&String(offer.tradeofferid||"")===String(offerId)?offer:null;
}

function setSteamApiPurchaseProgress(job,phase,message,state=null){
  const updatedAt=Date.now();
  const hasState=Number.isSafeInteger(state);
  const stateName=hasState?(STEAM_TRADE_OFFER_STATE_NAMES.get(state)||"Unknown"):"";
  const evidence=hasState
    ?`IEconService/GetTradeOffers returned trade_offer_state=${state} (${stateName}).`
    :"Looking up the exact offer ID in Steam's received-offers list.";
  const history=[...(job.purchaseProgress?.history||[])];
  const last=history[history.length-1];
  if(!last||last.phase!==phase||last.state!==(hasState?state:null)){
    history.push({phase,message,evidence,state:hasState?state:null,updatedAt});
  }
  job.purchaseProgress={
    phase,
    message,
    evidence,
    source:"Steam Web API",
    steamOfferState:hasState?state:null,
    steamOfferStateName:stateName,
    offerId:job.purchaseOfferId,
    updatedAt,
    history:history.slice(-8)
  };
  emitTradeAutomationStatus(message);
}

async function waitForSteamOfferAccepted(job,offerId,apiKey,timeoutMs=STEAM_TRADE_OFFER_TIMEOUT_MS){
  const deadline=Date.now()+timeoutMs;
  let consecutiveFailures=0;
  let missingOfferPolls=0;
  setSteamApiPurchaseProgress(
    job,
    "steam-api-polling",
    `Waiting for Steam Web API state 3 (Accepted) for offer #${offerId}. The Mac confirmer handles the mobile confirmation when it is enabled; otherwise confirm on your phone.`
  );

  // The offer page saw Steam accept the offer (no further confirmation needed).
  const acceptedByPage=()=>job.purchaseAcceptedOfferId===String(offerId);
  // Accepting an STN offer also needs the Steam Mobile confirmation. This entry
  // lets the Mac confirmer handle it the same way as a sent bot offer.
  const macEntry={
    offerId:String(offerId),
    needsConfirmation:false,
    label:job.source==="scrap.tf"?"the scrap.tf purchase":"the STN purchase"
  };
  // The offer page says Steam is waiting for the mobile confirmation. Either of
  // its two reports counts: the final "accepted, needs confirmation" event, or
  // the earlier progress step (which is enough even if the final event is lost).
  const pageNeedsMobile=()=>
    job.purchaseNeedsConfirmationOfferId===String(offerId)||
    (job.purchasePageProgress?.phase==="mobile-confirmation-pending"&&String(job.purchasePageProgress.offerId)===String(offerId));
  let askedForPageSignal=false;
  const askMac=async(waitingForConfirmation)=>{
    macEntry.needsConfirmation=waitingForConfirmation;
    if(!waitingForConfirmation)return;
    await requestMacConfirmations([macEntry]).catch(error=>console.warn("Mac confirmer request failed:",error));
  };
  // Sleeps between API polls but wakes at once when the page reports acceptance.
  const pollPause=async()=>{
    const until=Date.now()+STEAM_TRADE_OFFER_POLL_MS;
    while(Date.now()<until&&!acceptedByPage()&&!(pageNeedsMobile()&&!askedForPageSignal))await sleep(200);
  };

  while(Date.now()<deadline){
    if(acceptedByPage()){
      setSteamApiPurchaseProgress(job,"steam-page-accepted",`Steam accepted offer #${offerId} on its offer page (accept request succeeded). Not waiting for the Web API to catch up.`);
      return 3;
    }
    // The offer page said Steam needs the mobile confirmation: ask the Mac now,
    // without waiting for the lagging Web API to show state 9.
    if(pageNeedsMobile()){
      askedForPageSignal=true;
      await askMac(true);
    }
    let offers;
    try{
      offers=await fetchSteamReceivedOffers(apiKey);
      consecutiveFailures=0;
    }catch(error){
      consecutiveFailures++;
      if(!error.retryable||consecutiveFailures>=3){
        throw new Error(`Could not verify Steam purchase offer #${offerId} through the Web API: ${error.message||error} No bot offers were sent.`);
      }
      setSteamApiPurchaseProgress(
        job,
        "steam-api-retrying",
        `Steam Web API is temporarily unavailable (retry ${consecutiveFailures}/3): ${error.message||error}`
      );
      await pollPause();
      continue;
    }

    let offer=offers.find(entry=>String(entry?.tradeofferid||"")===String(offerId));
    if(!offer){
      // The list can be empty or behind; ask Steam for this exact offer.
      try{offer=await fetchSteamTradeOffer(apiKey,offerId)||undefined}
      catch(error){
        if(error&&error.retryable===false&&/denied|rejected/i.test(String(error.message||""))){
          throw new Error(`Could not verify Steam purchase offer #${offerId} through the Web API: ${error.message||error} No bot offers were sent.`);
        }
      }
    }
    if(!offer){
      missingOfferPolls++;
      const keyHint=missingOfferPolls>=6
        ?` Steam still does not list it for this API key after ${missingOfferPolls} checks; make sure the saved key belongs to the Steam account that receives the STN offers.`
        :"";
      setSteamApiPurchaseProgress(
        job,
        "steam-api-offer-not-found",
        `Steam Web API has not returned offer #${offerId} yet. Retrying the exact offer lookup.${keyHint}`
      );
    }else{
      missingOfferPolls=0;
      const state=Number(offer.trade_offer_state);
      if(!Number.isSafeInteger(state)){
        throw new Error(`Steam Web API returned an invalid trade_offer_state for offer #${offerId}. No bot offers were sent.`);
      }

      const stateName=STEAM_TRADE_OFFER_STATE_NAMES.get(state)||"Unknown";
      const phase=state===3
        ?"steam-api-accepted"
        :state===2
          ?"steam-api-active"
          :state===9
            ?"steam-api-mobile-confirmation-pending"
            :state===11
              ?"steam-api-in-escrow"
              :"steam-api-state";
      const message=state===2
        ?`Steam Web API reports offer #${offerId} is Active (state 2). Waiting for acceptance and mobile confirmation.`
        :state===3
          ?`Steam Web API confirms offer #${offerId} is Accepted (state 3).`
          :state===9
            ?`Steam Web API reports offer #${offerId} is awaiting the Steam Mobile confirmation (state 9).`
            :state===11
              ?`Steam Web API reports offer #${offerId} is in escrow (state 11). Escrow is not treated as completed.`
              :`Steam Web API reports offer #${offerId}: ${stateName} (state ${state}).`;
      setSteamApiPurchaseProgress(job,phase,message,state);
      // State 9 means Steam is waiting for the mobile confirmation.
      if(state===9)await askMac(true);
      else macEntry.needsConfirmation=false;

      if(state===3)return state;
      if(state===11){
        throw new Error(`Steam reports offer #${offerId} is InEscrow (state 11), not Accepted (state 3). No bot offers were sent; wait until Steam completes escrow, then retry.`);
      }
      if(STEAM_TRADE_OFFER_TERMINAL_STATES.has(state)){
        throw new Error(`Steam reports offer #${offerId} is ${stateName} (state ${state}), not Accepted. No bot offers were sent.`);
      }
    }

    await pollPause();
  }

  const lastState=job.purchaseProgress?.steamOfferState;
  const lastStateName=job.purchaseProgress?.steamOfferStateName;
  const lastStateMessage=Number.isSafeInteger(lastState)
    ?`The last reported state was ${lastState} (${lastStateName||"Unknown"}).`
    :"Steam did not return the offer in its received-offers list.";
  throw new Error(`Timed out waiting for offer #${offerId} to reach Accepted (state 3). ${lastStateMessage} No bot offers were sent.`);
}

function chooseStnQuickBuyAmount(availableAmounts,remaining){
  return (Array.isArray(availableAmounts)?availableAmounts:[])
    .map(Number)
    .filter(value=>Number.isSafeInteger(value)&&value>0&&value<=remaining)
    .sort((a,b)=>b-a)[0]||null;
}

async function waitForStnQuickBuyAmount(tabId,remaining,timeoutMs=30000){
  const deadline=Date.now()+timeoutMs;
  let lastReason="";
  while(Date.now()<deadline){
    if(!await tabStillExists(tabId))throw new Error("The STN marketplace tab closed before its QuickBuy quantities loaded.");
    const response=await getTabMessageWithRetry(tabId,{type:"GET_STN_QUICKBUY_OPTIONS"},5000);
    if(response?.status==="failed")throw new Error(response.reason||"STN could not read its QuickBuy quantities.");
    if(response?.status==="ready"&&Array.isArray(response.amounts)){
      const amount=chooseStnQuickBuyAmount(response.amounts,remaining);
      if(amount)return amount;
      const maxAmount=Number(response.maxAmount);
      throw new Error(
        `STN's available QuickBuy quantities (${response.amounts.join(", ")}) cannot cover the remaining ${remaining} item${remaining===1?"":"s"} without exceeding the target`+
        (Number.isSafeInteger(maxAmount)&&maxAmount>remaining?` (STN's largest option is ${maxAmount}).`:".")
      );
    }
    lastReason=response?.reason||lastReason;
    await sleep(500);
  }
  throw new Error(lastReason||"STN did not load its QuickBuy quantities within 30 seconds.");
}

async function openStnPurchaseBatch(job,batchNumber,remaining){
  const stnUrl=new URL(marketplaceUrl(job.name));
  stnUrl.hash=new URLSearchParams({tmt_arb_job:job.id}).toString();
  const {tab:stnTab,loaded}=await openJobTransactionPage(job,stnUrl.href,30000);
  if(!loaded)throw new Error("STN.Trading did not finish loading the item page.");
  const amount=await waitForStnQuickBuyAmount(stnTab.id,remaining);
  emitTradeAutomationStatus(`STN batch ${batchNumber}: QuickBuying ${amount} of ${remaining} remaining ${job.name}…`);
  const purchase=await getTabMessageWithRetry(stnTab.id,{type:"AUTOMATED_QUICK_BUY",amount});
  if(!purchase?.ok)throw new Error(purchase?.reason||`STN could not place QuickBuy batch ${batchNumber} (${amount} items).`);
  emitTradeAutomationStatus(`STN batch ${batchNumber}: QuickBuy accepted for ${amount}. Waiting for the incoming trade offer…`);
  const offerUrl=await waitForStnPurchaseOffer(stnTab.id,180000,job.purchaseOfferIds);
  if(!offerUrl)throw new Error(`STN did not provide a valid trade offer for purchase batch ${batchNumber}.`);
  return {amount,offerUrl};
}

// ---- scrap.tf purchase --------------------------------------------------------
// Opens the scrap.tf Buy Hats page the item was found on, selects the item and
// presses the cart button, then waits until scrap.tf's bot has sent its Steam
// trade offer (the "Your trade is ready!" panel) and returns that offer. The
// offer is then accepted and verified exactly like an STN purchase offer.
const SCRAP_BUY_URL="https://scrap.tf/buy/hats";
const SCRAP_QUEUE_TIMEOUT_MS=360000;
// scrap.tf is asked for one trade at a time: the next one is requested only after
// the previous scrap.tf offer was accepted (Steam Web API state 3), and then only
// after a few seconds, so scrap.tf's queue is never hit back to back. The gap also
// separates the trades of two different items.
const SCRAP_REQUEST_GAP_MIN_MS=6000;
const SCRAP_REQUEST_GAP_MAX_MS=9000;
let scrapLastActivityAt=0;
async function waitForScrapRequestGap(){
  const gap=randomDelay(SCRAP_REQUEST_GAP_MIN_MS,SCRAP_REQUEST_GAP_MAX_MS);
  const wait=scrapLastActivityAt?gap-(Date.now()-scrapLastActivityAt):0;
  if(wait>250){
    emitTradeAutomationStatus(`Waiting ${Math.ceil(wait/1000)} s after the last scrap.tf trade before asking scrap.tf for the next one…`);
    await sleep(wait);
  }
  scrapLastActivityAt=Date.now();
}
const SCRAP_IDLE_TIMEOUT_MS=60000;

async function cancelScrapQueue(tabId){
  try{if(Number.isInteger(tabId)&&await tabStillExists(tabId))await msgTab(tabId,{type:"SCRAP_CANCEL_QUEUE"})}
  catch(error){console.warn("Could not cancel the scrap.tf queue entry:",error)}
}

async function openScrapPurchaseBatch(job,batchNumber,remaining,apiKey){
  // Purchases always happen on the Buy Hats page.
  const pageUrl=new URL(SCRAP_BUY_URL);
  // The offers Steam already lists, in case the offer id cannot be read from
  // the scrap.tf page itself.
  const knownOffers=new Set();
  try{for(const offer of await fetchSteamReceivedOffers(apiKey))knownOffers.add(String(offer.tradeofferid))}
  catch(error){console.warn("Could not list the existing Steam offers:",error)}

  const {tab,loaded}=await openJobTransactionPage(job,pageUrl.href,30000);
  if(!loaded)throw new Error("scrap.tf did not finish loading the Buy Hats page.");
  emitTradeAutomationStatus(`scrap.tf batch ${batchNumber}: selecting ${remaining} ${job.name} and pressing the cart button…`);

  let selection=null;
  const pageDeadline=Date.now()+45000;
  while(Date.now()<pageDeadline){
    if(!await tabStillExists(tab.id))throw new Error("The scrap.tf tab closed before the item could be selected.");
    selection=await getTabMessageWithRetry(tab.id,{
      type:"SCRAP_BUY",
      name:job.name,
      quantity:remaining,
      maxScrapValue:job.maxScrapValue
    },10000);
    if(selection?.status!=="not-ready")break;
    await sleep(1000);
  }
  if(!selection?.ok)throw new Error(selection?.reason||"scrap.tf could not select the item.");
  const amount=Math.max(1,Number(selection.selected)||1);
  emitTradeAutomationStatus(`scrap.tf batch ${batchNumber}: ${amount} ${job.name} added to the cart. Waiting for scrap.tf to prepare the trade…`);

  let succeeded=false;
  try{
    const startedAt=Date.now();
    const deadline=startedAt+SCRAP_QUEUE_TIMEOUT_MS;
    let lastText="";
    let sawQueue=false;
    let offerId="";
    while(Date.now()<deadline){
      if(!await tabStillExists(tab.id))throw new Error("The scrap.tf tab closed before the trade offer was ready.");
      let state=null;
      try{state=await msgTab(tab.id,{type:"SCRAP_QUEUE_STATE"})}
      catch(error){await sleep(500);continue}
      if(state?.status==="error")throw new Error(`scrap.tf reported: ${state.text}`);
      if(state?.status==="ready"){
        sawQueue=true;
        offerId=String(state.offerId||"");
        break;
      }
      if(state?.status==="processing"||state?.status==="confirming"){
        sawQueue=true;
        const text=state.status==="confirming"?"scrap.tf is confirming the trade…":(state.text||"");
        if(text&&text!==lastText){
          lastText=text;
          emitTradeAutomationStatus(`scrap.tf batch ${batchNumber}: ${text}`);
        }
      }else if(!sawQueue&&Date.now()-startedAt>SCRAP_IDLE_TIMEOUT_MS){
        throw new Error("scrap.tf never started preparing the trade after the cart button was pressed.");
      }
      await sleep(700);
    }
    if(!sawQueue)throw new Error("scrap.tf did not start the trade.");
    if(!offerId){
      // The page's offer id was not readable: take the new offer Steam lists.
      const lookupDeadline=Date.now()+30000;
      while(!offerId&&Date.now()<lookupDeadline){
        try{
          const fresh=(await fetchSteamReceivedOffers(apiKey))
            .filter(offer=>!knownOffers.has(String(offer.tradeofferid))&&[2,9].includes(Number(offer.trade_offer_state)))
            .sort((a,b)=>Number(b.time_created||0)-Number(a.time_created||0));
          if(fresh.length)offerId=String(fresh[0].tradeofferid);
        }catch(error){console.warn("Could not look for the scrap.tf offer:",error)}
        if(!offerId)await sleep(2000);
      }
    }
    if(!/^\d+$/.test(offerId))throw new Error("scrap.tf said the trade is ready, but its Steam offer could not be identified.");
    succeeded=true;
    emitTradeAutomationStatus(`scrap.tf batch ${batchNumber}: trade ready, Steam offer #${offerId} for ${amount} ${job.name}. Opening it now…`);
    return {amount,offerUrl:new URL(`https://steamcommunity.com/tradeoffer/${offerId}/`)};
  }finally{
    // Leave nothing queued on scrap.tf when this attempt did not finish.
    if(!succeeded)await cancelScrapQueue(tab.id);
  }
}

async function acceptStnPurchaseBatch(job,batchNumber,batchAmount,rawOfferUrl,steamApiKey){
  const purchaseOfferUrl=validSteamIncomingTradeUrl(rawOfferUrl);
  if(!purchaseOfferUrl)throw new Error(`STN returned an unsupported Steam offer for purchase batch ${batchNumber}.`);
  purchaseOfferUrl.hash="";
  const purchaseOfferId=purchaseOfferUrl.pathname.match(/^\/tradeoffer\/(\d+)\/?$/i)?.[1]||"";
  if(!purchaseOfferId)throw new Error(`STN's purchase batch ${batchNumber} did not include a valid Steam trade-offer ID.`);

  job.step="waiting-for-purchase-acceptance";
  job.purchaseOfferId=purchaseOfferId;
  job.purchasePageProgress=null;
  delete job.purchaseAcceptedOfferId;
  delete job.purchaseNeedsConfirmationOfferId;
  job.purchaseOfferIds=[...(job.purchaseOfferIds||[]),purchaseOfferId];
  setSteamApiPurchaseProgress(
    job,
    "steam-api-polling",
    `Batch ${batchNumber}: opening Steam offer #${purchaseOfferId} and waiting for Steam Web API to confirm it as Accepted (state 3); mobile confirmation remains manual.`
  );
  if(Number.isInteger(job.transactionTabId))job.purchaseTabId=job.transactionTabId;
  const {tab:purchaseTab,loaded}=await openJobTransactionPage(job,purchaseOfferUrl.href,30000);
  job.purchaseTabId=purchaseTab.id;
  if(!loaded)throw new Error(`Steam did not finish loading purchase batch ${batchNumber}'s offer (#${purchaseOfferId}).`);
  const stopWatchdog=startPurchaseAcceptanceWatchdog(job,purchaseOfferId);
  // middle1 = another STN bot trade is still coming, middle2 = this was the
  // last one. It plays the moment the accept goes through on the offer page
  // (when you can confirm it), not later when the Web API catches up.
  const isLastBatch=(Number(job.purchasedQuantity)||0)+batchAmount>=job.quantity;
  const acceptSound=startPurchaseAcceptedSound(job,isLastBatch?"middle2.wav":"middle1.wav");
  try{
    await waitForSteamOfferAccepted(job,purchaseOfferId,steamApiKey);
    // Fallback for an offer accepted some other way (for example by hand).
    acceptSound.playNow();
  }finally{
    stopWatchdog();
    acceptSound.stop();
  }
  if(job.purchaseOfferId===purchaseOfferId)delete job.purchaseOfferId;
  delete job.purchaseTabId;
  return purchaseOfferId;
}

// Page progress that proves Steam really accepted the offer (its accept request
// succeeded), as opposed to the Accept button merely having been clicked.
const PURCHASE_ACCEPTANCE_EVIDENCE_PHASES=new Set(["steam-accepted","steam-accepted-observed","mobile-confirmation-pending"]);
const PURCHASE_ACCEPT_STALL_MS=90000;
const PURCHASE_ACCEPT_MAX_RELOADS=2;

// Plays `file` once, as soon as the offer page proves Steam accepted the
// offer (the same evidence phases the watchdog uses). playNow() plays it if it
// has not played yet; stop() cancels it without playing.
function startPurchaseAcceptedSound(job,file){
  let done=false;
  const play=()=>{
    if(done)return;
    done=true;
    playTradeMilestoneSound(file);
  };
  (async()=>{
    while(!done){
      await sleep(200);
      if(done)break;
      if(PURCHASE_ACCEPTANCE_EVIDENCE_PHASES.has(job.purchasePageProgress?.phase||""))play();
    }
  })().catch(()=>{});
  return {playNow:play,stop(){done=true}};
}

// While the Web API wait runs, make sure the offer page really accepts the
// offer. If it shows no proof of acceptance (the click was ignored, or the page
// gave up), reload the offer page so it tries again. Steam Web API polling stays
// the final authority, including when you accept the offer yourself.
function startPurchaseAcceptanceWatchdog(job,offerId){
  let stopped=false;
  let reloads=0;
  let lastAttemptAt=Date.now();
  (async()=>{
    while(!stopped){
      await sleep(2000);
      if(stopped)break;
      const phase=job.purchasePageProgress?.phase||"";
      if(PURCHASE_ACCEPTANCE_EVIDENCE_PHASES.has(phase))break;
      const failed=phase==="acceptance-failed";
      const stalled=Date.now()-lastAttemptAt>=PURCHASE_ACCEPT_STALL_MS;
      if(!failed&&!stalled)continue;
      if(reloads>=PURCHASE_ACCEPT_MAX_RELOADS){
        emitTradeAutomationStatus(`Steam offer #${offerId} still shows no sign of being accepted after ${reloads} page reloads. Accept it yourself in the scanner window if needed; Steam Web API polling continues.`);
        break;
      }
      const tabId=job.purchaseTabId;
      if(!Number.isInteger(tabId)||!await tabStillExists(tabId))break;
      reloads++;
      lastAttemptAt=Date.now();
      job.purchasePageProgress=null;
      emitTradeAutomationStatus(`Steam offer #${offerId} was not accepted by the page yet. Reloading the offer page to try again (${reloads}/${PURCHASE_ACCEPT_MAX_RELOADS})…`);
      try{await reloadTab(tabId)}catch(error){console.warn("Could not reload the purchase offer page:",error)}
    }
  })().catch(error=>console.warn("Purchase acceptance watchdog stopped:",error));
  return ()=>{stopped=true};
}

function buildBotOfferUrl(listing,itemName,jobId,excludedAssetIds=[]){
  const url=validSteamNewTradeUrl(listing?.tradeUrl);
  if(!url)throw new Error(`No valid Steam trade-offer URL is available for ${listing?.listingName||"a profitable listing"}.`);
  const payload=new URLSearchParams({
    tmt_listing:"1",
    tmt_name:itemName,
    tmt_price:String(listing.price||""),
    tmt_intent:"buy",
    tmt_comment:String(listing.comment||""),
    tmt_description:String(listing.description||listing.comment||""),
    tmt_quantity:String(listingItemQuantity(listing)),
    tmt_arb_job:jobId
  });
  // The item's quality and whether it is a cosmetic let the offer page use
  // Steam's Quality (and Cosmetic) filters when searching the inventory.
  const spec=getBackpackSpec(itemName);
  payload.set("tmt_quality",spec.quality||"Unique");
  payload.set("tmt_cosmetic",NON_COSMETIC_ITEM_PATTERN.test(spec.itemName||itemName)?"0":"1");
  // Lets Metal Trader pay a key price in metal when the paying side has too
  // few physical keys.
  if(Number.isFinite(keyRate)&&keyRate>0)payload.set("tmt_key_rate",String(keyRate));
  // Items already placed in earlier offers of this job. Each offer must use
  // different copies, so the offer page skips these asset ids.
  const reserved=[...new Set((Array.isArray(excludedAssetIds)?excludedAssetIds:[]).map(String))]
    .filter(id=>/^\d{1,20}$/.test(id));
  if(reserved.length)payload.set("tmt_exclude_assets",reserved.join(","));
  url.hash=payload.toString();
  return url.href;
}

// Opens the Steam offer page for one bot listing and waits until Steam reports
// the offer as sent. Returns the asset ids it used and, when Steam reported it,
// the new offer's id.
async function sendBotOffer(job,listing,label,excludedAssetIds){
  const operationId=label.operationId||`${job.id}:listing:${label.index}`;
  const itemName=label.itemName||job.name;
  const offerUrl=buildBotOfferUrl(listing,itemName,operationId,excludedAssetIds);
  const listingQuantity=listingItemQuantity(listing);
  emitTradeAutomationStatus(`${label.verb} offer ${label.index}/${label.total} to ${listing.listingName||"a profitable bot"} for ${listingQuantity}× ${itemName}${excludedAssetIds.length?` (skipping ${excludedAssetIds.length} cop${excludedAssetIds.length===1?"y":"ies"} already used by other offers)`:""}…`);
  const sentPromise=waitForTradeEvent(operationId,"TRADE_LISTING_SENT",BOT_OFFER_TIMEOUT_MS);
  sentPromise.catch(()=>{});
  let offerTab=null;
  try{
    job.currentListingOperationId=operationId;
    if(Number.isInteger(job.transactionTabId))job.currentOfferTabId=job.transactionTabId;
    const opened=await openJobTransactionPage(job,offerUrl,30000);
    offerTab=opened.tab;
    job.currentOfferTabId=offerTab.id;
    if(!opened.loaded)throw new Error(`Steam offer page for ${listing.listingName||"the bot"} did not finish loading.`);
    const sentEvent=await waitForAutomationEvent(offerTab.id,sentPromise);
    const usedNow=(Array.isArray(sentEvent?.assetIds)?sentEvent.assetIds:[])
      .map(String)
      .filter(id=>/^\d{1,20}$/.test(id));
    const tradeOfferId=/^\d+$/.test(String(sentEvent?.tradeOfferId||""))?String(sentEvent.tradeOfferId):"";
    emitTradeAutomationStatus(`Offer ${label.index}/${label.total} sent to ${listing.listingName||"a profitable bot"} using ${usedNow.length||"unreported"} unique ${itemName} cop${usedNow.length===1?"y":"ies"}${usedNow.length?` (asset${usedNow.length===1?"":"s"} ${usedNow.join(", ")})`:""}${tradeOfferId?`, offer #${tradeOfferId}`:""}.`);
    return {usedNow,tradeOfferId};
  }finally{
    settleTradeEvent(`TRADE_LISTING_SENT:${operationId}`,null,new Error("This bot-offer attempt ended."));
    if(job.currentListingOperationId===operationId)delete job.currentListingOperationId;
    if(job.currentOfferTabId===offerTab?.id)delete job.currentOfferTabId;
  }
}

// ---- Mac confirmer -------------------------------------------------------
// A bot offer that reaches Steam state 9 (CreatedNeedsConfirmation) needs the
// Steam Mobile confirmation. When enabled, the add-on asks the small server in
// macConfirmer/ (running on a Mac with iPhone Mirroring) to accept it. Steam
// is still the judge: the offer leaving state 9 proves it worked.
const MAC_CONFIRM_RETRY_AFTER_MS=120000;
const MAC_CONFIRM_MAX_REQUESTS=3;
const MAC_CONFIRM_ERROR_BACKOFF_MS=30000;
const MAC_CONFIRM_MAX_ERRORS=5;
const MAC_CONFIRM_POLL_MS=5000;
let macConfirmerReportedPause="";

async function loadMacConfirmerSettings(){
  const stored=isFirefoxBrowserApi
    ?await api.storage.local.get({macConfirmer:{}})
    :await new Promise((resolve,reject)=>api.storage.local.get({macConfirmer:{}},value=>{
        const error=api.runtime.lastError;
        if(error)reject(new Error(error.message));else resolve(value);
      }));
  const saved=stored?.macConfirmer||{};
  const url=String(saved.url||"").trim().replace(/\/+$/,"");
  const token=String(saved.token||"").trim();
  return {enabled:Boolean(saved.enabled)&&/^https?:\/\//i.test(url)&&Boolean(token),url,token};
}

// Asks the Mac confirmer server to bring iPhone Mirroring back to the front
// (POST /focus). Used right after the scanner window opens, which comes up on
// top of it. Does nothing when the Mac confirmer is not set up, and a failure
// is never an error for the scan.
async function refocusIPhoneMirroring(){
  try{
    const settings=await loadMacConfirmerSettings();
    if(!settings.enabled)return;
    // Firefox finishes bringing its new window forward a moment after it exists.
    await sleep(1200);
    await macConfirmerFetch(settings,"/focus",{});
  }catch(error){console.warn("Could not ask the Mac to focus iPhone Mirroring:",error)}
}

async function macConfirmerFetch(settings,path,body){
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),8000);
  try{
    const response=await fetch(`${settings.url}${path}`,{
      method:body?"POST":"GET",
      headers:{"X-Confirm-Token":settings.token,...(body?{"Content-Type":"application/json"}:{})},
      body:body?JSON.stringify(body):undefined,
      cache:"no-store",
      credentials:"omit",
      signal:controller.signal
    });
    let payload={};
    try{payload=await response.json()}catch{}
    return {status:response.status,payload};
  }finally{
    clearTimeout(timeout);
  }
}

// Asks the Mac to confirm every tracked offer that is waiting in state 9.
// Offers are asked for once; if one is still in state 9 after two minutes the
// request is repeated (at most MAC_CONFIRM_MAX_REQUESTS times).
// `entries` defaults to the tracked bot offers; the STN purchase offer passes
// its own entry, since it is accepted from the STN side and never tracked there.
async function requestMacConfirmations(entries=[...trackedBotOffers.values()]){
  const waiting=entries.filter(entry=>entry.needsConfirmation&&entry.offerId);
  if(!waiting.length)return;
  let settings;
  try{settings=await loadMacConfirmerSettings()}
  catch(error){console.warn("Could not read the Mac confirmer settings:",error);return}
  if(!settings.enabled)return;

  // The Mac works on a request after answering it, so a failed click run only
  // shows up in its status. Say so, instead of leaving the offer silently waiting.
  if(waiting.some(entry=>entry.macRequestedAt)){
    try{
      const {payload}=await macConfirmerFetch(settings,"/status");
      const reason=payload?.paused||"";
      if(reason&&reason!==macConfirmerReportedPause){
        macConfirmerReportedPause=reason;
        emitTradeAutomationStatus(`The Mac confirmer stopped without confirming: ${reason}. Check its output (the terminal or ~/Library/Logs/TF2Trader.log), fix it, then resume it (POST /resume) or restart the browser. Confirm on your phone meanwhile.`);
      }else if(!reason)macConfirmerReportedPause="";
    }catch(error){/* the request below reports connection problems */}
  }

  const now=Date.now();
  const due=waiting.filter(entry=>{
    if(entry.macErrorAt&&now-entry.macErrorAt<MAC_CONFIRM_ERROR_BACKOFF_MS)return false;
    if((entry.macErrors||0)>=MAC_CONFIRM_MAX_ERRORS)return false;
    if(!entry.macRequestedAt)return true;
    return now-entry.macRequestedAt>=MAC_CONFIRM_RETRY_AFTER_MS&&(entry.macRequests||0)<MAC_CONFIRM_MAX_REQUESTS;
  });
  for(const retry of [false,true]){
    const group=due.filter(entry=>Boolean(entry.macRequests)===retry);
    if(!group.length)continue;
    const ids=group.map(entry=>entry.offerId);
    try{
      const {status,payload}=await macConfirmerFetch(settings,"/confirm",{offerIds:ids,retry});
      if(status===202||status===200){
        for(const entry of group){entry.macRequestedAt=Date.now();entry.macRequests=(entry.macRequests||0)+1;entry.macErrors=0}
        const labelText=[...new Set(group.map(entry=>entry.label).filter(Boolean))].join(" and ");
        emitTradeAutomationStatus(payload?.duplicate
          ?`The Mac already has offer${ids.length===1?"":"s"} ${ids.map(id=>`#${id}`).join(", ")} queued.`
          :`Asked the Mac to confirm ${ids.length} offer${ids.length===1?"":"s"} (${ids.map(id=>`#${id}`).join(", ")}${labelText?`, ${labelText}`:""})${retry?" again":""}.${payload?.dryRun?" The Mac server is in DRY RUN mode, so nothing will be clicked; start the browser without --server-dry-run.":""}`);
        continue;
      }
      throw new Error(payload?.error||`the Mac server answered HTTP ${status}`);
    }catch(error){
      for(const entry of group){entry.macErrorAt=Date.now();entry.macErrors=(entry.macErrors||0)+1}
      const message=error?.name==="AbortError"?"the Mac did not answer within 8 seconds":String(error?.message||error);
      emitTradeAutomationStatus(`Could not ask the Mac to confirm ${ids.map(id=>`#${id}`).join(", ")}: ${message}. Confirm on your phone if this keeps failing.`);
    }
  }
}

function trackSentBotOffer(entry){
  const offerId=/^\d+$/.test(String(entry.offerId||""))?String(entry.offerId):"";
  const assetIds=(Array.isArray(entry.assetIds)?entry.assetIds:[]).map(String);
  if(!offerId&&!assetIds.length){
    console.warn("A sent bot offer cannot be tracked: Steam reported neither its offer id nor its items.");
    return;
  }
  trackedBotOffers.set(offerId||`pending-${++botOfferTrackerSeq}`,{
    offerId,
    assetIds,
    itemName:entry.itemName,
    listing:entry.listing,
    windowId:entry.windowId,
    jobId:entry.jobId,
    resends:entry.resends||0,
    sentAt:Date.now()
  });
  // The running job's own listing is now counted through this tracked offer.
  if(activeTradeJob&&entry.listing){
    if(!activeTradeJob.trackedListingKeys)activeTradeJob.trackedListingKeys=new Set();
    activeTradeJob.trackedListingKeys.add(tradeListingKey(entry.itemName,entry.listing));
  }
  runBotOfferTracker();
}

function describeTrackedOffer(entry){
  return `${entry.offerId?`offer #${entry.offerId}`:"the offer"} to ${entry.listing?.listingName||"a bot"} for ${entry.itemName}`;
}

// Polls Steam for every sent bot offer until each one is accepted, ends in a
// final state, or must be sent again.
async function runBotOfferTracker(){
  if(botOfferTrackerRunning)return;
  botOfferTrackerRunning=true;
  let failures=0;
  try{
    const apiKey=await loadSteamWebApiKey();
    while(trackedBotOffers.size){
      let sent;
      try{
        sent=await fetchSteamSentOffers(apiKey);
        failures=0;
      }catch(error){
        failures++;
        if(!error.retryable||failures>=5){
          emitTradeAutomationStatus(`Stopped tracking sent bot offers: ${error.message||error}`);
          trackedBotOffers.clear();
          return;
        }
        await sleep(BOT_OFFER_TRACK_POLL_MS);
        continue;
      }
      const sentById=new Map(sent.map(offer=>[String(offer?.tradeofferid||""),offer]));
      for(const [key,entry] of [...trackedBotOffers]){
        if(!entry.offerId){
          // Steam did not report the new offer's id: find it by the items given.
          const known=new Set([...trackedBotOffers.values()].map(other=>other.offerId).filter(Boolean));
          const match=sent.find(offer=>!known.has(String(offer?.tradeofferid||""))&&
            (Array.isArray(offer?.items_to_give)?offer.items_to_give:[]).some(item=>entry.assetIds.includes(String(item?.assetid||""))));
          if(!match)continue;
          entry.offerId=String(match.tradeofferid);
        }
        let offer=sentById.get(entry.offerId);
        if(!offer){
          try{offer=await fetchSteamTradeOffer(apiKey,entry.offerId)||undefined}catch{}
        }
        const state=Number(offer?.trade_offer_state);
        if(Number.isSafeInteger(state)){
          if(entry.needsConfirmation&&state!==9&&entry.macRequestedAt){
            emitTradeAutomationStatus(`${describeTrackedOffer(entry)} left "waiting for confirmation" after the Mac was asked: Steam now reports ${STEAM_TRADE_OFFER_STATE_NAMES.get(state)||"another state"} (state ${state}).`);
          }
          entry.needsConfirmation=state===9;
          if(state===3||state===11){
            trackedBotOffers.delete(key);
            emitTradeAutomationStatus(`Steam reports ${describeTrackedOffer(entry)} as ${STEAM_TRADE_OFFER_STATE_NAMES.get(state)} (state ${state}). No longer tracking it.`);
            continue;
          }
          if(state===8){
            trackedBotOffers.delete(key);
            requestBotOfferResend(entry);
            continue;
          }
          if(STEAM_TRADE_OFFER_TERMINAL_STATES.has(state)){
            trackedBotOffers.delete(key);
            emitTradeAutomationStatus(`Steam reports ${describeTrackedOffer(entry)} as ${STEAM_TRADE_OFFER_STATE_NAMES.get(state)} (state ${state}). It is not sent again.`);
            continue;
          }
        }
        if(Date.now()-entry.sentAt>=BOT_OFFER_TRACK_MAX_MS){
          trackedBotOffers.delete(key);
          emitTradeAutomationStatus(`Stopped tracking ${describeTrackedOffer(entry)}: it was still not accepted after ${Math.round(BOT_OFFER_TRACK_MAX_MS/3600000)} hours.`);
        }
      }
      await requestMacConfirmations().catch(error=>console.warn("Mac confirmer request failed:",error));
      if(!trackedBotOffers.size)break;
      // Look more often while offers wait for the Mac to confirm them.
      const confirming=[...trackedBotOffers.values()].some(entry=>entry.needsConfirmation&&entry.macRequestedAt);
      await sleep(confirming?MAC_CONFIRM_POLL_MS:BOT_OFFER_TRACK_POLL_MS);
    }
  }catch(error){
    trackedBotOffers.clear();
    emitTradeAutomationStatus(`Sent bot offers are not tracked, so failed ones will not be re-sent: ${error?.message||error}`);
  }finally{
    botOfferTrackerRunning=false;
  }
}

// Steam cancelled the offer because its items became unavailable; queue a
// fresh offer to the same bot ahead of other work.
function requestBotOfferResend(entry){
  if(entry.resends>=BOT_OFFER_MAX_RESENDS){
    emitTradeAutomationStatus(`Steam reports ${describeTrackedOffer(entry)} as InvalidItems (Items Now Unavailable For Trade) again. It was already re-sent ${entry.resends} times, so it is not sent again.`);
    return;
  }
  const job={
    id:`${entry.jobId}-resend${++botOfferTrackerSeq}`,
    resendOf:entry.offerId,
    resendCount:entry.resends+1,
    originalJobId:entry.jobId,
    name:entry.itemName,
    quantity:listingItemQuantity(entry.listing),
    offerCount:1,
    purchasedQuantity:0,
    listings:[entry.listing],
    backpackUrl:"",
    windowId:Number.isInteger(sourceWindowId)?sourceWindowId:entry.windowId,
    forceManual:true,
    skipPurchase:true,
    status:"queued"
  };
  tradeAutomationQueue.splice(resendQueueIndex(),0,job);
  emitTradeAutomationStatus(`Steam reports ${describeTrackedOffer(entry)} as InvalidItems (Items Now Unavailable For Trade). Re-sending it first, ahead of other queued trades (attempt ${job.resendCount}/${BOT_OFFER_MAX_RESENDS}).`);
  runTradeQueue();
}

// Re-sends go ahead of every normal trade but keep their own order.
function resendQueueIndex(){
  let index=0;
  while(index<tradeAutomationQueue.length&&tradeAutomationQueue[index].resendOf)index++;
  return index;
}

// `host` is the job whose transaction tab and state carry the send. A re-send
// that runs on its own is its own host; one run in the middle of another job
// borrows that job's tab so only one Steam page is ever in use.
async function executeResendJob(job,host=job){
  if(!Number.isInteger(host.windowId))throw new Error("The original Firefox window is no longer available for re-sending the offer.");
  host.step="sending-bot-offers";
  if(!Array.isArray(host.usedAssetIds))host.usedAssetIds=[];
  const listing=job.listings[0];
  // Other offers still waiting on the bot keep their own copies.
  const reserved=[...new Set([...trackedBotOffers.values()].flatMap(entry=>entry.assetIds))];
  const {usedNow,tradeOfferId}=await sendBotOffer(
    host,
    listing,
    {index:1,total:1,verb:"Re-sending",itemName:job.name,operationId:`${job.id}:listing:1`},
    reserved
  );
  if(host!==job)host.usedAssetIds=[...new Set([...host.usedAssetIds,...usedNow])];
  trackSentBotOffer({offerId:tradeOfferId,itemName:job.name,listing,assetIds:usedNow,windowId:job.windowId,jobId:job.originalJobId,resends:job.resendCount});
}

// A cancelled offer is re-sent as soon as the running job reaches a safe point
// (between STN batches or between bot offers) instead of waiting for the whole
// job to end.
async function runPendingResends(hostJob){
  if(hostJob.resendOf)return;
  for(;;){
    const index=tradeAutomationQueue.findIndex(job=>job.resendOf);
    if(index<0)return;
    const [resendJob]=tradeAutomationQueue.splice(index,1);
    const previousStep=hostJob.step;
    emitTradeAutomationStatus(`Re-sending the cancelled ${resendJob.name} offer before continuing ${hostJob.name}…`);
    try{
      await executeResendJob(resendJob,hostJob);
      emitTradeAutomationStatus(`Re-sent the offer for ${resendJob.name} that Steam cancelled (attempt ${resendJob.resendCount}). Continuing ${hostJob.name}.`);
    }catch(error){
      emitTradeAutomationStatus(`Could not re-send the offer for ${resendJob.name}: ${error.message||error}. Continuing ${hostJob.name}.`);
    }finally{
      hostJob.step=previousStep;
    }
  }
}

// ---- Raw key budget -----------------------------------------------------------
// STN and scrap.tf build their own Steam offers, and when the inventory does not
// hold exactly what a price asks for they convert metal into keys (or keys into
// metal) at their own, worse rate. The sites cannot be told what to take, so a
// key-priced item is only bought when the inventory holds enough raw keys for the
// key part of its price. When the keys do not cover the whole job the order
// changes from buy, buy, buy, sell, sell, sell to buy, sell, buy, sell: buy what
// the keys cover, sell it, wait until the sales have brought keys back, then buy
// the next part.
const TF2_KEY_ITEM_NAME="Mann Co. Supply Crate Key";
const KEY_POLL_MS=20000;
const KEY_READ_RETRY_MS=8000;
const KEY_READ_MAX_FAILURES=4;
const KEY_WAIT_MAX_MS=45*60*1000;
const KEY_WAIT_NOTE_MS=5*60*1000;
let ownSteamId="";

// The SteamID64 of the account signed in to steamcommunity.com in this browser.
async function findOwnSteamId(){
  if(/^\d{17}$/.test(ownSteamId))return ownSteamId;
  try{
    // steamLoginSecure starts with the SteamID64.
    const cookie=await api.cookies.get({url:"https://steamcommunity.com/",name:"steamLoginSecure"});
    const match=String(cookie?.value||"").match(/^(\d{17})/);
    if(match)return ownSteamId=match[1];
  }catch(error){console.warn("Could not read the Steam login cookie:",error)}
  const response=await fetch("https://steamcommunity.com/my/",{credentials:"include"});
  const fromUrl=response.url.match(/\/profiles\/(\d{17})/);
  if(fromUrl)return ownSteamId=fromUrl[1];
  const fromPage=(await response.text()).match(/"steamid"\s*:\s*"(\d{17})"/);
  if(fromPage)return ownSteamId=fromPage[1];
  throw new Error("could not find out which Steam account is signed in (sign in to steamcommunity.com in this browser)");
}

// How many tradable Mann Co. Supply Crate Keys the signed-in account holds.
async function fetchRawKeyCount(){
  const steamId=await findOwnSteamId();
  let keys=0;
  let startAssetId="";
  for(let page=0;page<10;page++){
    const url=new URL(`https://steamcommunity.com/inventory/${steamId}/440/2`);
    url.searchParams.set("l","english");
    url.searchParams.set("count","2000");
    if(startAssetId)url.searchParams.set("start_assetid",startAssetId);
    const response=await fetch(url.href,{credentials:"include",cache:"no-store"});
    if(response.status===429)throw new Error("Steam is rate limiting inventory requests (HTTP 429)");
    if(!response.ok)throw new Error(`Steam did not return the TF2 inventory (HTTP ${response.status})`);
    const data=await response.json();
    // Steam answers an empty inventory with null.
    if(data===null)return keys;
    if(!Array.isArray(data.assets))throw new Error("Steam returned an inventory page without items");
    const keyClasses=new Set((Array.isArray(data.descriptions)?data.descriptions:[])
      .filter(description=>description?.market_hash_name===TF2_KEY_ITEM_NAME&&Number(description.tradable)===1)
      .map(description=>`${description.classid}_${description.instanceid}`));
    for(const asset of data.assets){
      if(keyClasses.has(`${asset.classid}_${asset.instanceid}`))keys+=Math.max(1,Number(asset.amount)||1);
    }
    if(!data.more_items)return keys;
    startAssetId=String(data.last_assetid||"");
    if(!startAssetId)break;
  }
  return keys;
}

// Raw keys one item of the job costs (0 when its price has no key part).
function keysPerItem(job){
  const price=parsePrice(job?.buyPriceText);
  const keys=price?Number(price.keys):0;
  return Number.isFinite(keys)&&keys>0?Math.ceil(keys):0;
}

// The first `quantity` items of the listings, and the listings of the rest.
function splitListings(listings,quantity){
  const taken=limitListingsToQuantity(listings,quantity);
  let skip=totalListingItemQuantity(taken);
  const rest=[];
  for(const listing of Array.isArray(listings)?listings:[]){
    const requested=listingItemQuantity(listing);
    if(requested<=0)continue;
    if(skip>=requested){skip-=requested;continue}
    if(skip>0){
      rest.push({...listing,listedQuantity:listing.listedQuantity??requested,quantity:requested-skip});
      skip=0;
    }else{
      rest.push({...listing});
    }
  }
  return {taken,rest};
}

const keyPlural=count=>`${count} key${count===1?"":"s"}`;

// Decides how many of the `remaining` items may be bought next. Returns
//   {amount, limited}  buy `amount` now (limited: the keys cover fewer than remaining),
//   {sellFirst:true}   no key is free but items bought earlier are still unsold,
//   {stop:"reason"}    give up on the rest of this job.
// It reads the real key count from the Steam inventory first; when not even one
// item is affordable it waits for the bot offers that are still out to bring keys
// back.
async function planKeyPurchase(job,remaining){
  const perItem=keysPerItem(job);
  if(!perItem)return {amount:remaining,limited:false};
  const startedAt=Date.now();
  let lastNoteAt=0;
  let failures=0;
  for(;;){
    let keys;
    try{
      keys=await fetchRawKeyCount();
      failures=0;
    }catch(error){
      failures++;
      if(failures<KEY_READ_MAX_FAILURES){await sleep(KEY_READ_RETRY_MS);continue}
      return {amount:0,stop:`Could not read how many raw keys you hold (${error?.message||error}), so the rest of ${job.name} was not bought: it costs ${keyPlural(perItem)} each and the sites convert metal into keys at their own rate.`};
    }
    const affordable=Math.floor(keys/perItem);
    if(affordable>=1){
      const amount=Math.min(remaining,affordable);
      emitTradeAutomationStatus(`You hold ${keyPlural(keys)}; ${job.name} costs ${keyPlural(perItem)} each, so ${amount} of ${remaining} can be paid with raw keys now${amount<remaining?`. The other ${remaining-amount} are bought after the sales bring keys back (buy, sell, buy, sell)`:""}.`);
      return {amount,limited:amount<remaining};
    }
    if((Number(job.purchasedQuantity)||0)>(Number(job.soldQuantity)||0))return {amount:0,sellFirst:true};
    const salesPending=trackedBotOffers.size>0||tradeAutomationQueue.some(queued=>queued.resendOf);
    if(!salesPending){
      return {amount:0,stop:`You hold ${keyPlural(keys)} but ${job.name} costs ${keyPlural(perItem)} each, and no sale is waiting that could bring more, so the rest of it was not bought (the sites would convert metal into keys at their own rate).`};
    }
    if(Date.now()-startedAt>=KEY_WAIT_MAX_MS){
      return {amount:0,stop:`Still only ${keyPlural(keys)} after waiting ${Math.round(KEY_WAIT_MAX_MS/60000)} minutes for sales to bring keys back (${job.name} costs ${keyPlural(perItem)} each), so the rest of it was not bought.`};
    }
    if(!tradeAutomationEnabled&&!job.forceManual)return {amount:0,stop:`Automatic trading was turned off while waiting for keys; the rest of ${job.name} was not bought.`};
    if(Date.now()-lastNoteAt>=KEY_WAIT_NOTE_MS){
      lastNoteAt=Date.now();
      emitTradeAutomationStatus(`You hold ${keyPlural(keys)} and ${job.name} costs ${keyPlural(perItem)} each. Waiting for the sent bot offers to be accepted so their keys can pay for the next one…`);
    }
    await runPendingResends(job);
    await sleep(KEY_POLL_MS);
  }
}

// Opens the Backpack.tf pages of `listings`, highlights them and sends one bot
// offer per listing.
async function sellListings(job,listings){
  if(!listings.length)return;
  job.step="highlighting-profitable-listings";
  emitTradeAutomationStatus(`Opening Backpack.tf pages for ${listings.length} verified offers covering ${totalListingItemQuantity(listings)} items and highlighting each listing…`);
  // The Backpack.tf pages open in the scanner window, never in the main one.
  const backpackPages=await openAndHighlightBackpackPages(
    listings,
    job.name,
    job.backpackUrl,
    job.windowId,
    true,
    true
  );
  const backpackTabs=backpackPages.tabs;
  if(backpackPages.missing.length||backpackPages.errors.length){
    emitTradeAutomationStatus(
      `Highlighted ${backpackPages.highlighted}/${listings.length} verified Backpack.tf offers across ${backpackPages.pages} pages. Some listings were not present on their recorded page; continuing with the exact Steam offer links.`
    );
  }else{
    emitTradeAutomationStatus(`Highlighted all ${backpackPages.highlighted} verified Backpack.tf listings across ${backpackPages.pages} page${backpackPages.pages===1?"":"s"}.`);
  }
  try{
    job.step="sending-bot-offers";
    for(let index=0;index<listings.length;index++){
      // A cancelled offer is re-sent before the next new offer goes out.
      await runPendingResends(job);
      const listing=listings[index];
      const reservedAssets=[...new Set([...job.usedAssetIds,...[...trackedBotOffers.values()].flatMap(entry=>entry.assetIds)])];
      job.sendSeq=(Number(job.sendSeq)||0)+1;
      const {usedNow,tradeOfferId}=await sendBotOffer(job,listing,{index:index+1,total:listings.length,verb:"Sending",operationId:`${job.id}:listing:${job.sendSeq}`},reservedAssets);
      // Remember exactly which copies this offer used so no later offer
      // contains the same item.
      job.usedAssetIds=[...new Set([...job.usedAssetIds,...usedNow])];
      trackSentBotOffer({offerId:tradeOfferId,itemName:job.name,listing,assetIds:usedNow,windowId:job.windowId,jobId:job.id,resends:0});
    }
  }finally{
    await Promise.all(backpackTabs.map(async tab=>{
      await closeTabRobust(tab.id);
      transactionTabIds.delete(tab.id);
    }));
  }
}

// Sells the items of this job that were bought and not sold yet (all of the
// remaining listings when `all` is set: a job that uses existing inventory).
async function sellUnsold(job,all=false){
  const pending=Array.isArray(job.pendingListings)?job.pendingListings:[];
  const sold=Number(job.soldQuantity)||0;
  const quantity=all?totalListingItemQuantity(pending):Math.max(0,(Number(job.purchasedQuantity)||0)-sold);
  if(quantity<=0||!pending.length)return;
  const {taken,rest}=splitListings(pending,quantity);
  job.pendingListings=rest;
  job.soldQuantity=sold+totalListingItemQuantity(taken);
  await sellListings(job,taken);
  // All bot offers of the job have been sent.
  if(job.soldQuantity>=job.quantity)playTradeMilestoneSound("middle2.wav");
}

async function executeTradeJob(job){
  if(!Number.isInteger(job.windowId))throw new Error("The original Firefox window is no longer available for the trade workflow.");
  if(job.resendOf)return executeResendJob(job);
  job.purchasedQuantity=0;
  job.purchaseOfferIds=[];
  job.usedAssetIds=[];
  // Listings still to be sold, and how many items were already sold (see the raw
  // key budget above: with too few keys the job buys and sells in parts).
  job.pendingListings=job.listings.map(listing=>({...listing}));
  job.soldQuantity=0;
  job.sendSeq=0;
  job.keyLimited=false;
  const sellerLabel=job.source==="scrap.tf"?"scrap.tf":"STN";
  if(!job.skipPurchase){
    steamApiKey=await loadSteamWebApiKey();
    emitTradeAutomationStatus(`Checking Steam Web API access before buying from ${sellerLabel}…`);
    await fetchSteamReceivedOffers(steamApiKey);
    emitTradeAutomationStatus(`Steam Web API access is ready. ${sellerLabel} purchase offers will be verified by their exact numeric state.`);
  }
  if(job.skipPurchase){
    job.step="using-existing-inventory";
    emitTradeAutomationStatus(`Skipping ${sellerLabel} for ${job.name}. Checking existing inventory for ${job.quantity} items across ${job.listings.length} metal-verified offers…`);
  }else{
    let batchNumber=0;
    while(job.purchasedQuantity<job.quantity){
      const stillWanted=job.quantity-job.purchasedQuantity;
      // Key-priced items are only bought with raw keys: how many can be paid now?
      const plan=await planKeyPurchase(job,stillWanted);
      if(plan.stop){
        job.keyShortage=plan.stop;
        emitTradeAutomationStatus(plan.stop);
        break;
      }
      if(plan.sellFirst){
        job.keyLimited=true;
        emitTradeAutomationStatus(`Not enough raw keys for another ${job.name} yet. Selling the ${(Number(job.purchasedQuantity)||0)-(Number(job.soldQuantity)||0)} already bought first, then buying the rest once their keys are back.`);
        await sellUnsold(job);
        continue;
      }
      if(plan.limited)job.keyLimited=true;
      batchNumber++;
      const remaining=plan.amount;
      job.purchaseProgress=null;
      job.purchaseOfferId="";
      job.purchaseTabId=null;
      job.step=job.source==="scrap.tf"?"scrap.tf-purchase":"stn-purchase";
      emitTradeAutomationStatus(job.source==="scrap.tf"
        ?`Buying ${remaining} remaining ${job.name} on scrap.tf…`
        :`Reading STN QuickBuy quantities for ${remaining} remaining ${job.name}…`);
      let purchaseBatch=null;
      // The previous batch (or item) was accepted before this point; scrap.tf
      // still gets a few seconds before it is asked for another trade.
      if(job.source==="scrap.tf")await waitForScrapRequestGap();
      for(let attempt=1;!purchaseBatch;attempt++){
        try{
          purchaseBatch=job.source==="scrap.tf"
            ?await openScrapPurchaseBatch(job,batchNumber,remaining,steamApiKey)
            :await openStnPurchaseBatch(job,batchNumber,remaining);
        }catch(error){
          // STN refused the request before creating any offer (for example
          // "Some items in your selection were reserved by other users"), so
          // nothing was bought and asking again with a fresh page is safe.
          if(!error?.stnRetryable||attempt>=3)throw error;
          emitTradeAutomationStatus(`${sellerLabel} batch ${batchNumber} was not accepted (${String(error.message||error).slice(0,160)}). Reloading ${sellerLabel} and trying again (${attempt}/2)…`);
          await sleep(4000*attempt);
        }
      }
      emitTradeAutomationStatus(`${sellerLabel} batch ${batchNumber}: ${sellerLabel} created Steam offer #${stnOfferIdFromUrl(purchaseBatch.offerUrl.href)} for ${purchaseBatch.amount} ${job.name}. Opening it now…`);
      let acceptedOfferId;
      try{
        acceptedOfferId=await acceptStnPurchaseBatch(job,batchNumber,purchaseBatch.amount,purchaseBatch.offerUrl,steamApiKey);
      }finally{
        // The gap before the next scrap.tf request counts from here.
        if(job.source==="scrap.tf")scrapLastActivityAt=Date.now();
      }
      job.purchasedQuantity+=purchaseBatch.amount;
      recordPurchase(job,purchaseBatch.amount,acceptedOfferId);
      // (The middle1/middle2 sound for this trade already played when the
      // accept went through, inside acceptStnPurchaseBatch.)
      emitTradeAutomationStatus(`Confirmed ${sellerLabel} batch ${batchNumber}: Steam Web API state 3 accepted ${job.purchasedQuantity}/${job.quantity} ${job.name} item${job.purchasedQuantity===1?"":"s"}.`);
      // Keys are short: sell what was just bought before buying the next part.
      if(job.keyLimited)await sellUnsold(job);
      // A cancelled bot offer takes priority over the next STN batch.
      await runPendingResends(job);
    }
  }

  // Sell what is still unsold (everything bought, or the whole job when it uses
  // existing inventory).
  await sellUnsold(job,job.skipPurchase);
}

// Every accepted purchase is kept (browser storage, key purchaseLog) so the
// popup's Bought tab can show how many hats were grabbed and from where.
let purchaseLogChain=Promise.resolve();
function recordPurchase(job,quantity,offerId){
  const entry={
    at:Date.now(),
    name:job.name,
    quantity:Math.max(1,Math.floor(Number(quantity))||1),
    source:job.source==="scrap.tf"?"scrap.tf":"stn",
    offerId:String(offerId||""),
    jobId:job.id,
    price:String(job.buyPriceText||""),
    sellPrice:String(job.sellPriceText||""),
    profitRef:Number.isFinite(job.profitRef)?job.profitRef:null,
    href:job.source==="scrap.tf"?String(job.scrapUrl||""):"",
    scrapValue:job.source==="scrap.tf"?(Number(job.maxScrapValue)||null):null
  };
  purchaseLogChain=purchaseLogChain.then(async()=>{
    const stored=await storageGet({purchaseLog:[]});
    const log=Array.isArray(stored.purchaseLog)?stored.purchaseLog:[];
    log.push(entry);
    const kept=log.slice(-1000);
    await storageSet({purchaseLog:kept});
    // A bought hat is saved (again, if it was removed) and counted in the saved list.
    await syncBoughtIntoSaved(kept,new Set([TF2SavedTrades.keyFor(entry.name)]));
  }).catch(error=>console.warn("Could not record the purchase:",error));
  return purchaseLogChain;
}

// Puts the hats in the purchase log into the saved list (the "Check saved items"
// scan). Hats that were bought before this existed are added once at start-up;
// afterwards only the item just bought is added, so an item the user removed
// from the saved list stays removed until it is bought again.
function syncBoughtIntoSaved(log,onlyKeys){
  savedTradesChain=savedTradesChain.then(async()=>{
    const key=TF2SavedTrades.STORAGE_KEY;
    const map=(await storageGet({[key]:{}}))[key]||{};
    const before=JSON.stringify(map);
    TF2SavedTrades.syncBought(map,log,onlyKeys);
    if(JSON.stringify(map)!==before)await storageSet({[key]:map});
  }).catch(error=>console.warn("Could not save the bought hats:",error));
  return savedTradesChain;
}
(async()=>{
  try{
    const stored=await storageGet({purchaseLog:[],boughtSavedBackfill:false});
    if(stored.boughtSavedBackfill)return;
    if(Array.isArray(stored.purchaseLog)&&stored.purchaseLog.length)await syncBoughtIntoSaved(stored.purchaseLog,null);
    await storageSet({boughtSavedBackfill:true});
  }catch(error){console.warn("Could not save the earlier purchases:",error)}
})();

async function runTradeQueue(){
  if(tradeWorkerRunning||(!tradeAutomationEnabled&&!tradeAutomationQueue.some(job=>job.forceManual)))return;
  tradeWorkerRunning=true;
  try{
    while(tradeAutomationQueue.length&&(tradeAutomationEnabled||tradeAutomationQueue[0]?.forceManual)){
      activeTradeJob=tradeAutomationQueue.shift();
      activeTradeJob.step="purchase";
      if(scanItemBusy){
        emitTradeAutomationStatus(`Waiting for the current scan item to finish before starting the trade for ${activeTradeJob.name} in the scanner window…`);
        await waitForScanIdle();
      }
      emitTradeAutomationStatus(`Starting queued trade for ${activeTradeJob.name}.`);
      try{
        await executeTradeJob(activeTradeJob);
        if(activeTradeJob.resendOf){
          emitTradeAutomationStatus(`Re-sent the offer for ${activeTradeJob.name} that Steam cancelled (attempt ${activeTradeJob.resendCount}). It is tracked until Steam reports it Accepted.`);
        }else if(activeTradeJob.keyShortage){
          emitTradeAutomationStatus(`${activeTradeJob.name} ended early: bought ${Number(activeTradeJob.purchasedQuantity)||0}/${activeTradeJob.quantity} and sent bot offers for ${Number(activeTradeJob.soldQuantity)||0}. The rest was left because of the raw key limit.`);
        }else{
          emitTradeAutomationStatus(`Submitted ${activeTradeJob.offerCount} distinct bot offer${activeTradeJob.offerCount===1?"":"s"} covering ${activeTradeJob.quantity} ${activeTradeJob.name} item${activeTradeJob.quantity===1?"":"s"}${activeTradeJob.skipPurchase?` using existing inventory (${activeTradeJob.source==="scrap.tf"?"scrap.tf":"STN"} skipped)`:` after accepting the full quantity from ${activeTradeJob.source==="scrap.tf"?"scrap.tf":"STN"}`}. Steam is watched for cancelled offers (Items Now Unavailable For Trade), which are sent again until accepted.`);
        }
      }catch(error){
        console.error("Arbitrage trade workflow failed:",error);
        if(activeTradeJob.resendOf){
          emitTradeAutomationStatus(`Could not re-send the offer for ${activeTradeJob.name}: ${error.message||error}`);
        }else{
          const purchased=Number(activeTradeJob.purchasedQuantity)||0;
          const purchaseNote=activeTradeJob.skipPurchase
            ?" STN was skipped; the trade used existing inventory."
            :purchased>0
              ?` STN purchase confirmed ${purchased}/${activeTradeJob.quantity} items${purchased<activeTradeJob.quantity&&!activeTradeJob.soldQuantity?"; no bot offers were sent because the full target was not met":""}.`
              :"";
          emitTradeAutomationStatus(`Stopped ${activeTradeJob.name} workflow:${purchaseNote} ${error.message||error}. Remaining bot offers for this item were not attempted.`);
        }
      }finally{
        const transactionTabId=activeTradeJob?.transactionTabId;
        if(Number.isInteger(transactionTabId)){
          await closeTabRobust(transactionTabId);
          await restoreAfterOfferTab(transactionTabId);
          transactionTabIds.delete(transactionTabId);
          if(activeTradeJob?.transactionTabId===transactionTabId)delete activeTradeJob.transactionTabId;
        }
        activeTradeJob=null;
        // If the scanner window had to be raised for this trade, give focus back.
        await restoreMainWindowFocus();
      }
    }
  }finally{
    tradeWorkerRunning=false;
    if(tradeAutomationQueue.length&&(tradeAutomationEnabled||tradeAutomationQueue[0]?.forceManual))runTradeQueue();
    else{
      if(!tradeAutomationMessage)emitTradeAutomationStatus("No trades are running.");
      if(shutdownLauncherPending)shutDownLocalHelper().catch(()=>{});
      // Nothing left to trade: close the scanner window unless a scan still uses it.
      closeAutomationWindowIfIdle().catch(error=>console.warn("Could not close the idle scanner window:",error));
    }
  }
}

function normalizeTradeItemName(name){
  return String(name||"").normalize("NFKC").replace(/^the\s+/i,"").replace(/\s+/g," ").trim().toLowerCase();
}

function tradeListingKey(itemName,listing){
  return `${normalizeTradeItemName(itemName)}|${listingIdentity(listing)}`;
}

// How many copies of each listing (item + bot) already have an offer queued,
// being sent, or waiting for Steam to accept it (including cancelled ones
// waiting to be re-sent). A listing's remaining demand is its wanted quantity
// minus this.
function inFlightTradeQuantities(){
  const quantities=new Map();
  const add=(itemName,listing,quantity)=>{
    if(!listing||!(quantity>0))return;
    const key=tradeListingKey(itemName,listing);
    quantities.set(key,(quantities.get(key)||0)+quantity);
  };
  for(const entry of trackedBotOffers.values()){
    // The copies actually put in the offer; the listed quantity if unreported.
    add(entry.itemName,entry.listing,entry.assetIds?.length||listingItemQuantity(entry.listing));
  }
  for(const job of tradeAutomationQueue){
    for(const listing of job.listings||[])add(job.name,listing,listingItemQuantity(listing));
  }
  if(activeTradeJob){
    // Offers the running job already sent are counted above through tracking.
    // Once the job tracks its own unsold part (pendingListings), that part is
    // counted as it is; offers already sent are counted through tracking.
    if(Array.isArray(activeTradeJob.pendingListings)){
      for(const listing of activeTradeJob.pendingListings)add(activeTradeJob.name,listing,listingItemQuantity(listing));
    }else{
      const alreadyTracked=activeTradeJob.trackedListingKeys;
      for(const listing of activeTradeJob.listings||[]){
        if(alreadyTracked?.has(tradeListingKey(activeTradeJob.name,listing)))continue;
        add(activeTradeJob.name,listing,listingItemQuantity(listing));
      }
    }
  }
  return quantities;
}

// What was in flight when an item's offers were checked, so enqueueing only
// subtracts trades that started after that check.
const inFlightSnapshots=new WeakMap();

function enqueueTradeJob(result,options={}){
  const forceManual=options.forceManual===true;
  const skipPurchase=forceManual&&options.skipPurchase===true;
  const fromScrapTf=result?.source==="scrap.tf";
  const sellerLabel=fromScrapTf?"scrap.tf":"STN";
  if((!tradeAutomationEnabled&&!forceManual)||!result?.deal){
    return {ok:false,reason:"Automatic trade execution is not enabled for this result."};
  }
  const verifiedListings=sufficientOfferListings(result);
  if(!verifiedListings.length){
    const reason=`No price-profitable offer for ${result.name} was verified to have enough metal.`;
    emitTradeAutomationStatus(`Not queued ${result.name}: ${reason}`);
    return {ok:false,reason};
  }
  let listings=[];
  const seen=new Set();
  let missingOfferUrls=0;
  for(const entry of verifiedListings){
    const listing=entry;
    const url=validSteamNewTradeUrl(listing.tradeUrl);
    if(!url){missingOfferUrls++;continue}
    if(seen.has(url.href))continue;
    seen.add(url.href);
    listings.push({...listing});
  }
  if(missingOfferUrls){
    const reason=`${missingOfferUrls} verified listing${missingOfferUrls===1?" has":"s have"} no usable Steam offer link.`;
    emitTradeAutomationStatus(`Not queued ${result.name}: ${reason}`);
    return {ok:false,reason};
  }
  if(!listings.length){
    const reason="No verified bot listing had a valid Steam offer link.";
    emitTradeAutomationStatus(`Could not queue ${result.name}: ${reason}`);
    return {ok:false,reason};
  }
  // Trades that started after this item's offers were checked (the check
  // already left out everything that was in flight back then) reduce what is
  // still wanted from each listing.
  if(!forceManual){
    const inFlightNow=inFlightTradeQuantities();
    const snapshot=inFlightSnapshots.get(result)||new Map();
    const fresh=[];
    let skipped=0;
    for(const listing of listings){
      const key=tradeListingKey(result.name,listing);
      const newlyInFlight=Math.max(0,(inFlightNow.get(key)||0)-(snapshot.get(key)||0));
      const remaining=listingItemQuantity(listing)-newlyInFlight;
      if(remaining<=0){skipped++;continue}
      fresh.push(newlyInFlight?{...listing,listedQuantity:listing.listedQuantity??listingItemQuantity(listing),quantity:remaining}:listing);
    }
    if(skipped||fresh.some((listing,index)=>listing!==listings[index])){
      if(!fresh.length){
        const reason=`${skipped===1?"The only verified listing is":`All ${skipped} verified listings are`} already covered by trades in progress (queued, sending, waiting for Steam, or being re-sent after a cancellation).`;
        emitTradeAutomationStatus(`Not queued ${result.name}: ${reason}`);
        return {ok:false,reason,alreadyInFlight:true};
      }
      if(skipped)emitTradeAutomationStatus(`${result.name}: ${skipped} listing${skipped===1?" is":"s are"} already covered by trades in progress and skipped; queuing the other ${fresh.length}.`);
      listings=fresh;
    }
  }
  let quantity=totalListingItemQuantity(listings);
  const stockValue=result.sourceItem?.stock;
  const stock=stockValue===null||stockValue===undefined||stockValue===""?NaN:Number(stockValue);
  let stockLimited=false;
  if(!skipPurchase&&Number.isFinite(stock)&&stock>=0&&stock<quantity){
    const availableStock=Math.floor(stock);
    listings=limitListingsToQuantity(listings,availableStock);
    quantity=totalListingItemQuantity(listings);
    stockLimited=true;
    if(quantity<=0){
      const reason=`${sellerLabel} currently has no stock available for this item.`;
      emitTradeAutomationStatus(`Not queued ${result.name}: ${reason}`);
      return {ok:false,reason};
    }
    emitTradeAutomationStatus(`${sellerLabel} stock is limited to ${availableStock}; reducing this job to ${quantity} item${quantity===1?"":"s"} and selling only that available quantity across the verified bot listings.`);
  }
  const offerCount=listings.length;
  const job={
    id:`arb-${Date.now()}-${Math.random().toString(36).slice(2,9)}`,
    name:result.name,
    quantity,
    offerCount,
    purchasedQuantity:0,
    listings,
    backpackUrl:result.backpackUrl||"",
    windowId:sourceWindowId,
    forceManual,
    skipPurchase,
    source:fromScrapTf?"scrap.tf":"stn",
    scrapUrl:fromScrapTf?String(result.sourceItem?.href||""):"",
    maxScrapValue:fromScrapTf?Number(result.sourceItem?.scrapValue)||null:null,
    buyPriceText:String(result.sourceItem?.price||result.buyPrice?.display||""),
    sellPriceText:String(result.sellPrice?.display||""),
    profitRef:Number.isFinite(result.profitRef)?result.profitRef:null,
    status:"queued"
  };
  tradeAutomationQueue.push(job);
  const profitableCount=Number(result.priceProfitableListingCount??result.profitableListingCount??result.profitableListings?.length)||offerCount;
  const profitableItemCount=Number(result.priceProfitableItemCount??totalListingItemQuantity(result.profitableListings))||quantity;
  emitTradeAutomationStatus(skipPurchase
    ?`Manual Auto trade queued for ${result.name}: ${offerCount} verified sufficient offer${offerCount===1?"":"s"} covering ${quantity} items. ${sellerLabel} purchase skipped; existing TF2 items will be used.`
    :`Queued ${result.name}: ${profitableCount} price-profitable listing${profitableCount===1?"":"s"} covering up to ${profitableItemCount} items; ${offerCount} verified sufficient offer${offerCount===1?"":"s"} cover ${quantity} items${stockLimited?" (limited to current ${sellerLabel} stock)":""}. Buy that quantity and send the listed amount to each verified trader.`);
  runTradeQueue();
  return {ok:true,quantity,offerCount,jobId:job.id};
}

// Items that are not cosmetics skip the "Type: Cosmetic" filter (keys, tickets,
// crates and similar). Applying the filter to a non-cosmetic only hides it, so
// an unrecognized item is merely not recognized as already owned.
const NON_COSMETIC_ITEM_PATTERN=/\b(?:keys?|tickets?|crates?|cases?|tags?|strangifiers?|killstreak|kits?|medals?|paints?|taunts?)\b/i;

async function inspectListingTradeOffer(listing,requiredRef,itemCheck=null,keyPayment=null){
  const rawUrl=String(listing?.tradeUrl||"").trim();
  if(!rawUrl)return {status:"unverified",reason:"No Steam trade-offer URL was found on this listing."};
  let url;
  try{
    url=new URL(rawUrl);
    if(url.protocol!=="https:"||url.hostname!=="steamcommunity.com"||!/^\/tradeoffer\/new\/?$/i.test(url.pathname)){
      return {status:"unverified",reason:"The listing's offer URL is not a supported Steam trade link."};
    }
  }catch(error){
    return {status:"unverified",reason:`The listing's offer URL is invalid: ${String(error?.message||error)}`};
  }
  const verifyParams=new URLSearchParams({
    tmt_verify:"1",
    tmt_required_ref:String(requiredRef)
  });
  // Tells Metal Trader which item the trader wants and how many, so it can
  // first check whether the trader already holds that many (a bad trader).
  if(itemCheck?.itemName&&Number.isSafeInteger(itemCheck.wanted)&&itemCheck.wanted>=1){
    verifyParams.set("tmt_item",itemCheck.itemName);
    verifyParams.set("tmt_wanted",String(itemCheck.wanted));
    verifyParams.set("tmt_quality",itemCheck.quality||"Unique");
    if(itemCheck.cosmetic)verifyParams.set("tmt_cosmetic","1");
  }
  // A key price is paid with the trader's physical keys when they hold them,
  // so the metal check only asks for metal for the keys they lack. Metal Trader
  // counts the trader's keys and lowers the metal it needs by that many keys.
  if(Number.isSafeInteger(keyPayment?.keys)&&keyPayment.keys>0&&Number.isFinite(keyPayment.rate)&&keyPayment.rate>0){
    verifyParams.set("tmt_keys",String(keyPayment.keys));
    verifyParams.set("tmt_key_rate",String(keyPayment.rate));
  }
  url.hash=verifyParams.toString();

  let tab=null;
  try{
    // Steam does not reliably initialize the other trader's inventory in a
    // background tab, so the offer is the active tab of the main window
    // (the previously active tab comes back when the check is over).
    tab=await createOfferTab(url.href);
    if(!Number.isInteger(tab?.id))throw new Error("Browser did not return an offer tab ID.");
    ownedTabIds.add(tab.id);
    ownedTabUrls.set(tab.id,url.href);

    // Polled every 250 ms (not 1 s) so the check starts as soon as Steam is done.
    const loaded=await waitForTabComplete(tab.id,30000,250);
    if(!loaded)throw new Error(running?"Steam offer page did not finish loading.":"Offer check stopped with the scan.");

    if(!running)return {status:"unverified",url:url.href,reason:"Offer checking stopped with the scan."};
    await ensureScanTabVisible(tab.id);
    if(!running)return {status:"unverified",url:url.href,reason:"Offer checking stopped with the scan."};
    const message={type:"READ_TRADE_OFFER_METAL",requiredRef};
    let response=null;
    const messageDeadline=Date.now()+15000;
    while(running&&Date.now()<messageDeadline&&!response){
      try{response=await msgTab(tab.id,message)}
      catch(error){await sleep(120)}
    }
    if(!response){
      return {
        status:"unverified",
        url:url.href,
        reason:running
          ?"The arbitrage content script did not become ready to request a trader-inventory check."
          :"Offer checking stopped with the scan."
      };
    }
    if(response?.status!=="checked"){
      return {status:"unverified",url:url.href,reason:response.reason||"TF2 Metal Trader could not inspect the trader's inventory."};
    }

    return {
      status:"checked",
      url:url.href,
      offeredRef:response.availableRef,
      counts:response.counts||{},
      items:response.items||0,
      badTrader:response.badTrader===true,
      keysUsed:Number(response.keysUsed)||0,
      keysNeeded:Number(response.keysNeeded)||0,
      ownedCopies:Number(response.ownedCopies)||0,
      wantedCopies:Number(response.wantedCopies)||0
    };
  }catch(error){
    return {
      status:"unverified",
      url:url.href,
      reason:`Could not open/read this Steam offer: ${String(error?.message||error)}`
    };
  }finally{
    if(Number.isInteger(tab?.id)){
      await closeTabRobust(tab.id);
      await restoreAfterOfferTab(tab.id);
    }
  }
}

// How many metal-verified trades are worth finding for an item: the STN stock
// (how many can be bought) plus one spare. Verification stops as soon as that
// many offers are confirmed. Unknown stock means every offer is checked.
function verificationTradeLimit(result){
  const raw=result?.sourceItem?.stock;
  const stock=raw===null||raw===undefined||raw===""?NaN:Number(raw);
  if(!Number.isFinite(stock)||stock<0)return Infinity;
  return Math.floor(stock)+1;
}

async function verifyProfitableListings(result){
  const candidates=Array.isArray(result?.profitableListings)?result.profitableListings:[];
  const inspectionCache=new Map();
  result.priceProfitableListingCount=candidates.length;
  result.priceProfitableItemCount=totalListingItemQuantity(candidates);
  result.offerChecks=[];
  const tradeLimit=verificationTradeLimit(result);
  let sufficientTrades=0;
  result.skippedListingCount=0;
  result.offerCheckLimit=Number.isFinite(tradeLimit)?tradeLimit:null;
  // Trades already sent (or queued, or being sent) for this item. They are
  // taken off what each trader still wants, so a trader whose wanted amount is
  // already covered is not a good trade again.
  const inFlight=inFlightTradeQuantities();
  inFlightSnapshots.set(result,inFlight);
  result.alreadyTradingListingCount=0;

  for(let index=0;index<candidates.length;index++){
    // Offers are checked from the highest price down; once enough are verified
    // the rest are not worth opening in Steam.
    if(sufficientTrades>=tradeLimit){
      result.skippedListingCount=candidates.length-index;
      break;
    }
    let listing=candidates[index];
    const wantedQuantity=listingItemQuantity(listing);
    const coveredQuantity=Math.min(wantedQuantity,inFlight.get(tradeListingKey(result.name,listing))||0);
    if(coveredQuantity>=wantedQuantity){
      result.alreadyTradingListingCount++;
      result.offerChecks.push({...listing,verification:{
        status:"already-trading",
        quantity:wantedQuantity,
        requestedQuantity:wantedQuantity,
        alreadyTradingQuantity:coveredQuantity,
        reason:`Already trading: ${coveredQuantity} ${result.name} ${coveredQuantity===1?"is":"are"} already in offers to this trader (queued, sent, or waiting for Steam), which covers the ${wantedQuantity} they want. Not checked again.`
      }});
      continue;
    }
    if(coveredQuantity>0){
      // Only what is still missing is checked and traded.
      listing={...listing,listedQuantity:listing.listedQuantity??wantedQuantity,quantity:wantedQuantity-coveredQuantity};
    }
    popup({
      type:"OFFER_CHECK_PROGRESS",
      itemName:result.name,
      checked:index+1,
      total:candidates.length,
      itemQuantity:listingItemQuantity(listing),
      traderName:listing.listingName||"unknown trader"
    });
    if(!running){
      result.offerChecks.push({...listing,verification:{status:"unverified",reason:"Offer checking stopped with the scan."}});
      continue;
    }
    const price=parsePrice(listing.price);
    const quantity=listingItemQuantity(listing);
    if(!price){
      result.offerChecks.push({...listing,verification:{status:"unverified",reason:"Could not parse this listing's price."}});
      continue;
    }
    const requestedRef=price.refValue*quantity;
    const url=String(listing.tradeUrl||"").trim();
    // The trader wants `quantity` of this item (1 when their description does
    // not mention stock). The description's own stock already counts copies the
    // trader holds ("Stock: 4/5" = 4 held, 1 wanted), so a trader is only bad
    // when it holds that many MORE copies than its stock says.
    const spec=getBackpackSpec(result.name);
    const declaredStock=Number.isSafeInteger(listing.currentStock)&&listing.currentStock>0?listing.currentStock:0;
    const holdLimit=quantity+declaredStock;
    const itemCheck={
      itemName:spec.itemName,
      quality:spec.quality,
      wanted:holdLimit,
      cosmetic:!NON_COSMETIC_ITEM_PATTERN.test(spec.itemName)
    };
    const inspectionKey=`${url}|${requestedRef.toFixed(4)}|${itemCheck.wanted}`;
    let inspection;
    if(url&&inspectionCache.has(inspectionKey)){
      inspection=inspectionCache.get(inspectionKey);
    }else{
      inspection=await inspectListingTradeOffer(listing,requestedRef,itemCheck,{keys:price.keys*quantity,rate:keyRate});
      if(url)inspectionCache.set(inspectionKey,inspection);
    }
    if(inspection.status==="checked"&&inspection.badTrader){
      result.offerChecks.push({...listing,verification:{
        status:"bad-trader",
        url:inspection.url,
        requiredRef:requestedRef,
        requestedRef,
        unitPriceRef:price.refValue,
        quantity,
        requestedQuantity:quantity,
        ownedCopies:inspection.ownedCopies,
        wantedCopies:inspection.wantedCopies||holdLimit,
        declaredStock,
        reason:`Bad trader: already holds ${inspection.ownedCopies} ${itemCheck.itemName}${declaredStock?`, which reaches the ${declaredStock} its description already counts as stock plus the ${quantity} it wants`:`, which meets the ${quantity} it wants`}. Metal was not checked.`
      }});
      continue;
    }
    // When the full request is short, the check has staged the trader's
    // available metal. Queue only the largest whole quantity that amount can cover.
    let affordableQuantity=0;
    const offeredRef=Number(inspection.offeredRef);
    if(inspection.status==="checked"&&Number.isFinite(offeredRef)){
      affordableQuantity=price.refValue>0
        ?Math.min(quantity,Math.floor((offeredRef+0.0001)/price.refValue))
        :quantity;
      while(affordableQuantity>0&&offeredRef+0.0001<price.refValue*affordableQuantity){
        affordableQuantity--;
      }
    }
    const enough=affordableQuantity>0;
    const requiredRef=enough?price.refValue*affordableQuantity:requestedRef;
    const checkedListing=enough&&affordableQuantity<quantity
      ?{...listing,listedQuantity:listing.listedQuantity??quantity,quantity:affordableQuantity}
      :listing;
    const verification=inspection.status==="checked"
      ?{
        status:enough?"sufficient":"insufficient",
        url:inspection.url,
        requiredRef,
        requestedRef,
        unitPriceRef:price.refValue,
        quantity:enough?affordableQuantity:quantity,
        requestedQuantity:quantity,
        offeredRef:inspection.offeredRef,
        counts:inspection.counts,
        keysUsed:inspection.keysUsed,
        reason:(enough
          ?affordableQuantity<quantity
            ?`Trader inventory supports ${affordableQuantity} of ${quantity} requested items at ${price.refValue.toFixed(2)} ref each.`
            :`Trader inventory contains enough metal for ${quantity} item${quantity===1?"":"s"} at ${price.refValue.toFixed(2)} ref each.`
          :`Trader inventory has less metal than the single-item Buy Order price of ${price.refValue.toFixed(2)} ref.`)
          +(inspection.keysUsed>0?` The price's keys are paid with the trader's own keys (${inspection.keysUsed} of ${inspection.keysNeeded} counted); metal is only needed for the rest.`:"")
      }
      :{...inspection,requiredRef:requestedRef,unitPriceRef:price.refValue,quantity,requestedQuantity:quantity};
    result.offerChecks.push({...checkedListing,verification});
    if(verification.status==="sufficient")sufficientTrades++;
  }
  // If the scanner window had to be raised for Steam, give focus back now.
  await restoreMainWindowFocus();

  const verified=result.offerChecks
    .filter(entry=>entry.verification.status==="sufficient")
    .sort((a,b)=>(parsePrice(b.price)?.refValue||0)-(parsePrice(a.price)?.refValue||0));
  const unverified=result.offerChecks
    .filter(entry=>entry.verification.status==="unverified")
    .sort((a,b)=>(parsePrice(b.price)?.refValue||0)-(parsePrice(a.price)?.refValue||0));
  // A bad trader (already holds the item) or one whose wanted amount is already
  // covered by trades in progress is never a usable offer and must not make an
  // item count as a Good Trade through the multiple-listings override.
  const usableChecks=result.offerChecks.filter(entry=>entry.verification.status!=="bad-trader"&&entry.verification.status!=="already-trading");
  const initialBest=usableChecks[0]||candidates[0]||result.bestListing;
  result.verifiedProfitableListingCount=verified.length;
  result.verifiedProfitableItemCount=totalListingItemQuantity(verified);
  result.insufficientListingCount=result.offerChecks.filter(entry=>entry.verification.status==="insufficient").length;
  result.badTraderListingCount=result.offerChecks.filter(entry=>entry.verification.status==="bad-trader").length;
  result.unverifiedListingCount=unverified.length;
  result.bestListing=verified[0]||unverified[0]||initialBest;
  result.tradeOfferUrl=String(result.bestListing?.tradeUrl||"");
  result.verificationOverride=verified.length===0&&usableChecks.length>1;
  result.deal=verified.length>0||usableChecks.length>1;
  result.unverifiedDeal=!result.deal&&unverified.length>0;
  if(result.deal){
    const dealListing=verified[0]||initialBest;
    result.bestListing=dealListing;
    result.tradeOfferUrl=String(dealListing?.tradeUrl||"");
    result.sellPrice=parsePrice(dealListing.price);
    result.profitRef=result.sellPrice.refValue-result.buyPrice.refValue;
  }else{
    result.pricePotentialSellPrice=parsePrice(initialBest?.price)||result.sellPrice;
    result.pricePotentialProfitRef=result.pricePotentialSellPrice.refValue-result.buyPrice.refValue;
  }
}

function notifyHit(result){
  if(!result?.deal||!result.name)return;
  const key=`${String(result.name).toLowerCase()}|${result.profitRef.toFixed(4)}|${result.sellPrice?.display||""}`;
  if(notifiedDeals.has(key))return;
  notifiedDeals.add(key);
  const profit=result.profitRef.toFixed(2);
  const buy=result.buyPrice?.display||"unknown";
  const sell=result.sellPrice?.display||"unknown";
  const notificationId=`tf2-hit-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  notificationTargets.set(notificationId,result.sourceItem?.href||`https://stntrading.eu/item/tf2/${encodeURIComponent(result.name).replace(/%20/g,"+")}`);
  const options={
    type:"basic",
    title:result.source==="scrap.tf"?"🔥 SCRAP.TF ARBITRAGE HIT":"🔥 TF2 ARBITRAGE HIT",
    message:`${result.name}\n${buy} → ${sell}\nPROFIT: +${profit} ref`,
    iconUrl:api.runtime.getURL("hit-icon.png")
  };
  try{
    const created=api.notifications.create(notificationId,options);
    if(created&&typeof created.catch==="function")created.catch(()=>{});
  }catch(e){}
  playHitSound();
}
function playHitSound(){
  try{
    if(typeof Audio!=="undefined"){
      hitAudio=new Audio(api.runtime.getURL("hit.mp3"));
      hitAudio.volume=Math.max(0,Math.min(1,notificationVolume));
      const p=hitAudio.play();
      if(p&&typeof p.catch==="function")p.catch(()=>{});
    }
  }catch(e){}
}
// Trade sounds (hit.mp3, which announces a deal, is played elsewhere):
//   middle1.wav after each STN / scrap.tf trade when more of that purchase is still coming
//   middle2.wav after the last STN / scrap.tf trade, and after the last Backpack.tf offer
// The volume slider's saved value is read each time, so these sounds follow the
// slider even if the background script was restarted since it was moved.
async function playTradeMilestoneSound(file){
  try{
    if(typeof Audio==="undefined")return;
    try{
      const stored=await storageGet({notificationVolume});
      const saved=Number(stored?.notificationVolume);
      if(Number.isFinite(saved))notificationVolume=Math.max(0,Math.min(1,saved));
    }catch(e){}
    const audio=new Audio(api.runtime.getURL(file));
    audio.volume=Math.max(0,Math.min(1,notificationVolume));
    const p=audio.play();
    if(p&&typeof p.catch==="function")p.catch(()=>{});
  }catch(e){}
}
function playEndSound(){
  if(endSoundPlayed)return;
  endSoundPlayed=true;
  try{
    if(typeof Audio!=="undefined"){
      endAudio=new Audio(api.runtime.getURL("Item_metal_pot_drop.wav"));
      endAudio.volume=Math.max(0,Math.min(1,notificationVolume));
      const p=endAudio.play();
      if(p&&typeof p.catch==="function")p.catch(()=>{});
    }
  }catch(e){}
}
if(api.notifications?.onClicked){
  api.notifications.onClicked.addListener(id=>{
    const url=notificationTargets.get(id);
    if(!url)return;
    notificationTargets.delete(id);
    try{
      const p=createTab({url});
      if(p&&typeof p.catch==="function")p.catch(()=>{});
    }catch(e){}
  });
}
if(api.notifications?.onClosed){
  api.notifications.onClosed.addListener(id=>notificationTargets.delete(id));
}

function popup(m){
  try{
    const p=api.runtime.sendMessage(m);
    if(p&&typeof p.catch==="function")p.catch(()=>{});
  }catch(e){}
}
const isFirefoxBrowserApi=typeof browser!=="undefined";

// Firefox's `browser.*` APIs return Promises. Chrome-style callback wrappers
// are used only for the `chrome.*` API. Mixing the two is especially dangerous
// for tabs.create/update because the Promise never resolves and the scanner
// appears to stop before opening its Backpack.tf tab.
function qTabs(q){
  if(isFirefoxBrowserApi)return api.tabs.query(q);
  return new Promise((resolve,reject)=>api.tabs.query(q,t=>{const e=api.runtime.lastError;if(e){reject(new Error(e.message));return}resolve(t)}));
}
function createTab(p){
  if(isFirefoxBrowserApi)return api.tabs.create(p);
  return new Promise((resolve,reject)=>api.tabs.create(p,t=>{const e=api.runtime.lastError;if(e){reject(new Error(e.message));return}resolve(t)}));
}
function updateTab(id,p){
  if(isFirefoxBrowserApi)return api.tabs.update(id,p);
  return new Promise((resolve,reject)=>api.tabs.update(id,p,t=>{const e=api.runtime.lastError;if(e){reject(new Error(e.message));return}resolve(t)}));
}
function removeTab(id){
  if(isFirefoxBrowserApi)return api.tabs.remove(id);
  return new Promise((resolve,reject)=>api.tabs.remove(id,()=>{
    const e=api.runtime.lastError;
    if(e){reject(new Error(e.message));return}
    resolve();
  }));
}
function msgTab(id,m){
  if(isFirefoxBrowserApi)return api.tabs.sendMessage(id,m);
  return new Promise((resolve,reject)=>api.tabs.sendMessage(id,m,r=>{const err=api.runtime.lastError;if(err){reject(new Error(err.message));return}resolve(r)}));
}
function createWindow(p){
  if(isFirefoxBrowserApi)return api.windows.create(p);
  return new Promise((resolve,reject)=>api.windows.create(p,w=>{const e=api.runtime.lastError;if(e){reject(new Error(e.message));return}resolve(w)}));
}
function getWindow(id){
  if(isFirefoxBrowserApi)return api.windows.get(id);
  return new Promise((resolve,reject)=>api.windows.get(id,w=>{const e=api.runtime.lastError;if(e){reject(new Error(e.message));return}resolve(w)}));
}
function updateWindow(id,p){
  if(isFirefoxBrowserApi)return api.windows.update(id,p);
  return new Promise((resolve,reject)=>api.windows.update(id,p,w=>{const e=api.runtime.lastError;if(e){reject(new Error(e.message));return}resolve(w)}));
}
function removeWindow(id){
  if(isFirefoxBrowserApi)return api.windows.remove(id);
  return new Promise((resolve,reject)=>api.windows.remove(id,()=>{const e=api.runtime.lastError;if(e){reject(new Error(e.message));return}resolve()}));
}
// ---- Closing the browser -----------------------------------------------------
// Closing the user's Firefox window ends everything the add-on is doing: scans
// stop (the results so far stay saved), queued trades are dropped, the scanner
// window closes and the local confirm server is told to shut down, which makes
// browserShell/launch.py quit Firefox. Without this the scanner window kept
// Firefox alive (a Mac does not quit when its last window closes) and the scan went
// on without a main window. Windows the add-on closes itself are not mistaken for
// the user closing them.
const selfClosedWindowIds=new Set();
let shutdownLauncherPending=false;

async function stopScanningBecauseClosed(reason){
  const wasActive=running||scanItemBusy||queue.length>0;
  running=false;
  queue=[];
  sourceTabId=null;
  autoRescanContext=null;
  autoRescanToken++;
  if(wasActive)emitTradeAutomationStatus(`${reason} Scanning was stopped; the results so far are saved.`);
  try{await closeCurrentTab()}catch(error){}
  try{await closeAllOwnedTabs()}catch(error){}
  scanItemBusy=false;
  try{await saveState({running:false,queueLength:0})}catch(error){console.warn("Could not save the scan state:",error)}
  popup({type:"SCAN_FINISHED",checked,total});
}

// Asks the confirm server on this computer (started by the launcher) to stop.
// A trade that is still running finishes first.
async function shutDownLocalHelper(){
  if(isTradeWorkBusy()){
    shutdownLauncherPending=true;
    emitTradeAutomationStatus("The browser window was closed. The running trade finishes first; then the confirm server and the launcher shut down.");
    return;
  }
  shutdownLauncherPending=false;
  try{
    const settings=await loadMacConfirmerSettings();
    if(!settings.enabled||!/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(settings.url))return;
    await macConfirmerFetch(settings,"/shutdown",{});
  }catch(error){console.warn("Could not ask the local confirm server to shut down:",error)}
}

async function handleWindowClosed(id,wasScanner){
  if(wasScanner){
    // The user closed the scanner window by hand: stop scanning instead of
    // opening a new one. A running trade is left alone.
    if(running||scanItemBusy)await stopScanningBecauseClosed("The scanner window was closed.");
    return;
  }
  let others=[{}];
  try{others=(await api.windows.getAll({windowTypes:["normal"]})).filter(win=>win.id!==automationWindowId)}catch(error){}
  const browserClosed=others.length===0;
  const wasSource=id===sourceWindowId;
  if(!wasSource&&!browserClosed)return;
  if(wasSource)sourceWindowId=null;
  await stopScanningBecauseClosed(browserClosed?"The Firefox window was closed.":"The window the scan was started from was closed.");
  if(!browserClosed)return;
  const removed=tradeAutomationQueue.filter(job=>!job.resendOf).length;
  if(removed){
    tradeAutomationQueue=tradeAutomationQueue.filter(job=>job.resendOf);
    emitTradeAutomationStatus(`Dropped ${removed} queued item trade${removed===1?"":"s"} because the browser was closed.`);
  }
  await closeAutomationWindowIfIdle();
  await shutDownLocalHelper();
}

if(api.windows?.onRemoved){
  api.windows.onRemoved.addListener(id=>{
    if(selfClosedWindowIds.delete(id))return;
    const wasScanner=id===automationWindowId;
    if(wasScanner){
      automationWindowId=null;
      automationWindowRaised=false;
    }
    handleWindowClosed(id,wasScanner).catch(error=>console.warn("Could not handle the closed window:",error));
  });
}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function randomDelay(min,max){return Math.floor(min+Math.random()*(max-min+1))}
function parsePrice(text){
  const s=String(text||"").toLowerCase().replace(/,/g,"");
  const k=s.match(/([\d.]+)\s*keys?/),r=s.match(/([\d.]+)\s*ref/);
  if(!k&&!r)return null;
  const keys=k?+k[1]:0,ref=r?+r[1]:0;
  return {keys,ref,display:text,refValue:keys*keyRate+ref};
}
function listingItemQuantity(listing){
  const quantity=explicitListingItemQuantity(listing);
  return quantity===null?1:quantity;
}
function explicitListingItemQuantity(listing){
  const raw=listing?.quantity;
  if(raw===null||raw===undefined||raw==="")return null;
  const quantity=Number(raw);
  return Number.isSafeInteger(quantity)&&quantity>=0?quantity:null;
}
function totalListingItemQuantity(listings){
  return (Array.isArray(listings)?listings:[]).reduce((total,listing)=>total+listingItemQuantity(listing),0);
}
function limitListingsToQuantity(listings,maxQuantity){
  let remaining=Math.max(0,Math.floor(Number(maxQuantity)||0));
  const limited=[];
  for(const listing of Array.isArray(listings)?listings:[]){
    if(remaining<=0)break;
    const requested=listingItemQuantity(listing);
    if(requested<=0)continue;
    const quantity=Math.min(requested,remaining);
    limited.push(quantity<requested
      ?{...listing,listedQuantity:listing.listedQuantity??requested,quantity}
      :{...listing});
    remaining-=quantity;
  }
  return limited;
}
function listingIdentity(listing){
  const accountId=String(listing?.listingAccountId||"").trim();
  if(accountId)return `account:${accountId}`;
  const tradeUrl=String(listing?.tradeUrl||"").trim();
  if(tradeUrl){
    try{
      const url=new URL(tradeUrl);
      url.hash="";
      return `trade:${url.origin.toLowerCase()}${url.pathname}${url.search}`;
    }catch{
      return `trade:${tradeUrl.toLowerCase()}`;
    }
  }
  const normalized=value=>String(value||"").normalize("NFKC").replace(/^the\s+/i,"").replace(/\s+/g," ").trim().toLowerCase();
  return `listing:${normalized(listing?.listingName)}|${normalized(listing?.price)}|${normalized(listing?.comment||listing?.description)}`;
}
function deduplicateListings(listings){
  const unique=new Map();
  for(const listing of listings||[]){
    const identity=listingIdentity(listing);
    const current=unique.get(identity);
    const price=parsePrice(listing?.price)?.refValue??-Infinity;
    const currentPrice=parsePrice(current?.price)?.refValue??-Infinity;
    const pageUrls=new Set([
      ...(current?.sourceClassifiedsUrls||[]),
      ...(listing?.sourceClassifiedsUrls||[])
    ]);
    const selected=!current||price>currentPrice?listing:current;
    const knownQuantities=[explicitListingItemQuantity(current),explicitListingItemQuantity(listing)]
      .filter(quantity=>quantity!==null);
    unique.set(identity,{
      ...selected,
      quantity:knownQuantities.length?Math.max(...knownQuantities):1,
      sourceClassifiedsUrls:[...pageUrls]
    });
  }
  return [...unique.values()];
}
let unusualEffectCatalog=null;
let unusualEffectCatalogPromise=null;

async function getUnusualEffectCatalog(){
  if(Array.isArray(unusualEffectCatalog))return unusualEffectCatalog;
  if(unusualEffectCatalogPromise)return unusualEffectCatalogPromise;
  unusualEffectCatalogPromise=(async()=>{
    try{
      const controller=typeof AbortController!=='undefined'?new AbortController():null;
      const timer=controller?setTimeout(()=>controller.abort(),8000):null;
      const response=await fetch('https://backpack.tf/effects',{signal:controller?.signal});
      if(timer)clearTimeout(timer);
      if(!response.ok)throw new Error('effects page '+response.status);
      const html=await response.text();
      const doc=new DOMParser().parseFromString(html,'text/html');
      const out=[];
      for(const el of doc.querySelectorAll('[data-effect_name][data-effect_id]')){
        const name=String(el.getAttribute('data-effect_name')||'').trim();
        const id=Number(el.getAttribute('data-effect_id'));
        if(name&&Number.isInteger(id))out.push({name,id});
      }
      // Some Backpack.tf versions render the effect name/id as a table row
      // instead. Accept those links as a fallback.
      for(const a of doc.querySelectorAll('a[href*="/stats/Unusual/"]')){
        const href=a.getAttribute('href')||'';
        const m=href.match(/\/stats\/Unusual\/[^/]+\/Tradable\/Craftable\/(\d+)\b/i);
        const name=(a.textContent||'').trim();
        if(m&&name&&!out.some(x=>x.id===Number(m[1])))out.push({name,id:Number(m[1])});
      }
      unusualEffectCatalog=out.sort((a,b)=>b.name.length-a.name.length);
      return unusualEffectCatalog;
    }catch(e){
      unusualEffectCatalog=[];
      return unusualEffectCatalog;
    }finally{unusualEffectCatalogPromise=null}
  })();
  return unusualEffectCatalogPromise;
}

async function getBackpackSpecAsync(name){
  const raw=String(name||'').trim();
  const spec=getBackpackSpec(raw);
  if(!/^Unusual\s+/i.test(raw))return spec;
  const rest=raw.replace(/^Unusual\s+/i,'').trim();
  const effects=await getUnusualEffectCatalog();
  const lower=rest.toLowerCase();
  const effect=effects.find(e=>lower===e.name.toLowerCase() || lower.startsWith(e.name.toLowerCase()+' '));
  if(effect){
    const itemName=rest.slice(effect.name.length).trim();
    if(itemName)return {...spec,itemName,quality:'Unusual',effectName:effect.name,effectId:effect.id};
  }
  return {...spec,quality:'Unusual',unresolvedEffect:true,itemName:rest};
}

async function bpUrlAsync(name,forcedState=null){
  const spec=await getBackpackSpecAsync(name);
  const quality=forcedState?.quality||spec.quality;
  const craftability=forcedState?.craftability||spec.craftability;
  let url=`https://backpack.tf/stats/${encodeURIComponent(quality)}/${encodeURIComponent(spec.itemName)}/Tradable/${encodeURIComponent(craftability)}`;
  if(spec.effectId&&quality==='Unusual')url+=`/${spec.effectId}`;
  return {url,spec};
}

function getBackpackSpec(name){
  let n=String(name||"").trim();
  let quality="Unique";
  let craftability="Craftable";
  const qualityPrefixes=["Haunted","Unique","Strange","Unusual","Vintage","Genuine","Collector's","Collector’s"];
  let changed=true;
  while(changed){
    changed=false;
    const craftMatch=n.match(/^non[- ]craftable\s+/i);
    if(craftMatch){craftability="Non-Craftable";n=n.slice(craftMatch[0].length).trim();changed=true;continue;}
    for(const q of qualityPrefixes){
      const re=new RegExp("^"+q.replace(/[.*+?^${}()|[\\]\\\\]/g,"\\$&")+"\\s+","i");
      if(re.test(n)){quality=q.replace("Collector’s","Collector's");n=n.replace(re,"").trim();changed=true;break;}
    }
  }
  n=n.replace(/^the\s+/i,"");
  return {itemName:n,quality,craftability};
}
function fallbackName(name){const n=String(name||"").trim();const parts=n.split(/\s+/);return parts.length>1?parts.slice(1).join(" "):""}
function bpUrl(name,forcedState=null){
  const spec=getBackpackSpec(name);
  const quality=forcedState?.quality||spec.quality;
  const craftability=forcedState?.craftability||spec.craftability;
  return `https://backpack.tf/stats/${encodeURIComponent(quality)}/${encodeURIComponent(spec.itemName)}/Tradable/${encodeURIComponent(craftability)}`;
}

let results=[];
let saveChain=Promise.resolve();
function storageSet(value){
  if(isFirefoxBrowserApi)return api.storage.local.set(value).catch(()=>{});
  return new Promise(resolve=>{
    try{api.storage.local.set(value,()=>{void api.runtime.lastError;resolve()})}
    catch(e){resolve()}
  });
}
function storageGet(defaults){
  if(isFirefoxBrowserApi)return api.storage.local.get(defaults);
  return new Promise(resolve=>{
    try{api.storage.local.get(defaults,v=>{void api.runtime.lastError;resolve(v)})}
    catch(e){resolve(defaults)}
  });
}
function saveState(extra={}){
  const state={version:EXTENSION_VERSION,running,total,checked,queueLength:queue.length,keyRate,results,updatedAt:Date.now(),...extra};
  saveChain=saveChain.then(()=>storageSet({scanState:state}));
  return saveChain;
}

storageGet({tradeAutomationEnabled:false,notificationVolume,volumeDefaultApplied:false}).then(value=>{
  // One-time reset to the 40% default (the popup does the same on first open).
  if(!value.volumeDefaultApplied){
    notificationVolume=0.4;
    storageSet({notificationVolume:0.4,volumeDefaultApplied:true});
  }else{
    const savedVolume=Number(value.notificationVolume);
    if(Number.isFinite(savedVolume))notificationVolume=Math.max(0,Math.min(1,savedVolume));
  }
  tradeAutomationEnabled=value.tradeAutomationEnabled===true;
  if(tradeAutomationEnabled)emitTradeAutomationStatus("Automatic trade execution is enabled.");
}).catch(error=>console.error("Could not restore trade automation setting:",error));

async function finish(result){
  // The result list is the source of truth for progress. This prevents the
  // counter from getting ahead of the actual results during long scans.
  result.resultId=`${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  scanCurrentItem=null;
  if(!String(result.reason||"").startsWith("Check failed:"))scanStepErrors=0;
  if(result.profitableListings?.length)await verifyProfitableListings(result);
  // The item's tabs are closed and its verification is done, so a queued trade
  // may now use the scanner window.
  scanItemBusy=false;
  enqueueTradeJob(result);
  results.push(result);
  checked=results.length;
  notifyHit(result);
  updateSavedTrades(result).catch(error=>console.warn("Could not update the saved trades:",error));
  recordCheckedItem(result);
  notifyReverseHit(result);
  saveState({lastResult:result,finished:false}).finally(()=>{
    popup({type:"SCAN_RESULT",result,checked,total});
    next();
  });
}

// Saves a Good Trade to the local database, or records that a saved item is no
// longer one. The read-modify-write is chained so two results never overwrite
// each other.
let savedTradesChain=Promise.resolve();
function updateSavedTrades(result){
  if(!result?.name||(!result.deal&&!result.savedCheck))return Promise.resolve();
  savedTradesChain=savedTradesChain.then(async()=>{
    const key=TF2SavedTrades.STORAGE_KEY;
    const map=(await storageGet({[key]:{}}))[key]||{};
    const before=JSON.stringify(map);
    if(result.deal)TF2SavedTrades.recordGoodTrade(map,result);
    else if(result.savedCheck&&!result.unverifiedDeal&&isConclusiveCheck(result)){
      // The saved item was checked again and is not a Good Trade any more (its
      // price rose, or nobody buys it): it leaves the saved list by itself.
      // Checks that failed or could not finish keep the item.
      if(map[TF2SavedTrades.keyFor(result.name)]){
        TF2SavedTrades.remove(map,result.name);
        emitTradeAutomationStatus(`${result.name} is no longer a Good Trade, so it was removed from the saved items.`);
      }
    }
    else TF2SavedTrades.recordCheck(map,result);
    if(JSON.stringify(map)!==before)await storageSet({[key]:map});
  }).catch(()=>{});
  return savedTradesChain;
}

// ---- already-checked table ------------------------------------------------------
// Every conclusive check is written to the "checkedItems" table (item, price it
// was checked at, site, time). A normal scan skips an item for 60 minutes while
// its price on that site stays the same. Failures (Backpack.tf did not load, a
// price could not be read) are not recorded, so those items are tried again.
const CHECK_FAILURE_REASON=/did not return a usable|Could not parse|did not finish loading|Could not (?:read|open)|has none in stock|^Stopped\.|^Check failed:|shows no buy price/i;
function isConclusiveCheck(result){
  if(!result?.name||!result.sourceItem?.price)return false;
  if(!result.skipped)return true;
  // A reverse check that stopped early (STN buys no more of it, Backpack.tf has no
  // sell listing) is an answer; one that could not load a page is not. Forward
  // checks that never reached Backpack.tf have no attempts and are not recorded.
  if(!result.reverse&&!result.attempts?.length)return false;
  return !CHECK_FAILURE_REASON.test(String(result.reason||""));
}

// A result card for one direction of an item that was checked recently and is
// skipped. `direction` is "forward" (buy on the marketplace, sell on Backpack.tf)
// or "reverse" (buy on Backpack.tf, sell to STN).
function alreadyCheckedResult(entry,block,direction){
  const reverse=direction==="reverse";
  const outcome=block.outcome==="good"
    ?(reverse?"it was a hit":"it was a Good Trade")
    :block.outcome==="not-found"
      ?(reverse?"no usable STN price or sell listing":"no usable Buy Order")
      :"not profitable";
  const scrap=!reverse&&entry.source==="scrap.tf";
  return {
    name:entry.name,
    skipped:true,
    alreadyChecked:true,
    checkedDirection:direction,
    source:reverse?"stn":entry.source,
    reason:`Already checked${reverse?" (buy on Backpack.tf, sell to STN)":""} ${Math.max(1,Math.round((Date.now()-block.checkedAt)/60000))} min ago at ${block.price} (${outcome}). Checks again in ${Math.max(1,Math.ceil((block.expiresAt-Date.now())/60000))} min.`,
    checkedAt:block.checkedAt,
    checkedExpiresAt:block.expiresAt,
    checkedOutcome:block.outcome,
    sourceItem:{
      name:entry.name,price:entry.price,stock:entry.stock??null,href:entry.href||marketplaceUrl(entry.name),
      ...(scrap?{source:"scrap.tf",scrapValue:Number(entry.scrapValue)||null}:{}),
      ...(reverse?{source:"stn",reverse:true}:{})
    },
    attempts:[]
  };
}

// Emits the skipped results to the popup after a scan started.
function emitAlreadyChecked(skippedResults){
  if(!skippedResults.length)return;
  emitTradeAutomationStatus(`Skipping ${skippedResults.length} check${skippedResults.length===1?"":"s"} already done in the last 60 minutes.`);
  let done=0;
  for(const skippedResult of skippedResults)popup({type:"SCAN_RESULT",result:skippedResult,checked:++done,total});
}

let checkedItemsChain=Promise.resolve();
function recordCheckedItem(result){
  if(!isConclusiveCheck(result))return Promise.resolve();
  checkedItemsChain=checkedItemsChain.then(async()=>{
    const key=TF2CheckedItems.STORAGE_KEY;
    const map=(await storageGet({[key]:{}}))[key]||{};
    TF2CheckedItems.record(map,{
      name:result.name,
      direction:result.reverse?"reverse":"forward",
      source:result.reverse?"stn":result.source,
      price:result.sourceItem.price,
      outcome:(result.deal||result.reverseDeal)?"good":(result.skipped?"not-found":"not-good"),
      note:result.skipped?result.reason:"",
      profitRef:result.profitRef
    });
    await storageSet({[key]:map});
  }).catch(()=>{});
  return checkedItemsChain;
}

// The scrap.tf Buy Hats list read for a "Check saved items" scan: one read
// serves every saved scrap.tf item of the same scan.
let scrapPageCache=null;
// Reasons a saved item's marketplace page could not be read (as opposed to the
// item really not being listed or being out of stock).
const SAVED_REFRESH_RETRY_REASON=/did not finish loading|Could not (?:read|open)|shows no buy price|Could not read the price/i;
const SAVED_BACKOFF_MS=45000;
let savedRefreshFailures=0;

// At the end of a "Check saved items" run: what happened to the saved items.
function reportSavedCheckSummary(){
  const list=Array.isArray(results)?results:[];
  if(!list.length||!list.every(result=>result?.savedCheck))return;
  let good=0,gone=0,unverified=0;
  const unchecked=new Map();
  for(const result of list){
    if(result.deal)good++;
    else if(result.unverifiedDeal)unverified++;
    else if(result.skipped&&!isConclusiveCheck(result)){
      const reason=String(result.reason||"unknown reason").replace(/\s+/g," ").slice(0,90);
      unchecked.set(reason,(unchecked.get(reason)||0)+1);
    }else gone++;
  }
  const failed=[...unchecked.values()].reduce((sum,count)=>sum+count,0);
  const details=[...unchecked.entries()].map(([reason,count])=>`${count}× ${reason}`).join("; ");
  emitTradeAutomationStatus(`Saved items checked: ${good} still Good Trade${good===1?"":"s"}, ${gone} no longer good (removed from the list), ${unverified} unverified (kept), ${failed} could not be checked and stay saved${details?` (${details})`:""}.`);
}

// scrap.tf draws its list in pieces, so the first read of a freshly opened page can
// hold only part of it. The list is read until its length stops changing.
async function readScrapPageWhenComplete(tabId,timeoutMs=30000){
  const deadline=Date.now()+timeoutMs;
  let lastCount=-1,stableSince=0,latest=null;
  while(running&&Date.now()<deadline){
    let page=null;
    try{page=await msgTab(tabId,{type:"READ_BUY_PAGE"})}catch(error){page=null}
    const count=Array.isArray(page?.items)?page.items.length:0;
    if(count>0){
      latest=page.items;
      if(count===lastCount){
        if(!stableSince)stableSince=Date.now();
        if(Date.now()-stableSince>=2500)return latest;
      }else{
        lastCount=count;
        stableSince=0;
      }
    }
    await sleep(1000);
  }
  return latest;
}

// "Check saved items" reads the scrap.tf Buy Hats page ONCE (one tab, opened and
// closed again). Every saved scrap.tf item is then answered from that one list: it
// is listed with stock, listed but out of stock, or not listed at all. No tab is
// opened per item, and an item the list already rules out is not waited on.
const SCRAP_LIST_REUSE_MS=10*60000;
function scrapListFresh(){
  return Boolean(scrapPageCache&&Array.isArray(scrapPageCache.items)&&Date.now()-scrapPageCache.at<SCRAP_LIST_REUSE_MS);
}

async function loadScrapList(){
  let tab=null;
  try{
    tab=await createScanTab(SCRAP_BUY_URL);
    ownedTabIds.add(tab.id);
    ownedTabUrls.set(tab.id,SCRAP_BUY_URL);
    currentTabId=tab.id;
    const loaded=await waitForTabComplete(tab.id,30000);
    if(!running)return {ok:false,reason:"Stopped."};
    if(!loaded)return {ok:false,reason:"The scrap.tf Buy Hats page did not finish loading."};
    await ensureScanTabVisible(tab.id,6000);
    const items=await readScrapPageWhenComplete(tab.id);
    if(!running)return {ok:false,reason:"Stopped."};
    if(!items)return {ok:false,reason:"Could not read the scrap.tf Buy Hats page (are you signed in to scrap.tf?)."};
    scrapPageCache={at:Date.now(),items};
    emitTradeAutomationStatus(`Read the scrap.tf Buy Hats page once: ${items.length} hat${items.length===1?"":"s"} listed. Every saved scrap.tf item is answered from this single read.`);
    return {ok:true};
  }catch(error){
    return {ok:false,reason:`Could not open the scrap.tf Buy Hats page: ${error?.message||error}`};
  }finally{
    if(tab&&Number.isInteger(tab.id)){
      if(currentTabId===tab.id)currentTabId=null;
      await closeTabRobust(tab.id);
    }
  }
}

function scrapAnswerFor(item,items){
  const target=TF2CheckedItems.keyFor(item.name);
  const found=items.find(entry=>entry.source==="scrap.tf"&&TF2CheckedItems.keyFor(entry.name)===target);
  if(!found)return {ok:false,stock:0,reason:"scrap.tf does not list this item right now."};
  if(!(Number(found.stock)>0))return {ok:false,stock:0,reason:`scrap.tf has none in stock right now (${found.price}).`};
  return {ok:true,price:found.price,stock:found.stock,scrapValue:found.scrapValue,href:found.href||SCRAP_BUY_URL};
}

// The answer from the list that is already read, or null when it is not read yet.
function savedScrapAnswer(item){
  return scrapListFresh()?scrapAnswerFor(item,scrapPageCache.items):null;
}

async function refreshItemFromScrap(item){
  if(!scrapListFresh()){
    const loaded=await loadScrapList();
    if(!loaded.ok)return loaded;
  }
  return scrapAnswerFor(item,scrapPageCache.items);
}

// ---- reverse scan: buy on Backpack.tf, sell to STN --------------------------------
// For each hat on the STN listing the scanner reads what STN pays for it (the
// "Sell it for" box of its item page, plus how many more STN will buy) and the
// cheapest sell listings on its Backpack.tf stats page. When the cheapest bot
// listing costs at least MIN_PROFIT_REF less than STN pays, it is reported.
// Nothing is bought automatically on this side.
async function readStnBuyPrice(item){
  const url=marketplaceUrl(item.name);
  let tab=null;
  try{
    tab=await createScanTab(url);
    ownedTabIds.add(tab.id);
    ownedTabUrls.set(tab.id,url);
    currentTabId=tab.id;
    const loaded=await waitForTabComplete(tab.id,30000);
    if(!running)return {ok:false,reason:"Stopped."};
    if(!loaded)return {ok:false,reason:"The STN item page did not finish loading."};
    await ensureScanTabVisible(tab.id,6000);
    let page=null;
    const deadline=Date.now()+20000;
    while(running&&Date.now()<deadline){
      try{page=await msgTab(tab.id,{type:"READ_STN_SELL_PAGE"})}catch(error){page=null}
      if(page?.status==="ready")break;
      await sleep(500);
    }
    if(!page||page.status!=="ready")return {ok:false,reason:"STN shows no buy price for this item (or its page did not load)."};
    return {ok:true,price:page.price,capacity:page.capacity};
  }catch(error){
    return {ok:false,reason:`Could not open the STN item page: ${error?.message||error}`};
  }finally{
    if(tab&&Number.isInteger(tab.id)){
      if(currentTabId===tab.id)currentTabId=null;
      await closeTabRobust(tab.id);
    }
  }
}

async function readSellListingsWhenStable(tabId,itemName,desiredSpec=null){
  const start=Date.now();
  let lastCount=-1,lastSignature="",stableSince=0;
  while(running&&Date.now()-start<PAGE_SETTLE_TIMEOUT){
    try{
      const state=await msgTab(tabId,{type:"CHECK_CLASSIFIEDS_READY",itemName});
      if(state&&state.ready){
        const signature=String(state.signature||"");
        if(state.count===lastCount&&signature===lastSignature){
          if(!stableSince)stableSince=Date.now();
          if(Date.now()-stableSince>=1500)return await msgTab(tabId,{type:"READ_STATS_SELL_LISTINGS",itemName,desiredSpec});
        }else{stableSince=0;lastCount=state.count;lastSignature=signature;}
      }
    }catch(error){}
    await sleep(LISTING_POLL_MS);
  }
  return null;
}

async function processReverseItem(item){
  const stnUrl=marketplaceUrl(item.name);
  const base={
    name:item.name,
    reverse:true,
    source:"stn",
    sourceItem:{name:item.name,price:item.price||"",stock:item.stock??null,href:stnUrl,reverse:true},
    attempts:[]
  };
  await highlightSourceItem(item.name,"stn");
  const stn=await readStnBuyPrice(item);
  if(!running){scanItemBusy=false;return}
  if(!stn.ok){await finish({...base,skipped:true,reason:stn.reason});return}
  const stnPrice=parsePrice(stn.price);
  if(!stnPrice){await finish({...base,skipped:true,reason:`Could not parse STN's buy price (${stn.price}).`});return}
  base.stnPrice=stnPrice;
  base.stnCapacity=stn.capacity;
  if(!(stn.capacity>0)){
    await finish({...base,skipped:true,reason:`STN is not buying more of this item right now (it would pay ${stn.price}).`});
    return;
  }

  const resolved=await bpUrlAsync(item.name);
  const backpackUrl=resolved.url;
  base.backpackUrl=backpackUrl;
  base.attempts=[{name:item.name,url:backpackUrl,source:"stats",status:"opened"}];
  let data=null;
  try{
    const tab=await createScanTab(backpackUrl);
    ownedTabIds.add(tab.id);
    ownedTabUrls.set(tab.id,backpackUrl);
    currentTabId=tab.id;
    if(await loadBackpackPage(tab.id,backpackUrl))data=await readSellListingsWhenStable(tab.id,item.name,resolved.spec);
  }catch(error){
    console.warn("Could not read the Backpack.tf sell listings:",error);
  }finally{
    await closeAllOwnedTabs();
    if(!running){scanItemBusy=false;await closeAutomationWindowIfIdle()}
  }
  if(!data)await sleep(randomDelay(4000,6500));
  if(!running){scanItemBusy=false;return}
  if(!data){
    base.attempts[0].status="failed";
    await finish({...base,skipped:true,reason:"Backpack.tf did not return a usable sell listings page."});
    return;
  }

  const priced=(data.listings||[])
    .map(listing=>({listing,price:parsePrice(listing.price)}))
    .filter(entry=>entry.price)
    .sort((a,b)=>a.price.refValue-b.price.refValue);
  base.attempts[0].status=priced.length?"found":"no-match";
  if(!priced.length){
    await finish({...base,skipped:true,reason:"Backpack.tf lists no matching sell listing for this item."});
    return;
  }
  const bots=priced.filter(entry=>entry.listing.botLike);
  const best=bots[0]||priced[0];
  const profitRef=stnPrice.refValue-best.price.refValue;
  const reverseDeal=Boolean(bots[0])&&profitRef+0.0000001>=MIN_PROFIT_REF;
  const cheaperHuman=!best.listing.botLike?null:priced.find(entry=>!entry.listing.botLike&&entry.price.refValue<best.price.refValue&&stnPrice.refValue-entry.price.refValue+0.0000001>=MIN_PROFIT_REF);
  await finish({
    ...base,
    bpPrice:best.price,
    bestListing:best.listing,
    tradeOfferUrl:String(best.listing.tradeUrl||""),
    profitRef,
    reverseDeal,
    humanOnly:!bots.length,
    cheaperHumanPrice:cheaperHuman?.price?.display||"",
    sellListingCount:priced.length,
    botSellListingCount:bots.length,
    sellListings:priced.slice(0,5).map(entry=>({price:entry.price.display,listingName:entry.listing.listingName||"",botLike:Boolean(entry.listing.botLike),tradeUrl:String(entry.listing.tradeUrl||"")}))
  });
}

function notifyReverseHit(result){
  if(!result?.reverseDeal||!result.name)return;
  const key=`reverse|${String(result.name).toLowerCase()}|${result.profitRef.toFixed(4)}|${result.bpPrice?.display||""}`;
  if(notifiedDeals.has(key))return;
  notifiedDeals.add(key);
  const notificationId=`tf2-hit-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  notificationTargets.set(notificationId,result.backpackUrl||result.sourceItem?.href||"https://stntrading.eu/");
  const options={
    type:"basic",
    title:"💰 STN BUY-PRICE HIT",
    message:`${result.name}\nBackpack.tf ${result.bpPrice?.display||"?"} → STN pays ${result.stnPrice?.display||"?"}\nPROFIT: +${result.profitRef.toFixed(2)} ref`,
    iconUrl:api.runtime.getURL("hit-icon.png")
  };
  try{
    const created=api.notifications.create(notificationId,options);
    if(created&&typeof created.catch==="function")created.catch(()=>{});
  }catch(e){}
  // No hit.mp3 here: that sound means a Good Trade, and this report-only hit is not one.
}

// Opens the item's STN page (https://stntrading.eu/item/tf2/<name>) in the
// scanner window and reads its current price and stock.
async function refreshItemFromStn(item){
  const url=marketplaceUrl(item.name);
  let tab=null;
  try{
    tab=await createScanTab(url);
    ownedTabIds.add(tab.id);
    ownedTabUrls.set(tab.id,url);
    currentTabId=tab.id;
    const loaded=await waitForTabComplete(tab.id,30000);
    if(!running)return {ok:false,reason:"Stopped."};
    if(!loaded)return {ok:false,reason:"The STN item page did not finish loading."};
    // STN runs its Turnstile check only in a visible page.
    await ensureScanTabVisible(tab.id,6000);
    let page=null;
    const deadline=Date.now()+20000;
    while(running&&Date.now()<deadline){
      try{page=await msgTab(tab.id,{type:"READ_STN_ITEM_PAGE"})}catch(error){page=null}
      if(page?.status==="ready")break;
      await sleep(500);
    }
    if(!page||page.status!=="ready")return {ok:false,reason:page?.reason||"Could not read the price from the STN item page."};
    if(page.stock<=0)return {ok:false,stock:0,reason:`STN has none in stock right now (${page.price}).`};
    return {ok:true,price:page.price,stock:page.stock};
  }catch(error){
    return {ok:false,reason:`Could not open the STN item page: ${error?.message||error}`};
  }finally{
    if(tab&&Number.isInteger(tab.id)){
      if(currentTabId===tab.id)currentTabId=null;
      await closeTabRobust(tab.id);
    }
  }
}

// Alternates the sites (STN, scrap.tf, STN, scrap.tf, ...) so both are worked
// through side by side instead of one site being finished before the other
// starts. Each site keeps its own order.
function interleaveBySource(items){
  const lanes=new Map();
  for(const item of items){
    const source=item.source==="scrap.tf"?"scrap.tf":"stn";
    if(!lanes.has(source))lanes.set(source,[]);
    lanes.get(source).push(item);
  }
  const ordered=[];
  const lists=[...lanes.values()];
  for(let index=0;lists.some(list=>index<list.length);index++){
    for(const list of lists)if(index<list.length)ordered.push(list[index]);
  }
  return ordered;
}

// The marketplace tab each source (STN, scrap.tf) was read from in this scan.
let sourceTabsBySource={};
async function highlightSourceItem(itemName,source){
  const tabId=Number.isInteger(sourceTabsBySource[source])?sourceTabsBySource[source]:sourceTabId;
  if(!Number.isInteger(tabId))return;
  try{
    await msgTab(tabId,{type:"HIGHLIGHT_MARKET_ITEM",itemName});
  }catch(e){}
}

function analyze(item,data){
  if(!data)return {name:item.name,skipped:true,reason:"Backpack.tf did not return a usable Buy Order page."};
  const buy=parsePrice(item.price);
  if(!buy)return {name:item.name,skipped:true,reason:"Could not parse the marketplace price."};
  const sourceListings=Array.isArray(data.listings)?data.listings:[];
  if(!sourceListings.length)return {name:item.name,skipped:true,reason:"No normal generic Backpack.tf Buy Order exists for this item."};

  // Keep every bot Buy Order above our marketplace cost, not just the single
  // highest-priced order. This tells the user how many profitable bot listings
  // are actually available at or above the price needed for a hit. A recent
  // bump supersedes the original listing date when deciding whether an order
  // is still active enough to count.
  const now=Date.now();
  // Blacklisted traders are already skipped by the page scanner; filtering
  // again here also covers any listing that reached this point another way.
  const allowedListings=TraderBlacklist.filterOut(sourceListings);
  const blacklistedIgnored=sourceListings.length-allowedListings.length;
  const recentListings=allowedListings.filter(listing=>{
    const bumpedAt=Number(listing?.bumpedAt)||0;
    const listedAt=Number(listing?.listedAt)||0;
    const lastActivityAt=bumpedAt||listedAt;
    return listingItemQuantity(listing)>0&&
      (!lastActivityAt||(now-lastActivityAt)<=MAX_LISTING_ACTIVITY_AGE_MS);
  });
  const staleListingsIgnored=allowedListings.length-recentListings.length;
  const freshListings=deduplicateListings(recentListings);
  if(!freshListings.length){
    return {
      name:item.name,
      skipped:true,
      reason:allowedListings.length||!blacklistedIgnored
        ?`No bot Buy Order was listed or bumped within the last ${Math.round(MAX_LISTING_ACTIVITY_AGE_MS/3600000)} hours.`
        :`Only blacklisted traders have Buy Orders for this item (${blacklistedIgnored} ignored).`,
      staleListingsIgnored,
      blacklistedIgnored
    };
  }

  const profitableListings=freshListings
    .map(listing=>({listing,price:parsePrice(listing.price)}))
    .filter(x=>x.price&&x.price.refValue-buy.refValue+0.0000001>=MIN_PROFIT_REF)
    .sort((a,b)=>b.price.refValue-a.price.refValue);

  const best=profitableListings.find(entry=>entry.listing.tradeUrl)?.listing||
    profitableListings[0]?.listing||
    freshListings[0];
  const sell=parsePrice(best.price);
  if(!sell)return {name:item.name,skipped:true,reason:"Could not parse the Buy Order price."};
  const profitRef=sell.refValue-buy.refValue;
  return {
    name:item.name,
    buyPrice:buy,
    sellPrice:sell,
    bestListing:best,
    tradeOfferUrl:String(best.tradeUrl||""),
    profitRef,
    deal:profitRef+0.0000001>=MIN_PROFIT_REF,
    profitableListingCount:profitableListings.length,
    profitableListings:profitableListings.map(x=>x.listing),
    totalBotListings:freshListings.length,
    staleListingsIgnored,
    blacklistedIgnored
  };
}

async function waitForTabComplete(tabId,timeout=PAGE_SETTLE_TIMEOUT,pollMs=LISTING_POLL_MS){
  const start=Date.now();
  while(running&&Date.now()-start<timeout){
    try{
      const tabs=await qTabs({});
      const tab=tabs.find(t=>t.id===tabId);
      if(tab&&tab.status==="complete")return true;
    }catch(e){}
    await sleep(pollMs);
  }
  return false;
}

// Backpack.tf returns error pages (HTTP 500 and similar) when it is busy.
// These are retried a few times with short, growing pauses (about 2-8 seconds).
const BACKPACK_ERROR_MAX_RETRIES=4;

async function backpackPageError(tabId){
  const tab=await getTabInfo(tabId);
  if(!tab)return "the tab closed";
  if(/^about:(?:neterror|certerror|blocked)/i.test(String(tab.url||"")))return "the page could not be loaded";
  for(let attempt=0;attempt<4;attempt++){
    try{
      const response=await msgTab(tabId,{type:"CHECK_BACKPACK_ERROR"});
      return response&&response.error?String(response.error):"";
    }catch(error){
      await sleep(400);
    }
  }
  return "";
}

// Loads a Backpack.tf page that is already navigating and reloads it when the
// site answers with a server error. Returns true only for a usable page.
async function loadBackpackPage(tabId,url,timeout=PAGE_SETTLE_TIMEOUT){
  for(let retry=0;;retry++){
    if(!await waitForTabComplete(tabId,timeout))return false;
    const error=await backpackPageError(tabId);
    if(!error)return true;
    if(!running||retry>=BACKPACK_ERROR_MAX_RETRIES){
      console.warn(`Backpack.tf kept returning an error (${error}) for ${url}.`);
      return false;
    }
    const delay=randomDelay(2000,3500)+retry*1500;
    console.warn(`Backpack.tf returned an error (${error}). Reloading in ${(delay/1000).toFixed(1)}s (${retry+1}/${BACKPACK_ERROR_MAX_RETRIES}).`);
    await sleep(delay);
    if(!running)return false;
    const watch=watchTabNavigation(tabId);
    try{
      await reloadTab(tabId);
      if(!await waitForTabNavigation(tabId,url,watch,"",timeout))return false;
    }catch(reloadError){
      return false;
    }finally{
      watch.stop();
    }
  }
}

async function readWhenStable(tabId,itemName,desiredSpec=null){
  const start=Date.now();
  let lastCount=-1,lastSignature="",stableSince=0;
  while(running&&Date.now()-start<PAGE_SETTLE_TIMEOUT){
    try{
      const state=await msgTab(tabId,{type:"CHECK_CLASSIFIEDS_READY",itemName});
      if(state&&state.ready){
        const signature=String(state.signature||"");
        if(state.count===lastCount&&signature===lastSignature){
          if(!stableSince)stableSince=Date.now();
          if(Date.now()-stableSince>=1500)return await msgTab(tabId,{type:"READ_CLASSIFIEDS_PAGE",itemName,desiredSpec});
        }else{stableSince=0;lastCount=state.count;lastSignature=signature;}
      }
    }catch(e){}
    await sleep(LISTING_POLL_MS);
  }
  return null;
}

async function readStatsBuyOrders(tabId,itemName,desiredSpec=null){
  try{return await msgTab(tabId,{type:"READ_STATS_BUY_ORDERS",itemName,desiredSpec})}catch(e){return null}
}

function classifiedsUrl(itemName){
  const spec=getBackpackSpec(itemName);

  // Use Backpack.tf's full generic Buy Orders filter. This deliberately
  // mirrors the useful filters from the expanded Classifieds link instead of
  // opening the broad quality-only page, which can contain less relevant
  // variants and specialized orders.
  const qualityIds={
    "Unique":6,
    "Genuine":1,
    "Vintage":3,
    "Strange":11,
    "Unusual":5,
    "Haunted":13,
    "Collector's":14
  };
  const params=new URLSearchParams({
    item:spec.itemName,
    quality:String(qualityIds[spec.quality]??6),
    tradable:"1",
    craftable:spec.craftability==="Non-Craftable"?"-1":"1",
    australium:"-1",
    killstreak_tier:"0",
    spell:"None",
    offers:"1",
    paint:"None"
  });
  return `https://backpack.tf/classifieds?${params.toString()}`;
}

function sufficientOfferListings(result){
  return Array.isArray(result?.offerChecks)
    ?result.offerChecks.filter(entry=>
      entry?.verification?.status==="sufficient"&&
      listingItemQuantity(entry)>0&&
      !TraderBlacklist.isBlacklisted(entry)
    )
    :[];
}

function groupBackpackListingsBySourcePage(listings,itemName,preferredUrl=""){
  const preferred=filteredClassifiedsPageUrl(preferredUrl);
  const fallbackUrl=preferred
    ?preferred.href
    :classifiedsUrl(itemName);
  const groups=new Map();
  for(const listing of listings){
    const sourcePages=Array.isArray(listing.sourceClassifiedsUrls)
      ?listing.sourceClassifiedsUrls
      :[];
    const sourceUrl=sourcePages
      .map(filteredClassifiedsPageUrl)
      .find(Boolean);
    const url=(sourceUrl?.href||fallbackUrl).replace(/#.*$/,"");
    if(!groups.has(url))groups.set(url,[]);
    groups.get(url).push(listing);
  }
  return [...groups.entries()].map(([url,pageListings])=>({url,listings:pageListings}));
}

async function openAndHighlightBackpackPages(listings,itemName,preferredUrl,windowId,trackAsTransaction=true,inScannerWindow=false){
  const groups=groupBackpackListingsBySourcePage(listings,itemName,preferredUrl);
  const opened={tabs:[],pages:0,highlighted:0,missing:[],errors:[]};
  for(let index=0;index<groups.length;index++){
    const group=groups[index];
    try{
      // Automatic trades keep every page in the scanner window so the user's
      // own window is never switched; the manual "open verified pages" button
      // still opens them where the user is looking.
      const tab=inScannerWindow
        ?await createScanTab(group.url,false)
        :await createTransactionTab(group.url,index===0,windowId);
      opened.tabs.push(tab);
      if(trackAsTransaction)transactionTabIds.add(tab.id);
      opened.pages++;
      if(!await waitForTabComplete(tab.id,30000)){
        opened.errors.push(`Backpack.tf page ${index+1} did not finish loading.`);
        continue;
      }
      const response=await getTabMessageWithRetry(tab.id,{
        type:"HIGHLIGHT_LISTINGS",
        itemName,
        listings:group.listings.map(listing=>({
          accountId:listing.listingAccountId||listing.accountId||"",
          listingName:listing.listingName||""
        }))
      },10000);
      opened.highlighted+=Number(response?.highlighted)||0;
      if(Array.isArray(response?.missing))opened.missing.push(...response.missing);
      if(!response?.ok&&response?.highlighted===0){
        opened.errors.push(response?.reason||`No verified listings were highlighted on Backpack.tf page ${index+1}.`);
      }
    }catch(error){
      opened.errors.push(error.message||String(error));
    }
  }
  return opened;
}

async function readClassifiedsLink(tabId,itemName){
  // The correct expanded Buy Orders URL can be built deterministically from
  // the item name, so do not depend on the stats page exposing its expand link.
  return {href:classifiedsUrl(itemName)};
}

function safeNextClassifiedsUrl(rawHref,currentUrl){
  try{
    const current=new URL(currentUrl);
    const next=new URL(rawHref,current);
    const currentPage=Number(current.searchParams.get("page")||"1");
    const nextPage=Number(next.searchParams.get("page"));
    if(next.protocol!=="https:"||! /^(?:[a-z0-9-]+\.)*backpack\.tf$/i.test(next.hostname)||next.pathname!=="/classifieds"){
      return {error:"Backpack.tf returned an unsafe pagination link."};
    }
    if(!Number.isInteger(nextPage)||nextPage!==currentPage+1){
      return {error:"Backpack.tf pagination did not provide the next consecutive page."};
    }
    const params=new URLSearchParams(current.searchParams);
    params.set("page",String(nextPage));
    params.set("offers","1");
    params.set("paint","None");
    next.search=params.toString();
    return {url:next.href,page:nextPage};
  }catch(error){
    return {error:`Could not parse the next Classifieds page: ${String(error?.message||error)}`};
  }
}

async function closeCurrentTab(){
  const id=currentTabId;
  currentTabId=null;
  if(id!==null)await removeTab(id).catch(()=>{});
}

async function tabStillExists(id){
  try{const tabs=await qTabs({});return tabs.some(t=>t.id===id)}catch(e){return false}
}
async function closeTabRobust(id){
  if(!Number.isInteger(id))return;
  for(let attempt=0;attempt<6;attempt++){
    if(!await tabStillExists(id)){ownedTabIds.delete(id);ownedTabUrls.delete(id);return}
    try{await removeTab(id)}catch(e){}
    await sleep(150+attempt*150);
  }
  if(!await tabStillExists(id)){ownedTabIds.delete(id);ownedTabUrls.delete(id)}
}
async function closeCurrentTab(){const id=currentTabId;currentTabId=null;if(id!==null)await closeTabRobust(id)}
async function closeAllOwnedTabs(){
  const ids=[...ownedTabIds];
  if(currentTabId!==null&&!ids.includes(currentTabId))ids.push(currentTabId);
  currentTabId=null;
  await Promise.all(ids.map(id=>closeTabRobust(id)));
  const remaining=[...ownedTabIds];
  if(remaining.length)await Promise.all(remaining.map(id=>closeTabRobust(id)));
}

async function openAndReadClassifieds(statsTabId,itemName,buyRefValue=null){
  const searchSpec=await getBackpackSpecAsync(itemName);
  const statsData=await readStatsBuyOrders(statsTabId,searchSpec.itemName,searchSpec);
  const statsListings=Array.isArray(statsData?.listings)?statsData.listings:[];

  // Close the stats tab before opening Classifieds, then combine both result
  // sources so a stats-page hit does not hide other profitable offers.
  if(currentTabId===statsTabId){
    await closeCurrentTab();
  }else{
    await closeTabRobust(statsTabId);
  }
  if(!running)return null;

  const linkData=await readClassifiedsLink(null,itemName);
  if(!linkData?.href){
    return {
      listings:statsListings,
      pagesChecked:0,
      source:"stats",
      statsFound:statsListings.length>0,
      url:null,
      error:"Classifieds search URL could not be constructed; only stats-page listings were available."
    };
  }

  const firstUrl=new URL(linkData.href,"https://backpack.tf").href;
  const classifiedsTab=await createScanTab(firstUrl);
  ownedTabIds.add(classifiedsTab.id);
  ownedTabUrls.set(classifiedsTab.id,firstUrl);
  currentTabId=classifiedsTab.id;

  if(!await loadBackpackPage(classifiedsTab.id,firstUrl))return null;
  let page=await readWhenStable(classifiedsTab.id,searchSpec.itemName,searchSpec);
  if(!page)return null;
  const allListings=[...statsListings];
  const visitedPages=new Set([firstUrl]);
  let pageUrl=firstUrl;
  let pagesChecked=0;
  let paginationError="";
  let stoppedEarly=false;
  let stopReason="";
  // Buy Orders are listed from the highest price to the lowest. A listing is
  // only profitable at or above this price, so paging can stop as soon as a
  // page reaches anything below it.
  const profitThresholdRef=Number.isFinite(buyRefValue)?buyRefValue+MIN_PROFIT_REF:null;
  while(page&&running){
    pagesChecked++;
    if(Array.isArray(page.listings)){
      allListings.push(...page.listings.map(listing=>({
        ...listing,
        sourceClassifiedsUrls:[...new Set([...(listing.sourceClassifiedsUrls||[]),pageUrl])]
      })));
    }
    const profitRange=classifiedsProfitRangeEnd(page,profitThresholdRef);
    if(!page.nextHref)break;
    if(profitRange.ends){
      stoppedEarly=true;
      stopReason=profitRange.reason;
      break;
    }
    if(pagesChecked>=MAX_CLASSIFIEDS_PAGES){
      paginationError=`Stopped after the ${MAX_CLASSIFIEDS_PAGES}-page safety limit; more Classifieds pages remain.`;
      break;
    }
    const next=safeNextClassifiedsUrl(page.nextHref,pageUrl);
    if(!next.url){
      paginationError=next.error||"Could not follow the next Classifieds page.";
      break;
    }
    if(visitedPages.has(next.url)){
      paginationError="Backpack.tf pagination repeated a page URL.";
      break;
    }
    await sleep(randomDelay(BETWEEN_CLASSIFIED_PAGES_MIN,BETWEEN_CLASSIFIED_PAGES_MAX));
    if(!running)break;
    visitedPages.add(next.url);
    pageUrl=next.url;
    await updateTab(classifiedsTab.id,{url:pageUrl});
    ownedTabUrls.set(classifiedsTab.id,pageUrl);
    if(!await loadBackpackPage(classifiedsTab.id,pageUrl)){
      paginationError=`Classifieds page ${next.page} did not finish loading.`;
      break;
    }
    page=await readWhenStable(classifiedsTab.id,searchSpec.itemName,searchSpec);
    if(!page){
      paginationError=`Could not read Classifieds page ${next.page}.`;
      break;
    }
  }
  const uniqueListings=deduplicateListings(allListings);
  return {
    listings:uniqueListings,
    pagesChecked,
    source:"classifieds",
    statsFound:statsListings.length>0,
    url:firstUrl,
    paginationError,
    stoppedEarly,
    stopReason
  };
}

// Classifieds pages are ordered from the highest Buy Order price to the
// lowest. Once a page contains a price under the profit threshold, every later
// page is lower still, so there is no reason to load it.
function classifiedsProfitRangeEnd(page,thresholdRef){
  if(!Number.isFinite(thresholdRef))return {ends:true,reason:"No marketplace price was available to compare Buy Orders against."};
  // A page without price data (for example, an older content script) cannot
  // prove the range ended, so keep the original follow-every-page behavior.
  if(!Array.isArray(page?.buyOrderPrices))return {ends:false};
  const values=page.buyOrderPrices
    .map(text=>parsePrice(text)?.refValue)
    .filter(Number.isFinite);
  if(!values.length)return {ends:true,reason:"No Buy Order prices were readable on this page."};
  const lowest=Math.min(...values);
  if(lowest+0.0000001<thresholdRef){
    return {
      ends:true,
      lowest,
      reason:`Buy Orders on page ${page.page||"?"} already drop to ${lowest.toFixed(2)} ref, below the ${thresholdRef.toFixed(2)} ref profit threshold.`
    };
  }
  return {ends:false,lowest};
}

function marketplaceUrl(itemName){
  // STN.Trading uses the TF2 item name as the final URL segment. Keep the
  // full marketplace-facing name (including Non-Craftable) and encode it so
  // spaces, apostrophes and other item-name characters work correctly.
  const clean=String(itemName||"").trim();
  return `https://stntrading.eu/item/tf2/${encodeURIComponent(clean).replace(/%20/g,"+")}`;
}

// The item being checked right now, so a failure can be reported against it.
let scanCurrentItem=null;
let scanStepErrors=0;
const SCAN_MAX_STEP_ERRORS=5;

// One step of the scan. An unexpected error used to end the chain silently (the
// scan stayed "running" and nothing more happened); now the item gets a failed
// result, the reason is shown, and the scan goes on with the next item.
async function next(){
  try{
    await nextInner();
  }catch(error){
    console.error("Scan step failed:",error);
    const item=scanCurrentItem;
    scanCurrentItem=null;
    scanItemBusy=false;
    if(!running)return;
    scanStepErrors++;
    const message=String(error?.message||error).slice(0,200);
    emitTradeAutomationStatus(`Checking ${item?.name||"the next item"} failed unexpectedly (${message}). ${scanStepErrors>=SCAN_MAX_STEP_ERRORS?"Too many errors in a row, so the scan was stopped.":"Moving on to the next item."}`);
    if(scanStepErrors>=SCAN_MAX_STEP_ERRORS){
      running=false;
      queue=[];
      autoRescanContext=null;
      await closeAllOwnedTabs().catch(()=>{});
      await saveState({running:false,queueLength:0}).catch(()=>{});
      popup({type:"SCAN_FINISHED",checked,total});
      await closeAutomationWindowIfIdle().catch(()=>{});
      return;
    }
    if(item){
      try{
        await finish({
          name:item.name,
          skipped:true,
          savedCheck:Boolean(item.fromSaved),
          reverse:Boolean(item.reverse),
          source:item.source==="scrap.tf"?"scrap.tf":"stn",
          reason:`Check failed: ${message}`,
          sourceItem:{name:item.name,price:item.price||"",stock:item.stock??null,href:item.href||"",...(item.reverse?{reverse:true}:{})},
          attempts:[]
        });
        return;
      }catch(innerError){console.error("Could not record the failed check:",innerError)}
    }
    await sleep(2000);
    next();
  }
}

async function nextInner(){
  if(!running||!queue.length){
    const naturalFinish=running&&!queue.length;
    running=false;
    scanItemBusy=false;
    if(naturalFinish)reportSavedCheckSummary();
    scrapPageCache=null;
    await saveState({running:false,queueLength:0,finished:true});
    popup({type:"SCAN_FINISHED",checked,total});
    await closeAllOwnedTabs();
    // A trade that is still running keeps using the scanner window; the trade
    // worker closes it when it is done.
    await closeAutomationWindowIfIdle();
    if(naturalFinish)playEndSound();
    if(naturalFinish&&autoRescanContext){
      startAutoRescan(autoRescanContext).catch(error=>{
        console.warn("Automatic rescan failed:",error);
        emitTradeAutomationStatus(`The automatic rescan stopped: ${error?.message||error}`);
      });
    }
    return;
  }

  await closeAllOwnedTabs();
  // A saved scrap.tf item that the single read of the scrap.tf list has already
  // ruled out (not listed / out of stock) needs no page, so there is nothing to
  // space out.
  const upcoming=queue[0];
  const answeredAlready=Boolean(upcoming&&upcoming.fromSaved&&upcoming.source==="scrap.tf"&&savedScrapAnswer(upcoming)?.ok===false);
  if(!answeredAlready)await sleep(randomDelay(BETWEEN_ITEMS_MIN,BETWEEN_ITEMS_MAX));
  if(!running||!queue.length)return nextInner();

  // The scanner window is shared with the trade worker (STN purchase and Steam
  // offers), so scanning waits while a trade is running.
  if(isTradeWorkBusy()){
    emitTradeAutomationStatus("Scanning is paused while a trade runs in the scanner window; it resumes when the trade finishes.");
    await waitForTradeIdle();
    if(!running||!queue.length)return nextInner();
  }
  scanItemBusy=true;

  const item=queue.shift();
  scanCurrentItem=item;
  await saveState({finished:false});
  if(!running){scanItemBusy=false;return}

  // Reverse scan: what STN pays versus Backpack.tf sell listings.
  if(item.reverse){
    await processReverseItem(item);
    return;
  }

  // A saved item is opened on STN first: the price and stock there are what the
  // comparison with Backpack.tf must use, and an item STN no longer stocks
  // cannot be bought anyway.
  if(item.fromSaved){
    const savedFromScrap=item.source==="scrap.tf";
    const siteLabel=savedFromScrap?"scrap.tf":"STN";
    emitTradeAutomationStatus(`Checking saved item ${results.length+1}/${total}: ${item.name} (${savedFromScrap?"from the scrap.tf list":"reading STN"}, then Backpack.tf)…`);
    let stn=savedFromScrap?await refreshItemFromScrap(item):await refreshItemFromStn(item);
    // A page that did not load or answer is tried once more before the item is
    // given up on (the item is never removed from the saved list for this).
    if(!stn.ok&&running&&SAVED_REFRESH_RETRY_REASON.test(String(stn.reason||""))){
      emitTradeAutomationStatus(`${item.name}: ${stn.reason} Trying ${siteLabel} once more…`);
      await sleep(randomDelay(3000,5000));
      if(running)stn=savedFromScrap?await refreshItemFromScrap(item):await refreshItemFromStn(item);
    }
    if(!running){scanItemBusy=false;return}
    if(!stn.ok){
      emitTradeAutomationStatus(`${item.name}: ${stn.reason}`);
      // Several pages in a row that do not answer usually mean the site is
      // throttling the scanner: give it a rest instead of hammering it.
      if(SAVED_REFRESH_RETRY_REASON.test(String(stn.reason||""))){
        savedRefreshFailures++;
        if(savedRefreshFailures>=3){
          savedRefreshFailures=0;
          emitTradeAutomationStatus(`${siteLabel} did not answer for 3 saved items in a row. Pausing the check for ${Math.round(SAVED_BACKOFF_MS/1000)} seconds before going on.`);
          const until=Date.now()+SAVED_BACKOFF_MS;
          while(running&&Date.now()<until)await sleep(1000);
          if(!running){scanItemBusy=false;return}
        }
      }
    }else{
      savedRefreshFailures=0;
    }
    if(!stn.ok){
      await finish({
        name:item.name,
        skipped:true,
        savedCheck:true,
        source:savedFromScrap?"scrap.tf":"stn",
        reason:stn.reason,
        sourceItem:{
          name:item.name,price:item.price||"",stock:stn.stock??null,
          href:savedFromScrap?(item.href||SCRAP_BUY_URL):marketplaceUrl(item.name),
          ...(savedFromScrap?{source:"scrap.tf",scrapValue:Number(item.scrapValue)||null}:{})
        },
        attempts:[]
      });
      return;
    }
    item.price=stn.price;
    item.stock=stn.stock;
    if(savedFromScrap){
      item.scrapValue=stn.scrapValue??item.scrapValue;
      item.href=stn.href||item.href;
    }
  }

  const firstName=item.name;
  await highlightSourceItem(firstName,item.source);
  const originalSpec=getBackpackSpec(firstName);
  const namesToTry=[];
  const addName=n=>{
    const clean=String(n||"").trim();
    if(clean&&!namesToTry.some(x=>x.toLowerCase()===clean.toLowerCase()))namesToTry.push(clean);
  };
  // Exact name first, then the existing one-word fallback.
  addName(firstName);
  addName(fallbackName(firstName));

  let data=null;
  let searchedName=firstName;
  const attempts=[];

  try{
    for(let attempt=0;attempt<namesToTry.length&&running;attempt++){
      searchedName=namesToTry[attempt];
      const fallbackState=attempt===0?null:originalSpec;
      const resolved=await bpUrlAsync(searchedName,fallbackState);
      const backpackUrl=resolved.url;
      attempts.push({name:searchedName,url:backpackUrl,source:"stats",status:"opened"});
      const statsTab=await createScanTab(backpackUrl);
      ownedTabIds.add(statsTab.id);
      ownedTabUrls.set(statsTab.id,backpackUrl);
      currentTabId=statsTab.id;

      const loaded=await loadBackpackPage(statsTab.id,backpackUrl);
      if(!running)break;
      if(!loaded){
        // Do not leave a timed-out tab behind. The previous version returned
        // here, which is one reason tabs accumulated during long scans.
        await closeCurrentTab();
        if(attempt===0&&namesToTry.length>1)await sleep(randomDelay(2500,4500));
        continue;
      }

      const searchSpec=resolved.spec;
      data=await openAndReadClassifieds(statsTab.id,searchedName,parsePrice(item.price)?.refValue??null);
      if(data?.source==="classifieds"&&data.url){
        const pageNote=`${data.pagesChecked} page${data.pagesChecked===1?"":"s"}${data.stoppedEarly?", stopped once prices fell below profit":""}`;
        const status=data.paginationError
          ?`partial (${pageNote}): ${data.paginationError}`
          :`${data.listings?.length?"found":"no-match"} (${pageNote})`;
        attempts.push({name:searchedName,url:data.url,source:"classifieds",status});
      }
      const attemptRecord=attempts.find(a=>a.name===searchedName&&a.source==="stats");
      if(attemptRecord){
        if(!data)attemptRecord.status="failed";
        else if(data.statsFound)attemptRecord.status="found";
        else attemptRecord.status="no-match";
      }

      const hasUsableListing=!!(data&&data.listings&&data.listings.length);
      if(hasUsableListing)break;

      await closeCurrentTab();
      if(attempt===0&&namesToTry.length>1)await sleep(randomDelay(2500,4500));
    }
  }finally{
    await closeAllOwnedTabs();
    // A stopped scan returns before reaching the end-of-scan cleanup above.
    if(!running){
      scanItemBusy=false;
      await closeAutomationWindowIfIdle();
    }
  }

  if(!data)await sleep(randomDelay(4000,6500));
  if(!running){scanItemBusy=false;return}

  const result=analyze(item,data);
  const fromScrap=item.source==="scrap.tf";
  result.source=fromScrap?"scrap.tf":"stn";
  result.sourceItem={
    name:item.name,price:item.price,stock:item.stock??null,
    href:fromScrap?(item.href||"https://scrap.tf/buy/hats"):marketplaceUrl(item.name),
    ...(fromScrap?{source:"scrap.tf",scrapValue:Number(item.scrapValue)||null}:{})
  };
  if(item.fromSaved)result.savedCheck=true;
  result.attempts=attempts;
  // Preserve the exact Backpack.tf page that produced the usable Buy Orders
  // so a confirmed arbitrage hit can open both sides automatically.
  if(data?.source==="classifieds"&&data.url){
    result.backpackUrl=data.url;
  }else{
    const successfulStats=[...attempts].reverse().find(a=>a.source==="stats"&&a.status==="found"&&a.url);
    if(successfulStats)result.backpackUrl=successfulStats.url;
  }
  if(result.skipped&&namesToTry.length>1&&searchedName===namesToTry[1])
    result.reason=`No generic Backpack.tf Buy Orders found for "${firstName}" or fallback "${namesToTry[1]}".`;
  if(data?.pagesChecked)result.pagesChecked=data.pagesChecked;
  await finish(result);
}

// Reads every STN / scrap.tf page open in the window and starts the scan. `m.tabId`
// (used by the automatic rescan) names the tab to start from; without it the active
// tab of the current window is used. `sendResponse` gets {ok,...}.
function startItemScan(m,sendResponse){
  const findTabs=Number.isInteger(m.tabId)
    ?getTabInfo(m.tabId).then(tab=>tab?[tab]:[])
    :qTabs({active:true,currentWindow:true});
  findTabs.then(async tabs=>{
    const tab=tabs[0];
      if(!tab){sendResponse({ok:false,error:"No active tab."});return}
      keyRate=+m.keyRate||63;
      // Every STN and scrap.tf page open in this window is read (the active tab
      // first), so both marketplaces are checked in one scan.
      // "sites" limits the scan to one marketplace ("stn" or "scrap.tf"); anything
      // else scans both. STN items are checked in both directions.
      const sites=m.sites==="stn"||m.sites==="scrap.tf"?m.sites:"all";
      const marketplacePage=sites==="stn"?/^https:\/\/(?:www\.)?stntrading\.eu\//i
        :sites==="scrap.tf"?/^https:\/\/(?:www\.)?scrap\.tf\//i
        :/^https:\/\/(?:www\.)?(?:stntrading\.eu|scrap\.tf)\//i;
      const windowTabs=await qTabs({windowId:tab.windowId}).catch(()=>[tab]);
      const pageTabs=[tab,...windowTabs.filter(other=>other.id!==tab.id)].filter(other=>marketplacePage.test(String(other.url||"")));
      // The Craft Hats section is hundreds of 1.77 ref hats that Backpack.tf
      // buyers never pay that much for; skipping it saves most of the scan.
      const skipCraft=(await storageGet({scrapSkipCraft:true})).scrapSkipCraft!==false;
      const found=[];
      const tabsBySource={};
      let craftSkipped=0;
      for(const pageTab of pageTabs){
        const page=await msgTab(pageTab.id,{type:"READ_BUY_PAGE"}).catch(()=>null);
        for(const entry of page?.items||[]){
          const source=entry.source==="scrap.tf"?"scrap.tf":"stn";
          if(source==="scrap.tf"&&skipCraft&&entry.category==="Craft Hats"){craftSkipped++;continue}
          found.push({...entry,source});
          if(!Number.isInteger(tabsBySource[source]))tabsBySource[source]=pageTab.id;
        }
      }
      if(!found.length){
        sendResponse({ok:false,error:craftSkipped
          ?"Only Craft Hats were found on the scrap.tf page and they are skipped (see the checkbox in the popup)."
          :(sites==="stn"?"No STN items found. Open the stntrading.eu hats listing first."
            :sites==="scrap.tf"?"No scrap.tf items found. Open scrap.tf/buy/hats first (signed in)."
            :"No TF2 marketplace items found. Open stntrading.eu and/or scrap.tf/buy/hats first.")});
        return;
      }
      // Every STN item is also checked the other way round: buy on Backpack.tf and
      // sell to STN (see processReverseItem). That is not tied to the cheaper-site
      // choice below, because STN pays for the item whichever site sells it cheaper.
      const reverseByKey=new Map();
      for(const entry of found){
        if(entry.source!=="stn")continue;
        const reverseKey=TF2CheckedItems.keyFor(entry.name);
        if(!reverseKey||reverseByKey.has(reverseKey))continue;
        reverseByKey.set(reverseKey,{name:entry.name,price:entry.price,stock:entry.stock??null,href:entry.href||"",source:"stn",reverse:true});
      }
      // An item listed on both sites is checked once, at the cheaper price: that
      // is the one worth buying.
      const cheapest=new Map();
      for(const entry of found){
        const spec=getBackpackSpec(entry.name);
        const key=`${spec.quality}|${spec.craftability}|${normalizeTradeItemName(spec.itemName)}`;
        const current=cheapest.get(key);
        if(!current){cheapest.set(key,entry);continue}
        const price=parsePrice(entry.price)?.refValue;
        const currentPrice=parsePrice(current.price)?.refValue;
        if(Number.isFinite(price)&&(!Number.isFinite(currentPrice)||price<currentPrice))cheapest.set(key,entry);
      }
      const items=[...cheapest.values()];
      const sources={};
      for(const entry of items)sources[entry.source]=(sources[entry.source]||0)+1;
      // Items checked within the last 60 minutes at the same price are not
      // checked again; they are shown as "Already checked" instead.
      const checkedMap=(await storageGet({[TF2CheckedItems.STORAGE_KEY]:{}}))[TF2CheckedItems.STORAGE_KEY]||{};
      const toScan=[];
      const alreadyChecked=[];
      const reverseHandled=new Set();
      const planReverse=key=>{
        const candidate=reverseByKey.get(key);
        if(!candidate||reverseHandled.has(key))return;
        reverseHandled.add(key);
        const previous=TF2CheckedItems.skipEntry(checkedMap,candidate,Date.now(),"reverse");
        if(previous)alreadyChecked.push(alreadyCheckedResult(candidate,previous,"reverse"));
        else toScan.push(candidate);
      };
      // An item's two directions are queued next to each other, so it is fully
      // checked (and grayed out on the marketplace page) as soon as possible.
      for(const entry of items){
        const previous=TF2CheckedItems.skipEntry(checkedMap,entry);
        if(previous)alreadyChecked.push(alreadyCheckedResult(entry,previous,"forward"));
        else toScan.push(entry);
        planReverse(TF2CheckedItems.keyFor(entry.name));
      }
      for(const key of reverseByKey.keys())planReverse(key);
      sourceTabsBySource=tabsBySource;
      sourceTabId=tab.id;
      sourceWindowId=tab.windowId;
      if(Number.isFinite(+m.notificationVolume))notificationVolume=Math.max(0,Math.min(1,+m.notificationVolume));
      if(typeof m.autoTradesEnabled==="boolean"){
        tradeAutomationEnabled=m.autoTradesEnabled;
        storageSet({tradeAutomationEnabled});
      }
      if(reverseByKey.size)sources["stn-reverse"]=reverseByKey.size;
      queue=interleaveBySource(toScan);scanQueuedCount=queue.length;autoRescanContext=tabsBySource.stn!==undefined?{tabId:tab.id,sites,stnTabId:tabsBySource.stn}:null;total=items.length+reverseByKey.size;running=true;results=[...alreadyChecked];checked=results.length;notifiedDeals.clear();endSoundPlayed=false;
      await saveState({running:true,checked,total,queueLength:queue.length,lastResult:null,finished:false});
      sendResponse({ok:true,total,sources,alreadyChecked:alreadyChecked.length});
      emitAlreadyChecked(alreadyChecked);
      emitTradeAutomationStatus(tradeAutomationEnabled?"Automatic trade execution is enabled for price-profitable deals.":"Scanning with automatic trade execution disabled.");
    next();
  }).catch(error=>sendResponse({ok:false,error:error?.message||String(error)}));
}

const AUTO_RESCAN_PAUSE_MS=15000;
// When nothing new was queued (every item was checked within the last hour) the
// next round waits longer, so the STN page is not hammered.
const AUTO_RESCAN_IDLE_PAUSE_MS=120000;

// Waits `ms`, ending early (false) when the rescan was cancelled.
async function autoRescanWait(token,ms){
  const end=Date.now()+ms;
  while(Date.now()<end){
    if(token!==autoRescanToken||!autoRescanContext)return false;
    await sleep(Math.min(1000,Math.max(50,end-Date.now())));
  }
  return token===autoRescanToken&&Boolean(autoRescanContext);
}

// A scan of an STN page finished: refresh that page (its own link), press PageDown
// three times and scan again, until Stop is pressed or another scan is started.
async function startAutoRescan(context){
  const settings=await storageGet({stnAutoRescan:true});
  if(settings.stnAutoRescan===false||!Number.isInteger(context?.stnTabId))return;
  const token=++autoRescanToken;
  const idle=scanQueuedCount===0;
  const pause=idle?AUTO_RESCAN_IDLE_PAUSE_MS:AUTO_RESCAN_PAUSE_MS;
  emitTradeAutomationStatus(`Scan finished. Refreshing the STN page and scanning again in ${Math.round(pause/1000)}s${idle?" (everything was checked recently)":""}. Press Stop to end this.`);
  if(!await autoRescanWait(token,pause))return;
  if(running)return;
  const stnTab=await getTabInfo(context.stnTabId);
  if(!stnTab||!/^https:\/\/(?:www\.)?stntrading\.eu\//i.test(String(stnTab.url||""))){
    autoRescanContext=null;
    emitTradeAutomationStatus("The STN page is no longer open, so the automatic rescan ended.");
    return;
  }
  emitTradeAutomationStatus("Refreshing the STN page and pressing PageDown 3 times…");
  try{await updateTab(stnTab.id,{active:true})}catch(error){}
  const watch=watchTabNavigation(stnTab.id);
  try{
    await reloadTab(stnTab.id);
    const deadline=Date.now()+30000;
    while(!watch.complete&&Date.now()<deadline)await sleep(250);
  }finally{watch.stop()}
  if(token!==autoRescanToken||!autoRescanContext||running)return;
  await sleep(1500);
  let pressed=false;
  const pressDeadline=Date.now()+10000;
  while(!pressed&&Date.now()<pressDeadline){
    try{pressed=Boolean((await msgTab(stnTab.id,{type:"PAGE_DOWN",times:3,delayMs:700}))?.ok)}
    catch(error){await sleep(500)}
  }
  await sleep(2500);
  if(token!==autoRescanToken||!autoRescanContext||running)return;
  const origin=await getTabInfo(context.tabId);
  const result=await new Promise(resolve=>startItemScan({type:"START_SCAN",sites:context.sites,keyRate,tabId:origin?context.tabId:stnTab.id},resolve));
  if(!result?.ok){
    autoRescanContext=null;
    emitTradeAutomationStatus(`The automatic rescan ended: ${result?.error||"the scan could not start."}`);
  }
}

setInterval(()=>{if(running)saveState({finished:false})},CHECKPOINT_MS);

api.runtime.onMessage.addListener((m,s,sendResponse)=>{
  if(m.type==="START_SCAN"){
    autoRescanToken++;
    startItemScan(m,sendResponse);
    return true;
  }
  if(m.type==="START_REVERSE_SCAN"){
    (async()=>{
      if(running){sendResponse({ok:false,error:"A scan is already running. Stop it first."});return}
      autoRescanContext=null;autoRescanToken++;
      const tabs=await qTabs({active:true,currentWindow:true}).catch(()=>[]);
      const tab=tabs[0];
      if(!tab){sendResponse({ok:false,error:"No active tab."});return}
      keyRate=+m.keyRate||63;
      const stnPage=/^https:\/\/(?:www\.)?stntrading\.eu\//i;
      const windowTabs=await qTabs({windowId:tab.windowId}).catch(()=>[tab]);
      const pageTabs=[tab,...windowTabs.filter(other=>other.id!==tab.id)].filter(other=>stnPage.test(String(other.url||"")));
      const found=new Map();
      const tabsBySource={};
      for(const pageTab of pageTabs){
        const page=await msgTab(pageTab.id,{type:"READ_BUY_PAGE"}).catch(()=>null);
        for(const entry of page?.items||[]){
          if(entry.source==="scrap.tf")continue;
          const key=TF2CheckedItems.keyFor(entry.name);
          if(!key||found.has(key))continue;
          found.set(key,{name:entry.name,price:entry.price,stock:entry.stock??null,href:entry.href||"",source:"stn",reverse:true});
          if(!Number.isInteger(tabsBySource.stn))tabsBySource.stn=pageTab.id;
        }
      }
      if(!found.size){sendResponse({ok:false,error:"No STN items found. Open the stntrading.eu hats listing first."});return}
      sourceTabsBySource=tabsBySource;
      sourceTabId=tab.id;
      sourceWindowId=tab.windowId;
      if(Number.isFinite(+m.notificationVolume))notificationVolume=Math.max(0,Math.min(1,+m.notificationVolume));
      const checkedMap=(await storageGet({[TF2CheckedItems.STORAGE_KEY]:{}}))[TF2CheckedItems.STORAGE_KEY]||{};
      const toScan=[];
      const alreadyChecked=[];
      for(const candidate of found.values()){
        const previous=TF2CheckedItems.skipEntry(checkedMap,candidate,Date.now(),"reverse");
        if(previous)alreadyChecked.push(alreadyCheckedResult(candidate,previous,"reverse"));
        else toScan.push(candidate);
      }
      queue=toScan;
      total=found.size;running=true;results=[...alreadyChecked];checked=results.length;notifiedDeals.clear();endSoundPlayed=false;
      await saveState({running:true,checked,total,queueLength:queue.length,lastResult:null,finished:false});
      sendResponse({ok:true,total,sources:{"stn-reverse":total},alreadyChecked:alreadyChecked.length});
      emitAlreadyChecked(alreadyChecked);
      emitTradeAutomationStatus("Checking what STN pays for each hat against Backpack.tf sell listings. Nothing is bought automatically on this side.");
      next();
    })().catch(error=>sendResponse({ok:false,error:error?.message||String(error)}));
    return true;
  }
  if(m.type==="START_SAVED_SCAN"){
    (async()=>{
      if(running){sendResponse({ok:false,error:"A scan is already running. Stop it first."});return}
      autoRescanContext=null;autoRescanToken++;
      const stored=await storageGet({[TF2SavedTrades.STORAGE_KEY]:{}});
      const saved=TF2SavedTrades.list(stored[TF2SavedTrades.STORAGE_KEY]);
      if(!saved.length){sendResponse({ok:false,error:"No saved items yet. Items are saved when they are found to be Good Trades."});return}
      const tabs=await qTabs({active:true,currentWindow:true}).catch(()=>[]);
      keyRate=+m.keyRate||63;
      sourceTabId=tabs[0]?.id??null;
      sourceWindowId=tabs[0]?.windowId??null;
      if(Number.isFinite(+m.notificationVolume))notificationVolume=Math.max(0,Math.min(1,+m.notificationVolume));
      if(typeof m.autoTradesEnabled==="boolean"){
        tradeAutomationEnabled=m.autoTradesEnabled;
        storageSet({tradeAutomationEnabled});
      }
      queue=saved.map(entry=>entry.source==="scrap.tf"
        ?{name:entry.name,price:entry.buyPrice||"",stock:null,href:entry.sourceHref||SCRAP_BUY_URL,source:"scrap.tf",scrapValue:entry.scrapValue||null,fromSaved:true}
        :{name:entry.name,price:entry.buyPrice||"",stock:null,href:marketplaceUrl(entry.name),fromSaved:true});
      scrapPageCache=null;
      total=queue.length;checked=0;running=true;results=[];notifiedDeals.clear();endSoundPlayed=false;
      await saveState({running:true,checked:0,total,queueLength:queue.length,lastResult:null,finished:false});
      sendResponse({ok:true,total});
      emitTradeAutomationStatus(`Checking ${total} saved item${total===1?"":"s"} on STN or scrap.tf and Backpack.tf.`);
      next();
    })().catch(error=>sendResponse({ok:false,error:error?.message||String(error)}));
    return true;
  }
  if(m.type==="STOP_SCAN"){
    running=false;queue=[];
    autoRescanContext=null;autoRescanToken++;
    sourceTabId=null;
    closeCurrentTab()
      .then(()=>closeAllOwnedTabs())
      .then(()=>{
        scanItemBusy=false;
        // A running trade keeps the scanner window until it finishes.
        return closeAutomationWindowIfIdle();
      })
      .finally(()=>saveState({running:false,queueLength:0}).finally(()=>sendResponse({ok:true})));
    return true;
  }
  if(m.type==="RETRY_ITEM"){
    const item=m.item;
    if(!item?.name){sendResponse({ok:false,error:"Missing item to retry."});return}
    const wasRunning=running;
    queue.unshift(item);
    total++;
    running=true;
    saveState({running:true,queueLength:queue.length,finished:false,lastResult:null}).then(()=>{
      if(!wasRunning)next();
      sendResponse({ok:true});
    });
    return true;
  }
  if(m.type==="SET_VOLUME"){
    if(Number.isFinite(+m.volume))notificationVolume=Math.max(0,Math.min(1,+m.volume));
    sendResponse({ok:true,volume:notificationVolume});
    return true;
  }
  if(m.type==="SET_TRADE_AUTOMATION"){
    const enabled=Boolean(m.enabled);
    tradeAutomationEnabled=enabled;
    storageSet({tradeAutomationEnabled:enabled});
    if(!enabled&&tradeAutomationQueue.some(job=>!job.resendOf)){
      // Re-sends belong to offers already sent, so they stay queued.
      const removed=tradeAutomationQueue.filter(job=>!job.resendOf).length;
      tradeAutomationQueue=tradeAutomationQueue.filter(job=>job.resendOf);
      emitTradeAutomationStatus(`Automatic trading disabled; cancelled ${removed} queued item trade${removed===1?"":"s"}. The active item workflow, if any, will finish safely.`);
    }else{
      emitTradeAutomationStatus(enabled?"Automatic trade execution enabled. New Good Trades will be queued.":"Automatic trade execution disabled.");
    }
    if(enabled)runTradeQueue();
    sendResponse({ok:true,state:getTradeAutomationState()});
    return true;
  }
  if(m.type==="OPEN_VERIFIED_BACKPACK_PAGES"){
    const verifiedListings=sufficientOfferListings(m.result);
    if(!verifiedListings.length){
      sendResponse({ok:false,error:"No profitable listing was verified to have enough metal."});
      return;
    }
    const windowId=Number.isInteger(sourceWindowId)?sourceWindowId:s?.tab?.windowId;
    openAndHighlightBackpackPages(
      verifiedListings,
      String(m.result?.name||""),
      String(m.result?.backpackUrl||""),
      windowId,
      false
    ).then(opened=>{
      sendResponse({
        ok:opened.tabs.length>0,
        pages:opened.pages,
        highlighted:opened.highlighted,
        missing:opened.missing,
        errors:opened.errors,
        error:opened.tabs.length?undefined:"Could not open a Backpack.tf listings page."
      });
    }).catch(error=>sendResponse({ok:false,error:error.message||String(error)}));
    return true;
  }
  if(m.type==="FORCE_VERIFIED_AUTO_TRADE"){
    const result=enqueueTradeJob(m.result,{forceManual:true,skipPurchase:true});
    sendResponse(result);
    return true;
  }
  if(m.type==="TRADE_PURCHASE_PROGRESS"||m.type==="TRADE_PURCHASE_FAILED"||m.type==="TRADE_PURCHASE_ACCEPTED"){
    const purchaseJob=activeTradeJob;
    const fromActivePurchaseTab=
      purchaseJob?.step==="waiting-for-purchase-acceptance"&&
      Number.isInteger(s?.tab?.id)&&
      purchaseJob.purchaseTabId===s.tab.id&&
      purchaseJob.purchaseOfferId===String(m.tradeOfferId||"");
    if(!fromActivePurchaseTab)return false;

    if(m.type==="TRADE_PURCHASE_PROGRESS"){
      const allowedPhases=new Set([
        "offer-page-loaded",
        "waiting-for-contents-control",
        "waiting-for-items",
        "contents-reset",
        "contents-confirmed",
        "accept-control-ready",
        "accept-clicked",
        "accept-request-failed",
        "accept-click-retried",
        "waiting-for-steam-status",
        "mobile-confirmation-pending",
        "steam-accepted-observed",
        "steam-accepted"
      ]);
      const phase=String(m.phase||"");
      if(!allowedPhases.has(phase))return false;
      const pageProgress={
        phase,
        message:String(m.message||"").slice(0,240),
        evidence:String(m.evidence||"").slice(0,320),
        offerId:purchaseJob.purchaseOfferId,
        updatedAt:Date.now()
      };
      const previousPageProgress=purchaseJob.purchasePageProgress;
      if(!previousPageProgress||previousPageProgress.phase!==pageProgress.phase){
        purchaseJob.purchasePageProgress=pageProgress;
        const pageMessage=phase==="steam-accepted"||phase==="steam-accepted-observed"
          ?`Steam's offer page indicates accepted for #${purchaseJob.purchaseOfferId}; waiting for numerical Web API confirmation.`
          :phase==="mobile-confirmation-pending"
            ?`The offer page suggests mobile confirmation is pending for #${purchaseJob.purchaseOfferId}; Steam Web API state remains authoritative.`
            :`Steam offer page progress: ${pageProgress.message||phase}. Final completion is checked through the Web API.`;
        emitTradeAutomationStatus(pageMessage);
      }
      return false;
    }

    if(m.type==="TRADE_PURCHASE_FAILED"){
      const message=String(m.message||"Steam did not confirm acceptance.").slice(0,320);
      purchaseJob.purchasePageProgress={
        phase:"acceptance-failed",
        message,
        evidence:"",
        offerId:purchaseJob.purchaseOfferId,
        updatedAt:Date.now()
      };
      emitTradeAutomationStatus(`The offer page could not verify acceptance for #${purchaseJob.purchaseOfferId}: ${message} Steam Web API polling remains authoritative.`);
      return false;
    }

    const jobId=String(m.jobId||"");
    if(
      m.confirmed===true&&
      (!jobId||jobId===purchaseJob.id)
    ){
      // Steam's own answer to the accept request is authoritative when it needs
      // no mobile/email confirmation: there is no reason to wait for the lagging
      // Web API to say the same thing.
      if(m.evidenceSource==="Steam accept request"&&m.needsConfirmation!==true){
        purchaseJob.purchaseAcceptedOfferId=purchaseJob.purchaseOfferId;
      }else if(m.needsConfirmation===true){
        purchaseJob.purchaseNeedsConfirmationOfferId=purchaseJob.purchaseOfferId;
      }
      purchaseJob.purchasePageProgress={
        phase:"steam-accepted-observed",
        message:"The offer page reports accepted; Steam Web API state 3 is still required.",
        evidence:String(m.evidence||"").slice(0,320),
        evidenceSource:String(m.evidenceSource||""),
        offerId:purchaseJob.purchaseOfferId,
        updatedAt:Date.now()
      };
      emitTradeAutomationStatus(purchaseJob.purchaseAcceptedOfferId===purchaseJob.purchaseOfferId
        ?`Steam's accept request for offer #${purchaseJob.purchaseOfferId} succeeded; continuing without waiting for the Web API.`
        :`Steam's offer page indicates offer #${purchaseJob.purchaseOfferId} is accepted; verifying trade_offer_state=3 through Steam Web API.`);
    }
    return false;
  }
  if(m.type==="TRADE_LISTING_RETRYING"||m.type==="TRADE_LISTING_RETRY_FAILED"){
    const jobId=String(m.jobId||"");
    const listingJob=activeTradeJob;
    const fromActiveListingTab=
      listingJob?.step==="sending-bot-offers"&&
      listingJob.currentListingOperationId===jobId&&
      Number.isInteger(s?.tab?.id)&&
      listingJob.currentOfferTabId===s.tab.id&&
      transactionTabIds.has(s.tab.id);
    if(!fromActiveListingTab)return false;

    if(m.type==="TRADE_LISTING_RETRYING"){
      const attempt=Math.max(1,Number(m.attempt)||1);
      const maxAttempts=Math.max(attempt,Number(m.maxAttempts)||1);
      emitTradeAutomationStatus(
        `Steam rejected the bot offer for ${listingJob.name}. The trade page is being refreshed for retry ${attempt}/${maxAttempts}.`
      );
    }else{
      const message=String(m.message||"Steam rejected the bot offer after its page-refresh retry.").slice(0,320);
      emitTradeAutomationStatus(`Could not send the bot offer for ${listingJob.name}: ${message}`);
      settleTradeEvent(`TRADE_LISTING_SENT:${jobId}`,null,new Error(message));
    }
    return false;
  }
  if(m.type==="TRADE_LISTING_SENT"){
    const jobId=String(m.jobId||"");
    const listingJob=activeTradeJob;
    const fromActiveListingTab=
      listingJob?.step==="sending-bot-offers"&&
      listingJob.currentListingOperationId===jobId&&
      Number.isInteger(s?.tab?.id)&&
      listingJob.currentOfferTabId===s.tab.id&&
      transactionTabIds.has(s.tab.id);
    if(fromActiveListingTab)settleTradeEvent(`${m.type}:${jobId}`,m);
    return false;
  }
  if(m.type==="GET_STATE"){
    storageGet({scanState:null}).then(v=>sendResponse({
      state:v.scanState,
      version:EXTENSION_VERSION,
      tradeAutomation:getTradeAutomationState()
    })).catch(()=>sendResponse({state:null,version:EXTENSION_VERSION,tradeAutomation:getTradeAutomationState()}));
    return true;
  }
});
