"""Pure image-validation function for uploaded bytes. No storage, no HTTP, no model.

The ONLY trusted input is the bytes themselves — never a filename or a client-sent
Content-Type. Raises rest_framework.exceptions.ValidationError (house style) on anything
that is not a genuine, in-bounds JPEG or PNG.
"""

import io

from PIL import Image
from rest_framework.exceptions import ValidationError

MAX_UPLOAD_BYTES = 5 * 1024 * 1024       # 5 MB, checked BEFORE any decode
MAX_IMAGE_PIXELS = 24_000_000            # 24 MP decompression-bomb cap
MAX_DIMENSION = 2000                     # px, longest side (used in Phase 2)
JPEG_QUALITY = 85
_ALLOWED = {'JPEG': 'image/jpeg', 'PNG': 'image/png'}
_MAGIC = {b'\xFF\xD8\xFF': 'JPEG', b'\x89PNG\r\n\x1a\n': 'PNG'}


def validate_and_reencode(raw: bytes):
    """Validate raw upload bytes are a real JPEG/PNG and return cleaned bytes.

    Returns (clean_bytes, content_type). Raises rest_framework.exceptions.ValidationError
    on anything that is not a genuine, in-bounds JPEG or PNG. The ONLY trusted input is
    the bytes themselves — never a filename or client Content-Type (this function never
    sees them). PHASE 1: validates and returns raw (NO re-encode). Phase 2 adds re-encode.
    """
    if not raw:
        raise ValidationError("Empty file.")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise ValidationError("File too large (max 5 MB).")
    if not any(raw.startswith(sig) for sig in _MAGIC):
        raise ValidationError("Unsupported image type.")
    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS  # second-layer bomb guard
    try:
        img = Image.open(io.BytesIO(raw))
        img.load()  # load() forces full decode → catches truncation/corruption
    except Exception:
        raise ValidationError("Corrupt or unreadable image.")
    fmt = img.format  # authoritative allowlist — img.format, not the magic guess
    if fmt not in _ALLOWED:
        raise ValidationError("Unsupported image type.")
    if img.width * img.height > MAX_IMAGE_PIXELS:
        raise ValidationError("Image dimensions too large.")
    content_type = _ALLOWED[fmt]
    # PHASE 2 — rebuild the file from decoded pixels. A fresh save drops any appended
    # tail (polyglot payload) AND metadata. Do NOT pass exif= or pnginfo=.
    if max(img.width, img.height) > MAX_DIMENSION:
        img.thumbnail((MAX_DIMENSION, MAX_DIMENSION))
    out = io.BytesIO()
    if fmt == 'JPEG':
        img.convert('RGB').save(out, 'JPEG', quality=JPEG_QUALITY, optimize=True)
    else:  # PNG — preserve mode/alpha
        img.save(out, 'PNG', optimize=True)
    return out.getvalue(), content_type
