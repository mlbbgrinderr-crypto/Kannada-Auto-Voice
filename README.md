# Kannada Auto Voice Generator

Paste a Kannada script, enter an ElevenLabs Voice ID, pick a model, press **Generate Audio** — the app splits the script into safe chunks, generates MP3 for each one, and lets you download individual files, a zip of everything, or one merged MP3.

## Deploy to Vercel (no coding required)

1. Go to [vercel.com](https://vercel.com) and sign in (GitHub login is easiest).
2. Click **Add New → Project**, then **import** this folder — either:
   - upload it as a GitHub repo and import that repo, or
   - if your Vercel plan supports it, drag-and-drop this folder directly.
3. Leave all build settings on their defaults (this project needs no build step — Framework Preset: "Other").
4. Before clicking Deploy, open **Environment Variables** and add:
   - **Name:** `ELEVENLABS_API_KEY`
   - **Value:** your ElevenLabs API key
5. Click **Deploy**. Vercel gives you a URL like `https://your-app.vercel.app`.
6. Open that URL on your Android phone. That's it.

If you ever change the key, update it in Vercel → Project → Settings → Environment Variables, then redeploy (Vercel → Deployments → ⋯ → Redeploy).

## Using the app

1. Paste your Kannada script into the box.
2. Enter the Voice ID (from your ElevenLabs account), or pick a saved one.
3. Leave the model as `eleven_multilingual_v2` (recommended for Kannada) or pick another.
4. Tap **Generate Audio**. Watch the progress bar — you can leave and come back; if you paste the exact same script/voice/model again, the app offers to continue from where it left off.
5. When done, download chunks individually, as a zip, or merged into one MP3.

## Notes

- Your `ELEVENLABS_API_KEY` only ever lives on Vercel's servers (`api/generate.js`). The browser never sees it.
- Chunk size defaults to 2,500 characters per request, safely under every current ElevenLabs model's limit. To change it, edit `CONFIG.maxChunkChars` near the top of `app.js`.
- Saved voices and in-progress jobs are stored in your phone's browser (localStorage + IndexedDB) — clearing browser data clears them too.
- "Merge Into One MP3" joins the generated MP3 files back-to-back in order. This plays correctly in virtually all players; if you need frame-perfect gapless merging for professional editing, use dedicated audio software afterward.
