import logging
from logging import StreamHandler
import os
from datetime import datetime

def setup_logger():
    log_file_name = f"{datetime.now().strftime('%m_%d')}.log"
    log_path = os.path.join('log', log_file_name)
    os.makedirs(log_path, exist_ok=True)
    log_file_path = os.path.join(log_path, log_file_name)

    # Create a custom logger
    logger = logging.getLogger(__name__)
    logger.setLevel(logging.DEBUG)  # Set the logger level to DEBUG

    # Check if handlers already exist to avoid duplicates
    if not logger.handlers:
        # Configure the file handler
        file_handler = logging.FileHandler(log_file_path)
        file_handler.setFormatter(logging.Formatter("[%(asctime)s] %(name)s - %(levelname)s - %(message)s"))
        file_handler.setLevel(logging.INFO)

        # Create a stream handler and set its level to DEBUG
        stream_handler = StreamHandler()
        stream_handler.setLevel(logging.DEBUG)  # Set the level to the lowest severity level

        # Add both handlers to the custom logger
        logger.addHandler(file_handler)
        logger.addHandler(stream_handler)

    return logger
