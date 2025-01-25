// State management
const state = {
  isEnabled: false,
  selectedDeck: "",
  deckWords: {
    known: new Map(), // Map of word -> reading
    unknown: new Map(),
  },
  pageCache: {
    currentUrl: "",
    stats: null,
    textNodes: null,
    pageWords: null,
  },
  lastHighlightTime: 0,
  highlightDebounceMs: 1000,
};

// Language detection and processing
const langUtils = {
  detectLanguage(text) {
    const hasJapanese = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff]/.test(text);
    const hasKorean = /[\uac00-\ud7af]/.test(text);
    const hasChinese = /[\u4e00-\u9fff]/.test(text) && !hasJapanese;

    if (hasJapanese) return "ja";
    if (hasKorean) return "ko";
    if (hasChinese) return "zh";
    return "other";
  },

  containsCJK(text) {
    return /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(text);
  },

  stripHtml(html) {
    const temp = document.createElement("div");
    temp.innerHTML = html;
    return temp.textContent || temp.innerText || "";
  },
};

// Tokenization logic for different languages
const tokenizers = {
  japanese(text) {
    const patterns = [
      /([一-龯々]+[ぁ-ん]+)/g,
      /([一-龯々]+(?:する|できる|たい|な|に|の))/g,
      /([一-龯々]{2,})/g,
      /([ぁ-ん]{2,})/g,
      /([一-龯々])/g,
      /([ぁ-ん]+)/g,
      /([ァ-ヺー]+)/g,
    ];
    return this._applyPatterns(text, patterns);
  },

  korean(text) {
    const patterns = [
      /([0-9０-９]+년[0-9０-９]+월[0-9０-９]+일)/g,
      /([0-9０-９]+시[0-9０-９]+분)/g,
      /([0-9０-９]+[개명원초대건장통분초년월일주회차례])/g,
      /([\uac00-\ud7af]+(?:하다|되다|스럽다|답다|적이다|같다|있다|없다|보다|싶다|만하다))/g,
      /([\uac00-\ud7af]+(?:[은는이가을를에서도와과의로부터까지처럼보다만이나마도든지라도며]+))/g,
      /([\uac00-\ud7af]+(?:공부|준비|시작|포기|노력|걱정|생각|시도|계획|희망|기대|상상|판단|결정|선택|고민|결심)하다)/g,
      /([\uac00-\ud7af]+)/g,
      /([0-9０-９]+)/g,
    ];
    return this._applyPatterns(text, patterns);
  },

  chinese(text) {
    const patterns = [
      /([0-9０-９]+年[0-9０-９]+月[0-9０-９]+[日號号])/g,
      /([0-9０-９]+[时時][0-9０-９]+分)/g,
      /([0-9０-９]+[个個件條条份張张包双對对])/g,
      /([一二三四五六七八九十百千万億]{1,2}[个個件條条份張张包双對对])/g,
      /([一-龯々]{2}(?:时间|地方|东西|事情|问题|工作|学习|生活|历史|文化|社会|国家|世界|科技|经济|政治|教育|研究|发展|管理))/g,
      /([一-龯々]{2})/g,
      /([一-龯々])/g,
      /([0-9０-９]+)/g,
    ];
    return this._applyPatterns(text, patterns);
  },

  _applyPatterns(text, patterns) {
    let tokens = [];
    let remaining = text;

    patterns.forEach((pattern) => {
      remaining = remaining.replace(pattern, (match) => {
        const cleanMatch = match.trim();
        if (cleanMatch) tokens.push(cleanMatch);
        return " ".repeat(match.length);
      });
    });

    return tokens.filter((token) => token.length > 0);
  },
};

