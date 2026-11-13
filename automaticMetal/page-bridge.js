(() => {
  "use strict";

  if (window.__TF2_METAL_TRADER_BRIDGE__) return;
  window.__TF2_METAL_TRADER_BRIDGE__ = true;
  const TRADE_PAGE_READY_TIMEOUT_MS = 20000;
  const INVENTORY_SELECTION_ATTEMPT_TIMEOUT_MS = 8000;

  function ready() {
    window.dispatchEvent(new CustomEvent("tmt-bridge-ready"));
  }

  function emit(name, detail) {
    window.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(detail) }));
  }

  // Observe Steam's own trade requests without changing them. The real
  // response (an offer id, or Steam's error text) tells the extension whether an
  // offer was actually sent or accepted, instead of guessing from the page.
  //   POST /tradeoffer/new/send        - sending an outgoing offer
  //   POST /tradeoffer/<id>/accept     - accepting an incoming offer
  function classifyTradeRequest(method, url) {
    try {
      if (String(method).toUpperCase() !== "POST") return null;
      const path = new URL(String(url), window.location.href).pathname;
      if (/\/tradeoffer\/new\/send\/?$/i.test(path)) return { kind: "send" };
      const accept = path.match(/\/tradeoffer\/(\d+)\/accept\/?$/i);
      if (accept) return { kind: "accept", tradeOfferId: accept[1] };
    } catch (_) {}
    return null;
  }

  function describeTradeAcceptResponse(status, text, tradeOfferId) {
    let data = null;
    try { data = JSON.parse(text); } catch (_) {}
    const reason = data && (data.strError || data.error || data.message);
    if (!reason && status > 0 && status < 400) {
      return {
        ok: true,
        status,
        tradeOfferId,
        tradeId: data && data.tradeid !== undefined ? String(data.tradeid) : "",
        needsMobileConfirmation: Boolean(data && data.needs_mobile_confirmation),
        needsEmailConfirmation: Boolean(data && data.needs_email_confirmation)
      };
    }
    return {
      ok: false,
      status,
      tradeOfferId,
      error: String(reason || (status === 0
        ? "Steam did not answer the request to accept the trade offer."
        : `Steam returned HTTP ${status} while accepting the trade offer.`))
    };
  }

  function describeTradeSendResponse(status, text) {
    let data = null;
    try { data = JSON.parse(text); } catch (_) {}
    if (data && data.tradeofferid) {
      return {
        ok: true,
        status,
        tradeOfferId: String(data.tradeofferid),
        needsMobileConfirmation: Boolean(data.needs_mobile_confirmation),
        needsEmailConfirmation: Boolean(data.needs_email_confirmation)
      };
    }
    const reason = data && (data.strError || data.error || data.message);
    return {
      ok: false,
      status,
      error: String(reason || (status === 0
        ? "Steam did not answer the request to send the trade offer."
        : status >= 400
          ? `Steam returned HTTP ${status} while sending the trade offer.`
          : "Steam did not return a trade offer ID."))
    };
  }

  function announceTradeRequestStarted(info) {
    emit(info.kind === "accept" ? "tmt-trade-accept-started" : "tmt-trade-send-started", { tradeOfferId: info.tradeOfferId });
  }

  function announceTradeRequestResult(info, status, text) {
    if (info.kind === "accept") {
      emit("tmt-trade-accept-result", describeTradeAcceptResponse(status, text, info.tradeOfferId));
    } else {
      emit("tmt-trade-send-result", describeTradeSendResponse(status, text));
    }
  }

  function announceTradeRequestFailure(info, status, message) {
    emit(
      info.kind === "accept" ? "tmt-trade-accept-result" : "tmt-trade-send-result",
      { ok: false, status, tradeOfferId: info.tradeOfferId, error: message }
    );
  }

  try {
    const xhrPrototype = window.XMLHttpRequest.prototype;
    const nativeOpen = xhrPrototype.open;
    const nativeSend = xhrPrototype.send;
    xhrPrototype.open = function (method, url) {
      try { this.__tmtTradeRequest = classifyTradeRequest(method, url); } catch (_) {}
      return nativeOpen.apply(this, arguments);
    };
    xhrPrototype.send = function () {
      const info = this.__tmtTradeRequest;
      if (info) {
        const request = this;
        announceTradeRequestStarted(info);
        request.addEventListener("loadend", () => {
          try {
            const text = request.responseType === "" || request.responseType === "text"
              ? request.responseText
              : JSON.stringify(request.response || {});
            announceTradeRequestResult(info, request.status, text);
          } catch (error) {
            announceTradeRequestFailure(info, request.status, error?.message || String(error));
          }
        });
      }
      return nativeSend.apply(this, arguments);
    };

    if (typeof window.fetch === "function") {
      const nativeFetch = window.fetch;
      window.fetch = function (input, init) {
        const request = nativeFetch.apply(this, arguments);
        try {
          const url = typeof input === "string" ? input : input?.url;
          const method = init?.method || input?.method || "GET";
          const info = classifyTradeRequest(method, url);
          if (info) {
            announceTradeRequestStarted(info);
            request.then(
              response => response.clone().text()
                .then(text => announceTradeRequestResult(info, response.status, text))
                .catch(() => announceTradeRequestResult(info, response.status, "")),
              error => announceTradeRequestFailure(info, 0, error?.message || String(error))
            );
          }
        } catch (_) {}
        return request;
      };
    }
  } catch (error) {
    console.debug("TF2 Metal Trader: could not observe Steam's trade requests.", error);
  }

  function steamIdForUser(user) {
    try {
      if (typeof user?.GetSteamId === "function") return String(user.GetSteamId());
      return String(user?.steamid || user?.steamID || user?.steamId || "");
    } catch (_) {
      return "";
    }
  }

  function activeInventoryContainer(side) {
    const theirSide = side === "their" || side === "them";
    const user = theirSide ? window.UserThem : window.UserYou;
    const steamId = steamIdForUser(user);
    const expectedId = steamId ? `inventory_${steamId}_440_2` : "";
    const box = document.querySelector("#inventory_box");
    const theirSideActive = Boolean(box?.classList.contains("their_inventory_active"));
    if (!box) return null;

    const containers = [...document.querySelectorAll('.inventory_ctn[id*="_440_2"]')];
    const isVisible = container => {
      const style = window.getComputedStyle(container);
      return style.display !== "none" && style.visibility !== "hidden";
    };
    const visibleContainers = containers.filter(isVisible);
    const requestedSideActive = theirSide ? theirSideActive : !theirSideActive;
    if (expectedId) {
      const expected = document.getElementById(expectedId);
      if (!expected || !isVisible(expected)) return null;
      const identityIsUnambiguous =
        visibleContainers.length === 1 && visibleContainers[0] === expected;
      return requestedSideActive || identityIsUnambiguous ? expected : null;
    }
    if (!requestedSideActive || visibleContainers.length !== 1) return null;
    return visibleContainers[0];
  }

  async function waitForActiveInventory(side, timeout = 3000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const container = activeInventoryContainer(side);
      if (container) return container;
      await new Promise(resolve => setTimeout(resolve, 75));
    }
    return null;
  }

  async function clearAdvancedInventoryFilters(side) {
    if (!(await waitForActiveInventory(side))) {
      throw new Error(`Steam's ${side === "their" ? "Their" : "Your"} inventory was not active before clearing advanced filters.`);
    }

    const prefix = side === "their" ? "them_" : "";
    const options = document.getElementById("filter_options");
    const isCollapsed = options?.classList.contains("filter_collapsed") ||
      (options && window.getComputedStyle(options).display === "none");
    if (isCollapsed) {
      if (typeof window.ToggleTagFilters === "function") window.ToggleTagFilters();
      else document.querySelector(".filter_tag_button")?.click();
    }

    const checkedSelector =
      `#filter_options input.econ_tag_filter_checkbox[id^="tag_filter_${prefix}440_2_"]:checked`;
    let cleared = 0;
    while (document.querySelector(checkedSelector)) {
      if (++cleared > 30) {
        throw new Error(`Steam left too many advanced filters selected on the ${side} inventory.`);
      }
      const checkbox = document.querySelector(checkedSelector);
      const checkboxId = checkbox?.id;
      if (!checkboxId) break;
      checkbox.click();

      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        const current = document.getElementById(checkboxId);
        if (!current || !current.checked) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (document.getElementById(checkboxId)?.checked) {
        throw new Error(`Steam did not clear advanced filter ${checkboxId}.`);
      }
    }
  }

  window.addEventListener("tmt-select-inventory", async event => {
    let detail = {};
    try {
      detail = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail || {};
      const side = detail.side === "their" ? "them" : "you";
      const userObjectName = side === "them" ? "UserThem" : "UserYou";
      const tabId = side === "you"
        ? "inventory_select_your_inventory"
        : "inventory_select_their_inventory";
      const tradeSlotsId = side === "you" ? "your_slots" : "their_slots";
      const readyDeadline = Date.now() + TRADE_PAGE_READY_TIMEOUT_MS;
      let userObject = null;
      let steamId = "";

      while (Date.now() < readyDeadline) {
        userObject = side === "them" ? window.UserThem : window.UserYou;
        steamId = steamIdForUser(userObject);
        if (
          userObject &&
          steamId &&
          typeof window.TradePageSelectInventory === "function" &&
          document.querySelector("#inventory_box") &&
          document.getElementById(tradeSlotsId) &&
          document.getElementById(tabId)
        ) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (
        !userObject ||
        !steamId ||
        typeof window.TradePageSelectInventory !== "function" ||
        !document.querySelector("#inventory_box") ||
        !document.getElementById(tradeSlotsId) ||
        !document.getElementById(tabId)
      ) {
        throw new Error(`Steam's ${userObjectName} trade controls did not finish initializing within ${TRADE_PAGE_READY_TIMEOUT_MS / 1000} seconds.`);
      }

      const expectedInventoryId = steamId ? `inventory_${steamId}_440_2` : "";

      const isInventoryContainerVisible = container => {
        if (!container) return false;
        const style = window.getComputedStyle(container);
        return style.display !== "none" && style.visibility !== "hidden";
      };

      const getVisibleTF2InventoryId = () => {
        const nodes = [...document.querySelectorAll('.inventory_ctn[id*="_440_2"]')];
        const visible = nodes.find(isInventoryContainerVisible);
        return visible?.id || null;
      };

      const getSelectedTF2InventoryId = () => {
        if (expectedInventoryId) {
          const expected = document.getElementById(expectedInventoryId);
          if (isInventoryContainerVisible(expected)) return expected.id;
        }
        return getVisibleTF2InventoryId();
      };

      const isExpectedInventoryActive = () => {
        const activeSide = side === "them" ? "their" : "you";
        return activeInventoryContainer(activeSide)?.id === expectedInventoryId;
      };

      const waitForInventoryDom = async (timeout = INVENTORY_SELECTION_ATTEMPT_TIMEOUT_MS) => {
        const deadline = Date.now() + timeout;
        let active = getSelectedTF2InventoryId();
        while (Date.now() < deadline) {
          active = getSelectedTF2InventoryId();
          if (isExpectedInventoryActive()) return active;
          await new Promise(resolve => setTimeout(resolve, 75));
        }
        return active;
      };

      const nativeSelect = () => {
        window.TradePageSelectInventory(userObject, 440, "2");
      };

      // First use the exact native path that works during ordinary Steam
      // trade switching.
      nativeSelect();
      let activeInventoryId = await waitForInventoryDom();

      // CRITICAL RECOVERY:
      // Steam can update the selected tab without replacing the actual
      // inventory DOM. The manual fix is clicking the already-selected
      // "Your inventory" tab a second time. Reproduce that exact interaction
      // in the page world, then let Steam rebuild the inventory.
      if (!isExpectedInventoryActive()) {
        const tab = document.getElementById(tabId);

        if (tab) {
          tab.click();
          await new Promise(resolve => setTimeout(resolve, 250));
        }

        // Re-run Steam's native selector after the simulated tab click. This
        // mirrors the manual "click Your inventory again" recovery without
        // changing the established inventory-selection path.
        nativeSelect();
        activeInventoryId = await waitForInventoryDom();
      }

      // One final repeated tab click is useful when Steam accepted the first
      // click but its inventory request was still finishing.
      if (!isExpectedInventoryActive()) {
        const tab = document.getElementById(tabId);
        if (tab) {
          tab.click();
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        nativeSelect();
        activeInventoryId = await waitForInventoryDom();
      }

      emit("tmt-select-inventory-result", {
        requestId: detail.requestId,
        ok: isExpectedInventoryActive(),
        side,
        expectedInventoryId,
        activeInventoryId,
        refreshedByTabClick: Boolean(expectedInventoryId && activeInventoryId === expectedInventoryId)
      });
    } catch (error) {
      emit("tmt-select-inventory-result", { requestId: detail.requestId ?? null, ok: false, error: error?.message || String(error) });
    }
  });

  window.addEventListener("tmt-set-filter", event => {
    let detail = {};
    try {
      detail = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail || {};
      const input = document.getElementById("filter_control");
      if (!input) throw new Error("Steam's inventory search field (#filter_control) was not found.");

      input.focus();

      // Steam's own inventory code responds to the search box's keyup path.
      // Use the same minimal trigger as the established trade-offer helper
      // rather than firing input + change + keyup, which can cause extra work.
      if (typeof window.$J === "function") {
        window.$J(input).val(detail.query || "");
      } else {
        input.value = detail.query || "";
      }

      // Steam's trade-page search is powered by its global Filter object.
      // Calling the native handler directly is much more reliable than trying
      // to recreate Steam's Prototype event chain from the extension world.
      // Filter.ApplyFilter also knows how to fully load the inventory before
      // filtering, which is important for large TF2 inventories.
      if (window.Filter && typeof window.Filter.OnFilterChange === "function") {
        window.Filter.OnFilterChange();
      } else {
        // Older Steam builds may not expose Filter yet. Fall back to the real
        // DOM events so the page's own handler can process the search.
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keyup", {
          key: "a",
          code: "KeyA",
          keyCode: 65,
          which: 65,
          bubbles: true,
          cancelable: true
        }));
      }

      emit("tmt-filter-result", {
        requestId: detail.requestId,
        ok: true,
        query: input.value,
        nativeFilter: Boolean(window.Filter && typeof window.Filter.OnFilterChange === "function")
      });
    } catch (error) {
      emit("tmt-filter-result", { requestId: detail.requestId ?? null, ok: false, error: error?.message || String(error) });
    }
  });

  window.addEventListener("tmt-clear-advanced-filters", async event => {
    let detail = {};
    try {
      detail = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail || {};
      const side = detail.side === "their" ? "their" : "you";
      await clearAdvancedInventoryFilters(side);
      emit("tmt-clear-advanced-filters-result", {
        requestId: detail.requestId,
        ok: true,
        side
      });
    } catch (error) {
      emit("tmt-clear-advanced-filters-result", {
        requestId: detail.requestId ?? null,
        ok: false,
        error: error?.message || String(error)
      });
    }
  });

  window.addEventListener("tmt-set-normal-weapon-filters", async event => {
    let detail = {};
    try {
      detail = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail || {};
      const side = detail.side === "their" ? "their" : "you";
      if (!(await waitForActiveInventory(side))) {
        throw new Error(`Steam's ${side === "their" ? "Their" : "Your"} inventory was not active before setting weapon filters.`);
      }
      const prefix = side === "their" ? "them_" : "";
      const allowedWeaponTypes = new Set(["primary", "secondary"]);
      const weaponType = String(detail.weaponType || "primary");
      if (!allowedWeaponTypes.has(weaponType)) {
        throw new Error(`Steam's weapon search supports Primary and Secondary filters only, not "${weaponType}".`);
      }
      const weaponTypeLabels = {
        primary: "Primary Weapon",
        secondary: "Secondary Weapon"
      };
      const weaponTypeTitleCase = {
        primary: "Primary",
        secondary: "Secondary",
        melee: "Melee"
      };
      const typeLabel = weaponTypeLabels[weaponType];

      const showButton = document.querySelector(".filter_tag_button");
      const options = document.getElementById("filter_options");
      const isCollapsed = options?.classList.contains("filter_collapsed") ||
        (options && getComputedStyle(options).display === "none");
      if (isCollapsed) {
        if (typeof window.ToggleTagFilters === "function") {
          window.ToggleTagFilters();
        } else if (showButton) {
          showButton.click();
        }
      }

      const waitFor = async (selector, timeout = 4000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const element = document.querySelector(selector);
          if (element) return element;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        return null;
      };

      const waitForState = async (selector, checked, timeout = 4000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const element = document.querySelector(selector);
          if (element && element.checked === checked) return true;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        return false;
      };

      const getWeaponTypeCheckbox = type => {
        const ids = [
          `tag_filter_${prefix}440_2_Type_${weaponTypeTitleCase[type]}`,
          `tag_filter_${prefix}440_2_Type_${type}`
        ];
        return ids.map(id => document.getElementById(id)).find(Boolean) || null;
      };

      // Weapon selection must start from a completely blank native search.
      const searchInput = document.getElementById("filter_control");
      if (searchInput) {
        if (typeof window.$J === "function") {
          window.$J(searchInput).val("");
        } else {
          searchInput.value = "";
        }
        if (window.Filter && typeof window.Filter.OnFilterChange === "function") {
          window.Filter.OnFilterChange();
        } else {
          searchInput.dispatchEvent(new Event("input", { bubbles: true }));
          searchInput.dispatchEvent(new Event("change", { bubbles: true }));
          searchInput.dispatchEvent(new KeyboardEvent("keyup", {
            key: "a", code: "KeyA", keyCode: 65, which: 65,
            bubbles: true, cancelable: true
          }));
        }
      }

      const qualitySelector = `#tag_filter_${prefix}440_2_Quality_Unique`;
      const unmarketableSelector = `#tag_filter_${prefix}440_2_misc_unmarketable`;

      await waitFor(qualitySelector);
      await waitFor(unmarketableSelector);
      const initialTypeCheckbox = await (async () => {
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline) {
          const checkbox = getWeaponTypeCheckbox(weaponType);
          if (checkbox) return checkbox;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        return null;
      })();
      if (!initialTypeCheckbox) throw new Error(`Steam's ${typeLabel} filter was not available.`);
      const typeSelector = `#${initialTypeCheckbox.id}`;

      // IMPORTANT: Steam applies each checkbox click asynchronously. The old
      // implementation clicked several boxes back-to-back, which could leave
      // the previous Primary filter active when we asked for Melee. Clear all
      // existing tags first, one at a time, and wait for Steam to acknowledge
      // each change before selecting the new three filters.
      const checkedSelector = `#filter_options input.econ_tag_filter_checkbox[id^="tag_filter_${prefix}440_2_"]:checked`;
      let safety = 0;
      while (document.querySelectorAll(checkedSelector).length && safety++ < 30) {
        const checkbox = document.querySelector(checkedSelector);
        if (!checkbox) break;
        checkbox.click();
        await new Promise(resolve => setTimeout(resolve, 150));
      }

      // Re-query after Steam's DOM updates; the checkbox nodes can be replaced.
      const quality = await waitFor(qualitySelector);
      const unmarketable = await waitFor(unmarketableSelector);
      const typeCheckbox = await waitFor(typeSelector);
      if (!quality || !unmarketable || !typeCheckbox) {
        throw new Error(`Steam's Unique + ${typeLabel} + Not Marketable filters were not available.`);
      }

      const clickAndWait = async selector => {
        const checkbox = await waitFor(selector);
        if (!checkbox) throw new Error(`Steam filter ${selector} was not available.`);
        if (!checkbox.checked) checkbox.click();
        if (!(await waitForState(selector, true))) {
          throw new Error(`Steam did not activate filter ${selector}.`);
        }
        // Allow Steam's inventory rebuild to begin before changing the next tag.
        await new Promise(resolve => setTimeout(resolve, 150));
      };

      await clickAndWait(qualitySelector);
      await clickAndWait(unmarketableSelector);
      await clickAndWait(typeSelector);
      if (!(await waitForActiveInventory(side))) {
        throw new Error(`Steam changed away from the ${side === "their" ? "Their" : "Your"} inventory while setting weapon filters.`);
      }

      // Verify that the requested type is the ONLY selected weapon type.
      const typeCheckboxes = ["primary", "secondary", "melee"]
        .map(getWeaponTypeCheckbox);
      const finalType = getWeaponTypeCheckbox(weaponType);
      if (!finalType?.checked) {
        throw new Error(`Steam did not activate the ${typeLabel} filter.`);
      }
      for (const other of typeCheckboxes) {
        if (other && other.id !== finalType.id && other.checked) {
          throw new Error(`Steam left another weapon type filter active while switching to ${typeLabel}.`);
        }
      }

      emit("tmt-normal-weapon-filters-result", {
        requestId: detail.requestId,
        ok: true,
        quality: "Unique",
        type: typeLabel,
        misc: "Not Marketable"
      });
    } catch (error) {
      emit("tmt-normal-weapon-filters-result", {
        requestId: detail.requestId ?? null,
        ok: false,
        error: error?.message || String(error)
      });
    }
  });

  window.addEventListener("tmt-find-normal-weapon", event => {
    let detail = {};
    try {
      detail = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail || {};
      const side = detail.side === "their" ? "their" : "you";
      const inventory = activeInventoryContainer(side);
      if (!inventory) {
        throw new Error(`Steam's ${side === "their" ? "Their" : "Your"} inventory was not active before selecting a weapon.`);
      }
      const excludedWeaponImages = new Set([
        "https://community.fastly.steamstatic.com/economy/image/fWFc82js0fmoRAP-qOIPu5THSWqfSmTELLqcUywGkijVjZULUrsm1j-9xgEIUwQCWhTduS9Tt8TnH_WJRuNVy49itMUB32JtklgoN7OzZTQxJFPEV_lfBa1irV-9C3Zr6sU6AdH457UBFLISf9s/96fx96f",
        "https://community.fastly.steamstatic.com/economy/image/fWFc82js0fmoRAP-qOIPu5THSWqfSmTELLqcUywGkijVjZULUrsm1j-9xgEIUwQCWhTduS9Tt8TnH_WJRuJZyoMx5MMMi2FtlVUuZbblM29hKwaUBaVYDfRuoVu7DCIxvsZmVoH457UBFLISf9s/96fx96f",
        "https://community.fastly.steamstatic.com/economy/image/fWFc82js0fmoRAP-qOIPu5THSWqfSmTELLqcUywGkijVjZULUrsm1j-9xgEIUwYYYh3uuTVGnMD0AuWJGt8Mmsgy4N4E2zIzxAQrYuW2YWcycFKaUvAIWvdt9lm1D3Zr6pM2Voez8esAcA7pqsKYZA9iUxzv/96fx96f",
        "https://community.fastly.steamstatic.com/economy/image/fWFc82js0fmoRAP-qOIPu5THSWqfSmTELLqcUywGkijVjZULUrsm1j-9xgEIUwEYThPhuTNGt8TnH_WJRrRSz4xntZQCi2BpyVQsYuewaGBmdFObBfRYWvRqowu6WHdlupFhAtL457UBypngriA/96fx96f"
      ]);

      // Steam can serve the same inventory image at different resolutions
      // (and occasionally with a query/hash suffix).  Comparing the entire
      // src string made our blocked-weapon check too easy to bypass.  The
      // image path itself is the stable identifier, so normalize away the
      // size suffix and URL decorations before comparing.
      const normalizeWeaponImage = (src) => {
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

      const excludedWeaponImageKeys = new Set(
        [...excludedWeaponImages].map(normalizeWeaponImage)
      );

      // Items that must never be used as a half-scrap weapon, matched by name
      // in addition to the image list above (Steam serves several images for
      // the same item).
      const blockedWeaponNamePattern = /\bfish\s*cake\b/i;
      const candidateNames = (candidate) => {
        const names = [];
        const assetId = String(candidate.id || "").match(/(\d+)$/)?.[1] || "";
        const sources = [candidate.rgItem];
        try {
          const user = side === "their" ? window.UserThem : window.UserYou;
          const inventoryData = user?.getInventory?.(440, "2");
          if (assetId && inventoryData?.rgInventory?.[assetId]) sources.push(inventoryData.rgInventory[assetId]);
        } catch (_) {}
        for (const source of sources) {
          if (!source) continue;
          names.push(source.name, source.market_name, source.market_hash_name);
        }
        for (const image of candidate.querySelectorAll("img")) {
          names.push(image.getAttribute("alt"), image.getAttribute("title"));
        }
        names.push(candidate.getAttribute("title"), candidate.getAttribute("data-name"));
        return names.filter(value => typeof value === "string" && value.trim());
      };

      const isBlockedWeaponCandidate = (candidate) => {
        if (candidateNames(candidate).some(name => blockedWeaponNamePattern.test(name))) return true;

        // Check every image/currentSrc inside the item, not merely the first
        // <img>. Steam can put the actual item image in a different image
        // element depending on inventory state.
        const images = [...candidate.querySelectorAll("img")];
        if (!images.length) return false;

        return images.some(image => {
          const sources = [
            image.currentSrc,
            image.getAttribute("src"),
            image.getAttribute("data-src"),
            image.getAttribute("data-original")
          ].filter(Boolean);

          return sources.some(src => excludedWeaponImageKeys.has(normalizeWeaponImage(src)));
        });
      };

      // Steam's advanced filters define the candidate pool.  Our blocked
      // weapon list is a SECONDARY filter: if Steam gives us a blocked item,
      // skip that item and continue through the rendered candidates instead
      // of returning it and waiting for MoveItemToTrade to fail later.
      const itemHolders = [...inventory.querySelectorAll(".itemHolder")];
      const visibleHolders = itemHolders.filter(holder => holder.offsetParent !== null);

      let item = null;
      for (const holder of visibleHolders) {
        const candidate = holder.querySelector(".item.app440.context2[id^=\"item440_2_\"]");
        if (!candidate) continue;

        if (isBlockedWeaponCandidate(candidate)) {
          console.debug("TF2 Metal Trader: skipped blocked normal-weapon candidate", candidate.id);
          continue;
        }

        item = candidate;
        break;
      }

      if (activeInventoryContainer(side) !== inventory) {
        throw new Error(`Steam changed inventory sides while searching for a normal weapon.`);
      }

      if (!item) {
        emit("tmt-find-normal-weapon-result", {
          requestId: detail.requestId,
          ok: true,
          found: false
        });
        return;
      }
      if (activeInventoryContainer(side) !== inventory || !inventory.contains(item)) {
        throw new Error(`Steam changed inventory sides while selecting a normal weapon.`);
      }

      const match = item.id.match(/^item440_2_(\d+)$/);
      if (!match) {
        emit("tmt-find-normal-weapon-result", {
          requestId: detail.requestId,
          ok: true,
          found: false
        });
        return;
      }

      emit("tmt-find-normal-weapon-result", {
        requestId: detail.requestId,
        ok: true,
        found: true,
        itemId: item.id,
        assetId: match[1],
        name: "normal weapon"
      });
    } catch (error) {
      emit("tmt-find-normal-weapon-result", {
        requestId: detail.requestId ?? null,
        ok: false,
        found: false,
        error: error?.message || String(error)
      });
    }
  });

  // Applies Steam's advanced Quality (and optionally Type: Cosmetic) filters.
  // Tag checkboxes are located by their visible label, so this does not depend
  // on Steam's internal tag ids. Missing filters are reported, not fatal.
  window.addEventListener("tmt-set-item-filters", async event => {
    let detail = {};
    try {
      detail = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail || {};
      const side = detail.side === "their" ? "their" : "you";
      if (!(await waitForActiveInventory(side))) {
        throw new Error(`Steam's ${side === "their" ? "Their" : "Your"} inventory was not active before setting item filters.`);
      }
      const prefix = side === "their" ? "them_" : "";
      const idPrefix = `tag_filter_${prefix}440_2_`;
      const wantedQuality = String(detail.quality || "Unique").trim();
      const wantCosmetic = detail.cosmetic === true;

      // Start from a blank state: no previous tags, no search text.
      await clearAdvancedInventoryFilters(side);

      const labelOf = checkbox => {
        const holder = checkbox.closest("label") || checkbox.parentElement;
        return String(holder?.innerText || holder?.textContent || checkbox.getAttribute("title") || "")
          .replace(/\s+/g, " ")
          .trim();
      };
      const findCheckbox = (category, labelPattern, extraIds = []) => {
        for (const id of extraIds) {
          const direct = document.getElementById(id);
          if (direct) return direct;
        }
        const candidates = [...document.querySelectorAll(`#filter_options input.econ_tag_filter_checkbox[id^="${idPrefix}${category}_"]`)];
        return candidates.find(checkbox => labelPattern.test(labelOf(checkbox))) || null;
      };
      const waitForCheckbox = async (finder, timeout = 4000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          const checkbox = finder();
          if (checkbox) return checkbox;
          await new Promise(resolve => setTimeout(resolve, 80));
        }
        return null;
      };
      const select = async checkbox => {
        if (!checkbox.checked) checkbox.click();
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          if (document.getElementById(checkbox.id)?.checked) break;
          await new Promise(resolve => setTimeout(resolve, 60));
        }
        // Steam applies each tag asynchronously; let it finish before the next.
        await new Promise(resolve => setTimeout(resolve, 200));
        return Boolean(document.getElementById(checkbox.id)?.checked);
      };

      const options = document.getElementById("filter_options");
      const isCollapsed = options?.classList.contains("filter_collapsed") ||
        (options && window.getComputedStyle(options).display === "none");
      if (isCollapsed) {
        if (typeof window.ToggleTagFilters === "function") window.ToggleTagFilters();
        else document.querySelector(".filter_tag_button")?.click();
      }

      const result = { requestId: detail.requestId, ok: true, side, quality: false, cosmetic: false, missing: [] };
      const qualityPattern = new RegExp(`^${wantedQuality.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
      const qualityBox = await waitForCheckbox(() => findCheckbox("Quality", qualityPattern, [`${idPrefix}Quality_${wantedQuality}`]));
      if (qualityBox) result.quality = await select(qualityBox);
      else result.missing.push(`Quality: ${wantedQuality}`);

      if (wantCosmetic) {
        const typeBox = await waitForCheckbox(() => findCheckbox("Type", /^cosmetic/i, [`${idPrefix}Type_Cosmetic`, `${idPrefix}Type_cosmetic`]));
        if (typeBox) result.cosmetic = await select(typeBox);
        else result.missing.push("Type: Cosmetic");
      }

      if (!(await waitForActiveInventory(side))) {
        throw new Error(`Steam changed away from the ${side === "their" ? "Their" : "Your"} inventory while setting item filters.`);
      }
      emit("tmt-set-item-filters-result", result);
    } catch (error) {
      emit("tmt-set-item-filters-result", {
        requestId: detail.requestId ?? null,
        ok: false,
        error: error?.message || String(error)
      });
    }
  });

  // Counts the items currently shown in the inventory whose name is exactly
  // the requested item. Returns their asset ids so repeated pages can be
  // combined without counting an item twice.
  window.addEventListener("tmt-count-inventory-items", event => {
    let detail = {};
    try {
      detail = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail || {};
      const side = detail.side === "their" ? "their" : "you";
      const inventory = activeInventoryContainer(side);
      if (!inventory) {
        throw new Error(`Steam's ${side === "their" ? "Their" : "Your"} inventory was not active before counting items.`);
      }

      const normalizeName = value => String(value || "")
        .normalize("NFKC")
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase()
        .replace(/^the /, "");
      const wanted = normalizeName(detail.itemName);
      const quality = String(detail.quality || "").trim().toLowerCase();
      // Non-Unique items carry their quality in the name ("Strange <item>").
      const acceptable = new Set([wanted]);
      if (quality && quality !== "unique") acceptable.add(normalizeName(`${quality} ${wanted}`));

      const user = side === "their" ? window.UserThem : window.UserYou;
      let inventoryData = null;
      try { inventoryData = user?.getInventory?.(440, "2") || null; } catch (_) {}

      const matches = [];
      const names = [];
      let scanned = 0;
      const holders = [...inventory.querySelectorAll(".itemHolder")].filter(holder => holder.offsetParent !== null);
      for (const holder of holders) {
        const item = holder.querySelector('.item.app440.context2[id^="item440_2_"], .item[id^="item440_"]');
        if (!item) continue;
        scanned++;
        const assetId = String(item.id || "").match(/(\d+)$/)?.[1] || "";
        const sources = [item.rgItem, assetId ? inventoryData?.rgInventory?.[assetId] : null].filter(Boolean);
        const candidateNames = [];
        for (const source of sources) candidateNames.push(source.name, source.market_name, source.market_hash_name);
        const itemName = candidateNames.find(value => typeof value === "string" && value.trim()) || "";
        if (names.length < 6) names.push(itemName);
        if (candidateNames.some(value => typeof value === "string" && acceptable.has(normalizeName(value)))) {
          if (assetId) matches.push(assetId);
        }
      }

      emit("tmt-count-inventory-items-result", {
        requestId: detail.requestId,
        ok: true,
        side,
        scanned,
        matches: [...new Set(matches)],
        sampleNames: names
      });
    } catch (error) {
      emit("tmt-count-inventory-items-result", {
        requestId: detail.requestId ?? null,
        ok: false,
        error: error?.message || String(error)
      });
    }
  });

  window.addEventListener("tmt-remove-item", event => {
    let detail;
    try {
      detail = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail || {};
      const moveItemToInventory = window.MoveItemToInventory;
      if (typeof moveItemToInventory !== "function") {
        throw new Error("Steam's MoveItemToInventory function is unavailable.");
      }

      const itemIds = Array.isArray(detail.itemIds) ? detail.itemIds : [];
      if (itemIds.length === 0) {
        emit("tmt-remove-result", { requestId: detail.requestId, ok: true, removed: 0 });
        return;
      }

      // Steam already exposes the native inverse of MoveItemToTrade:
      // MoveItemToInventory(item). Use it directly from the page world.
      for (const itemId of itemIds) {
        const item = document.getElementById(itemId);
        if (!item) continue;
        moveItemToInventory(item);
      }

      emit("tmt-remove-result", {
        requestId: detail.requestId,
        ok: true,
        removed: itemIds.length
      });
    } catch (error) {
      let parsed = {};
      try { parsed = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail || {}; } catch {}
      emit("tmt-remove-result", {
        requestId: parsed.requestId ?? null,
        ok: false,
        error: error?.message || String(error)
      });
    }
  });

  window.addEventListener("tmt-move-item", event => {
    let detail;
    try {
      detail = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail || {};
      const moveItem = window.MoveItemToTrade;
      if (typeof moveItem !== "function") throw new Error("Steam's MoveItemToTrade function is unavailable.");
      const item = document.getElementById(detail.itemId);
      if (!item) throw new Error(`Steam item ${detail.itemId} no longer exists.`);
      if (detail.side === "you" || detail.side === "their") {
        const inventory = activeInventoryContainer(detail.side);
        if (!inventory || !inventory.contains(item)) {
          throw new Error(`Steam refused to move ${detail.itemId}: it is not in the active ${detail.side} inventory.`);
        }
      }
      moveItem(item);
      emit("tmt-move-result", { requestId: detail.requestId, ok: true, assetId: detail.assetId });
    } catch (error) {
      let parsed = {};
      try { parsed = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail || {}; } catch {}
      emit("tmt-move-result", { requestId: parsed.requestId ?? null, ok: false, assetId: parsed.assetId ?? null, error: error?.message || String(error) });
    }
  });

  window.addEventListener("tmt-accept-incoming", event => {
    let detail = {};
    try {
      detail = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail || {};
      const tradeOfferId = String(detail.tradeOfferId || "").trim();
      if (!/^\d+$/.test(tradeOfferId)) {
        throw new Error("Steam trade offer ID is missing or invalid.");
      }

      let controlDeadline = Date.now() + 30000;
      const handlerStartedAt = Date.now();
      let contentsConfirmed = false;
      let contentsClickedAt = 0;
      let accepted = false;
      let reported = false;
      let acceptanceDeadline = 0;
      let lastProgressSignature = "";
      let lastAcceptedText = "";
      let acceptedSince = 0;
      let acceptedObservations = 0;
      // Steam's own answer to the accept request is the authoritative signal.
      // Clicking the button alone proves nothing: it can be ignored when Steam
      // is not ready yet.
      const MAX_ACCEPT_ATTEMPTS = 4;
      let acceptAttempts = 0;
      let acceptClickedAt = 0;
      let nextAcceptAllowedAt = 0;
      let acceptRequestStarted = false;
      let acceptRequestResult = null;
      const parseBridgeEvent = eventObject => {
        try { return typeof eventObject.detail === "string" ? JSON.parse(eventObject.detail) : eventObject.detail; }
        catch { return null; }
      };
      const onAcceptRequestStarted = eventObject => {
        const info = parseBridgeEvent(eventObject);
        if (info && String(info.tradeOfferId) === tradeOfferId) acceptRequestStarted = true;
      };
      const onAcceptRequestResult = eventObject => {
        const info = parseBridgeEvent(eventObject);
        if (info && String(info.tradeOfferId) === tradeOfferId) acceptRequestResult = info;
      };
      window.addEventListener("tmt-trade-accept-started", onAcceptRequestStarted);
      window.addEventListener("tmt-trade-accept-result", onAcceptRequestResult);
      const stopListeningForAccept = () => {
        window.removeEventListener("tmt-trade-accept-started", onAcceptRequestStarted);
        window.removeEventListener("tmt-trade-accept-result", onAcceptRequestResult);
      };

      const isReadyControl = element => element && isDisplayed(element) && !element.disabled;
      // Steam renders the offer's items after the page itself. When they finish
      // loading it re-renders the trade and drops any confirmation that was
      // already made, so nothing is clicked until the items are on screen and
      // have stopped changing.
      const ITEMS_STABLE_MS = 800;
      const ITEMS_GIVE_UP_MS = 6000;
      const MAX_RECONFIRMATIONS = 5;
      let itemsSignature = "";
      let itemsStableSince = 0;
      let reconfirmations = 0;
      const readOfferItems = () => {
        const unique = [...new Set(document.querySelectorAll(".trade_item, [data-economy-item]"))];
        let allLoaded = true;
        const parts = unique.map(element => {
          const image = element.querySelector("img");
          const loaded = !image || (image.complete && image.naturalWidth > 0);
          if (!loaded) allLoaded = false;
          return `${element.getAttribute("data-economy-item") || element.id || ""}|${image?.getAttribute("src") || ""}|${loaded ? 1 : 0}`;
        });
        return { count: unique.length, allLoaded, signature: parts.join(";") };
      };
      const offerItemsSettled = () => {
        const now = Date.now();
        const items = readOfferItems();
        if (items.signature !== itemsSignature) {
          itemsSignature = items.signature;
          itemsStableSince = now;
        }
        // Items are on screen and unchanged for a moment. An image that never
        // finishes loading must not block the trade forever, so after the give-up
        // wait only the items' stability is required.
        if (items.count > 0) {
          return now - itemsStableSince >= ITEMS_STABLE_MS &&
            (items.allLoaded || now - handlerStartedAt >= ITEMS_GIVE_UP_MS);
        }
        // No item elements recognized: do not wait forever on a layout that
        // marks items differently.
        return now - handlerStartedAt >= ITEMS_GIVE_UP_MS;
      };
      // True when Steam has dropped the contents confirmation we made.
      const contentsConfirmationLost = () =>
        contentsConfirmed &&
        Date.now() - contentsClickedAt >= 1200 &&
        isReadyControl(document.querySelector("#you_notready")) &&
        !isDisplayed(document.querySelector("#you_ready"));
      const reportProgress = (phase, message, evidence = "") => {
        const signature = `${phase}|${evidence}`;
        if (signature === lastProgressSignature) return;
        lastProgressSignature = signature;
        emit("tmt-accept-incoming-progress", {
          requestId: detail.requestId,
          tradeOfferId,
          phase,
          message,
          evidence
        });
      };
      const readSteamOfferStatus = () => {
        const selectors = [
          "#tradeoffer_status_message",
          "#tradeoffer_status",
          ".tradeoffer_status_message"
        ];
        let explicitStatus = null;
        for (const selector of selectors) {
          const element = document.querySelector(selector);
          if (!isDisplayed(element)) continue;
          const text = String(element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
          if (text) {
            explicitStatus = { text, source: selector };
            break;
          }
        }
        const bodyText = String(document.body?.innerText || "").replace(/\s+/g, " ").trim();
        return {
          text: explicitStatus?.text || bodyText,
          decisionText: `${explicitStatus?.text || ""} ${bodyText}`.trim(),
          source: explicitStatus?.source || "visible Steam offer page text"
        };
      };
      const statusEvidence = (text, source, preference = "accepted") => {
        const keywords = preference === "pending"
          ? /mobile|steam guard|authenticator|confirmation|pending|waiting|awaiting/i
          : /accepted|accept|mobile|steam guard|authenticator|confirmation|pending|waiting|awaiting/i;
        const match = keywords.exec(text);
        if (!match) return `${source}: no accepted or confirmation status is visible yet.`;
        const start = Math.max(0, match.index - 70);
        const end = Math.min(text.length, match.index + 150);
        return `${source}: “${text.slice(start, end).trim()}”`;
      };

      const poll = () => {
        if (reported) return;

        if (accepted) {
          // 1. Steam answered the accept request: that is the real result.
          if (acceptRequestResult) {
            if (acceptRequestResult.ok) {
              reported = true;
              stopListeningForAccept();
              const waitingForMobile = acceptRequestResult.needsMobileConfirmation || acceptRequestResult.needsEmailConfirmation;
              const requestEvidence =
                `Steam's accept request for offer #${tradeOfferId} succeeded` +
                `${acceptRequestResult.tradeId ? ` (trade id ${acceptRequestResult.tradeId})` : ""}` +
                `${waitingForMobile ? "; it still needs your mobile/email confirmation" : ""}.`;
              reportProgress(
                waitingForMobile ? "mobile-confirmation-pending" : "steam-accepted",
                waitingForMobile
                  ? "Steam accepted the offer and is waiting for your mobile confirmation."
                  : "Steam accepted the offer.",
                requestEvidence
              );
              emit("tmt-accept-incoming-result", {
                requestId: detail.requestId,
                ok: true,
                tradeOfferId,
                confirmed: true,
                evidence: requestEvidence,
                evidenceSource: "Steam accept request",
                needsConfirmation: Boolean(waitingForMobile)
              });
              return;
            }
            const refusal = String(acceptRequestResult.error || "Steam refused the accept request.");
            if (acceptAttempts >= MAX_ACCEPT_ATTEMPTS) {
              reported = true;
              stopListeningForAccept();
              emit("tmt-accept-incoming-result", {
                requestId: detail.requestId,
                ok: false,
                tradeOfferId,
                evidence: refusal,
                evidenceSource: "Steam accept request",
                error: `Steam refused to accept the incoming offer after ${acceptAttempts} attempts: ${refusal}`
              });
              return;
            }
            reportProgress(
              "accept-request-failed",
              `Steam did not accept the offer (${refusal}). Trying again (${acceptAttempts}/${MAX_ACCEPT_ATTEMPTS})…`,
              refusal
            );
            accepted = false;
            acceptRequestStarted = false;
            acceptRequestResult = null;
            nextAcceptAllowedAt = Date.now() + 2500;
            controlDeadline = Date.now() + 30000;
            setTimeout(poll, 500);
            return;
          }

          // 2. The request is in flight; wait for Steam's answer.
          if (acceptRequestStarted && Date.now() - acceptClickedAt < 45000) {
            setTimeout(poll, 300);
            return;
          }

          // 3. Nothing was sent. If the Accept button is still waiting, the
          //    click had no effect (Steam was not ready) and must be repeated
          //    instead of being treated as accepted.
          const acceptButtonStillWaiting = isReadyControl(document.querySelector("#trade_confirmbtn"));
          // Steam reset the confirmation (the items finished loading after the
          // click), so the accept can never go through until it is made again.
          if (!acceptRequestStarted && contentsConfirmationLost() && reconfirmations < MAX_RECONFIRMATIONS && acceptAttempts < MAX_ACCEPT_ATTEMPTS) {
            reconfirmations++;
            reportProgress(
              "contents-reset",
              "Steam reset the trade confirmation while the items were loading. Confirming the contents again…",
              "#you_notready is enabled again after it was clicked"
            );
            accepted = false;
            contentsConfirmed = false;
            nextAcceptAllowedAt = Date.now();
            controlDeadline = Date.now() + 30000;
            setTimeout(poll, 250);
            return;
          }
          if (!acceptRequestStarted && acceptButtonStillWaiting && Date.now() - acceptClickedAt >= 5000) {
            if (acceptAttempts >= MAX_ACCEPT_ATTEMPTS) {
              reported = true;
              stopListeningForAccept();
              emit("tmt-accept-incoming-result", {
                requestId: detail.requestId,
                ok: false,
                tradeOfferId,
                evidence: "#trade_confirmbtn is still visible and enabled after clicking it.",
                evidenceSource: "#trade_confirmbtn",
                error: `Steam ignored the Accept click ${acceptAttempts} times, so the incoming offer was NOT accepted. No bot offers will be sent.`
              });
              return;
            }
            reportProgress(
              "accept-click-retried",
              `Steam ignored the Accept click (the button is still there). Clicking again (${acceptAttempts}/${MAX_ACCEPT_ATTEMPTS})…`,
              "#trade_confirmbtn still visible and enabled"
            );
            accepted = false;
            nextAcceptAllowedAt = Date.now();
            controlDeadline = Date.now() + 30000;
            setTimeout(poll, 100);
            return;
          }

          // 4. Fallback only when Steam's accept request was never observed
          //    (for example Steam changed how it sends it): trust the page
          //    text, but never while the Accept button is still there.
          const status = readSteamOfferStatus();
          const pageText = status.decisionText.toLowerCase();
          const mobileConfirmationPending =
            /\b(?:awaiting|waiting|pending|requires?|needs?)\b.{0,120}\b(?:mobile|steam guard|authenticator|confirmation)\b/.test(pageText) ||
            /\b(?:mobile|steam guard|authenticator)\b.{0,120}\b(?:awaiting|waiting|pending|required|confirmation)\b/.test(pageText);
          const acceptedMatch = /\b(?:you have accepted (?:this )?trade offer|trade offer (?:has been )?accepted|trade accepted)\b/.exec(pageText);
          const steamReportsAccepted = Boolean(acceptedMatch);
          const evidence = statusEvidence(
            status.decisionText,
            status.source,
            mobileConfirmationPending ? "pending" : "accepted"
          );
          if (mobileConfirmationPending) {
            acceptedSince = 0;
            acceptedObservations = 0;
            lastAcceptedText = "";
            reportProgress(
              "mobile-confirmation-pending",
              "Steam reports that mobile/Steam Guard confirmation is still pending.",
              evidence
            );
          } else if (steamReportsAccepted && !acceptButtonStillWaiting && Date.now() - acceptClickedAt >= 4000) {
            const acceptedSignature = acceptedMatch[0].toLowerCase();
            if (acceptedSignature === lastAcceptedText) {
              acceptedObservations++;
            } else {
              lastAcceptedText = acceptedSignature;
              acceptedSince = Date.now();
              acceptedObservations = 1;
            }

            reportProgress(
              "steam-accepted-observed",
              "Steam's offer page now reports accepted; confirming that the status is stable…",
              evidence
            );
            if (acceptedObservations >= 3 && Date.now() - acceptedSince >= 1000) {
              reported = true;
              reportProgress(
                "steam-accepted",
                "Steam's offer page consistently reports accepted with no mobile confirmation pending.",
                evidence
              );
              emit("tmt-accept-incoming-result", {
                requestId: detail.requestId,
                ok: true,
                tradeOfferId,
                confirmed: true,
                evidence,
                evidenceSource: status.source
              });
              return;
            }
          } else {
            acceptedSince = 0;
            acceptedObservations = 0;
            lastAcceptedText = "";
            reportProgress(
              "waiting-for-steam-status",
              "Accept was clicked. Waiting for Steam's offer page to report its status.",
              evidence
            );
          }
          if (Date.now() >= acceptanceDeadline) {
            reported = true;
            emit("tmt-accept-incoming-result", {
              requestId: detail.requestId,
              ok: false,
              tradeOfferId,
              evidence,
              evidenceSource: status.source,
              error: "Steam did not confirm that the incoming trade was accepted. No bot offers will be sent."
            });
            return;
          }
          setTimeout(poll, 500);
          return;
        }

        const confirmContents = document.querySelector("#you_notready");
        // If Steam dropped the confirmation we already made, make it again.
        if (contentsConfirmationLost() && reconfirmations < MAX_RECONFIRMATIONS) {
          reconfirmations++;
          contentsConfirmed = false;
          controlDeadline = Date.now() + 30000;
          reportProgress(
            "contents-reset",
            "Steam reset the trade confirmation while the items were loading. Confirming the contents again…",
            "#you_notready is enabled again after it was clicked"
          );
        }
        if (!contentsConfirmed) {
          if (isReadyControl(confirmContents)) {
            if (!offerItemsSettled()) {
              reportProgress(
                "waiting-for-items",
                "Waiting for the offer's items to finish loading before confirming the trade contents.",
                "offer items are still loading"
              );
              setTimeout(poll, 250);
              return;
            }
            confirmContents.click();
            contentsConfirmed = true;
            contentsClickedAt = Date.now();
            reportProgress(
              "contents-confirmed",
              "Clicked Steam's “Confirm Trade Contents” control; waiting for the accept control.",
              "#you_notready clicked"
            );
            setTimeout(poll, 250);
            return;
          }
          if (isDisplayed(confirmContents) && Date.now() < controlDeadline) {
            // The control is on screen but still disabled. Wait for it rather
            // than reaching for Accept before the contents are confirmed.
            reportProgress(
              "waiting-for-contents-control",
              "Waiting for Steam's “Confirm Trade Contents” control to become enabled.",
              "#you_notready is visible but disabled"
            );
            setTimeout(poll, 250);
            return;
          }
          reportProgress(
            "waiting-for-contents-control",
            "Waiting for Steam's “Confirm Trade Contents” control to become available.",
            "#you_notready is not visible and enabled yet"
          );
        }

        // Only click Accept once Steam has applied the contents confirmation
        // (its "ready" state shows), or - for a layout without that step - after
        // the page has had a few seconds to render.
        const readyIndicator = document.querySelector("#you_ready");
        const contentsStepDone = contentsConfirmed
          ? ((isDisplayed(readyIndicator) || !isDisplayed(confirmContents) || Date.now() - contentsClickedAt >= 3000) &&
             // Give Steam a moment to re-render before relying on the confirmation.
             Date.now() - contentsClickedAt >= 700)
          : (isDisplayed(readyIndicator) || (!isDisplayed(confirmContents) && Date.now() - handlerStartedAt >= 4000));
        const acceptButton = document.querySelector("#trade_confirmbtn");
        if (contentsStepDone && offerItemsSettled() && Date.now() >= nextAcceptAllowedAt && isReadyControl(acceptButton)) {
          reportProgress(
            "accept-control-ready",
            acceptAttempts
              ? `Steam's accept control is available; clicking it again (attempt ${acceptAttempts + 1}/${MAX_ACCEPT_ATTEMPTS}).`
              : "Steam's accept control is available; clicking it now.",
            "#trade_confirmbtn is visible and enabled"
          );
          acceptAttempts++;
          acceptClickedAt = Date.now();
          acceptRequestStarted = false;
          acceptRequestResult = null;
          acceptButton.click();
          accepted = true;
          if (!detail.requireCompletionConfirmation) {
            setTimeout(() => {
              if (reported) return;
              reported = true;
              emit("tmt-accept-incoming-result", {
                requestId: detail.requestId,
                ok: true,
                tradeOfferId,
                clicked: true,
                evidence: "#trade_confirmbtn clicked; completion confirmation was not requested."
              });
            }, 750);
            return;
          }
          acceptanceDeadline = Date.now() + 600000;
          reportProgress(
            "accept-clicked",
            "Clicked Steam's accept control. The offer is not marked complete yet; waiting for Steam's status update.",
            "#trade_confirmbtn clicked"
          );
          setTimeout(poll, 500);
          return;
        }

        if (Date.now() >= controlDeadline) {
          reported = true;
          emit("tmt-accept-incoming-result", {
            requestId: detail.requestId,
            ok: false,
            error: "Steam's incoming trade controls did not become available."
          });
          return;
        }

        setTimeout(poll, 250);
      };

      setTimeout(poll, 250);
    } catch (error) {
      emit("tmt-accept-incoming-result", {
        requestId: detail.requestId ?? null,
        ok: false,
        error: error?.message || String(error)
      });
    }
  });

  window.addEventListener("tmt-toggle-ready", event => {
    let detail = {};
    try {
      detail = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail || {};
      const notReady = document.getElementById("you_notready");
      const ready = document.getElementById("you_ready");
      const cantReady = document.getElementById("you_cantready");

      // Follow Steam's actual UI path. Clicking the page element runs its
      // inline onclick handler in Steam's own page context.
      if (isDisplayed(notReady)) {
        notReady.click();
      } else if (isDisplayed(ready)) {
        // Already accepted; do not toggle it back off.
      } else if (isDisplayed(cantReady)) {
        throw new Error("Steam is not allowing the trade to be accepted yet.");
      } else {
        throw new Error("Steam's trade ready controls are not currently available.");
      }

      emit("tmt-ready-result", { requestId: detail.requestId, ok: true, alreadyReady: isDisplayed(ready) });
    } catch (error) {
      emit("tmt-ready-result", { requestId: detail.requestId ?? null, ok: false, error: error?.message || String(error) });
    }
  });

  window.addEventListener("tmt-confirm-trade", event => {
    let detail = {};
    try {
      detail = typeof event.detail === "string" ? JSON.parse(event.detail) : event.detail || {};
      const button = document.getElementById("trade_confirmbtn");
      if (!button) throw new Error("Steam's trade confirmation button was not found.");
      if (!isDisplayed(button)) throw new Error("Steam's trade confirmation button is not currently available.");
      if (button.disabled) throw new Error("Steam's trade confirmation button is still disabled.");

      // Click the real Steam button so its own onclick handler executes.
      button.click();
      emit("tmt-confirm-result", { requestId: detail.requestId, ok: true });
    } catch (error) {
      emit("tmt-confirm-result", { requestId: detail.requestId ?? null, ok: false, error: error?.message || String(error) });
    }
  });

  function isDisplayed(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  // The bridge is ready as soon as its event handlers are installed.
  // Do NOT wait for MoveItemToTrade here: inventory selection and search do
  // not require that function, and waiting for Steam to define it can add
  // several seconds to the beginning of an automated trade. The individual
  // move handler still verifies MoveItemToTrade when it is actually needed.
  ready();
})();
