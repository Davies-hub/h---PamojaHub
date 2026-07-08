"""Shared PDF report renderer (reportlab platypus).

`render_report_pdf(title, subtitle, header, rows) -> bytes` builds a paginated,
tabular PDF for the treasurer Reports exports. It is the PDF sibling of the CSV
`_Echo` / `csv.writer` idiom: the SAME (header, list-of-row-lists) contract, a
different wire format. Callers own the queryset + column selection — the single
church-scope / NET-only / PII leak surface stays in the view; this module only
formats what it is handed. Donation History is the first caller (this slice);
Payout History and Campaign Summary reuse it verbatim in later slices.

Empty `rows` is valid, not an error: the PDF still renders the title, subtitle and
the column header, with a "No records" line in place of the table body — never a
crash. Row cell values are coerced to `str` so an accidental None/Decimal does not
blow up the layout engine.
"""
from io import BytesIO

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

# On-brand shades (mirror constants/theme.ts: primary teal, grey row stripe, muted
# footer, border hairline) — inlined as hex so the renderer pulls no JS token.
_HEADER_BG = colors.HexColor('#057C8A')     # Colors.primary
_ROW_ALT_BG = colors.HexColor('#F5F5F5')    # Colors.grey
_HAIRLINE = colors.HexColor('#CCCCCC')      # Colors.border
_MUTED = colors.HexColor('#888888')         # Colors.textMuted
_TEXT = colors.HexColor('#1A1A1A')          # Colors.text
_TEXT_SECONDARY = colors.HexColor('#555555')  # Colors.textSecondary


def _draw_footer(canvas, doc):
    """onPage callback: the current page number, centred in the bottom margin."""
    canvas.saveState()
    canvas.setFont('Helvetica', 8)
    canvas.setFillColor(_MUTED)
    canvas.drawCentredString(A4[0] / 2.0, 12 * mm, f'Page {canvas.getPageNumber()}')
    canvas.restoreState()


def render_report_pdf(title, subtitle, header, rows):
    """Return raw PDF bytes for a titled, paginated table report.

    title    — report name (e.g. "Donation History").
    subtitle — context line (e.g. "Church A · Generated 2026-07-07").
    header   — list[str] column headings.
    rows     — list[list] data rows; [] renders a "No records" body (still valid PDF).
    """
    buffer = BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        topMargin=20 * mm,
        bottomMargin=20 * mm,
        leftMargin=15 * mm,
        rightMargin=15 * mm,
        title=title,
    )

    base = getSampleStyleSheet()
    title_style = ParagraphStyle(
        'ReportTitle', parent=base['Title'], fontSize=18, spaceAfter=4,
        alignment=0, textColor=_TEXT,
    )
    subtitle_style = ParagraphStyle(
        'ReportSubtitle', parent=base['Normal'], fontSize=10,
        textColor=_TEXT_SECONDARY, spaceAfter=12,
    )

    story = [
        Paragraph(title, title_style),
        Paragraph(subtitle, subtitle_style),
    ]

    # Always render the column header row (even when empty) so the PDF documents its
    # shape; cells are str()-coerced so None/Decimal can't break layout.
    table_data = [list(header)] + [[('' if c is None else str(c)) for c in r] for r in rows]
    table = Table(table_data, repeatRows=1)
    table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), _HEADER_BG),
        ('TEXTCOLOR', (0, 0), (-1, 0), colors.white),
        ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
        ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'),
        ('FONTSIZE', (0, 0), (-1, -1), 9),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ('LINEBELOW', (0, 0), (-1, 0), 0.75, _HEADER_BG),
        ('LINEBELOW', (0, 1), (-1, -1), 0.25, _HAIRLINE),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, _ROW_ALT_BG]),
    ]))
    story.append(table)

    if not rows:
        empty_style = ParagraphStyle(
            'ReportEmpty', parent=base['Normal'], fontSize=11,
            textColor=_MUTED, spaceBefore=16,
        )
        story.append(Spacer(1, 8))
        story.append(Paragraph('No records for this report.', empty_style))

    doc.build(story, onFirstPage=_draw_footer, onLaterPages=_draw_footer)
    return buffer.getvalue()
