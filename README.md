# Uno online — 4 player web game

A real-time multiplayer Uno game for up to 4 players, playable in any browser.
Node.js + Express + Socket.io backend, single-page vanilla JS frontend.

## Deploy to Render (free, no credit card)

1. Go to https://render.com and sign up (free).
2. Put this project on GitHub:
   - Create a new repo (e.g. `uno-online`).
   - Upload all files in this folder (`server.js`, `package.json`, `public/index.html`)
     keeping the same folder structure.
3. In Render, click **New +** → **Web Service**.
4. Connect your GitHub repo.
5. Settings:
   - **Environment**: Node
   - **Build command**: `npm install`
   - **Start command**: `npm start`
   - **Instance type**: Free
6. Click **Create Web Service**. Render will build and deploy — takes 2-3 minutes.
7. You'll get a URL like `https://uno-online-xxxx.onrender.com` — that's your live game.
   Share it with up to 3 friends and play.

Note: on Render's free tier, the server sleeps after 15 minutes of no traffic and takes
~30-50 seconds to wake up on the next visit. That's fine for casual play — just give it
a moment to load if it's been idle.

## Alternative: Railway

Same idea — https://railway.app, "New Project" → "Deploy from GitHub repo" → it
auto-detects Node and runs `npm start`. Also has a free tier.

## Run locally first (optional, to test)

If you have Node.js installed on your computer:

```
npm install
npm start
```

Then open http://localhost:3000 in a few browser tabs to test with yourself before
deploying.

## How it works

- One player clicks **Create room**, gets a 4-letter code, shares it.
- Others open the same URL and click **Join room** with that code.
- The host can fill empty seats with bots and needs at least 2 players (human or bot)
  seated to start.
- Standard Uno rules: match color or number, skip/reverse/draw2 actions, wild and
  wild draw 4, stacking draw cards, Uno call-out with a 2-card penalty if caught
  forgetting.
- Scoring accumulates across rounds using the classic Uno point values (number cards
  at face value, action cards worth 20, wilds worth 50) from the losers' remaining
  hands.
