"""WebSocket data handler — receives audio, broadcasts transcription events."""

from __future__ import annotations

import json
import time
import wave
from typing import Any

import numpy as np
import pyaudio
import websockets
from scipy.signal import resample
from websockets.asyncio.server import ServerConnection

from src.building_blocks.terminal import TerminalColors as bcolors
from src.building_blocks.terminal import debug_print, format_now_hms_ms, format_timestamp_ns
from src.stt_server.state import ServerState

FORMAT = pyaudio.paInt16
CHANNELS = 1


def decode_and_resample(
    audio_data: bytes,
    original_sample_rate: int,
    target_sample_rate: int,
) -> bytes:
    """Decode 16-bit PCM data and resample to target rate."""
    if original_sample_rate == target_sample_rate:
        return audio_data

    audio_np = np.frombuffer(audio_data, dtype=np.int16)
    num_original_samples = len(audio_np)
    num_target_samples = int(num_original_samples * target_sample_rate / original_sample_rate)
    resampled_audio = resample(audio_np, num_target_samples)
    result: bytes = resampled_audio.astype(np.int16).tobytes()
    return result


async def data_handler(websocket: ServerConnection, state: ServerState) -> None:
    """Handle incoming audio data from a WebSocket client."""
    print(f"{bcolors.OKGREEN}Data client connected{bcolors.ENDC}")
    state.data_connections.add(websocket)

    # Replay current download state so clients that connect mid-download see the progress bar.
    if state.download_state is not None:
        try:
            await websocket.send(state.download_state)
        except websockets.exceptions.ConnectionClosed:
            state.data_connections.discard(websocket)
            return

    try:
        while True:
            message = await websocket.recv()
            if not state.recorder_ready.is_set():
                continue  # Ignore incoming audio during model download / init
            if isinstance(message, bytes):
                if state.extended_logging:
                    debug_print(f"Received audio chunk (size: {len(message)} bytes)", enabled=True)
                elif state.log_incoming_chunks:
                    print(".", end="", flush=True)

                metadata_length = int.from_bytes(message[:4], byteorder="little")
                metadata_json = message[4 : 4 + metadata_length].decode("utf-8")
                metadata: dict[str, Any] = json.loads(metadata_json)
                sample_rate: int = metadata["sampleRate"]

                if "server_sent_to_stt" in metadata:
                    stt_received_ns = time.time_ns()
                    metadata["stt_received"] = stt_received_ns
                    metadata["stt_received_formatted"] = format_timestamp_ns(stt_received_ns)
                    print(
                        f"Server received audio chunk of length {len(message)} bytes, metadata: {metadata}",
                    )

                if state.extended_logging:
                    debug_print(f"Processing audio chunk with sample rate {sample_rate}", enabled=True)
                chunk = message[4 + metadata_length :]

                if state.writechunks and isinstance(state.writechunks, str):
                    if not state.wav_file:
                        state.wav_file = wave.open(state.writechunks, "wb")  # noqa: SIM115
                        state.wav_file.setnchannels(CHANNELS)
                        state.wav_file.setsampwidth(pyaudio.get_sample_size(FORMAT))
                        state.wav_file.setframerate(sample_rate)
                    state.wav_file.writeframes(chunk)

                assert state.recorder is not None
                if sample_rate != 16000:
                    resampled_chunk = decode_and_resample(chunk, sample_rate, 16000)
                    if state.extended_logging:
                        debug_print(f"Resampled chunk size: {len(resampled_chunk)} bytes", enabled=True)
                    state.recorder.feed_audio(resampled_chunk)
                else:
                    state.recorder.feed_audio(chunk)
            else:
                print(f"{bcolors.WARNING}Received non-binary message on data connection{bcolors.ENDC}")
    except websockets.exceptions.ConnectionClosed as e:
        print(f"{bcolors.WARNING}Data client disconnected: {e}{bcolors.ENDC}")
    except Exception as e:
        print(f"{bcolors.FAIL}Data handler error: {type(e).__name__}: {e}{bcolors.ENDC}")
    finally:
        state.data_connections.discard(websocket)  # Use discard to avoid KeyError
        if state.recorder is not None:
            state.recorder.clear_audio_queue()


async def broadcast_audio_messages(state: ServerState) -> None:
    """Continuously read from audio_queue and broadcast to all data clients."""
    while True:
        message = await state.audio_queue.get()
        for conn in list(state.data_connections):
            try:
                timestamp = format_now_hms_ms()
                if state.extended_logging:
                    print(
                        f"  [{timestamp}] Sending message: {bcolors.OKBLUE}{message}{bcolors.ENDC}\n",
                        flush=True,
                        end="",
                    )
                await conn.send(message)
            except websockets.exceptions.ConnectionClosed:
                state.data_connections.discard(conn)
            except Exception as e:
                print(f"{bcolors.WARNING}Broadcast error for client: {type(e).__name__}: {e}{bcolors.ENDC}")
                state.data_connections.discard(conn)
