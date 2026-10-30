import os
import io
import asyncio
import base64
import wave
import cv2
import httpx
import numpy as np
from dotenv import dotenv_values
from faster_whisper import decode_audio
from pydantic import BaseModel, Field
from typing import Literal, Optional

import db

# Commands, conversation topics, label reading and scene descriptions go to OpenAI through the owner's
# metering gateway: OPENAI_BASE_URL is the gateway, OPENAI_API_KEY its token for this backend (both in
# backend/.env). Until 30.10.2026 these calls went to Gemini. Speech is transcribed first (the chat model
# gets text), images go to the chat model as they are.
# The gateway pair is read from backend/.env only: a shell that exports its own OPENAI_API_KEY would otherwise
# send that key to the gateway (401) or, worse, a fixed key straight to OpenAI.
ENV_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
DEFAULT_CHAT_MODEL = "gpt-5.4-nano"
DEFAULT_STT_MODEL = "gpt-4o-transcribe"
DEFAULT_REASONING_EFFORT = "none"  # same answers as "low" on these tasks, ~2 s faster (smoke 30.10.2026)
LLM_TIMEOUT_SECONDS = 60
AUDIO_SAMPLE_RATE = 16000  # conversation chunks are joined into one 16 kHz mono WAV for a single transcription


class CommandAction(BaseModel):
    """Structured output schema for command processing."""
    user_transcript: str = Field(
        description="The exact text of what the user said."
    )
    action: Literal["add_note", "set_reminder", "retrieve_memory", "recognize_object", "add_topic", "respond"] = Field(
        description="The action to take based on the user's command."
    )
    topic_person: Optional[str] = Field(
        None, description="If action is add_topic: the name of the person the conversation was with, exactly as in the known people list. Empty if the user didn't say who."
    )
    topic_text: Optional[str] = Field(
        None, description="If action is add_topic: what they talked about, as a short topic of 3-8 words in English."
    )
    note_text: Optional[str] = Field(
        None, description="The text content of the note, if action is add_note or recognize_object."
    )
    reminder_time: Optional[str] = Field(
        None, description="When to remind, if action is set_reminder."
    )
    reminder_task: Optional[str] = Field(
        None, description="What to remind about, if action is set_reminder."
    )
    memory_query: Optional[str] = Field(
        None, description="The query to search memories, if action is retrieve_memory."
    )
    object_name: Optional[str] = Field(
        None, description="The name or label the user gives to the object they want to save, if action is recognize_object."
    )
    spoken_response: str = Field(
        "", description="A friendly text response to show the user in the chat."
    )


class ConversationTopic(BaseModel):
    """Structured output for summarizing a conversation with a known person."""
    has_topic: bool = Field(
        description="True only if the transcript contains a real conversation with a clear subject. False for silence, noise, TV, or just greetings."
    )
    topic: str = Field(
        "", description="The main subject of the conversation as a short topic of 3-8 words in English, e.g. 'Planning a trip to Japan'."
    )


class SceneUpdate(BaseModel):
    """Structured output for the ambient context check."""
    changed: bool = Field(
        description="True only if the surroundings meaningfully changed compared to the previous description."
    )
    description: str = Field(
        "", description="One short sentence describing the current surroundings, if changed."
    )


LABEL_IMAGE_MAX_SIDE = 640  # px — enough to read a label held near the camera, and faster to upload
LABEL_READ_ATTEMPTS = 2  # the gateway or the model sometimes fails a call — retry once before giving up


def _shrink_jpeg(data: bytes) -> bytes:
    """Downscale a JPEG so its longer side is at most LABEL_IMAGE_MAX_SIDE (smaller upload, faster answer)."""
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return data
    h, w = img.shape[:2]
    scale = LABEL_IMAGE_MAX_SIDE / max(h, w)
    if scale >= 1:
        return data
    img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    return cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 90])[1].tobytes()


