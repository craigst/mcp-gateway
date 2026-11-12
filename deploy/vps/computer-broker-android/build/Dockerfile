# Android connector image for the Razer Phone computer.
# Build context is this directory plus connector/ (the broker connector
# package, taken from the "computer broker" checkout).
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && (apt-get install -y --no-install-recommends adb \
     || apt-get install -y --no-install-recommends android-tools-adb) \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/connector
COPY connector/ ./connector/
RUN pip install --no-cache-dir -r ./connector/requirements.txt

ENV PYTHONUNBUFFERED=1
CMD ["python", "-m", "connector"]
