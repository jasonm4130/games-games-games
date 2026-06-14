"""Convert a rulebook PDF to cleaned raw markdown (Docling primary, Marker --use_llm escalation).

Usage:
  uv run python scripts/convert-pdfs.py --pdf /path/in.pdf --out rulebooks/catan/tb.md \
      [--engine docling|marker] [--r2-key catan/tb.md]

Docling needs no API key. --engine marker uses Marker with --use_llm (cloud Gemini, needs
GOOGLE_API_KEY) and is the escalation for graphically-designed files Docling mangles. R2 upload
(when --r2-key is given) rides the wrangler login; CLOUDFLARE_API_TOKEN is stripped.
"""
import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path

# Make `scripts.lib.*` importable when run as `python scripts/convert-pdfs.py` (sys.path[0] would
# otherwise be scripts/, not the repo root).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts.lib.clean import clean_markdown  # noqa: E402

R2_BUCKET = "ggg-rulebooks"


def convert_docling(pdf: Path) -> str:
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    # Our rulebooks are born-digital PDFs with a real text layer (the problem we heal is mangled
    # extraction, NOT a missing layer). Docling defaults do_ocr=True, which runs RapidOCR on every
    # page, returns empty results, and adds minutes per file for zero gain. Disable it; keep table
    # structure on (rulebooks have tables). Escalate to --engine marker for any truly scanned file.
    opts = PdfPipelineOptions()
    opts.do_ocr = False
    converter = DocumentConverter(
        format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)}
    )
    return converter.convert(str(pdf)).document.export_to_markdown()


def convert_marker(pdf: Path) -> str:
    if not os.environ.get("GOOGLE_API_KEY"):
        sys.exit("--engine marker needs GOOGLE_API_KEY for --use_llm")
    with tempfile.TemporaryDirectory() as out:
        subprocess.run(
            ["marker_single", str(pdf), "--use_llm", "--output_format", "markdown", "--output_dir", out],
            check=True,
        )
        md = next(Path(out).rglob("*.md"), None)
        if md is None:
            sys.exit("marker produced no markdown")
        return md.read_text(encoding="utf-8")


def upload_r2(local: Path, r2_key: str) -> None:
    env = {k: v for k, v in os.environ.items() if k != "CLOUDFLARE_API_TOKEN"}
    subprocess.run(
        ["wrangler", "r2", "object", "put", f"{R2_BUCKET}/{r2_key}", "--file", str(local), "--remote"],
        check=True,
        env=env,
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--engine", choices=["docling", "marker"], default="docling")
    ap.add_argument("--r2-key")
    args = ap.parse_args()

    pdf = Path(args.pdf)
    raw = convert_marker(pdf) if args.engine == "marker" else convert_docling(pdf)
    cleaned = clean_markdown(raw)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(cleaned, encoding="utf-8")
    print(f"-> wrote {out} ({len(cleaned)} chars, engine={args.engine})")

    if args.r2_key:
        upload_r2(out, args.r2_key)
        print(f"-> uploaded to {R2_BUCKET}/{args.r2_key}")


if __name__ == "__main__":
    main()