class LabelReading(BaseModel):
    """Structured output for reading the printed text on an object (e.g. a medicine box)."""
    text: str = Field(
        "", description="All clearly readable printed text on the object, as written. Empty if nothing is readable."
    )
    product_name: str = Field(
        "", description="The product or medicine name (brand name), if there is one. Empty otherwise."
    )
    dosage: str = Field(
        "", description="Strength/dosage printed on it, e.g. '200 mg' or '500 mg/5 ml'. Empty if none."
    )


class Introduction(BaseModel):
    """Structured output for naming a new person by voice (the AR mode has no keyboard)."""
    name: str = Field(
        "", description="The person's name exactly as the user said it, capitalised. Empty if no name was said."
    )
    relation: str = Field(
        "", description="Who the person is to the user, in English, e.g. 'brother', 'neighbour', 'developer'. Empty if not said."
    )


class ObjectDescription(BaseModel):
    """Structured output for naming an object by voice (the AR mode has no keyboard)."""
    name: str = Field(
        "", description="What the object is called, as the user said it, capitalised, e.g. 'Amoksiklav' or 'Reading glasses'. Empty if not said."
    )
    dosage: str = Field(
        "", description="Strength of a medicine if said, e.g. '500 mg'. Empty otherwise."
    )
    notes: str = Field(
        "", description="How or when to use it if said, in English, e.g. 'Take 3 times a day'. Empty otherwise."
    )


def _strict_schema(model: type[BaseModel]) -> dict:
    """OpenAI strict json_schema from a pydantic model: every field required (optional ones accept null), no extras."""
    props = {
        name: {k: v for k, v in prop.items() if k not in ("default", "title")}
        for name, prop in model.model_json_schema()["properties"].items()
    }
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}


def _image_part(jpeg: bytes) -> dict:
    return {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()}}


