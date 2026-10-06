# CI runner image: Cloudflare's sandbox runtime plus the toolchain this
# monorepo needs. Keep the base digest in sync with @cloudflare/ci's
# @cloudflare/sandbox version (also pinned in infra/ci/package.json).
FROM docker.io/cloudflare/sandbox:0.12.1@sha256:ea9b35e61c800eddbc4450fad333e5dd26033a06f7d36624388b0711bef9f8c5

# git >= 2.41 (gq ploi release uses `git archive --add-virtual-file`) and PHP 8.4
# (getquick-design requires >= 8.4.1) come from their upstream PPAs; the base
# image is Ubuntu 22.04 with git 2.34 and no PHP.
RUN apt-get update \
  && apt-get install -y --no-install-recommends software-properties-common gpg-agent unzip \
  && add-apt-repository -y ppa:git-core/ppa \
  && add-apt-repository -y ppa:ondrej/php \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
    git php8.4-cli php8.4-mbstring php8.4-curl php8.4-intl php8.4-zip php8.4-mysql php8.4-xml \
  && rm -rf /var/lib/apt/lists/*

COPY --from=docker.io/composer:2 /usr/bin/composer /usr/bin/composer

# Matches packageManager in the root package.json.
RUN npm install -g pnpm@12.6.0
