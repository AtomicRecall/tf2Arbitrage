(() => {
  "use strict";

  const METAL_IMAGES = Object.freeze({
    refined:
      "https://community.fastly.steamstatic.com/economy/image/fWFc82js0fmoRAP-qOIPu5THSWqfSmTELLqcUywGkijVjZULUrsm1j-9xgEbZQsUYhTkhzJWhsO1Mv6NGucF1Ygzt8ZQijJukFMiMrbhYDEwI1yRVKNfD6xorQ3qW3Jr6546DNPuou9IOVK4p4kWJaA/96fx96f",
    reclaimed:
      "https://community.fastly.steamstatic.com/economy/image/fWFc82js0fmoRAP-qOIPu5THSWqfSmTELLqcUywGkijVjZULUrsm1j-9xgEbZQsUYhTkhzJWhsO0Mv6NGucF1YJlscMEgDdvxVYsMLPkMmFjI1OSUvMHDPBp9lu0CnVluZQxA9Gwp-hIOVK4sMMNWF4/96fx96f",
    scrap:
      "https://community.fastly.steamstatic.com/economy/image/fWFc82js0fmoRAP-qOIPu5THSWqfSmTELLqcUywGkijVjZULUrsm1j-9xgEbZQsUYhTkhzJWhsPZAfOeD-VOn4phtsdQ32ZtxFYoN7PkYmVmIgeaUKNaX_Rjpwy8UHMz6pcxAIfnovUWJ1t9nYFqYw/96fx96f"
  });

  const METAL_VALUES = Object.freeze({ refined: 9, reclaimed: 3, scrap: 1 });
  const KEY_NAME = "Mann Co. Supply Crate Key";
  const KEY_IMAGE_URL = "https://community.fastly.steamstatic.com/economy/image/fWFc82js0fmoRAP-qOIPu5THSWqfSmTELLqcUywGkijVjZULUrsm1j-9xgEAaR4uURrwvz0N252yVaDVWrRTno9m4ccG2GNqxlQoZrC2aG9hcVGUWflbX_drrVu5UGki5sAij6tOtQ/96fx96f";
  const TOUR_TICKET_NAME = "Tour of Duty Ticket";
  const EXTENSION_VERSION = browser.runtime.getManifest().version;
  const INVENTORY_SELECTION_RESPONSE_TIMEOUT_MS = 50000;
  const INVENTORY_SIDE_READY_TIMEOUT_MS = 45000;
  const INVENTORY_SELECTION_VERIFICATION_TIMEOUT_MS = 8000;
  const INVENTORY_TAB_RECOVERY_TIMEOUT_MS = 15000;
  const TRADE_SUBMISSION_RETRY_STORAGE_KEY = "tf2MetalTraderSubmissionRetry";
  const MAX_TRADE_SUBMISSION_REFRESH_RETRIES = 3;
  const TRADE_SUBMISSION_REFRESH_DELAYS_MS = [1500, 3000, 5000];
  let yourInventoryContainerId = "";
  let theirInventoryContainerId = "";
  let traderMetalVerificationPromise = null;


  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  // Faster polling keeps the addon responsive without relying on long fixed sleeps.
  const FAST_POLL_MS = 25;

  function isVisible(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && rect.width > 0 && rect.height > 0;
  }

  function convertMetalAmount(input, itemUnitPrice = null, itemCount = 1) {
    const amount = Number(input);
    if (!Number.isFinite(amount) || amount < 0) throw new Error("Enter a valid metal amount.");

    const sourcePrice = Number(itemUnitPrice);
    const hasSourcePrice = itemUnitPrice !== null && itemUnitPrice !== undefined && Number.isFinite(sourcePrice);
    const quantity = Number(itemCount);
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      throw new Error("Enter a valid whole-item quantity.");
    }
    const sourceDecimals = hasSourcePrice ? sourcePrice.toFixed(2).split(".")[1] : "";
    const sourceTens = Number(sourceDecimals[0] || "0");
    const sourceOnes = Number(sourceDecimals[1] || "0");
    const cleanUnitPrice = hasSourcePrice &&
      (sourceOnes === 0 || sourceTens === sourceOnes);
    const roundCleanPriceUp = cleanUnitPrice && quantity > 1;

    // A single half-scrap price stays exact and uses a weapon. Only a grouped
    // multi-item payment rounds a clean unit price up to the next whole scrap.
    const totalScrap = roundCleanPriceUp
      ? Math.ceil(amount * 9 - 1e-9)
      : Math.round(amount * 9 * 2) / 2;
    const wholeScrap = Math.floor(totalScrap);

    return {
      totalScrap,
      refined: Math.floor(wholeScrap / 9),
      reclaimed: Math.floor((wholeScrap % 9) / 3),
      scrap: wholeScrap % 3,
      halfScrap: !roundCleanPriceUp && totalScrap % 1 === 0.5,
      roundedForMultipleItems: roundCleanPriceUp
    };
  }

  function isSteamInventoryDisplayed(element) {
    if (!element) return false;
    // Steam's inventory renderer can temporarily give the element zero
    // geometry while it is rebuilding. Geometry-based visibility therefore
    // causes false "no inventory" errors. For these inventory nodes, the
    // reliable signal is their display state.
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function findActiveTF2InventoryPage(throwOnMissing = true) {
    const inventoryBox = document.querySelector("#inventories");
    if (!inventoryBox) {
      if (throwOnMissing) throw new Error("Steam's inventory box was not found.");
      return null;
    }

    // The trade page keeps both users' inventories in the DOM. Steam marks
    // the active TF2 inventory with an inventory_ctn whose id contains
    // _440_2. Do not use getBoundingClientRect() here because Steam can
    // temporarily report zero dimensions while replacing the contents.
    const inventories = [...inventoryBox.querySelectorAll('.inventory_ctn[id*="_440_2"]')];
    for (const inventory of inventories) {
      if (!isSteamInventoryDisplayed(inventory)) continue;

      const pages = [...inventory.querySelectorAll(".inventory_page")];
      const page = pages.find(isSteamInventoryDisplayed);
      if (page) return page;

      // The correct TF2 container exists, but Steam has not inserted its page
      // yet. Keep waiting instead of incorrectly claiming TF2 is not selected.
      if (pages.length === 0) return null;
    }

    if (throwOnMissing) {
      throw new Error("No visible TF2 inventory page found. Select Team Fortress 2 first.");
    }
    return null;
  }


  async function waitForInventoryBox(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const box = document.querySelector("#inventory_box");
      if (box) return box;
      await sleep(FAST_POLL_MS);
    }
    throw new Error("Steam did not finish loading the trade inventory.");
  }

  async function waitForInventoryDom(timeoutMs = 1800) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const page = findActiveTF2InventoryPage(false);
      if (page) return page;
      await sleep(FAST_POLL_MS);
    }
    return findActiveTF2InventoryPage(false);
  }



  function getActiveTF2InventoryContainer(side) {
    const box = document.querySelector("#inventory_box");
    if (!box) return null;
    const theirSideActive = box.classList.contains("their_inventory_active");
    const requestedSideActive = side === "their" ? theirSideActive : !theirSideActive;
    const expectedContainerId = side === "their" ? theirInventoryContainerId : yourInventoryContainerId;
    const visibleContainers = [...document.querySelectorAll('.inventory_ctn[id*="_440_2"]')]
      .filter(isSteamInventoryDisplayed);

    if (expectedContainerId) {
      const expectedContainer = visibleContainers.find(container => container.id === expectedContainerId);
      if (!expectedContainer) return null;
      const identityIsUnambiguous =
        visibleContainers.length === 1 && visibleContainers[0] === expectedContainer;
      return requestedSideActive || identityIsUnambiguous ? expectedContainer : null;
    }

    // Before the bridge has identified the account-specific inventory, only
    // infer the side when the active marker and a single visible TF2 container
    // agree. Multiple visible inventories are ambiguous and must be selected.
    if (requestedSideActive && visibleContainers.length === 1) return visibleContainers[0];
    return null;
  }

  function findInventoryPageForSide(side) {
    const container = getActiveTF2InventoryContainer(side);
    if (!container) return null;
    return [...container.querySelectorAll(".inventory_page")].find(isSteamInventoryDisplayed) || null;
  }

  async function waitForInventoryReady(side, timeoutMs = INVENTORY_SIDE_READY_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const page = findInventoryPageForSide(side);
      if (page) return page;
      await sleep(FAST_POLL_MS);
    }
    throw new Error(`Steam's ${side === 'you' ? 'Your' : 'Their'} TF2 inventory was not detected as the active inventory.`);
  }

  async function ensureInventorySideReady(side) {
    await selectInventorySide(side);
    return waitForInventorySide(side);
  }

  function getAssetId(item) {
    const match = item?.id?.match(/^item(\d+)_(\d+)_(\d+)$/);
    return match ? match[3] : null;
  }

  // Steam's trade page has an internal function named MoveItemToTrade(item).
  // Calling it from the extension's isolated world does not work because the
  // page's JS globals are in a different JS world. page-bridge.js runs in the
  // Steam page's MAIN world and calls the real Steam function for us.
  let bridgeReadyPromise;
  function ensurePageBridge() {
    if (bridgeReadyPromise) return bridgeReadyPromise;

    bridgeReadyPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Steam trade bridge did not initialize.")), 5000);
      const onReady = () => {
        clearTimeout(timeout);
        window.removeEventListener("tmt-bridge-ready", onReady);
        resolve();
      };
      window.addEventListener("tmt-bridge-ready", onReady, { once: true });

      if (!document.documentElement) {
        reject(new Error("Steam page DOM is not ready."));
        return;
      }

      const script = document.createElement("script");
      script.src = browser.runtime.getURL("page-bridge.js");
      script.dataset.tmtBridge = "1";
      script.onload = () => script.remove();
      script.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("Could not inject the Steam trade bridge."));
      };
      (document.head || document.documentElement).appendChild(script);
    });

    return bridgeReadyPromise;
  }

  async function moveItemToTrade(item, side = null) {
    const assetId = getAssetId(item);
    if (!assetId) throw new Error(`Could not read Steam asset ID from ${item?.id || "item"}.`);

    await ensurePageBridge();

    return new Promise((resolve, reject) => {
      const requestId = `${assetId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timeout = setTimeout(() => {
        window.removeEventListener("tmt-move-result", onResult);
        reject(new Error(`Steam did not respond while adding asset ${assetId}.`));
      }, 5000);

      function onResult(event) {
        let detail;
        try {
          detail = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail;
        } catch {
          return;
        }
        if (!detail || detail.requestId !== requestId) return;
        clearTimeout(timeout);
        window.removeEventListener("tmt-move-result", onResult);
        if (detail.ok) resolve(detail);
        else reject(new Error(detail.error || "Steam refused the item."));
      }

      window.addEventListener("tmt-move-result", onResult);
      // Use a JSON string across Firefox's isolated-world/page-world boundary.
      window.dispatchEvent(new CustomEvent("tmt-move-item", {
        detail: JSON.stringify({ requestId, itemId: item.id, assetId, side })
      }));
    });
  }





  function countTradeAssets(side) {
    const root = document.querySelector(side === "their" ? "#their_slots" : "#your_slots");
    if (!root) return new Set();
    return new Set(
      [...root.querySelectorAll('.item[id^="item"]')]
        .map(getAssetId)
        .filter(Boolean)
    );
  }

  async function removeAllItemsFromTradeSide(side, statusCallback) {
    const rootSelector = side === "their" ? "#their_slots" : "#your_slots";
    const root = document.querySelector(rootSelector);
    if (!root) throw new Error(`Steam's ${side} trade slot was not found.`);

    // IMPORTANT: do not try to remove one asset by calling MoveItemToTrade.
    // That function ADDS an inventory item to the trade. Steam's page-world
    // inverse is MoveItemToInventory(item), which is what the bridge invokes.
    // Snapshot every item currently on the side, then clear the entire side.
    const itemIds = [...root.querySelectorAll('.item[id^="item"]')]
      .map(item => item.id)
      .filter(Boolean);

    if (itemIds.length === 0) return 0;
    return removeTradeItemsFromSide(side, itemIds, statusCallback);
  }

  async function removeTradeItemsFromSide(side, itemIds, statusCallback) {
    const rootSelector = side === "their" ? "#their_slots" : "#your_slots";
    const root = document.querySelector(rootSelector);
    if (!root) throw new Error(`Steam's ${side} trade slot was not found.`);
    const uniqueItemIds = [...new Set(itemIds)].filter(id => typeof id === "string" && id);
    if (uniqueItemIds.length === 0) return 0;

    statusCallback?.(`Removing ${uniqueItemIds.length} item${uniqueItemIds.length === 1 ? "" : "s"} from the ${side === "their" ? "trader" : "your"} side…`);

    await ensurePageBridge();

    await new Promise((resolve, reject) => {
      const requestId = `clear-${side}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timeout = setTimeout(() => {
        window.removeEventListener("tmt-remove-result", onResult);
        reject(new Error(`Steam did not respond while clearing the ${side} trade side.`));
      }, 5000);

      function onResult(event) {
        let detail;
        try {
          detail = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail;
        } catch {
          return;
        }
        if (!detail || detail.requestId !== requestId) return;

        clearTimeout(timeout);
        window.removeEventListener("tmt-remove-result", onResult);
        if (detail.ok) resolve(detail);
        else reject(new Error(detail.error || `Steam could not clear the ${side} trade side.`));
      }

      window.addEventListener("tmt-remove-result", onResult);
      window.dispatchEvent(new CustomEvent("tmt-remove-item", {
        detail: JSON.stringify({ requestId, itemIds: uniqueItemIds, side })
      }));
    });

    const removedIds = new Set(uniqueItemIds);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const remaining = [...root.querySelectorAll('.item[id^="item"]')].some(item => removedIds.has(item.id));
      if (!remaining) return uniqueItemIds.length;
      await sleep(FAST_POLL_MS);
    }

    const remainingIds = [...root.querySelectorAll('.item[id^="item"]')]
      .filter(item => removedIds.has(item.id))
      .map(item => getAssetId(item))
      .filter(Boolean);
    throw new Error(`Steam did not remove temporary items from the ${side} trade side. Remaining assets: ${remainingIds.join(", ") || "unknown"}.`);
  }

  function getFilterInput() {
    return document.querySelector("#filter_control");
  }

  function parseAssetIdList(value) {
    return [...new Set(
      String(value || "")
        .split(/[\s,]+/)
        .map(part => part.trim())
        .filter(part => /^\d{1,20}$/.test(part))
    )];
  }

  function getListingFromUrl() {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    if (params.get("tmt_listing") !== "1") return null;

    const comment = params.get("tmt_comment") || "";
    const description = params.get("tmt_description") || "";
    return {
      name: params.get("tmt_name") || "",
      price: params.get("tmt_price") || "",
      intent: resolveListingIntent(params.get("tmt_intent"), comment, description),
      assetId: params.get("tmt_asset") || "",
      quantity: params.get("tmt_quantity") || "",
      arbitrageJobId: params.get("tmt_arb_job") || "",
      // Assets already placed in earlier offers of the same run. Every offer
      // must use different copies, so these are never picked again.
      excludedAssetIds: parseAssetIdList(params.get("tmt_exclude_assets")),
      // Metal value of one key, sent by the arbitrage scanner. Used to pay a
      // key price in metal when the paying side has too few physical keys.
      keyRate: params.get("tmt_key_rate") || "",
      // Advanced inventory filters used when searching for the item itself.
      quality: params.get("tmt_quality") || "",
      cosmetic: params.has("tmt_cosmetic") ? params.get("tmt_cosmetic") === "1" : null,
      comment,
      description
    };
  }

  // Keys, tickets, crates and similar are not cosmetics, so the Cosmetic tab
  // would hide them.
  const NON_COSMETIC_ITEM_PATTERN = /\b(?:keys?|tickets?|crates?|cases?|tags?|strangifiers?|killstreak|kits?|medals?|paints?|taunts?)\b/i;

  function listingItemFilters(listing) {
    const cosmetic = typeof listing?.cosmetic === "boolean"
      ? listing.cosmetic
      : !NON_COSMETIC_ITEM_PATTERN.test(String(listing?.name || ""));
    return { quality: listing?.quality || "Unique", cosmetic };
  }

  function isArbitrageVerificationPage() {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    return params.get("tmt_verify") === "1";
  }

  function resolveListingIntent(metadataIntent, ...descriptions) {
    // An explicit intent from Backpack.tf (or from the arbitrage scanner, which
    // only passes real buy orders) wins over what the free-text description
    // happens to say.
    const intent = String(metadataIntent || "")
      .normalize("NFKC")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .trim()
      .toLowerCase();
    const metadataSaysBuying = /\b(?:buy|buying|buy order)\b/.test(intent);
    const metadataSaysSelling = /\b(?:sell|selling|sell order)\b/.test(intent);
    if (metadataSaysBuying !== metadataSaysSelling) return metadataSaysBuying ? "buy" : "sell";
    if (metadataSaysBuying && metadataSaysSelling) return "";

    const description = descriptions
      .filter(Boolean)
      .join(" ")
      .normalize("NFKC")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .toLowerCase();
    const explicitlyBuying = /\b(?:i\s+am|i['’]m|im|we\s+are|we['’]re)\s+buying\b/.test(description);
    const explicitlySelling = /\b(?:i\s+am|i['’]m|im|we\s+are|we['’]re)\s+selling\b/.test(description);
    if (explicitlyBuying !== explicitlySelling) return explicitlyBuying ? "buy" : "sell";
    return "";
  }

  function getIncomingTradeOfferId() {
    // A normal incoming Steam trade-offer page has an offer ID in the path:
    // /tradeoffer/<id>/. The /tradeoffer/new/ URL is our outgoing trade
    // composer and must never be auto-accepted.
    const match = window.location.pathname.match(/^\/tradeoffer\/(\d+)\/?$/);
    if (!match) return null;

    // Only arbitrage purchase jobs may carry a fragment on an incoming offer.
    // Other special-flow hashes are not safe to auto-accept.
    if (window.location.hash) {
      const params = new URLSearchParams(window.location.hash.slice(1));
      const jobIds = params.getAll("tmt_arb_job");
      if (
        jobIds.length !== 1 ||
        !jobIds[0] ||
        [...params.keys()].some(key => key !== "tmt_arb_job")
      ) {
        return null;
      }
    }

    return match[1];
  }

  function isIncomingTradeOfferPage() {
    return !!getIncomingTradeOfferId();
  }

  function parseListingTradePrice(price) {
    const text = String(price || "").trim().toLowerCase().replace(/,/g, "");
    if (!text) return null;

    const keyMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:keys?|mann\s*co\.?\s*supply\s*crate\s*keys?)/i);
    const refMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:ref|refined)\b/i);
    const keys = keyMatch ? Number(keyMatch[1]) : 0;
    const refined = refMatch ? Number(refMatch[1]) : 0;

    if (!Number.isFinite(keys) || !Number.isFinite(refined) || keys < 0 || refined < 0) return null;
    if (!keyMatch && !refMatch) return null;
    if (!Number.isInteger(keys)) return null;
    return { keys, refined };
  }

  function parseListingMetalPrice(price) {
    const parsed = parseListingTradePrice(price);
    if (!parsed || parsed.keys !== 0) return null;
    return parsed.refined;
  }

  // Backpack.tf listing comments can contain stock/demand fractions such as
  // "91/100", "3/5", or "74/100". Look for a slash or backslash with
  // digits on both sides and interpret right - left as the available quantity.
  // A labeled stock fraction takes precedence over a plain stock count.
  // There can also be unrelated fractions in the listing text (for example
  // "24/7 Yorozuya Shop"), so ignore fractions whose left side exceeds the
  // right side.
  //
  // Some sellers state the quantity as "up to 50" instead of a fraction.
  // That is treated as a request for 50 items.
  function parseListingRequestedQuantity(comment) {
    // Backpack.tf comments can contain Unicode-styled digits, such as the
    // mathematical bold digits in "𝟒𝟔𝟒 / 𝟓𝟎𝟎". JavaScript's \d only
    // matches ASCII 0-9, so normalize compatibility characters first.
    const text = String(comment || "").normalize("NFKC");

    // Some buy orders state the desired quantity explicitly, e.g.
    // "I CAN BUY 2". Treat that as the requested number of copies.
    const canBuyMatch = text.match(/\b(?:i\s+)?can\s+buy\s+(\d+)\b/i);
    if (canBuyMatch) {
      const quantity = Number.parseInt(canBuyMatch[1], 10);
      if (Number.isFinite(quantity) && quantity >= 0) return quantity;
    }

    // Sell-order comments use the same general idea, but sellers commonly
    // state the quantity as "Selling 2", "I am selling 1", etc.  Check this
    // before the stock/fraction forms so an explicit per-listing quantity is
    // respected.  Unicode-styled digits are already converted by NFKC above.
    const sellingMatch = text.match(/\b(?:i\s+am\s+|i\s+)?selling\s+(\d+)\b/i);
    if (sellingMatch) {
      const quantity = Number.parseInt(sellingMatch[1], 10);
      if (Number.isFinite(quantity) && quantity >= 0) return quantity;
    }

    // Examples: Stock 0/5 means five remain; Stock 2/5 means three remain.
    const stockFraction = text.match(
      /\b(?:stock|have|storage|carry|currently\s+have|current\s+stock)\s*[:=]?\s*\[?\s*(\d+)\s*(?:\/|\\|\||out\s+of)\s*(\d+)\b/i
    );
    if (stockFraction) {
      const current = Number.parseInt(stockFraction[1], 10);
      const maximum = Number.parseInt(stockFraction[2], 10);
      if (Number.isInteger(current) && Number.isInteger(maximum) && maximum > 0 && current <= maximum) {
        return maximum - current;
      }
    }

    const outOfFraction = text.match(/\b(\d+)\s+out\s+of\s+(\d+)\b/i);
    if (outOfFraction) {
      const current = Number.parseInt(outOfFraction[1], 10);
      const maximum = Number.parseInt(outOfFraction[2], 10);
      if (Number.isInteger(current) && Number.isInteger(maximum) && maximum > 0 && current <= maximum) {
        return maximum - current;
      }
    }

    // Some grouped listings use a plain remaining count such as "Stock: 5".
    const stockMatch = text.match(/\bstock\s*[:=-]?\s*(\d+)\b/i);
    if (stockMatch) {
      const quantity = Number.parseInt(stockMatch[1], 10);
      if (Number.isFinite(quantity) && quantity >= 0) return quantity;
    }

    const fractionMatches = text.matchAll(/(\d+)\s*[\/\\]\s*(\d+)/g);
    for (const match of fractionMatches) {
      const current = Number.parseInt(match[1], 10);
      const maximum = Number.parseInt(match[2], 10);
      const quantity = maximum - current;

      if (Number.isFinite(quantity) && quantity >= 0 && maximum > 0 && current <= maximum) {
        return quantity;
      }
    }

    const upToMatch = text.match(/\bup\s+to\s+(\d+)\b/i);
    if (upToMatch) {
      const quantity = Number.parseInt(upToMatch[1], 10);
      if (Number.isFinite(quantity) && quantity >= 0) return quantity;
    }

    return 1;
  }

  function parseRequestedListingQuantityOverride(value) {
    const text = String(value || "").trim();
    if (!text) return Number.POSITIVE_INFINITY;
    const quantity = Number.parseInt(text, 10);
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(quantity) || quantity < 1) {
      throw new Error(`Invalid requested listing quantity "${text}".`);
    }
    return quantity;
  }

  function getRequestedListingQuantity(listing) {
    const override=parseRequestedListingQuantityOverride(listing?.quantity);
    if(Number.isFinite(override))return override;
    const description=[listing?.comment,listing?.description].filter(Boolean).join(" ");
    return parseListingRequestedQuantity(description);
  }

  function multiplyTradePrice(price, quantity) {
    return {
      keys: price.keys * quantity,
      refined: price.refined * quantity
    };
  }

  function isInsufficientMetalPaymentError(error) {
    const message = String(error?.message || error || "");
    return /^Not enough metal to pay\b/i.test(message) ||
      /^Steam could not add the extra Scrap needed to replace the missing half-scrap weapon\b/i.test(message);
  }

  function isInventorySideActive(side) {
    return Boolean(getActiveTF2InventoryContainer(side));
  }

  async function selectInventorySide(side) {
    const expectedContainerId = side === "their" ? theirInventoryContainerId : yourInventoryContainerId;
    if (expectedContainerId && isInventorySideActive(side)) {
      return { ok: true, side, alreadyActive: true };
    }

    // Steam can occasionally swallow the first native inventory-selection
    // request while it is still rebuilding the trade UI. In that state the
    // bridge waits forever from our point of view, even though a real click
    // on the inventory tab immediately fixes it. Keep the proven native path
    // first, but make the tab click a local recovery instead of failing the
    // whole weapon search.
    try {
      await ensurePageBridge();
      const result = await new Promise((resolve, reject) => {
        const requestId = `inventory-${side}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const timeout = setTimeout(() => {
          window.removeEventListener("tmt-select-inventory-result", onResult);
          reject(new Error(`Steam did not respond while selecting ${side} inventory.`));
        }, INVENTORY_SELECTION_RESPONSE_TIMEOUT_MS);

        function onResult(event) {
          let detail;
          try { detail = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail; }
          catch { return; }
          if (!detail || detail.requestId !== requestId) return;
          if (side === "you" && detail.expectedInventoryId) {
            yourInventoryContainerId = detail.expectedInventoryId;
          }
          if (side === "their" && detail.expectedInventoryId) {
            theirInventoryContainerId = detail.expectedInventoryId;
          }
          clearTimeout(timeout);
          window.removeEventListener("tmt-select-inventory-result", onResult);
          if (detail.ok) resolve(detail);
          else {
            const expected = detail.expectedInventoryId ? ` Expected: ${detail.expectedInventoryId}.` : "";
            const actual = detail.activeInventoryId ? ` Actual: ${detail.activeInventoryId}.` : "";
            reject(new Error((detail.error || `Steam did not activate the ${side} inventory.`) + expected + actual));
          }
        }

        window.addEventListener("tmt-select-inventory-result", onResult);
        window.dispatchEvent(new CustomEvent("tmt-select-inventory", {
          detail: JSON.stringify({ requestId, side })
        }));
      });

      // The bridge result is authoritative, but verify the content-world DOM
      // once more before returning. This prevents the next advanced filter
      // from racing the final inventory swap.
      if (isInventorySideActive(side)) return result;
      await waitForInventoryReady(side, INVENTORY_SELECTION_VERIFICATION_TIMEOUT_MS);
      return result;
    } catch (bridgeError) {
      console.warn(`TF2 Metal Trader: native inventory switch to ${side} needs click recovery.`, bridgeError);
    }

    const tabId = side === "you"
      ? "inventory_select_your_inventory"
      : "inventory_select_their_inventory";
    const tab = document.getElementById(tabId);

    if (tab) {
      // Reproduce the manual recovery that fixes Steam when the native call
      // gets stuck: click the desired tab, let Steam process it, then click it
      // once more if the real inventory container still has not appeared.
      tab.click();
      await sleep(300);
      if (!isInventorySideActive(side)) {
        tab.click();
        await sleep(600);
      }
    }

    try {
      await waitForInventoryReady(side, INVENTORY_TAB_RECOVERY_TIMEOUT_MS);
      return { ok: true, side, recoveredByTabClick: true };
    } catch (recoveryError) {
      throw new Error(
        `Steam could not switch to the ${side} inventory. ` +
        `Native selection and manual tab recovery both failed. ` +
        `${recoveryError?.message || recoveryError}`
      );
    }
  }

  async function waitForInventorySide(side, timeoutMs = INVENTORY_SIDE_READY_TIMEOUT_MS) {
    return waitForInventoryReady(side, timeoutMs);
  }

  function isInventorySideFailure(error) {
    const message = String(error?.message || error || "");
    return /could not switch to the (?:you|their) inventory/i.test(message) ||
      /inventory.*(?:not detected|not active)/i.test(message) ||
      /changed away from the (?:your|their) inventory/i.test(message) ||
      /changed inventory sides/i.test(message);
  }

  async function waitForTradeAsset(side, assetId, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const assets = countTradeAssets(side);
      if (assets.has(assetId)) return assets;
      await sleep(FAST_POLL_MS);
    }
    return countTradeAssets(side);
  }





  async function addExactNamedItem(side, itemName, onProgress, restoreState = true, preferredAssetId = "", exactDefaultWeapon = false, excludedAssetIds = null, itemFilters = null) {
    if (!itemName) throw new Error("The Backpack.tf listing did not provide an item name.");
    await ensureInventorySideReady(side);
    const originalFilter = getFilterInput()?.value ?? "";
    const excluded = excludedAssetIds instanceof Set
      ? excludedAssetIds
      : new Set(Array.isArray(excludedAssetIds) ? excludedAssetIds.map(String) : []);

    try {
      const normalizeInventoryImage = (src) => {
        if (!src) return "";
        let value = String(src).trim().toLowerCase();
        try {
          const url = new URL(value, window.location.href);
          value = `${url.origin}${url.pathname}`;
        } catch {
          value = value.split("?")[0].split("#")[0];
        }
        return value.replace(/\/(?:\d+f?x\d+f?)$/, "");
      };

      const isExactKeyImage = (item) => {
        if (itemName !== KEY_NAME) return true;
        const expected = normalizeInventoryImage(KEY_IMAGE_URL);
        return [...item.querySelectorAll("img")].some(image => {
          const sources = [
            image.currentSrc,
            image.getAttribute("src"),
            image.getAttribute("data-src"),
            image.getAttribute("data-original")
          ].filter(Boolean);
          return sources.some(src => normalizeInventoryImage(src) === expected);
        });
      };

      const preferredAsset = String(preferredAssetId || "").match(/(\d+)$/)?.[1] || "";
      const readMatchingCandidates = (page) => [...page.querySelectorAll('.itemHolder .item.app440, .itemHolder .item[id^="item440_"]')]
        .filter(item => isVisible(item) && item.querySelector("img") && getAssetId(item))
        .filter(isExactKeyImage);
      let target = null;
      let reservedVisible = 0;
      for (let searchAttempt = 0; searchAttempt < 2; searchAttempt++) {
        await ensureInventorySideReady(side);
        await clearSteamInventoryAdvancedFilters(side);
        // First pass narrows the inventory to the item's quality (and Cosmetic
        // for hats). If that finds nothing, the second pass searches without
        // the advanced filters in case the item is not in that category.
        if (itemFilters && searchAttempt === 0) {
          try {
            const applied = await setSteamItemFilters(side, itemFilters.quality, itemFilters.cosmetic);
            if (applied?.missing?.length) console.warn("TF2 Metal Trader: Steam did not offer these inventory filters:", applied.missing);
          } catch (error) {
            console.warn("TF2 Metal Trader: could not apply the Quality/Type filters; searching without them.", error);
          }
        }
        await setSteamInventorySearch(itemName);
        await waitForSearchToSettle(itemName, side);

        let page = await waitForInventoryReady(side);
        let candidates = readMatchingCandidates(page);
        reservedVisible = candidates.filter(item => excluded.has(getAssetId(item))).length;
        let usable = candidates.filter(item => !excluded.has(getAssetId(item)));

        // Steam's search shows one page (about 16 copies) at a time. When every
        // visible copy is already reserved for another offer, look at the
        // following result pages for an unused one.
        for (let pageStep = 0; !usable.length && candidates.length && pageStep < 8; pageStep++) {
          const nextButton = document.querySelector("#pagebtn_next");
          if (!nextButton || nextButton.classList.contains("disabled") || !isSteamInventoryDisplayed(nextButton)) break;
          onProgress?.(`All visible ${itemName} copies are reserved by earlier offers; checking the next page…`);
          nextButton.click();
          await sleep(450);
          page = await waitForInventoryReady(side);
          candidates = readMatchingCandidates(page);
          reservedVisible += candidates.filter(item => excluded.has(getAssetId(item))).length;
          usable = candidates.filter(item => !excluded.has(getAssetId(item)));
        }

        target = usable.find(item => getAssetId(item) === preferredAsset) || usable[0] || null;
        if (target) break;
        // Copies exist but all are reserved: searching again cannot help.
        if (candidates.length && !usable.length) break;

        if (searchAttempt === 0) {
          onProgress?.(`Refreshing Steam's search for ${itemName}…`);
          await setSteamInventorySearch("");
          await waitForSearchToSettle("", side);
        }
      }

      if (!target) {
        if (reservedVisible > 0) {
          throw new Error(
            `No unused ${itemName} is left in the ${side} TF2 inventory: all ${reservedVisible} copies Steam shows are already reserved for other offers in this run.`
          );
        }
        if (itemName === KEY_NAME) {
          throw new Error(`Steam's key search did not find the exact ${KEY_NAME} image in the ${side} TF2 inventory.`);
        }
        throw new Error(`Steam's native inventory search found no result for ${itemName} in the ${side} TF2 inventory.`);
      }

      const assetId = getAssetId(target);
      let activePage = await ensureInventorySideReady(side);
      let currentTarget = activePage.querySelector(`#item440_2_${CSS.escape(assetId)}`);
      if (!currentTarget) {
        await setSteamInventorySearch(itemName);
        await waitForSearchToSettle(itemName, side);
        activePage = await ensureInventorySideReady(side);
        currentTarget = activePage.querySelector(`#item440_2_${CSS.escape(assetId)}`);
      }
      if (!currentTarget) {
        throw new Error(`Steam's filtered ${side} inventory changed before ${itemName} could be moved (asset ${assetId}).`);
      }
      const before = countTradeAssets(side);
      await moveItemToTrade(currentTarget, side);
      const after = await waitForTradeAsset(side, assetId);
      if (!assetId || !after.has(assetId) || before.has(assetId)) {
        throw new Error(`Steam did not add ${itemName} (asset ${assetId || "unknown"}) to the ${side} side.`);
      }
      onProgress?.(`Added ${itemName}`);
      return assetId;
    } finally {
      if (restoreState) {
        try {
          await ensureInventorySideReady(side);
          await setSteamInventorySearch(originalFilter);
          await waitForSearchToSettle(originalFilter, side);
        } catch (error) {
          console.warn("TF2 Metal Trader: could not restore Steam inventory search.", error);
        }
      }
    }
  }

  async function setSteamInventorySearch(query) {
    await ensurePageBridge();
    return new Promise((resolve, reject) => {
      const requestId = `filter-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timeout = setTimeout(() => {
        window.removeEventListener("tmt-filter-result", onResult);
        reject(new Error("Steam did not respond while changing the inventory search."));
      }, 5000);

      function onResult(event) {
        let detail;
        try {
          detail = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail;
        } catch { return; }
        if (!detail || detail.requestId !== requestId) return;
        clearTimeout(timeout);
        window.removeEventListener("tmt-filter-result", onResult);
        if (detail.ok) resolve(detail);
        else reject(new Error(detail.error || "Steam refused the inventory search."));
      }

      window.addEventListener("tmt-filter-result", onResult);
      window.dispatchEvent(new CustomEvent("tmt-set-filter", {
        detail: JSON.stringify({ requestId, query })
      }));
    });
  }

  async function waitForSearchToSettle(query, side = null, expectedImageUrl = "", timeoutMs = 15000, minimumSettleMs = 750) {
    let deadline = Date.now() + timeoutMs;
    let searchStartedAt = Date.now();
    let previousPage = null;
    let previousSignature = null;
    let stableSince = searchStartedAt;
    let sideMismatchSince = 0;
    let emptyStateStableSince = null;
    let sideRecoveryAttempts = 0;

    while (Date.now() < deadline) {
      const input = getFilterInput();
      if (side && !isInventorySideActive(side)) {
        if (!sideMismatchSince) sideMismatchSince = Date.now();
        if (Date.now() - sideMismatchSince >= 1000) {
          if (sideRecoveryAttempts >= 2) {
            throw new Error(`Steam repeatedly changed away from the ${side === "their" ? "Their" : "Your"} inventory while waiting for the "${query || "cleared"}" search.`);
          }
          sideRecoveryAttempts++;
          await ensureInventorySideReady(side);
          await setSteamInventorySearch(query);
          searchStartedAt = Date.now();
          deadline = searchStartedAt + timeoutMs;
          previousPage = null;
          previousSignature = null;
          stableSince = searchStartedAt;
          emptyStateStableSince = null;
          sideMismatchSince = 0;
          continue;
        }
        await sleep(FAST_POLL_MS);
        continue;
      }
      sideMismatchSince = 0;
      const page = side ? findInventoryPageForSide(side) : findActiveTF2InventoryPage(false);
      if (input && input.value === query && page) {
        const visibleItems = [...page.querySelectorAll('.itemHolder .item.app440, .itemHolder .item[id^="item440_"]')]
          .filter(isVisible);
        const signature = visibleItems.map(item => item.id).join("|");
        const now = Date.now();
        if (page !== previousPage || signature !== previousSignature) {
          previousPage = page;
          previousSignature = signature;
          stableSince = now;
          emptyStateStableSince = null;
        }

        const emptyMessage = document.querySelector('#empty_filtered_inventory_page');
        const isEmpty = Boolean(emptyMessage && isVisible(emptyMessage));
        if (isEmpty) {
          if (emptyStateStableSince === null) emptyStateStableSince = now;
        } else {
          emptyStateStableSince = null;
        }

        const searchAge = now - searchStartedAt;
        const stableFor = now - stableSince;
        if (query === "" && searchAge >= minimumSettleMs && stableFor >= 300) return;
        if (
          expectedImageUrl &&
          searchAge >= 500 &&
          visibleItems.some(item => inventoryItemMatchesImage(item, expectedImageUrl))
        ) {
          return;
        }
        if (query && visibleItems.length && searchAge >= 750 && stableFor >= 400) return;
        if (
          query &&
          isEmpty &&
          searchAge >= 1500 &&
          emptyStateStableSince !== null &&
          now - emptyStateStableSince >= 750
        ) {
          return;
        }
      }
      await sleep(FAST_POLL_MS);
    }
    throw new Error("Steam's inventory search did not finish updating.");
  }

  function inventoryItemMatchesImage(item, expectedImageUrl) {
    const normalize = value => {
      if (!value) return "";
      try {
        const url = new URL(String(value), window.location.href);
        return url.pathname.toLowerCase().replace(/\/(?:\d+f?x\d+f?)$/, "");
      } catch {
        return String(value).split(/[?#]/, 1)[0].replace(/^https?:\/\/[^/]+/i, "").toLowerCase().replace(/\/(?:\d+f?x\d+f?)$/, "");
      }
    };
    const expected = normalize(expectedImageUrl);
    return [...item.querySelectorAll("img")].some(image =>
      [image.currentSrc, image.getAttribute("src"), image.getAttribute("data-src"), image.getAttribute("data-original")]
        .filter(Boolean)
        .some(source => normalize(source) === expected)
    );
  }

  async function inspectTraderMetalInventory(requiredRef, statusCallback) {
    if (!Number.isFinite(requiredRef) || requiredRef < 0) {
      throw new Error("The arbitrage check did not provide a valid required metal amount.");
    }
    statusCallback?.("Waiting for Steam's trade inventory to load…");
    const inventoryBox = await waitForInventoryBox();
    const originalInventoryPage = findActiveTF2InventoryPage(false);
    const originalContainerId = originalInventoryPage?.closest('.inventory_ctn[id*="_440_2"]')?.id || "";
    let originalSide = inventoryBox.classList.contains("their_inventory_active") ? "their" : "you";
    const originalFilter = getFilterInput()?.value ?? "";
    const tradeRoot = document.querySelector("#their_slots");
    if (!tradeRoot) throw new Error("Steam's trader trade slots were not found.");
    if (tradeRoot.querySelector('.item[id^="item"]')) {
      throw new Error("Cannot run a metal availability test because the trader side already contains items.");
    }

    const targetScrap = Math.ceil(requiredRef * 9 - 0.0001);
    const counts = { refined: 0, reclaimed: 0, scrap: 0 };
    const denominations = [
      ["refined", METAL_IMAGES.refined, 9],
      ["reclaimed", METAL_IMAGES.reclaimed, 3],
      ["scrap", METAL_IMAGES.scrap, 1]
    ];
    let remaining = targetScrap;
    let addError = null;
    let badTrader = null;
    let ownedCheck = null;

    // The arbitrage controller passes the item and the number the trader wants
    // in the link fragment. Without them, only the metal is checked.
    const fragmentParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const checkItemName = String(fragmentParams.get("tmt_item") || "").trim();
    const checkWanted = Number.parseInt(fragmentParams.get("tmt_wanted") || "", 10);
    const ownedItemCheck = checkItemName && Number.isSafeInteger(checkWanted) && checkWanted >= 1
      ? {
          itemName: checkItemName,
          wanted: checkWanted,
          quality: String(fragmentParams.get("tmt_quality") || "Unique").trim() || "Unique",
          cosmetic: fragmentParams.get("tmt_cosmetic") === "1"
        }
      : null;

    const readStagedMetal = () => {
      const stagedCounts = { refined: 0, reclaimed: 0, scrap: 0 };
      for (const item of tradeRoot.querySelectorAll('.item[id^="item"]')) {
        if (inventoryItemMatchesImage(item, METAL_IMAGES.refined)) stagedCounts.refined++;
        else if (inventoryItemMatchesImage(item, METAL_IMAGES.reclaimed)) stagedCounts.reclaimed++;
        else if (inventoryItemMatchesImage(item, METAL_IMAGES.scrap)) stagedCounts.scrap++;
      }
      return stagedCounts;
    };

    try {
      statusCallback?.("Switching to the trader's TF2 inventory and waiting for it to load…");
      await ensureInventorySideReady("their");
      statusCallback?.("Trader inventory selected. Waiting for Steam's metal search…");
      if (originalContainerId && theirInventoryContainerId) {
        originalSide = originalContainerId === theirInventoryContainerId ? "their" : "you";
      }

      // Before looking at metal: a trader who already holds as many copies of
      // the item as they want is a bad trader and is skipped. A failed count
      // never blocks the metal check.
      if (ownedItemCheck) {
        try {
          const owned = await countTraderCopies(ownedItemCheck, statusCallback);
          ownedCheck = { ownedCopies: owned.count, wantedCopies: ownedItemCheck.wanted, scanned: owned.scanned };
          if (owned.count >= ownedItemCheck.wanted) badTrader = ownedCheck;
        } catch (error) {
          ownedCheck = { error: error?.message || String(error), wantedCopies: ownedItemCheck.wanted };
          console.warn("TF2 Metal Trader: could not count the trader's copies; checking metal anyway.", error);
        }
        try {
          await clearSteamInventoryAdvancedFilters("their");
        } catch (clearError) {
          console.warn("TF2 Metal Trader: could not clear the item filters.", clearError);
        }
      }

      // The price is met by refined, reclaimed and scrap TOGETHER (1.77 ref =
      // 16 scrap can be 1 refined + 2 reclaimed + 1 scrap). Whatever the trader
      // has of one denomination is kept and the rest of the price is asked of
      // the next one, so one missing or short denomination never ends the check.
      const stagedScrap = () => metalCountsToScrap(readStagedMetal());
      const tryDenomination = async (kind, imageUrl, requested) => {
        if (requested <= 0) return;
        statusCallback?.(`Testing whether trader can add ${requested} ${kind} metal…`);
        try {
          await addMetalTypeToSide("their", imageUrl, requested, kind);
        } catch (error) {
          // Keep what was staged and try the other denominations; the error
          // only matters if the combined total still falls short.
          addError = addError || error;
          console.warn(`TF2 Metal Trader: could not finish adding ${kind} metal; continuing with the others.`, error);
        }
        remaining = targetScrap - stagedScrap();
      };

      if (!badTrader) {
        // Pass 1 - exact fit, largest first: only whole denominations that fit
        // inside what is still needed, so nothing is over-staged.
        for (const [kind, imageUrl, valueScrap] of denominations) {
          if (remaining <= 0) break;
          await tryDenomination(kind, imageUrl, Math.floor(remaining / valueScrap));
        }
        // Pass 2 - top up: if the exact fit left a gap (for example the trader
        // has no scrap), cover it with the smallest whole item that closes it,
        // taking whatever the trader still has.
        // (Scrap was already asked for in full in pass 1, so it is not retried.)
        for (const [kind, imageUrl, valueScrap] of denominations.slice(0, 2).reverse()) {
          if (remaining <= 0) break;
          await tryDenomination(kind, imageUrl, Math.ceil(remaining / valueScrap));
        }
      }
      Object.assign(counts, readStagedMetal());
    } catch (error) {
      addError = error;
      Object.assign(counts, readStagedMetal());
    } finally {
      const temporaryItemIds = [...tradeRoot.querySelectorAll('.item[id^="item"]')]
        .map(item => item.id)
        .filter(Boolean);
      if (temporaryItemIds.length) {
        await removeTradeItemsFromSide("their", temporaryItemIds, statusCallback);
      }
      try {
        await setSteamInventorySearch(originalFilter);
        await waitForSearchToSettle(originalFilter);
      } catch (cleanupError) {
        console.warn("TF2 Metal Trader: could not restore the inventory search after metal verification.", cleanupError);
      }
      if (originalSide !== "their") {
        try {
          await selectInventorySide(originalSide);
        } catch (restoreError) {
          console.warn("TF2 Metal Trader: could not restore the original inventory side after metal verification.", restoreError);
        }
      }
    }

    const availableScrap =
      counts.refined * METAL_VALUES.refined +
      counts.reclaimed * METAL_VALUES.reclaimed +
      counts.scrap;
    const availableRef = availableScrap / 9;
    if (badTrader) {
      return {
        status: "checked",
        badTrader: true,
        ownedCopies: badTrader.ownedCopies,
        wantedCopies: badTrader.wantedCopies,
        itemName: ownedItemCheck.itemName,
        counts,
        availableRef: 0,
        requiredRef,
        sufficient: false,
        items: 0
      };
    }
    if (addError && availableScrap < targetScrap) {
      throw new Error(`Metal availability test could not finish: ${addError.message || addError}`);
    }
    return {
      status: "checked",
      counts,
      availableRef,
      requiredRef,
      ownedCheck,
      sufficient: availableScrap >= targetScrap,
      items: counts.refined + counts.reclaimed + counts.scrap
    };
  }

  async function addMetalType(imageUrl, amount, label, onProgress, searchStatus) {
    let added = 0;
    const searchQuery = `${label[0].toUpperCase()}${label.slice(1)} Metal`;
    await setSteamInventorySearch(searchQuery);
    await waitForSearchToSettle(searchQuery);
    await waitForInventoryDom();

    const page = findActiveTF2InventoryPage(false);
    if (!page) return 0;
    const items = [...page.querySelectorAll('.itemHolder .item.app440, .itemHolder .item[id^="item440_"]')]
      .filter(item => isVisible(item) && item.querySelector('img') && getAssetId(item));

    for (const target of items) {
      if (added >= amount) break;
      const assetId = getAssetId(target);
      const before = countTradeAssets('their');
      await moveItemToTrade(target, "their");
      const after = await waitForTradeAsset('their', assetId);
      if (!assetId || !after.has(assetId) || before.has(assetId)) {
        throw new Error(`Steam did not add ${label} (asset ${assetId || "unknown"}) to the trade.`);
      }
      added++;
      onProgress?.({ label, added, requested: amount, itemId: target.id, assetId, page: 1 });
    }
    return added;
  }

  async function setNormalWeaponFilters(side, weaponType = "primary") {
    await ensurePageBridge();
    const weaponTypeLabel = {
      primary: "Primary Weapon",
      secondary: "Secondary Weapon"
    }[weaponType] || "Primary Weapon";
    return new Promise((resolve, reject) => {
      const requestId = `normal-weapon-filters-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timeout = setTimeout(() => {
        window.removeEventListener("tmt-normal-weapon-filters-result", onResult);
        reject(new Error(`Steam did not respond while applying the Unique + ${weaponTypeLabel} + Not Marketable filters.`));
      }, 5000);

      function onResult(event) {
        let detail;
        try {
          detail = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail;
        } catch {
          return;
        }
        if (!detail || detail.requestId !== requestId) return;
        clearTimeout(timeout);
        window.removeEventListener("tmt-normal-weapon-filters-result", onResult);
        if (detail.ok) resolve(detail);
        else reject(new Error(detail.error || "Steam refused the weapon filters."));
      }

      window.addEventListener("tmt-normal-weapon-filters-result", onResult);
      window.dispatchEvent(new CustomEvent("tmt-set-normal-weapon-filters", {
        detail: JSON.stringify({ requestId, side, weaponType })
      }));
    });
  }

  async function clearSteamInventoryAdvancedFilters(side) {
    await ensurePageBridge();
    return new Promise((resolve, reject) => {
      const requestId = `clear-inventory-filters-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timeout = setTimeout(() => {
        window.removeEventListener("tmt-clear-advanced-filters-result", onResult);
        reject(new Error(`Steam did not respond while clearing advanced filters on the ${side} inventory.`));
      }, 15000);

      function onResult(event) {
        let detail;
        try {
          detail = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail;
        } catch {
          return;
        }
        if (!detail || detail.requestId !== requestId) return;
        clearTimeout(timeout);
        window.removeEventListener("tmt-clear-advanced-filters-result", onResult);
        if (detail.ok) resolve(detail);
        else reject(new Error(detail.error || `Steam could not clear advanced filters on the ${side} inventory.`));
      }

      window.addEventListener("tmt-clear-advanced-filters-result", onResult);
      window.dispatchEvent(new CustomEvent("tmt-clear-advanced-filters", {
        detail: JSON.stringify({ requestId, side })
      }));
    });
  }

  // Generic request/response over the page bridge.
  async function bridgeRequest(requestEvent, resultEvent, payload, timeoutMs, timeoutMessage) {
    await ensurePageBridge();
    return new Promise((resolve, reject) => {
      const requestId = `${requestEvent}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timeout = setTimeout(() => {
        window.removeEventListener(resultEvent, onResult);
        reject(new Error(timeoutMessage));
      }, timeoutMs);

      function onResult(event) {
        let detail;
        try {
          detail = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail;
        } catch {
          return;
        }
        if (!detail || detail.requestId !== requestId) return;
        clearTimeout(timeout);
        window.removeEventListener(resultEvent, onResult);
        if (detail.ok) resolve(detail);
        else reject(new Error(detail.error || `Steam could not complete ${requestEvent}.`));
      }

      window.addEventListener(resultEvent, onResult);
      window.dispatchEvent(new CustomEvent(requestEvent, {
        detail: JSON.stringify({ requestId, ...payload })
      }));
    });
  }

  function setSteamItemFilters(side, quality, cosmetic) {
    return bridgeRequest(
      "tmt-set-item-filters",
      "tmt-set-item-filters-result",
      { side, quality, cosmetic },
      30000,
      "Steam did not respond while applying the Quality/Type filters."
    );
  }

  function countSteamInventoryItems(side, itemName, quality) {
    return bridgeRequest(
      "tmt-count-inventory-items",
      "tmt-count-inventory-items-result",
      { side, itemName, quality },
      8000,
      "Steam did not respond while counting the trader's items."
    );
  }

  // Counts how many copies of an item the trader already holds, following
  // the arbitrage "bad trader" rule: apply Steam's advanced filters (Quality,
  // and Type: Cosmetic for hats), search the item name, then count every
  // found item whose name matches exactly. Counting stops as soon as the count
  // reaches the number of items the trader wants.
  async function countTraderCopies(check, statusCallback) {
    await ensureInventorySideReady("their");
    statusCallback?.(`Checking how many ${check.itemName} the trader already holds…`);

    let filters = null;
    try {
      filters = await setSteamItemFilters("their", check.quality, check.cosmetic);
      if (filters.missing?.length) {
        console.warn("TF2 Metal Trader: some item filters were not available:", filters.missing);
      }
    } catch (error) {
      console.warn("TF2 Metal Trader: could not apply the item filters; counting by name only.", error);
    }

    await ensureInventorySideReady("their");
    await setSteamInventorySearch(check.itemName);
    await waitForSearchToSettle(check.itemName, "their");

    const owned = new Set();
    let scanned = 0;
    let pagesRead = 0;
    for (; pagesRead < 8; pagesRead++) {
      await waitForInventoryReady("their");
      let page = await countSteamInventoryItems("their", check.itemName, check.quality);
      if (page.scanned === 0 && pagesRead === 0) {
        // Steam may still be laying out the search results.
        await sleep(600);
        page = await countSteamInventoryItems("their", check.itemName, check.quality);
      }
      scanned += page.scanned;
      for (const assetId of page.matches) owned.add(assetId);
      statusCallback?.(`Trader holds ${owned.size} ${check.itemName} (bad trader at ${check.wanted}; ${scanned} item${scanned === 1 ? "" : "s"} checked)…`);
      if (owned.size >= check.wanted) break;

      const nextButton = document.querySelector("#pagebtn_next");
      if (!nextButton || nextButton.classList.contains("disabled") || !isSteamInventoryDisplayed(nextButton)) break;
      nextButton.click();
      await sleep(450);
    }
    return { count: owned.size, scanned, pagesRead: pagesRead + 1, filters };
  }

  const KEY_RATE_STORAGE_KEY = "tf2MetalTraderKeyRate";
  const MIN_KEY_RATE_REF = 10;
  const MAX_KEY_RATE_REF = 500;

  // The metal value of one key: from the offer link when the scanner sent it
  // (and remembered for later manual trades), otherwise the last remembered
  // value. Returns null when no usable rate is known.
  function resolveKeyRate(listing) {
    const usable = value => Number.isFinite(value) && value >= MIN_KEY_RATE_REF && value <= MAX_KEY_RATE_REF;
    const fromLink = Number(listing?.keyRate);
    if (usable(fromLink)) {
      try { window.localStorage.setItem(KEY_RATE_STORAGE_KEY, String(fromLink)); } catch { /* storage unavailable */ }
      return fromLink;
    }
    try {
      const stored = Number(window.localStorage.getItem(KEY_RATE_STORAGE_KEY));
      if (usable(stored)) return stored;
    } catch { /* storage unavailable */ }
    return null;
  }

  // Counts the distinct copies of an item that one side's inventory can still
  // offer, by searching its exact name and reading the result pages. Stops as
  // soon as `needed` copies are found.
  async function countAvailableCopies(side, itemName, needed) {
    await ensureInventorySideReady(side);
    await clearSteamInventoryAdvancedFilters(side);
    await setSteamInventorySearch(itemName);
    await waitForSearchToSettle(itemName, side);

    const found = new Set();
    for (let pagesRead = 0; pagesRead < 8; pagesRead++) {
      await waitForInventoryReady(side);
      let page = await countSteamInventoryItems(side, itemName, "Unique");
      if (page.scanned === 0 && pagesRead === 0) {
        // Steam may still be laying out the search results.
        await sleep(600);
        page = await countSteamInventoryItems(side, itemName, "Unique");
      }
      for (const assetId of page.matches) found.add(String(assetId));
      if (found.size >= needed) break;

      const nextButton = document.querySelector("#pagebtn_next");
      if (!nextButton || nextButton.classList.contains("disabled") || !isSteamInventoryDisplayed(nextButton)) break;
      nextButton.click();
      await sleep(450);
    }
    return found;
  }

  // Decides whether a key price is paid with physical keys. The paying side
  // must hold every key the price needs; otherwise the whole price is paid in
  // metal (keys x key rate + the metal part). `stagedKeyIds` are keys already
  // placed in the trade, which count as held.
  async function planKeyPayment(side, keysNeeded, stagedKeyIds, keyRate, statusCallback) {
    const owner = side === "you" ? "Your" : "Their";
    const staged = new Set((stagedKeyIds || []).map(id => String(id).match(/(\d+)$/)?.[1]).filter(Boolean));
    statusCallback?.(`Checking ${owner.toLowerCase()} inventory for ${keysNeeded}× ${KEY_NAME}…`);

    let have = null;
    try {
      const found = await countAvailableCopies(side, KEY_NAME, keysNeeded + staged.size);
      const inTrade = countTradeAssets(side);
      have = staged.size + [...found].filter(assetId => !inTrade.has(assetId)).length;
    } catch (error) {
      console.warn("TF2 Metal Trader: could not count the available keys.", error);
    }

    if (have === null) {
      // Could not count: try the keys, and fall back to metal if adding fails.
      return { useKeys: true, have: null };
    }
    if (have >= keysNeeded) {
      statusCallback?.(`${owner} inventory has ${have} ${KEY_NAME}${have === 1 ? "" : "s"}; paying ${keysNeeded} key${keysNeeded === 1 ? "" : "s"}.`);
      return { useKeys: true, have };
    }
    if (!keyRate) {
      throw new Error(
        `${owner} inventory has only ${have} ${KEY_NAME}${have === 1 ? "" : "s"} but ${keysNeeded} ${keysNeeded === 1 ? "is" : "are"} needed, ` +
        "and no key rate is known to pay the price in metal instead. Start this trade from the arbitrage scanner once so the key rate is remembered."
      );
    }
    statusCallback?.(`${owner} inventory has only ${have} of the ${keysNeeded} ${KEY_NAME}s needed. Paying the whole price in metal instead (${keyRate} ref per key)…`);
    return { useKeys: false, have };
  }

  function isKeyShortageError(error) {
    return /found no result for|did not find the exact|No unused .* is left/i.test(String(error?.message || error || ""));
  }

  // The price of one item entirely in metal (ref), and for `count` items.
  function metalOnlyUnitPrice(tradePrice, keyRate) {
    return Math.round((tradePrice.keys * keyRate + tradePrice.refined) * 100) / 100;
  }

  async function findNormalWeaponOnCurrentPage(side) {
    await ensurePageBridge();

    return new Promise((resolve, reject) => {
      const requestId = `normal-weapon-${side}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timeout = setTimeout(() => {
        window.removeEventListener("tmt-find-normal-weapon-result", onResult);
        reject(new Error("Steam did not respond while looking for the first filtered normal weapon."));
      }, 5000);

      function onResult(event) {
        let detail;
        try {
          detail = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail;
        } catch {
          return;
        }

        if (!detail || detail.requestId !== requestId) return;

        clearTimeout(timeout);
        window.removeEventListener("tmt-find-normal-weapon-result", onResult);

        if (detail.ok) {
          resolve(detail);
        } else {
          reject(new Error(detail.error || "Steam could not inspect the filtered weapon inventory."));
        }
      }

      window.addEventListener("tmt-find-normal-weapon-result", onResult);
      window.dispatchEvent(new CustomEvent("tmt-find-normal-weapon", {
        detail: JSON.stringify({ requestId, side })
      }));
    });
  }

  async function addHalfScrapWeapon(side, statusCallback) {
    statusCallback?.(`Finding a normal weapon in ${side === "you" ? "your" : "their"} inventory…`);

    await ensureInventorySideReady(side);
    await sleep(750);
    await waitForInventoryReady(side);

    // No text search. Steam's advanced filters define the candidate pool.
    // Keep each category search on this selected side; a missing weapon
    // proceeds to the caller's metal-change fallback instead of a third filter.
    await setSteamInventorySearch("");
    await waitForSearchToSettle("", side, "", 30000, 1200);
    await waitForInventoryReady(side);

    const tryWeaponType = async (weaponType) => {
      let sideRecoveryAttempts = 0;
      while (true) {
        try {
          await ensureInventorySideReady(side);
          await setNormalWeaponFilters(side, weaponType);
          await waitForSearchToSettle("", side, "", 30000, 1200);
          await waitForInventoryReady(side, 5000);
          return await findNormalWeaponOnCurrentPage(side);
        } catch (error) {
        const message = String(error?.message || error || "");

        // CRITICAL: once Steam has selected a blocked/invalid candidate and
        // MoveItemToTrade fails, this is NOT a failed weapon category. It is
        // the exact condition that must escape to calculateAndAddMetalToSide
        // so the full Scrap -> YOUR inventory fallback can run. Previously
        // this catch swallowed the placement error and returned found:false,
        // which made the recovery sequence unreliable and left the UI looking
        // like the operation had simply failed.
        if (/Steam did not place the selected normal weapon into the trade/i.test(message)) {
          statusCallback?.(`Steam rejected the selected ${weaponType} weapon — starting the Scrap + your-weapon fallback…`);
          throw error;
        }

        if (isInventorySideFailure(error)) {
          if (sideRecoveryAttempts >= 1) throw error;
          sideRecoveryAttempts++;
          statusCallback?.(`Steam changed inventory sides while checking ${weaponType}; reselecting the correct inventory and retrying…`);
          await ensureInventorySideReady(side);
          continue;
        }

        // Steam's advanced-filter bridge can occasionally time out while the
        // inventory is rebuilding. That is a failed category, not a failed
        // trade: try the next allowed weapon category on the same side.
        statusCallback?.(`Steam could not finish the ${weaponType} weapon filter. Trying the next weapon type…`);
        console.warn(`TF2 Metal Trader: ${weaponType} weapon filter failed; continuing to the next category.`, error);
        return { found: false, filterError: error };
        }
      }
    };

    const weaponTypes = [
      ["primary", "Primary Weapon"],
      ["secondary", "Secondary Weapon"]
    ];
    let result = { found: false };
    let selectedType = "";
    for (const [weaponType, label] of weaponTypes) {
      result = await tryWeaponType(weaponType);
      if (result.found) {
        selectedType = label;
        break;
      }
      if (weaponType === "primary") {
        const nextLabel = weaponTypes[1][1];
        statusCallback?.(`No eligible ${label} found — trying ${nextLabel}…`);
      }
    }

    if (!result.found) {
      statusCallback?.("No eligible Primary or Secondary Weapon found — using the metal-change fallback.");
      throw new Error("NO_ELIGIBLE_WEAPON_FOUND");
    }

    await ensureInventorySideReady(side);
    const activePage = await waitForInventoryReady(side);
    let item = activePage.querySelector(`#${CSS.escape(result.itemId)}`);
    if (!item) {
      throw new Error("Steam's filtered weapon item disappeared before it could be added to the trade.");
    }

    statusCallback?.(`Adding the first eligible ${selectedType.toLowerCase()} to the trade…`);
    await ensureInventorySideReady(side);
    const currentPage = await waitForInventoryReady(side);
    item = currentPage.querySelector(`#${CSS.escape(result.itemId)}`);
    if (!item) throw new Error(`Steam's ${side === "you" ? "Your" : "Their"} inventory changed before the weapon could be added.`);
    await moveItemToTrade(item, side);

    const movedAssets = await waitForTradeAsset(side, result.assetId, 1500);
    if (!movedAssets.has(result.assetId)) {
      throw new Error("Steam did not place the selected normal weapon into the trade.");
    }

    return result.name || "normal weapon";
  }

  async function toggleReady() {
    await ensurePageBridge();
    // Steam can take a moment after the last item is placed before its Ready
    // control is usable; wait briefly for it instead of failing the trade.
    const deadline = Date.now() + 6000;
    while (true) {
      try {
        return await callBridge("tmt-toggle-ready", {});
      } catch (error) {
        const retryable = /not allowing the trade to be accepted yet|ready controls are not currently available/i
          .test(String(error?.message || error || ""));
        if (!retryable || Date.now() >= deadline) throw error;
        await sleep(150);
      }
    }
  }

  async function confirmTradeOffer() {
    await ensurePageBridge();
    return callBridge("tmt-confirm-trade", {});
  }

  function isTradeReady() {
    const ready = document.querySelector("#you_ready");
    return isVisible(ready);
  }

  function isConfirmButtonAvailable() {
    const button = document.querySelector("#trade_confirmbtn");
    return isVisible(button) && !button.disabled;
  }

  function findSentTradeOfferLink() {
    const header = document.querySelector("#alert-header");
    if (!header) return null;

    // This exact header identifies the final "trade sent" alert. Steam also
    // shows other alert/loading states, so do not act on those.
    const headerText = (header.textContent || "").trim().replace(/\s+/g, " ").toLowerCase();
    if (headerText !== "your trade has been sent") return null;

    const content = document.querySelector("#alert-content");
    if (!content || !isVisible(content)) return null;

    // Require the actual Open Trade Offer button/link from this exact alert.
    // The numeric trade-offer URL is the strongest signal that this is the
    // completed outgoing trade rather than a loading/confirmation alert.
    const link = [...content.querySelectorAll("a.btn.btn-info.btn-lg[href]")].find(anchor => {
      if (!isVisible(anchor)) return false;
      const href = anchor.getAttribute("href") || "";
      const text = (anchor.textContent || "").trim().replace(/\s+/g, " ").toLowerCase();
      return text === "open trade offer" && /^https?:\/\/steamcommunity\.com\/tradeoffer\/\d+\/?$/i.test(href);
    });

    return link || null;
  }

  async function waitForSentTradeOfferAlert(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const link = findSentTradeOfferLink();
      if (link) return link;
      await sleep(FAST_POLL_MS);
    }
    throw new Error("Steam's 'Your trade has been sent' alert did not appear.");
  }

  async function openSentTradeOffer(statusCallback) {
    statusCallback?.("Waiting for Steam's 'Your trade has been sent' alert…");
    const link = await waitForSentTradeOfferAlert();
    const href = link.href;
    statusCallback?.("Trade sent. Opening the Steam trade offer…");

    // A synthetic anchor.click() can be blocked because this code is no longer
    // running inside the user's original click gesture. Open the exact href
    // through the extension's background script instead, which reliably creates
    // a normal new Firefox tab.
    await browser.runtime.sendMessage({
      type: "tmt-open-trade-offer",
      url: href
    });

    return href;
  }

  async function waitForTradeReady(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (isTradeReady()) return true;
      await sleep(FAST_POLL_MS);
    }
    throw new Error("Steam did not show the accepted/ready state after 15 seconds.");
  }

  async function waitForConfirmButton(timeoutMs = 60000, statusCallback = null) {
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    let lastStatusAt = startedAt;
    while (Date.now() < deadline) {
      if (isConfirmButtonAvailable()) return true;
      const elapsed = Date.now() - startedAt;
      if (statusCallback && elapsed >= 5000 && Date.now() - lastStatusAt >= 5000) {
        statusCallback(`Still waiting for Steam to enable Make Offer (${Math.floor(elapsed / 1000)}s)…`);
        lastStatusAt = Date.now();
      }
      await sleep(FAST_POLL_MS);
    }
    throw new Error(`Steam did not enable the Make Offer button within ${Math.floor(timeoutMs / 1000)} seconds.`);
  }

  function metalCountsToScrap(counts) {
    return (counts.refined * METAL_VALUES.refined) +
      (counts.reclaimed * METAL_VALUES.reclaimed) +
      counts.scrap;
  }

  // Normalize a whole-scrap value into the largest TF2 metal denominations.
  // Example: 3 scrap is 1 reclaimed, not 3 separate scrap items.
  function metalValueToDenominations(scrapValue) {
    if (!Number.isInteger(scrapValue) || scrapValue < 0) {
      throw new Error("Metal value must be a non-negative whole number of scrap.");
    }

    return {
      refined: Math.floor(scrapValue / METAL_VALUES.refined),
      reclaimed: Math.floor((scrapValue % METAL_VALUES.refined) / METAL_VALUES.reclaimed),
      scrap: scrapValue % METAL_VALUES.reclaimed
    };
  }

  // Metal already sitting in a trade side, read directly from Steam's trade
  // slots. Using this avoids searching the inventory again for value that is
  // already staged.
  function readStagedMetalItems(side) {
    const root = document.querySelector(side === "their" ? "#their_slots" : "#your_slots");
    if (!root) return [];
    const kinds = [
      ["refined", METAL_IMAGES.refined],
      ["reclaimed", METAL_IMAGES.reclaimed],
      ["scrap", METAL_IMAGES.scrap]
    ];
    const items = [];
    for (const item of root.querySelectorAll('.item[id^="item"]')) {
      const kind = kinds.find(([, imageUrl]) => inventoryItemMatchesImage(item, imageUrl));
      if (kind) items.push({ id: item.id, kind: kind[0], value: METAL_VALUES[kind[0]] });
    }
    return items;
  }

  function countStagedMetal(items) {
    const counts = { refined: 0, reclaimed: 0, scrap: 0 };
    for (const item of items) counts[item.kind]++;
    return counts;
  }

  // If the trade already holds more metal than the target, remove the
  // largest staged items that fit inside the excess. Removing is local to the
  // trade and needs no inventory search.
  async function trimStagedMetalToValue(side, targetScrap, statusCallback) {
    const items = readStagedMetalItems(side).sort((a, b) => b.value - a.value);
    let excess = items.reduce((total, item) => total + item.value, 0) - targetScrap;
    if (excess <= 0) return items;

    const removeIds = [];
    for (const item of items) {
      if (excess <= 0) break;
      if (item.value <= excess) {
        removeIds.push(item.id);
        excess -= item.value;
      }
    }
    if (!removeIds.length) return items;

    statusCallback?.(`The trade already holds more metal than needed. Removing ${removeIds.length} staged metal item${removeIds.length === 1 ? "" : "s"} instead of searching again…`);
    await removeTradeItemsFromSide(side, removeIds, statusCallback);
    return readStagedMetalItems(side);
  }

  async function addMetalValueWithFallback(side, scrapValue, statusCallback, labelPrefix = "change") {
    if (!Number.isInteger(scrapValue) || scrapValue < 0) {
      throw new Error(`Invalid ${labelPrefix} value.`);
    }
    if (scrapValue === 0) return { refined: 0, reclaimed: 0, scrap: 0 };

    // Count metal already staged on this side toward the requested value and
    // only search the inventory for what is still missing.
    const stagedItems = await trimStagedMetalToValue(side, scrapValue, statusCallback);
    const added = countStagedMetal(stagedItems);
    let remaining = scrapValue - metalCountsToScrap(added);
    if (remaining < 0) {
      throw new Error(`The ${side} side already holds more metal than the ${scrapValue} scrap of ${labelPrefix} required.`);
    }
    if (remaining < scrapValue) {
      statusCallback?.(`${scrapValue - remaining} scrap of ${labelPrefix} is already in the trade; adding only the remaining ${remaining} scrap.`);
    }

    // Build an exact metal value using the largest denominations first. If a
    // denomination is unavailable, the remaining value falls through to the
    // smaller denominations. This lets, for example, 3 scrap replace 1 rec.

    const plan = [
      ["refined", METAL_IMAGES.refined, 9],
      ["reclaimed", METAL_IMAGES.reclaimed, 3],
      ["scrap", METAL_IMAGES.scrap, 1]
    ];

    for (const [label, imageUrl, value] of plan) {
      // Re-read the metal in the trade before each denomination so the value
      // already placed (by any earlier step) is never searched for again.
      const stagedNow = countStagedMetal(readStagedMetalItems(side));
      for (const key of Object.keys(added)) added[key] = Math.max(added[key], stagedNow[key]);
      remaining = scrapValue - metalCountsToScrap(added);

      const requested = Math.floor(remaining / value);
      if (requested <= 0) continue;

      const count = await addMetalTypeToSide(
        side,
        imageUrl,
        requested,
        label,
        progress => statusCallback?.(`Adding ${labelPrefix}: ${progress.added}/${progress.requested} ${label}`),
        status => statusCallback?.(status)
      );

      added[label] += count;
    }

    const stagedAfter = countStagedMetal(readStagedMetalItems(side));
    for (const key of Object.keys(added)) added[key] = Math.max(added[key], stagedAfter[key]);
    remaining = scrapValue - metalCountsToScrap(added);
    if (remaining > 0) {
      throw new Error(`Could not make exact ${labelPrefix} of ${scrapValue} scrap value. Still missing ${remaining} scrap.`);
    }

    return added;
  }

  async function addFallbackWeaponToOurSide(statusCallback) {
    // This is deliberately a standalone fallback weapon routine.  Do NOT call
    // addHalfScrapWeapon() here: that routine starts by selecting an inventory
    // again, which can undo the explicit THEIR -> YOU recovery sequence.
    statusCallback?.("Running the normal-weapon Advanced Filters on your inventory…");

    await ensureInventorySideReady("you");
    await sleep(750);
    await waitForInventoryReady("you");

    await setSteamInventorySearch("");
    await waitForSearchToSettle("", "you", "", 30000, 1200);
    await ensureInventorySideReady("you");
    await sleep(750);

    const tryWeaponType = async (weaponType) => {
      let sideRecoveryAttempts = 0;
      while (true) {
        try {
          await ensureInventorySideReady("you");
          await setNormalWeaponFilters("you", weaponType);
          await waitForSearchToSettle("", "you", "", 30000, 1200);
          await waitForInventoryReady("you", 5000);
          return await findNormalWeaponOnCurrentPage("you");
        } catch (error) {
          if (!isInventorySideFailure(error) || sideRecoveryAttempts >= 1) throw error;
          sideRecoveryAttempts++;
          statusCallback?.(`Steam changed away from your inventory while checking ${weaponType}; reselecting and retrying…`);
          await ensureInventorySideReady("you");
        }
      }
    };

    const weaponTypes = [
      ["primary", "Primary Weapon"],
      ["secondary", "Secondary Weapon"]
    ];
    let result = { found: false };
    let selectedType = "";
    for (const [weaponType, label] of weaponTypes) {
      result = await tryWeaponType(weaponType);
      if (result.found) {
        selectedType = label;
        break;
      }
      if (weaponType === "primary") {
        const nextLabel = weaponTypes[1][1];
        statusCallback?.(`No eligible ${label} found in your inventory — trying ${nextLabel}…`);
      }
    }

    if (!result.found) {
      statusCallback?.("No eligible Primary or Secondary Weapon found in your inventory.");
      throw new Error("NO_ELIGIBLE_WEAPON_FOUND");
    }

    await ensureInventorySideReady("you");
    const activePage = await waitForInventoryReady("you");
    let item = activePage.querySelector(`#${CSS.escape(result.itemId)}`);
    if (!item) {
      throw new Error("Steam's filtered weapon item disappeared before it could be added to the trade.");
    }

    statusCallback?.(`Eligible ${selectedType.toLowerCase()} found — adding it from your inventory…`);
    await ensureInventorySideReady("you");
    const currentPage = await waitForInventoryReady("you");
    item = currentPage.querySelector(`#${CSS.escape(result.itemId)}`);
    if (!item) throw new Error("Steam's Your inventory changed before the fallback weapon could be added.");
    await moveItemToTrade(item, "you");

    const movedAssets = await waitForTradeAsset("you", result.assetId, 5000);
    if (!movedAssets.has(result.assetId)) {
      throw new Error("Steam did not place the fallback normal weapon into the trade.");
    }

    return result.name || "normal weapon";
  }

  async function addHalfScrapFallback(paymentSide, statusCallback) {
    const changeSide = paymentSide === "you" ? "their" : "you";
    statusCallback?.(`No half-scrap weapon found on the ${changeSide === "you" ? "your" : "trader's"} change side. Adding one Scrap of change and a normal weapon to balance the half scrap…`);

    await ensureInventorySideReady(changeSide);
    const changeScrap = await addMetalTypeToSide(
      changeSide,
      METAL_IMAGES.scrap,
      1,
      "scrap",
      progress => statusCallback?.(`Adding fallback change Scrap: ${progress.added}/${progress.requested}…`),
      status => statusCallback?.(status)
    );
    if (changeScrap !== 1) {
      throw new Error(`Steam could not add one extra Scrap to the ${changeSide} side for the half-scrap fallback.`);
    }

    if (paymentSide === "you") {
      await ensureInventorySideReady("you");
      return {
        weaponName: await addFallbackWeaponToOurSide(statusCallback),
        weaponSide: "you",
        changeScrapAdded: 1,
        paymentScrapAdded: 0
      };
    }

    // If the user is receiving metal, first try to balance the extra change
    // with a weapon the payer can add and one more Scrap returned by the user.
    try {
      await ensureInventorySideReady("their");
      return {
        weaponName: await addHalfScrapWeapon("their", statusCallback),
        weaponSide: "their",
        changeScrapAdded: 1,
        paymentScrapAdded: 0
      };
    } catch (paymentWeaponError) {
      const message = String(paymentWeaponError?.message || paymentWeaponError || "");
      if (
        message !== "NO_ELIGIBLE_WEAPON_FOUND" &&
        !/Steam did not place the selected normal weapon into the trade/i.test(message)
      ) {
        throw paymentWeaponError;
      }

      // Last exact fallback: the payer adds one more Scrap; the user's
      // change side returns one extra Scrap plus a normal weapon (half scrap).
      statusCallback?.("No payer-side weapon found. Adding one Scrap on each side and a normal weapon from your inventory…");
      const paymentScrap = await addMetalTypeToSide(
        "their",
        METAL_IMAGES.scrap,
        1,
        "scrap",
        progress => statusCallback?.(`Adding payer fallback Scrap: ${progress.added}/${progress.requested}…`),
        status => statusCallback?.(status)
      );
      if (paymentScrap !== 1) {
        throw new Error("Steam could not add the payer-side Scrap required for the half-scrap fallback.");
      }
      return {
        weaponName: await addFallbackWeaponToOurSide(statusCallback),
        weaponSide: "you",
        changeScrapAdded: 1,
        paymentScrapAdded: 1
      };
    }
  }

  async function calculateAndAddMetalToSide(side, amount, statusCallback, itemUnitPrice = null, itemCount = 1, options = {}) {
    const metal = convertMetalAmount(amount, itemUnitPrice, itemCount);
    const desiredScrap = metal.totalScrap;
    const changeSide = side === "you" ? "their" : "you";
    const tradeRoots = {
      you: document.querySelector("#your_slots"),
      their: document.querySelector("#their_slots")
    };
    if (!tradeRoots.you || !tradeRoots.their) {
      throw new Error("Steam's trade slots were not available before adding metal.");
    }
    const originalTradeItemIds = Object.fromEntries(
      Object.entries(tradeRoots).map(([tradeSide, root]) => [
        tradeSide,
        new Set([...root.querySelectorAll('.item[id^="item"]')].map(item => item.id))
      ])
    );

    statusCallback?.(`Need ${metal.refined} ref, ${metal.reclaimed} rec, ${metal.scrap} scrap${metal.halfScrap ? " + 1 half-scrap weapon" : ""} from ${side === "you" ? "your" : "their"} inventory`);

    await ensurePageBridge();

    const added = { refined: 0, reclaimed: 0, scrap: 0 };
    // The trade itself is the source of truth for the payment metal already
    // placed. Reading it back (never below what was counted) keeps every
    // fallback step aware of the total metal in the trade.
    const syncAddedFromTrade = () => {
      const staged = countStagedMetal(readStagedMetalItems(side));
      for (const label of Object.keys(added)) added[label] = Math.max(added[label], staged[label]);
      return metalCountsToScrap(added);
    };

    try {
      // Metal that is already in the trade counts toward the payment, so only
      // the missing value is searched for. If the trade holds too much, trim
      // the excess locally instead of rebuilding it.
      const stagedPaymentItems = await trimStagedMetalToValue(side, Math.floor(desiredScrap), statusCallback);
      Object.assign(added, countStagedMetal(stagedPaymentItems));
      const stagedPaymentScrap = metalCountsToScrap(added);
      if (stagedPaymentScrap > 0) {
        statusCallback?.(`${stagedPaymentScrap} scrap of metal is already in the trade; searching only for the remaining value.`);
      }

      // First try the exact TF2 denomination breakdown for whatever value is
      // still missing. If Steam cannot supply the complete breakdown, keep the
      // metal already staged and fill the rest from the available
      // denominations. This is the important "change" flow:
      //
      //   5.66 + trader has only ref
      //     -> remove partial 5 ref
      //     -> trader gives 6 ref
      //     -> we give 3 scrap (1 rec) back
      //
      //   1.55 + trader has no scrap
      //     -> remove partial 1 ref
      //     -> trader gives 1 ref + 2 rec = 1.66
      //     -> we give 1 scrap back
      // Normalize the whole-scrap portion into the largest denominations
      // before searching. The first pass is the cheapest/exact denomination
      // plan. If one denomination is missing, rebuild from a clean trade and
      // calculate the payment from the metal VALUE that is actually available.
      //
      // This is important for cases such as a 1.50 ref price (13.5 scrap):
      // if the trader has 3 reclaimed + 5 scrap and no refined, that is 14
      // scrap of value and is enough. Do not assume a missing refined means
      // the trader cannot pay.
      const normalizedWhole = metalValueToDenominations(
        Math.max(0, Math.floor(desiredScrap) - metalCountsToScrap(added))
      );
      const exactPlan = [
        ["refined", METAL_IMAGES.refined, normalizedWhole.refined],
        ["reclaimed", METAL_IMAGES.reclaimed, normalizedWhole.reclaimed],
        ["scrap", METAL_IMAGES.scrap, normalizedWhole.scrap]
      ];
      const unavailableDenominations = new Set();

      for (const [label, imageUrl, requested] of exactPlan) {
        if (requested === 0) continue;
        const count = await addMetalTypeToSide(
          side,
          imageUrl,
          requested,
          label,
          progress => statusCallback?.(`Adding ${label}: ${progress.added}/${progress.requested}`),
          status => statusCallback?.(status)
        );
        added[label] += count;
        if (count < requested) unavailableDenominations.add(label);
      }

      let paidScrap = syncAddedFromTrade();
      const requiredWholeScrap = Math.floor(desiredScrap);
      // Whole-scrap prices are covered as soon as the trade holds at least the
      // price; any surplus is returned as change below.
      const exactMetalComplete = !metal.halfScrap && paidScrap >= requiredWholeScrap;
      let exactHalfScrapComplete = metal.halfScrap && paidScrap >= requiredWholeScrap;
      let halfScrapWeaponUnavailable = false;
      let halfScrapWeapon = null;

      if (exactHalfScrapComplete && paidScrap === requiredWholeScrap) {
        const itemsBeforeWeapon = new Set(
          [...tradeRoots[side].querySelectorAll('.item[id^="item"]')].map(item => item.id)
        );
        try {
          halfScrapWeapon = await addHalfScrapWeapon(side, statusCallback);
        } catch (error) {
          const message = String(error?.message || error || "");
          const canRebuildWithWholeScrap =
            message === "NO_ELIGIBLE_WEAPON_FOUND" ||
            /Steam did not place the selected normal weapon into the trade/i.test(message);
          if (!canRebuildWithWholeScrap) throw error;

          const failedWeaponIds = [...tradeRoots[side].querySelectorAll('.item[id^="item"]')]
            .map(item => item.id)
            .filter(itemId => !itemsBeforeWeapon.has(itemId));
          if (failedWeaponIds.length) {
            await removeTradeItemsFromSide(side, failedWeaponIds, statusCallback);
          }
          statusCallback?.("No half-scrap weapon was available with the exact metal. Keeping the metal already added and filling the payment to the next scrap…");
          exactHalfScrapComplete = false;
          halfScrapWeaponUnavailable = true;
          halfScrapWeapon = null;
        }
      }

      if (!exactMetalComplete && !exactHalfScrapComplete) {
        statusCallback?.(
          paidScrap >= Math.ceil(desiredScrap)
            ? "The metal already in the trade covers the payment; no more metal is needed."
            : "The exact metal breakdown is short. Keeping the metal already added and filling the remaining scrap value…"
        );

        // For whole-ref prices we need exactly that whole-scrap value. For a
        // half-scrap price, the smallest possible whole-metal payment is the
        // next scrap value (e.g. 13.5 -> 14). We then give 0.5 scrap back as
        // the normal half-scrap weapon/change flow.

        // Try the largest denomination first, but request ENOUGH of each
        // denomination to cover the remaining value. addMetalTypeToSide()
        // naturally returns fewer items when the inventory does not have that
        // many. We then continue with the next denomination.
        //
        // Example: target 14 scrap, inventory = 3 rec + 5 scrap, 0 ref:
        //   request 2 ref -> 0
        //   request 5 rec -> 3 rec = 9 scrap
        //   request 5 scrap -> 5 scrap
        //   total = 14 scrap, so the payment succeeds.
        //
        // Any denominations already staged by the exact-plan pass remain in
        // the trade. Continue from their scrap value rather than removing and
        // searching for them a second time (e.g. 2 ref + 3 rec = 3 ref).
        const valuePlan = [
          ["refined", METAL_IMAGES.refined, METAL_VALUES.refined],
          ["reclaimed", METAL_IMAGES.reclaimed, METAL_VALUES.reclaimed],
          ["scrap", METAL_IMAGES.scrap, METAL_VALUES.scrap]
        ];

        const targetPaymentScrap = Math.ceil(desiredScrap);
        for (const [label, imageUrl, value] of valuePlan) {
          // Count every piece of metal already in the trade before searching
          // for more; it may already complete the payment.
          paidScrap = syncAddedFromTrade();
          const remaining = Math.max(0, targetPaymentScrap - paidScrap);
          if (remaining <= 0) break;
          if (halfScrapWeaponUnavailable && label !== "scrap") continue;
          if (unavailableDenominations.has(label)) continue;

          const requested = Math.ceil(remaining / value);
          const count = await addMetalTypeToSide(
            side,
            imageUrl,
            requested,
            label,
            progress => statusCallback?.(`Building payment with ${label}: ${progress.added}/${progress.requested}`),
            status => statusCallback?.(status)
          );

          added[label] += count;
          if (count < requested) unavailableDenominations.add(label);
        }

        paidScrap = syncAddedFromTrade();
        if (halfScrapWeaponUnavailable && paidScrap < targetPaymentScrap) {
          throw new Error(
            `Steam could not add the extra Scrap needed to replace the missing half-scrap weapon (${paidScrap}/${targetPaymentScrap} scrap).`
          );
        }
      }

      if (paidScrap < Math.floor(desiredScrap)) {
        throw new Error(`Not enough metal to pay ${amount} ref. Steam's native inventory search could only provide ${paidScrap}/${Math.floor(desiredScrap)} scrap value.`);
      }

      const overpaymentScrap = paidScrap - desiredScrap;
      let changeAdded = { refined: 0, reclaimed: 0, scrap: 0 };
      let changeHalfScrapWeapon = null;
      let changeHalfScrapWeaponSide = null;

      if (overpaymentScrap > 0) {
        const wholeChange = Math.floor(overpaymentScrap);
        const needsHalfScrapChange = Math.abs(overpaymentScrap - wholeChange - 0.5) < 0.0001;

        statusCallback?.(`Trader is overpaying by ${overpaymentScrap} scrap. Adding exact change from the ${changeSide === "you" ? "your" : "trader's"} inventory…`);

        if (wholeChange > 0) {
          changeAdded = await addMetalValueWithFallback(
            changeSide,
            wholeChange,
            statusCallback,
            "change"
          );
        }

        if (needsHalfScrapChange) {
          const changeSideBeforeWeapon = new Set(
            [...tradeRoots[changeSide].querySelectorAll('.item[id^="item"]')].map(item => item.id)
          );
          try {
            changeHalfScrapWeapon = await addHalfScrapWeapon(changeSide, statusCallback);
            changeHalfScrapWeaponSide = changeSide;
          } catch (error) {
            const errorMessage = String(error?.message || error || "");
            const shouldUseOurWeaponFallback =
              errorMessage === "NO_ELIGIBLE_WEAPON_FOUND" ||
              /Steam did not place the selected normal weapon into the trade/i.test(errorMessage);

            if (!shouldUseOurWeaponFallback) throw error;
            const partiallyAddedWeaponIds = [...tradeRoots[changeSide].querySelectorAll('.item[id^="item"]')]
              .map(item => item.id)
              .filter(itemId => !changeSideBeforeWeapon.has(itemId));
            if (partiallyAddedWeaponIds.length) {
              await removeTradeItemsFromSide(changeSide, partiallyAddedWeaponIds, statusCallback);
            }

            // A half-scrap weapon is worth exactly 0.5 scrap. If we cannot
            // successfully get a normal weapon from the change side (either
            // because none is available OR Steam failed to actually place the
            // selected weapon), make the same change another way: they give
            // 1 full scrap and we give them a normal weapon from our side.
            statusCallback?.(
              errorMessage === "Steam did not place the selected normal weapon into the trade."
                ? "Steam failed to place the change-side weapon — adding one Scrap of change and balancing with a payment-side weapon…"
                : "No eligible weapon was found on the change side — adding one Scrap of change and balancing with a payment-side weapon…"
            );

            try {
              // Explicit recovery sequence: clear -> Scrap search -> add Scrap
              // to their side -> switch to our inventory -> Advanced weapon
              // filter on our side.
              const fallback = await addHalfScrapFallback(side, statusCallback);
              changeHalfScrapWeapon = fallback.weaponName;
              changeHalfScrapWeaponSide = fallback.weaponSide;
              changeAdded.scrap += fallback.changeScrapAdded;
              added.scrap += fallback.paymentScrapAdded;
              paidScrap += fallback.paymentScrapAdded;
            } catch (weaponError) {
              if (weaponError?.message === "NO_ELIGIBLE_WEAPON_FOUND") {
                throw new Error("No eligible normal weapon was found in your inventory for the half-scrap change fallback.");
              }
              throw weaponError;
            }
          }
        } else if (!Number.isInteger(overpaymentScrap)) {
          throw new Error(`Could not represent ${overpaymentScrap} scrap of change.`);
        }
      }

      if (metal.halfScrap && overpaymentScrap <= 0 && !halfScrapWeapon) {
        halfScrapWeapon = await addHalfScrapWeapon(side, statusCallback);
      }

      const paymentText = `${added.refined} ref, ${added.reclaimed} rec, ${added.scrap} scrap`;
      const changeText = overpaymentScrap > 0
        ? ` · change: ${changeAdded.refined} ref, ${changeAdded.reclaimed} rec, ${changeAdded.scrap} scrap${changeHalfScrapWeapon ? ` · balance weapon ${changeHalfScrapWeapon} on ${changeHalfScrapWeaponSide === "you" ? "your" : "trader's"} side (0.5 scrap)` : ""}`
        : "";
      statusCallback?.(`Payment added: ${paymentText}${halfScrapWeapon ? ` + ${halfScrapWeapon} (half scrap)` : ""}${changeText}`);

      return {
        requested: metal,
        added,
        halfScrapWeapon,
        change: changeAdded,
        changeHalfScrapWeapon,
        changeHalfScrapWeaponSide,
        overpaymentScrap
      };
    } catch (error) {
      // A grouped-order caller keeps the staged metal after a genuine shortage
      // so a smaller quantity can reuse it without searching again.
      if (options?.keepStagedMetalOnShortage && isInsufficientMetalPaymentError(error)) {
        throw error;
      }
      const cleanupErrors = [];
      for (const tradeSide of ["you", "their"]) {
        const root = tradeRoots[tradeSide];
        const newItemIds = [...root.querySelectorAll('.item[id^="item"]')]
          .map(item => item.id)
          .filter(itemId => !originalTradeItemIds[tradeSide].has(itemId));
        if (!newItemIds.length) continue;
        try {
          await removeTradeItemsFromSide(tradeSide, newItemIds, statusCallback);
        } catch (cleanupError) {
          cleanupErrors.push(`${tradeSide}: ${cleanupError.message || cleanupError}`);
        }
      }
      if (cleanupErrors.length) {
        throw new Error(
          `${error.message || error}. Steam also failed to remove partial metal/change items (${cleanupErrors.join("; ")}). Review the trade before continuing.`
        );
      }
      throw error;
    }
  }

  // Compatibility wrapper: BUY listings pay us from THEIR inventory.
  // Keep the old helper name available so the calculation path cannot throw
  // calculateAndAddMetal is not defined.
  async function calculateAndAddMetal(amount, statusCallback) {
    return calculateAndAddMetalToSide("their", amount, statusCallback);
  }

  async function addMetalTypeToSide(side, imageUrl, amount, label, onProgress, searchStatus) {
    let added = 0;
    const searchQuery = `${label[0].toUpperCase()}${label.slice(1)} Metal`;

    // Steam's native search shows only the first chunk of matching items
    // (commonly 16). Once we consume that chunk, clear the search and run the
    // exact same native search again. The items we just moved are no longer in
    // the inventory, so Steam's fresh search exposes the next chunk.
    //
    // This is intentionally NOT a page-sifting fallback: we never inspect
    // inventory pages or manually navigate them. We only reset and re-run
    // Steam's own Search Within Listings.
    let searchPass = 0;
    const maxSearchPasses = Math.max(2, Math.ceil(amount / 8) + 2);
    let searchSettleFailures = 0;
    await ensureInventorySideReady(side);
    await clearSteamInventoryAdvancedFilters(side);

    while (added < amount && searchPass < maxSearchPasses) {
      searchPass++;

      // This is the critical v0.9.65 metal-search behavior: verify that the
      // requested Steam inventory container is actually active immediately
      // before every native metal search pass. The double-click inventory
      // switching remains owned by the current page-bridge implementation.
      await ensureInventorySideReady(side);
      await setSteamInventorySearch("");
      await waitForSearchToSettle("", side, "", 5000);
      await setSteamInventorySearch(searchQuery);
      try {
        await waitForSearchToSettle(searchQuery, side, imageUrl, 5000);
        searchSettleFailures = 0;
      } catch (error) {
        if (!/Steam's inventory search did not finish updating\./i.test(String(error?.message || error || ""))) {
          throw error;
        }

        searchSettleFailures++;
        if (added > 0 || searchSettleFailures >= 2) {
          searchStatus?.(
            added > 0
              ? `No further ${label} was visible; continuing with lower-value metal.`
              : `Steam could not confirm any ${label}; continuing with lower-value metal.`
          );
          break;
        }
        await sleep(250);
        continue;
      }
      const page = await waitForInventoryReady(side);
      if (!page) break;

      const items = [...page.querySelectorAll('.itemHolder .item.app440, .itemHolder .item[id^="item440_"]')]
        .filter(item => {
          if (!isVisible(item) || !item.querySelector('img') || !getAssetId(item)) return false;

          // Metal searches are image-verified. Steam's native search can
          // surface lookalike/case results, so accept only an item whose
          // rendered Steam economy image matches the
          // exact denomination image we requested.
          if (label === "refined" || label === "reclaimed" || label === "scrap") {
            const expected = String(imageUrl || "").trim().toLowerCase()
              .replace(/\/(?:\d+f?x\d+f?)$/, "");
            return [...item.querySelectorAll("img")].some(image => {
              const sources = [
                image.currentSrc,
                image.getAttribute("src"),
                image.getAttribute("data-src"),
                image.getAttribute("data-original")
              ].filter(Boolean);
              return sources.some(src => {
                let value = String(src).trim().toLowerCase().split("?")[0].split("#")[0];
                return value.replace(/\/(?:\d+f?x\d+f?)$/, "") === expected;
              });
            });
          }

          return true;
        });

      if (items.length === 0) break;

      const beforePass = added;
      for (const target of items) {
        if (added >= amount) break;
        const assetId = getAssetId(target);
        if (!assetId) continue;

        // Steam can rebuild the native-search results between the moment we
        // collect the candidate and the moment we ask Steam to move it.
        // Re-read the exact asset from the active inventory immediately before
        // moving it so we never send a stale DOM node to MoveItemToTrade.
        const before = countTradeAssets(side);

        let moved = false;
        for (let attempt = 0; attempt < 2 && !moved; attempt++) {
          const activePage = await ensureInventorySideReady(side);
          const currentTarget = activePage.querySelector(`#item440_2_${CSS.escape(assetId)}`);
          if (!currentTarget) break;

          await moveItemToTrade(currentTarget, side);
          const after = await waitForTradeAsset(side, assetId, 5000);
          moved = after.has(assetId);

          if (!moved) await sleep(250);
        }

        if (!moved || before.has(assetId)) {
          throw new Error(`Steam did not add ${label} (asset ${assetId}) to the ${side} side after retrying.`);
        }
        added++;
        onProgress?.({ label, added, requested: amount, itemId: target.id, assetId, page: 1 });
      }

      // If Steam returned items but none could actually be moved, repeating
      // the search would only loop forever. Let the caller report the shortfall.
      if (added === beforePass) break;
    }

    return added;
  }

  function readTradeSubmissionRetryContext() {
    let raw;
    try {
      raw = window.sessionStorage.getItem(TRADE_SUBMISSION_RETRY_STORAGE_KEY);
    } catch (error) {
      throw new Error(`Could not access the tab's trade retry state: ${error?.message || error}`);
    }
    if (!raw) return null;

    let context;
    try {
      context = JSON.parse(raw);
    } catch (error) {
      throw new Error(`The saved trade retry state is invalid: ${error?.message || error}`);
    }
    if (
      !context ||
      context.href !== window.location.href ||
      !["listing", "manual"].includes(context.mode) ||
      !Number.isSafeInteger(context.attempts) ||
      context.attempts < 0 ||
      context.attempts > MAX_TRADE_SUBMISSION_REFRESH_RETRIES
    ) {
      try {
        window.sessionStorage.removeItem(TRADE_SUBMISSION_RETRY_STORAGE_KEY);
      } catch (error) {
        throw new Error(`Could not clear stale trade retry state: ${error?.message || error}`);
      }
      return null;
    }
    return context;
  }

  function beginTradeSubmissionRetryContext(listing = null, amount = "") {
    const mode = listing ? "listing" : "manual";
    const jobId = String(listing?.arbitrageJobId || "");
    const current = readTradeSubmissionRetryContext();
    if (current && current.mode === mode && current.jobId === jobId) return current;

    const context = {
      href: window.location.href,
      mode,
      jobId,
      amount: String(amount ?? ""),
      attempts: 0
    };
    try {
      window.sessionStorage.setItem(TRADE_SUBMISSION_RETRY_STORAGE_KEY, JSON.stringify(context));
    } catch (error) {
      throw new Error(`Could not save trade retry state: ${error?.message || error}`);
    }
    return context;
  }

  function clearTradeSubmissionRetryContext() {
    try {
      window.sessionStorage.removeItem(TRADE_SUBMISSION_RETRY_STORAGE_KEY);
    } catch (error) {
      console.warn("TF2 Metal Trader: could not clear completed trade retry state.", error);
    }
  }

  // Steam shows send errors in a modal dialog (ShowAlertDialog), for example
  // "Make Offer / There was an error sending your trade offer. Please try
  // again later. (26)". These are <dialog class="newmodal"> elements.
  function visibleSteamDialogTexts() {
    return [...document.querySelectorAll("dialog.newmodal, div.newmodal")]
      .filter(isVisible)
      .map(element => String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
  }

  function getTradeSubmissionFailureMessage(ignoredDialogTexts = null) {
    const header = document.querySelector("#alert-header");
    const content = document.querySelector("#alert-content");
    const visibleText = [header, content]
      .filter(isVisible)
      .map(element => String(element.innerText || element.textContent || ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const normalized = visibleText.toLowerCase();
    const failure = /\b(?:failed|failure|error|unable|cannot|can['’]t|could not|couldn['’]t|problem)\b/.test(normalized);
    const tradeOfferMentioned = /\btrade offer\b/.test(normalized);
    const sendAttemptMentioned = /\b(?:send|sending|submission|submit)\b/.test(normalized) ||
      /\btry again later\b/.test(normalized);
    if (failure && tradeOfferMentioned && sendAttemptMentioned) return visibleText.slice(0, 320);

    for (const text of visibleSteamDialogTexts()) {
      if (ignoredDialogTexts?.has(text)) continue;
      const lower = text.toLowerCase();
      if (
        /\b(?:make offer|trade offer)\b/.test(lower) &&
        /\b(?:error|failed|failure|unable|cannot|can['’]t|could not|couldn['’]t|problem|try again later|invalid|no longer|not available|too many|exceeded|limit)\b/.test(lower)
      ) {
        return text.slice(0, 320);
      }
    }
    return "";
  }

  // Follows Steam's own send request (reported by the page bridge) so success
  // and failure come from the real response.
  function watchTradeSendResult() {
    const watch = { started: false, result: null, stop: () => {} };
    const parse = event => {
      try { return typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail; }
      catch { return null; }
    };
    const onStarted = () => { watch.started = true; };
    const onResult = event => {
      const detail = parse(event);
      if (detail && typeof detail === "object") watch.result = detail;
    };
    window.addEventListener("tmt-trade-send-started", onStarted);
    window.addEventListener("tmt-trade-send-result", onResult);
    watch.stop = () => {
      window.removeEventListener("tmt-trade-send-started", onStarted);
      window.removeEventListener("tmt-trade-send-result", onResult);
    };
    return watch;
  }

  function dispatchListingSubmissionRetryEvent(type, context, message) {
    if (!context?.jobId) return;
    window.dispatchEvent(new CustomEvent(`tf2mt-arbitrage-listing-${type}`, {
      detail: JSON.stringify({
        jobId: context.jobId,
        attempt: context.attempts,
        maxAttempts: MAX_TRADE_SUBMISSION_REFRESH_RETRIES,
        message
      })
    }));
  }

  function prepareTradeSubmissionRetry(message, statusCallback) {
    const listing = getListingFromUrl();
    let context;
    try {
      context = readTradeSubmissionRetryContext() ||
        beginTradeSubmissionRetryContext(listing, document.querySelector("#tmt-amount")?.value || "");
    } catch (error) {
      return { retrying: false, error: `${message} Automatic refresh retry could not be prepared: ${error.message || error}` };
    }

    if (context.attempts >= MAX_TRADE_SUBMISSION_REFRESH_RETRIES) {
      clearTradeSubmissionRetryContext();
      const stoppedMessage = `Steam still could not send the trade offer after ${context.attempts} page-refresh ${context.attempts === 1 ? "retry" : "retries"}. ${message}`;
      dispatchListingSubmissionRetryEvent("retry-failed", context, stoppedMessage);
      return { retrying: false, error: stoppedMessage };
    }

    context.attempts++;
    try {
      window.sessionStorage.setItem(TRADE_SUBMISSION_RETRY_STORAGE_KEY, JSON.stringify(context));
    } catch (error) {
      return { retrying: false, error: `${message} Could not save the page-refresh retry count: ${error?.message || error}` };
    }

    const retryMessage = `Steam could not send the trade offer. Refreshing the trade page to retry (${context.attempts}/${MAX_TRADE_SUBMISSION_REFRESH_RETRIES})…`;
    dispatchListingSubmissionRetryEvent("retrying", context, `${retryMessage} ${message}`);
    statusCallback?.(retryMessage);
    const delayMs = TRADE_SUBMISSION_REFRESH_DELAYS_MS[Math.min(context.attempts, TRADE_SUBMISSION_REFRESH_DELAYS_MS.length) - 1];
    setTimeout(() => window.location.reload(), delayMs);
    return { retrying: true };
  }

  async function waitForSubmitTransition(watch, ignoredDialogTexts = null, timeoutMs = 45000) {
    // Clicking #trade_confirmbtn starts Steam's submission asynchronously.
    // The page bridge reports Steam's real response to that request: an offer
    // id means the offer was sent, an error means Steam refused it. Only if no
    // request was observed do we fall back to what the page shows.
    const startedAt = Date.now();
    const noRequestFallbackMs = 4000;
    const noRequestTimeoutMs = 12000;

    while (true) {
      const result = watch?.result;
      if (result) {
        return result.ok
          ? { status: "sent", tradeOfferId: result.tradeOfferId }
          : { status: "failed", message: String(result.error || "Steam rejected the trade offer.").slice(0, 320) };
      }

      const elapsed = Date.now() - startedAt;
      const limitMs = watch?.started ? timeoutMs : Math.min(timeoutMs, noRequestTimeoutMs);
      if (elapsed >= limitMs) break;

      // While Steam's request is in flight, wait for its answer; the page is
      // only consulted when no request was seen (or the answer is very late).
      if (!watch?.started || elapsed >= limitMs - 5000) {
        const failureMessage = getTradeSubmissionFailureMessage(ignoredDialogTexts);
        if (failureMessage) return { status: "failed", message: failureMessage };

        const headerText = (document.querySelector("#alert-header")?.textContent || "")
          .trim()
          .replace(/\s+/g, " ")
          .toLowerCase();
        if (headerText === "your trade has been sent") return { status: "sent" };

        const button = document.querySelector("#trade_confirmbtn");
        if (!watch?.started && elapsed >= noRequestFallbackMs && (!isVisible(button) || button.disabled)) {
          return { status: "processing" };
        }
      }

      await sleep(FAST_POLL_MS);
    }

    // Steam did not expose a definitive transition within the timeout. The
    // confirm click has already happened, so proceed rather than waiting for
    // mobile confirmation indefinitely.
    return { status: "timeout" };
  }

  async function finishTradeAutomatically(statusCallback, offeredAssetIds = []) {
    if (isArbitrageVerificationPage()) {
      throw new Error("Trade submission is disabled in read-only arbitrage verification mode.");
    }
    const listing = getListingFromUrl();
    const watch = watchTradeSendResult();
    let submission;
    try {
      statusCallback?.("Accepting trade contents…");
      await toggleReady();

      statusCallback?.("Trade contents accepted. Waiting for the offer to become confirmable…");
      await waitForConfirmButton(listing ? 20000 : 60000, statusCallback);

      statusCallback?.("Confirming trade offer…");
      const dialogsBeforeSend = new Set(visibleSteamDialogTexts());
      await confirmTradeOffer();

      // Wait for Steam's real answer to the send request (never for the
      // mobile confirmation itself).
      statusCallback?.("Trade submitted. Waiting for Steam to confirm the offer was sent…");
      submission = await waitForSubmitTransition(watch, dialogsBeforeSend);
    } catch (error) {
      // Any Steam-side problem while accepting or sending is handled the same
      // way as a rejected offer: refresh the page and try again.
      submission = { status: "failed", message: String(error?.message || error || "Steam could not send the trade offer.") };
    } finally {
      watch.stop();
    }

    if (submission.status === "failed") {
      const retry = prepareTradeSubmissionRetry(submission.message, statusCallback);
      if (retry.retrying) return { retrying: true };
      throw new Error(retry.error);
    }
    clearTradeSubmissionRetryContext();
    if (listing?.arbitrageJobId) {
      window.dispatchEvent(new CustomEvent("tf2mt-arbitrage-listing-sent", {
        detail: JSON.stringify({
          jobId: listing.arbitrageJobId,
          assetIds: parseAssetIdList(offeredAssetIds.join(",")),
          tradeOfferId: /^\d+$/.test(String(submission.tradeOfferId || "")) ? String(submission.tradeOfferId) : ""
        })
      }));
    }
    statusCallback?.(listing?.arbitrageJobId
      ? "Trade submission started. Waiting for the arbitrage controller…"
      : "Trade submission started. Closing trade tab…");
    if (!listing?.arbitrageJobId) {
      await browser.runtime.sendMessage({ type: "tmt-close-current-tab" });
    }
    return { submitted: true, transition: submission.status };
  }

  function callBridge(eventName, payload, statusCallback) {
    return new Promise((resolve, reject) => {
      const resultEvent = eventName === "tmt-toggle-ready"
        ? "tmt-ready-result"
        : eventName === "tmt-confirm-trade"
          ? "tmt-confirm-result"
          : "tmt-accept-incoming-result";
      const requestId = `${eventName}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timeoutMs = eventName === "tmt-accept-incoming" ? 660000 : 7000;
      const timeout = setTimeout(() => {
        window.removeEventListener(resultEvent, onResult);
        if (eventName === "tmt-accept-incoming") {
          window.removeEventListener("tmt-accept-incoming-progress", onProgress);
        }
        reject(new Error(`Steam did not respond to ${eventName}.`));
      }, timeoutMs);

      function onProgress(event) {
        let detail;
        try { detail = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail; }
        catch { return; }
        if (detail?.requestId === requestId && typeof detail.message === "string") {
          statusCallback?.(detail.message, detail);
        }
      }

      function onResult(event) {
        let detail;
        try { detail = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail; }
        catch { return; }
        if (!detail || detail.requestId !== requestId) return;
        clearTimeout(timeout);
        window.removeEventListener(resultEvent, onResult);
        if (eventName === "tmt-accept-incoming") {
          window.removeEventListener("tmt-accept-incoming-progress", onProgress);
        }
        if (detail.ok) resolve(detail);
        else reject(new Error(detail.error || `Steam rejected ${eventName}.`));
      }

      window.addEventListener(resultEvent, onResult);
      if (eventName === "tmt-accept-incoming") {
        window.addEventListener("tmt-accept-incoming-progress", onProgress);
      }
      window.dispatchEvent(new CustomEvent(eventName, {
        detail: JSON.stringify({ requestId, ...payload })
      }));
    });
  }

  async function acceptIncomingTradeOffer(statusCallback, requireCompletionConfirmation = true) {
    const tradeOfferId = getIncomingTradeOfferId();
    if (!tradeOfferId) return false;

    statusCallback?.("Incoming offer page loaded. Waiting for Steam's trade controls…", {
      phase: "offer-page-loaded",
      tradeOfferId,
      evidence: `Opened /tradeoffer/${tradeOfferId}/ without extension URL parameters.`
    });
    // Steam can load the offer shell before its trade controls are ready.
    // The page bridge polls for the controls, so no fixed startup delay is
    // needed here.
    await ensurePageBridge();
    return callBridge("tmt-accept-incoming", { tradeOfferId, requireCompletionConfirmation }, statusCallback);
  }

  async function waitForTradeSlots(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const you = document.querySelector("#your_slots");
      const their = document.querySelector("#their_slots");
      if (you && their) return { you, their };
      await sleep(100);
    }
    throw new Error(`Steam's trade slots did not load within ${Math.floor(timeoutMs / 1000)} seconds.`);
  }

  // After a page-refresh retry Steam may restore the failed offer's draft.
  // Clear it so the trade is rebuilt from scratch and nothing is duplicated.
  async function clearRestoredTradeDraft(statusCallback, timeoutMs = 3000) {
    const { you, their } = await waitForTradeSlots();
    const countItems = () =>
      you.querySelectorAll('.item[id^="item"]').length + their.querySelectorAll('.item[id^="item"]').length;
    const startedAt = Date.now();
    let inventoryReadySince = 0;
    while (Date.now() - startedAt < timeoutMs && countItems() === 0) {
      // Once the inventory has loaded, a draft would already be showing.
      if (isInventorySideActive("you")) {
        if (!inventoryReadySince) inventoryReadySince = Date.now();
        else if (Date.now() - inventoryReadySince >= 800) break;
      }
      await sleep(100);
    }
    if (countItems() === 0) return 0;

    // Let the rest of the draft render before clearing both sides.
    await sleep(600);
    statusCallback?.("Steam restored the failed offer's draft. Clearing it before rebuilding the trade…");
    const removed =
      await removeAllItemsFromTradeSide("you", statusCallback) +
      await removeAllItemsFromTradeSide("their", statusCallback);
    if (countItems() > 0) {
      throw new Error("Could not clear the restored trade draft after refreshing the page.");
    }
    return removed;
  }

  // A single transient Steam error (side switch, search settle, slow DOM)
  // must not abort an item add that was never really attempted. Retry with a
  // fresh side selection, and treat the add as successful if Steam placed the
  // item despite reporting an error.
  async function addExactNamedItemWithRetry(side, itemName, onProgress, preferredAssetId = "", excludedAssetIds = null, itemFilters = null) {
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const before = countTradeAssets(side);
      try {
        return await addExactNamedItem(side, itemName, onProgress, false, preferredAssetId, false, excludedAssetIds, itemFilters);
      } catch (error) {
        lastError = error;
        if (countTradeAssets(side).size > before.size) return true;

        const message = String(error?.message || error || "");
        // A search that finds nothing, or only reserved copies, will not
        // improve with more attempts.
        const itemMissing = /found no result for|did not find the exact|No unused .* is left/i.test(message);
        if (attempt >= 3 || (itemMissing && (attempt >= 2 || /No unused .* is left/i.test(message)))) break;

        onProgress?.(`Retrying ${itemName} (${attempt + 1}/3) after: ${message}`);
        await sleep(400);
        try {
          await selectInventorySide(side);
        } catch (selectError) {
          console.debug("TF2 Metal Trader: inventory reselect before retry failed.", selectError);
        }
      }
    }
    throw lastError || new Error(`Could not add ${itemName} to the ${side} side.`);
  }

  async function processBackpackListing(listing, statusCallback) {
    if (isArbitrageVerificationPage()) {
      throw new Error("Trade automation is disabled in read-only arbitrage verification mode.");
    }
    if (!listing?.name) {
      throw new Error("Backpack.tf listing did not provide an item name.");
    }
    const retryContext = beginTradeSubmissionRetryContext(listing);

    listing.intent = resolveListingIntent(listing.intent, listing.comment, listing.description);
    if (listing.intent !== "buy" && listing.intent !== "sell") {
      throw new Error(
        `Could not determine whether this is a buy or sell order for "${listing.name}". ` +
        "The listing metadata and description did not identify its direction; no items were added."
      );
    }

    const tradePrice = parseListingTradePrice(listing.price);
    if (tradePrice === null) {
      throw new Error(`Could not understand listing price "${listing.price || "unknown"}". Use a price such as 1.55 ref or 1 key and 26 ref.`);
    }
    // Needed only to pay a key price in metal when keys are short.
    const keyRate = tradePrice.keys > 0 ? resolveKeyRate(listing) : null;

    if (retryContext?.attempts > 0) {
      await clearRestoredTradeDraft(statusCallback);
    }

    const isSellOrder = listing.intent === "sell";

    if (!isSellOrder) {
      // Original v0.9.7 behavior: a Backpack.tf BUY listing means the trader
      // is buying the item from us, so we send them the item and receive the
      // listed keys/ref.
      const requestedQuantity = Math.max(1, getRequestedListingQuantity(listing));
      statusCallback?.(`BUY order: ${listing.name} · ${listing.price}`);
      statusCallback?.(requestedQuantity > 1
        ? `Listing requests up to ${requestedQuantity}× ${listing.name}. Adding items one at a time…`
        : `Searching your inventory for "${listing.name}"…`);

      const { you: yourSlots, their: theirSlots } = await waitForTradeSlots();
      const readItemIds = root => [...root.querySelectorAll('.item[id^="item"]')]
        .map(item => item.id)
        .filter(Boolean);
      const originalYourItemIds = new Set(readItemIds(yourSlots));
      const paymentBaselineIds = new Set(readItemIds(theirSlots));
      const addedListingItemIds = () => readItemIds(yourSlots)
        .filter(itemId => !originalYourItemIds.has(itemId));
      const removeStagedPayment = async () => {
        const stagedIds = readItemIds(theirSlots).filter(itemId => !paymentBaselineIds.has(itemId));
        if (!stagedIds.length) return;
        try {
          await removeTradeItemsFromSide("their", stagedIds, statusCallback);
        } catch (cleanupError) {
          console.warn("TF2 Metal Trader: could not remove staged payment.", cleanupError);
        }
      };

      // Add the requested item copies one at a time. If Steam cannot provide
      // another copy, stop immediately and pay only for the copies that were
      // actually added. This prevents a partial item trade from being paired
      // with the full stock price.
      let itemCount = 0;
      let lastItemError = null;
      const reservedAssets = new Set(listing.excludedAssetIds || []);
      if (reservedAssets.size) {
        statusCallback?.(`${reservedAssets.size} ${listing.name} cop${reservedAssets.size === 1 ? "y is" : "ies are"} already reserved by earlier offers and will be skipped.`);
      }
      for (let i = 0; i < requestedQuantity; i++) {
        try {
          const addedAsset = await addExactNamedItemWithRetry(
            "you",
            listing.name,
            progress => statusCallback?.(`Adding item ${i + 1}/${requestedQuantity} · ${progress}`),
            "",
            reservedAssets,
            listingItemFilters(listing)
          );
          // Reserve the copy immediately so the next copy of this same offer
          // can never be the same asset.
          if (typeof addedAsset === "string") reservedAssets.add(addedAsset);
          itemCount++;
        } catch (error) {
          lastItemError = error;
          statusCallback?.(`Could not add item ${i + 1}/${requestedQuantity}; stopping at ${itemCount} item${itemCount === 1 ? "" : "s"}.`);
          break;
        }
      }

      if (itemCount === 0) {
        throw lastItemError || new Error(`Could not add ${listing.name} to the trade.`);
      }

      let paymentComplete = false;
      while (itemCount > 0 && !paymentComplete) {
        const actualTradePrice = multiplyTradePrice(tradePrice, itemCount);
        const actualPriceText = [
          actualTradePrice.keys ? `${actualTradePrice.keys} key${actualTradePrice.keys === 1 ? "" : "s"}` : "",
          actualTradePrice.refined ? `${actualTradePrice.refined} ref` : ""
        ].filter(Boolean).join(" + ") || "nothing";

        statusCallback?.(`Added ${itemCount}× ${listing.name}. Paying ${actualPriceText} for the items actually added…`);
        try {
          await selectInventorySide("their");

          // When the trader cannot supply every key, the whole price is paid
          // in metal instead (keys converted at the key rate).
          let payInMetalOnly = false;
          if (actualTradePrice.keys > 0 || readItemIds(theirSlots).some(itemId => !paymentBaselineIds.has(itemId))) {
            // Keys left from a failed larger attempt count toward this
            // payment. Trim any surplus locally and search only for the rest.
            const metalIds = new Set(readStagedMetalItems("their").map(item => item.id));
            const stagedKeyIds = readItemIds(theirSlots)
              .filter(itemId => !paymentBaselineIds.has(itemId) && !metalIds.has(itemId));
            let keysToPay = actualTradePrice.keys;
            if (keysToPay > 0) {
              const plan = await planKeyPayment("their", keysToPay, stagedKeyIds, keyRate, statusCallback);
              if (!plan.useKeys) {
                payInMetalOnly = true;
                keysToPay = 0;
              }
            }
            if (stagedKeyIds.length > keysToPay) {
              await removeTradeItemsFromSide("their", stagedKeyIds.slice(keysToPay), statusCallback);
            }
            const keysStaged = Math.min(stagedKeyIds.length, keysToPay);
            const keysNeeded = keysToPay - keysStaged;
            if (keysNeeded > 0) {
              statusCallback?.(`Searching their inventory for ${keysNeeded}× ${KEY_NAME}…`);
              try {
                for (let i = 0; i < keysNeeded; i++) {
                  await addExactNamedItemWithRetry(
                    "their",
                    KEY_NAME,
                    progress => statusCallback?.(`Adding key ${keysStaged + i + 1}/${actualTradePrice.keys} · ${progress}`)
                  );
                }
              } catch (error) {
                // The keys turned out not to be there after all: pay in metal.
                if (!keyRate || !isKeyShortageError(error)) throw error;
                const addedKeyIds = readItemIds(theirSlots)
                  .filter(itemId => !paymentBaselineIds.has(itemId) && !metalIds.has(itemId));
                if (addedKeyIds.length) await removeTradeItemsFromSide("their", addedKeyIds, statusCallback);
                statusCallback?.(`Not enough ${KEY_NAME}s in their inventory. Paying the whole price in metal instead (${keyRate} ref per key)…`);
                payInMetalOnly = true;
              }
            }
          }

          if (payInMetalOnly) {
            const unitMetalRef = metalOnlyUnitPrice(tradePrice, keyRate);
            await calculateAndAddMetalToSide(
              "their",
              Math.round(unitMetalRef * itemCount * 100) / 100,
              statusCallback,
              unitMetalRef,
              itemCount,
              { keepStagedMetalOnShortage: true }
            );
          } else if (actualTradePrice.refined > 0) {
            await calculateAndAddMetalToSide(
              "their",
              actualTradePrice.refined,
              statusCallback,
              tradePrice.refined,
              itemCount,
              { keepStagedMetalOnShortage: true }
            );
          } else {
            statusCallback?.(`Done: ${actualTradePrice.keys} key${actualTradePrice.keys === 1 ? "" : "s"}, no metal required.`);
          }
          paymentComplete = true;
        } catch (error) {
          if (!isInsufficientMetalPaymentError(error)) {
            await removeStagedPayment();
            throw error;
          }

          // The metal staged for the larger quantity stays in the trade; the
          // next attempt subtracts it from the smaller total.
          const offeredItemIds = addedListingItemIds();
          if (offeredItemIds.length !== itemCount) {
            await removeStagedPayment();
            throw new Error(
              `Could not safely reduce the ${listing.name} offer after insufficient metal; Steam shows ${offeredItemIds.length} added item slots for a ${itemCount}-item payment.`
            );
          }
          await removeTradeItemsFromSide("you", [offeredItemIds[offeredItemIds.length - 1]], statusCallback);
          itemCount--;

          if (itemCount === 0) {
            await removeStagedPayment();
            throw new Error(
              `The trader does not have enough metal to pay for even one ${listing.name}. ${String(error?.message || error)}`
            );
          }
          statusCallback?.(`Not enough metal for the full amount. Removed one ${listing.name}; retrying payment for ${itemCount} item${itemCount === 1 ? "" : "s"} using the metal already in the trade…`);
        }
      }

      if (!paymentComplete) throw new Error(`Could not complete the ${listing.name} trade payment.`);
      // Report the exact copies this offer uses so the controller never reuses
      // them in another offer.
      const offeredAssetIds = addedListingItemIds()
        .map(itemId => String(itemId).match(/^item\d+_\d+_(\d+)$/)?.[1])
        .filter(Boolean);
      return await finishTradeAutomatically(statusCallback, offeredAssetIds);
    }

    // Sell orders are the reverse of BUY orders: the trader sends us the
    // listed item and we pay the listed price.  Reuse the same quantity
    // parser used by BUY orders so comments such as "Stock: 37",
    // "Selling 2", and "I am selling 1" all control the number of copies.
    const requestedQuantity = Math.max(1, getRequestedListingQuantity(listing));
    statusCallback?.(`SELL order: buying ${listing.name} for ${listing.price}`);
    statusCallback?.(requestedQuantity > 1
      ? `Listing offers up to ${requestedQuantity}× ${listing.name}. Checking how many copies you can afford…`
      : `Listing offers 1× ${listing.name}.`);

    // We may have to reduce a grouped sell listing when the requested total
    // payment is larger than the metal/keys available on our side.  Work
    // downward one copy at a time.  Each failed payment attempt is rebuilt
    // from a clean trade so partial metal/change from the previous attempt
    // can never be mixed with the smaller quantity.
    let quantity = requestedQuantity;
    let lastPaymentError = null;
    let successfulQuantity = 0;

    for (; quantity > 0; quantity--) {
      if (successfulQuantity > 0) break;

      // On retries, remove the previous attempt completely before rebuilding
      // the smaller quantity. The trade is dedicated to this listing, so this
      // safely removes both the received items and any partial payment/change.
      if (quantity !== requestedQuantity) {
        statusCallback?.(`Not enough payment for ${quantity + 1}× ${listing.name}. Removing one item and retrying with ${quantity}×…`);
        await removeAllItemsFromTradeSide("their", statusCallback);
        await removeAllItemsFromTradeSide("you", statusCallback);
      }

      // Add the requested number of copies from THEIR inventory. If Steam runs
      // out of copies before the requested quantity, use the number that was
      // actually added rather than paying for nonexistent items.
      await selectInventorySide("their");
      let itemCount = 0;
      let lastItemError = null;

      for (let i = 0; i < quantity; i++) {
        try {
          await addExactNamedItemWithRetry(
            "their",
            listing.name,
            progress => statusCallback?.(`Adding item ${i + 1}/${quantity} · ${progress}`),
            i === 0 ? (listing.assetId || "") : "",
            null,
            listingItemFilters(listing)
          );
          itemCount++;
        } catch (error) {
          lastItemError = error;
          break;
        }
      }

      if (itemCount === 0) {
        throw lastItemError || new Error(`Could not add ${listing.name} to the trade.`);
      }

      // If Steam had fewer copies than the comment requested, the actual
      // quantity is the number that made it into the trade. Do not charge for
      // copies that were unavailable.
      if (itemCount < quantity) {
        quantity = itemCount;
        statusCallback?.(`Only ${itemCount}× ${listing.name} could be added. Paying for the copies actually available…`);
      }

      const actualTradePrice = multiplyTradePrice(tradePrice, itemCount);
      const actualPriceText = [
        actualTradePrice.keys ? `${actualTradePrice.keys} key${actualTradePrice.keys === 1 ? "" : "s"}` : "",
        actualTradePrice.refined ? `${actualTradePrice.refined} ref` : ""
      ].filter(Boolean).join(" + ") || "nothing";

      statusCallback?.(`SELL order: ${itemCount}× ${listing.name} requires ${actualPriceText}. Adding payment from your inventory…`);

      try {
        await selectInventorySide("you");

        // If I cannot supply every key, the whole price is paid in metal
        // instead (keys converted at the key rate).
        let payInMetalOnly = false;
        if (actualTradePrice.keys > 0) {
          const plan = await planKeyPayment("you", actualTradePrice.keys, [], keyRate, statusCallback);
          if (plan.useKeys) {
            statusCallback?.(`Adding ${actualTradePrice.keys}× ${KEY_NAME} from your inventory…`);
            const yourItemIds = () => [...(document.querySelector("#your_slots")?.querySelectorAll('.item[id^="item"]') || [])].map(item => item.id);
            const yourItemsBeforeKeys = new Set(yourItemIds());
            try {
              for (let i = 0; i < actualTradePrice.keys; i++) {
                await addExactNamedItemWithRetry(
                  "you",
                  KEY_NAME,
                  progress => statusCallback?.(`Adding key ${i + 1}/${actualTradePrice.keys} · ${progress}`)
                );
              }
            } catch (error) {
              // The keys turned out not to be there after all: pay in metal.
              if (!keyRate || !isKeyShortageError(error)) throw error;
              const addedKeyIds = yourItemIds().filter(itemId => !yourItemsBeforeKeys.has(itemId));
              if (addedKeyIds.length) await removeTradeItemsFromSide("you", addedKeyIds, statusCallback);
              statusCallback?.(`Not enough ${KEY_NAME}s in your inventory. Paying the whole price in metal instead (${keyRate} ref per key)…`);
              payInMetalOnly = true;
            }
          } else {
            payInMetalOnly = true;
          }
        }

        if (payInMetalOnly) {
          const unitMetalRef = metalOnlyUnitPrice(tradePrice, keyRate);
          await calculateAndAddMetalToSide("you", Math.round(unitMetalRef * itemCount * 100) / 100, statusCallback, unitMetalRef, itemCount);
        } else if (actualTradePrice.refined > 0) {
          await calculateAndAddMetalToSide("you", actualTradePrice.refined, statusCallback, tradePrice.refined, itemCount);
        }

        successfulQuantity = itemCount;
        statusCallback?.(`Payment is available. Trade contains ${itemCount}× ${listing.name} for ${actualPriceText}.`);
      } catch (error) {
        lastPaymentError = error;

        // If this was the final possible copy, there is no smaller quantity
        // to try. Re-throw the original payment error below.
        if (quantity <= 1) break;

        // The loop will clear both sides at the top of the next iteration and
        // then rebuild the trade with one fewer item.
      }
    }

    if (successfulQuantity === 0) {
      throw lastPaymentError || new Error(`Could not afford even one ${listing.name}.`);
    }

    // The normal finish routine remains unchanged. At this point the trade
    // should contain their item on their side and our payment on our side.
    return await finishTradeAutomatically(statusCallback);
  }

  function createUI() {
    if (document.querySelector("#tf2-metal-trader")) return;
    const verificationMode = isArbitrageVerificationPage();
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const requiredRef = Number(fragment.get("tmt_required_ref"));

    const panel = document.createElement("div");
    panel.id = "tf2-metal-trader";
    panel.innerHTML = `
      <div class="tmt-header">
        <div>
          <div class="tmt-title">TF2 Metal Trader</div>
          <div class="tmt-subtitle">v${EXTENSION_VERSION} · Faster Backpack.tf → Steam trade automation</div>
        </div>
        <button class="tmt-close" type="button" title="Hide">×</button>
      </div>
      <div class="tmt-body">
        <label class="tmt-label" for="tmt-amount">Metal amount</label>
        <input id="tmt-amount" class="tmt-input" type="number" min="0" step="0.11" placeholder="e.g. 11.55" />
        <button id="tmt-add" class="tmt-add" type="button">Add metal</button>
        <div class="tmt-auto-note">After adding the metal, TF2 Metal Trader will automatically accept the trade and confirm the offer when Steam allows it.</div>
        <div class="tmt-preview" id="tmt-preview">Enter an amount</div>
        <div class="tmt-status" id="tmt-status">Ready</div>
      </div>
    `;

    document.body.appendChild(panel);

    const amountInput = panel.querySelector("#tmt-amount");
    const addButton = panel.querySelector("#tmt-add");
    const preview = panel.querySelector("#tmt-preview");
    const status = panel.querySelector("#tmt-status");

    if (verificationMode) {
      amountInput.value = Number.isFinite(requiredRef) ? requiredRef.toFixed(2) : "";
      amountInput.disabled = true;
      addButton.style.display = "none";
      panel.querySelector(".tmt-label").textContent = "Metal availability test";
      panel.querySelector(".tmt-auto-note").textContent =
        "Temporarily tests adding only the required metal to the trader's side, then removes the test items. The offer is never submitted.";
      preview.textContent = "Testing whether the trader can add the required metal…";
      status.textContent = "Metal availability test starting…";
      if (Number.isFinite(requiredRef) && requiredRef >= 0) {
        runTraderMetalVerification(requiredRef, text => { status.textContent = text; })
          .then(result => {
            status.className = `tmt-status ${result.sufficient ? "success" : "error"}`;
            status.textContent = `${result.sufficient ? "Metal can be added" : "Not enough metal"}: ${result.availableRef.toFixed(2)} ref staged / ${requiredRef.toFixed(2)} ref required. Test items were removed.`;
          })
          .catch(error => {
            console.error("TF2 Metal Trader metal availability test:", error);
            status.className = "tmt-status error";
            status.textContent = `Could not test trader metal: ${error.message || error}`;
          });
      } else {
        status.className = "tmt-status error";
        status.textContent = "Could not test trader metal: the arbitrage request has an invalid required amount.";
      }
    }

    function updatePreview() {
      try {
        const m = convertMetalAmount(amountInput.value);
        preview.textContent =
          `${m.refined} ref + ${m.reclaimed} rec + ${m.scrap} scrap` +
          (m.halfScrap ? " + 1 normal weapon (half scrap)" : "");
      } catch {
        preview.textContent = "Enter an amount";
      }
    }

    const listing = getListingFromUrl();
    if (listing && !verificationMode) {
      // The URL fragment is now the source of truth for the listing.
      amountInput.value = listing.price.replace(/\s*ref(?:ined)?\s*$/i, "");
      updatePreview();
      preview.textContent = `${listing.intent === "sell" ? "Buying" : "Selling"}: ${listing.name} · ${listing.price}`;
      console.info("TF2 Metal Trader: Backpack.tf listing received", listing);

      // Run the listing flow automatically. The user should not need to
      // re-enter the price or manually press Add metal.
      addButton.disabled = true;
      status.textContent = "Starting Backpack.tf trade…";

      processBackpackListing(listing, text => {
        status.textContent = text;
      }).then(result => {
        if (result?.retrying) {
          status.textContent = "Steam rejected the offer. Refreshing the trade page to retry…";
          return;
        }
        status.className = "tmt-status success";
        status.textContent = "Trade offer submitted. Check Steam for any final confirmation step.";
      }).catch(error => {
        clearTradeSubmissionRetryContext();
        console.error("TF2 Metal Trader Backpack.tf flow:", error);
        status.className = "tmt-status error";
        status.textContent = `Error: ${error.message || error}`;
      });
    }

    amountInput.addEventListener("input", updatePreview);
    panel.querySelector(".tmt-close").addEventListener("click", () => panel.remove());

    addButton.addEventListener("click", async () => {
      if (verificationMode || addButton.disabled) return;
      addButton.disabled = true;
      status.className = "tmt-status";

      try {
        beginTradeSubmissionRetryContext(null, amountInput.value);
        status.textContent = "Checking Steam trade controls…";
        await calculateAndAddMetal(amountInput.value, text => {
          status.textContent = text;
        });
        const result = await finishTradeAutomatically(text => {
          status.textContent = text;
        });
        if (result?.retrying) {
          status.textContent = "Steam rejected the offer. Refreshing the trade page to retry…";
          return;
        }
        status.classList.add("success");
      } catch (error) {
        clearTradeSubmissionRetryContext();
        console.error("TF2 Metal Trader v0.6:", error);
        status.textContent = `Error: ${error.message || error}`;
        status.classList.add("error");
      } finally {
        addButton.disabled = false;
      }
    });

    amountInput.addEventListener("keydown", event => {
      if (event.key === "Enter") addButton.click();
    });

    if (!listing && !verificationMode) {
      try {
        const retryContext = readTradeSubmissionRetryContext();
        if (retryContext?.mode === "manual" && retryContext.attempts > 0) {
          amountInput.value = retryContext.amount;
          updatePreview();
          status.textContent = `Refreshing a failed trade and checking its draft (${retryContext.attempts}/${MAX_TRADE_SUBMISSION_REFRESH_RETRIES})…`;
          setTimeout(() => {
            (async () => {
              const deadline = Date.now() + 15000;
              let tradeRootsReady = false;
              let restoredItemCount = 0;
              while (Date.now() < deadline) {
                const yourSlots = document.querySelector("#your_slots");
                const theirSlots = document.querySelector("#their_slots");
                if (yourSlots && theirSlots) {
                  tradeRootsReady = true;
                  restoredItemCount =
                    yourSlots.querySelectorAll('.item[id^="item"]').length +
                    theirSlots.querySelectorAll('.item[id^="item"]').length;
                  if (restoredItemCount > 0) break;
                }
                await sleep(FAST_POLL_MS);
              }
              if (!tradeRootsReady) {
                throw new Error("Steam did not restore the trade slots after the page refresh.");
              }
              if (restoredItemCount > 0) {
                addButton.disabled = true;
                status.textContent = "Steam restored the failed trade draft. Retrying submission without adding duplicate items…";
                const result = await finishTradeAutomatically(text => {
                  status.textContent = text;
                });
                if (result?.retrying) return;
                status.className = "tmt-status success";
                status.textContent = "Trade offer submitted after refreshing the restored draft.";
                return;
              }
              status.textContent = "Steam did not restore the draft items. Rebuilding the manual metal trade and retrying…";
              addButton.click();
            })().catch(error => {
              clearTradeSubmissionRetryContext();
              status.className = "tmt-status error";
              status.textContent = `Could not retry the refreshed trade: ${error.message || error}`;
            });
          }, 0);
        }
      } catch (error) {
        status.className = "tmt-status error";
        status.textContent = `Could not restore the trade retry state: ${error.message || error}`;
      }
    }

    // Trade acceptance and confirmation are now part of the Add metal flow.
    // The extension waits for Steam/the other trader instead of requiring
    // manual clicks.
  }

  function prewarmSteamInventory() {
    // Start the bridge and select the first inventory side in the background
    // as soon as the trade page is ready. This moves Steam's initialization
    // work out of the critical path of the Backpack.tf listing flow.
    ensurePageBridge()
      .then(() => selectInventorySide("you"))
      .catch(error => console.debug("TF2 Metal Trader: inventory prewarm skipped.", error));
  }

  function runTraderMetalVerification(requiredRef, statusCallback) {
    if (!traderMetalVerificationPromise) {
      traderMetalVerificationPromise = inspectTraderMetalInventory(requiredRef, statusCallback);
    }
    return traderMetalVerificationPromise;
  }

  window.addEventListener("tf2mt-verify-trader-metal", event => {
    let request;
    try {
      request = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail;
    } catch (error) {
      console.warn("TF2 Metal Trader: invalid arbitrage verification request.", error);
      return;
    }
    if (!request || typeof request.requestId !== "string" || !isArbitrageVerificationPage()) return;

    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const requiredRef = Number(fragment.get("tmt_required_ref"));
    if (Number(request.requiredRef) !== requiredRef) {
      window.dispatchEvent(new CustomEvent("tf2mt-verify-trader-metal-result", {
        detail: JSON.stringify({
          requestId: request.requestId,
          result: { status: "unverified", reason: "The arbitrage request does not match this tab's metal verification parameters." }
        })
      }));
      return;
    }
    window.dispatchEvent(new CustomEvent("tf2mt-verify-trader-metal-started", {
      detail: JSON.stringify({ requestId: request.requestId })
    }));
    runTraderMetalVerification(requiredRef, text => {
      const status = document.querySelector("#tmt-status");
      if (status) status.textContent = text;
    })
      .then(result => {
        window.dispatchEvent(new CustomEvent("tf2mt-verify-trader-metal-result", {
          detail: JSON.stringify({ requestId: request.requestId, result })
        }));
      })
      .catch(error => {
        console.error("TF2 Metal Trader metal availability test:", error);
        window.dispatchEvent(new CustomEvent("tf2mt-verify-trader-metal-result", {
          detail: JSON.stringify({
            requestId: request.requestId,
            result: { status: "unverified", reason: error.message || String(error) }
          })
        }));
      });
  });

  async function autoAcceptIncomingTrade() {
    if (!isIncomingTradeOfferPage() || window.__TF2_METAL_TRADER_INCOMING_STARTED__) return;
    window.__TF2_METAL_TRADER_INCOMING_STARTED__ = true;
    const tradeOfferId = getIncomingTradeOfferId();

    const status = document.querySelector("#tmt-status");
    try {
      const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const arbitrageJobId = params.get("tmt_arb_job");
      const reportProgress = (message, progress = {}) => {
        if (status) status.textContent = message;
        window.dispatchEvent(new CustomEvent("tf2mt-arbitrage-purchase-progress", {
          detail: JSON.stringify({
            tradeOfferId,
            phase: progress.phase || "acceptance-in-progress",
            message,
            evidence: progress.evidence || ""
          })
        }));
      };
      const acceptance = await acceptIncomingTradeOffer(reportProgress, true);
      if (!acceptance?.confirmed || String(acceptance.tradeOfferId) !== String(tradeOfferId)) {
        throw new Error("Steam did not provide confirmed acceptance for this incoming offer.");
      }
      window.dispatchEvent(new CustomEvent("tf2mt-arbitrage-purchase-accepted", {
        detail: JSON.stringify({
          jobId: arbitrageJobId || "",
          tradeOfferId,
          confirmed: true,
          evidence: acceptance.evidence || "",
          evidenceSource: acceptance.evidenceSource || "",
          needsConfirmation: Boolean(acceptance.needsConfirmation)
        })
      }));
      if (status) {
        status.className = "tmt-status success";
        status.textContent = `Steam's offer page reports accepted. ${acceptance.evidence || ""}`;
      }
      if (!arbitrageJobId) {
        await sleep(500);
        await browser.runtime.sendMessage({ type: "tmt-close-current-tab" }).catch(error => {
          console.warn("TF2 Metal Trader: could not close completed trade tab.", error);
        });
      }
    } catch (error) {
      console.error("TF2 Metal Trader incoming trade flow:", error);
      window.dispatchEvent(new CustomEvent("tf2mt-arbitrage-purchase-failed", {
        detail: JSON.stringify({ tradeOfferId, message: error.message || String(error) })
      }));
      if (status) {
        status.className = "tmt-status error";
        status.textContent = `Error: ${error.message || error}`;
      }
    }
  }

  function boot() {
    if (!document.body) return;
    createUI();
    if (!isArbitrageVerificationPage() && !isIncomingTradeOfferPage()) prewarmSteamInventory();
    autoAcceptIncomingTrade();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }

  const observer = new MutationObserver(() => {
    if (!document.querySelector("#tf2-metal-trader")) createUI();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
