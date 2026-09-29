"""
QForge Provenance & Copyright Audit — Phase 3: Deterministic Normalizer & Canonical Hasher
"""

import re
import unicodedata
import hashlib
from typing import Dict, List, Optional, Tuple


def canonicalize_text(text: Optional[str]) -> str:
    """
    Deterministically normalize question text, options, or explanations.
    - Preserves mathematical equations, digits, signs, decimal points, variables, units.
    - Strips outer LaTeX delimiters ($...$, $$...$$, \\(...\\), \\[...\\]) and HTML tags/entities.
    - Normalizes LaTeX operators and whitespace.
    """
    if not text or not isinstance(text, str):
        return ""

    # 1. Unicode Normalization (NFKC)
    text = unicodedata.normalize("NFKC", text)

    # 2. Decode common HTML entities
    html_entities = {
        "&nbsp;": " ",
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&#39;": "'",
        "&times;": "*",
        "&divide;": "/",
        "&plusmn;": "+-",
        "&le;": "<=",
        "&ge;": ">=",
        "&ne;": "!=",
        "&alpha;": "alpha",
        "&beta;": "beta",
        "&gamma;": "gamma",
        "&theta;": "theta",
        "&pi;": "pi",
        "&mu;": "mu",
        "&lambda;": "lambda",
        "&omega;": "omega",
    }
    for ent, rep in html_entities.items():
        text = text.replace(ent, rep)

    # 3. Strip HTML tags like <p>, </p>, <br>, <b>, etc.
    text = re.sub(r"<[^>]+>", " ", text)

    # 4. Standardize LaTeX outer math delimiters
    # Strip $$, $, \(, \), \[, \]
    text = re.sub(r"\\\[(.*?)\\\]", r"\1", text, flags=re.DOTALL)
    text = re.sub(r"\\\((.*?)\\\)", r"\1", text, flags=re.DOTALL)
    text = re.sub(r"\$\$(.*?)\$\$", r"\1", text, flags=re.DOTALL)
    text = re.sub(r"\$(.*?)\$", r"\1", text, flags=re.DOTALL)

    # 5. Standardize LaTeX fraction macros: \frac{a}{b} -> (a)/(b)
    # Recursively replace \frac{num}{den}
    fraction_pattern = re.compile(r"\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}")
    while fraction_pattern.search(text):
        text = fraction_pattern.sub(r"(\1)/(\2)", text)

    # Standardize \sqrt{a} -> sqrt(a)
    text = re.sub(r"\\sqrt\s*\{([^{}]+)\}", r"sqrt(\1)", text)

    # Standardize common LaTeX symbols
    latex_symbols = {
        r"\times": "*",
        r"\cdot": "*",
        r"\div": "/",
        r"\pm": "+-",
        r"\mp": "-+",
        r"\leq": "<=",
        r"\geq": ">=",
        r"\neq": "!=",
        r"\approx": "~=",
        r"\equiv": "==",
        r"\degree": "deg",
        r"^\circ": "deg",
        r"\rightarrow": "->",
        r"\to": "->",
        r"\leftarrow": "<-",
        r"\implies": "=>",
        r"\infty": "inf",
        r"\Delta": "delta",
        r"\delta": "delta",
        r"\theta": "theta",
        r"\pi": "pi",
        r"\lambda": "lambda",
        r"\mu": "mu",
        r"\Omega": "ohm",
        r"\omega": "omega",
        r"\text": "",
        r"\mathrm": "",
        r"\mathbf": "",
        r"\mathit": "",
    }
    for sym, rep in latex_symbols.items():
        text = text.replace(sym, rep)

    # 6. Lowercase
    text = text.lower()

    # 7. Normalize spaces around mathematical operators: e.g. 2x + 3 -> 2x+3 or consistent single space
    # Normalize operators to have single space around them
    text = re.sub(r"\s*([=+\-*/^<>])\s*", r" \1 ", text)

    # 8. Clean up extra punctuation/brackets whitespace
    text = re.sub(r"\s*([(),:;])\s*", r"\1 ", text)

    # 9. Collapse multiple whitespace into a single space and trim
    text = re.sub(r"\s+", " ", text).strip()

    return text


def sha256_hex(text: str) -> str:
    """Compute SHA-256 hex digest for a string."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def compute_question_fingerprints(
    question_text: str,
    option_a: Optional[str] = None,
    option_b: Optional[str] = None,
    option_c: Optional[str] = None,
    option_d: Optional[str] = None,
    correct_answer: Optional[str] = None,
) -> Dict[str, str]:
    """
    Generate the 4 canonical SHA-256 fingerprint hashes:
    1. stem_hash
    2. stem_plus_options_ordered_hash
    3. stem_plus_options_unordered_hash
    4. full_question_hash
    """
    c_stem = canonicalize_text(question_text)
    c_opt_a = canonicalize_text(option_a)
    c_opt_b = canonicalize_text(option_b)
    c_opt_c = canonicalize_text(option_c)
    c_opt_d = canonicalize_text(option_d)
    c_ans = canonicalize_text(correct_answer)

    # 1. Stem hash
    stem_hash = sha256_hex(c_stem)

    # 2. Stem + Options Ordered hash
    ordered_opts_str = f"{c_stem}|A:{c_opt_a}|B:{c_opt_b}|C:{c_opt_c}|D:{c_opt_d}"
    stem_plus_options_ordered_hash = sha256_hex(ordered_opts_str)

    # 3. Stem + Options Unordered hash (sorted options to detect permutations)
    sorted_opts = sorted([c_opt_a, c_opt_b, c_opt_c, c_opt_d])
    unordered_opts_str = f"{c_stem}|" + "|".join(sorted_opts)
    stem_plus_options_unordered_hash = sha256_hex(unordered_opts_str)

    # 4. Full question hash (includes correct answer)
    full_q_str = f"{ordered_opts_str}|ANS:{c_ans}"
    full_question_hash = sha256_hex(full_q_str)

    return {
        "canonical_stem": c_stem,
        "stem_hash": stem_hash,
        "stem_plus_options_ordered_hash": stem_plus_options_ordered_hash,
        "stem_plus_options_unordered_hash": stem_plus_options_unordered_hash,
        "full_question_hash": full_question_hash,
    }
