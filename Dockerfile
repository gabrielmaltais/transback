# ── Étape 1 : apfs-fuse (lecture seule des disques Mac en APFS) ─────────────
FROM debian:bookworm-slim AS apfs
ARG APFS_FUSE_REF=master
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates cmake g++ make \
      libfuse3-dev zlib1g-dev libbz2-dev libattr1-dev libicu-dev \
 && git clone --recursive https://github.com/sgan81/apfs-fuse.git /src \
 && git -C /src checkout "$APFS_FUSE_REF" \
 && cmake -S /src -B /src/build -DUSE_FUSE3=ON -DCMAKE_BUILD_TYPE=Release \
 && make -C /src/build -j"$(nproc)"

# ── Étape 2 : client Docker (pour « occ » dans le conteneur Nextcloud) ──────
FROM docker:27-cli AS dockercli

# ── Image finale ────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim

# rsync : copie · util-linux : lsblk/blkid/mount · fuse3 + libs : apfs-fuse
# kmod : chargement des pilotes hfs/hfsplus/exfat… · attr : getfattr (fichiers Mac)
RUN apt-get update && apt-get install -y --no-install-recommends \
      rsync util-linux fuse3 kmod attr \
      libfuse3-3 zlib1g libbz2-1.0 libattr1 libicu72 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=apfs /src/build/apfs-fuse /src/build/apfsutil /usr/local/bin/
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "server/index.js"]
