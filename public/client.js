// Yalla Play — logique front : gestion des écrans et des événements Socket.io
const socket = io();

const $ = id => document.getElementById(id);

const GAME_NAMES = {
  whois: 'Yalla, Qui ?',
  assoc: 'Yalla Vite',
  bluff: 'Sa7 ou Fake',
  traduis: 'Yalla, Traduis !',
  bottle: 'Yalla, Tourne !',
  undercover: 'Undercover'
};

// La bouteille, goulot vers le haut (la rotation se fait autour de son centre)
const BOTTLE_SVG = `<svg viewBox="0 0 60 200" aria-hidden="true">
  <path d="M24 6h12v8c0 4 2 6 2 12v14c0 10 14 22 14 40v104c0 6-4 10-10 10H18c-6 0-10-4-10-10V80c0-18 14-30 14-40V26c0-6 2-8 2-12z"
    fill="#2F8F5B" stroke="#1E1A16" stroke-width="3" stroke-linejoin="round"/>
  <rect x="22" y="2" width="16" height="10" rx="2" fill="#1E1A16"/>
  <rect x="12" y="104" width="36" height="46" rx="3" fill="#F4EFE6" stroke="#1E1A16" stroke-width="2.5"/>
  <path d="M17 86v86" stroke="#FFFFFF" stroke-opacity=".35" stroke-width="5" stroke-linecap="round"/>
</svg>`;

let me = null;          // mon id socket
let hostId = null;
let players = [];
let state = null;       // dernier état reçu du serveur
let clockOffset = 0;    // différence entre l'horloge du serveur et celle du tel
let timerInterval = null;

// État local du round en cours (remis à zéro à chaque nouveau round)
let local = {};
let localRound = null;

const isHost = () => me && me === hostId;

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function show(screen) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === `screen-${screen}`));
}

let toastTimeout;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => t.classList.remove('show'), 2800);
}

// ---------- Accueil ----------

const nameInput = $('name');
const codeInput = $('code');
try { nameInput.value = localStorage.getItem('yalla-name') || ''; } catch (e) {}

function getName() {
  const n = nameInput.value.trim();
  if (!n) { toast("Entre ton prénom d'abord."); nameInput.focus(); return null; }
  try { localStorage.setItem('yalla-name', n); } catch (e) {}
  return n;
}

$('btn-create').onclick = () => {
  const name = getName();
  if (name) socket.emit('create-room', { name });
};

$('btn-join').onclick = () => {
  const name = getName();
  if (!name) return;
  const code = codeInput.value.trim().toUpperCase();
  if (code.length !== 4) { toast('Le code fait 4 lettres.'); codeInput.focus(); return; }
  socket.emit('join-room', { name, code });
};

codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, ''); });
codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-join').click(); });

// Lien direct ?code=ABCD pour rejoindre plus vite
const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode) codeInput.value = urlCode.toUpperCase().slice(0, 4);

// ---------- Lobby ----------

document.querySelectorAll('.game-btn').forEach(btn => {
  btn.onclick = () => socket.emit('start-game', { game: btn.dataset.game });
});

$('btn-next').onclick = () => socket.emit('next-round');
$('btn-menu').onclick = () => socket.emit('back-to-menu');

function renderPlayers() {
  const sorted = [...players].sort((a, b) => b.score - a.score);
  const html = sorted.map(p => `
    <li class="${p.id === me ? 'me' : ''}">
      <span class="pname">${esc(p.name)}</span>
      ${p.id === hostId ? '<span class="tag">hôte</span>' : ''}
      <span class="score">${p.score} pts</span>
    </li>`).join('');
  $('lobby-players').innerHTML = html;
  $('game-players').innerHTML = html;
  $('host-menu').classList.toggle('hidden', !isHost());
  $('guest-wait').classList.toggle('hidden', isHost());
}

// ---------- Socket ----------

