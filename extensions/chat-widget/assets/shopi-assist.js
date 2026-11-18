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
  var MAX_STORED_MESSAGES = 40;
  var IDLE_RESET_MS = 24 * 60 * 60 * 1000;
  var REQUEST_TIMEOUT_MS = 60000;
  var MAX_MESSAGE_LENGTH = 2000;

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
    };
    this.pending = false;
    this.lastFailedMessage = null;
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
        wrapper.hidden = false;
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
    header.appendChild(el("h2", "sa-title", config.title));
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
    var row = this.appendBubble(message.role === "user" ? "user" : "assistant", message.text);
    if (message.cards && message.cards.length) this.appendCards(message.cards);
    return row;
  };

  Widget.prototype.appendNotice = function (text, tone, link) {
    var notice = el("div", "sa-notice" + (tone === "error" ? " sa-notice-error" : ""));
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

  Widget.prototype.appendCards = function (cards) {
    var self = this;
    var list = el("ul", "sa-cards");
    list.setAttribute("aria-label", "Suggested products");

    cards.slice(0, 6).forEach(function (card) {
      if (!card || typeof card.title !== "string") return;
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

      var price = el("div", "sa-card-price");
      price.appendChild(el("span", null, formatMoney(card.price, self.config.locale)));
      if (card.compareAtPrice) {
        var was = el("s", null, formatMoney(card.compareAtPrice, self.config.locale));
        was.setAttribute("aria-label", "Was " + was.textContent);
        price.appendChild(was);
      }
      if (!card.available) price.appendChild(el("span", "sa-card-soldout", "Sold out"));
      body.appendChild(price);

      var actions = el("div", "sa-card-actions");
      if (card.available && card.variantId && /^\d+$/.test(String(card.variantId))) {
        var add = el("button", "sa-card-button sa-card-button-primary", "Add to cart");
        add.type = "button";
        add.addEventListener("click", function () {
          add.disabled = true;
          add.textContent = "Adding…";
          self.addToCart(card.variantId, 1).then(function (result) {
            add.textContent = result.ok ? "Added" : "Add to cart";
            add.disabled = result.ok;
            if (result.ok) {
              window.setTimeout(function () {
                add.textContent = "Add to cart";
                add.disabled = false;
              }, 2500);
            } else {
              self.appendNotice(result.message, "error");
              self.scrollToEnd();
            }
          });
        });
        actions.appendChild(add);
      } else if (href && card.available) {
        var choose = el("a", "sa-card-button", "Choose options");
        choose.href = href;
        actions.appendChild(choose);
      }
      if (href) {
        var view = el("a", "sa-card-button", "View");
        view.href = href;
        view.setAttribute("aria-label", "View " + card.title);
        actions.appendChild(view);
      }
      body.appendChild(actions);

      item.appendChild(body);
      list.appendChild(item);
    });

    if (list.children.length) this.messagesEl.appendChild(list);
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

    return window
      .fetch(this.config.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        signal: controller ? controller.signal : undefined,
        body: JSON.stringify({
          message: text,
          visitorId: this.state.visitorId,
          conversationId: this.state.conversationId,
          country: this.config.country,
          language: (this.config.locale || "").slice(0, 2),
        }),
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

        (Array.isArray(body.actions) ? body.actions : []).forEach(function (action) {
          self.runAction(action);
        });
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

  Widget.prototype.runAction = function (action) {
    var self = this;
    if (!action || action.type !== "add_to_cart") return;
    if (!/^\d+$/.test(String(action.variantId))) return;
    var quantity = Math.max(1, Math.min(10, parseInt(action.quantity, 10) || 1));

    this.addToCart(action.variantId, quantity).then(function (result) {
      var entry = result.ok
        ? {
            role: "notice",
            text: "Added to your cart.",
            link: { label: "View cart", href: self.config.cartUrl },
          }
        : { role: "notice", tone: "error", text: result.message };
      self.state.messages.push(entry);
      self.saveState();
      self.renderMessage(entry);
      self.scrollToEnd();
    });
  };

  /** Adds a variant to the storefront cart through Shopify's Ajax Cart API. */
  Widget.prototype.addToCart = function (variantId, quantity) {
    return window
      .fetch(this.config.cartAddUrl + ".js", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ items: [{ id: Number(variantId), quantity: quantity }] }),
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
