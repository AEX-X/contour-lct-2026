# ML prediction service (code in ml/, a git subtree of LCT-ML).
# Build context is the repository root: see docker-compose.ml.yml.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

WORKDIR /ml

# ml-service requirements include ../ml-baseline/requirements.txt, so keep that layout.
COPY ml/outputs/ml-baseline/requirements.txt outputs/ml-baseline/requirements.txt
COPY ml/outputs/ml-service/requirements.txt outputs/ml-service/requirements.txt
RUN pip install --no-cache-dir -r outputs/ml-service/requirements.txt

# Code, models, calibrations and decision files (model paths are relative to each decision file).
COPY ml/outputs ./outputs
COPY ml/scripts ./scripts

# Channel directory for the object models: the same file (same SHA-256) the models were trained on.
COPY data/справочник_каналов_датчиков.csv /ml/reference/channels.csv

EXPOSE 8090
