// Yalla Play — serveur Express + Socket.io
// Tout l'état (rooms, joueurs, scores, round en cours) vit en mémoire : rien n'est persisté.

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const Q = require('./questions');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

const DURATIONS = { assoc: 12, bluff: 20, traduis: 10, gage: 60 }; // secondes
const TRADUIS_COUNTS = [5, 10, 15, 20]; // nombres de questions proposés à l'hôte
const ALL_GAMES = ['whois', 'assoc', 'bluff', 'traduis', 'bottle', 'undercover'];
// Jeux en pause : cachés du menu et impossibles à lancer. Retire un nom de cette liste pour le réactiver.
const PAUSED_GAMES = ['whois', 'assoc', 'bluff'];
const GAMES = ALL_GAMES.filter(g => !PAUSED_GAMES.includes(g));

const rooms = {}; // code -> room

// ---------- Utilitaires ----------

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sans I/O pour éviter la confusion
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms[code]);
  return code;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Pioche au hasard en évitant de retomber sur les dernières questions déjà vues
function pick(room, game, list) {
  const used = room.used[game] || (room.used[game] = []);
  let pool = list.map((_, i) => i).filter(i => !used.includes(i));
  if (pool.length === 0) { used.length = 0; pool = list.map((_, i) => i); }
  const idx = pool[Math.floor(Math.random() * pool.length)];
  used.push(idx);
  return list[idx];
}

const nameOf = (room, id) => (room.players[id] ? room.players[id].name : '(parti)');
// Chou Kelmtak ? : 1 El Gharib jusqu'à 6 joueurs, 2 à partir de 7
const undercoverCount = n => (n >= 7 ? 2 : 1);
// Nombre minimum de tours de descriptions rappelé avant chaque vote
const UNDERCOVER_MIN_TURNS = 3;
// Compare deux mots sans tenir compte des majuscules, accents, espaces et tirets
const normalizeWord = w => String(w).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
// "A, B et C"
const listNames = names => (names.length > 1 ? names.slice(0, -1).join(', ') + ' et ' + names[names.length - 1] : names.join(''));
const clean = (s, max) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, max);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

function publicPlayers(room) {
  return Object.values(room.players).map(p => ({ id: p.id, name: p.name, score: p.score }));
}

function broadcastPlayers(room) {
  io.to(room.code).emit('players', { hostId: room.hostId, players: publicPlayers(room) });
}

// Envoie l'état public du round à toute la room (ou à un seul socket)
function sendState(room, target) {
  const r = room.round;
  const payload = r ? { roundId: r.id, game: r.game, phase: r.phase, participants: activeParticipants(room), ...r.view(), serverNow: Date.now() } : { game: null, phase: 'menu' };
  (target || io.to(room.code)).emit('state', payload);
}

function clearTimer(room) {
  if (room.round && room.round.timer) clearTimeout(room.round.timer);
}

function startTimer(room, seconds, onEnd) {
  const r = room.round;
  r.endsAt = Date.now() + seconds * 1000;
  r.timer = setTimeout(() => { if (room.round === r) onEnd(); }, seconds * 1000);
}

// Joueurs encore présents parmi ceux qui participaient au début du round
function activeParticipants(room) {
  return room.round.participants.filter(id => room.players[id]);
}

// ---------- Les 4 jeux ----------