socket.on('joined', ({ code, you, games }) => {
  me = you;
  $('room-code').textContent = code;
  // N'affiche que les jeux actifs (les autres sont en pause côté serveur), numérotés dans l'ordre
  let n = 0;
  document.querySelectorAll('.game-btn').forEach(btn => {
    const on = games.includes(btn.dataset.game);
    btn.classList.toggle('hidden', !on);
    if (on) btn.querySelector('.num').textContent = ++n;
  });
  history.replaceState(null, '', `?code=${code}`);
});

socket.on('players', data => {
  hostId = data.hostId;
  players = data.players;
  renderPlayers();
  if (state) renderGame(); // les noms/hôte peuvent avoir changé
});

socket.on('state', s => {
  state = s;
  if (s.serverNow) clockOffset = s.serverNow - Date.now();
  if (s.roundId !== localRound) { localRound = s.roundId; local = {}; }
  renderGame();
});

// Undercover : mot secret envoyé uniquement à ce joueur
socket.on('undercover-secret', secret => {
  local.secret = secret;
  local.showWord = false;
  renderGame();
});

socket.on('toast', toast);
socket.on('error-msg', toast);

socket.on('room-closed', msg => {
  alert(msg);
  location.href = location.pathname;
});

socket.on('disconnect', () => {
  if (me) {
    toast("Connexion perdue. Retour à l'accueil…");
    setTimeout(() => { location.href = location.pathname; }, 1500);
  }
});

// ---------- Chrono ----------

function setTimer(endsAt) {
  clearInterval(timerInterval);
  const el = $('timer');
  if (!endsAt) { el.classList.add('hidden'); return; }
  const tick = () => {
    const left = Math.max(0, Math.ceil((endsAt - (Date.now() + clockOffset)) / 1000));
    el.textContent = left;
    el.classList.toggle('urgent', left <= 3);
    if (left <= 0) clearInterval(timerInterval);
  };
  el.classList.remove('hidden');
  tick();
  timerInterval = setInterval(tick, 250);
}

// ---------- Rendu des jeux ----------

function renderGame() {
  if (!me || !state) return;
  if (state.phase === 'menu') {
    document.body.removeAttribute('data-game');
    setTimer(null);
    show('lobby');
    return;
  }
  document.body.dataset.game = state.game;
  $('game-title').textContent = GAME_NAMES[state.game];

  // Préserve ce que le joueur est en train de taper si l'écran se redessine
  const input = $('answer-input');
  const typed = input ? input.value : null;
  const hadFocus = input && document.activeElement === input;

  const body = $('game-body');
  const view = views[state.game][state.phase];
  const spectator = !['results', 'setup'].includes(state.phase) && !state.participants.includes(me);
  body.innerHTML = spectator
    ? `<p class="waiting">Un round est en cours. Tu joues au prochain.</p>`
    : (view ? view(state) : '');
  bind[state.game] && bind[state.game](state);

  const newInput = $('answer-input');
  if (newInput && typed !== null) {
    newInput.value = typed;
    if (hadFocus) newInput.focus();
  }

  setTimer(state.phase !== 'results' ? state.endsAt : null);
  const results = state.phase === 'results';
  $('host-controls').classList.toggle('hidden', !isHost());
  $('btn-next').classList.toggle('hidden', !results);
  $('btn-next').textContent = ['traduis', 'undercover'].includes(state.game) ? 'Nouvelle partie' : 'Round suivant';
  show('game');
}

const prompt = (text, cls = 'big-prompt') => `<div class="prompt-card"><p class="${cls}">${esc(text)}</p></div>`;
const amIn = list => list.includes(me);
const waiting = (doneIds, label, among = state.participants) => {
  const expected = among.filter(id => state.participants.includes(id));
  const done = doneIds.filter(id => expected.includes(id)).length;
  const total = expected.length;
  return `<p class="status">${done}/${total} ${label}</p>`;
};
const answerBox = (placeholder, btn, max) => `
  <div class="answer-box">
    <input id="answer-input" type="text" maxlength="${max}" placeholder="${placeholder}" autocomplete="off">
    <button id="answer-send" class="btn btn-primary">${btn}</button>
  </div>`;

