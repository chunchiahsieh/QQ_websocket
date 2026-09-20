FROM mcr.microsoft.com/dotnet/sdk:9.0 AS build
WORKDIR /src
COPY backend/AccountAdmin/AccountAdmin.csproj backend/AccountAdmin/
RUN dotnet restore backend/AccountAdmin/AccountAdmin.csproj
COPY backend/AccountAdmin/ backend/AccountAdmin/
RUN dotnet publish backend/AccountAdmin/AccountAdmin.csproj -c Release -o /out --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:9.0
WORKDIR /app
COPY --from=build /out/ .
ENV ASPNETCORE_ENVIRONMENT=Production \
    ADMIN_DATA_DIR=/var/lib/account-admin
EXPOSE 10000
ENTRYPOINT ["dotnet", "AccountAdmin.dll"]
