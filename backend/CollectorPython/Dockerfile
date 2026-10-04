FROM python:3.12-slim

WORKDIR /collector
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && python -m playwright install --with-deps chromium

COPY collector.py collector_probe.py mt_decoder.py dg_decoder.py ab_decoder.py roads.py ./

ENV PYTHONUNBUFFERED=1 \
    COLLECTOR_HEADLESS=1 \
    COLLECTOR_BROWSER_CHANNEL=""

CMD ["python", "collector.py", "--start-all"]
