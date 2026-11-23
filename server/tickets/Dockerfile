FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py .
RUN useradd -r -u 10001 relay && mkdir -p /data && chown relay /data
USER relay
EXPOSE 8080
# No access log: it would record each reporter's IP address (the privacy policy says the relay keeps only a salted hash).
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080", "--proxy-headers", "--forwarded-allow-ips", "*", "--no-access-log"]
