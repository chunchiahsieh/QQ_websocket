FROM mcr.microsoft.com/dotnet/sdk:9.0-bookworm-slim AS build
WORKDIR /src

COPY backend/CollectorRelay/CollectorRelay.csproj backend/CollectorRelay/
RUN dotnet restore backend/CollectorRelay/CollectorRelay.csproj

COPY backend/CollectorRelay/ backend/CollectorRelay/
RUN dotnet publish backend/CollectorRelay/CollectorRelay.csproj \
    --configuration Release \
    --output /app/publish \
    --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:9.0-bookworm-slim
ENV ASPNETCORE_ENVIRONMENT=Production \
    PORT=10000
WORKDIR /app
COPY --from=build /app/publish .
EXPOSE 10000
ENTRYPOINT ["dotnet", "CollectorRelay.dll"]
