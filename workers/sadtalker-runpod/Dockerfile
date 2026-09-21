FROM python:3.12.7-slim-bookworm

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --requirement requirements.txt
COPY handler.py ./handler.py

ENV PYTHONUNBUFFERED=1 \
    LUX_WORKER_MODE=real

CMD ["python", "-u", "/app/handler.py"]