// Anki API interaction
const ankiAPI = {
  async queryBatch(deckName, words) {
    const queries = words.map((word) => {
      if (langUtils.containsCJK(word)) {
        return `(word:"${this._escapeAnkiSearch(word)}" OR reading:"${this._escapeAnkiSearch(word)}")`;
      }
      return `(word:${this._escapeAnkiSearch(word)}* OR reading:${this._escapeAnkiSearch(word)}*)`;
    });

    const queryBatches = [];
    for (let i = 0; i < queries.length; i += 5) {
      const batchQueries = queries.slice(i, i + 5);
      queryBatches.push(`(${batchQueries.join(" OR ")})`);
    }

    let allCards = [];
    for (const batchQuery of queryBatches) {
      const fullQuery = `deck:"${deckName}" ${batchQuery}`;
      const response = await this._makeAnkiRequest("findCards", {
        query: fullQuery,
      });
      if (response.result) {
        allCards = allCards.concat(response.result);
      }
    }

    return allCards;
  },

  async processCards(allFoundCards) {
    const cardsData = await this._makeAnkiRequest("cardsInfo", {
      cards: allFoundCards,
    });
    if (!cardsData.result) return;

    state.deckWords.known.clear();
    state.deckWords.unknown.clear();

    cardsData.result.forEach((card) => {
      const word = langUtils.stripHtml(card.fields.Word.value).trim();
      const reading = card.fields.Reading
        ? langUtils.stripHtml(card.fields.Reading.value).trim()
        : null;

      if (card.interval > 21) {
        state.deckWords.known.set(word, reading);
      } else {
        state.deckWords.unknown.set(word, reading);
      }
    });
  },

  _escapeAnkiSearch(text) {
    if (!text) return "";
    return text
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/:/g, "\\:")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)")
      .trim();
  },

  async _makeAnkiRequest(action, params) {
    try {
      const response = await fetch("http://localhost:8765", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          version: 6,
          params,
        }),
      });
      const data = await response.json();
      if (data.error) {
        console.error(`Anki ${action} error:`, data.error);
        return { result: null };
      }
      return data;
    } catch (error) {
      console.error(`Error in Anki ${action}:`, error);
      return { result: null };
    }
  },
};

// Page content analysis
const pageAnalyzer = {
  getTextNodes() {
    const textNodes = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          const tag = node.parentElement.tagName;
          if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      },
    );

    let node;
    while ((node = walker.nextNode())) {
      textNodes.push(node);
    }
    return textNodes;
  },

  getUniqueWords(text) {
    if (langUtils.containsCJK(text)) {
      const lang = langUtils.detectLanguage(text);
      const tokenizer = tokenizers[lang] || ((text) => [text]);
      return tokenizer.call(tokenizers, text);
    }

    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter((word) => word.length > 0);
  },

  async analyzeContent(force = false) {
    if (!state.isEnabled || !state.selectedDeck) return;

    const currentUrl = window.location.href;
    if (
      !force &&
      state.pageCache.currentUrl === currentUrl &&
      state.pageCache.stats
    ) {
      this._sendStats(state.pageCache.stats);
      return;
    }

    const textNodes = this.getTextNodes();
    const pageWords = new Set();
    textNodes.forEach((node) => {
      const words = this.getUniqueWords(node.textContent);
      words.forEach((word) => pageWords.add(word));
    });

    const validWords = Array.from(pageWords)
      .filter((word) => word.trim().length > 0)
      .map((word) => ankiAPI._escapeAnkiSearch(word))
      .filter((word) => word.length > 0);

    if (validWords.length === 0) return;

    const allFoundCards = await ankiAPI.queryBatch(
      state.selectedDeck,
      validWords,
    );
    if (allFoundCards.length > 0) {
      await ankiAPI.processCards(allFoundCards);
    }

    const stats = this._calculateStats(pageWords);

    state.pageCache = {
      currentUrl,
      stats,
      textNodes,
      pageWords,
    };

    this._sendStats(stats);
    this._applyHighlighting(textNodes);
  },

  _calculateStats(pageWords) {
    const stats = { known: 0, unknown: 0, new: 0, deckPercentage: 0 };
    const totalWords = pageWords.size;
    const processedWords = new Set();

    for (const word of pageWords) {
      const cleanWord = word.trim();

      // Check if word matches either form in known cards
      let found = false;
      for (const [knownWord, reading] of state.deckWords.known.entries()) {
        if (cleanWord === knownWord || cleanWord === reading) {
          if (!processedWords.has(knownWord)) {
            stats.known++;
            processedWords.add(knownWord);
          }
          found = true;
          break;
        }
      }

      if (!found) {
        // Check unknown cards if not found in known
        for (const [
          unknownWord,
          reading,
        ] of state.deckWords.unknown.entries()) {
          if (cleanWord === unknownWord || cleanWord === reading) {
            if (!processedWords.has(unknownWord)) {
              stats.unknown++;
              processedWords.add(unknownWord);
            }
            found = true;
            break;
          }
        }
      }

      if (!found) {
        stats.new++;
      }
    }

    if (totalWords > 0) {
      stats.deckPercentage = Math.round(
        ((stats.known + stats.unknown) / totalWords) * 100,
      );
    }

    return stats;
  },

  _sendStats(stats) {
    chrome.runtime.sendMessage({
      type: "statsUpdate",
      stats,
    });
  },

  _applyHighlighting(textNodes) {
    const now = Date.now();
    if (now - state.lastHighlightTime < state.highlightDebounceMs) {
      return;
    }
    state.lastHighlightTime = now;

    const existingHighlights = new Map();
    document
      .querySelectorAll(".anki-highlight-known, .anki-highlight-unknown")
      .forEach((el) => {
        existingHighlights.set(el.textContent, {
          element: el,
          class: el.className,
        });
      });

    textNodes.forEach((node) => {
      if (
        !node.parentNode ||
        node.parentNode.classList.contains("anki-highlight-known") ||
        node.parentNode.classList.contains("anki-highlight-unknown")
      ) {
        return;
      }

      const text = node.textContent;
      if (!text.trim()) return;

      const fragment = document.createDocumentFragment();

      if (langUtils.containsCJK(text)) {
        const lang = langUtils.detectLanguage(text);
        const tokenizer = tokenizers[lang] || ((text) => [text]);
        const tokens = tokenizer.call(tokenizers, text);

        tokens.forEach((token) => {
          const cleanToken = token.trim();
          const existing = existingHighlights.get(token);

          if (existing) {
            fragment.appendChild(existing.element.cloneNode(true));
          } else {
            let isKnown = false;
            let isUnknown = false;

            // Check both word and reading in known/unknown maps
            for (const [word, reading] of state.deckWords.known.entries()) {
              if (cleanToken === word || cleanToken === reading) {
                isKnown = true;
                break;
              }
            }

            if (!isKnown) {
              for (const [word, reading] of state.deckWords.unknown.entries()) {
                if (cleanToken === word || cleanToken === reading) {
                  isUnknown = true;
                  break;
                }
              }
            }

            const span = document.createElement("span");
            span.textContent = token;
            if (isKnown) {
              span.className = "anki-highlight-known";
            } else if (isUnknown) {
              span.className = "anki-highlight-unknown";
            } else {
              fragment.appendChild(document.createTextNode(token));
              return;
            }
            fragment.appendChild(span);
          }
        });
      } else {
        // Non-CJK text handling remains the same
        text.split(/(\s+)/).forEach((word) => {
          const cleanWord = word.toLowerCase().replace(/[^\w]/g, "");
          const existing = existingHighlights.get(word);

          if (existing) {
            fragment.appendChild(existing.element.cloneNode(true));
          } else if (cleanWord) {
            let isKnown = false;
            let isUnknown = false;

            for (const [word, reading] of state.deckWords.known.entries()) {
              if (cleanWord === word || cleanWord === reading) {
                isKnown = true;
                break;
              }
            }

            if (!isKnown) {
              for (const [word, reading] of state.deckWords.unknown.entries()) {
                if (cleanWord === word || cleanWord === reading) {
                  isUnknown = true;
                  break;
                }
              }
            }

            const span = document.createElement("span");
            span.textContent = word;
            if (isKnown) {
              span.className = "anki-highlight-known";
            } else if (isUnknown) {
              span.className = "anki-highlight-unknown";
            } else {
              fragment.appendChild(document.createTextNode(word));
              return;
            }
            fragment.appendChild(span);
          } else {
            fragment.appendChild(document.createTextNode(word));
          }
        });
      }

      if (node.parentNode) {
        node.parentNode.replaceChild(fragment, node);
      }
    });
  },
};

