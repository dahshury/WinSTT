import contextlib
import queue
import time

import numpy as np
import pyaudio
from PyQt6.QtCore import QMutex, QObject, QThread, pyqtSignal


class AudioProcessor(QThread):
    """Thread to process audio data and emit new waveform data."""
    data_ready = pyqtSignal(np.ndarray)
    
    def __init__(self, parent=None):
        super().__init__(parent)
        self.mutex = QMutex()
        self.stopped = False
        self.sample_rate = 16000  # 16kHz
        self.chunk_size = 1024
        self.buffer_size = 100  # Number of chunks to visualize
        self.buffer = np.zeros(self.chunk_size * self.buffer_size)
        self.audio = None
        self.stream = None
        self.audio_queue = queue.Queue(maxsize=10)
        
    def initialize_audio(self):
        """Initialize PyAudio and audio stream."""
        try:
            self.audio = pyaudio.PyAudio()
            
            # Open default input stream with float32 format
            self.stream = self.audio.open(
                format=pyaudio.paFloat32,
                channels=1,
                rate=self.sample_rate,
                input=True,
                frames_per_buffer=self.chunk_size,
                start=True,
            )
            
            return True
        except Exception:
            # Try a fallback approach with different format
            try:
                if self.audio:
                    # Clean up previous attempt
                    if self.stream:
                        self.stream.close()
                    self.audio.terminate()
                
                self.audio = pyaudio.PyAudio()
                self.stream = self.audio.open(
                    format=pyaudio.paInt16,
                    channels=1,
                    rate=self.sample_rate,
                    input=True,
                    frames_per_buffer=self.chunk_size,
                    start=True,
                )
                return True
            except Exception:
                return False
            
    def stop(self):
        """Signal the thread to stop - thread-safe."""
        self.mutex.lock()
        self.stopped = True
        self.mutex.unlock()
        
    def cleanup_resources(self):
        """Clean up audio resources - must be called from the thread that owns them."""
        # Clean up audio resources within the thread that owns them
        if hasattr(self, "stream") and self.stream:
            try:
                self.stream.stop_stream()
                self.stream.close()
                self.stream = None
            except Exception as e:
                print(f"Error closing audio stream: {e}")
                
        if hasattr(self, "audio") and self.audio:
            try:
                self.audio.terminate()
                self.audio = None
            except Exception as e:
                print(f"Error terminating audio: {e}")
            
    def run(self):
        """Main processing loop that captures audio and updates the buffer."""
        if not self.initialize_audio():
            return
            
        try:
            while True:
                self.mutex.lock()
                should_stop = self.stopped
                self.mutex.unlock()
                
                if should_stop:
                    break
                
                try:
                    # Read audio data
                    raw_data = self.stream.read(self.chunk_size, exception_on_overflow=False)
                    
                    # Convert to numpy array
                    data = np.frombuffer(raw_data, dtype=np.float32)
                    
                    # Normalize the data for consistent scaling of human speech
                    # Apply a fixed scale that works well for typical speech levels
                    # This ensures consistent visualization regardless of input volume
                    normalized_data = self.normalize_for_speech(data)
                    
                    # Roll the buffer and add new data
                    self.buffer = np.roll(self.buffer, -len(normalized_data))
                    self.buffer[-len(normalized_data):] = normalized_data
                    
                    # Emit the updated buffer for visualization
                    self.data_ready.emit(self.buffer.copy())
                    
                    # Slight delay to prevent CPU overuse
                    time.sleep(0.01)
                    
                except Exception as e:
                    print(f"Error in audio processing: {e}")
                    time.sleep(0.1)
        finally:
            # Clean up resources in the thread that created them
            self.cleanup_resources()
    
    def normalize_for_speech(self, data):
        """Normalize audio data specifically for speech visualization with consistent scaling."""
        # Calculate the RMS (root mean square) of the audio segment
        rms = np.sqrt(np.mean(np.square(data)))
        
        if rms > 0:
            # Apply a fixed scaling factor to normalize speech to a consistent range
            # but with a higher range to show more pronounced waveforms
            normalized = data / (rms * 2.5)  # Reduced dampening factor for larger waveforms
            
            # Apply consistent amplitude scaling for header visualization
            # Increase scale to make the visualization more prominent
            fixed_scale = 0.5  # Increased scale for better visibility
            normalized = normalized * fixed_scale
            
            # Apply clipping to prevent extreme values but allow for more range
            normalized = np.clip(normalized, -0.7, 0.7)  # Increased range
            
            # Center the visualization vertically in the header
            return normalized + 0.0  # Centered in header
            
        # Return zeros for silence
        return np.zeros_like(data)

class VoiceVisualizer(QObject):
    """Manages audio processing and provides waveform data for visualization."""
    
    def __init__(self, parent=None):
        super().__init__(parent)
        self.processor = None
        self.is_active = False
        
    def start_processing(self):
        """Start the audio processor and visualization."""
        if self.processor is None:
            self.processor = AudioProcessor()
            self.processor.data_ready.connect(self.handle_new_data)
            self.processor.start()
        self.is_active = True
        
    def stop_processing(self):
        """Stop the audio processor and visualization - thread-safe."""
        self.is_active = False
        if self.processor:
            try:
                # Signal the thread to stop
                self.processor.stop()
                
                # Don't wait for the thread in this method as it may be called from a different thread
                # Instead, schedule the cleanup for later in the main thread
                self.processor = None  # Allow garbage collection to clean up the thread when possible
            except Exception as e:
                print(f"Error stopping audio processor: {e}")
            
    def handle_new_data(self, data):
        """Handle new audio data from the processor."""
        if self.parent() and hasattr(self.parent(), "update_waveform"):
            with contextlib.suppress(Exception):
                self.parent().update_waveform(data)
            
    def is_processing(self):
        """Check if the visualizer is currently processing audio."""
        return self.is_active 