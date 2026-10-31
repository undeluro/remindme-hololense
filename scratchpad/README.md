# scratchpad

Working files that are not part of the app. Everything here except this README is git-ignored.

| Path | What it is |
|---|---|
| `smoke_llm_2026-10-30/smoke_llm.py` | One call of each LLM kind (command, conversation topic, label, scene) through the OpenAI gateway; makes its test speech with macOS `say` + ffmpeg |
| `e2e_box_2026-10-30/ws_check.py` | End-to-end check of the live backend as the Vercel page uses it: REST + CORS over https, WebSocket over wss with frames and one spoken command |
| `ar_v4_2026-10-30/` | Blocks spliced into `frontend/src/xr/KinlyAR.js` for the design v4 look, and the module before the change (`KinlyAR.before-v4.js`) |
| `ar_hud_2026-10-31/` | HUD rework of 31.10.2026: the AR module and App before it (`*.before-hud.*`), the spliced layout block, `mock_render.js` (draws one AR frame in the browser pane without a headset), the deploy log |