const games = {
  // 🕵️ Yalla, Qui ?
  whois: {
    start(room) {
      const r = room.round;
      r.question = pick(room, 'whois', Q.whois);
      r.votes = {}; // voterId -> targetId
      r.candidates = r.participants.map(id => ({ id, name: room.players[id].name }));
      r.phase = 'vote';
      r.view = () => r.phase === 'vote'
        ? { question: r.question, candidates: r.candidates, voted: Object.keys(r.votes) }
        : { question: r.question, results: r.results };
    },
    vote(room, socket, targetId) {
      const r = room.round;
      if (r.phase !== 'vote' || !r.participants.includes(socket.id) || r.votes[socket.id]) return;
      if (!r.candidates.some(c => c.id === targetId)) return;
      r.votes[socket.id] = targetId;
      this.check(room);
    },
    check(room) {
      const r = room.round;
      const active = activeParticipants(room);
      if (r.phase !== 'vote') return;
      if (active.length && active.every(id => r.votes[id])) return this.finish(room);
      sendState(room);
    },
    finish(room) {
      const r = room.round;
      const counts = {};
      Object.values(r.votes).forEach(t => { counts[t] = (counts[t] || 0) + 1; });
      const max = Math.max(0, ...Object.values(counts));
      r.results = r.candidates
        .map(c => ({ ...c, votes: counts[c.id] || 0, winner: max > 0 && counts[c.id] === max }))
        .sort((a, b) => b.votes - a.votes);
      r.results.forEach(c => { if (c.winner && room.players[c.id]) room.players[c.id].score += 100; });
      r.phase = 'results';
      sendState(room);
      broadcastPlayers(room);
    }
  },

  // ⚡ Yalla Vite
  assoc: {
    start(room) {
      const r = room.round;
      r.theme = pick(room, 'assoc', Q.assoc);
      r.answers = {}; // playerId -> texte
      r.phase = 'answer';
      startTimer(room, DURATIONS.assoc, () => this.finish(room));
      r.view = () => r.phase === 'answer'
        ? { theme: r.theme, endsAt: r.endsAt, answered: Object.keys(r.answers) }
        : { theme: r.theme, results: r.results };
    },
    answer(room, socket, text) {
      const r = room.round;
      if (r.phase !== 'answer' || !r.participants.includes(socket.id) || socket.id in r.answers) return;
      r.answers[socket.id] = clean(text, 80);
      this.check(room);
    },
    check(room) {
      const r = room.round;
      if (r.phase !== 'answer') return;
      const active = activeParticipants(room);
      if (active.length && active.every(id => id in r.answers)) return this.finish(room);
      sendState(room);
    },
    finish(room) {
      const r = room.round;
      if (r.phase !== 'answer') return;
      clearTimer(room);
      r.results = r.participants
        .filter(id => room.players[id] || r.answers[id])
        .map(id => ({ name: room.players[id] ? room.players[id].name : '(parti)', text: r.answers[id] || '' }));
      r.phase = 'results';
      sendState(room);
    }
  },

  // 🎭 Sa7 ou Fake
  bluff: {
    start(room) {
      const r = room.round;
      r.item = pick(room, 'bluff', Q.bluff);
      r.lies = {}; // playerId -> texte
      r.votes = {}; // playerId -> optionId
      r.phase = 'write';
      startTimer(room, DURATIONS.bluff, () => this.toVote(room));
      r.view = () => {
        if (r.phase === 'write') return { question: r.item.q, endsAt: r.endsAt, written: Object.keys(r.lies) };
        if (r.phase === 'vote') return {
          question: r.item.q,
          options: r.options.map(o => ({ id: o.id, text: o.text })), // auteurs cachés jusqu'aux résultats
          voted: Object.keys(r.votes)
        };
        return { question: r.item.q, results: r.results };
      };
    },
    lie(room, socket, text) {
      const r = room.round;
      if (r.phase !== 'write' || !r.participants.includes(socket.id) || r.lies[socket.id]) return;
      const t = clean(text, 120);
      if (!t) return;
      if (same(t, r.item.a)) return socket.emit('toast', "C'est la vraie réponse ! Invente une fausse réponse.");
      if (Object.values(r.lies).some(l => same(l, t))) return socket.emit('toast', "Quelqu'un a déjà proposé ça. Trouve autre chose.");
      r.lies[socket.id] = t;
      this.check(room);
    },
    toVote(room) {
      const r = room.round;
      if (r.phase !== 'write') return;
      clearTimer(room);
      const opts = [{ text: r.item.a, truth: true, authors: [] }];
      Object.entries(r.lies).forEach(([pid, text]) => opts.push({ text, truth: false, authors: [pid] }));
      r.options = shuffle(opts).map((o, i) => ({ ...o, id: i }));
      r.phase = 'vote';
      this.check(room);
    },
    vote(room, socket, optionId) {
      const r = room.round;
      if (r.phase !== 'vote' || !r.participants.includes(socket.id) || socket.id in r.votes) return;
      const opt = r.options.find(o => o.id === optionId);
      if (!opt) return;
      if (opt.authors.includes(socket.id)) return socket.emit('toast', "Tu ne peux pas voter pour ta propre réponse.");
      r.votes[socket.id] = optionId;
      this.check(room);
    },
    check(room) {
      const r = room.round;
      const active = activeParticipants(room);
      if (r.phase === 'write') {
        if (active.length && active.every(id => r.lies[id])) return this.toVote(room);
        return sendState(room);
      }
      if (r.phase !== 'vote') return;
      // Un joueur qui ne peut voter pour rien (seule option = la sienne) n'est pas attendu
      const mustVote = active.filter(id => r.options.some(o => !o.authors.includes(id)));
      if (mustVote.every(id => id in r.votes)) return this.finish(room);
      sendState(room);
    },
    finish(room) {
      const r = room.round;
      const name = id => (room.players[id] ? room.players[id].name : '(parti)');
      const gains = {};
      const add = (id, pts) => { gains[id] = (gains[id] || 0) + pts; };
      r.results = r.options.map(o => {
        const voters = Object.keys(r.votes).filter(v => r.votes[v] === o.id);
        voters.forEach(v => add(v, o.truth ? 100 : 0));
        if (!o.truth) o.authors.forEach(a => add(a, 50 * voters.length));
        return { text: o.text, truth: o.truth, authors: o.authors.map(name), voters: voters.map(name) };
      }).sort((a, b) => (b.truth - a.truth) || (b.voters.length - a.voters.length));
      Object.entries(gains).forEach(([id, pts]) => { if (room.players[id]) room.players[id].score += pts; });
      r.gains = Object.entries(gains).filter(([, p]) => p > 0).map(([id, pts]) => ({ name: name(id), pts }))
        .sort((a, b) => b.pts - a.pts);
      r.phase = 'results';
      r.view = () => ({ question: r.item.q, results: r.results, gains: r.gains });
      sendState(room);
      broadcastPlayers(room);
    }
  },

  // Yalla, Traduis !
  // Une partie = une série de N questions choisie par l'hôte. Les réponses restent secrètes
  // jusqu'à la fin, puis le(s) dernier(s) peuvent recevoir un gage écrit par les autres.
  traduis: {
    start(room) {
      const r = room.round;
      r.phase = 'setup';
      r.view = () => this.view(room);
    },

    // L'hôte choisit le nombre de questions, la série commence
    config(room, socket, count) {
      const r = room.round;
      if (r.phase !== 'setup' || room.hostId !== socket.id) return;
      if (!TRADUIS_COUNTS.includes(count)) return;
      r.participants = Object.keys(room.players); // ceux arrivés pendant le réglage jouent aussi
      r.items = shuffle(Q.traduis).slice(0, Math.min(count, Q.traduis.length));
      r.total = r.items.length;
      r.index = -1;
      r.points = Object.fromEntries(r.participants.map(id => [id, 0]));
      r.recap = []; // une entrée par question jouée
      this.nextQuestion(room);
    },

    nextQuestion(room) {
      const r = room.round;
      r.index++;
      if (r.index >= r.total) return this.endSeries(room);
      const item = r.items[r.index];
      r.current = { item, choices: shuffle([item.correct, item.fake1, item.fake2]), answers: {} };
      r.phase = 'question';
      startTimer(room, DURATIONS.traduis, () => this.closeQuestion(room));
      sendState(room);
    },

    answer(room, socket, index) {
      const r = room.round;
      if (r.phase !== 'question' || r.closing || !r.participants.includes(socket.id)) return;
      const q = r.current;
      if (socket.id in q.answers) return;
      if (!Number.isInteger(index) || index < 0 || index >= q.choices.length) return;
      q.answers[socket.id] = index; // aucun retour : on ne saura qu'à la fin
      this.check(room);
    },

    closeQuestion(room) {
      const r = room.round;
      if (r.phase !== 'question') return;
      clearTimer(room);
      r.closing = false;
      const q = r.current;
      const answers = {};
      r.participants.forEach(id => {
        const a = q.answers[id];
        answers[id] = a === undefined ? null : q.choices[a];
        if (answers[id] === q.item.correct) r.points[id] += 100;
      });
      r.recap.push({ expression: q.item.expression, correct: q.item.correct, answers });
      this.nextQuestion(room);
    },

    endSeries(room) {
      const r = room.round;
      clearTimer(room);
      const active = activeParticipants(room);
      // Les points de la série rejoignent le score général seulement maintenant
      active.forEach(id => { room.players[id].score += r.points[id]; });
      broadcastPlayers(room);

      const scores = active.map(id => r.points[id]);
      const min = Math.min(...scores);
      const allTied = scores.every(s => s === min);
      r.losers = allTied ? [] : active.filter(id => r.points[id] === min);
      r.judges = active.filter(id => !r.losers.includes(id));
      r.gageVotes = {};
      r.gages = {};
      r.drawn = [];

      if (r.losers.length && r.judges.length) r.phase = 'gage-vote';
      else r.phase = 'results';
      sendState(room);
    },

    gageVote(room, socket, yes) {
      const r = room.round;
      if (r.phase !== 'gage-vote' || !r.judges.includes(socket.id) || socket.id in r.gageVotes) return;
      r.gageVotes[socket.id] = !!yes;
      this.check(room);
    },

    gageWrite(room, socket, text) {
      const r = room.round;
      if (r.phase !== 'gage-write' || !r.judges.includes(socket.id) || r.gages[socket.id]) return;
      const t = clean(text, 140);
      if (!t) return;
      r.gages[socket.id] = t;
      this.check(room);
    },

    // Tire un gage différent au hasard pour chaque perdant
    drawGages(room) {
      const r = room.round;
      if (r.phase !== 'gage-write') return;
      clearTimer(room);
      const pool = shuffle(Object.entries(r.gages));
      r.drawn = r.losers.filter(id => room.players[id]).map((id, i) => {
        const g = pool.length ? pool[i % pool.length] : null;
        return { loser: room.players[id].name, text: g ? g[1] : null, author: g ? nameOf(room, g[0]) : null };
      });
      r.phase = 'results';
      sendState(room);
    },

    check(room) {
      const r = room.round;
      const active = activeParticipants(room);
      if (r.phase === 'question') {
        if (r.closing) return;
        if (active.length && active.every(id => id in r.current.answers)) {
          // Courte pause pour que le dernier voie que sa réponse est enregistrée
          clearTimer(room);
          r.closing = true;
          r.timer = setTimeout(() => { if (room.round === r) this.closeQuestion(room); }, 700);
        }
        return sendState(room);
      }
      if (r.phase === 'gage-vote') {
        const judges = r.judges.filter(id => room.players[id]);
        const votes = judges.map(id => r.gageVotes[id]);
        if (!judges.length || !r.losers.some(id => room.players[id])) r.phase = 'results';
        else if (votes.includes(false)) { r.gageRefused = true; r.phase = 'results'; } // il faut l'accord de tous
        else if (votes.every(v => v === true)) {
          r.phase = 'gage-write';
          startTimer(room, DURATIONS.gage, () => this.drawGages(room));
        }
        return sendState(room);
      }
      if (r.phase === 'gage-write') {
        const judges = r.judges.filter(id => room.players[id]);
        if (judges.every(id => r.gages[id])) return this.drawGages(room);
        return sendState(room);
      }
      sendState(room);
    },

    view(room) {
      const r = room.round;
      if (r.phase === 'setup') return { counts: TRADUIS_COUNTS.filter(c => c <= Q.traduis.length) };
      if (r.phase === 'question') {
        const q = r.current;
        return {
          index: r.index + 1, total: r.total,
          expression: q.item.expression, choices: q.choices,
          endsAt: r.endsAt, answered: Object.keys(q.answers)
        };
      }
      const active = activeParticipants(room);
      const ranking = active
        .map(id => ({ id, name: room.players[id].name, points: r.points[id], found: r.points[id] / 100 }))
        .sort((a, b) => b.points - a.points);
      const base = {
        total: r.total,
        ranking,
        losers: r.losers.filter(id => room.players[id]).map(id => nameOf(room, id)),
        loserIds: r.losers,
        recap: r.recap
      };
      if (r.phase === 'gage-vote') return { ...base, judges: r.judges, voted: Object.keys(r.gageVotes) };
      if (r.phase === 'gage-write') return { ...base, judges: r.judges, written: Object.keys(r.gages), endsAt: r.endsAt };
      return { ...base, gageRefused: !!r.gageRefused, drawn: r.drawn };
    }
  },

  // Yalla, Tourne ! — la bouteille pour jouer à action ou vérité.
  // Pas de points : le serveur tire au sort, tous les téléphones animent la même rotation.
  bottle: {
    start(room) {
      const r = room.round;
      r.rotation = 0;        // angle cumulé de la bouteille (degrés), 0 = goulot vers le haut
      r.circle = r.participants.slice();
      r.spinner = room.hostId; // celui qui a le droit de lancer
      r.target = null;
      r.choice = null;
      r.phase = 'ready';
      r.view = () => this.view(room);
    },

    // Les joueurs qui arrivent en cours de jeu prennent place autour de la bouteille
    onJoin(room, id) {
      const r = room.round;
      if (!r.participants.includes(id)) r.participants.push(id);
      if (r.phase !== 'spinning') r.circle = activeParticipants(room);
    },

    spin(room, socket) {
      const r = room.round;
      if (!['ready', 'choose'].includes(r.phase)) return;
      if (socket.id !== r.spinner && socket.id !== room.hostId) return;
      if (r.phase === 'choose' && socket.id !== room.hostId) return; // seul l'hôte peut passer son tour
      r.circle = activeParticipants(room);
      if (r.circle.length < 2) return socket.emit('toast', 'Il faut au moins 2 joueurs pour faire tourner la bouteille.');

      // On ne tombe pas sur celui qui lance
      const candidates = r.circle.filter(id => id !== socket.id);
      const target = candidates[Math.floor(Math.random() * candidates.length)];
      const slice = 360 / r.circle.length;
      const targetAngle = r.circle.indexOf(target) * slice;
      const jitter = (Math.random() - 0.5) * slice * 0.5; // pas pile au centre, comme en vrai
      const current = ((r.rotation % 360) + 360) % 360;
      const turns = 4 + Math.floor(Math.random() * 3);
      const delta = turns * 360 + ((targetAngle - current + 360) % 360) + jitter;
      const duration = 4200 + Math.floor(Math.random() * 1200);

      r.spin = { from: r.rotation, to: r.rotation + delta, startedAt: Date.now(), duration };
      r.rotation += delta;
      r.target = target;
      r.choice = null;
      r.spinnerName = nameOf(room, socket.id);
      r.phase = 'spinning';
      clearTimer(room);
      r.timer = setTimeout(() => {
        if (room.round !== r) return;
        r.phase = room.players[target] ? 'choose' : 'ready';
        sendState(room);
      }, duration + 150);
      sendState(room);
    },

    choose(room, socket, choice) {
      const r = room.round;
      if (r.phase !== 'choose' || socket.id !== r.target) return;
      if (!['action', 'verite'].includes(choice)) return;
      r.choice = choice;
      r.idea = null;
      r.spinner = r.target; // c'est à lui de relancer ensuite
      r.phase = 'ready';
      sendState(room);
    },

    // Seul l'hôte peut demander une idée (ou une autre) pour l'action/vérité en cours
    idea(room, socket) {
      const r = room.round;
      if (r.phase !== 'ready' || !r.choice || room.hostId !== socket.id) return;
      r.idea = pick(room, `bottle-${r.choice}`, Q.bottle[r.choice]);
      sendState(room);
    },

    check(room) {
      const r = room.round;
      if (!room.players[r.spinner]) r.spinner = room.hostId;
      if (r.phase === 'choose' && !room.players[r.target]) { r.target = null; r.phase = 'ready'; }
      if (r.phase !== 'spinning') r.circle = activeParticipants(room);
      sendState(room);
    },

    view(room) {
      const r = room.round;
      return {
        circle: r.circle.map(id => ({ id, name: nameOf(room, id) })),
        rotation: r.rotation,
        spin: r.phase === 'spinning' ? r.spin : null,
        spinner: r.spinner,
        spinnerName: nameOf(room, r.spinner),
        target: r.phase === 'spinning' ? null : r.target, // révélé seulement à l'arrêt
        targetName: r.phase === 'spinning' || !r.target ? null : nameOf(room, r.target),
        choice: r.choice,
        idea: r.phase === 'ready' ? r.idea : null
      };
    }
  },

  // Chou Kelmtak ? (id interne "undercover") — civils (même mot), El Gharib (mot proche),
  // El Shabah optionnel (aucun mot). Les descriptions se font à l'oral, au moins 3 tours avant
  // chaque vote ; le téléphone gère les mots secrets, l'ordre de parole et les votes.
  undercover: {
    start(room) {
      const r = room.round;
      r.phase = 'setup';
      r.white = false;
      r.view = () => this.view(room);
    },

    setOption(room, socket, white) {
      const r = room.round;
      if (r.phase !== 'setup' || room.hostId !== socket.id) return;
      r.white = !!white;
      sendState(room);
    },

    deal(room, socket) {
      const r = room.round;
      if (r.phase !== 'setup' || room.hostId !== socket.id) return;
      const players = Object.keys(room.players);
      const n = players.length;
      const min = r.white ? 4 : 3;
      if (n < min) return socket.emit('toast', `Il faut au moins ${min} joueurs${r.white ? ' avec El Shabah' : ''}.`);

      const nbUnder = undercoverCount(n);
      const shuffled = shuffle(players);
      r.roles = {};
      shuffled.forEach((id, i) => {
        r.roles[id] = i < nbUnder ? 'undercover' : (r.white && i === nbUnder ? 'white' : 'civil');
      });
      const pair = pick(room, 'undercover', Q.undercover);
      [r.civilWord, r.underWord] = Math.random() < 0.5 ? [pair.a, pair.b] : [pair.b, pair.a];
      r.participants = players;
      r.alive = players.slice();
      r.turn = 0;
      r.history = []; // éliminations successives

      // Chaque joueur reçoit son mot en privé (El Gharib ne sait pas qu'il l'est)
      players.forEach(id => {
        const role = r.roles[id];
        io.to(id).emit('undercover-secret', role === 'white' ? { white: true } : { word: role === 'civil' ? r.civilWord : r.underWord });
      });
      this.startDescribe(room);
    },

    aliveNow(room) {
      const r = room.round;
      r.alive = r.alive.filter(id => room.players[id]);
      return r.alive;
    },

    // Nouvelle manche : un ordre de parole tiré au sort, gardé pour les 3 tours de descriptions
    startDescribe(room) {
      const r = room.round;
      const alive = this.aliveNow(room);
      r.turn++;
      r.order = shuffle(alive);
      // El Shabah ne parle jamais en premier
      if (r.roles[r.order[0]] === 'white' && r.order.length > 1) {
        const j = 1 + Math.floor(Math.random() * (r.order.length - 1));
        [r.order[0], r.order[j]] = [r.order[j], r.order[0]];
      }
      r.notice = null;
      r.phase = 'describe';
      sendState(room);
    },

    // L'hôte lance le vote quand les tours de descriptions sont faits
    toVote(room, socket) {
      const r = room.round;
      if (r.phase !== 'describe' || room.hostId !== socket.id) return;
      this.startVote(room, this.aliveNow(room), false);
    },

    startVote(room, candidates, tie) {
      const r = room.round;
      r.phase = 'vote';
      r.votes = {};
      r.candidates = candidates;
      r.tie = tie;
      sendState(room);
    },

    vote(room, socket, targetId) {
      const r = room.round;
      if (r.phase !== 'vote' || !r.alive.includes(socket.id) || socket.id in r.votes) return;
      if (targetId === socket.id || !r.candidates.includes(targetId)) return;
      r.votes[socket.id] = targetId;
      this.check(room);
    },

    tally(room) {
      const r = room.round;
      const counts = {};
      Object.values(r.votes).forEach(t => { counts[t] = (counts[t] || 0) + 1; });
      const present = r.candidates.filter(id => room.players[id]);
      const max = Math.max(0, ...present.map(id => counts[id] || 0));
      const top = present.filter(id => (counts[id] || 0) === max);
      r.lastVotes = present.map(id => ({ name: nameOf(room, id), votes: counts[id] || 0 }))
        .sort((a, b) => b.votes - a.votes);

      if (top.length === 1) return this.eliminate(room, top[0]);
      if (!r.tie) {
        this.startVote(room, top, true);
        r.notice = `Égalité entre ${listNames(top.map(id => nameOf(room, id)))}. On revote entre eux.`;
        return sendState(room);
      }
      r.eliminated = null;
      r.notice = 'Encore une égalité : personne n\'est éliminé ce tour-ci.';
      r.phase = 'reveal';
      sendState(room);
    },

    eliminate(room, id) {
      const r = room.round;
      r.alive = r.alive.filter(a => a !== id);
      r.eliminated = { id, name: nameOf(room, id), role: r.roles[id] };
      r.history.push(r.eliminated);
      r.notice = null;
      if (r.roles[id] === 'white' && room.players[id]) {
        r.phase = 'white-guess';
        r.whiteGuess = null;
        return sendState(room);
      }
      this.afterElimination(room);
    },

    whiteGuess(room, socket, text) {
      const r = room.round;
      if (r.phase !== 'white-guess' || socket.id !== r.eliminated.id) return;
      const guess = clean(text, 40);
      if (!guess) return;
      r.whiteGuess = guess;
      if (normalizeWord(guess) === normalizeWord(r.civilWord)) {
        r.lastOut = r.eliminated;
        return this.endGame(room, 'white');
      }
      this.afterElimination(room);
    },

    // Les civils gagnent quand tous les infiltrés sont éliminés ; les infiltrés gagnent
    // quand il ne reste plus que 2 joueurs dont au moins un infiltré. Sinon on continue.
    winner(room) {
      const r = room.round;
      const alive = this.aliveNow(room);
      const infiltrated = alive.filter(id => r.roles[id] !== 'civil').length;
      if (infiltrated === 0) return 'civils';
      if (alive.length <= 2) return 'infiltres';
      return null;
    },

    afterElimination(room) {
      const r = room.round;
      const w = this.winner(room);
      if (w) {
        r.lastOut = r.eliminated; // l'élimination qui termine la partie, affichée sur l'écran de fin
        return this.endGame(room, w);
      }
      r.phase = 'reveal';
      sendState(room);
    },

    next(room, socket) {
      const r = room.round;
      if (r.phase === 'reveal' && room.hostId === socket.id) this.startDescribe(room);
    },

    endGame(room, winner) {
      const r = room.round;
      r.winner = winner;
      const pts = id => {
        const role = r.roles[id];
        if (winner === 'civils') return role === 'civil' ? 100 : 0;
        if (winner === 'infiltres') return role !== 'civil' ? 200 : 0;
        return role === 'white' ? 300 : 0;
      };
      r.gains = {};
      r.participants.forEach(id => {
        r.gains[id] = pts(id);
        if (room.players[id]) room.players[id].score += r.gains[id];
      });
      r.phase = 'results';
      sendState(room);
      broadcastPlayers(room);
    },

    check(room) {
      const r = room.round;
      if (r.phase === 'setup') return sendState(room);
      // Un départ peut suffire à terminer la partie
      if (['describe', 'vote', 'reveal'].includes(r.phase)) {
        const w = this.winner(room);
        if (w) return this.endGame(room, w);
      }
      if (r.phase === 'describe') {
        r.order = r.order.filter(id => room.players[id]); // un joueur parti sort de l'ordre de parole
        return sendState(room);
      }
      if (r.phase === 'vote') {
        const voters = this.aliveNow(room);
        if (voters.length && voters.every(id => id in r.votes)) return this.tally(room);
        return sendState(room);
      }
      if (r.phase === 'white-guess' && !room.players[r.eliminated.id]) return this.afterElimination(room);
      sendState(room);
    },

    view(room) {
      const r = room.round;
      if (r.phase === 'setup') {
        const n = Object.keys(room.players).length;
        return { white: r.white, count: n, undercovers: undercoverCount(n) };
      }
      const seat = id => ({ id, name: nameOf(room, id), alive: r.alive.includes(id) });
      const base = {
        turn: r.turn,
        white: r.white,
        undercovers: undercoverCount(r.participants.length),
        alive: r.alive,
        dead: r.history.map(h => ({ name: h.name, role: h.role })),
        notice: r.notice
      };
      if (r.phase === 'describe') {
        return { ...base, order: r.order.map(seat), minTurns: UNDERCOVER_MIN_TURNS };
      }
      if (r.phase === 'vote') {
        return { ...base, candidates: r.candidates.map(seat), voted: Object.keys(r.votes), tie: r.tie };
      }
      if (r.phase === 'white-guess') return { ...base, eliminated: r.eliminated };
      if (r.phase === 'reveal') return { ...base, eliminated: r.eliminated, lastVotes: r.lastVotes, whiteGuess: r.whiteGuess };
      return {
        ...base,
        winner: r.winner,
        lastOut: r.lastOut || null,
        civilsLeft: r.alive.filter(id => r.roles[id] === 'civil').length,
        civilWord: r.civilWord,
        underWord: r.underWord,
        whiteGuess: r.whiteGuess,
        roles: r.participants.map(id => ({
          name: nameOf(room, id),
          role: r.roles[id],
          alive: r.alive.includes(id),
          gain: r.gains[id]
        }))
      };
    }
  }
};

