import os
import threading
import time
import io
import pyperclip
import pyaudio
import wave
from logger import setup_logger
from utils import WhisperONNXTranscriber, VaDetector
from keyboard import KEY_DOWN, KEY_UP, hook_key, wait, unhook_all
from pynput.keyboard import Key, Controller
import pygame

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
        self.stream_status = ""
        self.transcription_thread = None
        self.stop_event = threading.Event()
        self.rec_hooked = False
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
        else:
            self.logger.warning("Sound file %s not found.", self.start_sound_file)
            
    # def reinitialize(self):
    #     """
    #     Reinitialize the AudioToText instance after a shutdown.
    #     This allows the instance to be used again after a shutdown.
    #     """
    #     self.logger.debug("Reinitializing AudioToText application...")
    #     try:
    #         # Reinitialize Recorder
    #         self.rec = Recorder(channels=self.channels, rate=self.rate)
    #         self.recording = False
    #         self.stream_status = ""
    #         self.transcription_thread = None
    #         self.stop_event = threading.Event()
    #         self.logger.debug("Recorder reinitialized.")

    #         # Reinitialize Pygame mixer and load sound
    #         if not pygame.mixer.get_init():
    #             pygame.mixer.init()
                                
    #         self.start_sound = None
    #         if os.path.exists(self.start_sound_file):
    #             try:
    #                 self.start_sound = pygame.mixer.Sound(self.start_sound_file)
    #                 self.logger.debug("Start sound reloaded: %s", self.start_sound_file)
    #             except Exception as e:
    #                 self.logger.exception("Failed to reload start sound: %s", e)
    #         else:
    #             self.logger.warning("Sound file %s not found during reinitialization.", self.start_sound_file)

    #         # Reinitialize keyboard hooks
    #         self.capture_keys()
    #         self.logger.debug("Keyboard hooks re-established.")

    #         self.logger.debug("Reinitialization completed successfully.")
    #     except Exception as e:
    #         self.logger.exception("Error during reinitialization: %s", e)
    
    def play_sound(self):
        try:
            with self.sound_play_lock:
                if self.start_sound is not None:
                    self.start_sound.play()
        except Exception as e:
            self.logger.exception("Error playing sound: %s", e)

    def play_sound_thread(self):
        threading.Thread(target=self.play_sound, daemon=True).start()

    def capture_keys(self):
        unhook_all()
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
                        self.stream_status = "No speech detected in the recording."
                        return
                    # Reset buffer position after VAD
                    wav_buffer.seek(0)
                    # self.logger.debug("Starting transcription.")
                    outputs = self.model.transcribe(wav_buffer)
                    # self.logger.debug("Transcription completed.")
                    self.paste_transcription(outputs)
            else:
                self.stream_status = "Audio data is too small. Check your recording device."
                self.logger.warning(self.stream_status)
        except Exception as e:
            self.logger.exception("Error during transcription: %s", e)
            self.stream_status = f"Transcription error: {e}"
        # No need to delete the file since we're using in-memory data
    
    def transcribe_recording(self, e):
        if e.event_type == KEY_DOWN and e.name == self.rec_key and not self.recording:
            start_time = time.time()
            self.recording = True
            self.last_playback_time = start_time
            self.logger.debug("Recording key pressed.")
            try:
                self.rec.start()
                self.logger.debug("Recorder started in %.4f seconds.", time.time() - start_time)
            except Exception as e:
                self.logger.exception("Cannot start recording: %s", e)
                self.stream_status = str(e)
            if self.start_sound is not None:
                sound_start_time = time.time()
                self.play_sound_thread()
                # self.logger.debug("Sound played in %.4f seconds.", time.time() - sound_start_time)
        elif e.event_type == KEY_UP and e.name == self.rec_key and self.recording:
            self.recording = False
            self.rec.stop()
            recording_duration = time.time() - self.last_playback_time
            self.logger.debug("Recording stopped. Duration: %.2f seconds", recording_duration)
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
                    self.stream_status = f"Recording error: {e}"
            else:
                self.logger.warning(
                    "Recording too short (%.2f seconds). Minimum duration is %.2f seconds.",
                    recording_duration,
                    self.min_duration,
                )
                self.stream_status = f"Recording too short. Please record at least {self.min_duration} seconds."

    def shutdown(self):
        """
        Gracefully shut down the application, stopping all threads and resources.
        """
        self.logger.debug("Shutting down AudioToText application...")
        try:
            # Stop recording if it's running
            if self.recording:
                self.rec.stop()
                self.recording = False

            # Close the recorder to release resources
            self.rec.close()

            # Wait for any ongoing transcription thread to finish
            if self.transcription_thread and self.transcription_thread.is_alive():
                self.logger.debug("Waiting for transcription thread to finish...")
                self.transcription_thread.join()

            # Stop Pygame mixer
            if pygame.mixer.get_init():
                pygame.mixer.quit()

            # Unhook all keys
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