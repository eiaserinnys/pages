# Private VTuber voice demo

The private page at `/d/seosoyoung-vtuber-live-private` uses `POST /api/vtuber-live/session` to exchange a browser WebRTC offer with GPT-Live 1. The existing public motion demo remains independent.

The endpoint requires a valid Pages session cookie, an email still present in `ALLOWED_EMAILS`, the configured same-origin `Origin`, and a JSON SDP offer under 64 KiB. The OpenAI key is a Worker secret named `VTUBER_OPENAI_API_KEY`; never embed it in the page. The client cannot select the upstream model or override server instructions. Duplicate starts within three seconds are suppressed per Worker instance; this is click protection, not a global quota.

Server configuration uses `gpt-live-1`, feminine voice `quartz`, Korean instructions requesting a bright young-adult feminine tone, and `gpt-5.6-luna` Responses delegation without external tools. Voice age is a requested style rather than a guaranteed API attribute.

The browser receives audio over the WebRTC track and uses the data channel for `session.started`, transcript deltas, and graceful `session.close` / `session.closed`. No Realtime session events or ephemeral API keys are used.

## Cost and verification

As of 2026-09-11, GPT-Live costs $0.05 per minute of connected session time, billed per second, plus delegated Responses usage. WebRTC initialization bills 15 seconds, credited against the running session. See [official pricing](https://developers.openai.com/api/docs/pricing) and [WebRTC setup](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live).

Run `npm test` and `npm run worker:check`. The focused tests cover authentication, origin checks, bounded input, fixed upstream configuration, output filtering, and duplicate start suppression. A real WebRTC smoke test also confirmed HTTP 201, Korean spoken output, and `session.closed` with 15 seconds of usage.
