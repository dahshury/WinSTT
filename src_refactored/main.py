#!/usr/bin/env python3
"""Main entry point for the refactored WinSTT application.

This is the parallel refactored version that uses the new DDD architecture
with dependency injection, clean architecture patterns, and enterprise-level
container management.
"""

import sys
from pathlib import Path

# Add the project root to the Python path
project_root = Path(__file__).parent.parent
sys.path.insert(0, str(project_root))

from src_refactored.application.application_config import create_default_configuration
from src_refactored.application.application_orchestrator import create_application_orchestrator
from logger import setup_logger


def main() -> int:
    """Main entry point for the refactored WinSTT application.
    
    Returns:
        Exit code (0 for success, non-zero for error)
    """
    logger = setup_logger()
    
    try:
        logger.info("Starting WinSTT Refactored Application")
        
        # Initialize application configuration
        config = create_default_configuration()
        
        # Create application orchestrator with DI container
        orchestrator = create_application_orchestrator()
        
        # Start the application using the orchestrator
        exit_code = orchestrator.start_application()
        
        logger.info(f"Application exited with code: {exit_code}")
        return exit_code
        
    except Exception as e:
        logger.error(f"Fatal error starting application: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())