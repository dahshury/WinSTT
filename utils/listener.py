import os
import threading
import time
import io
import pyperclip
import pyaudio
import wave
import numpy as np
import pyautogui
from logger.logger import setup_logger
from utils import WhisperONNXTranscriber, VaDetector
from keyboard import KEY_DOWN, KEY_UP, hook_key, wait, unhook_all
from pynput.keyboard import Key, Controller
import pygame
from collections import deque  # Import deque for efficient sliding window
import difflib

logger = setup_logger()

class Recorder:
    def __init__(self, chunk=256, channels=1, rate=16000):
        self.CHUNK = chunk
        self.FORMAT = pyaudio.paInt16
        self.CHANNELS = channels
        self.RATE = rate
        self._running = threading.Event()
        self._frames = []
        self.p = pyaudio.PyAudio()
        self.stream = None
        self.logger = setup_logger()

    def start(self):
        self._running.set()
        self._frames = []
        try:
            # Open the stream
            self.stream = self.p.open(
                format=self.FORMAT,
                channels=self.CHANNELS,
                rate=self.RATE,
                input=True,
                frames_per_buffer=self.CHUNK,
            )
            threading.Thread(target=self._recording, daemon=True).start()
            self.logger.debug("Recording started.")
        except Exception as e:
            self.logger.exception("Failed to start recording: %s", e)
            raise

    def _recording(self):
        try:
            while self._running.is_set():
                data = self.stream.read(self.CHUNK, exception_on_overflow=False)
                self._frames.append(data)
        except Exception as e:
            self.logger.exception("Error during recording: %s", e)
        finally:
            if self.stream is not None:
                self.stream.stop_stream()
                self.stream.close()
                self.stream = None
                # self.logger.debug("Stream closed.")

    def stop(self):
        self._running.clear()
        self.logger.debug("Recording stopped.")

    def get_wav_bytes(self):
        """
        Assemble the recorded frames into a WAV format in-memory bytes buffer.
        """
        try:
            with io.BytesIO() as wf:
                with wave.open(wf, 'wb') as wave_file:
                    wave_file.setnchannels(self.CHANNELS)
                    wave_file.setsampwidth(self.p.get_sample_size(self.FORMAT))
                    wave_file.setframerate(self.RATE)
                    wave_file.writeframes(b''.join(self._frames))
                wf.seek(0)
                return wf.read()
        except Exception as e:
            self.logger.exception("Failed to assemble WAV bytes: %s", e)
            raise
        
    def close(self):
        # Call this when the application is exiting
        unhook_all()
        try:
            if self.stream is not None:
                self.stream.stop_stream()
                self.stream.close()
                self.stream = None
            if self.p is not None:
                self.p.terminate()
                self.p = None
            # self.logger.debug("Recorder closed.")
        except Exception as e:
            self.logger.exception("Error closing Recorder: %s", e)

    @staticmethod
    def delete(filename):
        try:
            os.remove(filename)
        except OSError as e:
            logger.warning("Error deleting file %s: %s", filename, e)


