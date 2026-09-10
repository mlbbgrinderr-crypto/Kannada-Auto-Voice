# Kannada Auto Voice

Mobile-first ElevenLabs narration app.

## Deploy
1. Import this project into Vercel.
2. Add Environment Variable:
   ELEVENLABS_API_KEY = your ElevenLabs API key
3. Deploy.
4. Open the deployed URL on Android.

## ElevenLabs key permissions
- Text to Speech: Access
- Voices: Read
- Everything else: No Access

The app keeps the API key server-side.

## Usage
Paste Kannada script, choose a voice, choose model, Generate Audio.
The app splits the script, generates MP3 chunks, shows progress, provides downloads, and can concatenate the MP3 chunks into one file.

For Kannada, Eleven Multilingual v2 is the safer default. Eleven v3 is also available but uses smaller request chunks.
