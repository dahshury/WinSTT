import gc
import json
import os
import queue
import sys
import threading
import time
from collections import deque

import librosa
import numpy as np
import onnxruntime as ort
import requests
from pydub import AudioSegment
from tqdm import tqdm

# Suppress transformers warning about PyTorch/TensorFlow/Flax
import logging
logging.getLogger("transformers").setLevel(logging.ERROR)

from transformers import WhisperFeatureExtractor, WhisperTokenizerFast

from logger import setup_logger

custom_logger = setup_logger()
# cache_path = os.path.join(os.path.dirname(os.path.dirname(script_path)), "cache") # For exe
# cache_path = os.path.join(os.path.dirname(script_path), "cache")

def resource_path(relative_path):
    """ Get absolute path to resource, works for dev and for PyInstaller """
    try:
        base_path = sys._MEIPASS
    except Exception:
        # Get project root, then go to src directory
        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        base_path = os.path.join(project_root, "src")

    return os.path.join(base_path, relative_path)

class WhisperONNXTranscriber:
    def __init__(self, cache_path=resource_path("cache"), q="full" if "CUDAExecutionProvider" in ort.get_available_providers() else "quantized", display_message_signal=None, model_type="whisper-turbo"):
        self.cache_path = cache_path
        self.q = q
        self.model_type = model_type
        
        # Determine model directory based on type
        if model_type == "lite-whisper-turbo":
            self.model_cache_path = os.path.join(self.cache_path, "models", "lite-whisper-turbo")
        elif model_type == "lite-whisper-turbo-fast":
            self.model_cache_path = os.path.join(self.cache_path, "models", "lite-whisper-turbo-fast")
        else:  # Default to standard whisper-turbo
            self.model_cache_path = os.path.join(self.cache_path, "models", "whisper-turbo")
        
        # ONNX files are in the onnx subdirectory
        self.onnx_folder = os.path.join(self.model_cache_path, "onnx")
        self.display_message_signal = display_message_signal
        
        # Ensure models are downloaded
        self.update_names()
        self.download_and_prepare_models()
        # Load ONNX models  
        self.initialize_sessions(q=self.q)
        # Load tokenizer and feature extractor from model cache path (where HF files are)
        self.tokenizer = WhisperTokenizerFast.from_pretrained(self.model_cache_path)
        self.feature_extractor = WhisperFeatureExtractor.from_pretrained(self.model_cache_path)
        
        # Streaming attributes
        self.audio_buffer = deque(maxlen=96000)  # 6 seconds buffer at 16kHz
        self.buffer_lock = threading.Lock()
        self.processing_thread = None
        self.is_processing = False
        self.current_transcript = ""
        self.transcript_queue = queue.Queue()
        # Load configuration files
        with open(os.path.join(self.model_cache_path, "config.json")) as f:
            self.config = json.load(f)
        with open(os.path.join(self.model_cache_path, "generation_config.json")) as f:
            self.generation_config = json.load(f)
        with open(os.path.join(self.model_cache_path, "preprocessor_config.json")) as f:
            self.preprocessor_config = json.load(f)
            
    def update_names(self):
        self.encoder_name = "encoder_model.onnx" if self.q.lower() == "full" else f"encoder_model_{self.q.lower()}.onnx"
        self.decoder_name = "decoder_model_merged.onnx" if self.q.lower() == "full" else f"decoder_model_merged_{self.q.lower()}.onnx"
        
    def initialize_sessions(self, q):
        """
        Initialize ONNX sessions for the encoder and decoder based on the model type (Full/Quantized).
        """
        # Log the operation
        self.q = q
        # Delete the current sessions
        if hasattr(self, "encoder_session"):
            del self.encoder_session
        if hasattr(self, "decoder_session"): 
            del self.decoder_session

        # Force garbage collection to release old sessions
        gc.collect()
        
        # Update model names based on the current quantization setting
        self.update_names()

        # Load new ONNX models
        available_providers = ort.get_available_providers()
        try:
            encoder_path = os.path.join(self.onnx_folder, self.encoder_name)
            self.encoder_session = ort.InferenceSession(
                os.path.join(encoder_path),
                providers=available_providers,
            )
        except Exception as e:
            os.remove(encoder_path)
            if self.q.lower()=="full":
                encoder_onnx_data_path = os.path.join(self.onnx_folder, self.encoder_name.replace("onnx", "onnx_data"))
                if os.path.exists(encoder_onnx_data_path):
                    os.remove(encoder_onnx_data_path)
            self.download_and_prepare_models()
            custom_logger.debug(e)
        try:
            decoder_path = os.path.join(self.onnx_folder, self.decoder_name)
            self.decoder_session = ort.InferenceSession(
                os.path.join(decoder_path),
                providers=available_providers,
            ) 
        except Exception as e:
            os.remove(decoder_path) 
            self.download_and_prepare_models()
            custom_logger.debug(e)
            
    def reinitialize_sessions(self, q):
        """
        Reinitialize ONNX sessions with a new quantization type (e.g., 'full' or 'quantized').
        
        Args:
            new_q (str): The new quantization type ('full' or 'quantized').
        """
        try:
            # Log the operation
            custom_logger.info(f"Reinitializing ONNX sessions with quantization: {q}")
            
            # Ensure the quantization type is valid
            if q.lower() not in ["full", "quantized"]:
                msg = "Invalid quantization type. Choose 'full' or 'quantized'."
                raise ValueError(msg)
            
            self.clear_sessions()
            
            # Update quantization and model names
            self.q = q
            self.update_names()

            # Reinitialize ONNX sessions
            self.initialize_sessions(q=self.q)

            custom_logger.info("ONNX sessions successfully reinitialized.")

        except Exception as e:
            custom_logger.exception(f"Error reinitializing ONNX sessions: {e}")
            raise
        
    def clear_sessions(self):
        # Delete current ONNX sessions
        if hasattr(self, "encoder_session"):
            del self.encoder_session
        if hasattr(self, "decoder_session"):
            del self.decoder_session
        # Force garbage collection to release old sessions
        gc.collect()
        
    def download_and_prepare_models(self):
        """Downloads the model files if they don't exist."""
        os.makedirs(self.onnx_folder, exist_ok=True)

        repo_url = "https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/main/onnx/"
        files = [
            self.encoder_name,
            "encoder_model.onnx_data" if self.q.lower() == "full" else None,
            self.decoder_name,
        ]

        config_files = [
            "config.json",                # General model configuration
            "generation_config.json",     # Configuration for text generation
            "preprocessor_config.json",   # Preprocessor-specific configuration
            "merges.txt",                 # Byte Pair Encoding (BPE) merge rules for the tokenizer
            "vocab.json",                 # Vocabulary used by the tokenizer
            "added_tokens.json",          # Custom added tokens (if any)
            "special_tokens_map.json",    # Mapping of special tokens (e.g., <pad>, <eos>)
            "tokenizer_config.json",      # Tokenizer-specific configuration
            "normalizer.json",             # Optional normalization configurations for text preprocessing
        ]

        # Download ONNX files
        for file_name in files:
            if file_name is not None:
                file_path = os.path.join(self.onnx_folder, file_name)
                if not os.path.exists(file_path) or os.path.getsize(file_path) <= 2048:
                    print(f"File '{file_name}' not found. Downloading...")
                    file_url = repo_url + file_name
                    self.download_file_with_progress(file_url, file_path, file_name)

        # Download configuration files
        for config_file in config_files:
            config_path = os.path.join(self.model_cache_path, config_file)
            config_url = f"https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/main/{config_file}"
            if not os.path.exists(config_path):
                print(f"Configuration file '{config_file}' not found. Downloading...")
                self.download_file_with_progress(config_url, config_path, config_file)
        if self.display_message_signal:
            self.display_message_signal.emit(None, None, None, None, True)

    def download_file_with_progress(self, url, save_path, name):
        """Download a file from a URL with a progress bar and handle errors."""
        try:
            # First check if the URL responds (without downloading the content)
            head_response = requests.head(url, timeout=10)
            head_response.raise_for_status()
            
            # Get the file from the server
            response = requests.get(url, stream=True, timeout=10)
            response.raise_for_status()
            
            # Log content type for debugging
            content_type = response.headers.get("content-type", "").lower()
            custom_logger.debug(f"Downloading {url} with content-type: {content_type}")
            
            # For small files, we'll check the first part to detect HTML error pages
            content_is_html = False
            
            # Only download to a temporary file first for validation
            temp_path = save_path + ".tmp"
            
            total_size = int(response.headers.get("content-length", 0))
            block_size = 1024  # 1 KiB
            
            with open(temp_path, "wb") as file, tqdm(
                desc=f"Downloading {os.path.basename(save_path)}",
                total=total_size,
                unit="B",
                unit_scale=True,
                unit_divisor=1024,
            ) as bar:
                first_chunk = True
                downloaded_size = 0
                
                for data in response.iter_content(block_size):
                    if not data:  # Skip empty chunks
                        continue
                        
                    # Check the first chunk for HTML content
                    if first_chunk:
                        try:
                            text_sample = data[:512].decode("utf-8", errors="ignore")
                            # Check for HTML markers
                            content_is_html = (
                                "<html" in text_sample or 
                                "<body" in text_sample or 
                                "<!DOCTYPE" in text_sample or
                                "<head" in text_sample
                            )
                            
                            # If dealing with JSON file but received HTML, abort
                            if content_is_html and save_path.endswith(".json"):
                                custom_logger.error(f"Received HTML content for a JSON file: {url}")
                                msg = f"Received HTML content instead of JSON: {url}"
                                raise Exception(msg)
                                
                            first_chunk = False
                        except UnicodeDecodeError:
                            # If we can't decode as text, it's probably binary data which is good
                            # (assuming we're downloading a binary file)
                            first_chunk = False
                    
                    # Write the data regardless of content type
                    file.write(data)
                    downloaded_size += len(data)
                    bar.update(len(data))
                    
                    # Update progress
                    percent = (downloaded_size / total_size) * 100 if total_size > 0 else 0
                    if self.display_message_signal:
                        self.display_message_signal.emit(None, name, percent, True, None)
            
            # File downloaded, now validate based on file type
            if os.path.exists(temp_path):
                file_valid = True
                
                # For JSON files, verify they contain valid JSON
                if save_path.endswith(".json"):
                    try:
                        with open(temp_path, encoding="utf-8") as f:
                            content = f.read()
                            # Basic check for HTML in JSON file
                            if "<html" in content or "<!DOCTYPE" in content:
                                custom_logger.error(f"Downloaded file contains HTML, not JSON: {save_path}")
                                file_valid = False
                            else:
                                # Verify it parses as JSON
                                import json
                                json.loads(content)
                    except json.JSONDecodeError as e:
                        custom_logger.exception(f"Downloaded file is not valid JSON: {save_path}, error: {e}")
                        file_valid = False
                    except Exception as e:
                        custom_logger.exception(f"Error validating JSON file: {save_path}, error: {e}")
                        file_valid = False
                
                # For ONNX files, do basic size check
                if save_path.endswith(".onnx"):
                    file_size = os.path.getsize(temp_path)
                    if file_size < 1000:  # ONNX files should be larger than this
                        with open(temp_path, encoding="utf-8", errors="ignore") as f:
                            content_peek = f.read(512)
                            if "<html" in content_peek or "<!DOCTYPE" in content_peek:
                                custom_logger.error(f"Downloaded file contains HTML, not an ONNX model: {save_path}")
                                file_valid = False
                
                # Move temp file to final location if valid
                if file_valid:
                    os.replace(temp_path, save_path)
                    custom_logger.debug(f"File validated and saved successfully: {save_path}")
                    return True
                # Remove invalid file
                os.remove(temp_path)
                msg = f"Downloaded file failed validation: {save_path}"
                raise Exception(msg)
            msg = f"Failed to download file: {save_path}"
            raise Exception(msg)

        except requests.ConnectionError:
            if self.display_message_signal:
                self.display_message_signal.emit("Failed to connect to the internet. Please check your connection.", None, None, None, None)
            custom_logger.exception("Failed to connect to the internet. Please check your connection.")
            if os.path.exists(save_path + ".tmp"):
                os.remove(save_path + ".tmp")
            raise
        except requests.HTTPError as http_err:
            if http_err.response.status_code == 404:
                custom_logger.exception(f"File not found (404): {url}")
                if self.display_message_signal:
                    self.display_message_signal.emit(f"File not found: {os.path.basename(url)}", None, None, None, None)
            else:
                if self.display_message_signal:
                    self.display_message_signal.emit(f"HTTP error occurred: {http_err}", None, None, None, None)
                custom_logger.exception(f"HTTP error occurred: {http_err}")
            if os.path.exists(save_path + ".tmp"):
                os.remove(save_path + ".tmp")
            raise
        except requests.Timeout:
            if self.display_message_signal:
                self.display_message_signal.emit("The request timed out. Please try again later.", None, None, None, None)
            custom_logger.exception("The request timed out. Please try again later.")
            if os.path.exists(save_path + ".tmp"):
                os.remove(save_path + ".tmp")
            raise
        except requests.RequestException as req_err:
            if self.display_message_signal:
                self.display_message_signal.emit(f"An error occurred during download: {req_err}", None, None, None, None)
            custom_logger.exception(f"An error occurred: {req_err}")
            if os.path.exists(save_path + ".tmp"):
                os.remove(save_path + ".tmp")
            raise
        except Exception as err:
            if self.display_message_signal:
                self.display_message_signal.emit(f"An unexpected error occurred: {err}", None, None, None, None)
            custom_logger.exception(f"An unexpected error occurred: {err}")
            # Clean up
            if os.path.exists(save_path + ".tmp"):
                os.remove(save_path + ".tmp")
            if os.path.exists(save_path):
                os.remove(save_path)
            raise

    def preprocess_audio(self, audio_path):
        # Load audio file using librosa
        audio, sr = librosa.load(audio_path, sr=None)  # sr=None to keep original sampling rate

        # Resample if necessary
        if sr != self.feature_extractor.sampling_rate:
            audio = librosa.resample(audio, orig_sr=sr, target_sr=self.feature_extractor.sampling_rate)
            sr = self.feature_extractor.sampling_rate

        # Process through feature extractor
        inputs = self.feature_extractor(
            audio,
            sampling_rate=sr,
            return_tensors="np",
        )

        return inputs.input_features


    def encode(self, input_features):
        # Run encoder
        encoder_outputs = self.encoder_session.run(
            None,
            {"input_features": input_features},
        )
        return encoder_outputs[0]

    def decode(self, encoder_hidden_states, attention_mask=None):
        # Initialize decoder inputs
        batch_size = encoder_hidden_states.shape[0]
        decoder_input_ids = np.array([[self.generation_config["decoder_start_token_id"]]] * batch_size, dtype=np.int64)

        # Initialize past key values with correct dimensions from config
        num_layers = self.config["decoder_layers"]
        num_attention_heads = self.config["decoder_attention_heads"]
        head_dim = self.config["d_model"] // num_attention_heads

        past_key_values = []
        for _ in range(num_layers):
            # Create 4D tensors for past key and value for both decoder and encoder
            past_decoder_key = np.zeros((batch_size, num_attention_heads, 0, head_dim), dtype=np.float32)
            past_decoder_value = np.zeros((batch_size, num_attention_heads, 0, head_dim), dtype=np.float32)
            past_encoder_key = np.zeros((batch_size, num_attention_heads, 0, head_dim), dtype=np.float32)
            past_encoder_value = np.zeros((batch_size, num_attention_heads, 0, head_dim), dtype=np.float32)
            
            past_key_values.append((past_decoder_key, past_decoder_value, past_encoder_key, past_encoder_value))

        output_ids = []
        max_length = self.generation_config.get("max_length", 448)

        for _ in range(max_length):
            # Prepare decoder inputs
            decoder_inputs = {
                "input_ids": decoder_input_ids,
                "use_cache_branch": np.array([False], dtype=bool),
            }

            # Add past key values to inputs
            for layer in range(num_layers):
                decoder_inputs.update({
                    f"past_key_values.{layer}.decoder.key": past_key_values[layer][0],
                    f"past_key_values.{layer}.decoder.value": past_key_values[layer][1],
                    f"past_key_values.{layer}.encoder.key": past_key_values[layer][2],
                    f"past_key_values.{layer}.encoder.value": past_key_values[layer][3],
                })

            # Add encoder hidden states and encoder attention mask
            decoder_inputs["encoder_hidden_states"] = encoder_hidden_states.astype(np.float32)
            if attention_mask is not None:
                decoder_inputs["encoder_attention_mask"] = attention_mask.astype(np.int64)

            try:
                # Run decoder
                decoder_outputs = self.decoder_session.run(None, decoder_inputs)
                
                # Extract next token logits 
                # Assuming the first output is the logits
                next_token_logits = decoder_outputs[0][:, -1, :]
                next_tokens = np.argmax(next_token_logits, axis=-1)

                # Extract updated past key values
                updated_past_key_values = []
                for layer in range(num_layers):
                    idx = 1 + layer * 4  # Adjust index based on output order
                    updated_past_key_values.append((
                        decoder_outputs[idx],     # decoder key
                        decoder_outputs[idx + 1], # decoder value
                        decoder_outputs[idx + 2], # encoder key
                        decoder_outputs[idx + 3],  # encoder value
                    ))
                past_key_values = updated_past_key_values

                # Append tokens
                output_ids.append(next_tokens)

                # Update decoder input ids
                decoder_input_ids = np.concatenate(
                    [decoder_input_ids, next_tokens[:, None]], axis=-1,
                )

                # Check for end of sequence
                if np.all(next_tokens == self.generation_config["eos_token_id"]):
                    break

            except Exception as e:
                custom_logger.exception(f"Error in decoder iteration: {e}")
                break

        return np.array(output_ids, dtype=np.int64).T  # Ensure int64

    def postprocess(self, output_ids):
        # Convert output_ids to list for the tokenizer
        output_ids_list = output_ids.tolist()

        # Decode the predicted tokens to text
        return self.tokenizer.batch_decode(
            output_ids_list, skip_special_tokens=True,
        )[0]

    def transcribe(self, audio_path):
        """Convenience method to handle complete transcription process"""
        try:
            # Preprocess audio
            input_features = self.preprocess_audio(audio_path)

            # Run encoder
            encoder_outputs = self.encode(input_features)

            # Run decoder
            output_ids = self.decode(encoder_outputs)

            # Get transcription
            transcription = self.postprocess(output_ids)
            
            # Store the audio path for possible segment extraction
            self.last_audio_path = audio_path
            
            # Store the transcription for possible segment extraction
            self.last_transcription = transcription
            
            return transcription
        except Exception as e:
            custom_logger.exception(f"Error in transcription pipeline: {e!s}")
            raise
    
    def get_segments(self):
        """
        Extract segments with timestamps from the last transcription.
        Returns a list of segments with start time, end time, and text.
        """
        if not hasattr(self, "last_audio_path") or not hasattr(self, "last_transcription"):
            custom_logger.warning("No previous transcription available for segmentation")
            return []
            
        try:
            import librosa
            from pydub import AudioSegment
            
            # Load audio file to get duration
            try:
                audio_duration = librosa.get_duration(path=self.last_audio_path)
            except:
                # Fall back to pydub if librosa fails
                audio = AudioSegment.from_file(self.last_audio_path)
                audio_duration = len(audio) / 1000.0  # Convert ms to seconds
            
            # If this is a very short audio file, create a simple segment
            if audio_duration < 5:
                return [{"start": 0, "end": audio_duration, "text": self.last_transcription}]
            
            # Split transcription into sentences for segments
            import re
            sentences = re.split(r"(?<=[.!?])\s+", self.last_transcription)
            sentences = [s for s in sentences if s.strip()]
            
            # If only one sentence, create a simple segment
            if len(sentences) <= 1:
                return [{"start": 0, "end": audio_duration, "text": self.last_transcription}]
            
            # Create segments with evenly distributed timestamps
            segments = []
            duration_per_segment = audio_duration / len(sentences)
            
            for i, sentence in enumerate(sentences):
                start_time = i * duration_per_segment
                end_time = min((i + 1) * duration_per_segment, audio_duration)
                
                segments.append({
                    "start": start_time,
                    "end": end_time,
                    "text": sentence.strip(),
                })
            
            return segments
        except Exception as e:
            custom_logger.exception(f"Error creating segments: {e!s}")
            return [{"start": 0, "end": 30, "text": self.last_transcription}]  # Fallback

    def process_audio_chunk(self, chunk):
        """Process a single chunk of audio data."""
        with self.buffer_lock:
            # Convert int16 to float32 and normalize
            if chunk.dtype == np.int16:
                chunk = chunk.astype(np.float32) / 32768.0
            
            # Add to buffer
            self.audio_buffer.extend(chunk)
            
            # Only process if we have enough data
            if len(self.audio_buffer) >= 16000:  # 1 second of audio
                # Convert buffer to numpy array
                audio_data = np.array(list(self.audio_buffer), dtype=np.float32)
                
                # Process through feature extractor
                inputs = self.feature_extractor(
                    audio_data,
                    sampling_rate=16000,
                    return_tensors="np",
                )
                
                # Get encoder outputs
                encoder_outputs = self.encode(inputs.input_features)
                
                # Run decoder
                output_ids = self.decode(encoder_outputs)
                
                # Get transcription
                transcription = self.postprocess(output_ids)
                
                # Update current transcript and put in queue
                self.current_transcript = transcription
                self.transcript_queue.put(transcription)
                
                # Keep only the last 0.5 seconds of audio for context
                self.audio_buffer = deque(list(self.audio_buffer)[-8000:], maxlen=48000)

    def start_processing(self):
        """Start the background processing thread."""
        self.is_processing = True
        self.processing_thread = threading.Thread(target=self._process_stream, daemon=True)
        self.processing_thread.start()

    def stop_processing(self):
        """Stop the background processing thread."""
        self.is_processing = False
        if self.processing_thread:
            self.processing_thread.join()

    def _process_stream(self):
        """Background thread for continuous processing."""
        while self.is_processing:
            try:
                if len(self.audio_buffer) >= 16000:
                    self.process_audio_chunk(np.array([]))
                else:
                    time.sleep(0.1)  # Prevent busy waiting
            except Exception as e:
                custom_logger.exception(f"Error in processing thread: {e}")
                break

    def get_current_transcript(self):
        """Get the latest transcript."""
        try:
            while not self.transcript_queue.empty():
                self.current_transcript = self.transcript_queue.get_nowait()
        except queue.Empty:
            pass
        return self.current_transcript
                