const views = {
  whois: {
    vote: s => {
      const voted = amIn(s.voted);
      return prompt(s.question) +
        `<p class="hint">${voted ? 'Vote enregistré. On attend les autres.' : 'Vote pour quelqu\'un (toi compris).'}</p>
        <div class="choices">${s.candidates.map(c => `
          <button class="choice ${local.vote === c.id ? 'picked' : ''} ${voted && local.vote !== c.id ? 'dim' : ''}"
            data-id="${c.id}" ${voted ? 'disabled' : ''}>${esc(c.name)}</button>`).join('')}
        </div>` + waiting(s.voted, 'ont voté');
    },
    results: s => prompt(s.question) + `<ul class="results">${s.results.map(c => `
      <li class="${c.winner ? 'win' : ''}">
        <div class="row"><span class="main">${esc(c.name)}${c.winner ? ' <span class="badge pts">+100</span>' : ''}</span>
        <span class="count">${c.votes} vote${c.votes > 1 ? 's' : ''}</span></div>
      </li>`).join('')}</ul>`
  },

  assoc: {
    answer: s => prompt(s.theme) + (amIn(s.answered)
      ? `<p class="status sent">Ta réponse : «${esc(local.sent || '')} »</p>`
      : answerBox('Ta réponse, vite !', 'Envoyer', 80)) + waiting(s.answered, 'ont répondu'),
    results: s => prompt(s.theme) + `<ul class="results">${s.results.map(r => `
      <li><div class="main">${r.text ? esc(r.text) : '<span class="empty">(pas de réponse)</span>'}</div>
      <div class="sub">${esc(r.name)}</div></li>`).join('')}</ul>`
  },

  bluff: {
    write: s => prompt(s.question) + (amIn(s.written)
      ? `<p class="status sent">Ta fausse réponse : «${esc(local.lie || '')} »</p>`
      : `<p class="hint">Invente une fausse réponse crédible pour piéger les autres.</p>` +
        answerBox('Ta fausse réponse…', 'Envoyer', 120)) + waiting(s.written, 'ont écrit'),
    vote: s => {
      const voted = amIn(s.voted);
      const mine = o => local.lie && o.text.toLowerCase() === local.lie.toLowerCase();
      return prompt(s.question) +
        `<p class="hint">${voted ? 'Vote enregistré. On attend les autres.' : 'Laquelle est la vraie réponse ?'}</p>
        <div class="choices">${s.options.map(o => `
          <button class="choice ${mine(o) ? 'mine' : ''} ${local.vote === o.id ? 'picked' : ''} ${voted && local.vote !== o.id ? 'dim' : ''}"
            data-id="${o.id}" ${voted || mine(o) ? 'disabled' : ''}>${esc(o.text)}</button>`).join('')}
        </div>` + waiting(s.voted, 'ont voté');
    },
    results: s => prompt(s.question) + `<ul class="results">${s.results.map(r => `
      <li class="${r.truth ? 'truth' : ''}">
        <div class="row"><span class="main">${esc(r.text)}${r.truth ? ' <span class="badge good">VRAI</span>' : ''}</span>
        <span class="count">${r.voters.length}</span></div>
        <div class="sub">${r.truth ? 'La vraie réponse' : `Inventé par ${esc(r.authors.join(', '))}`}${
          r.voters.length ? ` · votée par ${esc(r.voters.join(', '))}` : ''}</div>
      </li>`).join('')}</ul>` +
      (s.gains.length ? `<h3>Points gagnés</h3><ul class="results">${s.gains.map(g => `
        <li><div class="row"><span class="main">${esc(g.name)}</span><span class="count">+${g.pts}</span></div></li>`).join('')}</ul>` : '')
  },

  traduis: {
    setup: s => isHost()
      ? `<p class="big-prompt">Combien de questions ?</p>
        <p class="hint">Personne ne saura si ses réponses sont justes avant la fin.
        Le dernier du classement peut recevoir un gage, si tout le monde est d'accord.</p>
        <div class="count-picker">${s.counts.map(c => `<button class="btn count-btn" data-count="${c}">${c}</button>`).join('')}</div>`
      : `<p class="waiting">L'hôte choisit le nombre de questions…</p>`,

    question: s => {
      const mine = local[`q${s.index}`];
      const done = mine !== undefined;
      return `<p class="progress">Question ${s.index} sur ${s.total}</p>
        <div class="prompt-card"><p class="hint">Ça veut dire quoi ?</p><p class="big-prompt expression">${esc(s.expression)}</p></div>
        <div class="choices">${s.choices.map((c, i) => `
          <button class="choice ${mine === i ? 'picked' : ''} ${done && mine !== i ? 'dim' : ''}" data-index="${i}" ${done ? 'disabled' : ''}>${esc(c)}</button>`).join('')}
        </div>` +
        (done ? `<p class="status">Réponse enregistrée. Tu sauras à la fin si c'est juste.</p>` : '') +
        waiting(s.answered, 'ont répondu');
    },

    'gage-vote': s => {
      const judge = s.judges.includes(me);
      const voted = amIn(s.voted);
      const plural = s.losers.length > 1;
      let action;
      if (!judge) action = `<p class="status sent">Les autres votent pour savoir si tu prends un gage…</p>`;
      else if (voted) action = `<p class="status">Vote enregistré. Il faut que tout le monde soit d'accord.</p>`;
      else action = `<p class="hint">${plural ? 'On leur donne un gage ?' : 'On lui donne un gage ?'} Il faut que tout le monde soit d'accord.</p>
        <div class="vote-row">
          <button class="btn btn-primary" data-gage="yes">Oui, un gage !</button>
          <button class="btn" data-gage="no">Non, on laisse</button>
        </div>`;
      return ranking(s) + loserBlock(s, plural ? 'Derniers du classement (égalité)' : 'Dernier du classement') + action + waiting(s.voted.filter(id => s.judges.includes(id)), 'ont voté', s.judges) + recap(s);
    },

    'gage-write': s => {
      const judge = s.judges.includes(me);
      let action;
      if (!judge) action = `<p class="status sent">Les autres écrivent ton gage… Un seul sera tiré au sort.</p>`;
      else if (amIn(s.written)) action = `<p class="status sent">Ton gage : « ${esc(local.gage || '')} »</p>`;
      else action = `<p class="hint">Écris un gage. Un seul sera tiré au sort parmi ceux des joueurs.</p>` +
        answerBox('ex : imiter ta téta au téléphone', 'Envoyer le gage', 140);
      return loserBlock(s, 'Gage pour') + action + waiting(s.written, 'ont écrit', s.judges);
    },

    results: s => {
      let gage = '';
      if (s.drawn && s.drawn.length) {
        gage = s.drawn.map(d => `<div class="gage-card">
            <p class="gage-label">Gage pour ${esc(d.loser)}</p>
            ${d.text ? `<p class="gage-text">${esc(d.text)}</p><p class="sub">Écrit par ${esc(d.author)}</p>`
                     : `<p class="gage-text">Personne n'a écrit de gage. Chanceux…</p>`}
          </div>`).join('');
      } else if (s.gageRefused) {
        gage = `<p class="status sent">Pas de gage cette fois : tout le monde n'était pas d'accord.</p>`;
      }
      return gage + ranking(s) + recap(s, true);
    }
  }
};

// ---------- Yalla, Tourne ! ----------

function bottleTable(s) {
  const n = s.circle.length;
  const seats = s.circle.map((p, i) => `
    <li style="--a:${i * 360 / n}deg" class="${p.id === s.target ? 'target' : ''} ${p.id === me ? 'me' : ''}">
      <span>${esc(p.name)}</span>
    </li>`).join('');
  return `<div class="table"><ul class="seats">${seats}</ul>
    <div id="bottle" class="bottle" style="transform: rotate(${s.rotation}deg)">${BOTTLE_SVG}</div></div>`;
}

const CHOICE_LABEL = { action: 'Action', verite: 'Vérité' };

views.bottle = {
  ready: s => {
    let html = '';
    if (s.targetName && s.choice) {
      html += `<p class="verdict"><strong>${esc(s.targetName)}</strong> a choisi
        <span class="pick-${s.choice}">${CHOICE_LABEL[s.choice]}</span></p>`;
      if (s.idea) {
        html += `<div class="idea-card idea-${s.choice}">
          <p class="idea-label">${s.choice === 'action' ? 'Ton action' : 'Ta vérité'}, ${esc(s.targetName)}</p>
          <p class="idea-text">${esc(s.idea)}</p>
        </div>`;
      }
      html += `<button id="idea" class="btn idea-btn">${s.idea ? 'Une autre idée' : 'Donne-moi une idée'}</button>`;
    }
    html += bottleTable(s);
    if (s.circle.length < 2) {
      html += `<p class="status">Il faut au moins 2 joueurs autour de la bouteille.</p>`;
    } else if (s.spinner === me) {
      html += `<button id="spin" class="btn btn-primary">Faire tourner la bouteille</button>`;
    } else {
      html += `<p class="status">C'est à <strong>${esc(s.spinnerName)}</strong> de faire tourner la bouteille.</p>`;
      if (isHost()) html += `<button id="spin" class="btn">Lancer à sa place</button>`;
    }
    return html;
  },

  spinning: s => bottleTable(s) +
    `<p class="status">${esc(s.spinnerName)} fait tourner la bouteille…</p>`,

  choose: s => {
    let html = bottleTable(s);
    if (s.target === me) {
      html += `<p class="verdict">C'est sur toi ! Action ou vérité ?</p>
        <div class="vote-row">
          <button class="btn pick-btn" data-choice="action">Action</button>
          <button class="btn pick-btn" data-choice="verite">Vérité</button>
        </div>`;
    } else {
      html += `<p class="verdict">La bouteille montre <strong>${esc(s.targetName)}</strong></p>
        <p class="status">On attend son choix : action ou vérité ?</p>`;
      if (isHost()) html += `<button id="spin" class="btn btn-ghost">Passer et relancer</button>`;
    }
    return html;
  }
};

function bindBottle(s) {
  const spinBtn = $('spin');
  if (spinBtn) spinBtn.onclick = () => socket.emit('bottle-spin');
  const ideaBtn = $('idea');
  if (ideaBtn) ideaBtn.onclick = () => socket.emit('bottle-idea');
  document.querySelectorAll('[data-choice]').forEach(b => b.onclick = () =>
    socket.emit('bottle-choose', { choice: b.dataset.choice }));

  // Rotation synchronisée : on reprend l'animation là où elle en est (utile si l'écran se redessine)
  const el = $('bottle');
  if (s.spin && el && el.animate) {
    const elapsed = Date.now() + clockOffset - s.spin.startedAt;
    if (elapsed < s.spin.duration) {
      const anim = el.animate(
        [{ transform: `rotate(${s.spin.from}deg)` }, { transform: `rotate(${s.spin.to}deg)` }],
        { duration: s.spin.duration, easing: 'cubic-bezier(.1, .55, .15, 1)' }
      );
      anim.currentTime = Math.max(0, elapsed);
    }
  }

  // Petit coup de vibreur sur le téléphone de celui qui est désigné
  if (s.phase === 'choose' && s.target === me && local.buzzed !== s.rotation) {
    local.buzzed = s.rotation;
    if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
  }
}

// ---------- Undercover ----------

const ROLE_LABEL = { civil: 'Civil', undercover: 'Undercover', white: 'Mr. White' };
const WINNER_LABEL = {
  civils: 'Les civils ont gagné !',
  infiltres: 'Les infiltrés ont gagné !',
  white: 'Mr. White a deviné le mot !'
};

// Pourquoi la partie s'arrête, en une phrase
function endReason(s) {
  if (s.winner === 'white') return 'Il a trouvé le mot des civils après avoir été démasqué.';
  if (s.winner === 'civils') return 'Tous les infiltrés ont été démasqués.';
  return s.civilsLeft === 1
    ? 'Il ne reste plus qu\'un civil : il ne peut plus faire éliminer les infiltrés.'
    : 'Il ne reste plus assez de civils pour faire éliminer les infiltrés.';
}

function setupInfo(s) {
  return `${s.count} joueur${s.count > 1 ? 's' : ''} : ${s.undercovers} Undercover${s.white ? ' + Mr. White' : ''}`;
}

// Carte du mot secret, cachée par défaut pour que les voisins ne la lisent pas
function wordCard(s) {
  if (!s.alive.includes(me)) return `<div class="word-card out"><p class="word-label">Tu es éliminé(e)</p>
    <p class="word-hint">Tu peux écouter, mais tu ne parles plus et tu ne votes plus.</p></div>`;
  const secret = local.secret;
  if (!secret) return `<div class="word-card"><p class="word-label">Distribution des mots…</p></div>`;
  if (!local.showWord) return `<button id="word-card" class="word-card hidden-word">
      <span class="word-label">Ton mot est caché</span>
      <span class="word-hint">Appuie pour le voir (cache ton écran)</span></button>`;
  return `<button id="word-card" class="word-card">${secret.white
      ? `<span class="word-label">Tu es</span><span class="word">Mr. White</span>
         <span class="word-hint">Tu n'as pas de mot. Écoute les autres et bluffe !</span>`
      : `<span class="word-label">Ton mot</span><span class="word">${esc(secret.word)}</span>
         <span class="word-hint">Appuie pour le cacher</span>`}</button>`;
}

function deadList(s) {
  if (!s.dead.length) return '';
  return `<h3>Éliminés</h3><ul class="player-list">${s.dead.map(d => `
    <li><span class="pname">${esc(d.name)}</span><span class="role-tag role-${d.role}">${ROLE_LABEL[d.role]}</span></li>`).join('')}</ul>`;
}

views.undercover = {
  setup: s => isHost()
    ? `<p class="big-prompt">Prêts à jouer ?</p>
      <p class="hint">Les civils ont tous le même mot. L'Undercover a un mot proche, sans le savoir.
      Chacun décrit son mot à voix haute, puis on vote pour éliminer l'intrus.</p>
      <label class="toggle"><input id="opt-white" type="checkbox" ${s.white ? 'checked' : ''}>
        <span>Avec Mr. White <small>(aucun mot, il doit bluffer)</small></span></label>
      <p class="status">${setupInfo(s)}</p>
      <button id="uc-deal" class="btn btn-primary">Distribuer les mots</button>`
    : `<p class="waiting">L'hôte prépare la partie…</p><p class="status">${setupInfo(s)}</p>`,

  describe: s => {
    const current = s.order.find(o => o.id === s.speaker);
    let action;
    if (s.speaker === me) action = `<button id="uc-spoke" class="btn btn-primary">J'ai parlé</button>`;
    else {
      action = `<p class="status">C'est à <strong>${esc(current ? current.name : '…')}</strong> de décrire son mot.</p>`;
      if (isHost()) action += `<button id="uc-spoke" class="btn btn-ghost">Passer au suivant</button>`;
    }
    const idx = s.order.findIndex(o => o.id === s.speaker);
    return wordCard(s) +
      `<p class="progress">Tour ${s.turn} · Descriptions</p>
      <p class="hint">Chacun dit un mot ou une courte phrase à voix haute, dans cet ordre.</p>
      <ol class="speak-order">${s.order.map((o, i) => `
        <li class="${i < idx ? 'done' : ''} ${o.id === s.speaker ? 'current' : ''}">${esc(o.name)}${o.id === me ? ' (toi)' : ''}</li>`).join('')}
      </ol>` + action + deadList(s);
  },

  vote: s => {
    const alive = s.alive.includes(me);
    const voted = amIn(s.voted);
    let body;
    if (!alive) body = `<p class="status">Tu es éliminé(e), tu ne votes pas.</p>`;
    else body = `<p class="hint">${voted ? 'Vote enregistré. On attend les autres.' : 'Qui est l\'intrus ? Vote pour l\'éliminer.'}</p>
      <div class="choices">${s.candidates.filter(c => c.id !== me).map(c => `
        <button class="choice ${voted && local.vote === c.id ? 'picked' : ''} ${voted && local.vote !== c.id ? 'dim' : ''}"
          data-id="${c.id}" ${voted ? 'disabled' : ''}>${esc(c.name)}</button>`).join('')}</div>`;
    return wordCard(s) +
      `<p class="progress">Tour ${s.turn} · Vote</p>` +
      (s.notice ? `<p class="notice">${esc(s.notice)}</p>` : '') +
      body + waiting(s.voted, 'ont voté', s.alive) + deadList(s);
  },

  'white-guess': s => s.eliminated.id === me
    ? `<div class="elim-card"><p class="elim-name">Démasqué(e) !</p>
        <p class="elim-role">Dernière chance : devine le mot des civils pour gagner.</p></div>` +
      answerBox('Le mot des civils', 'Valider', 40)
    : `<div class="elim-card"><p class="elim-name">${esc(s.eliminated.name)} était Mr. White !</p>
        <p class="elim-role">Il tente de deviner le mot des civils…</p></div>`,

  reveal: s => {
    let html = '';
    if (s.eliminated) {
      html += `<div class="elim-card"><p class="elim-name">${esc(s.eliminated.name)} est éliminé(e)</p>
        <p class="elim-role">C'était : <span class="role-tag role-${s.eliminated.role}">${ROLE_LABEL[s.eliminated.role]}</span></p>
        ${s.eliminated.role === 'white' && s.whiteGuess ? `<p class="elim-role">Il a proposé « ${esc(s.whiteGuess)} »… raté.</p>` : ''}</div>`;
    } else if (s.notice) {
      html += `<p class="notice">${esc(s.notice)}</p>`;
    }
    html += `<p class="hint">La partie continue : il reste encore au moins un intrus.</p>`;
    if (s.lastVotes) html += `<h3>Votes</h3><ul class="results">${s.lastVotes.map(v => `
      <li><div class="row"><span class="main">${esc(v.name)}</span><span class="count">${v.votes}</span></div></li>`).join('')}</ul>`;
    html += isHost()
      ? `<button id="uc-next" class="btn btn-primary spaced">Tour suivant</button>`
      : `<p class="waiting">L'hôte lance le tour suivant…</p>`;
    return html + deadList(s);
  },

  results: s => `${s.lastOut ? `<div class="elim-card">
        <p class="elim-name">${esc(s.lastOut.name)} est éliminé(e)</p>
        <p class="elim-role">C'était : <span class="role-tag role-${s.lastOut.role}">${ROLE_LABEL[s.lastOut.role]}</span></p>
      </div>` : ''}
    <div class="winner-card winner-${s.winner}"><p>${WINNER_LABEL[s.winner]}</p>
      <p class="winner-why">${endReason(s)}</p></div>
    <p class="words-line">Mot des civils : <strong>${esc(s.civilWord)}</strong><br>
      Mot de l'Undercover : <strong>${esc(s.underWord)}</strong></p>
    ${s.whiteGuess ? `<p class="status">Mr. White a proposé « ${esc(s.whiteGuess)} »</p>` : ''}
    <h3>Les rôles</h3>
    <ul class="player-list">${s.roles.map(p => `
      <li class="${p.alive ? '' : 'out'}"><span class="pname">${esc(p.name)}${p.alive ? '' : ' <small>éliminé(e)</small>'}</span>
        <span class="role-tag role-${p.role}">${ROLE_LABEL[p.role]}</span>
        <span class="score">${p.gain ? '+' + p.gain : ''}</span></li>`).join('')}</ul>`
};

function bindUndercover(s) {
  const card = $('word-card');
  if (card) card.onclick = () => { local.showWord = !local.showWord; renderGame(); };
  const opt = $('opt-white');
  if (opt) opt.onchange = () => socket.emit('undercover-option', { white: opt.checked });
  const deal = $('uc-deal');
  if (deal) deal.onclick = () => socket.emit('undercover-deal');
  const spoke = $('uc-spoke');
  if (spoke) spoke.onclick = () => socket.emit('undercover-spoke');
  const next = $('uc-next');
  if (next) next.onclick = () => socket.emit('undercover-next');
  if (s.phase === 'vote') {
    document.querySelectorAll('.choice:not(:disabled)').forEach(b => b.onclick = () => {
      local.vote = b.dataset.id;
      socket.emit('undercover-vote', { targetId: b.dataset.id });
    });
  }
  if (s.phase === 'white-guess') bindAnswer(text => socket.emit('undercover-guess', { text }));
}

// Classement de la série (Yalla, Traduis !)
function ranking(s) {
  return `<h3>Classement</h3><ol class="ranking">${s.ranking.map((p, i) => `
    <li class="${s.loserIds.includes(p.id) ? 'last' : ''} ${p.id === me ? 'me' : ''}">
      <span class="rank">${i + 1}</span>
      <span class="pname">${esc(p.name)}</span>
      <span class="sub">${p.found}/${s.total}</span>
      <span class="score">${p.points} pts</span>
    </li>`).join('')}</ol>`;
}

function loserBlock(s, label) {
  return `<div class="loser"><span>${label}</span><strong>${esc(s.losers.join(' et '))}</strong></div>`;
}

// Récapitulatif question par question : la bonne réponse et la tienne
function recap(s, open) {
  const n = Object.keys(s.recap[0] ? s.recap[0].answers : {}).length;
  return `<details class="recap" ${open ? 'open' : ''}><summary>Les réponses, question par question</summary>
    <ol class="results">${s.recap.map(q => {
      const mine = q.answers[me];
      const found = Object.values(q.answers).filter(a => a === q.correct).length;
      const ok = mine === q.correct;
      return `<li>
        <div class="main">${esc(q.expression)}</div>
        <div class="sub">= ${esc(q.correct)} · trouvé par ${found} sur ${n}</div>
        ${me in q.answers ? `<div class="mine ${ok ? 'ok' : 'ko'}">${
          mine === null ? 'Tu n\'as pas répondu' : `${ok ? 'Juste' : 'Faux'} : tu as répondu « ${esc(mine)} »`}</div>` : ''}
      </li>`;
    }).join('')}</ol></details>`;
}

// Branche les clics après chaque rendu
function bindAnswer(onSend) {
  const input = $('answer-input');
  const btn = $('answer-send');
  if (!input) return;
  const send = () => {
    const text = input.value.trim();
    if (!text) { toast("Écris quelque chose avant d'envoyer."); return; }
    onSend(text);
  };
  btn.onclick = send;
  input.onkeydown = e => { if (e.key === 'Enter') send(); };
}

const bind = {
  bottle: bindBottle,
  undercover: bindUndercover,
  whois: s => {
    if (s.phase !== 'vote') return;
    document.querySelectorAll('.choice:not(:disabled)').forEach(b => b.onclick = () => {
      local.vote = b.dataset.id;
      socket.emit('whois-vote', { targetId: b.dataset.id });
    });
  },
  assoc: s => {
    if (s.phase !== 'answer') return;
    bindAnswer(text => { local.sent = text; socket.emit('assoc-answer', { text }); });
  },
  bluff: s => {
    if (s.phase === 'write') {
      bindAnswer(text => { local.lie = text; socket.emit('bluff-lie', { text }); });
    } else if (s.phase === 'vote') {
      document.querySelectorAll('.choice:not(:disabled)').forEach(b => b.onclick = () => {
        local.vote = Number(b.dataset.id);
        socket.emit('bluff-vote', { optionId: local.vote });
      });
    }
  },
  traduis: s => {
    if (s.phase === 'setup') {
      document.querySelectorAll('.count-btn').forEach(b => b.onclick = () =>
        socket.emit('traduis-config', { count: Number(b.dataset.count) }));
    } else if (s.phase === 'question') {
      document.querySelectorAll('.choice:not(:disabled)').forEach(b => b.onclick = () => {
        local[`q${s.index}`] = Number(b.dataset.index);
        socket.emit('traduis-answer', { index: Number(b.dataset.index) });
        renderGame();
      });
    } else if (s.phase === 'gage-vote') {
      document.querySelectorAll('[data-gage]').forEach(b => b.onclick = () =>
        socket.emit('gage-vote', { yes: b.dataset.gage === 'yes' }));
    } else if (s.phase === 'gage-write') {
      bindAnswer(text => { local.gage = text; socket.emit('gage-write', { text }); });
    }
  }
};
