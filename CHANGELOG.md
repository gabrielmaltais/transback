# Changelog

## 3.0.0 — first public release

- Automatic detection of the Nextcloud container, `occ`, web user and data folder (official image, linuxserver.io, AIO), with a Diagnostics tab.
- Destinations chosen by name: group folders, users' personal folders, or plain folders mounted under /destinations (works without Nextcloud, no indexing).
- Disks of any common format mounted read-only by TransBack itself: APFS, HFS+, HFS, FAT, exFAT, NTFS, ISO 9660, UDF, ext, btrfs, XFS; host mounts reused when visible.
- Folder browser at any depth, selection basket, per-disk eject.
- Free-space check, configurable permissions, speed limit, exclusions, webhook notification.
- Optional password or reverse-proxy authentication.
- English and French interface; mobile-friendly transfers panel.
- Multi-architecture image (amd64, arm64) published on GitHub Container Registry.
