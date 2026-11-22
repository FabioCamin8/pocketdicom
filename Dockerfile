FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir --no-compile --only-binary=:all: -r requirements.txt

COPY server.py dicom_catalog.py dicom_overlays.py dicom_pixels.py ./
COPY web/ web/

USER 10001:10001
EXPOSE 8765
ENTRYPOINT ["python", "server.py", "--host", "0.0.0.0"]
