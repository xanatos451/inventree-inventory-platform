"""Validated, non-destructive row selection for captured datasets."""


def select_capture_rows(rows, selected_row_indices=None):
    """Return ``(original_index, row)`` pairs for the requested subset."""
    rows = list(rows or [])
    if selected_row_indices is None:
        return list(enumerate(rows))
    if not isinstance(selected_row_indices, list):
        raise ValueError("selected_row_indices must be a list.")

    selected = []
    seen = set()
    for value in selected_row_indices:
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError("Every selected row index must be an integer.")
        if value < 0 or value >= len(rows):
            raise ValueError(f"Selected row index {value} is outside the dataset.")
        if value in seen:
            continue
        seen.add(value)
        selected.append((value, rows[value]))
    return selected