def _chunks_to_wav(chunks: list[bytes]) -> bytes:
    """Decode the browser's webm chunks (each a complete file) and join them into one 16 kHz mono WAV."""
    parts = []
    for chunk in chunks:
        try:
            parts.append(decode_audio(io.BytesIO(chunk), sampling_rate=AUDIO_SAMPLE_RATE))
        except Exception as e:  # one broken chunk should not lose the whole conversation
            print(f"[LLM] Skipping an audio chunk that could not be decoded: {e}")
    if not parts:
        return b""
    pcm = (np.clip(np.concatenate(parts), -1.0, 1.0) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(AUDIO_SAMPLE_RATE)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


class LLMOrchestrator:
    _http: httpx.AsyncClient | None = None  # one connection pool for every instance (one per WebSocket)

    def __init__(self, ws_send_callback):
        self.ws_send_callback = ws_send_callback
        self.chat_model = os.environ.get("KINLY_CHAT_MODEL", DEFAULT_CHAT_MODEL)
        self.stt_model = os.environ.get("KINLY_STT_MODEL", DEFAULT_STT_MODEL)
        self.reasoning_effort = os.environ.get("KINLY_REASONING_EFFORT", DEFAULT_REASONING_EFFORT)
        gateway = dotenv_values(ENV_FILE) if os.path.exists(ENV_FILE) else {}
        base_url = (gateway.get("OPENAI_BASE_URL") or "").rstrip("/")
        api_key = gateway.get("OPENAI_API_KEY") or ""
        if not base_url or not api_key:
            print("WARNING: OPENAI_BASE_URL / OPENAI_API_KEY missing in backend/.env. LLM features will not work.")
            self.client = None
        elif "api.openai.com" in base_url:
            print("WARNING: OPENAI_BASE_URL must be the metering gateway, not api.openai.com. LLM features are off.")
            self.client = None
        else:
            if LLMOrchestrator._http is None:
                LLMOrchestrator._http = httpx.AsyncClient(
                    base_url=base_url,
                    headers={"Authorization": f"Bearer {api_key}"},
                    timeout=LLM_TIMEOUT_SECONDS,
                )
            self.client = LLMOrchestrator._http

    async def _chat(self, what: str, messages: list[dict], max_tokens: int, schema: type[BaseModel] | None = None):
        """One chat call. Returns the parsed model when a schema is given, the text otherwise; raises with the reason."""
        body = {
            "model": self.chat_model,
            "messages": messages,
            "max_completion_tokens": max_tokens,
            "reasoning_effort": self.reasoning_effort,
        }
        if schema is not None:
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": schema.__name__, "strict": True, "schema": _strict_schema(schema)},
            }
        r = await self.client.post("/chat/completions", json=body)
        if r.status_code != 200:
            raise RuntimeError(f"{what}: HTTP {r.status_code} {r.text[:200]}")
        choice = r.json()["choices"][0]
        if choice.get("finish_reason") != "stop":
            raise RuntimeError(f"{what}: finish_reason={choice.get('finish_reason')} (answer cut or refused)")
        content = choice["message"].get("content") or ""
        return schema.model_validate_json(content) if schema is not None else content

    async def _transcribe(self, what: str, audio: bytes, filename: str, mime: str) -> str:
        r = await self.client.post(
            "/audio/transcriptions",
            files={"file": (filename, audio, mime)},
            data={"model": self.stt_model},
        )
        if r.status_code != 200:
            raise RuntimeError(f"{what}: transcription HTTP {r.status_code} {r.text[:200]}")
        return (r.json().get("text") or "").strip()

    async def process_command(self, audio_b64: str, face_context: list) -> dict | None:
        """Process a spoken voice command: transcribe the audio, then pick the action with structured output."""
        if not self.client:
            return None

        try:
            # Build context
            patient_context = db.build_context_string()

            # Format visible faces
            face_info = ""
            if face_context:
                face_names = [f"{f.get('name', 'Unknown')} ({f.get('relation', 'N/A')})" for f in face_context]
                face_info = f"\nCurrently visible people: {', '.join(face_names)}"

            system_prompt = f"""You are a memory companion assistant for people with memory difficulties or cognitive problem.
Based on the user's spoken command (given to you as its transcript), determine what action to take.

{patient_context}
{face_info}

Actions:
- add_note: Save information the user wants to remember
- set_reminder: Set a reminder for a specific time/event
- retrieve_memory: Search past memories/notes for information
- recognize_object: The user wants to save/remember an object currently visible in front of the camera. Extract the note/description they want to attach (note_text) and optionally the name they use for the object (object_name). The system will detect and photograph the central object automatically.
- add_topic: The user wants to remember what they talked about with a person (e.g. "remember that Dimka told me about his exam", "save that we talked about the trip"). Set topic_person to that person's name from the known people list (leave it empty if they didn't say who — the person in front of the camera is used) and topic_text to a short topic.
- respond: Just respond conversationally (no special action needed)

Always provide a friendly spoken_response.
When the user mentions wanting to remember, save, or recognize an object/item/thing in front of them (e.g. medicine, keys, food), use recognize_object."""

            audio_bytes = base64.b64decode(audio_b64)
            transcript = await self._transcribe("command", audio_bytes, "command.webm", "audio/webm")
            if not transcript:
                return {"user_transcript": "", "action": "respond",
                        "spoken_response": "Sorry, I didn't catch that. Please try again."}
            action = await self._chat(
                "command",
                [{"role": "system", "content": system_prompt}, {"role": "user", "content": transcript}],
                max_tokens=2000,
                schema=CommandAction,
            )
            result = action.model_dump()
            result["user_transcript"] = transcript
            print(f"[LLM] Structured output: {result}")
            return result

        except Exception as e:
            print(f"Error processing command: {e}")
            return {"action": "respond", "spoken_response": f"Sorry, I had trouble understanding that. ({e})"}

    async def summarize_conversation(self, person: str, relation: str, audio_chunks: list[bytes]) -> str:
        """Turn the recorded audio of a conversation with a known person into a short topic.

        The chunks are joined and transcribed in one call (any language), then the chat model picks the topic.
        Returns "" when there was no real conversation or the call failed.
        """
        if not self.client or not audio_chunks:
            return ""
        try:
            wav = await asyncio.to_thread(_chunks_to_wav, audio_chunks)
            if not wav:
                return ""
            transcript = await self._transcribe(f"conversation with {person}", wav, "conversation.wav", "audio/wav")
            if not transcript:
                print(f"[LLM] Conversation with {person}: nothing transcribed")
                return ""
            prompt = (
                f"This is a transcript of a conversation between the user and {person}"
                f"{f' ({relation})' if relation else ''}, possibly in any language. "
                "What was the main subject? If there was no real conversation with a clear subject "
                "(only silence, noise, TV, or greetings), set has_topic=false.\n\n"
                f"Transcript:\n{transcript}"
            )
            result = await self._chat(f"conversation with {person}", [{"role": "user", "content": prompt}],
                                      max_tokens=1000, schema=ConversationTopic)
            print(f"[LLM] Conversation with {person}: {result.model_dump()}")
            return result.topic.strip() if result.has_topic else ""
        except Exception as e:
            print(f"Error summarizing conversation with {person}: {e}")
            return ""

    async def parse_introduction(self, audio_b64: str, mime: str = "audio/webm") -> dict:
        """Name and relation of a new person from the user's spoken introduction, e.g. "Niaz, developer".

        Returns {"transcript", "name", "relation"} (empty strings when nothing usable was said) or {"error"}.
        """
        if not self.client:
            return {"error": "the LLM is not configured"}
        try:
            transcript = await self._transcribe("introduction", base64.b64decode(audio_b64), "intro.webm",
                                                mime.split(";")[0])
            if not transcript:
                return {"transcript": "", "name": "", "relation": ""}
            result = await self._chat(
                "introduction",
                [{"role": "system", "content": (
                    "The user is introducing a person standing in front of them so a memory assistant can "
                    "remember that person's face. From the transcript, take the person's name and who they are "
                    "to the user. Leave a field empty if it was not said."
                )}, {"role": "user", "content": transcript}],
                max_tokens=500,
                schema=Introduction,
            )
            print(f"[LLM] Introduction: '{transcript}' -> {result.model_dump()}")
            return {"transcript": transcript, **result.model_dump()}
        except Exception as e:
            print(f"Error parsing introduction: {e}")
            return {"error": str(e)}

    async def parse_object_description(self, audio_b64: str, mime: str = "audio/webm") -> dict:
        """Name, dosage and a usage note of an object from the user's spoken words, e.g. "Amoksiklav, 3 times a day".

        Returns {"transcript", "name", "dosage", "notes"} (empty strings when not said) or {"error"}.
        """
        if not self.client:
            return {"error": "the LLM is not configured"}
        try:
            transcript = await self._transcribe("object description", base64.b64decode(audio_b64), "object.webm",
                                                mime.split(";")[0])
            if not transcript:
                return {"transcript": "", "name": "", "dosage": "", "notes": ""}
            result = await self._chat(
                "object description",
                [{"role": "system", "content": (
                    "The user is naming an object they hold up so a memory assistant can remember it. From the "
                    "transcript, take the object's name, the dosage if it is a medicine, and a short note on how or "
                    "when to use it. Leave a field empty if it was not said."
                )}, {"role": "user", "content": transcript}],
                max_tokens=500,
                schema=ObjectDescription,
            )
            print(f"[LLM] Object description: '{transcript}' -> {result.model_dump()}")
            return {"transcript": transcript, **result.model_dump()}
        except Exception as e:
            print(f"Error parsing object description: {e}")
            return {"error": str(e)}

    async def read_label(self, images_jpeg: list[bytes]) -> dict:
        """Read the printed text on an object from one or more photos of it (different angles).

        Returns {"text", "product_name", "dosage"} — all empty when nothing is readable.
        If the call fails even after a retry, "error": True is added: that means
        "unknown", NOT "no text" — callers must not treat a failed read as an unlabelled object.
        """
        empty = {"text": "", "product_name": "", "dosage": ""}
        if not self.client or not images_jpeg:
            return {**empty, "error": True}
        content = [_image_part(_shrink_jpeg(img)) for img in images_jpeg]
        content.append({"type": "text", "text": (
            "These photos show the same object from different angles. Read the printed text on it "
            "(for medicine: the name and the strength). Only report text you can actually read — never guess."
        )})
        for attempt in range(LABEL_READ_ATTEMPTS):
            try:
                reading = await self._chat("label", [{"role": "user", "content": content}],
                                           max_tokens=2000, schema=LabelReading)
                print(f"[LLM] Label read: {reading.model_dump()}")
                return reading.model_dump()
            except Exception as e:
                print(f"Error reading label (attempt {attempt + 1}/{LABEL_READ_ATTEMPTS}): {e}")
                if attempt + 1 < LABEL_READ_ATTEMPTS:
                    await asyncio.sleep(0.5)
        return {**empty, "error": True}

    async def generate_ambient_summary(self, base64_image: str, previous_summary: str = "") -> str:
        """Describe the surroundings, or return "" when nothing meaningful changed since previous_summary."""
        if not self.client:
            return ""
        try:
            image_bytes = base64.b64decode(base64_image)
            if previous_summary:
                prompt = (
                    f'Previous description of the patient\'s surroundings: "{previous_summary}"\n'
                    "Look at the new image. Set changed=true only if something meaningful changed: "
                    "a different place or room, people arriving or leaving, or a different activity. "
                    "Camera movement, lighting, posture or small differences do NOT count. "
                    "If changed, describe the new surroundings in 1 short sentence."
                )
            else:
                prompt = "Describe the patient's surroundings in 1 short sentence. Set changed=true."
            result = await self._chat(
                "scene",
                [{"role": "user", "content": [_image_part(image_bytes), {"type": "text", "text": prompt}]}],
                max_tokens=1000,
                schema=SceneUpdate,
            )
            if not result.changed:
                return ""
            return result.description.strip()
        except Exception as e:
            print(f"Error generating ambient summary: {e}")
            return ""

    async def generate_session_summary(self, session_log: list[str]) -> str:
        if not self.client or not session_log:
            return ""
        try:
            prompt = "Summarize the recent session with the patient focusing on key events and contexts:\n" + "\n".join(session_log)
            return await self._chat("session summary", [{"role": "user", "content": prompt}], max_tokens=2000)
        except Exception as e:
            print(f"Error generating session summary: {e}")
            return ""

    def _init_gemma(self):
        """Lazy-load Gemma 3 1B for topic extraction. Uses MPS on Apple Silicon, CPU otherwise."""
        if not hasattr(self, '_gemma_pipe') or self._gemma_pipe is None:
            import torch
            from transformers import pipeline

            if torch.backends.mps.is_available():
                device = "mps"
            elif torch.cuda.is_available():
                device = "cuda"
            else:
                device = "cpu"

            print(f"[LLM] Loading Gemma 3 1B on {device}...")
            self._gemma_pipe = pipeline(
                "text-generation",
                model="google/gemma-3-1b-it",
                device=device,
                torch_dtype=torch.bfloat16 if device != "cpu" else torch.float32,
            )
            print(f"[LLM] Gemma 3 1B loaded successfully on {device}.")
        return self._gemma_pipe

    def extract_topic_sync(self, transcript: str) -> str | None:
        """Extract a short readable conversation topic using Gemma 3 1B (local)."""
        if not transcript.strip() or len(transcript.strip()) < 15:
            return None
        try:
            pipe = self._init_gemma()

            # Cap transcript to avoid excessive input
            text = transcript.strip()[:1500]

            messages = [
                {
                    "role": "user",
                    "content": (
                        "Extract the main conversation topic from this transcript in 3-6 words. "
                        "Reply with ONLY the topic, nothing else.\n\n"
                        f"Transcript: {text}"
                    ),
                }
            ]

            result = pipe(messages, max_new_tokens=20, do_sample=False)
            topic = result[0]["generated_text"][-1]["content"].strip()

            # Clean up: remove quotes, periods, prefixes
            topic = topic.strip('"\'.,!').strip()
            if topic.lower().startswith("topic:"):
                topic = topic[6:].strip()

            if topic and 3 < len(topic) < 80:
                print(f"[LLM] Gemma topic extracted: '{topic}'")
                return topic

            print(f"[LLM] Gemma topic rejected (len={len(topic)}): '{topic}'")
            return None
        except Exception as e:
            print(f"[LLM] Gemma topic extraction error: {e}")
            return None
