import os
import threading
import time
import io
import pyperclip
import pyaudio
import wave
import gc
# import pyautogui
from logger.logger import setup_logger
from .transcribe import WhisperONNXTranscriber, VaDetector
import keyboard
from keyboard import wait, hook, unhook_all
from pynput.keyboard import Key, Controller
import pygame
from collections import deque  # Import deque for efficient sliding window
# import difflib

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
            # self.logger.debug("Recording started.")
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
        # self.logger.debug("Recording stopped.")

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
        
    def close(self, reset=False):
        """
        Close the Recorder and release resources. Reset if needed to allow for reinitialization.
        
        Args:
            reset (bool): If True, reset the audio stream and PyAudio instance for reuse.
        """
        try:
            if self.stream is not None:
                self.stream.stop_stream()
                self.stream.close()
                if not reset:
                    self.stream = None
            if self.p is not None:
                self.p.terminate()
                if not reset:
                    self.p = None

            if reset:
                # Reinitialize PyAudio for reuse
                self.p = pyaudio.PyAudio()
                self.stream = None  # Ensure the stream is reset
                self.logger.debug("Recorder reset for reinitialization.")

        except Exception as e:
            self.logger.exception("Error closing Recorder: %s", e)
                
class AudioToText:
    def __init__(
        self,
        model_cls,
        vad_cls,
        rec_key: str = 'Ctrl+Alt+A',
        channels: int = 1,
        rate: int = 16000,
        start_sound_file: str = "../media/splash.mp3",
        error_callback = None
    ):
        self.scriptdir = os.path.dirname(os.path.abspath(__file__))
        self.model = model_cls
        self.vad = vad_cls
        self.rec_key = rec_key.lower()
        self.channels = channels
        self.rate = rate
        self.rec = Recorder(channels=channels, rate=rate)
        self.is_recording = False
        self.start_sound = None
        self.start_sound_file = start_sound_file  # Store the path directly without joining
        self.sound_play_lock = threading.Lock()
        self.last_playback_time = 0
        self.min_duration = 0.5  # Minimum recording duration in seconds
        
        self.keys_down = set()
        self.keyboard = Controller()
        

        self.transcription_thread = None
        self.stop_event = threading.Event()
        self.error_callback = error_callback
        # self.logger.debug("AudioToText initialized.")

        # Streaming attributes
        self.stream_buffer = deque()
        self.stream_lock = threading.Lock()
        self.is_streaming = False
        self.processing_buffer = deque()  # Buffer for sliding window
        self.sliding_window_size = 16000  # 1 second window
        self.overlap_size = 8000  # 0.5 second overlap
        self.previous_transcript = ""
        
        self.logger = setup_logger()
        pygame.mixer.init()  # Initialize Pygame mixer here
        
    def init_pygame(self):
        # Load the sound file
        try:
            if self.start_sound_file and os.path.exists(self.start_sound_file):
                self.start_sound = pygame.mixer.Sound(self.start_sound_file)
                self.logger.debug("Start sound loaded: %s", self.start_sound_file)
            else:
                self.start_sound = None
                if self.start_sound_file:  # Only log if a file was specified
                    self.logger.warning("Sound file %s not found.", self.start_sound_file)
                    if self.error_callback:
                        self.error_callback.emit("Sound file not found: " + str(self.start_sound_file), None, None, None, None)
        except Exception as e:
            self.start_sound = None
            self.logger.exception("Failed to load start sound: %s", e)
            if self.error_callback:
                self.error_callback.emit("Failed to load start sound: " + str(e), None, None, None, None)

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

    def capture_keys(self, new_key:str=None):
        """Handle key events and track the combo."""
        # Check if any hotkeys are currently registered
        if new_key and self.rec_key.lower() != new_key.lower():
            unhook_all()
            self.rec_key = new_key.lower()
        hook(self._key_event_handler)

    def _key_event_handler(self, event):
        if event.event_type == "down":
            self.keys_down.add(event.name)  # Add pressed key to the set
            if set(self.rec_key.split("+")).issubset(self.keys_down) and not self.is_recording:
                self.is_recording = True
                self.start_recording()
        elif event.event_type == "up":
            self.keys_down.discard(event.name)  # Remove released key from the set
            if self.is_recording and not set(self.rec_key.split("+")).issubset(self.keys_down):
                self.is_recording = False
                self.stop_recording()

    def paste_transcription(self, transcript_text):
        transcript_text = transcript_text.replace("New paragraph.", "\n\n")
        
        # Leerzeichen von Anfang an Ende verschieben
        if transcript_text.startswith(' '):
            # Entferne alle führenden Leerzeichen
            cleaned_text = transcript_text.lstrip(' ')
            # Füge genau ein Leerzeichen am Ende hinzu (falls noch nicht vorhanden)
            if cleaned_text and not cleaned_text.endswith(' '):
                transcript_text = cleaned_text + ' '
            else:
                transcript_text = cleaned_text
        
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
                        if self.error_callback:
                            self.error_callback.emit("No speech detected in the recording.", None, None, None, None)# txt=None, filename=None, percentage=None, hold=False, reset=None
                        return
                    # Reset buffer position after VAD
                    wav_buffer.seek(0)
                    # self.logger.debug("Starting transcription.")
                    outputs = self.model.transcribe(wav_buffer)
                    # self.logger.debug("Transcription completed.")
                    self.paste_transcription(outputs)
                    if self.error_callback:
                        self.error_callback.emit(f"{outputs}", None, None, None, None)# txt=None, filename=None, percentage=None, hold=False, reset=None
            else:
                if self.error_callback:
                    self.error_callback.emit("Audio data is too small. Check your recording device.", None, None, None, None) # txt=None, filename=None, percentage=None, hold=False, reset=None
                self.logger.warning("Audio data is too small. Check your recording device.")
        except Exception as e:
            self.logger.exception("Error during transcription: %s", e)
            if self.error_callback:
                self.error_callback.emit("Transcription Error. Check logs.", None, None, None, None) # txt=None, filename=None, percentage=None, hold=False, reset=None

    def start_recording(self):
        start_time = time.time()
        self.last_playback_time = start_time
        # self.logger.debug("Recording key pressed.")
        if self.error_callback:
            self.error_callback.emit("Recording...", None, None, None, None) # txt=None, filename=None, percentage=None, hold=False, reset=None
        try:
            self.rec.start()
            # self.logger.debug("Recorder started in %.4f seconds.", time.time() - start_time)
        except Exception as e:
            self.logger.exception("Cannot start recording: %s", e)
            self.rec.stop()
            self.rec.close(reset=True)
            if self.error_callback:
                self.error_callback.emit("Cannot start recording, check logs", None, None, None, None) # txt=None, filename=None, percentage=None, hold=False, reset=None
                raise
        if self.start_sound is not None:
            self.play_sound_thread()
                
    def stop_recording(self):
            self.rec.stop()
            recording_duration = time.time() - self.last_playback_time
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
                
    # Live transcription code
    # def _streaming_callback(self, in_data, frame_count, time_info, status):
    #     """Callback for streaming audio data."""
    #     if self.is_recording:
    #         audio_data = np.frombuffer(in_data, dtype=np.int16)
    #         with self.stream_lock:
    #             self.stream_buffer.append(audio_data)
    #         return (in_data, pyaudio.paContinue)
    #     return (None, pyaudio.paComplete)

    # def start_streaming(self):
    #     """Start streaming for live audio capture."""
    #     self.stream = self.rec.p.open(
    #         format=self.rec.FORMAT,
    #         channels=self.rec.CHANNELS,
    #         rate=self.rec.RATE,
    #         input=True,
    #         stream_callback=self._streaming_callback,
    #         frames_per_buffer=self.rec.CHUNK
    #     )
    #     self.stream.start_stream()
    #     self.is_streaming = True
    #     self.logger.debug("Streaming started.")

    # def stop_streaming(self):
    #     """Stop streaming audio capture."""
    #     if hasattr(self, 'stream') and self.stream:
    #         self.stream.stop_stream()
    #         self.stream.close()
    #         self.stream = None
    #     self.is_streaming = False
    #     with self.stream_lock:
    #         self.stream_buffer.clear()
    #         self.processing_buffer.clear()
    #     self.logger.debug("Streaming stopped.")
        
