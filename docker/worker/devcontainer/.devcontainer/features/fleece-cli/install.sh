#!/bin/sh
# Mirrors docker/worker/Dockerfile's Fleece block, including its reason for
# --tool-path: a global `dotnet tool install -g` lands in $HOME/.dotnet/tools,
# and $HOME is /root at build time, which the non-root user this image runs as
# can never reach.
set -eu

VERSION="${VERSION:-latest}"
TOOL_PATH=/usr/local/dotnet-tools

if ! command -v dotnet >/dev/null 2>&1; then
	# The dotnet Feature symlinks /usr/bin/dotnet, but PATH inside a Feature's
	# RUN layer does not yet include containerEnv additions from other Features.
	if [ -x /usr/bin/dotnet ]; then
		PATH="/usr/bin:${PATH}"
	elif [ -x /usr/share/dotnet/dotnet ]; then
		PATH="/usr/share/dotnet:${PATH}"
	else
		echo "(!) fleece-cli requires dotnet; install the dotnet Feature first." >&2
		exit 1
	fi
	export PATH
fi

if [ "${VERSION}" = "latest" ]; then
	dotnet tool install Fleece.Cli --tool-path "${TOOL_PATH}"
else
	dotnet tool install Fleece.Cli --version "${VERSION}" --tool-path "${TOOL_PATH}"
fi

# The tool tree is read at runtime by the non-root user; the NuGet scratch
# space is build-time only and is what makes this layer needlessly large.
chmod -R a+rX "${TOOL_PATH}"
rm -rf /root/.nuget/packages /tmp/NuGetScratch
