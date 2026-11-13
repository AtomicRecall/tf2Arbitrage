// Fills in the "Mac confirmer" settings from a config file packed into the
// add-on by browserShell/launch.py (mac-confirmer.json: url, token, enabled).
//
// When the add-on is loaded some other way the file does not exist and nothing
// happens, so manual settings are never touched in that case. When it does
// exist it is the source of truth for the address and token (the launcher
// creates the token), while the on/off choice is only defaulted: once a
// setting has been saved, the checkbox in the popup/sidebar stays in charge.
(function(root){
  const api=typeof browser!=="undefined"?browser:(typeof chrome!=="undefined"?chrome:null);
  const CONFIG_FILE="mac-confirmer.json";
  const STORAGE_KEY="macConfirmer";
  // Only this machine is ever configured automatically.
  const LOCAL_URL=/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/i;

  // The settings to store for a bundled config, or null if it is unusable.
  function mergedSettings(bundle,stored){
    const url=String(bundle?.url||"").trim().replace(/\/+$/,"");
    const token=String(bundle?.token||"").trim();
    if(!LOCAL_URL.test(url)||token.length<16)return null;
    const hasSaved=Boolean(stored&&(stored.url||stored.token));
    return {
      url,
      token,
      enabled:hasSaved?Boolean(stored.enabled):bundle.enabled!==false
    };
  }

  async function seed(){
    if(!api?.storage?.local||!api?.runtime?.getURL)return false;
    let bundle;
    try{
      const response=await fetch(api.runtime.getURL(CONFIG_FILE),{cache:"no-store"});
      if(!response.ok)return false;
      bundle=await response.json();
    }catch{return false}

    const stored=(await api.storage.local.get({[STORAGE_KEY]:{}}))[STORAGE_KEY];
    const next=mergedSettings(bundle,stored);
    if(!next)return false;
    if(stored&&stored.url===next.url&&stored.token===next.token&&Boolean(stored.enabled)===next.enabled)return false;
    await api.storage.local.set({[STORAGE_KEY]:next});
    return true;
  }

  const exported={CONFIG_FILE,mergedSettings,seed};
  if(typeof module!=="undefined"&&module.exports)module.exports=exported;
  else{
    root.TF2MacConfirmerSeed=exported;
    seed().then(changed=>{if(changed)console.log("Mac confirmer settings were filled in by the launcher.")})
      .catch(error=>console.warn("Could not apply the bundled Mac confirmer settings:",error));
  }
})(typeof self!=="undefined"?self:this);