class VaDetector:
    def __init__(self, onnx_path=resource_path("cache/vad"), model_filename="silero_vad_16k.onnx", progress_callback=None):
        self.model_filename = model_filename
        self.model_path = os.path.join(onnx_path, model_filename)
        self.progress_callback = progress_callback
        
        # Download model if it doesn't exist
        if not os.path.exists(self.model_path):
            os.makedirs(onnx_path, exist_ok=True)
            self.download_model()
        
        # Load the ONNX model
        providers = ort.get_available_providers()
        self.session = ort.InferenceSession(self.model_path, providers=providers)
        
        # Model parameters
        self.sample_rate = 16000
        self.sr_per_ms = self.sample_rate / 1000
        self.window_size_samples = int(32 * self.sr_per_ms)  # Window size of 32 ms
        self.state_shape = (2, 1, 128)  # Shape inferred from the model
        
        # VAD thresholds and durations
        self.threshold = 0.5
        self.min_silence_duration_ms = 0
        self.speech_pad_ms = 32
        self.min_speech_duration_ms = 32
        self.max_speech_duration_s = np.inf
        
        # Calculated parameters
        self.min_speech_samples = self.sr_per_ms * self.min_speech_duration_ms
        self.speech_pad_samples = self.sr_per_ms * self.speech_pad_ms
        self.max_speech_samples = (
            self.sample_rate * self.max_speech_duration_s
            - self.window_size_samples
            - 2 * self.speech_pad_samples
        )
        self.min_silence_samples = self.sr_per_ms * self.min_silence_duration_ms
        self.min_silence_samples_at_max_speech = self.sr_per_ms * 98  # As per C++ code
        
        # Input and output names
        self.input_names = [input_.name for input_ in self.session.get_inputs()]
        self.output_names = [output.name for output in self.session.get_outputs()]
        
        # Initialize the state and other variables
        self.reset_states()
    
    def reset_states(self):
        """
        Reset the model states before processing a new audio segment.
        """
        self.state = np.zeros(self.state_shape, dtype=np.float32)
        self.triggered = False
        self.temp_end = 0
        self.current_sample = 0
        self.prev_end = 0
        self.next_start = 0
        self.speeches = []
        self.current_speech = None
    
    def preprocess_audio(self, audio_waveform):
        """
        Preprocess the input audio waveform.
        Args:
            audio_waveform (numpy.ndarray): The input audio waveform.
        Returns:
            numpy.ndarray: The preprocessed audio ready for inference.
        """
        # Ensure waveform is a numpy array
        if not isinstance(audio_waveform, np.ndarray):
            msg = "The input audio waveform must be a numpy array."
            raise ValueError(msg)
        
        # Check if the audio waveform is 1D, as expected
        if audio_waveform.ndim > 1:
            msg = "The input audio waveform must be a 1D array."
            raise ValueError(msg)
        
        # Normalize and reshape
        audio_waveform = audio_waveform.astype(np.float32)
        return np.expand_dims(audio_waveform, axis=0)  # Add batch dimension
    
    def load_audio(self, file_path, target_sample_rate=16000):
        """
        Load an audio file (wav, mp3, etc.) and convert it to the desired format.
        Args:
            file_path (str): The path to the audio file.
            target_sample_rate (int): The desired sample rate for the output waveform. Default is 16000.
        Returns:
            numpy.ndarray: The loaded and resampled audio waveform.
        """
        # Load audio using pydub for flexibility with formats like mp3, wav, etc.
        audio = AudioSegment.from_file(file_path)
        audio = audio.set_frame_rate(target_sample_rate).set_channels(1)
        samples = np.array(audio.get_array_of_samples(), dtype=np.float32)
        
        # Normalize samples to [-1, 1]
        sample_width = audio.sample_width  # in bytes
        max_value = float(1 << (8 * sample_width - 1))
        return samples / max_value
        
    
    def predict(self, data):
        """
        Run inference on a single window and update internal states.
        Args:
            data (numpy.ndarray): The audio data for the current window.
        """
        # Prepare input data
        input_data = self.preprocess_audio(data)
        
        # Prepare additional required inputs
        input_feed = {
            "input": input_data,
            "state": self.state,
            "sr": np.array([self.sample_rate], dtype=np.int64),
        }
        
        # Run inference
        outputs = self.session.run(["output", "stateN"], input_feed)
        
        # Extract outputs
        speech_prob = outputs[0][0]  # Speech probability
        self.state = outputs[1]  # Updated state
        
        # Update current sample position
        self.current_sample += self.window_size_samples
        
        # Implement logic similar to C++ code
        if speech_prob >= self.threshold:
            if self.temp_end != 0:
                self.temp_end = 0
                if self.next_start < self.prev_end:
                    self.next_start = self.current_sample - self.window_size_samples
            if not self.triggered:
                self.triggered = True
                self.current_speech = {"start": self.current_sample - self.window_size_samples}
        elif (self.threshold - 0.15) <= speech_prob < self.threshold:
            # Do nothing
            pass
        elif self.triggered:
            if self.temp_end == 0:
                self.temp_end = self.current_sample
            if self.current_sample - self.temp_end > self.min_silence_samples_at_max_speech:
                self.prev_end = self.temp_end
            if (self.current_sample - self.temp_end) < self.min_silence_samples:
                # Continue speaking
                pass
            else:
                self.current_speech["end"] = self.temp_end
                if self.current_speech["end"] - self.current_speech["start"] > self.min_speech_samples:
                    self.speeches.append(self.current_speech)
                    self.current_speech = None
                    self.prev_end = 0
                    self.next_start = 0
                    self.temp_end = 0
                    self.triggered = False
    
    def has_speech(self, file_path):
        """
        Run inference on the given audio file using the ONNX model.
        Args:
            file_path (str): The path to the audio file (wav, mp3, etc.).
        Returns:
            bool: True if speech is detected, otherwise False.
        """
        # Load and preprocess the audio waveform
        audio_waveform = self.load_audio(file_path)
        audio_length = len(audio_waveform)
        
        # Reset state before starting a new inference
        self.reset_states()
        
        # Process the audio in chunks/windows
        for start in range(0, audio_length, int(self.window_size_samples)):
            end = start + int(self.window_size_samples)
            if end > audio_length:
                break
            
            window = audio_waveform[start:end]
            if len(window) < self.window_size_samples:
                # Pad the last chunk if necessary
                window = np.pad(window, (0, int(self.window_size_samples - len(window))), mode="constant")
            
            self.predict(window)
        
        # Handle any remaining speech segment
        if self.current_speech and "start" in self.current_speech:
            self.current_speech["end"] = self.current_sample
            self.speeches.append(self.current_speech)
            self.current_speech = None
            self.prev_end = 0
            self.next_start = 0
            self.temp_end = 0
            self.triggered = False
        
        # Return True if any speech segments were detected
        return len(self.speeches) > 0

    def download_model(self):
        """Download the VAD model if it doesn't exist"""
        filename = "silero_vad_16k_op15"
        custom_logger.info(f"Downloading ONNX model to {self.model_path}...")
        url = f"https://github.com/snakers4/silero-vad/blob/master/src/silero_vad/data/{filename}.onnx?raw=true"
        
        try:
            response = requests.get(url, stream=True, timeout=30)
            response.raise_for_status()
            total_size = int(response.headers.get("content-length", 0))
            block_size = 1024  # 1 Kibibyte
            
            with open(self.model_path, "wb") as f:
                downloaded = 0
                for data in response.iter_content(block_size):
                    downloaded += len(data)
                    f.write(data)
                    if total_size > 0:
                        percent = int((downloaded / total_size) * 100)
                        if self.progress_callback:
                            self.progress_callback(filename=filename, percentage=percent)
            
            custom_logger.info(f"File downloaded successfully: {self.model_path}")
            if self.progress_callback:
                self.progress_callback(filename=filename, percentage=100)
                
        except requests.ConnectionError:
            if self.progress_callback:
                self.progress_callback(txt="Failed to connect to the internet. Please check your connection.")
            custom_logger.exception("Failed to connect to the internet. Please check your connection.")
            raise
        except requests.HTTPError as http_err:
            if self.progress_callback:
                self.progress_callback(txt=f"HTTP error occurred: {http_err}")
            custom_logger.exception(f"HTTP error occurred: {http_err}")
            raise
        except requests.Timeout:
            if self.progress_callback:
                self.progress_callback(txt="The request timed out. Please try again later.")
            custom_logger.exception("The request timed out. Please try again later.")
            raise
        except requests.RequestException as req_err:
            if self.progress_callback:
                self.progress_callback(txt="An error occurred while downloading VAD model, check logs")
            custom_logger.exception(f"An error occurred while downloading VAD model: {req_err}")
            raise
        except Exception as err:
            if self.progress_callback:
                self.progress_callback(txt="An unexpected error occurred while initializing VAD, check logs")
            custom_logger.exception(f"An unexpected error occurred while initializing VAD: {err}")
            raise