function startRound(room, game) {
  clearTimer(room);
  room.round = { id: ++room.roundCount, game, participants: Object.keys(room.players) };
  games[game].start(room);
  sendState(room);
}

// ---------- Connexions ----------

io.on('connection', socket => {
  let room = null;

  const isHost = () => room && room.hostId === socket.id;

  function enter(r, name) {
    room = r;
    room.players[socket.id] = { id: socket.id, name, score: 0 };
    socket.join(room.code);
    const joinsGame = room.round && games[room.round.game].onJoin;
    if (joinsGame) games[room.round.game].onJoin(room, socket.id);
    socket.emit('joined', { code: room.code, you: socket.id, games: GAMES });
    broadcastPlayers(room);
    sendState(room, joinsGame ? undefined : socket); // tout le monde voit le nouveau venu autour de la bouteille
  }

  socket.on('create-room', ({ name } = {}) => {
    if (room) return;
    const n = clean(name, 20);
    if (!n) return socket.emit('error-msg', 'Entre ton prénom pour créer une partie.');
    const code = makeCode();
    rooms[code] = { code, hostId: socket.id, players: {}, round: null, roundCount: 0, used: {} };
    enter(rooms[code], n);
  });

  socket.on('join-room', ({ name, code } = {}) => {
    if (room) return;
    const n = clean(name, 20);
    const c = clean(code, 4).toUpperCase();
    if (!n) return socket.emit('error-msg', 'Entre ton prénom.');
    const r = rooms[c];
    if (!r) return socket.emit('error-msg', `Aucune partie avec le code ${c || '…'}.`);
    if (Object.values(r.players).some(p => same(p.name, n))) {
      return socket.emit('error-msg', 'Ce prénom est déjà pris dans cette partie.');
    }
    enter(r, n);
  });

  socket.on('start-game', ({ game } = {}) => {
    if (isHost() && GAMES.includes(game)) startRound(room, game);
  });

  socket.on('next-round', () => {
    if (isHost() && room.round) startRound(room, room.round.game);
  });

  socket.on('back-to-menu', () => {
    if (!isHost()) return;
    clearTimer(room);
    room.round = null;
    sendState(room);
  });

  const forRound = (game, fn) => (data = {}) => {
    if (room && room.round && room.round.game === game) fn(data);
  };

  socket.on('whois-vote', forRound('whois', d => games.whois.vote(room, socket, d.targetId)));
  socket.on('assoc-answer', forRound('assoc', d => games.assoc.answer(room, socket, d.text)));
  socket.on('bluff-lie', forRound('bluff', d => games.bluff.lie(room, socket, d.text)));
  socket.on('bluff-vote', forRound('bluff', d => games.bluff.vote(room, socket, d.optionId)));
  socket.on('bottle-spin', forRound('bottle', () => games.bottle.spin(room, socket)));
  socket.on('undercover-option', forRound('undercover', d => games.undercover.setOption(room, socket, d.white)));
  socket.on('undercover-deal', forRound('undercover', () => games.undercover.deal(room, socket)));
  socket.on('undercover-tovote', forRound('undercover', () => games.undercover.toVote(room, socket)));
  socket.on('undercover-vote', forRound('undercover', d => games.undercover.vote(room, socket, d.targetId)));
  socket.on('undercover-guess', forRound('undercover', d => games.undercover.whiteGuess(room, socket, d.text)));
  socket.on('undercover-next', forRound('undercover', () => games.undercover.next(room, socket)));
  socket.on('bottle-idea', forRound('bottle', () => games.bottle.idea(room, socket)));
  socket.on('bottle-choose', forRound('bottle', d => games.bottle.choose(room, socket, d.choice)));
  socket.on('traduis-config', forRound('traduis', d => games.traduis.config(room, socket, d.count)));
  socket.on('traduis-answer', forRound('traduis', d => games.traduis.answer(room, socket, d.index)));
  socket.on('gage-vote', forRound('traduis', d => games.traduis.gageVote(room, socket, d.yes)));
  socket.on('gage-write', forRound('traduis', d => games.traduis.gageWrite(room, socket, d.text)));

  socket.on('disconnect', () => {
    if (!room) return;
    if (isHost()) {
      clearTimer(room);
      io.to(room.code).emit('room-closed', "L'hôte a quitté la partie. La partie est terminée.");
      io.in(room.code).socketsLeave(room.code);
      delete rooms[room.code];
      return;
    }
    delete room.players[socket.id];
    broadcastPlayers(room);
    if (room.round) games[room.round.game].check(room); // le round peut maintenant être complet
  });
});

server.listen(PORT, () => console.log(`Yalla Play sur http://localhost:${PORT}`));
