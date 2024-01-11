import os
import logging

log_path = os.path.join('logs', 'running_logs.log')

os.makedirs('logs', exist_ok=True)

# Setting up logging
logger = logging.getLogger()
logger.setLevel(logging.WARNING)
log_format = logging.Formatter('WinTTS: %(name)s - %(levelname)s - %(message)s')
file_handler = logging.FileHandler(log_path)
file_handler.setLevel(logging.DEBUG)
file_handler.setFormatter(log_format)
stream_handler = logging.StreamHandler()
stream_handler.setLevel(logging.WARNING)
stream_handler.setFormatter(log_format)