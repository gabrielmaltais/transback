# Security

## What TransBack can do on your host

TransBack is an administration tool. To do its job it needs:

- **The Docker socket** (`/var/run/docker.sock`), to find the Nextcloud container and run `occ` inside it. Access to the Docker socket is equivalent to **root access to the host**.
- **Privileged mode, `/dev` and the kernel modules**, to mount USB disks (APFS through FUSE, HFS/HFS+ and other kernel file systems).
- **Write access to the Nextcloud data folder**, to copy files there.

Consequently, **anyone who can use TransBack can take control of the host**. Treat it like an admin panel.

## Recommendations

- Do not expose TransBack directly to the Internet.
- Set `TB_PASSWORD`, or put TransBack behind an authenticating reverse proxy (Cloudflare Access, Authelia, Authentik…) and set `TB_TRUST_PROXY_AUTH` to the header that proxy adds. Only use `TB_TRUST_PROXY_AUTH` if TransBack cannot be reached without going through that proxy.
- Keep the default `TB_FRAME_ANCESTORS` unless you embed TransBack in Nextcloud (then set it to your Nextcloud URL).

## What TransBack protects

- Source disks are always mounted **read-only**.
- Paths sent by the browser are resolved and confined to the selected disk (`..` and symbolic links pointing outside are refused); symbolic links on the disks are not copied.
- Destinations are limited to Nextcloud group folders and users' `files` folders.
- Names coming from disks are escaped before being displayed.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting (**Security › Report a vulnerability** on the repository), with the steps to reproduce and the affected version.