#     def transcribe_recording_live(self, e):
    #     """Handle live transcription with key events."""
    #     if e.event_type == KEY_DOWN and e.name == self.rec_key and not self.is_recording:
    #         start_time = time.time()
    #         self.is_recording = True
    #         self.last_playback_time = start_time
    #         self.logger.debug("Recording key pressed.")
    #         if self.error_callback:
    #             self.error_callback(error="Recording...")
    #         if self.start_sound is not None:
    #             self.play_sound_thread()
    #         self.model.start_processing()  # Start the transcription processing thread
    #         self.start_streaming()
            
    #         # Start the real-time update thread
    #         self.transcription_thread = threading.Thread(
    #             target=self._update_transcription_live,
    #             daemon=True
    #         )
    #         self.transcription_thread.start()
            
    #     elif e.event_type == KEY_UP and e.name == self.rec_key and self.is_recording:
    #         # Stop recording
    #         self.is_recording = False
    #         self.model.stop_processing()
    #         self.stop_streaming()
    #         if self.error_callback:
    #             self.error_callback(error=" ")
            
    #     elif e.event_type == KEY_UP and e.name == self.rec_key and self.is_recording:
    #         # Stop recording
    #         self.is_recording = False
    #         self.model.stop_processing()
    #         self.stop_streaming()
    #         if self.error_callback:
    #             self.error_callback(error=" ")

    # def _update_transcription_live(self):
    #     """Update transcription in real-time using sliding window approach."""
    #     last_transcript = ""
    #     while self.is_recording:
    #         with self.stream_lock:
    #             while self.stream_buffer:
    #                 # Retrieve the oldest chunk in the buffer
    #                 audio_chunk = self.stream_buffer.popleft()
                    
    #                 # Append to the processing buffer
    #                 self.processing_buffer.extend(audio_chunk)
                    
    #                 # Check if we have enough data for a sliding window
    #                 if len(self.processing_buffer) >= self.sliding_window_size:
    #                     # Extract the window for processing
    #                     window = np.array([self.processing_buffer[i] for i in range(self.sliding_window_size)], dtype=np.int16)
                        
    #                     # Convert to float32 and normalize
    #                     window = window.astype(np.float32) / 32768.0
                        
    #                     # Process the audio chunk with the model
    #                     self.model.process_audio_chunk(window)
                        
    #                     # Remove the overlap from the processing buffer
    #                     for _ in range(self.overlap_size):
    #                         if self.processing_buffer:
    #                             self.processing_buffer.popleft()
            
    #         # Get the latest transcript
    #         current_transcript = self.model.get_current_transcript()
            
    #         # Compare with the previous transcript
    #         if current_transcript != last_transcript:
    #             # Compute the difference
    #             diff = difflib.ndiff(self.previous_transcript.split(), current_transcript.split())
    #             delta = ' '.join([x[2:] for x in diff if x.startswith('+ ')])
    #             deletions = [x[2:] for x in diff if x.startswith('- ')]
                
    #             # Handle text updates
    #             if deletions:
    #                 for word in deletions:
    #                     self.delete_last_word(word)
                
    #             if delta:
    #                 self.append_text(delta)
                
    #             # Update the previous transcript
    #             self.previous_transcript = current_transcript
    #             last_transcript = current_transcript
            
    #         time.sleep(0.05)

    # def delete_last_word(self, word):
    #     """Delete the last occurrence of the specified word."""
    #     try:
    #         # Simulate holding Ctrl+Backspace to delete the last word
    #         self.keyboard.press(Key.ctrl)
    #         self.keyboard.press(Key.backspace)
    #         self.keyboard.release(Key.backspace)
    #         self.keyboard.release(Key.ctrl)
    #         time.sleep(0.05)  # Brief pause to ensure the deletion is registered
    #     except Exception as e:
    #         if self.error_callback:
    #             self.error_callback(error=f"Failed to delete word: {str(e)}")
    #         self.logger.exception("Failed to delete word: %s", e)

    # def append_text(self, text):
    #     """Append the specified text to the current cursor position."""
    #     try:
    #         # Store current clipboard content
    #         original_clipboard = pyperclip.paste()
            
    #         # Update with new transcription
    #         pyperclip.copy(text)
            
    #         # Simulate Ctrl+V to paste the new text
    #         pyautogui.hotkey('ctrl', 'v')
            
    #         # Restore original clipboard
    #         pyperclip.copy(original_clipboard)
    #     except Exception as e:
    #         if self.error_callback:
    #             self.error_callback(error=f"Failed to append text: {str(e)}")
    #         self.logger.exception("Failed to append text: %s", e)

    # def update_text_field(self, text):
    #     """Update the text field with new transcription."""
    #     try:
    #         # Store current clipboard content
    #         original_clipboard = pyperclip.paste()
            
    #         # Update with new transcription
    #         pyperclip.copy(text)
            
    #         # Simulate Ctrl+A and Ctrl+V
    #         pyautogui.hotkey('ctrl', 'a')
    #         pyautogui.hotkey('ctrl', 'v')
            
    #         # Restore original clipboard
    #         pyperclip.copy(original_clipboard)
    #     except Exception as e:
    #         if self.error_callback:
    #             self.error_callback(error=f"Failed to update text: {str(e)}")
            
    def shutdown(self):
        """Gracefully shut down the application."""
        try:
            if self.is_recording:
                self.stop_streaming()
                self.is_recording = False

            self.rec.close()

            if self.transcription_thread and self.transcription_thread.is_alive():
                self.logger.debug("Waiting for transcription thread to finish...")
                self.transcription_thread.join(timeout=1.0)

            if pygame.mixer.get_init():
                pygame.mixer.quit()
            unhook_all()
        except Exception as e:
            self.logger.exception("Error during shutdown: %s", e)

if __name__ == "__main__":
    # Initialize the transcription model and VAD detector
    transcriber = WhisperONNXTranscriber(q="full")
    vad_detector = VaDetector()

    # Create the AudioToText instance
    att = AudioToText(transcriber, vad_detector)
    # Run the application
    att.capture_keys()
    wait()