# CI runner image: Cloudflare's sandbox runtime plus the toolchain this
# monorepo needs. Keep the base digest in sync with @cloudflare/ci's
# @cloudflare/sandbox version (also pinned in infra/ci/package.json).
FROM docker.io/cloudflare/sandbox:0.12.1@sha256:ea9b35e61c800eddbc4450fad333e5dd26033a06f7d36624388b0711bef9f8c5

# git >= 2.41 (gq ploi release uses `git archive --add-virtual-file`) and PHP 8.4
# (getquick-design requires >= 8.4.1) come from their upstream PPAs; the base
# image is Ubuntu 22.04 with git 2.34 and no PHP. GNU patch applies the CMS's
# dependency patches (apps/cms/scripts/patch-dependencies.php).
RUN apt-get update \
  && apt-get install -y --no-install-recommends software-properties-common gpg-agent unzip \
  && add-apt-repository -y ppa:git-core/ppa \
  && add-apt-repository -y ppa:ondrej/php \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    git patch php8.4-cli php8.4-mbstring php8.4-curl php8.4-intl php8.4-zip php8.4-mysql php8.4-xml \
  && rm -rf /var/lib/apt/lists/*

COPY --from=docker.io/composer:2 /usr/bin/composer /usr/bin/composer

# Every step runs as root, where non-interactive Composer otherwise disables
# all plugins: composer/installers wouldn't place WordPress plugins and themes
# in installer-paths, and the dependency patch would find nothing to patch.
# This trusts the root user in this throwaway container only; which plugins
# may run is still decided by the CMS composer.json's allow-plugins.
ENV COMPOSER_ALLOW_SUPERUSER=1

# Node: the version every Site pins locally (.nvmrc, .mise.toml), so CI's
# checks run on the Node they pass on. The base image bundles Node 22.22.3,
# older than Astro 7.4.2+ accepts (>=22.23.4). The official linux-x64 build
# (Cloudflare's containers are linux/amd64) replaces it in /usr/local, where
# the base keeps node, npm and npx: the sandbox server's JavaScript executor
# and every CI step run this one, the only node on PATH. The checksum is the
# tarball's line in nodejs.org's SHASUMS256.txt; change it with the version.
ARG NODE_VERSION=24.21.0
ARG NODE_SHA256=6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff
RUN curl -fsSLo /tmp/node.tar.gz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz" \
  && echo "${NODE_SHA256}  /tmp/node.tar.gz" | sha256sum -c - \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  && tar -xzf /tmp/node.tar.gz -C /usr/local --strip-components=1 --no-same-owner \
    --exclude="node-v${NODE_VERSION}-linux-x64/CHANGELOG.md" \
    --exclude="node-v${NODE_VERSION}-linux-x64/LICENSE" \
    --exclude="node-v${NODE_VERSION}-linux-x64/README.md" \
  && rm /tmp/node.tar.gz \
  && test "$(node --version)" = "v${NODE_VERSION}"

# Matches packageManager in the root package.json.
RUN npm install -g {{packageManager}}
