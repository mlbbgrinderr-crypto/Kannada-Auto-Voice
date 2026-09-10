// api/generate.js
//
// Server-side proxy for ONE text-to-speech chunk.
// The browser never sees ELEVENLABS_API_KEY — it lives only in this
// function's environment (set it in Vercel → Project → Settings →
// Environment Variables).

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error:
        'Server is not configured: the ELEVENLABS_API_KEY environment variable is missing on this Vercel project.',
    });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid JSON in request body.' });
    }
  }
  body = body || {};

  const text = typeof body.text === 'string' ? body.text : '';
  const voiceId = typeof body.voice_id === 'string' ? body.voice_id.trim() : '';
  const modelId =
    typeof body.model_id === 'string' && body.model_id.trim()
      ? body.model_id.trim()
      : 'eleven_multilingual_v2';

  if (!text.trim()) {
    return res.status(400).json({ error: 'No text provided for this chunk.' });
  }
  if (!voiceId) {
    return res.status(400).json({ error: 'No Voice ID provided.' });
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`;

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
      }),
    });
  } catch (networkErr) {
    return res.status(502).json({
      error: `Network error while contacting ElevenLabs: ${networkErr.message}`,
    });
  }

  if (!upstream.ok) {
    let message = `ElevenLabs request failed with status ${upstream.status}.`;
    try {
      const errJson = await upstream.json();
      const detail = errJson && errJson.detail;
      if (typeof detail === 'string') message = detail;
      else if (detail && detail.message) message = detail.message;
      else if (detail) message = JSON.stringify(detail);
    } catch (e) {
      // Upstream body wasn't JSON — keep the generic status message.
    }

    if (upstream.status === 401) {
      message = `Invalid or unauthorized ElevenLabs API key. (${message})`;
    } else if (upstream.status === 404) {
      message = `Voice ID not found — double-check the Voice ID. (${message})`;
    } else if (upstream.status === 429) {
      message = `Rate limit or quota exhausted on ElevenLabs. (${message})`;
    } else if (upstream.status === 400) {
      message = `Invalid request — check the Voice ID and model. (${message})`;
    }

    return res.status(upstream.status).json({ error: message });
  }

  const arrayBuffer = await upstream.arrayBuffer();
  const audioBuffer = Buffer.from(arrayBuffer);

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Length', String(audioBuffer.length));
  return res.status(200).send(audioBuffer);
};
