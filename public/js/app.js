(() => {
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content;

  // Confirm before destructive form submits.
  document.addEventListener('submit', (e) => {
    const msg = e.target.dataset.confirm;
    if (msg && !confirm(msg)) e.preventDefault();
  });

  // "Select all" for checkbox groups.
  document.querySelectorAll('[data-check-all]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll(`input[name="${btn.dataset.checkAll}"]`).forEach((c) => { c.checked = true; });
    });
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
