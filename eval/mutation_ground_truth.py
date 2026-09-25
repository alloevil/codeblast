"""Pure ground-truth filtering used by the mutation harness and its offline regression."""


def remove_clean_failures(
    truth: set[str],
    predicted: set[str],
    isolated_clean_failures: set[str],
    full_clean_failures: set[str],
) -> tuple[set[str], set[str]]:
    """Drop apparent misses that fail again on restored source under either test load."""
    suspect = truth - predicted
    reproduced = suspect & (isolated_clean_failures | full_clean_failures)
    return truth - reproduced, reproduced
