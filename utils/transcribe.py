import os
import gc
import requests
from tqdm import tqdm
import onnxruntime as ort
import numpy as np
from transformers import WhisperTokenizerFast, WhisperFeatureExtractor
import json
import librosa
import onnxruntime as ort
from logger import setup_logger
from pydub import AudioSegment

custom_logger = setup_logger()
script_path = (os.path.dirname(os.path.abspath(__file__)))
cache_path = os.path.join(script_path, "cache")

class WhisperONNXTranscriber:
    def __init__(self, cache_path=cache_path, q="full" if 'CUDAExecutionProvider' in ort.get_available_providers() else "quantized"):
        self.cache_path = cache_path
        self.q = q
        self.model_type = "Whisper-turbo"
        # Subfolder for ONNX files
        self.onnx_folder = os.path.join(self.cache_path, "onnx")
        # Ensure models are downloaded
        self.update_names()
        self.download_and_prepare_models()
        # Load ONNX models  
        self.initialize_sessions(q=self.q)
        # Load tokenizer and feature extractor
        self.tokenizer = WhisperTokenizerFast.from_pretrained(self.cache_path)
        self.feature_extractor = WhisperFeatureExtractor.from_pretrained(self.cache_path)
        
        # Load configuration files
        with open(os.path.join(self.cache_path, "config.json"), 'r') as f:
            self.config = json.load(f)
        with open(os.path.join(self.cache_path, "generation_config.json"), 'r') as f:
            self.generation_config = json.load(f)
        with open(os.path.join(self.cache_path, "preprocessor_config.json"), 'r') as f:
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
                providers=available_providers
            )
        except Exception as e:
            os.remove(encoder_path)
            if self.q.lower()=="full":
                encoder_onnx_data_path = os.path.join(self.onnx_folder, self.encoder_name.replace("onnx", "onnx_data"))
                print(encoder_onnx_data_path)
                if os.path.exists(encoder_onnx_data_path):
                    os.remove(encoder_onnx_data_path)
            self.download_and_prepare_models()
            custom_logger.debug(e)
        try:
            decoder_path = os.path.join(self.onnx_folder, self.decoder_name)
            self.decoder_session = ort.InferenceSession(
                os.path.join(decoder_path),
                providers=available_providers
            ) 
        except Exception as e:
            os.remove(decoder_path) 
            self.download_and_prepare_models()
            custom_logger.debug(e)
        
    def download_and_prepare_models(self):
        """Downloads the model files if they don't exist."""
        os.makedirs(self.onnx_folder, exist_ok=True)

        repo_url = "https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/main/onnx/"
        files = [
            self.encoder_name,
            "encoder_model.onnx_data" if self.q.lower() == "full" else None,
            self.decoder_name
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
            "normalizer.json"             # Optional normalization configurations for text preprocessing
        ]


        # Download ONNX files
        for file_name in files:
            if file_name is not None:
                file_path = os.path.join(self.onnx_folder, file_name)
                if not os.path.exists(file_path):
                    print(f"File '{file_name}' not found. Downloading...")
                    file_url = repo_url + file_name
                    self.download_file_with_progress(file_url, file_path)

        # Download configuration files
        for config_file in config_files:
            config_path = os.path.join(self.cache_path, config_file)
            config_url = f"https://huggingface.co/onnx-community/whisper-large-v3-turbo/resolve/main/{config_file}"
            if not os.path.exists(config_path):
                print(f"Configuration file '{config_file}' not found. Downloading...")
                self.download_file_with_progress(config_url, config_path)

    @staticmethod
    def download_file_with_progress(url, save_path):
        """Download a file from a URL with a progress bar and handle errors."""
        try:
            response = requests.get(url, stream=True, timeout=10)
            response.raise_for_status()  # Raise HTTPError for bad responses (4xx and 5xx)

            total_size = int(response.headers.get('content-length', 0))
            block_size = 1024  # 1 KiB

            with open(save_path, 'wb') as file, tqdm(
                desc=f"Downloading {os.path.basename(save_path)}",
                total=total_size,
                unit='B',
                unit_scale=True,
                unit_divisor=1024,
            ) as bar:
                for data in response.iter_content(block_size):
                    file.write(data)
                    bar.update(len(data))
            print(f"File downloaded successfully: {save_path}")

        except requests.ConnectionError:
            print("Failed to connect to the internet. Please check your connection.")
        except requests.HTTPError as http_err:
            print(f"HTTP error occurred: {http_err}")
        except requests.Timeout:
            print("The request timed out. Please try again later.")
        except requests.RequestException as req_err:
            print(f"An error occurred: {req_err}")
        except Exception as err:
            print(f"An unexpected error occurred: {err}")

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
            return_tensors="np"
        )

        input_features = inputs.input_features

        return input_features

    def encode(self, input_features):
        # Run encoder
        encoder_outputs = self.encoder_session.run(
            None,
            {"input_features": input_features}
        )
        return encoder_outputs[0]

    def decode(self, encoder_hidden_states, attention_mask=None):
        # Initialize decoder inputs
        batch_size = encoder_hidden_states.shape[0]
        decoder_input_ids = np.array([[self.generation_config["decoder_start_token_id"]]] * batch_size, dtype=np.int64)

        # Initialize past key values with correct dimensions from config
        num_layers = self.config['decoder_layers']
        num_attention_heads = self.config['decoder_attention_heads']
        head_dim = self.config['d_model'] // num_attention_heads

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
                "use_cache_branch": np.array([False], dtype=bool)
            }

            # Add past key values to inputs
            for layer in range(num_layers):
                decoder_inputs.update({
                    f"past_key_values.{layer}.decoder.key": past_key_values[layer][0],
                    f"past_key_values.{layer}.decoder.value": past_key_values[layer][1],
                    f"past_key_values.{layer}.encoder.key": past_key_values[layer][2],
                    f"past_key_values.{layer}.encoder.value": past_key_values[layer][3]
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
                        decoder_outputs[idx + 3]  # encoder value
                    ))
                past_key_values = updated_past_key_values

                # Append tokens
                output_ids.append(next_tokens)

                # Update decoder input ids
                decoder_input_ids = np.concatenate(
                    [decoder_input_ids, next_tokens[:, None]], axis=-1
                )

                # Check for end of sequence
                if np.all(next_tokens == self.generation_config["eos_token_id"]):
                    break

            except Exception as e:
                print(f"Error in decoder iteration: {e}")
                break

        return np.array(output_ids, dtype=np.int64).T  # Ensure int64

    def postprocess(self, output_ids):
        # Convert output_ids to list for the tokenizer
        output_ids_list = output_ids.tolist()

        # Decode the predicted tokens to text
        transcription = self.tokenizer.batch_decode(
            output_ids_list, skip_special_tokens=True
        )[0]
        return transcription

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
            
            return transcription
        except Exception as e:
            print(f"Error in transcription pipeline: {str(e)}")
            raise
        
