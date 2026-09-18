FROM mcr.microsoft.com/dotnet/sdk:9.0-bookworm-slim AS build
WORKDIR /src

COPY backend/DgRelay/DgRelay.csproj backend/DgRelay/
RUN dotnet restore backend/DgRelay/DgRelay.csproj

COPY backend/DgRelay backend/DgRelay
RUN dotnet publish backend/DgRelay/DgRelay.csproj \
    --configuration Release \
    --output /app/publish \
    --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:9.0-bookworm-slim
ENV ASPNETCORE_ENVIRONMENT=Production \
    PORT=10000 \
    DG_BROWSER_CHANNEL=msedge \
    PLAYWRIGHT_BROWSERS_PATH=0

# MT currently requires a non-headless Edge context. Xvfb supplies the virtual
# display required by a Linux Render container without exposing a desktop.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
       ca-certificates gnupg wget xvfb xauth fonts-liberation \
    && wget --quiet --output-document=- https://packages.microsoft.com/keys/microsoft.asc \
       | gpg --dearmor --output /usr/share/keyrings/microsoft-edge.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/microsoft-edge.gpg] https://packages.microsoft.com/repos/edge stable main" \
       > /etc/apt/sources.list.d/microsoft-edge.list \
    && apt-get update \
    && apt-get install --yes --no-install-recommends microsoft-edge-stable \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/publish .

EXPOSE 10000
# Start the virtual display only when MT is enabled. DG uses a headless Edge
# session, so keeping Xvfb alive while MT is paused wastes memory on Render's
# Free instance. This keeps the .NET process as PID 1 for reliable logs.
ENTRYPOINT ["/bin/sh", "-c", "if [ \"${MT_RELAY_ENABLED:-false}\" = \"true\" ]; then Xvfb :99 -screen 0 1920x1080x24 -ac >/tmp/xvfb.log 2>&1 & sleep 1; export DISPLAY=:99; fi; exec dotnet /app/DgRelay.dll"]
