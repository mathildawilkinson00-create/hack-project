# Point Right — version application (Windows)

Même moteur de gestes que l'extension Chrome, mais dans une **vraie application** :
elle n'a besoin ni de Chrome ni de l'extension, et marche avec **n'importe quelle présentation**
(Figma, PowerPoint, Google Slides, PDF…) : elle appuie sur les touches → / ← de la fenêtre au premier plan.

## Lancer

Double-clic sur **`Lancer.bat`**. La première fois, il installe Electron (internet requis, ~1 minute).

Ou dans un terminal, depuis ce dossier :
```
npm install
npm start
```

## Utiliser

1. Ouvre ta présentation **Figma** en mode présentation (app Figma, ou Figma dans un navigateur).
2. Dans l'app, clique **Start camera** (Windows peut demander l'accès à la caméra).
3. Fais tes gestes : ✌️ 2 doigts = suivant, 🖖 3 doigts = précédent, 🤟 = fermer l'app.

**Figma** : si l'app est au premier plan quand un geste arrive, elle repasse d'abord automatiquement
sur la fenêtre dont le titre contient « Figma » (app Figma, ou onglet Figma actif d'un navigateur), puis appuie sur →/←.
Tu n'as donc rien à cliquer. Si ta présentation est dans une autre fenêtre (PowerPoint, Google Slides…) et que
tu cliques dessus, les touches vont directement dedans.

Limites : le titre de la fenêtre doit contenir « Figma » (dans un navigateur, l'onglet Figma doit être
l'onglet actif). Si la fenêtre Figma est introuvable, la touche reste dans l'app.

## Si la caméra ne démarre pas
Windows → Paramètres → Confidentialité et sécurité → Caméra → active **« Laisser les applications de bureau accéder à votre caméra »**.

## Les fichiers

| Fichier | Rôle |
|---|---|
| `main.js` | Le « backstage » : crée la fenêtre, autorise la caméra, appuie sur les touches, sauvegarde les réglages |
| `preload.js` | Pont sécurisé entre la fenêtre et `main.js` (4 fonctions : `sendKey`, `quit`, `loadSettings`, `saveSettings`) |
| `renderer/index.html` `panel.css` `panel.js` | L'interface (copie de `panel/` de l'extension) |
| `renderer/gestures.js` | Le moteur de gestes (copie de `engine/gestures.js`, seuls les chemins MediaPipe changent) |
| `lib/mediapipe/` | MediaPipe (IA de détection de la main), fourni avec l'app |

## Différences avec l'extension
- Les touches sont envoyées par Windows (PowerShell `SendKeys`), pas par un script injecté dans Figma.
- Les réglages sont sauvegardés dans un fichier (`%APPDATA%\point-right-app\settings.json`).
- Rien n'est envoyé sur Internet, aucune image n'est enregistrée.
- Le moteur et l'interface sont des **copies** : si tu modifies `engine/gestures.js`, reporte le changement dans `renderer/gestures.js`.

## Déboguer
```
set POINTRIGHT_DEBUG=1
npm start
```
Ouvre les outils de développement et affiche les messages de la fenêtre dans le terminal.
Si tu lances depuis VS Code et que l'app s'ouvre comme du Node simple, fais d'abord `set ELECTRON_RUN_AS_NODE=`.
