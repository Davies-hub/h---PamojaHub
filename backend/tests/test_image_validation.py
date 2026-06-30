"""Pure-function tests for media.validation.validate_and_reencode (SimpleTestCase, no DB).

Two-phase: S1 (polyglot tail) is written to FAIL in Phase 1 (return raw, tail survives)
and PASS in Phase 2 (re-encode rebuilds the file from decoded pixels, stripping the tail).
"""

import io
from unittest.mock import patch

from django.test import SimpleTestCase
from PIL import Image
from rest_framework.exceptions import ValidationError

from media.validation import MAX_DIMENSION, MAX_UPLOAD_BYTES, validate_and_reencode


def _jpeg(size=(8, 8), color=(237, 143, 28)):
    b = io.BytesIO()
    Image.new('RGB', size, color).save(b, 'JPEG')
    return b.getvalue()


def _png(size=(8, 8), color=(5, 124, 138), mode='RGB'):
    b = io.BytesIO()
    Image.new(mode, size, color).save(b, 'PNG')
    return b.getvalue()


class ImageValidationTests(SimpleTestCase):
    # --- RED: each must raise ValidationError ---
    def test_r1_empty(self):
        with self.assertRaises(ValidationError):
            validate_and_reencode(b'')

    def test_r2_not_image(self):
        with self.assertRaises(ValidationError):
            validate_and_reencode(b'<html>not an image</html>')

    def test_r3_gif_rejected(self):
        with self.assertRaises(ValidationError):
            validate_and_reencode(b'GIF89a' + b'\x00' * 32)

    def test_r4_corrupt_jpeg(self):
        with self.assertRaises(ValidationError):
            validate_and_reencode(b'\xFF\xD8\xFF' + b'\x00' * 64)

    def test_r5_oversized(self):
        with self.assertRaises(ValidationError):
            validate_and_reencode(b'\x00' * (MAX_UPLOAD_BYTES + 1))

    def test_r6_bomb_path(self):
        with patch('media.validation.MAX_IMAGE_PIXELS', 100):
            with self.assertRaises(ValidationError):
                validate_and_reencode(_jpeg(size=(50, 50)))

    # --- GREEN: each returns cleanly ---
    def test_g1_jpeg(self):
        out, ct = validate_and_reencode(_jpeg())
        self.assertEqual(ct, 'image/jpeg')
        Image.open(io.BytesIO(out)).verify()

    def test_g2_png(self):
        out, ct = validate_and_reencode(_png())
        self.assertEqual(ct, 'image/png')
        Image.open(io.BytesIO(out)).verify()

    def test_g3_png_alpha_preserved(self):
        out, _ = validate_and_reencode(_png(mode='RGBA'))
        self.assertIn(Image.open(io.BytesIO(out)).mode, ('RGBA', 'LA', 'P'))

    # --- SECURITY (seen-failing-first): FAILS in Phase 1, PASSES in Phase 2 ---
    def test_s1_polyglot_tail_stripped(self):
        payload = _jpeg() + b'<script>alert(document.cookie)</script>'
        out, ct = validate_and_reencode(payload)
        # it IS a valid image → accepted; but the script tail must be GONE:
        self.assertNotIn(b'<script>', out)
        self.assertNotIn(b'alert', out)

    # --- ADDENDUM: close two untested guard paths ---
    def test_oversized_dimensions_downscaled(self):
        big = _jpeg(size=(3000, 1500))  # longest side 3000 > MAX_DIMENSION (2000)
        out, ct = validate_and_reencode(big)
        w, h = Image.open(io.BytesIO(out)).size
        self.assertLessEqual(max(w, h), MAX_DIMENSION)  # downscaled
        self.assertEqual(w / h, 2.0)  # aspect ratio preserved (3000/1500 == new w/h)

    def test_s1b_png_polyglot_tail_stripped(self):
        payload = _png() + b'<script>alert(document.cookie)</script>'  # tail after IEND
        out, ct = validate_and_reencode(payload)
        self.assertEqual(ct, 'image/png')
        self.assertNotIn(b'<script>', out)
        self.assertNotIn(b'alert', out)