class AudioToText:
    def __init__(
        self,
        model_cls,
        vad_cls,
        rec_key: str = 'right ctrl',
        channels: int = 1,
        rate: int = 16000,
        start_sound_file: str = "../media/splash.mp3",
        error_callback = None
    ):
        self.rec_key = rec_key
        self.channels = channels
        self.rate = rate
        self.rec = Recorder(channels=channels, rate=rate)
        self.recording = False
        self.keyboard = Controller()
        self.logger = setup_logger()
        self.sound_play_lock = threading.Lock()
        self.last_playback_time = 0
        self.min_duration = 0.5  # Minimum recording duration in seconds
        self.scriptdir = os.path.dirname(os.path.abspath(__file__))
        self.model = model_cls
        self.vad = vad_cls
        self.transcription_thread = None
        self.stop_event = threading.Event()
        self.rec_hooked = False
        self.error_callback = error_callback
        # self.logger.debug("AudioToText initialized.")

        # Initialize Pygame mixer and load sound
        pygame.mixer.init()
        self.start_sound = None
        self.start_sound_file = os.path.join(self.scriptdir, start_sound_file)
        if os.path.exists(self.start_sound_file):
            try:
                self.start_sound = pygame.mixer.Sound(self.start_sound_file)
                # self.logger.debug("Start sound loaded: %s", self.start_sound_file)
            except Exception as e:
                self.logger.exception("Failed to load start sound: %s", e)
                if self.error_callback:
                    self.error_callback.emit("Failed to load start sound", None, None, None, None)# txt=None, filename=None, percentage=None, hold=False, reset=None
        else:
            self.logger.warning("Sound file %s not found.", self.start_sound_file)
            self.error_callback.emit("Sound file not found.", None, None, None, None)# txt=None, filename=None, percentage=None, hold=False, reset=None
        # Streaming attributes
        self.stream_buffer = deque()
        self.stream_lock = threading.Lock()
        self.is_streaming = False
        self.processing_buffer = deque()  # Buffer for sliding window
        self.sliding_window_size = 16000  # 1 second window
        self.overlap_size = 8000  # 0.5 second overlap
        self.previous_transcript = ""
        
    def play_sound(self):
        try:
            with self.sound_play_lock:
                if self.start_sound is not None:
                    self.start_sound.play()
        except Exception as e:
            if self.error_callback:
                self.error_callback.emit("Error playing sound. Check logs for details", None, None, None, None)# txt=None, filename=None, percentage=None, hold=False, reset=None
            self.logger.exception("Error playing sound: %s", e)

    def play_sound_thread(self):
        threading.Thread(target=self.play_sound, daemon=True).start()

    def capture_keys(self):
        unhook_all()
        hook_key(self.rec_key, self.transcribe_recording)
        
    def set_record_key(self, new_key):
        if self.rec_key != new_key:
            unhook_all()
            self.rec_key = new_key
            hook_key(self.rec_key, self.transcribe_recording)
    
    def paste_transcription(self, transcript_text):
        transcript_text = transcript_text.replace("New paragraph.", "\n\n")
        pyperclip.copy(transcript_text)
        self.keyboard.press(Key.ctrl)
        self.keyboard.press('v')
        self.keyboard.release('v')
        self.keyboard.release(Key.ctrl)

    def transcribe_and_paste(self, wav_bytes):
        try:
            # Check if there's sufficient data (approximate size check)
            if len(wav_bytes) > 1024:
                # Save wav_bytes to a BytesIO object for VAD and transcription
                with io.BytesIO(wav_bytes) as wav_buffer:
                    if not self.vad.has_speech(wav_buffer):
                        self.logger.warning("No speech detected in the recording.")
                        self.error_callback.emit("No speech detected in the recording.", None, None, None, None)# txt=None, filename=None, percentage=None, hold=False, reset=None
                        return
                    # Reset buffer position after VAD
                    wav_buffer.seek(0)
                    # self.logger.debug("Starting transcription.")
                    outputs = self.model.transcribe(wav_buffer)
                    # self.logger.debug("Transcription completed.")
                    self.paste_transcription(outputs)
                    self.error_callback.emit(f"{outputs}", None, None, None, None)# txt=None, filename=None, percentage=None, hold=False, reset=None
            else:
                if self.error_callback:
                    self.error_callback.emit("Audio data is too small. Check your recording device.", None, None, None, None) # txt=None, filename=None, percentage=None, hold=False, reset=None
                self.logger.warning("Audio data is too small. Check your recording device.")
        except Exception as e:
            self.logger.exception("Error during transcription: %s", e)
            if self.error_callback:
                self.error_callback.emit("Transcription Error. Check logs.", None, None, None, None) # txt=None, filename=None, percentage=None, hold=False, reset=None
                
    def _streaming_callback(self, in_data, frame_count, time_info, status):
        """Callback for streaming audio data."""
        if self.recording:
            audio_data = np.frombuffer(in_data, dtype=np.int16)
            with self.stream_lock:
                self.stream_buffer.append(audio_data)
            return (in_data, pyaudio.paContinue)
        return (None, pyaudio.paComplete)

    def start_streaming(self):
        """Start streaming for live audio capture."""
        self.stream = self.rec.p.open(
            format=self.rec.FORMAT,
            channels=self.rec.CHANNELS,
            rate=self.rec.RATE,
            input=True,
            stream_callback=self._streaming_callback,
            frames_per_buffer=self.rec.CHUNK
        )
        self.stream.start_stream()
        self.is_streaming = True
        self.logger.debug("Streaming started.")

    def stop_streaming(self):
        """Stop streaming audio capture."""
        if hasattr(self, 'stream') and self.stream:
            self.stream.stop_stream()
            self.stream.close()
            self.stream = None
        self.is_streaming = False
        with self.stream_lock:
            self.stream_buffer.clear()
            self.processing_buffer.clear()
        self.logger.debug("Streaming stopped.")

    def transcribe_recording_live(self, e):
        """Handle live transcription with key events."""
        if e.event_type == KEY_DOWN and e.name == self.rec_key and not self.recording:
            start_time = time.time()
            self.recording = True
            self.last_playback_time = start_time
            self.logger.debug("Recording key pressed.")
            if self.error_callback:
                self.error_callback(error="Recording...")
            if self.start_sound is not None:
                self.play_sound_thread()
            self.model.start_processing()  # Start the transcription processing thread
            self.start_streaming()
            
            # Start the real-time update thread
            self.transcription_thread = threading.Thread(
                target=self._update_transcription_live,
                daemon=True
            )
            self.transcription_thread.start()
            
        elif e.event_type == KEY_UP and e.name == self.rec_key and self.recording:
            # Stop recording
            self.recording = False
            self.model.stop_processing()
            self.stop_streaming()
            if self.error_callback:
                self.error_callback(error=" ")
            
        elif e.event_type == KEY_UP and e.name == self.rec_key and self.recording:
            # Stop recording
            self.recording = False
            self.model.stop_processing()
            self.stop_streaming()
            if self.error_callback:
                self.error_callback(error=" ")

    def _update_transcription_live(self):
        """Update transcription in real-time using sliding window approach."""
        last_transcript = ""
        while self.recording:
            with self.stream_lock:
                while self.stream_buffer:
                    # Retrieve the oldest chunk in the buffer
                    audio_chunk = self.stream_buffer.popleft()
                    
                    # Append to the processing buffer
                    self.processing_buffer.extend(audio_chunk)
                    
                    # Check if we have enough data for a sliding window
                    if len(self.processing_buffer) >= self.sliding_window_size:
                        # Extract the window for processing
                        window = np.array([self.processing_buffer[i] for i in range(self.sliding_window_size)], dtype=np.int16)
                        
                        # Convert to float32 and normalize
                        window = window.astype(np.float32) / 32768.0
                        
                        # Process the audio chunk with the model
                        self.model.process_audio_chunk(window)
                        
                        # Remove the overlap from the processing buffer
                        for _ in range(self.overlap_size):
                            if self.processing_buffer:
                                self.processing_buffer.popleft()
            
            # Get the latest transcript
            current_transcript = self.model.get_current_transcript()
            
            # Compare with the previous transcript
            if current_transcript != last_transcript:
                # Compute the difference
                diff = difflib.ndiff(self.previous_transcript.split(), current_transcript.split())
                delta = ' '.join([x[2:] for x in diff if x.startswith('+ ')])
                deletions = [x[2:] for x in diff if x.startswith('- ')]
                
                # Handle text updates
                if deletions:
                    for word in deletions:
                        self.delete_last_word(word)
                
                if delta:
                    self.append_text(delta)
                
                # Update the previous transcript
                self.previous_transcript = current_transcript
                last_transcript = current_transcript
            
            time.sleep(0.05)

    def delete_last_word(self, word):
        """Delete the last occurrence of the specified word."""
        try:
            # Simulate holding Ctrl+Backspace to delete the last word
            self.keyboard.press(Key.ctrl)
            self.keyboard.press(Key.backspace)
            self.keyboard.release(Key.backspace)
            self.keyboard.release(Key.ctrl)
            time.sleep(0.05)  # Brief pause to ensure the deletion is registered
        except Exception as e:
            if self.error_callback:
                self.error_callback(error=f"Failed to delete word: {str(e)}")
            self.logger.exception("Failed to delete word: %s", e)

    def append_text(self, text):
        """Append the specified text to the current cursor position."""
        try:
            # Store current clipboard content
            original_clipboard = pyperclip.paste()
            
            # Update with new transcription
            pyperclip.copy(text)
            
            # Simulate Ctrl+V to paste the new text
            pyautogui.hotkey('ctrl', 'v')
            
            # Restore original clipboard
            pyperclip.copy(original_clipboard)
        except Exception as e:
            if self.error_callback:
                self.error_callback(error=f"Failed to append text: {str(e)}")
            self.logger.exception("Failed to append text: %s", e)

    def update_text_field(self, text):
        """Update the text field with new transcription."""
        try:
            # Store current clipboard content
            original_clipboard = pyperclip.paste()
            
            # Update with new transcription
            pyperclip.copy(text)
            
            # Simulate Ctrl+A and Ctrl+V
            pyautogui.hotkey('ctrl', 'a')
            pyautogui.hotkey('ctrl', 'v')
            
            # Restore original clipboard
            pyperclip.copy(original_clipboard)
        except Exception as e:
            if self.error_callback:
                self.error_callback(error=f"Failed to update text: {str(e)}")

    def transcribe_recording(self, e):
        if e.event_type == KEY_DOWN and e.name == self.rec_key and not self.recording:
            start_time = time.time()
            self.recording = True
            self.last_playback_time = start_time
            self.logger.debug("Recording key pressed.")
            if self.error_callback:
                self.error_callback.emit("Recording...", None, None, None, None) # txt=None, filename=None, percentage=None, hold=False, reset=None
            try:
                self.rec.start()
                self.logger.debug("Recorder started in %.4f seconds.", time.time() - start_time)
            except Exception as e:
                self.logger.exception("Cannot start recording: %s", e)
                if self.error_callback:
                    self.error_callback.emit("Cannot start recording, check logs", None, None, None, None) # txt=None, filename=None, percentage=None, hold=False, reset=None
                    raise
            if self.start_sound is not None:
                self.play_sound_thread()
                # self.logger.debug("Sound played in %.4f seconds.", time.time() - sound_start_time)
        elif e.event_type == KEY_UP and e.name == self.rec_key and self.recording:
            self.recording = False
            self.rec.stop()
            recording_duration = time.time() - self.last_playback_time
            self.logger.debug("Recording stopped. Duration: %.2f seconds", recording_duration)
            if self.error_callback:
                self.error_callback.emit(None, None, None, None, True)
            if recording_duration >= self.min_duration:
                try:
                    wav_bytes = self.rec.get_wav_bytes()
                    # Start transcription in a separate thread
                    self.transcription_thread = threading.Thread(
                        target=self.transcribe_and_paste, args=(wav_bytes,), daemon=True
                    )
                    self.transcription_thread.start()
                except Exception as e:
                    self.logger.exception("Failed to get WAV bytes: %s", e)
                    if self.error_callback:
                        self.error_callback.emit("Failed to get WAV bytes, check logs", None, None, None, None) # txt=None, filename=None, percentage=None, hold=False, reset=None
            else:
                self.logger.warning(
                    "Recording too short (%.2f seconds). Minimum duration is %.2f seconds.",
                    recording_duration,
                    self.min_duration,
                )
                if self.error_callback:
                    self.error_callback.emit(f"Recording too short. Please record at least {self.min_duration}s.", None, None, None, None) # txt=None, filename=None, percentage=None, hold=False, reset=None
            
    def shutdown(self):
        """Gracefully shut down the application."""
        self.logger.debug("Shutting down AudioToText application...")
        try:
            if self.recording:
                self.stop_streaming()
                self.recording = False

            self.rec.close()

            if self.transcription_thread and self.transcription_thread.is_alive():
                self.logger.debug("Waiting for transcription thread to finish...")
                self.transcription_thread.join(timeout=1.0)

            if pygame.mixer.get_init():
                pygame.mixer.quit()

            unhook_all()
            self.logger.debug("Shutdown completed.")
        except Exception as e:
            self.logger.exception("Error during shutdown: %s", e)

    def run(self, solo=False):
        try:
            self.capture_keys()
            self.logger.debug("Key capture started.")
            wait()
        except KeyboardInterrupt:
            self.logger.debug("Program terminated by user.")
        finally:
            self.shutdown()  # Call the shutdown method to clean up
            if solo:
                os._exit(0)  # Force terminate to ensure all threads exit


if __name__ == "__main__":
    # Initialize the transcription model and VAD detector
    transcriber = WhisperONNXTranscriber(q="full")
    vad_detector = VaDetector()

    # Create the AudioToText instance
    att = AudioToText(transcriber, vad_detector)

    # Run the application
    att.run(solo=True)