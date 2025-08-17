"""Domain Utilities for Identity Generation."""


class DomainIdentityGenerator:
    """Internal generator for domain IDs and timestamps without external dependencies."""
    
    _sequence_counter = 0
    
    @classmethod
    def generate_domain_id(cls, prefix: str = "domain") -> str:
        """Generate a deterministic domain ID."""
        cls._sequence_counter += 1
        # Use hash of counter and prefix for pseudo-randomness
        hash_value = abs(hash(f"{prefix}_{cls._sequence_counter}")) % 1000000
        return f"{prefix}_{cls._sequence_counter}_{hash_value:06d}"
    
    @classmethod
    def generate_timestamp(cls) -> float:
        """Generate a monotonic timestamp for domain use."""
        # Use sequence counter as timestamp for deterministic behavior
        cls._sequence_counter += 1
        # Return a reasonable epoch-like timestamp
        return 1704067200.0 + cls._sequence_counter  # 2024-01-01 base + sequence

