(() => {
  'use strict';

  /* In-page fill engine for job_find_apply. Injected as a raw script via
   * page.evaluate; self-contained by design (no imports, no closures over module
   * scope). Installs window.__jfa with scan() / fill() / attachResume() /
   * detect(). Ported from jobsearch/jobfill/lib/{matchers,fields,adapters}.js and
   * content/fill.js, adapted so that DOM element references never cross the page
   * boundary: scan() returns plain descriptors and keeps the live elements in an
   * internal registry keyed by descriptor.index. */

  const tick = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ------------------------------------------------------------ pure helpers */

  function norm(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function clean(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }
  function scoreOption(optionText, wanted) {
    const label = norm(optionText);
    const want = norm(wanted);
    if (!label || !want) return 0;
    if (label === want) return 3;
    if (label.startsWith(want) || want.startsWith(label)) return 2;
    if (label.includes(want) || want.includes(label)) return 1;
    let i = 0;
    while (i < label.length && i < want.length && label[i] === want[i]) i++;
    if (i >= 4 && i / Math.min(label.length, want.length) >= 0.7) return 1;
    return 0;
  }
  function bestOption(options, wanted) {
    let best = null;
    options.forEach((text, index) => {
      const score = scoreOption(text, wanted);
      if (score && (!best || score > best.score)) best = { index, text, score };
    });
    return best;
  }

  /* ---------------------------------------------------------- label helpers */

  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\]/g, '\\$&');
  }
  function rootOf(el) {
    const root = el.getRootNode ? el.getRootNode() : document;
    return root && root.querySelector ? root : document;
  }
  function labelFor(el) {
    const root = rootOf(el);
    const parts = [];
    const push = (raw) => {
      const text = clean(raw);
      if (!text || text.length > 300) return;
      if (parts.some((p) => p.includes(text))) return;
      parts.push(text);
    };
    if (el.id && root.querySelector) push(root.querySelector(`label[for="${cssEscape(el.id)}"]`)?.textContent);
    push(el.closest?.('label')?.textContent);
    push(el.getAttribute?.('aria-label'));
    for (const id of (el.getAttribute?.('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
      push(root.getElementById?.(id)?.textContent || root.querySelector?.(`#${cssEscape(id)}`)?.textContent);
    }
    push(el.closest?.('fieldset')?.querySelector('legend')?.textContent);
    push(el.getAttribute?.('placeholder'));
    if (!parts.length) push(nearbyText(el));
    if (!parts.length) { push(el.getAttribute?.('name')); push(el.id); }

    // Gupy open-text questions carry a generic placeholder ("Digite sua
    // resposta aqui") instead of a real label; the actual question lives in a
    // heading above the field. Recover it so the model knows what is being asked.
    const resolved = clean(parts.join(' '));
    if (/^(digite|escreva|descreva|type|enter|write|responda)\b|sua\s*resposta|your\s*answer|answer\s*here|response\s*here/i.test(resolved)) {
      const q = questionText(el);
      if (q) return q;
    }
    return resolved;
  }
  function nearbyText(el) {
    let node = el.parentElement;
    for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
      for (const child of node.children) {
        if (child === el || child.contains(el)) continue;
        if (/^(input|select|textarea|button|svg|script|style)$/i.test(child.tagName)) continue;
        const text = clean(child.textContent);
        if (text && text.length <= 200) return text;
      }
      const own = clean(Array.from(node.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' '));
      if (own) return own;
    }
    return '';
  }
  function optionLabel(el) {
    const root = rootOf(el);
    const own = el.id && root.querySelector?.(`label[for="${cssEscape(el.id)}"]`);
    if (own) return clean(own.textContent);
    const wrapping = el.closest?.('label');
    if (wrapping) {
      const clone = wrapping.cloneNode(true);
      clone.querySelectorAll('input, select, textarea').forEach((n) => n.remove());
      const t = clean(clone.textContent);
      if (t) return t;
    }
    return clean(el.getAttribute?.('aria-label') || el.value || nearbyText(el));
  }
  function groupKey(el) {
    const raw = el.getAttribute?.('name') || '';
    // Grouping must distinguish "same question, different option" from "different
    // question". Two shapes are in play:
    //
    //   Gupy        checkbox-<questionId>-<optionIndex>   (e.g. checkbox-3093991-0)
    //   Greenhouse  question_<questionId>[]               (one name per question)
    //
    // Only a SHORT trailing index is an option index. The old chain ended with
    // `.replace(/_\d+$/, '')`, which ate Greenhouse's long question id as well:
    // question_33261698003[] -> "question" for every checkbox question on the form,
    // merging 28 options of three separate questions into one field. The filler then
    // ticked the right label in the wrong element and reported success.
    const stripped = raw
      .replace(/\[\](_\d+)?$/, '')
      .replace(/-\d{1,2}$/, '')
      .replace(/_\d{1,2}$/, '');
    if (stripped) return stripped;
    const container = el.closest?.('fieldset, [role="radiogroup"], [role="group"]');
    if (container) return container.id || container.getAttribute('aria-labelledby') || clean(container.textContent).slice(0, 60);
    return null;
  }
  function groupLabel(el) {
    const legend = el.closest?.('fieldset')?.querySelector('legend')?.textContent;
    if (legend) return clean(legend);
    const group = el.closest?.('[role="radiogroup"], [role="group"]');
    if (group?.getAttribute('aria-label')) return clean(group.getAttribute('aria-label'));
    // Gupy renders company questions as an <h3> question above the radio options,
    // with no fieldset/legend. Find that heading rather than returning "SIM".
    const q = questionText(el);
    if (q) return q;
    return labelFor(el);
  }
  function questionText(el) {
    let node = el.parentElement;
    for (let i = 0; node && i < 6; i++, node = node.parentElement) {
      let sib = node.previousElementSibling;
      while (sib) {
        const isHeading = /^H[1-6]$/.test(sib.tagName) || /question|pergunta|title/i.test(String(sib.className || ''));
        if (isHeading) {
          let t = clean(sib.textContent).replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
          // Gupy pads question headings with legal boilerplate plus a footnote
          // link ("*Para acessar o Código de Conduta acesse esse link: <url>").
          // Cut at the FIRST "?" — not at the first sentence boundary, because a
          // question containing an abbreviation ("...da Lojas Renner S.A. ou de
          // alguma de suas empresas controladas?") splits mid-question there and
          // leaves a meaningless tail as the label.
          const q = t.indexOf('?');
          if (q > 5) t = t.slice(0, q + 1);
          t = t.replace(/\s*\*\s*$/, ' *').trim();
          // Long compliance questions are still the question; keep them (capped) so
          // required-ness and the consent wording survive.
          if (t.length >= 6) return t.slice(0, 600);
        }
        sib = sib.previousElementSibling;
      }
    }
    return '';
  }
  function isRequired(el) {
    if (el.required || el.getAttribute?.('aria-required') === 'true') return true;
    const label = labelFor(el);
    if (/\*/.test(label) || /obrigat[óo]rio|required/i.test(label)) return true;
    // Gupy renders the marker as a sibling hint ("Campo obrigatório") instead of
    // inside the question text, and the heading is cut at the first "?" — so a
    // genuinely required choice group was read as optional. The driver then treated a
    // required compliance consent as a marketing opt-in and left it blank, which
    // disabled "Salvar e continuar" and stalled the application on that step forever.
    // Walk a few ancestors, bounded by text size so a neighbouring question's marker
    // cannot be borrowed.
    let node = el;
    for (let i = 0; i < 4 && node; i++) {
      const own = clean(node.textContent || '');
      if (own.length && own.length < 2000 && /campo\s*obrigat[óo]ri|this\s*field\s*is\s*required|required\s*field/i.test(own)) return true;
      // The hint is usually rendered right after the option list, i.e. as a trailing
      // sibling of the group rather than inside it.
      for (const sib of [node.nextElementSibling, node.previousElementSibling]) {
        const t = clean(sib?.textContent || '');
        if (t.length && t.length < 120 && /campo\s*obrigat[óo]ri|this\s*field\s*is\s*required|required\s*field/i.test(t)) return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  /* ---------------------------------------------------------------- fields */

  const NATIVE = 'input, select, textarea';
  const ARIA = '[role="combobox"], [role="radiogroup"], [contenteditable="true"], [contenteditable=""]';

  function deepQuery(selector, root, out, stats) {
    root = root || document;
    out = out || [];
    stats = stats || { shadowRoots: 0, closed: 0 };
    for (const el of root.querySelectorAll(selector)) out.push(el);
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        stats.shadowRoots++;
        deepQuery(selector, el.shadowRoot, out, stats);
      }
    }
    return { elements: out, stats };
  }

  function isVisible(el) {
    if (!el) return false;
    if (el.type === 'hidden') return false;
    if (el.disabled || el.readOnly) return false;
    if (el.getAttribute?.('aria-hidden') === 'true') return false;
    if (el.closest?.('[hidden], [aria-hidden="true"]')) return false;
    if (el.type === 'file') return true;
    if (typeof el.getBoundingClientRect !== 'function') return !!el.offsetParent;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0 && !el.offsetParent) return false;
    return true;
  }

  function slug(s) {
    return norm(s).replace(/\s+/g, '-').slice(0, 40) || 'field';
  }

  function makeUid(el, label, seen) {
    const base = el.getAttribute?.('name') || el.id || slug(label);
    const n = (seen[base] = (seen[base] || 0) + 1);
    return n === 1 ? base : `${base}~${n}`;
  }

  function optionsOf(el) {
    if (el.tagName === 'SELECT') return Array.from(el.options).map((o) => clean(o.textContent) || o.value);
    return [];
  }

  function kindOf(el) {
    const tag = el.tagName;
    if (tag === 'SELECT') return 'select';
    if (tag === 'TEXTAREA') return 'textarea';
    if (tag === 'INPUT') {
      const t = (el.type || 'text').toLowerCase();
      if (t === 'radio' || t === 'checkbox') return 'choice';
      if (t === 'file') return 'file';
      if (t === 'submit' || t === 'button' || t === 'image' || t === 'reset') return null;
      // MUI Autocomplete renders a bare <input role="combobox">; treat it as a
      // combobox so fillCombobox types + selects an option instead of fillText
      // silently failing to commit the value.
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (role === 'combobox' || role === 'listbox') return 'combobox';
      return 'text';
    }
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role === 'combobox' || role === 'listbox') return 'combobox';
    if (role === 'radiogroup') return 'choice-aria';
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '') return 'textarea';
    return null;
  }

  function setNative(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function accepted(actual, wanted) {
    const a = String(actual ?? '');
    const w = String(wanted ?? '');
    if (a === w) return { verified: true };
    if (!a.trim()) return { verified: false };
    const digits = (s) => s.replace(/\D/g, '');
    if (digits(w).length >= 6 && digits(a) === digits(w)) return { verified: true, note: 'the page reformatted it' };
    const na = norm(a);
    const nw = norm(w);
    if (na === nw) return { verified: true, note: 'the page reformatted it' };
    if (nw.length >= 4 && (na.includes(nw) || nw.includes(na))) return { verified: true, note: `the page stored it as "${a.slice(0, 40)}"` };
    return { verified: false };
  }

  async function fillText(field, value) {
    const el = field.el;
    if (el.isContentEditable) {
      el.focus?.();
      el.textContent = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, ...accepted(el.textContent, value) };
    }
    el.focus?.();
    setNative(el, String(value));
    el.blur?.();
    return { ok: true, ...accepted(el.value, value) };
  }

  function groupChoiceChecked(el, optionText) {
    const name = el.getAttribute?.('name') || '';
    const group = name.replace(/-\d{1,2}$/, '');
    if (!group) return false;
    const root = rootOf(el) || document;
    const nw = norm(optionText);
    for (const other of root.querySelectorAll('input[type="checkbox"], input[type="radio"]')) {
      const otherName = (other.getAttribute('name') || '').replace(/-\d{1,2}$/, '');
      if (otherName !== group) continue;
      if (other !== el && norm(optionLabel(other)) !== nw) continue;
      if (other.checked) return true;
      const holder = other.closest?.('[aria-checked="true"]');
      if (holder) return true;
    }
    return false;
  }

  async function fillSelect(field, value) {
    const el = field.el;
    const texts = Array.from(el.options).map((o) => clean(o.textContent) || o.value);
    const byValue = Array.from(el.options).findIndex((o) => norm(o.value) === norm(value));
    const best = byValue >= 0 ? { index: byValue, score: 3, text: texts[byValue] } : bestOption(texts, value);
    if (!best) return { ok: false, verified: false, note: `no option resembling "${value}"`, options: texts.slice(0, 12) };
    const option = el.options[best.index];
    setNative(el, option.value);
    return {
      ok: true,
      verified: el.value === option.value,
      exact: best.score === 3,
      chosen: best.text,
      note: best.score === 3 ? null : `closest option to "${value}"`,
    };
  }

  async function fillChoice(field, value) {
    const labels = field.els.map((el) => optionLabel(el));
    const best = bestOption(labels, value);
    if (best) {
      const target = field.els[best.index];
      // MUI radios/checkboxes ignore a programmatic `checked = true`; they need a
      // real click. Click the native input (the wrapping label's default action
      // forwards to it, but the native input is the most reliable target for a
      // controlled component) and give React time to re-render before reading.
      target.click();
      await tick(250);
      // A group that re-renders on selection (Gupy's MULTI_SELECTs replace their
      // inputs after a click) leaves our node detached, so `.checked` reads false
      // even though the answer was recorded. Re-read the group from the document by
      // the option's own label before concluding the click failed.
      let checked = !!target.checked;
      if (!checked) {
        await tick(200);
        checked = groupChoiceChecked(target, best.text);
      }
      if (!checked) {
        // Last resort: click the visible label/box around the input rather than the
        // (often visually hidden) input itself.
        const box = target.closest?.('label') || target.parentElement;
        if (box) {
          box.click();
          await tick(250);
          checked = !!target.checked || groupChoiceChecked(target, best.text);
        }
      }
      return { ok: true, verified: checked, exact: best.score === 3, chosen: best.text, note: best.score === 3 ? null : `closest option to "${value}"` };
    }
    // No option matched. For a single checkbox this is still a meaningful answer:
    // - an explicit "false"/"não"/"no" (the model unchecking a multi-select box),
    // - the "Sim" half of Gupy's Sim/Não checkbox pair when the answer is "Não".
    // Both mean "leave this box unchecked".
    if (field.els.length === 1 && field.els[0].type === 'checkbox') {
      const el = field.els[0];
      const nv = norm(value);
      const own = norm(labels[0] || '');
      const neg = /^(false|0|nao|n[aã]o|no)$/.test(nv);
      const yesNoPair = /^(sim|nao|n[aã]o|yes|no)$/.test(own);
      if (neg || yesNoPair) {
        if (el.checked) { el.click(); await tick(80); }
        return { ok: true, verified: !el.checked, note: 'left unchecked' };
      }
    }
    return { ok: false, verified: false, note: `no option resembling "${value}"`, options: labels.slice(0, 12) };
  }

  async function fillChoiceAria(field, value) {
    const labels = field.options;
    const best = bestOption(labels, value);
    if (!best) return { ok: false, verified: false, note: `no option resembling "${value}"`, options: labels.slice(0, 12) };
    const target = field.els[best.index];
    target.click();
    await tick(60);
    // Native <input type=radio|checkbox> report state via `.checked`; ARIA radios
    // (role="radio" on a div) via aria-checked. Cover both.
    const checked = target.getAttribute?.('aria-checked') === 'true' || target.checked === true;
    return { ok: true, verified: checked, exact: best.score === 3, chosen: best.text, note: best.score === 3 ? null : `closest option to "${value}"` };
  }

  // Read the currently rendered options of an open listbox.
  function readOptions(list) {
    const optionEls = Array.from(list.querySelectorAll('[role="option"], li, [data-value], [class*="__option"]')).filter(isVisible);
    return { optionEls, labels: optionEls.map((o) => clean(o.getAttribute('aria-label') || o.textContent)) };
  }

  async function fillCombobox(field, value) {
    const el = field.el;
    const input = el.tagName === 'INPUT' ? el : el.querySelector('input:not([type=hidden])');

    // Order matters for react-select. Typing first filters the menu — and react-select
    // only filters on real key input, so setNative left it showing nothing and every
    // option "failed". Open first, choose from the full list; type only as a fallback
    // when the open list has no match.
    for (let attempt = 0; attempt < 2; attempt++) {
      await openCombobox(el, input);
      let list = resolveListbox(el);
      if (list) {
        let { optionEls, labels } = readOptions(list);
        let best = bestOption(labels, value);
        if (!best && attempt === 0 && input) {
          // Long/unsorted lists: narrow by typing, then re-read.
          setNative(input, String(value));
          input.dispatchEvent(new KeyboardEvent('keydown', { key: value[0] || 'a', bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keyup', { key: value[0] || 'a', bubbles: true }));
          await tick(350);
          const narrowed = resolveListbox(el);
          if (narrowed) {
            optionEls = readOptions(narrowed).optionEls;
            labels = readOptions(narrowed).labels;
            best = bestOption(labels, value);
          }
        }
        if (best) {
          await press(optionEls[best.index]);
          await tick(220);
          // Close the dropdown before the caller asks the form to advance.
          //
          // MUI's Autocomplete (and react-select in some modes) leaves the list open
          // after an option is clicked. The input then shows the right value while the
          // popup still overlays the page: "Salvar e continuar" is visible and enabled,
          // the click lands on the popup instead, and the wizard reports "form did not
          // advance past this step" — a required field that looks filled but never
          // committed. Gupy's "Onde você encontrou essa vaga?" step failed this way on
          // every application that reached it.
          await closeListbox(el, input);
          const shown = clean(
            controlOf(el).querySelector?.('[class*="__single-value"], [class*="singleValue"]')?.textContent ||
              input?.value ||
              el.textContent ||
              '',
          );
          const verified =
            scoreOption(shown, best.text) >= 2 || scoreOption(shown, value) >= 2 || best.score >= 2;
          return {
            ok: true,
            verified,
            exact: best.score === 3,
            chosen: best.text,
            note: best.score === 3 ? null : `closest option to "${value}"`,
          };
        }
        if (attempt === 1) {
          close(el, input);
          return { ok: false, verified: false, note: `dropdown had no option resembling "${value}"`, options: labels.slice(0, 12) };
        }
      }
      if (attempt === 1) break;
    }
    // No listbox anywhere after pressing and typing. On a page whose select widget
    // never renders a menu (a plain input styled as a combobox, or a saved/offline
    // copy of the form) the typed text IS the control's value, so accept it when the
    // page kept it verbatim. On a live react-select/MUI form the menu opens above, so
    // this path is not reached and cannot mask an unselected option.
    close(el, input);
    if (input) {
      setNative(input, String(value));
      await tick(150);
      const typed = clean(input.value || '');
      const kept = accepted(typed, value);
      if (kept.verified) return { ok: true, ...kept, note: kept.note || 'typed into a combobox with no rendered menu' };
    }
    const shown = clean(input?.value || el.textContent || '');
    const already = accepted(shown, value);
    if (already.verified) return { ok: true, ...already };
    return { ok: false, verified: false, note: `dropdown did not open — option "${value}" was not selected` };
  }

  // react-select (used by Greenhouse's job boards and by many Gupy widgets) does not
  // put role="listbox" on its menu — it renders class="select__menu" / "__menu" with
  // children classed "__option", and only after the control is pressed. Matching those
  // class names is what makes custom selects fillable at all.
  const LISTBOX_SEL =
    '[role="listbox"], [class*="select__menu"], [class*="__menu-list"], [class*="menu-list"], [class*="options" i]';

  function controlOf(el) {
    // The inner <input> itself carries role="combobox" on react-select, so matching
    // role first returned the input and the mousedown never reached the control that
    // actually opens the menu. Prefer the control wrapper by class.
    return (
      el.closest?.('[class*="__control"], [class*="control"]') ||
      el.closest?.('[role="combobox"]') ||
      el.parentElement ||
      el
    );
  }

  function resolveListbox(el) {
    const root = el.getRootNode?.() || document;
    const id = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
    if (id) {
      const byId = root.getElementById?.(id) || document.getElementById(id);
      if (byId && isVisible(byId)) return byId;
    }
    const own = el.querySelector(LISTBOX_SEL);
    if (own && isVisible(own) && own.children.length) return own;
    const control = controlOf(el);
    const near = control.parentElement?.querySelector(LISTBOX_SEL);
    if (near && isVisible(near) && near.children.length) return near;
    const candidates = Array.from(document.querySelectorAll(LISTBOX_SEL)).filter((n) => isVisible(n) && n.children.length);
    return candidates.pop() || null;
  }

  // Open a custom select the way a human does: press the control wrapper, not the
  // inner input (react-select listens on the control's onMouseDown).
  async function press(node) {
    if (!node || typeof node.dispatchEvent !== 'function') return;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const Ctor = type.startsWith('pointer') ? (typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent) : MouseEvent;
      node.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window }));
    }
  }

  // Press the control the way a human does. react-select wires its open handler on
  // the control wrapper; MUI/others on the input; some builds on the container. Try
  // the whole chain rather than guessing one, stopping as soon as the menu appears.
  async function openCombobox(el, input) {
    const control = controlOf(el);
    const chain = [control, control.parentElement, input, input && input.parentElement, el].filter(Boolean);
    for (const node of chain) {
      await press(node);
      if (input && node === input) input.focus?.();
      await tick(180);
      if (resolveListbox(el)) return;
    }
  }

  function close(el, input) {
    const target = input || el;
    target.dispatchEvent?.(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }

  // Close an open dropdown properly, then confirm it is gone.
  //
  // Escape alone is not enough: the popup closes on the browser's default action, which
  // a synthetic event never triggers, and the control keeps focus so it can reopen. The
  // sequence below is what a person does: Escape, then move focus away.
  async function closeListbox(el, input) {
    const target = input || controlOf(el) || el;
    try {
      target.dispatchEvent?.(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
      target.dispatchEvent?.(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
      await tick(120);
      target.blur?.();
      // A blur alone may leave a portal-rendered menu mounted; a click on neutral
      // territory makes the owner close it on the outside-click handler.
      if (resolveListbox(el)) {
        const neutral = document.querySelector('main h1, main h2, form') || document.body;
        neutral.dispatchEvent?.(new MouseEvent('mousedown', { bubbles: true }));
        neutral.dispatchEvent?.(new MouseEvent('mouseup', { bubbles: true }));
        neutral.dispatchEvent?.(new MouseEvent('click', { bubbles: true }));
        await tick(150);
      }
    } catch {
      /* closing is best-effort; the caller verifies the value separately */
    }
  }

  async function fillByKind(field, value) {
    if (value == null || value === '') return { ok: false, verified: false, note: 'no value' };
    switch (field.kind) {
      case 'select': return fillSelect(field, value);
      case 'choice': return fillChoice(field, value);
      case 'boolean': return fillChoice(field, value);
      case 'choice-aria': return fillChoiceAria(field, value);
      case 'combobox': return fillCombobox(field, value);
      case 'file': return { ok: false, verified: false, note: 'file inputs are filled via attachResume' };
      default: return fillText(field, value);
    }
  }

  /* ---------------------------------------------------------------- scan */

  const registry = [];

  function scan() {
    const found = deepQuery(`${NATIVE}, ${ARIA}`);
    const stats = { ...found.stats, seen: found.elements.length, hidden: 0, unlabeled: 0, disabled: 0 };
    const fields = [];
    const seenUids = {};
    const consumed = new Set();
    registry.length = 0;

    for (const el of found.elements) {
      if (consumed.has(el)) continue;
      const kind = kindOf(el);
      if (!kind) continue;
      if (el.disabled || el.readOnly) { stats.disabled++; continue; }
      if (!isVisible(el)) { stats.hidden++; continue; }
      const wrapper = el.closest?.('[role="combobox"], [role="radiogroup"]');
      if (wrapper && wrapper !== el) continue;

      if (kind === 'choice') {
        const group = groupKey(el) || groupLabel(el);
        const members = found.elements.filter((x) => kindOf(x) === 'choice' && (groupKey(x) || groupLabel(x)) === group);
        members.forEach((m) => consumed.add(m));
        const label = groupLabel(el);
        if (!label) { stats.unlabeled++; continue; }
        const full = {
          uid: makeUid(el, label, seenUids),
          kind: members[0]?.type === 'checkbox' && members.length === 1 ? 'boolean' : 'choice',
          el,
          els: members,
          label: label.slice(0, 400),
          options: members.map((m) => optionLabel(m)),
          required: isRequired(el) || /\*|obrigat[oó]rio|required/i.test(label),
          name: el.getAttribute('name') || '',
        };
        const index = registry.length;
        registry.push(full);
        fields.push(descriptor(index, full));
        continue;
      }

      if (kind === 'choice-aria') {
        let members = Array.from(el.querySelectorAll('[role="radio"], [role="option"]'));
        let native = false;
        if (!members.length) {
          // MUI RadioGroup wraps native <input type=radio|checkbox> WITHOUT an
          // explicit role="radio", so the ARIA query comes back empty. Fall back to
          // the native inputs or the whole question is left unfilled.
          members = Array.from(el.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
          native = members.length > 0;
        }
        if (!members.length) continue;
        members.forEach((m) => consumed.add(m));
        const label = groupLabel(el) || labelFor(el);
        if (!label) { stats.unlabeled++; continue; }
        const full = {
          uid: makeUid(el, label, seenUids),
          kind: 'choice-aria',
          el,
          els: members,
          label: label.slice(0, 400),
          options: members.map((m) => (native ? optionLabel(m) : clean(m.getAttribute('aria-label') || m.textContent))),
          required: isRequired(el) || /\*|obrigat[oó]rio|required/i.test(label),
          name: el.getAttribute('name') || '',
        };
        const index = registry.length;
        registry.push(full);
        fields.push(descriptor(index, full));
        continue;
      }

      const label = labelFor(el);
      if (!label) { stats.unlabeled++; continue; }
      consumed.add(el);
      const full = {
        uid: makeUid(el, label, seenUids),
        kind,
        el,
        els: [el],
        label: label.slice(0, 400),
        options: optionsOf(el),
        required: isRequired(el),
        name: el.getAttribute('name') || '',
        maxLength: Number(el.getAttribute('maxlength')) || null,
        inputType: (el.type || '').toLowerCase(),
      };
      const index = registry.length;
      registry.push(full);
      fields.push(descriptor(index, full));
    }

    return { adapterId: detect(), fields, stats };
  }

  function descriptor(index, full) {
    return {
      index,
      uid: full.uid,
      kind: full.kind,
      label: full.label,
      options: full.options,
      required: full.required,
      name: full.name,
      inputType: full.inputType,
      maxLength: full.maxLength ?? null,
    };
  }

  function fill(index, value) {
    const field = registry[index];
    if (!field) return Promise.resolve({ ok: false, verified: false, note: `unknown field index ${index}` });
    return fillByKind(field, value);
  }

  /* ----------------------------------------------------------- adapters */

  const SIGNATURES = [
    { id: 'greenhouse', test: () => !!document.querySelector('#application-form, #resume[type="file"], [data-testid="resume-dropbox"]') || /greenhouse\.io/.test(location.hostname) },
    { id: 'gupy', test: () => /gupy\.io/.test(location.hostname) || !!document.querySelector('[class*="gupy" i], [data-testid*="gupy" i]') || /Gupy/.test(document.title) },
    { id: 'inhire', test: () => /inhire\./i.test(location.hostname) || !!document.querySelector('[class*="inhire" i]') },
    { id: 'lever', test: () => /jobs\.lever\.co/.test(location.href) || !!document.querySelector('.application-form') },
    { id: 'ashby', test: () => /ashbyhq\.com/.test(location.href) || !!document.querySelector('[class*="ashby" i]') },
  ];

  function detect() {
    for (const sig of SIGNATURES) {
      try { if (sig.test()) return sig.id; } catch (_) {}
    }
    return 'generic';
  }

  function resumeInput() {
    return (
      document.querySelector('#resume[type="file"]') ||
      document.querySelector('input[type="file"][accept*="pdf" i]') ||
      document.querySelector('input[type="file"]')
    );
  }

  /* Gupy's full form sometimes leaves a stuck overlay (a styled backdrop
   * `div.sc-dPZUQH` plus a `div.sc-ktPPKK[data-state="open"]` container, or a
   * Radix dialog/toast) that intercepts pointer events over the "Salvar e
   * continuar" button. Remove those — but never the application form itself —
   * before advancing. */
  function dismissOverlay() {
    const kill = (el) => el.remove();
    document.querySelectorAll('div.sc-dPZUQH, div.sc-ktPPKK[data-state="open"]').forEach(kill);
    document.querySelectorAll('[data-state="open"][role="dialog"]').forEach((el) => {
      const holdsForm = el.querySelector('form, input, select, textarea, [role="combobox"], [role="radiogroup"], [contenteditable]');
      if (!holdsForm) kill(el);
    });
    document.querySelectorAll('[data-radix-popper-content-wrapper]').forEach((el) => {
      if (!el.querySelector('form, input, select, textarea, [role="dialog"]')) kill(el);
    });
  }

  async function attachResume(base64, filename) {
    const input = resumeInput();
    if (!input) return { ok: false, reason: 'no file input on this page' };
    if (!base64) return { ok: false, reason: 'no resume bytes provided' };
    try {
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const file = new File([bytes], filename, { type: 'application/pdf' });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: input.files?.length === 1, filename };
    } catch (e) {
      return { ok: false, reason: String(e.message || e) };
    }
  }

  // Open a combobox and read the options it renders. React-Select and Greenhouse's
  // custom selects render nothing until clicked, so scan() reports an empty option
  // list — and a model given no options can only refuse the field, which leaves a
  // required question unfillable. Harvesting them lazily (only for comboboxes that
  // scanned empty) keeps the common path cheap.
  async function harvestOptions(index) {
    const field = registry[index];
    if (!field) return { ok: false, note: 'no such field', options: [] };
    const el = field.el;
    const input = el.tagName === 'INPUT' ? el : el.querySelector?.('input');
    let list = null;
    for (let i = 0; i < 4 && !list; i++) {
      await openCombobox(el, input);
      list = resolveListbox(el);
    }
    if (!list) {
      close(el, input);
      return { ok: false, note: 'dropdown did not open', options: [] };
    }
    const labels = Array.from(list.querySelectorAll('[role="option"], li, [data-value]'))
      .filter(isVisible)
      .map((o) => clean(o.getAttribute('aria-label') || o.textContent))
      .filter(Boolean);
    close(el, input);
    await tick(120);
    return { ok: true, options: labels.slice(0, 60) };
  }

  window.__jfa = { scan, fill, attachResume, detect, resumeInput, dismissOverlay, harvestOptions };
})();
