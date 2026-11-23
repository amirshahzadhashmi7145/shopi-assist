/*
 * Shopi Assist storefront chat widget.
 *
 * Plain JavaScript with no dependencies, loaded with `defer` by the app embed
 * block. Everything renders inside a shadow root. Text from the assistant is
 * always inserted with textContent / DOM nodes, never as HTML.
 */
(function () {
  "use strict";

  var STORAGE_KEY = "shopi-assist:v1";
  var OPEN_KEY = "shopi-assist:open";
  var CONFIG_KEY = "shopi-assist:config";
  var MAX_STORED_MESSAGES = 40;
  var IDLE_RESET_MS = 24 * 60 * 60 * 1000;
  var REQUEST_TIMEOUT_MS = 60000;
  var MAX_MESSAGE_LENGTH = 2000;
  var MAX_ORDER_ITEMS = 10;
  var MAX_ITEM_QUANTITY = 10;
  var MAX_CARD_VARIANTS = 12;
  var MAX_SUMMARY_LINES = 12;

  // Icons are built with DOM calls (never innerHTML), like everything else here.
  var SVG_NS = "http://www.w3.org/2000/svg";
  var ICONS = {
    chat: {
      size: 26,
      filled: true,
      d: "M12 3C6.9 3 3 6.5 3 11c0 2 .8 3.8 2.2 5.2L4.3 20.4a.6.6 0 0 0 .8.7l4.3-1.7c.8.2 1.7.3 2.6.3 5.1 0 9-3.5 9-8.7S17.1 3 12 3z",
    },
    close: { size: 20, stroke: 2, d: "M6 6l12 12M18 6L6 18" },
    reset: { size: 18, stroke: 2, d: "M4 5v5h5M4.6 14a8 8 0 1 0 1.6-7.5L4 10" },
    send: { size: 18, stroke: 2.2, d: "M12 19V5M6 11l6-6 6 6" },
  };

  function icon(name) {
    var spec = ICONS[name];
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(spec.size));
    svg.setAttribute("height", String(spec.size));
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");

    var path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", spec.d);
    if (spec.filled) {
      path.setAttribute("fill", "currentColor");
    } else {
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", String(spec.stroke));
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
    }
    svg.appendChild(path);
    return svg;
  }

  /** Replaces a button's content with one icon. */
  function setIcon(button, name) {
    button.textContent = "";
    button.appendChild(icon(name));
  }

  // ---------------------------------------------------------------- helpers

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function randomId() {
    var bytes = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    }
    var out = "";
    for (var j = 0; j < bytes.length; j += 1) out += ("0" + bytes[j].toString(16)).slice(-2);
    return out;
  }

  function readJson(storage, key) {
    try {
      var raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  function writeJson(storage, key, value) {
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch (error) {
      // Storage can be blocked or full; the chat still works for this page view.
    }
  }

  /** Only http(s) links and same-site paths are ever turned into anchors. */
  function safeHref(raw) {
    var href = String(raw || "").trim();
    if (/^https?:\/\/[^\s]+$/i.test(href)) return href;
    if (/^\/(?!\/)[^\s]*$/.test(href)) return href;
    return null;
  }

  /** Picks black or white text for the merchant's accent color. */
  function readableOn(hex) {
    var match = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!match) return "#ffffff";
    var value = parseInt(match[1], 16);
    var channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map(function (c) {
      var s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    var luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    return luminance > 0.45 ? "#111111" : "#ffffff";
  }

  function formatMoney(money, locale) {
    if (!money || money.amount === undefined) return "";
    try {
      return new Intl.NumberFormat(locale || undefined, {
        style: "currency",
        currency: money.currencyCode,
      }).format(Number(money.amount));
    } catch (error) {
      return money.amount + " " + (money.currencyCode || "");
    }
  }

  /** Shopify's cart reports money in hundredths of the cart currency. */
  function fromCents(value) {
    var cents = Number(value);
    return value === null || value === undefined || !isFinite(cents) ? null : cents / 100;
  }

  /** Keeps only well-formed order lines, one per variant, within the limits. */
  function cleanOrderItems(items) {
    var byVariant = {};
    var order = [];
    (Array.isArray(items) ? items : []).forEach(function (item) {
      var id = item ? String(item.variantId) : "";
      if (!/^\d{1,20}$/.test(id)) return;
      var quantity = Math.max(1, Math.min(MAX_ITEM_QUANTITY, parseInt(item.quantity, 10) || 1));
      if (byVariant[id]) {
        byVariant[id].quantity = Math.max(byVariant[id].quantity, quantity);
        return;
      }
      if (order.length >= MAX_ORDER_ITEMS) return;
      byVariant[id] = { variantId: id, quantity: quantity };
      order.push(byVariant[id]);
    });
    return order;
  }

  /**
   * The versions of a product its card lets the shopper pick from. Empty when
   * there is nothing to choose between.
   */
  function cardVariants(card) {
    var seen = {};
    var choices = [];
    (Array.isArray(card.variants) ? card.variants : []).forEach(function (variant) {
      var id = variant ? String(variant.id) : "";
      if (!/^\d{1,20}$/.test(id) || seen[id] || typeof variant.title !== "string") return;
      if (choices.length >= MAX_CARD_VARIANTS) return;
      seen[id] = true;
      choices.push({
        id: id,
        title: variant.title.slice(0, 80),
        price: variant.price || null,
        available: variant.available === true,
      });
    });
    return choices.length > 1 ? choices : [];
  }

  /** The cart in the few words the assistant needs: what, and how many. */
  function cartSnapshot(cart) {
    var byVariant = {};
    var lines = [];
    cart.items.forEach(function (line) {
      var id = String(line.variant_id);
      var quantity = parseInt(line.quantity, 10) || 0;
      if (!/^\d{1,20}$/.test(id) || quantity < 1) return;
      if (byVariant[id]) {
        byVariant[id].quantity += quantity;
        return;
      }
      if (lines.length >= 20) return;
      byVariant[id] = {
        variantId: id,
        title: String(line.title || line.product_title || "Item").slice(0, 120),
        quantity: quantity,
      };
      lines.push(byVariant[id]);
    });
    return lines;
  }

  /** What the order summary shows, taken from the storefront cart as it is now. */
  function orderSummary(cart) {
    var lines = cart.items.slice(0, MAX_SUMMARY_LINES).map(function (line) {
      var amount = line.final_line_price !== undefined ? line.final_line_price : line.line_price;
      return {
        title: String(line.title || line.product_title || "Item").slice(0, 120),
        quantity: Math.max(1, parseInt(line.quantity, 10) || 1),
        total: fromCents(amount),
        // Identifies the cart line, so it can be removed from the summary.
        key: typeof line.key === "string" ? line.key.slice(0, 200) : "",
      };
    });
    return {
      role: "order",
      currency: typeof cart.currency === "string" ? cart.currency : "",
      lines: lines,
      more: Math.max(0, cart.items.length - lines.length),
      subtotal: fromCents(cart.total_price),
    };
  }

  var INLINE_PATTERN =
    /\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,!?;:'"])/g;

  /** Appends text with **bold** and [links](url) to `parent` as DOM nodes. */
  function appendInline(parent, text) {
    var cursor = 0;
    var match;
    INLINE_PATTERN.lastIndex = 0;
    while ((match = INLINE_PATTERN.exec(text)) !== null) {
      if (match.index > cursor) {
        parent.appendChild(document.createTextNode(text.slice(cursor, match.index)));
      }
      if (match[1] !== undefined) {
        parent.appendChild(el("strong", null, match[1]));
      } else {
        var label = match[2] !== undefined ? match[2] : match[4];
        var href = safeHref(match[2] !== undefined ? match[3] : match[4]);
        if (href) {
          var link = el("a", null, label);
          link.href = href;
          if (/^https?:/i.test(href) && href.indexOf(window.location.origin) !== 0) {
            link.target = "_blank";
            link.rel = "noopener noreferrer";
          }
          parent.appendChild(link);
        } else {
          parent.appendChild(document.createTextNode(label));
        }
      }
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length) {
      parent.appendChild(document.createTextNode(text.slice(cursor)));
    }
  }

  /** Renders the assistant's small Markdown subset: paragraphs, lists, bold, links. */
  function renderRichText(container, source) {
    var lines = String(source || "").replace(/\r\n?/g, "\n").split("\n");
    var paragraph = null;
    var list = null;

    lines.forEach(function (rawLine) {
      var line = rawLine.replace(/^\s*#{1,6}\s+(.*)$/, "**$1**");
      var bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
      var numbered = bullet ? null : /^\s*\d{1,3}[.)]\s+(.*)$/.exec(line);

      if (bullet || numbered) {
        var tag = numbered ? "ol" : "ul";
        paragraph = null;
        if (!list || list.tagName.toLowerCase() !== tag) {
          list = el(tag);
          container.appendChild(list);
        }
        var item = el("li");
        appendInline(item, (bullet || numbered)[1]);
        list.appendChild(item);
      } else if (!line.trim()) {
        paragraph = null;
        list = null;
      } else {
        list = null;
        if (!paragraph) {
          paragraph = el("p");
          container.appendChild(paragraph);
        } else {
          paragraph.appendChild(el("br"));
        }
        appendInline(paragraph, line.trim());
      }
    });
  }

  // ----------------------------------------------------------------- widget

  function Widget(host) {
    this.host = host;
    var data = host.dataset;
    this.config = {
      endpoint: data.endpoint || "/apps/shopi-assist/chat",
      stylesheet: data.stylesheet || "",
      title: data.title || "Shopping assistant",
      greeting: data.greeting || "Hi! How can I help?",
      accent: /^#[0-9a-f]{6}$/i.test(data.accent || "") ? data.accent : "#1F3D2F",
      position: data.position === "left" ? "left" : "right",
      suggestions: [data.suggestion1, data.suggestion2, data.suggestion3].filter(function (s) {
        return s && s.trim();
      }),
      country: data.country || "",
      locale: data.locale || document.documentElement.lang || "",
      cartUrl: data.cartUrl || "/cart",
      cartAddUrl: data.cartAddUrl || "/cart/add",
      checkoutUrl: "/checkout",
      orderEndpoint:
        data.orderEndpoint || (data.endpoint || "/apps/shopi-assist/chat").replace(/chat$/, "order"),
    };
    // True when the merchant takes pay-on-delivery orders in the chat.
    this.chatOrders = false;
    // True when product cards may start an order with "Buy now".
    this.buyNow = false;
    // False until the app's settings have arrived. A page that loaded while
    // the app was unreachable asks again once a reply shows it is back.
    this.remoteLoaded = false;
    // The open order form, if any. Its contents are never stored.
    this.orderForm = null;
    // True on a development store: the order form offers to fill in test details.
    this.testMode = false;
    this.pending = false;
    this.lastFailedMessage = null;
    // False only while the stylesheet is still loading.
    this.stylesReady = !this.config.stylesheet;
    // True when the merchant has paused chat in the app.
    this.pausedByShop = false;
    this.state = this.loadState();
  }

  Widget.prototype.loadState = function () {
    var stored = readJson(window.localStorage, STORAGE_KEY) || {};
    var state = {
      visitorId: /^[A-Za-z0-9_-]{8,64}$/.test(stored.visitorId || "") ? stored.visitorId : randomId(),
      conversationId: typeof stored.conversationId === "string" ? stored.conversationId : null,
      messages: Array.isArray(stored.messages) ? stored.messages : [],
      updatedAt: Number(stored.updatedAt) || 0,
    };
    // A stale conversation is confusing; start fresh after a day of silence.
    if (state.updatedAt && Date.now() - state.updatedAt > IDLE_RESET_MS) {
      state.conversationId = null;
      state.messages = [];
    }
    return state;
  };

  Widget.prototype.saveState = function () {
    this.state.updatedAt = Date.now();
    this.state.messages = this.state.messages.slice(-MAX_STORED_MESSAGES);
    writeJson(window.localStorage, STORAGE_KEY, this.state);
  };

  Widget.prototype.mount = function () {
    var self = this;
    var config = this.config;
    var root = this.host.attachShadow ? this.host.attachShadow({ mode: "open" }) : this.host;
    this.root = root;

    // The host element has no light-DOM children, so theme rules like Dawn's
    // `div:empty { display: none }` would hide it and everything in its shadow
    // root. Force it visible; the wrapper inside is position: fixed anyway.
    this.host.style.setProperty("display", "block", "important");

    var wrapper = el("div", "sa");
    wrapper.setAttribute("data-position", config.position);
    wrapper.style.setProperty("--sa-accent", config.accent);
    wrapper.style.setProperty("--sa-on-accent", readableOn(config.accent));
    this.wrapper = wrapper;

    // Hold the UI back until its stylesheet has loaded, so it never flashes unstyled.
    if (config.stylesheet) {
      wrapper.hidden = true;
      var link = el("link");
      link.rel = "stylesheet";
      link.href = config.stylesheet;
      var reveal = function () {
        self.stylesReady = true;
        wrapper.hidden = Boolean(self.pausedByShop);
      };
      link.addEventListener("load", reveal);
      link.addEventListener("error", reveal);
      root.appendChild(link);
    }

    // Launcher
    var launcher = el("button", "sa-launcher");
    launcher.type = "button";
    setIcon(launcher, "chat");
    launcher.setAttribute("aria-label", "Open chat: " + config.title);
    launcher.setAttribute("aria-expanded", "false");
    launcher.setAttribute("aria-controls", "sa-panel");
    launcher.addEventListener("click", function () {
      self.toggle();
    });
    this.launcher = launcher;

    // Panel
    var panel = el("section", "sa-panel");
    panel.id = "sa-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", config.title);
    panel.hidden = true;
    this.panel = panel;

    var header = el("header", "sa-header");
    this.titleEl = el("h2", "sa-title", config.title);
    header.appendChild(this.titleEl);
    var headerActions = el("div", "sa-header-actions");

    var reset = el("button", "sa-icon-button");
    reset.type = "button";
    setIcon(reset, "reset");
    reset.setAttribute("aria-label", "Start a new chat");
    reset.title = "Start a new chat";
    reset.addEventListener("click", function () {
      self.resetConversation();
    });

    var close = el("button", "sa-icon-button");
    close.type = "button";
    setIcon(close, "close");
    close.setAttribute("aria-label", "Close chat");
    close.addEventListener("click", function () {
      self.close();
    });

    headerActions.appendChild(reset);
    headerActions.appendChild(close);
    header.appendChild(headerActions);

    var messages = el("div", "sa-messages");
    messages.setAttribute("role", "log");
    messages.setAttribute("aria-live", "polite");
    messages.setAttribute("aria-label", "Chat messages");
    messages.tabIndex = 0;
    this.messagesEl = messages;

    var suggestions = el("div", "sa-suggestions");
    this.suggestionsEl = suggestions;

    var form = el("form", "sa-form");
    form.noValidate = true;
    var input = el("textarea", "sa-input");
    input.rows = 1;
    input.maxLength = MAX_MESSAGE_LENGTH;
    input.placeholder = "Ask a question…";
    input.setAttribute("aria-label", "Message");
    input.setAttribute("enterkeyhint", "send");
    this.input = input;

    var send = el("button", "sa-send");
    send.type = "submit";
    setIcon(send, "send");
    send.setAttribute("aria-label", "Send message");
    this.sendButton = send;

    form.appendChild(input);
    form.appendChild(send);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      self.submitInput();
    });
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        self.submitInput();
      }
    });
    input.addEventListener("input", function () {
      self.resizeInput();
    });

    var footnote = el("p", "sa-footnote", "AI assistant. Answers can contain mistakes.");

    panel.appendChild(header);
    panel.appendChild(messages);
    panel.appendChild(suggestions);
    panel.appendChild(form);
    panel.appendChild(footnote);
    panel.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        event.stopPropagation();
        self.close();
      }
    });

    wrapper.appendChild(panel);
    wrapper.appendChild(launcher);
    root.appendChild(wrapper);

    this.renderAll();
    this.loadRemoteConfig();

    // Keep the chat open across page loads on larger screens, so following a
    // product link does not close the conversation.
    var wasOpen = false;
    try {
      wasOpen = window.sessionStorage.getItem(OPEN_KEY) === "1";
    } catch (error) {
      wasOpen = false;
    }
    if (wasOpen && window.matchMedia && window.matchMedia("(min-width: 750px)").matches) {
      this.open({ focus: false });
    }
  };

  /**
   * Applies what the merchant set in the app: the assistant's name and
   * welcome message (which override the theme editor's when filled in) and
   * whether chat is paused. Values are plain text and only ever used as text.
   */
  Widget.prototype.applyRemoteConfig = function (remote) {
    if (!remote || remote.ok !== true) return;

    this.pausedByShop = remote.enabled === false;
    if (this.stylesReady) this.wrapper.hidden = this.pausedByShop;
    if (this.pausedByShop) return;

    var changed = false;
    this.testMode = remote.testMode === true;
    var buyNow = remote.buyNow === true;
    if (buyNow !== this.buyNow) {
      this.buyNow = buyNow;
      // Product cards already on screen gain or lose the button.
      changed = this.state.messages.some(function (message) {
        return message.cards && message.cards.length;
      });
    }
    var chatOrders = remote.chatOrders === true;
    if (chatOrders !== this.chatOrders) {
      this.chatOrders = chatOrders;
      // An order summary already on screen gains or loses its button.
      changed =
        changed ||
        this.state.messages.some(function (message) {
          return message.role === "order";
        });
    }
    if (typeof remote.title === "string" && remote.title.trim()) {
      var title = remote.title.trim().slice(0, 60);
      if (title !== this.config.title) {
        this.config.title = title;
        this.titleEl.textContent = title;
        this.panel.setAttribute("aria-label", title);
        if (!this.isOpen()) this.launcher.setAttribute("aria-label", "Open chat: " + title);
      }
    }
    if (typeof remote.greeting === "string" && remote.greeting.trim()) {
      var greeting = remote.greeting.trim().slice(0, 400);
      if (greeting !== this.config.greeting) {
        this.config.greeting = greeting;
        changed = true;
      }
    }
    // The greeting is the first bubble. Skip the redraw while a reply is on
    // its way; the new greeting shows on the next page instead.
    if (changed && !this.pending) this.renderAll();
  };

  /** Uses the cached settings at once, then refreshes them in the background. */
  Widget.prototype.loadRemoteConfig = function () {
    var self = this;
    var cached = null;
    try {
      cached = readJson(window.sessionStorage, CONFIG_KEY);
    } catch (error) {
      cached = null;
    }
    this.applyRemoteConfig(cached);

    window
      .fetch(this.config.endpoint, {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (remote) {
        if (!remote || remote.ok !== true) return;
        self.remoteLoaded = true;
        try {
          writeJson(window.sessionStorage, CONFIG_KEY, remote);
        } catch (error) {
          // Ignore: only costs one extra request on the next page.
        }
        self.applyRemoteConfig(remote);
      })
      .catch(function () {
        // Keep the theme editor's values; the chat still works.
      });
  };

  Widget.prototype.isOpen = function () {
    return !this.panel.hidden;
  };

  Widget.prototype.toggle = function () {
    if (this.isOpen()) this.close();
    else this.open({ focus: true });
  };

  Widget.prototype.open = function (options) {
    this.panel.hidden = false;
    this.wrapper.classList.add("sa-open");
    this.launcher.setAttribute("aria-expanded", "true");
    this.launcher.setAttribute("aria-label", "Close chat");
    setIcon(this.launcher, "close");
    try {
      window.sessionStorage.setItem(OPEN_KEY, "1");
    } catch (error) {
      // Ignore: only affects reopening on the next page.
    }
    this.scrollToEnd();
    if (!options || options.focus !== false) this.input.focus();
  };

  Widget.prototype.close = function () {
    this.panel.hidden = true;
    this.wrapper.classList.remove("sa-open");
    this.launcher.setAttribute("aria-expanded", "false");
    this.launcher.setAttribute("aria-label", "Open chat: " + this.config.title);
    setIcon(this.launcher, "chat");
    try {
      window.sessionStorage.removeItem(OPEN_KEY);
    } catch (error) {
      // Ignore.
    }
    this.launcher.focus();
  };

  Widget.prototype.resetConversation = function () {
    if (this.pending) return;
    this.state.conversationId = null;
    this.state.messages = [];
    this.lastFailedMessage = null;
    this.saveState();
    this.renderAll();
    this.input.focus();
  };

  Widget.prototype.resizeInput = function () {
    this.input.style.height = "auto";
    this.input.style.height = Math.min(this.input.scrollHeight, 112) + "px";
  };

  Widget.prototype.scrollToEnd = function () {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  };

  /**
   * Brings a new reply into view. A short reply ends up at the bottom as
   * usual; a reply taller than the window (text plus product cards) is
   * aligned to its first line so the shopper reads it from the start.
   */
  Widget.prototype.scrollToMessage = function (row) {
    var list = this.messagesEl;
    var bottom = list.scrollHeight - list.clientHeight;
    var top = row ? row.offsetTop - 12 : bottom;
    list.scrollTop = Math.max(0, Math.min(top, bottom));
  };

  // -------------------------------------------------------------- rendering

  Widget.prototype.renderAll = function () {
    var self = this;
    this.messagesEl.textContent = "";
    this.orderForm = null;
    this.appendBubble("assistant", this.config.greeting);
    this.state.messages.forEach(function (message) {
      self.renderMessage(message);
    });
    this.renderSuggestions();
    this.scrollToEnd();
  };

  Widget.prototype.renderSuggestions = function () {
    var self = this;
    this.suggestionsEl.textContent = "";
    var show = this.state.messages.length === 0 && !this.pending;
    this.suggestionsEl.hidden = !show || this.config.suggestions.length === 0;
    if (this.suggestionsEl.hidden) return;

    this.config.suggestions.forEach(function (text) {
      var chip = el("button", "sa-chip", text);
      chip.type = "button";
      chip.addEventListener("click", function () {
        self.send(text);
      });
      self.suggestionsEl.appendChild(chip);
    });
  };

  Widget.prototype.appendBubble = function (role, text) {
    var row = el("div", "sa-row sa-row-" + role);
    var bubble = el("div", "sa-bubble");
    if (role === "assistant") renderRichText(bubble, text);
    else bubble.textContent = text;
    row.appendChild(bubble);
    this.messagesEl.appendChild(row);
    return row;
  };

  Widget.prototype.renderMessage = function (message) {
    if (message.role === "notice") {
      return this.appendNotice(message.text, message.tone, message.link);
    }
    if (message.role === "order") return this.appendOrder(message);
    var row = this.appendBubble(message.role === "user" ? "user" : "assistant", message.text);
    if (message.cards && message.cards.length) this.appendCards(message.cards);
    return row;
  };

  Widget.prototype.appendNotice = function (text, tone, link) {
    var notice = el(
      "div",
      "sa-notice" +
        (tone === "error" ? " sa-notice-error" : tone === "success" ? " sa-notice-success" : ""),
    );
    notice.appendChild(el("span", null, text));
    if (link && safeHref(link.href)) {
      var anchor = el("a", null, link.label);
      anchor.href = safeHref(link.href);
      notice.appendChild(document.createTextNode(" "));
      notice.appendChild(anchor);
    }
    this.messagesEl.appendChild(notice);
    return notice;
  };

  /**
   * The order summary: what is in the cart, the subtotal and a link to the
   * store's own checkout. The widget never takes payment or delivery details.
   */
  Widget.prototype.appendOrder = function (entry) {
    var self = this;
    var lines = (Array.isArray(entry.lines) ? entry.lines : []).filter(function (line) {
      return line && typeof line.title === "string";
    });
    if (!lines.length) return null;

    var money = function (amount) {
      return typeof amount === "number"
        ? formatMoney({ amount: amount, currencyCode: entry.currency }, self.config.locale)
        : "";
    };

    var box = el("section", "sa-order");
    box.setAttribute("aria-label", "Order summary");
    box.appendChild(el("h3", "sa-order-title", "Your order"));

    // One change to the cart at a time: the summary is drawn again from the
    // cart once Shopify has answered.
    var busy = function () {
      var buttons = box.querySelectorAll("button");
      for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = true;
    };

    var list = el("ul", "sa-order-lines");
    lines.forEach(function (line) {
      var quantity = parseInt(line.quantity, 10) || 1;
      var item = el("li", "sa-order-line");
      // A line that cannot be changed from here just says how many.
      if (!line.key) item.appendChild(el("span", "sa-order-quantity", quantity + " ×"));
      item.appendChild(el("span", "sa-order-item", line.title));
      item.appendChild(el("span", "sa-order-amount", money(line.total)));
      if (line.key) {
        var edit = el("div", "sa-order-edit");
        var stepper = el("div", "sa-stepper sa-stepper-small");
        var less = el("button", "sa-stepper-button", "−");
        less.type = "button";
        less.setAttribute("aria-label", "One less: " + line.title);
        less.disabled = quantity <= 1;
        var count = el("span", "sa-stepper-count", String(quantity));
        count.setAttribute("aria-label", "Quantity of " + line.title);
        var more = el("button", "sa-stepper-button", "+");
        more.type = "button";
        more.setAttribute("aria-label", "One more: " + line.title);
        more.disabled = quantity >= MAX_ITEM_QUANTITY;
        less.addEventListener("click", function () {
          busy();
          self.setCartQuantity(line.key, quantity - 1);
        });
        more.addEventListener("click", function () {
          busy();
          self.setCartQuantity(line.key, quantity + 1);
        });
        stepper.appendChild(less);
        stepper.appendChild(count);
        stepper.appendChild(more);
        edit.appendChild(stepper);

        var remove = el("button", "sa-order-remove", "Remove");
        remove.type = "button";
        remove.setAttribute("aria-label", "Remove " + line.title);
        remove.addEventListener("click", function () {
          busy();
          self.removeFromCart(line.key);
        });
        edit.appendChild(remove);
        item.appendChild(edit);
      }
      list.appendChild(item);
    });
    box.appendChild(list);
    if (entry.more > 0) {
      box.appendChild(el("p", "sa-order-note", "Plus " + parseInt(entry.more, 10) + " more in your cart."));
    }

    var total = el("p", "sa-order-total");
    total.appendChild(el("span", null, "Subtotal"));
    total.appendChild(el("strong", null, money(entry.subtotal)));
    box.appendChild(total);

    if (this.chatOrders) {
      // The order is finished here in the chat. Paying by card is only
      // possible on the store's checkout page, so that stays a quiet link
      // that opens beside the chat instead of replacing it.
      box.appendChild(el("p", "sa-order-note", "Delivery and taxes are added in the next step."));
      var here = el(
        "button",
        "sa-card-button sa-card-button-primary sa-order-here",
        "Order here, pay on delivery",
      );
      here.type = "button";
      here.addEventListener("click", function () {
        self.openOrderForm();
      });
      box.appendChild(here);

      var online = el("p", "sa-order-note sa-order-online-note");
      var link = el("a", "sa-order-online", "Pay online at checkout instead");
      link.href = this.config.checkoutUrl;
      link.target = "_blank";
      link.rel = "noopener";
      online.appendChild(link);
      box.appendChild(online);
    } else {
      box.appendChild(el("p", "sa-order-note", "Shipping and taxes are added at checkout."));
      var actions = el("div", "sa-order-actions");
      var pay = el("a", "sa-card-button sa-card-button-primary sa-order-checkout", "Go to checkout");
      pay.href = this.config.checkoutUrl;
      actions.appendChild(pay);
      box.appendChild(actions);
    }

    this.messagesEl.appendChild(box);
    return box;
  };

  /** A − / count / + control for one quantity. `change` hears every new value. */
  function quantityStepper(name, change) {
    var box = el("div", "sa-stepper");
    var less = el("button", "sa-stepper-button", "−");
    less.type = "button";
    less.setAttribute("aria-label", "One less: " + name);
    var count = el("span", "sa-stepper-count", "0");
    count.setAttribute("aria-label", "Quantity of " + name);
    var more = el("button", "sa-stepper-button", "+");
    more.type = "button";
    more.setAttribute("aria-label", "One more: " + name);

    var value = 0;
    var set = function (quantity) {
      value = Math.max(0, Math.min(MAX_ITEM_QUANTITY, quantity));
      count.textContent = String(value);
      less.disabled = value === 0;
      more.disabled = value === MAX_ITEM_QUANTITY;
      box.classList.toggle("sa-stepper-on", value > 0);
      change(value);
    };
    less.addEventListener("click", function () {
      set(value - 1);
    });
    more.addEventListener("click", function () {
      set(value + 1);
    });

    box.appendChild(less);
    box.appendChild(count);
    box.appendChild(more);
    return { node: box, set: set };
  }

  /** "3 items · $44.85" for what has been picked, or `empty` when nothing has. */
  function pickedText(lines, empty, locale) {
    var count = 0;
    var sum = 0;
    var currency = null;
    var priced = true;
    lines.forEach(function (line) {
      count += line.quantity;
      if (line.price && (!currency || currency === line.price.currencyCode)) {
        currency = line.price.currencyCode;
        sum += line.quantity * Number(line.price.amount);
      } else {
        priced = false;
      }
    });
    if (!count) return empty;
    return (
      count +
      (count === 1 ? " item" : " items") +
      (priced && currency
        ? " · " + formatMoney({ amount: String(sum), currencyCode: currency }, locale)
        : "")
    );
  }

  /**
   * "Add to cart" and, where the store allows it, "Buy now", acting on
   * whatever `picked` returns when one of them is pressed.
   */
  Widget.prototype.buyButtons = function (picked) {
    var self = this;
    var add = el("button", "sa-card-button sa-card-button-primary", "Add to cart");
    add.type = "button";
    add.addEventListener("click", function () {
      var items = picked();
      if (!items.length) return;
      add.disabled = true;
      add.textContent = "Adding…";
      self
        .addItems(
          items.map(function (entry) {
            return { id: Number(entry.variantId), quantity: entry.quantity };
          }),
        )
        .then(function (result) {
          add.textContent = result.ok ? "Added" : "Add to cart";
          add.disabled = result.ok;
          if (result.ok) {
            window.setTimeout(function () {
              add.textContent = "Add to cart";
              add.disabled = picked().length === 0;
            }, 2500);
          } else {
            self.appendNotice(result.message, "error");
            self.scrollToEnd();
          }
        });
    });
    if (!self.buyNow) return [add];

    // The same as asking the assistant to order it: the items go in the
    // cart and the order summary appears.
    var buy = el("button", "sa-card-button", "Buy now");
    buy.type = "button";
    buy.addEventListener("click", function () {
      var items = picked().map(function (entry) {
        return { variantId: entry.variantId, quantity: entry.quantity };
      });
      if (!items.length) return;
      buy.disabled = true;
      var done = function () {
        buy.disabled = picked().length === 0;
      };
      self.runAction({ type: "order", items: items }).then(done, done);
    });
    return [add, buy];
  };

  Widget.prototype.appendCards = function (cards) {
    var self = this;
    var locale = this.config.locale;
    var list = el("ul", "sa-cards");
    list.setAttribute("aria-label", "Suggested products");

    var shown = cards.slice(0, 6).filter(function (card) {
      return card && typeof card.title === "string";
    });
    // A list of products shares one set of buttons, under the last card, for
    // everything picked across the cards. A product shown on its own keeps
    // the buttons on its card.
    var several = shown.length > 1;
    var pickers = [];
    var refreshAll = function () {};

    shown.forEach(function (card) {
      var item = el("li", "sa-card");
      var href = safeHref(card.url);

      if (card.imageUrl && safeHref(card.imageUrl)) {
        var image = el("img", "sa-card-image");
        image.src = safeHref(card.imageUrl);
        image.alt = card.imageAlt || "";
        image.loading = "lazy";
        image.width = 64;
        image.height = 64;
        item.appendChild(image);
      } else {
        item.appendChild(el("div", "sa-card-image sa-card-image-empty"));
      }

      var body = el("div", "sa-card-body");
      var title = href ? el("a", "sa-card-title", card.title) : el("span", "sa-card-title", card.title);
      if (href) title.href = href;
      body.appendChild(title);

      // The versions to pick between, each with its own quantity. A product
      // that comes in one version has just that one to buy.
      var choices = card.available ? cardVariants(card) : [];
      var single =
        !choices.length && card.available && /^\d+$/.test(String(card.variantId))
          ? String(card.variantId)
          : null;
      var options = single
        ? [{ id: single, title: card.title, price: card.price || null, available: true }]
        : choices;
      var quantities = {};
      // On its own card, a product with one version is bought one at a time.
      if (single && !several) quantities[single] = 1;
      /** Every version the shopper gave a quantity. */
      var lines = function () {
        return options
          .filter(function (option) {
            return quantities[option.id] > 0;
          })
          .map(function (option) {
            return { variantId: option.id, quantity: quantities[option.id], price: option.price };
          });
      };
      if (options.length) pickers.push(lines);
      var pricesDiffer = choices.some(function (choice) {
        return !choice.price || !choices[0].price || choice.price.amount !== choices[0].price.amount;
      });

      var price = el("div", "sa-card-price");
      price.appendChild(el("span", null, (pricesDiffer ? "From " : "") + formatMoney(card.price, locale)));
      if (card.compareAtPrice) {
        var was = el("s", null, formatMoney(card.compareAtPrice, locale));
        was.setAttribute("aria-label", "Was " + was.textContent);
        price.appendChild(was);
      }
      if (!card.available) price.appendChild(el("span", "sa-card-soldout", "Sold out"));
      body.appendChild(price);

      var actions = el("div", "sa-card-actions");
      var ownButtons = [];
      if (!options.length) {
        // Too many versions for a card: they are chosen on the product page.
        if (href && card.available) {
          var choose = el("a", "sa-card-button", "Choose options");
          choose.href = href;
          actions.appendChild(choose);
        }
      } else if (!several) {
        ownButtons = self.buyButtons(lines);
        ownButtons.forEach(function (button) {
          actions.appendChild(button);
        });
      }

      var total = null;
      var refresh = function () {
        var picked = lines();
        ownButtons.forEach(function (button) {
          button.disabled = picked.length === 0;
        });
        if (total) total.textContent = pickedText(picked, "Set how many you want of each.", locale);
        item.classList.toggle("sa-card-on", several && picked.length > 0);
        refreshAll();
      };

      // The picker takes the card's full width, under the picture and title.
      var picker = null;
      if (choices.length) {
        picker = el("div", "sa-card-pick");
        var rows = el("ol", "sa-card-variants");
        rows.setAttribute("aria-label", "Options for " + card.title);
        if (!several) {
          total = el("div", "sa-card-total");
          total.setAttribute("role", "status");
        }

        choices.forEach(function (choice, index) {
          var row = el("li", "sa-variant");
          var label = el("span", "sa-variant-name");
          label.appendChild(el("span", "sa-variant-number", index + 1 + "."));
          label.appendChild(el("span", null, choice.title));
          row.appendChild(label);

          if (!choice.available) {
            row.classList.add("sa-variant-off");
            row.appendChild(el("span", "sa-variant-note", "Sold out"));
            rows.appendChild(row);
            return;
          }
          // One price for every version is on the card already.
          if (pricesDiffer && choice.price) {
            row.appendChild(el("span", "sa-variant-note", formatMoney(choice.price, locale)));
          }

          var control = quantityStepper(choice.title, function (value) {
            quantities[choice.id] = value;
            row.classList.toggle("sa-variant-on", value > 0);
            refresh();
          });
          choice.set = control.set;
          row.appendChild(control.node);
          rows.appendChild(row);
        });

        // On its own card, one version left in stock is nothing to choose:
        // start it at one. Otherwise everything starts at none.
        var inStock = choices.filter(function (choice) {
          return choice.available;
        });
        inStock.forEach(function (choice) {
          choice.set(!several && inStock.length === 1 ? 1 : 0);
        });
        refresh();

        picker.appendChild(rows);
        if (total) picker.appendChild(total);
        item.classList.add("sa-card-choices");
      }

      var view = null;
      if (href) {
        view = el("a", "sa-card-button", "View");
        view.href = href;
        view.setAttribute("aria-label", "View " + card.title);
      }
      if (several && options.length) {
        var bar = el("div", "sa-card-actions");
        if (picker) {
          // In a list of products the picker stays folded away until it is
          // asked for, so the list stays short enough to scan.
          var unfold = el(
            "button",
            "sa-card-button sa-card-button-primary",
            "Choose from " + choices.length + " options",
          );
          unfold.type = "button";
          unfold.addEventListener("click", function () {
            picker.hidden = false;
            bar.removeChild(unfold);
            var first = picker.querySelector("button:not([disabled])");
            if (first) first.focus();
          });
          bar.appendChild(unfold);
          picker.hidden = true;
        } else {
          var only = quantityStepper(card.title, function (value) {
            quantities[single] = value;
            refresh();
          });
          only.set(0);
          bar.appendChild(only.node);
        }
        if (view) bar.appendChild(view);
        body.appendChild(bar);
      } else {
        if (view) actions.appendChild(view);
        (picker || body).appendChild(actions);
      }

      item.appendChild(body);
      if (picker) item.appendChild(picker);
      list.appendChild(item);
    });

    if (!list.children.length) return;
    this.messagesEl.appendChild(list);
    if (!several || !pickers.length) return;

    // One place to add or buy everything picked on the cards above.
    var everything = function () {
      return pickers.reduce(function (found, lines) {
        return found.concat(lines());
      }, []);
    };
    var basket = el("div", "sa-cards-bar");
    var sum = el("div", "sa-card-total");
    sum.setAttribute("role", "status");
    var both = el("div", "sa-card-actions");
    var buttons = self.buyButtons(everything);
    buttons.forEach(function (button) {
      both.appendChild(button);
    });
    refreshAll = function () {
      var picked = everything();
      sum.textContent = pickedText(picked, "Set how many you want of each product above.", locale);
      buttons.forEach(function (button) {
        button.disabled = picked.length === 0;
      });
    };
    refreshAll();
    basket.appendChild(sum);
    basket.appendChild(both);
    this.messagesEl.appendChild(basket);
  };

  Widget.prototype.showTyping = function () {
    var row = el("div", "sa-row sa-row-assistant sa-typing-row");
    var bubble = el("div", "sa-bubble sa-typing");
    bubble.setAttribute("role", "status");
    bubble.setAttribute("aria-label", "Assistant is typing");
    for (var i = 0; i < 3; i += 1) bubble.appendChild(el("span", "sa-dot"));
    row.appendChild(bubble);
    this.messagesEl.appendChild(row);
    this.typingEl = row;
    this.scrollToEnd();
  };

  Widget.prototype.hideTyping = function () {
    if (this.typingEl && this.typingEl.parentNode) {
      this.typingEl.parentNode.removeChild(this.typingEl);
    }
    this.typingEl = null;
  };

  Widget.prototype.setPending = function (pending) {
    this.pending = pending;
    this.sendButton.disabled = pending;
    this.wrapper.classList.toggle("sa-pending", pending);
  };

  // ------------------------------------------------------------- messaging

  Widget.prototype.submitInput = function () {
    var text = this.input.value.trim();
    if (!text || this.pending) return;
    this.input.value = "";
    this.resizeInput();
    this.send(text);
  };

  Widget.prototype.send = function (text) {
    if (this.pending) return Promise.resolve();

    this.lastFailedMessage = null;
    this.removeRetry();
    this.state.messages.push({ role: "user", text: text });
    this.saveState();
    this.appendBubble("user", text);
    this.renderSuggestions();
    return this.request(text);
  };

  Widget.prototype.request = function (text) {
    var self = this;
    this.setPending(true);
    this.renderSuggestions();
    this.showTyping();

    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = window.setTimeout(function () {
      if (controller) controller.abort();
    }, REQUEST_TIMEOUT_MS);

    // The assistant is told what is in the cart, so it can answer questions
    // about it and warn when an order will include items already there.
    return this.fetchCart()
      .then(function (cart) {
        var payload = {
          message: text,
          visitorId: self.state.visitorId,
          conversationId: self.state.conversationId,
          country: self.config.country,
          language: (self.config.locale || "").slice(0, 2),
        };
        if (cart) payload.cart = cartSnapshot(cart);
        return window.fetch(self.config.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          credentials: "same-origin",
          signal: controller ? controller.signal : undefined,
          body: JSON.stringify(payload),
        });
      })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return null;
          })
          .then(function (body) {
            return { ok: response.ok, body: body };
          });
      })
      .then(function (result) {
        window.clearTimeout(timer);
        self.hideTyping();
        self.setPending(false);

        if (!result.ok || !result.body || typeof result.body.reply !== "string") {
          var message =
            result.body && result.body.error && typeof result.body.error.message === "string"
              ? result.body.error.message
              : "Sorry, something went wrong. Please try again.";
          self.fail(text, message);
          return;
        }

        var body = result.body;
        if (typeof body.conversationId === "string") self.state.conversationId = body.conversationId;
        var cards = Array.isArray(body.cards) ? body.cards : [];
        var entry = { role: "assistant", text: body.reply, cards: cards };
        self.state.messages.push(entry);
        self.saveState();
        self.scrollToMessage(self.renderMessage(entry));

        // A failed action reports itself in the chat. It must never look like
        // the reply failed, so nothing here reaches the handler below.
        self.runActions(Array.isArray(body.actions) ? body.actions : []).catch(function () {});
        if (!self.remoteLoaded) self.loadRemoteConfig();
      })
      .catch(function () {
        window.clearTimeout(timer);
        self.hideTyping();
        self.setPending(false);
        self.fail(text, "Couldn't reach the assistant. Check your connection and try again.");
      });
  };

  /** Shows an error with a retry button. The failed message stays visible. */
  Widget.prototype.fail = function (text, message) {
    var self = this;
    this.lastFailedMessage = text;
    var notice = this.appendNotice(message, "error");
    notice.classList.add("sa-retry-notice");
    var retry = el("button", "sa-retry", "Try again");
    retry.type = "button";
    retry.addEventListener("click", function () {
      if (self.pending || !self.lastFailedMessage) return;
      var again = self.lastFailedMessage;
      self.lastFailedMessage = null;
      self.removeRetry();
      self.request(again);
    });
    notice.appendChild(retry);
    this.scrollToEnd();
  };

  Widget.prototype.removeRetry = function () {
    var notices = this.messagesEl.querySelectorAll(".sa-retry-notice");
    for (var i = 0; i < notices.length; i += 1) {
      notices[i].parentNode.removeChild(notices[i]);
    }
  };

  // ------------------------------------------------------------------ cart

  /**
   * Runs the assistant's actions one after another, so the order summary
   * reads the cart only after every item before it has been added.
   */
  Widget.prototype.runActions = function (actions) {
    var self = this;
    return actions.reduce(function (chain, action) {
      return chain.then(function () {
        return self.runAction(action);
      });
    }, Promise.resolve());
  };

  /** Stores a non-chat entry (notice or order summary) and shows it. */
  Widget.prototype.pushEntry = function (entry) {
    this.state.messages.push(entry);
    this.saveState();
    this.renderMessage(entry);
    this.scrollToEnd();
  };

  Widget.prototype.runAction = function (action) {
    var self = this;
    if (!action) return Promise.resolve();
    if (action.type === "checkout") return this.showOrderSummary();

    if (action.type === "order") {
      var items = cleanOrderItems(action.items);
      if (!items.length) return Promise.resolve();
      // "Only these items": empty the cart first, then put in exactly these.
      var filled =
        action.replace === true
          ? this.clearCart().then(function (cleared) {
              if (!cleared) return { ok: false, message: "Your cart couldn't be updated. Please try again." };
              return self.addItems(
                items.map(function (item) {
                  return { id: Number(item.variantId), quantity: item.quantity };
                }),
              );
            })
          : this.ensureInCart(items);
      return filled.then(function (result) {
        if (!result.ok) {
          self.pushEntry({ role: "notice", tone: "error", text: result.message });
          return null;
        }
        return self.showOrderSummary();
      });
    }

    if (action.type === "order_action") {
      this.showOrderAction(action);
      return Promise.resolve();
    }

    if (action.type === "clear_cart") {
      return this.clearCart().then(function (cleared) {
        self.pushEntry(
          cleared
            ? { role: "notice", text: "Your cart is empty now." }
            : { role: "notice", tone: "error", text: "Your cart couldn't be emptied. Please try again." },
        );
        if (cleared) self.dropOrderSummary();
      });
    }

    if (action.type === "remove_from_cart") {
      if (!/^\d+$/.test(String(action.variantId))) return Promise.resolve();
      return this.removeVariant(String(action.variantId)).then(function (removed) {
        self.pushEntry(
          removed
            ? { role: "notice", text: "Removed from your cart." }
            : { role: "notice", tone: "error", text: "That item isn't in your cart." },
        );
        // A summary on screen would now be wrong: show the cart as it is.
        if (removed && self.messagesEl.querySelector(".sa-order:not(.sa-order-form)")) {
          return self.showOrderSummary();
        }
        return null;
      });
    }

    if (action.type !== "add_to_cart") return Promise.resolve();
    if (!/^\d+$/.test(String(action.variantId))) return Promise.resolve();
    var quantity = Math.max(1, Math.min(MAX_ITEM_QUANTITY, parseInt(action.quantity, 10) || 1));

    return this.addToCart(action.variantId, quantity).then(function (result) {
      self.pushEntry(
        result.ok
          ? {
              role: "notice",
              text: "Added to your cart.",
              link: { label: "View cart", href: self.config.cartUrl },
            }
          : { role: "notice", tone: "error", text: result.message },
      );
    });
  };

  /** Reads the storefront cart. Resolves with null when it cannot be read. */
  Widget.prototype.fetchCart = function () {
    return window
      .fetch(this.config.cartUrl + ".js", {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (cart) {
        return cart && Array.isArray(cart.items) ? cart : null;
      })
      .catch(function () {
        return null;
      });
  };

  /**
   * Makes sure the cart holds at least the quantity asked for of each item.
   * Only what is missing is added, so an order that is repeated, or that
   * names something the shopper already added, never doubles up.
   */
  Widget.prototype.ensureInCart = function (items) {
    var self = this;
    return this.fetchCart().then(function (cart) {
      var inCart = {};
      (cart ? cart.items : []).forEach(function (line) {
        var id = String(line.variant_id);
        inCart[id] = (inCart[id] || 0) + (parseInt(line.quantity, 10) || 0);
      });

      var missing = [];
      items.forEach(function (item) {
        var needed = item.quantity - (inCart[item.variantId] || 0);
        if (needed > 0) missing.push({ id: Number(item.variantId), quantity: needed });
      });
      return missing.length ? self.addItems(missing) : { ok: true };
    });
  };

  /** Shows what is in the cart with a checkout button, or says it is empty. */
  Widget.prototype.showOrderSummary = function () {
    var self = this;
    return this.fetchCart().then(function (cart) {
      if (!cart) {
        // The cart could not be read. The checkout link itself still works.
        self.pushEntry({
          role: "notice",
          text: "Ready when you are.",
          link: { label: "Go to checkout", href: self.config.checkoutUrl },
        });
        return;
      }
      // One summary at a time: an older one would show a cart that has changed.
      self.dropOrderSummary();

      if (!cart.items.length) {
        self.pushEntry({
          role: "notice",
          text: "Your cart is empty. Tell me what you'd like to order.",
        });
        return;
      }
      self.pushEntry(orderSummary(cart));
    });
  };

  /**
   * Takes the order summary, and any order form opened from it, off the
   * screen and out of the saved chat. Both describe a cart that has changed.
   */
  Widget.prototype.dropOrderSummary = function () {
    this.closeOrderForm();
    this.state.messages = this.state.messages.filter(function (message) {
      return message.role !== "order";
    });
    this.saveState();
    var stale = this.messagesEl.querySelectorAll(".sa-order");
    for (var i = 0; i < stale.length; i += 1) stale[i].parentNode.removeChild(stale[i]);
  };

  /**
   * Sets one cart line's quantity; none given takes the line out. Resolves
   * true when Shopify agreed.
   */
  Widget.prototype.changeCartLine = function (key, quantity) {
    return window
      .fetch(this.config.cartUrl + "/change.js", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ id: key, quantity: quantity > 0 ? quantity : 0 }),
      })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (cart) {
        if (cart) {
          document.dispatchEvent(new CustomEvent("shopi-assist:cart-updated", { detail: cart }));
        }
        return Boolean(cart);
      })
      .catch(function () {
        return false;
      });
  };

  /** Takes one line out of the storefront cart, then shows the summary again. */
  Widget.prototype.removeFromCart = function (key) {
    var self = this;
    // The summary is read from the cart again, so it shows the truth either way.
    return this.changeCartLine(key).then(function () {
      return self.showOrderSummary();
    });
  };

  /** Changes how many of one line the cart holds, then shows the summary again. */
  Widget.prototype.setCartQuantity = function (key, quantity) {
    var self = this;
    return this.changeCartLine(key, quantity).then(function (changed) {
      return self.showOrderSummary().then(function () {
        // Shopify says no when, for one, there is not that much in stock.
        if (!changed) {
          self.pushEntry({
            role: "notice",
            tone: "error",
            text: "That quantity couldn't be set. Your order is as shown above.",
          });
        }
      });
    });
  };

  /** Takes every line with this variant out of the cart. Resolves false when there is none. */
  Widget.prototype.removeVariant = function (variantId) {
    var self = this;
    return this.fetchCart().then(function (cart) {
      var keys = (cart ? cart.items : [])
        .filter(function (line) {
          return String(line.variant_id) === variantId && typeof line.key === "string";
        })
        .map(function (line) {
          return line.key;
        });
      // One after another: each change gives the remaining lines new positions.
      return keys.reduce(function (chain, key) {
        return chain.then(function (removed) {
          return self.changeCartLine(key).then(function (ok) {
            return removed || ok;
          });
        });
      }, Promise.resolve(false));
    });
  };

  /** Adds one variant to the storefront cart. */
  Widget.prototype.addToCart = function (variantId, quantity) {
    return this.addItems([{ id: Number(variantId), quantity: quantity }]);
  };

  /** Adds items to the storefront cart through Shopify's Ajax Cart API. */
  Widget.prototype.addItems = function (items) {
    return window
      .fetch(this.config.cartAddUrl + ".js", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ items: items }),
      })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return null;
          })
          .then(function (body) {
            if (response.ok) {
              // Lets themes that listen for cart changes refresh their cart icon.
              document.dispatchEvent(new CustomEvent("shopi-assist:cart-updated", { detail: body }));
              return { ok: true };
            }
            return {
              ok: false,
              message:
                (body && (body.description || body.message)) ||
                "That item couldn't be added to your cart.",
            };
          });
      })
      .catch(function () {
        return { ok: false, message: "That item couldn't be added to your cart." };
      });
  };

  // ------------------------------------------------- pay-on-delivery orders

  // The same fields, in the same order and under the same headings, as
  // Shopify's own checkout. `half` fields sit two to a row, as they do there.
  var ORDER_FIELDS = [
    { name: "email", label: "Email (optional, for order updates)", autocomplete: "email", type: "email" },
    { name: "countryCode", label: "Country/Region", autocomplete: "country", kind: "country" },
    { name: "firstName", label: "First name (optional)", autocomplete: "given-name", half: true },
    { name: "lastName", label: "Last name", autocomplete: "family-name", required: true, half: true },
    { name: "address1", label: "Address", autocomplete: "address-line1", required: true },
    { name: "address2", label: "Apartment, suite, etc. (optional)", autocomplete: "address-line2" },
    { name: "city", label: "City", autocomplete: "address-level2", required: true },
    // A list where Shopify knows the country's states, free text elsewhere.
    { name: "province", label: "State / province", autocomplete: "address-level1", kind: "province", half: true },
    { name: "zip", label: "Postal code", autocomplete: "postal-code", half: true },
    { name: "phone", label: "Phone", autocomplete: "tel", type: "tel", required: true },
  ];
  // What the checkout calls a state and a postal code in some countries.
  var PROVINCE_LABELS = { US: "State", IN: "State", AU: "State/territory", CA: "Province", AE: "Emirate" };
  var ZIP_LABELS = { US: "ZIP code", IN: "PIN code", GB: "Postcode", AU: "Postcode" };
  var USE_CHECKOUT = " Please use the checkout instead.";

  // Made-up people at real, well-known addresses, offered only on development
  // stores. The phone numbers are from ranges reserved for fiction.
  var TEST_DETAILS = {
    US: { address1: "742 Evergreen Terrace", city: "Springfield", province: "IL", provinceName: "Illinois", zip: "62704", phone: "+1 202 555 0143" },
    CA: { address1: "151 O'Connor Street", city: "Ottawa", province: "ON", provinceName: "Ontario", zip: "K2P 2L8", phone: "+1 613 555 0143" },
    GB: { address1: "221B Baker Street", city: "London", province: "", provinceName: "England", zip: "NW1 6XE", phone: "+44 20 7946 0143" },
    AU: { address1: "42 Wallaby Way", city: "Sydney", province: "NSW", provinceName: "New South Wales", zip: "2000", phone: "+61 2 5550 0143" },
    PK: { address1: "12 Mall Road", city: "Lahore", province: "Punjab", provinceName: "Punjab", zip: "54000", phone: "+92 300 5550143" },
    IN: { address1: "12 MG Road", city: "Bengaluru", province: "KA", provinceName: "Karnataka", zip: "560001", phone: "+91 80 5550 0143" },
    AE: { address1: "12 Sheikh Zayed Road", city: "Dubai", province: "DU", provinceName: "Dubai", zip: "", phone: "+971 4 555 0143" },
  };

  /** "Côte d'Ivoire" and "cote divoire" are the same country. */
  function regionKey(name) {
    var text = String(name || "").toLowerCase();
    if (text.normalize) text = text.normalize("NFD").replace(/[̀-ͯ]/g, "");
    return text.replace(/[^a-z0-9]/g, "");
  }

  /**
   * The states or provinces of each country the store ships to. They come
   * from the list Shopify renders for theme address forms, which the Liquid
   * block puts on the page in a hidden <select>. That list is keyed by
   * country name, so it is indexed here by every name it gives. Empty when
   * the list is not on the page; the form then asks for the state as text.
   */
  function readRegions() {
    var regions = {};
    var source = document.getElementById("shopi-assist-regions");
    var options = source ? source.querySelectorAll("option") : [];
    for (var i = 0; i < options.length; i += 1) {
      var pairs = [];
      try {
        pairs = JSON.parse(options[i].getAttribute("data-provinces") || "[]");
      } catch (error) {
        pairs = [];
      }
      var list = (Array.isArray(pairs) ? pairs : [])
        .filter(function (pair) {
          return Array.isArray(pair) && typeof pair[0] === "string" && pair[0];
        })
        .slice(0, 300)
        .map(function (pair) {
          return { value: pair[0].slice(0, 60), label: String(pair[1] || pair[0]).slice(0, 60) };
        });
      if (!list.length) continue;
      regions[regionKey(options[i].value)] = list;
      regions[regionKey(options[i].textContent)] = list;
    }
    return regions;
  }

  /** The states of one country, or none when it has none or they are unknown. */
  function provincesOf(regions, country) {
    if (!country) return [];
    var names = [country.code, country.name];
    try {
      names.push(new Intl.DisplayNames(["en"], { type: "region" }).of(country.code));
    } catch (error) {
      // Older browsers: the names above are tried on their own.
    }
    for (var i = 0; i < names.length; i += 1) {
      var found = regions[regionKey(names[i])];
      if (found) return found;
    }
    return [];
  }

  /** Sends one step of an order to the app. Never rejects. */
  Widget.prototype.postOrder = function (payload) {
    return window
      .fetch(this.config.orderEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return null;
          })
          .then(function (body) {
            return { ok: response.ok && body && body.ok === true, body: body || {} };
          });
      })
      .catch(function () {
        return { ok: false, body: {} };
      });
  };

  /** The countries the store sells to, for the form's country list. */
  Widget.prototype.loadCountries = function () {
    var fallback = /^[A-Za-z]{2}$/.test(this.config.country)
      ? [{ code: this.config.country.toUpperCase(), name: this.config.country.toUpperCase() }]
      : [];
    var url =
      this.config.orderEndpoint + "?language=" + encodeURIComponent((this.config.locale || "").slice(0, 2));
    return window
      .fetch(url, { method: "GET", headers: { Accept: "application/json" }, credentials: "same-origin" })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (body) {
        var countries = (body && Array.isArray(body.countries) ? body.countries : []).filter(
          function (country) {
            return country && /^[A-Z]{2}$/.test(country.code) && typeof country.name === "string";
          },
        );
        return countries.length ? countries : fallback;
      })
      .catch(function () {
        return fallback;
      });
  };

  /** Opens the delivery details form under the chat, once. */
  Widget.prototype.openOrderForm = function () {
    var self = this;
    // A form for something else (a new address) makes way for this one.
    if (this.orderForm && this.orderForm.mode) this.closeOrderForm();
    if (this.orderForm) {
      var first = this.orderForm.el.querySelector("input, button");
      if (first) first.focus();
      return Promise.resolve();
    }

    var form = el("form", "sa-order sa-order-form");
    form.noValidate = true;
    form.setAttribute("aria-label", "Order and pay on delivery");
    var state = {
      el: form,
      values: {},
      inputs: {},
      errors: {},
      items: null,
      quote: null,
      key: randomId(),
      busy: false,
      regions: readRegions(),
    };
    this.orderForm = state;
    this.messagesEl.appendChild(form);

    return this.loadCountries().then(function (countries) {
      if (self.orderForm !== state) return;
      state.countries = countries;
      state.values.countryCode = (
        countries.filter(function (country) {
          return country.code === (self.config.country || "").toUpperCase();
        })[0] ||
        countries[0] || { code: "" }
      ).code;
      self.renderOrderDetails();
    });
  };

  Widget.prototype.closeOrderForm = function () {
    var state = this.orderForm;
    this.orderForm = null;
    if (state && state.el.parentNode) state.el.parentNode.removeChild(state.el);
  };

  /** Shows a message at the foot of the form; errors are announced. */
  Widget.prototype.setOrderStatus = function (text, isError) {
    var status = this.orderForm && this.orderForm.statusEl;
    if (!status) return;
    status.textContent = text || "";
    status.hidden = !text;
    status.className = "sa-order-status" + (isError ? " sa-order-status-error" : "");
    if (isError) status.setAttribute("role", "alert");
    else status.removeAttribute("role");
  };

  Widget.prototype.setOrderBusy = function (busy) {
    var state = this.orderForm;
    if (!state) return;
    state.busy = busy;
    var controls = state.el.querySelectorAll("button, input, select");
    for (var i = 0; i < controls.length; i += 1) controls[i].disabled = busy;
  };

  /** Step 1: who the order is for and where it goes. */
  Widget.prototype.renderOrderDetails = function () {
    var self = this;
    var state = this.orderForm;
    var form = state.el;
    form.textContent = "";
    state.inputs = {};
    var forAddress = state.mode === "address";
    var deliveryTitle = forAddress ? "New delivery address" : "Delivery";

    if (!state.countries.length) {
      form.appendChild(el("h3", "sa-order-title", deliveryTitle));
      form.appendChild(
        el("p", "sa-order-status sa-order-status-error", "Ordering here isn't available right now." + USE_CHECKOUT),
      );
      return;
    }

    var country =
      state.countries.filter(function (entry) {
        return entry.code === state.values.countryCode;
      })[0] || state.countries[0];
    state.values.countryCode = country.code;
    var provinces = provincesOf(state.regions, country);

    /** Keeps what has been typed, so the form can be drawn again. */
    var keepValues = function () {
      Object.keys(state.inputs).forEach(function (name) {
        state.values[name] = state.inputs[name].value.trim();
      });
    };

    if (this.testMode) {
      var fillTest = el("button", "sa-order-test", "Fill test details");
      fillTest.type = "button";
      fillTest.title = "Shown on development stores only";
      fillTest.addEventListener("click", function () {
        keepValues();
        var sample = TEST_DETAILS[state.values.countryCode] || {
          address1: "1 Test Street",
          city: "Test City",
          province: "",
          provinceName: "",
          zip: "",
          phone: "+1 202 555 0143",
        };
        // In a list of states the sample's state is picked by name.
        var listed = provincesOf(
          state.regions,
          state.countries.filter(function (entry) {
            return entry.code === state.values.countryCode;
          })[0],
        ).filter(function (province) {
          return regionKey(province.label) === regionKey(sample.provinceName);
        })[0];
        state.values = {
          countryCode: state.values.countryCode,
          email: "test.buyer@example.com",
          firstName: "Test",
          lastName: "Buyer",
          phone: sample.phone,
          address1: sample.address1,
          address2: "",
          city: sample.city,
          province: listed ? listed.value : sample.province,
          zip: sample.zip,
        };
        state.errors = {};
        self.renderOrderDetails();
      });
      form.appendChild(fillTest);
    }

    // Each part of the form has a heading and its fields in a two-column grid.
    var fields = null;
    var section = function (title) {
      form.appendChild(el("h3", "sa-order-title", title));
      fields = el("div", "sa-fields");
      form.appendChild(fields);
    };

    var addField = function (spec, control) {
      var wrap = el("div", spec.half ? "sa-field sa-field-half" : "sa-field");
      var id = "sa-order-" + spec.name;
      var label = el("label", null, spec.label);
      label.htmlFor = id;
      control.id = id;
      control.name = spec.name;
      if (spec.autocomplete) control.autocomplete = spec.autocomplete;
      if (spec.required) control.required = true;
      wrap.appendChild(label);
      wrap.appendChild(control);
      var message = state.errors[spec.name];
      if (message) {
        var error = el("p", "sa-field-error", message);
        error.id = id + "-error";
        control.setAttribute("aria-invalid", "true");
        control.setAttribute("aria-describedby", error.id);
        wrap.appendChild(error);
      }
      state.inputs[spec.name] = control;
      fields.appendChild(wrap);
      return wrap;
    };

    ORDER_FIELDS.forEach(function (spec) {
      if (spec.name === "email") {
        // A new address for an existing order: the store already has the email.
        if (forAddress) return;
        section("Contact");
      }
      if (spec.kind === "country") section(deliveryTitle);
      if (spec.name === "province" || spec.name === "zip") {
        var named = (spec.name === "zip" ? ZIP_LABELS : PROVINCE_LABELS)[country.code];
        if (named) {
          spec = { name: spec.name, label: named, autocomplete: spec.autocomplete, kind: spec.kind, half: true };
        }
      }
      if (spec.kind === "country") {
        var countries = el("select");
        state.countries.forEach(function (entry) {
          var option = el("option", null, entry.name);
          option.value = entry.code;
          option.selected = entry.code === country.code;
          countries.appendChild(option);
        });
        // Another country has other states: draw the form again for it.
        countries.addEventListener("change", function () {
          keepValues();
          state.values.province = "";
          delete state.errors.province;
          self.renderOrderDetails();
          state.inputs.countryCode.focus();
        });
        // One country to deliver to needs no choice.
        addField(spec, countries).hidden = state.countries.length === 1;
        return;
      }

      if (spec.kind === "province" && provinces.length) {
        var states = el("select");
        var prompt = el("option", null, "Select…");
        prompt.value = "";
        states.appendChild(prompt);
        var chosen = regionKey(state.values.province);
        provinces.forEach(function (province) {
          var option = el("option", null, province.label);
          option.value = province.value;
          option.selected =
            Boolean(chosen) &&
            (regionKey(province.value) === chosen || regionKey(province.label) === chosen);
          states.appendChild(option);
        });
        addField(
          { name: spec.name, label: spec.label, autocomplete: spec.autocomplete, required: true, half: true },
          states,
        );
        return;
      }

      var input = el("input");
      input.type = spec.type || "text";
      input.value = state.values[spec.name] || "";
      addField(spec, input);
    });

    state.statusEl = el("p", "sa-order-status");
    state.statusEl.hidden = true;
    form.appendChild(state.statusEl);

    var actions = el("div", "sa-order-actions");
    var review = el(
      "button",
      "sa-card-button sa-card-button-primary sa-order-checkout",
      forAddress ? "Save address" : "Continue to shipping",
    );
    review.type = "submit";
    var cancel = el("button", "sa-card-button", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", function () {
      self.closeOrderForm();
    });
    actions.appendChild(review);
    actions.appendChild(cancel);
    form.appendChild(actions);

    form.onsubmit = function (event) {
      event.preventDefault();
      if (state.busy) return;
      keepValues();
      state.errors = {};
      if (forAddress) self.saveAddress();
      else self.quoteOrder();
    };

    var firstInvalid = form.querySelector('[aria-invalid="true"]');
    (firstInvalid || state.inputs.email || state.inputs.firstName).focus();
    this.scrollToEnd();
  };

  // ------------------------------------------- changes to an existing order

  var ORDER_ACTION_KINDS = { cancel: true, cancel_request: true, address: true, edit: true };

  /** Takes any confirmation card off the screen. Cards are never saved. */
  Widget.prototype.dropActionCards = function () {
    var cards = this.messagesEl.querySelectorAll(".sa-action");
    for (var i = 0; i < cards.length; i += 1) cards[i].parentNode.removeChild(cards[i]);
  };

  /**
   * A card asking the shopper to confirm a change to their own order: cancel
   * it, change its items, or send it somewhere else. The assistant only
   * proposes; nothing happens to the order until the button here is pressed,
   * and then it is the store's server, not this page, that decides.
   */
  Widget.prototype.showOrderAction = function (action) {
    var self = this;
    if (
      !ORDER_ACTION_KINDS[action.kind] ||
      typeof action.token !== "string" ||
      typeof action.title !== "string"
    ) {
      return;
    }
    // One at a time: an older card may describe an order that has since changed.
    this.dropActionCards();
    if (this.orderForm && this.orderForm.mode) this.closeOrderForm();

    var card = el("section", "sa-action");
    card.setAttribute("aria-label", action.title.slice(0, 200));
    card.appendChild(el("h3", "sa-order-title", action.title.slice(0, 200)));

    var lines = (Array.isArray(action.lines) ? action.lines : []).filter(function (line) {
      return typeof line === "string";
    });
    if (lines.length) {
      var list = el("ul", "sa-order-lines");
      lines.slice(0, 20).forEach(function (line) {
        list.appendChild(el("li", "sa-order-line", line.slice(0, 200)));
      });
      card.appendChild(list);
    }
    if (typeof action.note === "string" && action.note) {
      card.appendChild(el("p", "sa-order-note", action.note.slice(0, 300)));
    }

    var status = el("p", "sa-order-status");
    status.hidden = true;
    card.appendChild(status);
    var say = function (text, isError) {
      status.textContent = text;
      status.hidden = !text;
      status.className = "sa-order-status" + (isError ? " sa-order-status-error" : "");
      if (isError) status.setAttribute("role", "alert");
      else status.removeAttribute("role");
    };

    var actions = el("div", "sa-order-actions");
    var confirm = el(
      "button",
      "sa-card-button sa-order-checkout " +
        (action.kind === "cancel" ? "sa-card-button-danger" : "sa-card-button-primary"),
      typeof action.confirmLabel === "string" ? action.confirmLabel.slice(0, 40) : "Confirm",
    );
    confirm.type = "button";
    var dismiss = el("button", "sa-card-button", action.kind === "cancel" ? "Keep my order" : "Not now");
    dismiss.type = "button";
    dismiss.addEventListener("click", function () {
      if (self.orderForm && self.orderForm.card === card) self.closeOrderForm();
      if (card.parentNode) card.parentNode.removeChild(card);
    });

    confirm.addEventListener("click", function () {
      if (action.kind === "address") {
        self.openAddressForm(action, card);
        return;
      }
      confirm.disabled = true;
      dismiss.disabled = true;
      say("One moment…", false);
      self.postOrder({ step: action.kind, token: action.token }).then(function (result) {
        if (result.ok && typeof result.body.message === "string") {
          if (card.parentNode) card.parentNode.removeChild(card);
          self.pushEntry({ role: "notice", tone: "success", text: result.body.message });
          return;
        }
        var error = result.body.error || {};
        say(
          typeof error.message === "string"
            ? error.message
            : "We couldn't reach the store. Check your connection and try again.",
          true,
        );
        dismiss.disabled = false;
        // An expired or refused request will not succeed on a second press.
        confirm.disabled = error.code === "invalid_request" || error.code === "unavailable";
      });
    });

    actions.appendChild(confirm);
    actions.appendChild(dismiss);
    card.appendChild(actions);
    this.messagesEl.appendChild(card);
    this.scrollToEnd();
  };

  /** Opens the address form for an order whose delivery address may change. */
  Widget.prototype.openAddressForm = function (action, card) {
    var self = this;
    if (this.orderForm && this.orderForm.card === card) {
      var first = this.orderForm.el.querySelector("input, select");
      if (first) first.focus();
      return Promise.resolve();
    }
    this.closeOrderForm();

    var form = el("form", "sa-order sa-order-form");
    form.noValidate = true;
    form.setAttribute("aria-label", "New delivery address");
    var locked = /^[A-Z]{2}$/.test(action.countryCode || "") ? action.countryCode : "";
    var state = {
      el: form,
      mode: "address",
      token: action.token,
      card: card,
      values: { countryCode: locked },
      inputs: {},
      errors: {},
      busy: false,
      regions: readRegions(),
    };
    this.orderForm = state;
    this.messagesEl.appendChild(form);

    return this.loadCountries().then(function (countries) {
      if (self.orderForm !== state) return;
      // The address may change, the country may not: offer only that one.
      var same = countries.filter(function (country) {
        return country.code === locked;
      });
      if (!same.length && locked) {
        var name = locked;
        try {
          name = new Intl.DisplayNames([self.config.locale || "en"], { type: "region" }).of(locked) || locked;
        } catch (error) {
          name = locked;
        }
        same = [{ code: locked, name: name }];
      }
      state.countries = same.length ? same : countries;
      self.renderOrderDetails();
    });
  };

  /** Sends the new address for the order the form was opened for. */
  Widget.prototype.saveAddress = function () {
    var self = this;
    var state = this.orderForm;
    var values = state.values;
    this.setOrderBusy(true);
    this.setOrderStatus("Saving your new address…");

    return this.postOrder({
      step: "address",
      token: state.token,
      contact: {
        firstName: values.firstName || "",
        lastName: values.lastName,
        phone: values.phone,
        email: "",
      },
      address: {
        address1: values.address1,
        address2: values.address2 || "",
        city: values.city,
        province: values.province || "",
        zip: values.zip || "",
        countryCode: values.countryCode,
      },
    }).then(function (result) {
      if (self.orderForm !== state) return;
      self.setOrderBusy(false);
      if (result.ok && typeof result.body.message === "string") {
        self.closeOrderForm();
        if (state.card && state.card.parentNode) state.card.parentNode.removeChild(state.card);
        self.pushEntry({ role: "notice", tone: "success", text: result.body.message });
        return;
      }
      self.showOrderError(result.body);
    });
  };

  /** What the app needs to price or place the order. */
  Widget.prototype.orderPayload = function (step) {
    var state = this.orderForm;
    var values = state.values;
    return {
      step: step,
      items: state.items,
      contact: {
        firstName: values.firstName || "",
        lastName: values.lastName,
        phone: values.phone,
        email: values.email || "",
      },
      address: {
        address1: values.address1,
        address2: values.address2 || "",
        city: values.city,
        province: values.province || "",
        zip: values.zip || "",
        countryCode: values.countryCode,
      },
      shippingRateHandle: state.shippingRateHandle,
    };
  };

  /** Reads the cart, then asks the app for delivery options and the total. */
  Widget.prototype.quoteOrder = function () {
    var self = this;
    var state = this.orderForm;
    this.setOrderBusy(true);
    this.setOrderStatus("Working out delivery and total…");

    return this.fetchCart()
      .then(function (cart) {
        if (self.orderForm !== state) return null;
        var problem = !cart
          ? "Your cart couldn't be read."
          : !cart.items.length
            ? "Your cart is empty."
            : cart.items.length > MAX_ORDER_ITEMS ||
                cart.items.some(function (line) {
                  return (
                    line.quantity > MAX_ITEM_QUANTITY ||
                    line.selling_plan_allocation ||
                    (line.properties && Object.keys(line.properties).length > 0)
                  );
                })
              ? "This order can't be placed here."
              : "";
        if (problem) return { ok: false, body: { error: { message: problem + USE_CHECKOUT } } };

        state.items = cart.items.map(function (line) {
          return { variantId: String(line.variant_id), quantity: Number(line.quantity) };
        });
        return self.postOrder(self.orderPayload("quote"));
      })
      .then(function (result) {
        if (!result || self.orderForm !== state) return;
        self.setOrderBusy(false);
        if (result.ok && result.body.quote) {
          self.renderOrderReview(result.body.quote);
          return;
        }
        self.showOrderError(result.body);
      });
  };

  /** Puts a refused step back in front of the shopper with the reason. */
  Widget.prototype.showOrderError = function (body) {
    var state = this.orderForm;
    var error = (body && body.error) || {};
    var message =
      typeof error.message === "string"
        ? error.message
        : "We couldn't reach the store. Check your connection and try again.";

    if (error.fields && typeof error.fields === "object") {
      state.errors = {};
      Object.keys(error.fields).forEach(function (name) {
        if (typeof error.fields[name] === "string") state.errors[name] = error.fields[name];
      });
      this.renderOrderDetails();
    } else if (body && body.quote) {
      this.renderOrderReview(body.quote);
    }
    this.setOrderStatus(message, true);
    this.scrollToEnd();
  };

  /** Step 2: the total to pay on delivery, and the button that places the order. */
  Widget.prototype.renderOrderReview = function (quote) {
    var self = this;
    var state = this.orderForm;
    var form = state.el;
    var locale = this.config.locale;
    var money = function (value) {
      return formatMoney(value, locale);
    };
    // A new total is a new order as far as retries go.
    if (!state.quote || state.quote.total.amount !== quote.total.amount) state.key = randomId();
    state.quote = quote;
    state.shippingRateHandle = quote.shippingRateHandle;

    form.textContent = "";

    // Who the order is for and where it goes, each with a way back to change it.
    var values = state.values;
    var country = state.countries.filter(function (entry) {
      return entry.code === values.countryCode;
    })[0];
    var recap = el("div", "sa-order-recap");
    var addRecap = function (label, text) {
      var row = el("div", "sa-order-recap-row");
      row.appendChild(el("span", "sa-order-recap-label", label));
      row.appendChild(el("span", "sa-order-recap-value", text));
      var change = el("button", "sa-order-change", "Change");
      change.type = "button";
      change.setAttribute("aria-label", "Change: " + label);
      change.addEventListener("click", function () {
        self.renderOrderDetails();
      });
      row.appendChild(change);
      recap.appendChild(row);
    };
    addRecap("Contact", [values.email, values.phone].filter(Boolean).join(" · "));
    addRecap(
      "Ship to",
      [
        [values.firstName, values.lastName].filter(Boolean).join(" "),
        values.address1,
        values.address2,
        values.city,
        values.province,
        values.zip,
        country && country.name,
      ]
        .filter(Boolean)
        .join(", "),
    );
    form.appendChild(recap);

    var rates = Array.isArray(quote.shippingRates) ? quote.shippingRates : [];
    if (rates.length) {
      var options = el("fieldset", "sa-order-rates");
      options.appendChild(el("legend", "sa-order-title", "Shipping method"));
      rates.forEach(function (rate, index) {
        var label = el("label", "sa-order-rate");
        var radio = el("input");
        radio.type = "radio";
        radio.name = "shippingRate";
        radio.id = "sa-order-rate-" + index;
        radio.checked = rate.handle === quote.shippingRateHandle;
        radio.addEventListener("change", function () {
          state.shippingRateHandle = rate.handle;
          self.quoteOrder();
        });
        label.appendChild(radio);
        label.appendChild(el("span", "sa-order-item", String(rate.title)));
        label.appendChild(el("span", "sa-order-amount", money(rate.price)));
        options.appendChild(label);
      });
      form.appendChild(options);
    }

    form.appendChild(el("h3", "sa-order-title", "Payment"));
    var payment = el("div", "sa-order-pay");
    payment.appendChild(el("strong", null, "Pay on delivery"));
    payment.appendChild(
      el("span", null, "You pay " + money(quote.total) + " when your order arrives."),
    );
    form.appendChild(payment);

    form.appendChild(el("h3", "sa-order-title", "Order summary"));
    var list = el("ul", "sa-order-lines");
    (Array.isArray(quote.lines) ? quote.lines : []).forEach(function (line) {
      var item = el("li", "sa-order-line");
      item.appendChild(el("span", "sa-order-quantity", (parseInt(line.quantity, 10) || 1) + " ×"));
      item.appendChild(el("span", "sa-order-item", String(line.title || "Item")));
      item.appendChild(el("span", "sa-order-amount", money(line.total)));
      list.appendChild(item);
    });
    form.appendChild(list);

    var totals = el("dl", "sa-order-totals");
    var addTotal = function (label, value, strong) {
      totals.appendChild(el("dt", strong ? "sa-order-grand" : null, label));
      totals.appendChild(el("dd", strong ? "sa-order-grand" : null, money(value)));
    };
    addTotal("Subtotal", quote.subtotal);
    addTotal("Shipping", quote.shipping);
    if (quote.tax) addTotal("Tax", quote.tax);
    addTotal("Total", quote.total, true);
    form.appendChild(totals);

    state.statusEl = el("p", "sa-order-status");
    state.statusEl.hidden = true;
    form.appendChild(state.statusEl);

    var actions = el("div", "sa-order-actions");
    var place = el("button", "sa-card-button sa-card-button-primary sa-order-checkout", "Complete order");
    place.type = "submit";
    var edit = el("button", "sa-card-button", "Back");
    edit.type = "button";
    edit.addEventListener("click", function () {
      self.renderOrderDetails();
    });
    actions.appendChild(place);
    actions.appendChild(edit);
    form.appendChild(actions);

    form.onsubmit = function (event) {
      event.preventDefault();
      if (!state.busy) self.placeOrder();
    };
    place.focus();
    this.scrollToEnd();
  };

  /** Places the order the shopper has just reviewed. */
  Widget.prototype.placeOrder = function () {
    var self = this;
    var state = this.orderForm;
    var payload = this.orderPayload("place");
    payload.expectedTotal = state.quote.total;
    payload.idempotencyKey = state.key;
    // Lets the assistant know about the order afterwards. Left out when there
    // is no chat yet; the order is placed either way.
    if (this.state.conversationId) {
      payload.visitorId = this.state.visitorId;
      payload.conversationId = this.state.conversationId;
    }
    this.setOrderBusy(true);
    this.setOrderStatus("Placing your order…");

    return this.postOrder(payload).then(function (result) {
      if (self.orderForm !== state) return;
      self.setOrderBusy(false);
      var order = result.ok ? result.body.order : null;
      if (!order || typeof order.name !== "string") {
        self.showOrderError(result.body);
        return;
      }

      self.closeOrderForm();
      // The order is placed, so the summary of the old cart goes away too.
      self.state.messages = self.state.messages.filter(function (message) {
        return message.role !== "order";
      });
      var stale = self.messagesEl.querySelectorAll(".sa-order");
      for (var i = 0; i < stale.length; i += 1) stale[i].parentNode.removeChild(stale[i]);
      self.pushEntry({
        role: "notice",
        tone: "success",
        text:
          "Order " +
          order.name +
          " is placed. You pay " +
          formatMoney(order.total, self.config.locale) +
          " on delivery.",
      });
      self.clearCart();
    });
  };

  /** Empties the storefront cart. Resolves true when Shopify agreed. */
  Widget.prototype.clearCart = function () {
    return window
      .fetch(this.config.cartUrl + "/clear.js", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        body: "{}",
      })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (cart) {
        if (cart) {
          document.dispatchEvent(new CustomEvent("shopi-assist:cart-updated", { detail: cart }));
        }
        return Boolean(cart);
      })
      .catch(function () {
        return false;
      });
  };

  // ------------------------------------------------------------------ boot

  function mount(host) {
    if (!host || host.getAttribute("data-shopi-assist-mounted") === "true") return null;
    host.setAttribute("data-shopi-assist-mounted", "true");
    var widget = new Widget(host);
    widget.mount();
    return widget;
  }

  function boot() {
    mount(document.getElementById("shopi-assist-root"));
  }

  window.ShopiAssist = { mount: mount };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
