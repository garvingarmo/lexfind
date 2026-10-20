(() => {
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content;

  // Confirm before destructive form submits.
  document.addEventListener('submit', (e) => {
    const msg = e.submitter?.dataset.confirm || e.target.dataset.confirm;
    if (msg && !confirm(msg)) e.preventDefault();
  });

  // "Select all" for checkbox groups.
  document.querySelectorAll('[data-check-all]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll(`input[name="${btn.dataset.checkAll}"]`).forEach((c) => { c.checked = true; });
    });
  });

  // Copy the link in the input next to a [data-copy] button.
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const input = btn.parentElement.querySelector('input');
      try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand('copy'); }
      const label = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = label; }, 1500);
    });
  });

  // Bulk actions on the admin lawyers list.
  const bulk = document.getElementById('bulk-form');
  if (bulk) {
    const items = [...bulk.querySelectorAll('.bulk-item')];
    const all = document.getElementById('bulk-all');
    const action = document.getElementById('bulk-action');
    const area = document.getElementById('bulk-area');
    const apply = document.getElementById('bulk-apply');
    const count = document.getElementById('bulk-count');
    const refresh = () => {
      const n = items.filter((c) => c.checked).length;
      count.textContent = n;
      all.checked = n > 0 && n === items.length;
      all.indeterminate = n > 0 && n < items.length;
      const needsArea = action.value === 'add_area' || action.value === 'remove_area';
      area.hidden = !needsArea;
      apply.disabled = !n || !action.value || (needsArea && !area.value);
      apply.classList.toggle('btn-danger', action.value === 'delete');
    };
    all.addEventListener('change', () => { items.forEach((c) => { c.checked = all.checked; }); refresh(); });
    items.forEach((c) => c.addEventListener('change', refresh));
    action.addEventListener('change', refresh);
    area.addEventListener('change', refresh);
    bulk.addEventListener('submit', (e) => {
      const n = items.filter((c) => c.checked).length;
      const label = action.options[action.selectedIndex].text;
      const who = `${n} lawyer${n === 1 ? '' : 's'}`;
      const areaName = area.value ? area.options[area.selectedIndex].text : '';
      const msg = {
        delete: `Permanently delete ${who}, with their logins and inquiries? This cannot be undone.`,
        add_area: `Add "${areaName}" to ${who}?`,
        remove_area: `Remove "${areaName}" from ${who}?`,
      }[action.value] || `${label} for ${who}?`;
      if (!confirm(msg)) e.preventDefault();
    });
    refresh();
  }

  // --- Edit page mode (admins): click outlined text, type, then save ------------------------
  if (document.body.classList.contains('edit-mode')) {
    const changed = new Map();
    const saveBtn = document.getElementById('edit-save');
    const countEl = document.getElementById('edit-count');
    const update = () => {
      saveBtn.disabled = !changed.size;
      countEl.textContent = changed.size ? `${changed.size} change${changed.size === 1 ? '' : 's'} not saved` : '';
    };
    document.querySelectorAll('.editable').forEach((el) => {
      el.setAttribute('contenteditable', 'plaintext-only');
      if (el.contentEditable !== 'plaintext-only') el.setAttribute('contenteditable', 'true');
      el.spellcheck = true;
      el.dataset.original = el.textContent;
      el.addEventListener('input', () => {
        const key = el.dataset.editKey;
        const value = el.innerText.replace(/\n{3,}/g, '\n\n');
        // The same text can appear twice on a page (e.g. the disclaimer); keep copies in sync.
        document.querySelectorAll(`.editable[data-edit-key="${key}"]`).forEach((o) => { if (o !== el) o.textContent = value; });
        if (value === el.dataset.original) changed.delete(key); else changed.set(key, value);
        el.classList.toggle('edited', changed.has(key));
        update();
      });
      el.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey && el.closest('h1,h2,h3,h4,a,button,strong,label,.btn')) { ev.preventDefault(); el.blur(); }
      });
    });
    // Clicking text inside a link or button edits it instead of following it.
    document.addEventListener('click', (ev) => {
      if (ev.target.closest('.editable')) { ev.preventDefault(); ev.stopPropagation(); }
    }, true);
    document.addEventListener('submit', (ev) => {
      if (!ev.target.closest('#edit-bar')) { ev.preventDefault(); alert('Finish editing first: click Save changes or Done.'); }
    }, true);
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        const r = await fetch('/admin/texts.json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify({ changes: Object.fromEntries(changed) }),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Save failed');
        changed.clear();
        document.querySelectorAll('.editable').forEach((el) => { el.dataset.original = el.textContent; el.classList.remove('edited'); });
        saveBtn.textContent = 'Saved ✓';
        setTimeout(() => { saveBtn.textContent = 'Save changes'; update(); }, 1500);
      } catch (e) {
        alert(`Could not save: ${e.message}`);
        saveBtn.textContent = 'Save changes';
        update();
      }
    });
    window.addEventListener('beforeunload', (ev) => { if (changed.size) { ev.preventDefault(); ev.returnValue = ''; } });
  }

  // --- Admin → Texts: filter the list --------------------------------------------------------
  const textFilter = document.getElementById('text-filter');
  if (textFilter) {
    const apply = () => {
      const q = textFilter.value.trim().toLowerCase();
      document.querySelectorAll('.text-row').forEach((row) => { row.hidden = q && !row.dataset.search.includes(q); });
      document.querySelectorAll('.text-group').forEach((g) => { g.hidden = q && !g.querySelector('.text-row:not([hidden])'); });
    };
    textFilter.addEventListener('input', apply);
    apply();
  }

  // --- Admin → Homepage: reorder sections -----------------------------------------------------
  const sectionList = document.getElementById('section-list');
  if (sectionList) {
    const order = document.getElementById('sections-order');
    const sync = () => { order.value = [...sectionList.children].map((li) => li.dataset.id).join(','); };
    sectionList.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-move]');
      if (!btn) return;
      const li = btn.closest('li');
      if (btn.dataset.move === '-1' && li.previousElementSibling) li.parentNode.insertBefore(li, li.previousElementSibling);
      if (btn.dataset.move === '1' && li.nextElementSibling) li.parentNode.insertBefore(li.nextElementSibling, li);
      sync();
      btn.focus();
    });
  }

  // --- Admin → Appearance: live preview ----------------------------------------------------
  const preview = document.getElementById('theme-preview');
  if (preview) {
    const form = document.getElementById('appearance-form');
    const font = document.getElementById('theme-font');
    const hero = document.getElementById('pv-hero');
    const shade = (hex, t) => {
      const n = parseInt(hex.slice(1), 16);
      return `#${[n >> 16, (n >> 8) & 255, n & 255].map((c) => Math.round(t >= 0 ? c + (255 - c) * t : c * (1 + t)).toString(16).padStart(2, '0')).join('')}`;
    };
    const setHero = (url) => {
      const p = form.theme_primary.value;
      hero.style.backgroundImage = url
        ? `linear-gradient(160deg, ${p}b8 0%, ${shade(p, -0.35)}d9 100%), url("${url}")`
        : `linear-gradient(160deg, ${p} 0%, ${shade(p, -0.3)} 100%)`;
    };
    const apply = () => {
      const p = form.theme_primary.value;
      preview.style.setProperty('--primary', p);
      preview.style.setProperty('--primary-soft', shade(p, 0.88));
      preview.style.setProperty('--accent', form.theme_accent.value);
      const opt = font.options[font.selectedIndex];
      preview.style.setProperty('--serif', `'${opt.dataset.heading}', Georgia, serif`);
      preview.style.setProperty('--sans', `'${opt.dataset.body}', system-ui, sans-serif`);
      setHero(hero.dataset.image);
      document.getElementById('pv-name').hidden = Boolean(document.querySelector('#pv-logo img')) && !document.getElementById('logo-text').checked;
    };
    form.addEventListener('input', apply);
    form.addEventListener('change', apply);
    const previewFile = (input, onUrl) => input.addEventListener('change', () => {
      const f = input.files[0];
      if (!f) return;
      const reader = new FileReader(); // data: URLs are allowed by the site's image policy; blob: URLs are not
      reader.onload = () => onUrl(reader.result);
      reader.readAsDataURL(f);
    });
    previewFile(document.getElementById('logo-file'), (url) => {
      const box = document.getElementById('pv-logo');
      box.replaceChildren(Object.assign(document.createElement('img'), { src: url, alt: '' }));
      apply();
    });
    previewFile(document.getElementById('hero-file'), (url) => { hero.dataset.image = url; apply(); });
    apply();
  }

  // --- Visual blog editor ---------------------------------------------------------------------
  const rte = document.getElementById('rte-area');
  if (rte) {
    const body = document.getElementById('rte-body');
    const imageInput = document.getElementById('rte-image');
    let savedRange = null;
    const remember = () => { const sel = getSelection(); if (sel.rangeCount && rte.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0); };
    const restore = () => { rte.focus(); if (savedRange) { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(savedRange); } };
    rte.addEventListener('keyup', remember);
    rte.addEventListener('mouseup', remember);
    document.execCommand('defaultParagraphSeparator', false, 'p');
    if (!rte.innerHTML.trim()) rte.innerHTML = '<p><br></p>'; // so the first line is a paragraph too
    rte.closest('form').addEventListener('submit', () => {
      rte.querySelectorAll('p').forEach((el) => { if (!el.textContent.trim() && !el.querySelector('img')) el.remove(); });
    });
    document.querySelector('.rte-toolbar').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-cmd]');
      if (!btn) return;
      const { cmd, arg } = btn.dataset;
      restore();
      if (cmd === 'link') {
        const url = prompt('Link address (https://…, or /lawyers for a page on this site):', 'https://');
        if (url && url !== 'https://') document.execCommand('createLink', false, url);
      } else if (cmd === 'image') {
        imageInput.click();
      } else {
        document.execCommand(cmd, false, arg ? `<${arg}>` : null);
      }
      remember();
    });
    imageInput.addEventListener('change', async () => {
      const file = imageInput.files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('_csrf', csrf);
      fd.append('image', file);
      try {
        const r = await fetch('/admin/uploads/image', { method: 'POST', body: fd, headers: { Accept: 'application/json' } });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Upload failed');
        restore();
        document.execCommand('insertImage', false, data.url);
      } catch (e) {
        alert(e.message);
      }
      imageInput.value = '';
    });
    // Paste as plain text so formatting from Word or web pages doesn't come along.
    rte.addEventListener('paste', (ev) => {
      ev.preventDefault();
      document.execCommand('insertText', false, ev.clipboardData.getData('text/plain'));
    });
    rte.closest('form').addEventListener('submit', () => { body.value = rte.innerHTML; });
  }

  // Checkbox dropdowns (e.g. Languages): show the ticked items in the summary, close on outside click.
  document.querySelectorAll('details.multi-select').forEach((d) => {
    const summary = d.querySelector('summary');
    const sync = () => {
      const picked = [...d.querySelectorAll('input[type=checkbox]:checked')].map((c) => c.value);
      summary.textContent = picked.join(', ') || d.dataset.placeholder;
    };
    d.addEventListener('change', sync);
    document.addEventListener('click', (ev) => { if (d.open && !d.contains(ev.target)) d.open = false; });
  });

  // Poll a running AI research job and reload when it finishes.
  const wait = document.getElementById('research-wait');
  if (wait) {
    const poll = async () => {
      try {
        const r = await fetch(wait.dataset.statusUrl, { headers: { Accept: 'application/json' } });
        const { status } = await r.json();
        if (status !== 'running') return location.reload();
      } catch { /* retry */ }
      setTimeout(poll, 4000);
    };
    setTimeout(poll, 4000);
  }

  // --- AI assistant chat ---------------------------------------------------
  const chat = document.getElementById('chat');
  if (!chat) return;
  const log = document.getElementById('chat-log');
  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  const send = document.getElementById('chat-send');

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  // Render the assistant's reply: paragraphs, bullet lists and **bold**, built as DOM nodes (no innerHTML).
  function renderText(container, text) {
    let list = null;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) { list = null; continue; }
      const bullet = line.match(/^[-*•]\s+(.*)/) || line.match(/^\d+[.)]\s+(.*)/);
      let target;
      if (bullet) {
        if (!list) { list = el('ul'); container.appendChild(list); }
        target = el('li'); list.appendChild(target);
      } else {
        list = null;
        target = el('p'); container.appendChild(target);
      }
      const content = (bullet ? bullet[1] : line).replace(/^#+\s*/, '');
      content.split(/(\*\*[^*]+\*\*)/).forEach((part) => {
        if (/^\*\*[^*]+\*\*$/.test(part)) target.appendChild(el('strong', null, part.slice(2, -2)));
        else if (part) target.appendChild(document.createTextNode(part));
      });
    }
  }

  function addMsg(who, text) {
    const m = el('div', `msg msg-${who}`);
    const b = el('div', 'bubble');
    if (who === 'bot') renderText(b, text); else b.textContent = text;
    m.appendChild(b);
    log.appendChild(m);
    m.scrollIntoView({ behavior: 'smooth', block: 'end' });
    return m;
  }

  function lawyerCard(r) {
    const card = el('article', 'card lawyer-card rec-card');
    const head = el('div', 'lawyer-card-head');
    if (r.photo) {
      const img = el('img', 'avatar'); img.src = r.photo; img.alt = r.name; head.appendChild(img);
    } else {
      head.appendChild(el('div', 'avatar avatar-initials', r.name.split(' ').map((s) => s[0]).slice(0, 2).join('')));
    }
    const info = el('div');
    const h = el('h3');
    const a = el('a', null, r.name); a.href = `/lawyers/${r.slug}?from=ai`;
    h.appendChild(a);
    if (r.verified) h.appendChild(el('span', 'verified', ' ✓'));
    info.appendChild(h);
    info.appendChild(el('div', 'muted small', r.firm || ''));
    info.appendChild(el('div', 'small', [r.city, r.state].filter(Boolean).join(', ')));
    head.appendChild(info);
    card.appendChild(head);
    card.appendChild(el('p', 'rec-reason', r.reason));
    const tags = el('div', 'tags');
    r.areas.forEach((t) => tags.appendChild(el('span', 'tag', t)));
    card.appendChild(tags);
    const facts = el('ul', 'facts small');
    if (r.years_experience) facts.appendChild(el('li', null, `${r.years_experience} yrs experience`));
    if (r.languages) facts.appendChild(el('li', null, r.languages));
    if (r.free_consultation) facts.appendChild(el('li', 'ok', 'Free consultation'));
    card.appendChild(facts);
    const btn = el('a', 'btn btn-primary btn-block', 'View profile & contact');
    btn.href = `/lawyers/${r.slug}?from=ai#contact`;
    card.appendChild(btn);
    return card;
  }

  async function sendMessage(text) {
    addMsg('user', text);
    input.value = '';
    send.disabled = true;
    const typing = addMsg('bot', 'Looking through the directory…');
    typing.classList.add('typing');
    try {
      const r = await fetch('/api/assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ message: text }),
      });
      const data = await r.json();
      typing.remove();
      if (!r.ok) { addMsg('bot', data.error || 'Something went wrong.'); return; }
      if (data.reply) addMsg('bot', data.reply);
      if (data.recommendations?.length) {
        const grid = el('div', 'rec-grid');
        data.recommendations.forEach((rec) => grid.appendChild(lawyerCard(rec)));
        log.appendChild(grid);
        grid.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } catch {
      typing.remove();
      addMsg('bot', 'Network error — please try again.');
    } finally {
      send.disabled = false;
      input.focus();
    }
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (text && !send.disabled) sendMessage(text);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  document.getElementById('chat-reset').addEventListener('click', async () => {
    await fetch('/api/assistant/reset', { method: 'POST', headers: { 'x-csrf-token': csrf } });
    [...log.children].slice(1).forEach((n) => n.remove());
    input.focus();
  });

  const initial = chat.dataset.initial;
  if (initial) {
    // Start a fresh conversation for a question submitted from the home page.
    fetch('/api/assistant/reset', { method: 'POST', headers: { 'x-csrf-token': csrf } }).then(() => sendMessage(initial));
    history.replaceState(null, '', '/assistant');
  }
})();
