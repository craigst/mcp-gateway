# brain-api — the data plane.
#
# ocrmypdf + tesseract are baked in rather than run as a second container: OCR is
# a subprocess on a file the service already has open, and a separate "OCR
# service" would mean shipping the file twice and inventing a job protocol for
# no gain. Tika (metadata + hundreds of formats) IS a separate container, because
# that is what Tika is and it is used over HTTP by design.
FROM python:3.12-slim

ENV MEM0_TELEMETRY=false \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# ocrmypdf needs ghostscript (per-page rasterising + PDF/A), tesseract for the
# recognition itself, and unpaper/pngquant for the clean/deskew paths.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ocrmypdf \
        tesseract-ocr \
        tesseract-ocr-eng \
        ghostscript \
        unpaper \
        pngquant \
        poppler-utils \
        curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=8s --start-period=40s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8000/livez || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
