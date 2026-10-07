# Installation graph: the released production graph without the CLIProxy subscription gateway.
# Input and output are `docker compose config --no-interpolate --format json` documents.
del(.services["cli-proxy-api"]) |
del(.services.agent.depends_on["cli-proxy-api"]) |
del(.volumes["cli-proxy-auth"])
