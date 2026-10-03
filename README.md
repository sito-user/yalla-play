# Yalla Play 🎉

Mini-jeux multijoueur à jouer **en présentiel**, chacun sur son téléphone.
Node.js + Express + Socket.io, tout en mémoire (pas de base de données), 100 % gratuit.

## Les jeux
- **Yalla, Traduis !** — série de N questions sur les expressions libanaises, réponses révélées à la fin, gage pour le dernier
- **Yalla, Tourne !** — la bouteille qui tourne pour action ou vérité, avec un bouton « Donne-moi une idée »
- **Undercover** — civils, Undercover et Mr. White (optionnel) : trouve qui n'a pas le même mot

En pause (cachés du menu, code conservé) : **Yalla, Qui ?**, **Yalla Vite**, **Sa7 ou Fake**.
Pour en réactiver un, retire son nom de `PAUSED_GAMES` en haut de `server.js`
(`whois` = Yalla, Qui ?, `assoc` = Yalla Vite, `bluff` = Sa7 ou Fake).

## Lancer en local
```bash
npm install
npm start
```
Puis ouvrir http://localhost:3000. Pour jouer à plusieurs sur le même Wi-Fi, ouvrir
`http://<IP-du-PC>:3000` sur les téléphones.

## Modifier le contenu
Toutes les questions sont dans `questions.js`.

## Déployer gratuitement sur Render
1. Pousser le dossier sur un repo GitHub.
2. Sur render.com : **New → Web Service**, connecter le repo.
3. Build command : `npm install` — Start command : `npm start` — plan **Free**.
4. Le service s'endort après 15 min d'inactivité : ouvrir le lien ~1 min avant la soirée.