class VaDetector:
    def __init__(self, onnx_path=cache_path, model_filename="silero_vad_16k.onnx"):
        # Ensure the ONNX directory exists
        if not os.path.exists(onnx_path):
            os.makedirs(onnx_path)
        
        # Full path to the ONNX model
        onnx_model_path = os.path.join(onnx_path, "onnx", model_filename)
        
        # Download the ONNX model if it doesn't exist
        if not os.path.exists(onnx_model_path):
            custom_logger.info(f"Downloading ONNX model to {onnx_model_path}...")
            url = "https://github.com/snakers4/silero-vad/blob/master/src/silero_vad/data/silero_vad_16k_op15.onnx?raw=true"
            try:
                response = requests.get(url, stream=True)
                response.raise_for_status()
                total_size = int(response.headers.get('content-length', 0))
                block_size = 1024  # 1 Kibibyte
                with open(onnx_model_path, 'wb') as f, tqdm(total=total_size, unit='iB', unit_scale=True) as t:
                    for data in response.iter_content(block_size):
                        t.update(len(data))
                        f.write(data)
                custom_logger.info(f"File downloaded successfully: {onnx_model_path}")
            except requests.ConnectionError:
                custom_logger.error("Failed to connect to the internet. Please check your connection.")
                raise
            except requests.HTTPError as http_err:
                custom_logger.error(f"HTTP error occurred: {http_err}")
                raise
            except requests.Timeout:
                custom_logger.error("The request timed out. Please try again later.")
                raise
            except requests.RequestException as req_err:
                custom_logger.error(f"An error occurred while initializing VAD: {req_err}")
                raise
            except Exception as err:
                custom_logger.error(f"An unexpected error occurred while initializing VAD: {err}")
                raise
        
        # Load the ONNX model for inference
        self.onnx_model_path = onnx_model_path
        self.session = ort.InferenceSession(onnx_model_path)
        
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
            raise ValueError("The input audio waveform must be a numpy array.")
        
        # Check if the audio waveform is 1D, as expected
        if audio_waveform.ndim > 1:
            raise ValueError("The input audio waveform must be a 1D array.")
        
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
        samples = samples / max_value
        
        return samples
    
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
            'input': input_data,
            'state': self.state,
            'sr': np.array([self.sample_rate], dtype=np.int64)
        }
        
        # Run inference
        outputs = self.session.run(['output', 'stateN'], input_feed)
        
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
                self.current_speech = {'start': self.current_sample - self.window_size_samples}
        elif (self.threshold - 0.15) <= speech_prob < self.threshold:
            # Do nothing
            pass
        else:
            if self.triggered:
                if self.temp_end == 0:
                    self.temp_end = self.current_sample
                if self.current_sample - self.temp_end > self.min_silence_samples_at_max_speech:
                    self.prev_end = self.temp_end
                if (self.current_sample - self.temp_end) < self.min_silence_samples:
                    # Continue speaking
                    pass
                else:
                    self.current_speech['end'] = self.temp_end
                    if self.current_speech['end'] - self.current_speech['start'] > self.min_speech_samples:
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
                window = np.pad(window, (0, int(self.window_size_samples - len(window))), mode='constant')
            
            self.predict(window)
        
        # Handle any remaining speech segment
        if self.current_speech and 'start' in self.current_speech:
            self.current_speech['end'] = self.current_sample
            self.speeches.append(self.current_speech)
            self.current_speech = None
            self.prev_end = 0
            self.next_start = 0
            self.temp_end = 0
            self.triggered = False
        
        # Return True if any speech segments were detected
        return len(self.speeches) > 0