// Event listeners
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "toggleAnalysis") {
    state.isEnabled = message.isEnabled;
    state.selectedDeck = message.selectedDeck;

    if (state.isEnabled) {
      pageAnalyzer.analyzeContent(true);
    } else {
      document.querySelectorAll(".anki-known, .anki-unknown").forEach((el) => {
        if (el.parentNode) {
          const textNode = document.createTextNode(el.textContent);
          el.parentNode.replaceChild(textNode, el);
        }
      });
      state.pageCache = {
        currentUrl: "",
        stats: null,
        textNodes: null,
        pageWords: null,
      };
    }
  } else if (message.type === "getStats") {
    pageAnalyzer.analyzeContent();
  }
});

// URL change observer
let lastUrl = window.location.href;
const urlObserver = new MutationObserver(() => {
  if (lastUrl !== window.location.href) {
    lastUrl = window.location.href;
    if (state.isEnabled) {
      state.pageCache.currentUrl = "";
      pageAnalyzer.analyzeContent(true);
    }
  }
});

// Configure observer to only watch for URL changes
urlObserver.observe(document.documentElement, {
  childList: true,
  subtree: true,
  characterData: false,
  attributes: false,
});

// Initial setup
chrome.storage.local.get(["isEnabled", "selectedDeck"], (result) => {
  state.isEnabled = result.isEnabled || false;
  state.selectedDeck = result.selectedDeck || "";
  if (state.isEnabled) {
    pageAnalyzer.analyzeContent(true);
  }
});
