FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    REMOTE_NLP_MODEL=facebook/bart-large-mnli \
    REMOTE_NLP_DEVICE=-1 \
    REMOTE_NLP_MAX_SENTENCE_LENGTH=700 \
    REMOTE_NLP_DEFAULT_THRESHOLD=0.9

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

RUN python -c "from transformers import pipeline; pipeline('zero-shot-classification', model='facebook/bart-large-mnli', device=-1)"

COPY main.py ./

EXPOSE 8080

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
