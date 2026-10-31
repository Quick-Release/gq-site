# The disposable stack admission.sh's smoke runs on (see ../admission.sh):
# Ubuntu 24.04 with nginx, PHP-FPM and Composer from its own packages, as a
# Ploi server has them (Ploi installs newer PHP from a PPA; FPM's pool and
# reload behaviour is the same).
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq \
  && apt-get install -y -qq --no-install-recommends \
    nginx php8.3-fpm php8.3-cli php8.3-sqlite3 php8.3-curl php8.3-mbstring php8.3-xml \
    php8.3-zip php8.3-opcache composer git unzip curl ca-certificates sudo procps openssl \
    >/dev/null \
  && rm -rf /var/lib/apt/lists/*
