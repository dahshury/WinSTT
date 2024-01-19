import torch
import joblib
import os
from logger import setup_logger
from faster_whisper import WhisperModel
from transformers import pipeline
from transformers.utils import is_flash_attn_2_available
torch.set_num_threads(1)

logger = setup_logger()
torch.nn.functional.scaled_dot_product_attention

def has_speech(audio_file_path):
    if os.path.getsize(audio_file_path) > 1024:
        try:
            model, utils = torch.hub.load(repo_or_dir='snakers4/silero-vad',
                                            model='silero_vad',
                                            verbose=False
                                            )

            SAMPLING_RATE = 16000
            (get_speech_timestamps,
            save_audio,
            read_audio,
            VADIterator,
            collect_chunks) = utils
        except Exception as e:
            logger.exception(f"Error initializing Silero VAD "
                                    f"voice activity detection engine: {e}")
            raise
        vad_iterator = VADIterator(model)
        wav = read_audio(audio_file_path, sampling_rate=SAMPLING_RATE)

        window_size_samples = 1536  # number of samples in a single audio chunk
        for i in range(0, len(wav), window_size_samples):
            chunk = wav[i: i + window_size_samples]
            if len(chunk) < window_size_samples:
                break
            speech_dict = vad_iterator(chunk)
            if speech_dict:
                vad_iterator.reset_states()
                return True
                
        vad_iterator.reset_states()  # reset model states after each audio
        return False
    
    else:
        return False

def get_model(model_type, model_size):
    CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")
    torch.hub.set_dir(CACHE_DIR)
    # Ensure the cache directory exists
    os.makedirs(CACHE_DIR, exist_ok=True)
    logger.info(f"Loading model: {model_type} {model_size}...")
    cache_file = os.path.join(CACHE_DIR, f"{model_type} {model_size}.joblib")

    if os.path.exists(cache_file):
        model = joblib.load(cache_file)
        logger.debug(f"Model: {model_type} {model_size} loaded from cache.")
            
    elif model_type == "Insanely-Fast-Whisper":
        try:
        # If not in cache, create the pipeline and save to cache
            model = pipeline(
                "automatic-speech-recognition",
                model="openai/whisper-"+model_size,
                torch_dtype=torch.float16,
                device="cuda:0",
                model_kwargs={"attn_implementation": "flash_attention_2"} if is_flash_attn_2_available() else {"attn_implementation": "sdpa"},
            )
            joblib.dump(model, cache_file)
            logger.debug(f"Model: {model_type} {model_size} loaded and cached.")
        except Exception as e:
            logger.exception(f"Error initializing transcription model: {model_type} {model_size}, {e}")
            raise
    else:
        # Run on CPU with int8
        try:
            model = WhisperModel(model_size_or_path=model_size, device='cuda' if torch.cuda.is_available() else 'cpu', compute_type="auto")
            logger.debug(f"Model: {model_type} {model_size} loaded and cached.")
        except Exception as e:
             logger.exception(f"Error initializing transcription model: {model_type} {model_size}, {e}")
             raise
    return model