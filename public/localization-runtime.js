(() => {
  const storageKey = 'ai-media-client.locale';
  const english = window.aiMediaEnglish || {};
  const originalText = new WeakMap();
  const originalAttributes = new WeakMap();
  const renderedText = new WeakMap();
  const renderedAttributes = new WeakMap();
  const attributes = ['title', 'placeholder', 'aria-label', 'alt'];
  const normalize = value => value.trim().replace(/\s+/g, ' ');
  const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const templates = Object.entries(english).filter(([source, target]) => /\{\d+\}/.test(source) && /\{\d+\}/.test(target)).map(([source, target]) => {
    const pieces = source.split(/\{\d+\}/g);
    const order = [...source.matchAll(/\{(\d+)\}/g)].map(match => Number(match[1]));
    return { pattern: new RegExp('^' + pieces.map(escapeRegex).join('([\\s\\S]*?)') + '$'), order, target };
  });
  const language = value => /^(en|eng)(-|$)/i.test(value || '') ? 'en' : /^(ru|rus)(-|$)/i.test(value || '') ? 'ru' : null;
  let locale = language(localStorage.getItem(storageKey)) || (navigator.languages || [navigator.language]).map(language).find(Boolean) || 'ru';
  function translate(value) {
    if (locale === 'ru' || !/[А-Яа-яЁё]/u.test(value)) return value;
    const compact = normalize(value);
    let replacement = english[compact];
    if (!replacement) {
      for (const template of templates) {
        const match = template.pattern.exec(compact);
        if (!match) continue;
        replacement = template.target.replace(/\{(\d+)\}/g, (_, index) => match[template.order.indexOf(Number(index)) + 1] || '');
        break;
      }
    }
    if (!replacement) return value;
    const leading = value.match(/^\s*/)?.[0] || '';
    const trailing = value.match(/\s*$/)?.[0] || '';
    return leading + replacement + trailing;
  }
  function translateText(node) {
    const parent = node.parentElement;
    if (!parent || /^(SCRIPT|STYLE|TEXTAREA)$/i.test(parent.tagName) || parent.closest('[data-no-localize],[contenteditable="true"]')) return;
    if (!originalText.has(node) || node.nodeValue !== renderedText.get(node)) originalText.set(node, node.nodeValue || '');
    const result = translate(originalText.get(node));
    renderedText.set(node, result);
    if (node.nodeValue !== result) node.nodeValue = result;
  }
  function translateElement(element) {
    if (!originalAttributes.has(element)) originalAttributes.set(element, {});
    if (!renderedAttributes.has(element)) renderedAttributes.set(element, {});
    const original = originalAttributes.get(element);
    const rendered = renderedAttributes.get(element);
    for (const name of attributes) {
      if (!element.hasAttribute(name)) continue;
      const current = element.getAttribute(name);
      if (!(name in original) || current !== rendered[name]) original[name] = current;
      const result = translate(original[name]);
      rendered[name] = result;
      if (current !== result) element.setAttribute(name, result);
    }
  }
  function translateTree(root) {
    if (root.nodeType === Node.TEXT_NODE) return translateText(root);
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
    if (root.nodeType === Node.ELEMENT_NODE) translateElement(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (walker.currentNode.nodeType === Node.TEXT_NODE) translateText(walker.currentNode);
      else translateElement(walker.currentNode);
    }
  }
  function setLocale(next) {
    locale = language(next) || 'ru';
    localStorage.setItem(storageKey, locale);
    document.documentElement.lang = locale;
    const select = document.getElementById('legacyLocaleSwitcher');
    if (select) select.value = locale;
    const legalNote = document.getElementById('legalTranslationNote');
    if (legalNote) legalNote.hidden = locale !== 'en';
    translateTree(document);
    window.dispatchEvent(new CustomEvent('ai-media-locale-change', { detail: { locale } }));
  }
  function createSwitcher() {
    const host = document.querySelector('.account-card-topbar, .admin-heading .account-controls, .legal-header, body > header');
    if (!host) return;
    const select = document.createElement('select');
    select.id = 'legacyLocaleSwitcher';
    select.className = 'legacy-locale-switcher';
    select.dataset.noLocalize = '';
    select.setAttribute('aria-label', 'Language / Язык');
    select.append(new Option('Русский', 'ru'), new Option('English', 'en'));
    select.value = locale;
    select.addEventListener('change', () => setLocale(select.value));
    host.append(select);
    if (location.pathname.startsWith('/legal/')) {
      const note = document.createElement('p');
      note.id = 'legalTranslationNote';
      note.className = 'legal-translation-note';
      note.textContent = 'This English translation is provided for convenience. If meanings differ, the Russian original governs.';
      host.after(note);
    }
  }
  createSwitcher();
  setLocale(locale);
  new MutationObserver(changes => {
    for (const change of changes) {
      if (change.type === 'characterData') translateText(change.target);
      else if (change.type === 'attributes') translateElement(change.target);
      else for (const node of change.addedNodes) translateTree(node);
    }
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: attributes });
  window.addEventListener('storage', event => { if (event.key === storageKey) setLocale(event.newValue); });
  window.aiMediaLocale = { get current() { return locale; }, set: setLocale, translate };
})();
