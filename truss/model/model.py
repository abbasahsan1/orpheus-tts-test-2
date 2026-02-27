"""
Orpheus TTS – TRT-LLM Model Server
====================================
Based on: https://github.com/basetenlabs/truss-examples/tree/main/orpheus-best-performance

High-performance TTS with:
- TRT-LLM engine (compiled by Baseten Engine Builder)
- Batched SNAC decoding via `batched` library + torch.compile
- Pipelined async token → audio conversion
- Text chunking for long prompts
- Streaming raw 16-bit PCM at 24 kHz mono

Target: 16-24 concurrent real-time streams on H100 MIG 40GB
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from pathlib import Path
from typing import Any, Awaitable, Iterator, List

import batched
import fastapi
import numpy as np
import torch
from fastapi.responses import Response, StreamingResponse
from snac import SNAC
from transformers import AutoTokenizer

# ─── Global Inference Mode ──────────────────────────────────────────────────────
# Force inference mode for the lifetime of the process to avoid autograd overhead.
_inference_mode_raii_guard = torch._C._InferenceMode(True)

# ─── Constants ──────────────────────────────────────────────────────────────────

_TOKEN_RE = re.compile(r"<custom_token_(\d+)>")
SNAC_DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
SNAC_MAX_BATCH = 64
PREPROCESS_STREAM = torch.Stream(SNAC_DEVICE)
MAX_CHARACTERS_INPUT = 6144
MAX_CHUNK_SIZE = 280

# ─── SNAC Batched Decoder ───────────────────────────────────────────────────────


class SnacModelBatched:
    """GPU-resident SNAC decoder with dynamic batching and torch.compile.

    Uses the `batched` library for automatic request coalescing: concurrent
    decode calls are gathered into a single batched GPU operation, amortizing
    kernel launch overhead across all active streams.

    torch.compile with dynamic shapes is used to JIT-optimize the decoder
    and quantizer, providing ~30% speedup after warmup.
    """

    def __init__(self):
        self.dtype_decoder = torch.float32

        model = SNAC.from_pretrained("/app/snac_24khz").eval()
        model = model.to(SNAC_DEVICE)
        model.decoder = model.decoder.to(self.dtype_decoder)

        self.snac_model = model
        self.stream = torch.Stream()

        # Attempt torch.compile warmup; fall back silently to eager mode if
        # Triton is incompatible with the installed CUDA version (e.g. CUDA 13+).
        self._try_compile()

    def _try_compile(self):
        """Attempt JIT-compile of decoder + quantizer with full batch warmup.

        Falls back to eager mode if torch.compile / Triton is unavailable or
        incompatible (e.g. the TRT-LLM base image ships Triton that predates
        CUDA 13 support).
        """
        model = self.snac_model
        try:
            decoder = torch.compile(model.decoder, dynamic=True)
            quantizer = torch.compile(model.quantizer, dynamic=True)

            t = time.time()
            logging.info("Starting torch.compile warmup...")
            for bs_size in range(1, SNAC_MAX_BATCH + 1):
                codes = [
                    torch.randint(1, 4096, (bs_size, 4)).to(SNAC_DEVICE),
                    torch.randint(1, 4096, (bs_size, 8)).to(SNAC_DEVICE),
                    torch.randint(1, 4096, (bs_size, 16)).to(SNAC_DEVICE),
                ]
                with torch.inference_mode():
                    intermed = quantizer.from_codes(codes)
                    decoder(intermed.to(self.dtype_decoder))

            self.snac_model.decoder = decoder
            self.snac_model.quantizer = quantizer
            logging.info(f"torch.compile warmup completed in {time.time() - t:.2f}s")
        except Exception as exc:
            logging.warning(
                f"torch.compile unavailable ({exc}); running SNAC in eager mode."
            )

    @batched.dynamically(batch_size=SNAC_MAX_BATCH, timeout_ms=15)
    def batch_snac_model(
        self, items: list[dict[str, list[torch.Tensor]]]
    ) -> list[torch.Tensor]:
        """Dynamically batched SNAC decode.

        The `batched` decorator coalesces concurrent calls: if multiple
        requests submit decode jobs within timeout_ms, they are stacked
        into a single GPU operation, yielding massive throughput gains
        under concurrency.

        Extracts audio_hat[:, :, 2048:4096] — the 2nd frame window with
        optimal context (1 left + 2 right frames).
        """
        with torch.inference_mode(), torch.cuda.stream(self.stream):
            all_codes = [codes["codes"] for codes in items]
            can_be_batched = len(items) > 1 and all(
                codes[0].shape == all_codes[0][0].shape for codes in all_codes
            )

            if can_be_batched:
                # Stack into [batch, seq_len] per codebook level
                stacked_codes: tuple[torch.Tensor, torch.Tensor, torch.Tensor] = [
                    torch.cat([item[i] for item in all_codes], dim=0)
                    for i in range(3)
                ]
                stacked_z_q = self.snac_model.quantizer.from_codes(stacked_codes)
                output_batched = self.snac_model.decoder(
                    stacked_z_q.to(self.dtype_decoder)
                )[:, :, 2048:4096].to(torch.float32)

                out = output_batched.split(1, dim=0)
            else:
                if len(items) > 1:
                    logging.warning(
                        "Items can't be batched (shape mismatch), using individual decoding."
                    )
                out: list[torch.Tensor] = []
                for codes in all_codes:
                    stacked_z_q = self.snac_model.quantizer.from_codes(codes)
                    out.append(
                        self.snac_model.decoder(stacked_z_q.to(self.dtype_decoder))[
                            :, :, 2048:4096
                        ].to(torch.float32)
                    )

            self.stream.synchronize()
            return out


# ─── Module-level SNAC singleton ────────────────────────────────────────────────
model_snac = SnacModelBatched()


# ─── Token Processing Utilities ─────────────────────────────────────────────────


def turn_token_into_id(token_string: int, index: int) -> int:
    """Convert a custom token ID back to a SNAC code."""
    return token_string - 10 - ((index % 7) * 4096)


def split_custom_tokens(s: str) -> List[int]:
    """Extract all custom token IDs from a token string."""
    matches = _TOKEN_RE.findall(s)
    return [int(match) for match in matches if match != "0"]


# ─── Async Token-to-Audio Pipeline ─────────────────────────────────────────────


async def tokens_decoder(
    token_gen: Iterator, request_id: str, start_time: float
) -> Iterator[bytes]:
    """Pipelined async decoder: converts token stream to audio bytes.

    Architecture:
    - Producer coroutine consumes tokens, groups into 4-frame windows (28 tokens)
    - Each window is submitted as an asyncio.Task for SNAC decode
    - Consumer yields audio bytes in strict order (FIFO queue)

    This pipeline ensures GPU decode overlaps with token generation,
    maximizing throughput and minimizing latency.
    """
    assert hasattr(token_gen, "__aiter__")
    audio_queue: asyncio.Queue = asyncio.Queue()

    async def producer(token_gen: Iterator):
        buffer: list[int] = []
        count = 0
        tft = 0.0

        async for token_sim in token_gen:
            if tft == 0:
                tft = time.time()

            for tok_str in split_custom_tokens(token_sim):
                token = turn_token_into_id(int(tok_str), count)
                buffer.append(token)
                count += 1

                # Every 7 tokens = 1 frame; once we have 28 tokens (4 frames),
                # extract the last 28 for decoding
                if count % 7 == 0 and count > 27:
                    buf_to_proc = buffer[-28:]
                    task = asyncio.create_task(convert_to_audio(buf_to_proc))
                    audio_queue.put_nowait(task)

        audio_queue.put_nowait(None)

        elapsed = time.time() - start_time
        time_to_first_token = tft - start_time if tft else elapsed
        time_of_generation = time.time() - tft if tft else 0.001
        token_generation_speed = count / time_of_generation if time_of_generation > 0 else 0

        logging.info(
            f"Finished `{request_id}`, total tokens: {count}, time: {elapsed:.2f}s. "
            f"tokens/s generation: {token_generation_speed:.2f} "
            f"(ttft: {time_to_first_token:.2f}s, generation time: {time_of_generation:.2f}s) "
            f"real-time factor: {(token_generation_speed / 100):.2f}"
        )

    producer_task = asyncio.create_task(producer(token_gen))

    while True:
        task: None | Awaitable[bytes | None] = await audio_queue.get()
        if task is None:
            break
        audio_bytes = await task
        if audio_bytes is not None:
            yield audio_bytes
        audio_queue.task_done()

    assert audio_queue.empty(), f"audio queue is not empty: e.g. {audio_queue.get_nowait()}"
    await producer_task


@torch.inference_mode()
async def convert_to_audio(frame_ids: list[int]) -> bytes | None:
    """Convert a 4-frame window (28 token IDs) into raw PCM bytes.

    Separates the 7-per-frame token layout into 3 SNAC codebook levels,
    validates ranges, then delegates to the batched SNAC decoder.
    """
    n = len(frame_ids) // 7
    if n == 0:
        return None

    arr = torch.tensor(frame_ids[: n * 7], dtype=torch.int32)
    mat = arr.view(n, 7)

    codes_0 = mat[:, 0]
    codes_1 = mat[:, [1, 4]].reshape(-1)
    codes_2 = mat[:, [2, 3, 5, 6]].reshape(-1)

    if (
        ((codes_0 < 0) | (codes_0 > 4096)).any()
        or ((codes_1 < 0) | (codes_1 > 4096)).any()
        or ((codes_2 < 0) | (codes_2 > 4096)).any()
    ):
        logging.warning("Invalid token IDs detected, skipping audio generation.")
        return None

    with torch.cuda.stream(PREPROCESS_STREAM):
        codes = [
            codes_0.unsqueeze(0).to(SNAC_DEVICE),
            codes_1.unsqueeze(0).to(SNAC_DEVICE),
            codes_2.unsqueeze(0).to(SNAC_DEVICE),
        ]
        PREPROCESS_STREAM.synchronize()

    audio_hat = await model_snac.batch_snac_model.acall({"codes": codes})
    audio_np = audio_hat.numpy(force=True)
    audio_bytes = (audio_np * 32767).astype(np.int16).tobytes()
    return audio_bytes


# ─── Model Class ────────────────────────────────────────────────────────────────


class Model:
    # Truss Model class for Orpheus TTS.
    #
    # Lifecycle:
    # 1. __init__: receives TRT-LLM engine handle and secrets
    # 2. load(): loads tokenizer, precomputes format strings
    # 3. predict(): handles incoming requests, streams PCM audio

    def __init__(self, trt_llm, **kwargs) -> None:
        self._secrets = kwargs["secrets"]
        self._engine = trt_llm["engine"]
        self._data_dir = kwargs["data_dir"]
        self._model = None
        self._tokenizer = None
        self.start_id = [128259]
        self.end_ids = [128009, 128260, 128261, 128257]

    def load(self) -> None:
        self._tokenizer = AutoTokenizer.from_pretrained(
            Path(self._data_dir) / "tokenization"
        )

        self.start_tokenized = (
            self._tokenizer.decode(self.start_id) + self._tokenizer.bos_token
        )
        self.end_tokenized = self._tokenizer.decode(self.end_ids)

        # Verify fast format matches slow format
        self.use_fast_fmt = self._format_prompt_fast(
            "hello world", "tara"
        ) == self._format_prompt_slow("hello world", "tara")

        logging.info(
            f"Tokenizer loaded. Fast format: {self.use_fast_fmt}. "
            f"Start tokens: {self.start_tokenized!r}, End tokens: {self.end_tokenized!r}"
        )

    def _format_prompt_slow(self, prompt: str, voice: str = "tara") -> str:
        """Format prompt via full tokenizer encode/decode (reference impl)."""
        adapted_prompt = f"{voice}: {prompt}" if voice else prompt
        input_ids = self._tokenizer.encode(adapted_prompt)
        full_ids = self.start_id + input_ids + self.end_ids
        return self._tokenizer.decode(full_ids)

    def _format_prompt_fast(self, prompt: str, voice: str = "tara") -> str:
        """Format prompt via string concatenation (fast path)."""
        token_stream = self.start_tokenized
        if voice:
            token_stream += f"{voice}: "
        token_stream += prompt
        token_stream += self.end_tokenized
        return token_stream

    def format_prompt(self, prompt: str, voice: str = "tara") -> str:
        """Format the prompt for the model, using fast path when possible."""
        if self.use_fast_fmt:
            return self._format_prompt_fast(prompt, voice)
        else:
            logging.warning("Using slow format path")
            return self._format_prompt_slow(prompt, voice)

    def _chunk_text(self, text: str, max_len: int) -> list[str]:
        """Split text into chunks ≤ max_len chars, preferring natural boundaries.

        Priority: double newlines → sentence enders (.?!) → commas → spaces → hard cut.
        """
        if len(text) <= max_len:
            return [text]

        chunks = []
        start = 0

        while start < len(text):
            end = min(start + max_len, len(text))
            window = text[start:end]

            # Prefer paragraph breaks
            split_at = window.rfind("\n")
            if split_at == -1 or split_at < max_len * 0.5:
                # Prefer sentence boundaries
                split_at = max(
                    window.rfind("."), window.rfind("?"), window.rfind("!")
                )
                if split_at != -1:
                    split_at += 1  # Include the punctuation

            if split_at == -1 or split_at < max_len * 0.33:
                # Prefer last comma
                split_at = window.rfind(",")

            if split_at == -1:
                # Prefer last space
                split_at = window.rfind(" ")

            if split_at == -1:
                split_at = len(window)

            chunk = text[start : start + split_at].strip()
            if chunk:
                chunks.append(chunk)

            start = start + split_at
            # Skip leading whitespace before next chunk
            while start < len(text) and text[start].isspace():
                start += 1

        return chunks or [""]

    async def predict(
        self, model_input: Any, request: fastapi.Request
    ) -> StreamingResponse:
        """Handle TTS generation request.

        Accepts:
            model_input: dict with keys:
                - prompt (str, required): Text to synthesize
                - voice (str): Named voice (tara, leah, jess, leo, dan, mia, zac, zoe)
                - max_tokens (int): Max generation tokens
                - max_chunk_size (int): Max chars per text chunk
                - temperature (float): Sampling temperature
                - top_p (float): Nucleus sampling threshold
                - repetition_penalty (float): Token repetition penalty
                - request_id (str): Optional tracking ID

        Returns:
            StreamingResponse with media_type="audio/wav" streaming raw PCM bytes
        """
        req_id = str(model_input.get("request_id", uuid.uuid4()))

        try:
            max_chunk_size = model_input.get("max_chunk_size", MAX_CHUNK_SIZE)
            voice = model_input.get("voice", "tara")

            # Validate voice
            known_voices = {"tara", "leah", "jess", "leo", "dan", "mia", "zac", "zoe"}
            if voice not in known_voices:
                voice = "tara"

            # 1) Chunk the original prompt before formatting
            original_prompt: str = model_input.get("prompt", "")
            if not original_prompt:
                return Response("'prompt' is required", status_code=400)

            chunks = self._chunk_text(original_prompt, max_chunk_size)
            formatted_chunks = [
                self.format_prompt(chunk, voice=voice) for chunk in chunks
            ]

            total_input_length = len(original_prompt)
            logging.info(
                f"Starting request_id {req_id} with total input length {total_input_length} "
                f"split into {len(chunks)} chunk(s) (max {max_chunk_size} chars per chunk)."
            )

            # 2) Model params
            model_input["temperature"] = model_input.get("temperature", 0.6)
            model_input["top_p"] = model_input.get("top_p", 0.8)
            model_input["max_tokens"] = model_input.get("max_tokens", 6144)
            model_input["end_id"] = 128258
            model_input["repetition_penalty"] = model_input.get(
                "repetition_penalty", 1.1
            )

            start_time = time.time()

            async def audio_stream(req_id: str):
                # 3) Stream each chunk sequentially (preserves text order)
                for idx, chunk in enumerate(formatted_chunks):
                    model_input["prompt"] = chunk

                    logging.info(
                        f"[{req_id}] Streaming chunk {idx + 1}/{len(chunks)}"
                    )

                    token_gen = await self._engine.predict(model_input, request)
                    if isinstance(token_gen, StreamingResponse):
                        token_gen = token_gen.body_iterator

                    # 4) Forward audio bytes as we decode them
                    async for chunk_bytes in tokens_decoder(
                        token_gen, req_id, start_time
                    ):
                        yield chunk_bytes

                logging.info(
                    f"[{req_id}] Completed streaming {len(chunks)} chunk(s)."
                )

            return StreamingResponse(
                audio_stream(req_id),
                media_type="audio/wav",
                headers={"X-Baseten-Input-Tokens": str(total_input_length)},
            )

        except Exception as e:
            logging.error(f"Error in request_id {req_id}: {e} with input {model_input}")
            return Response(
                f"An internal server error occurred while processing your request {req_id}",
                status_code=500,
            )
